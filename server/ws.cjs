'use strict';
const { WebSocket } = require('ws');
const { parseName, parseCode, parseToken } = require('../docs/network.js');
const { resolveClientIp } = require('./limits.cjs');
const { makeCode, createRoom } = require('./rooms.cjs');

function createSender() {
  function send(ws, data) {
    if (ws?.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > 256 * 1024) { ws.terminate(); return; }
      ws.send(JSON.stringify(data));
    }
  }
  return send;
}

function invalid(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return true;
  if (typeof msg.type !== 'string' || !msg.type || msg.type.length > 32) return true;
  for (const value of Object.values(msg)) {
    if (typeof value === 'string' && value.length > 64) return true;
  }
  return false;
}

function attachUpgrade(server, wss, {
  trustProxy, maxClients, maxSocketsPerIp, socketsByIp, rejected, addSocket
}) {
  server.on('upgrade', (req, socket, head) => {
    let validOrigin = !req.headers.origin;
    try { validOrigin ||= new URL(req.headers.origin).host === req.headers.host; } catch {}
    const ip = resolveClientIp(req, trustProxy);
    if (req.url !== '/match' || !validOrigin || wss.clients.size >= maxClients) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    if ((socketsByIp.get(ip) || 0) >= maxSocketsPerIp) {
      rejected.sockets += 1;
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      addSocket(ip);
      ws.clientIp = ip;
      wss.emit('connection', ws);
    });
  });
}

function attachConnections(wss, ctx) {
  const {
    rooms, tokens, rejected, maxRooms, maxRoomsPerIp, createPerMin, createWindowMs,
    rateLimit, maxPayload, joinIdleMs, roomsByIp, createHits, allowWindow, takeRoom,
    dropSocket, send,
    roomOf, broadcast, claimSeat, resumeIfReady, recipients, seatTaken,
    beginMatch, stopInput, recordOutcome, matchActive, forfeitToLobby, lobbyDepart,
    startReconnect, issueToken, isDraining
  } = ctx;
  function reject(ws, message) {
    send(ws, { type: 'error', message });
    ws.close(1008);
  }
  wss.on('connection', ws => {
    ws.joined = false; ws.seat = null; ws.roomCode = ''; ws.alive = true;
    ws.messages = 0; ws.windowStart = Date.now(); ws.released = false;
    let idleTimer;
    function armIdle() {
      clearTimeout(idleTimer);
      if (ws.joined) return;
      idleTimer = setTimeout(() => {
        if (ws.joined) return;
        rejected.idle += 1;
        ws.close(1008, 'Idle');
      }, joinIdleMs);
    }
    armIdle();
    ws.on('error', error => {
      if (error && /max payload/i.test(error.message || '')) rejected.payload += 1;
    });
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (raw, binary) => {
      const bytes = Buffer.byteLength(raw);
      if (bytes > maxPayload) { rejected.payload += 1; ws.close(1008, 'Too large'); return; }
      if (Date.now() - ws.windowStart >= 1000) { ws.messages = 0; ws.windowStart = Date.now(); }
      if (++ws.messages > rateLimit || binary) { ws.close(1008, 'Invalid traffic'); return; }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { ws.close(1008, 'Invalid JSON'); return; }
      if (invalid(msg)) { ws.close(1008, 'Invalid message'); return; }
      if (!ws.joined) armIdle();
      if (!ws.joined) {
        if (msg.type === 'reconnect') {
          const token = parseToken(msg.sessionToken);
          const code = parseCode(msg.code);
          if (!token || !code) { reject(ws, '無效的重連憑證。'); return; }
          const claim = tokens.get(token);
          if (!claim || claim.code !== code) { reject(ws, '無效的重連憑證。'); return; }
          const room = rooms.get(claim.code);
          if (!room) { reject(ws, '找不到房間。'); return; }
          if (room.players[claim.owner]) { reject(ws, '此座位仍在線，無法重連。'); return; }
          claimSeat(room, ws, claim.owner, token, room.names[claim.owner] || '玩家');
          room.reconnecting[claim.owner] = null;
          clearTimeout(idleTimer);
          resumeIfReady(room);
          send(ws, { type: 'joined', owner: claim.owner, sessionToken: token, code: room.code, name: room.names[claim.owner], role: 'player' });
          const restored = { type: 'reconnected', owner: claim.owner };
          for (const seat of recipients(room)) send(seat, restored);
          broadcast(room);
          return;
        }
        if (msg.type !== 'join') { ws.close(1008, 'Invalid message'); return; }
        const name = parseName(msg.name);
        if (!name) { reject(ws, '暱稱需為 2–12 個字，且不可含控制字元。'); return; }
        if (!['host', 'guest', 'spectate'].includes(msg.role)) { ws.close(1008, 'Invalid message'); return; }
        if (msg.role === 'host' && msg.code !== undefined && msg.code !== '' && !parseCode(msg.code)) {
          reject(ws, '房間代碼無效。'); return;
        }
        if (msg.role !== 'host' && !parseCode(msg.code)) { reject(ws, '房間代碼無效。'); return; }
        if (msg.role === 'host' && !parseCode(msg.code)) {
          if (isDraining()) { reject(ws, '無法建立房間，請稍後再試。'); return; }
          if (rooms.size >= maxRooms) { reject(ws, '無法建立房間，請稍後再試。'); return; }
          const created = roomsByIp.get(ws.clientIp);
          if (created && created.size >= maxRoomsPerIp) { rejected.rooms += 1; reject(ws, '無法建立房間，請稍後再試。'); return; }
          if (!allowWindow(createHits, ws.clientIp, createWindowMs, createPerMin)) {
            rejected.create += 1;
            reject(ws, '無法建立房間，請稍後再試。');
            return;
          }
          const room = createRoom(makeCode(rooms));
          room.createdByIp = ws.clientIp;
          rooms.set(room.code, room);
          takeRoom(ws.clientIp, room.code);
          if (msg.color === 2) { room.game.reset(2); room.game.state = 'ready'; }
          const token = issueToken();
          claimSeat(room, ws, 0, token, name);
          clearTimeout(idleTimer);
          send(ws, { type: 'joined', owner: 0, sessionToken: token, code: room.code, name, role: 'player' });
          broadcast(room);
          return;
        }
        const code = parseCode(msg.code);
        const room = rooms.get(code);
        if (!room) { reject(ws, '找不到房間。'); return; }
        if (msg.role === 'spectate') {
          room.spectators.set(ws, name);
          ws.joined = true; ws.seat = 'spectate'; ws.roomCode = room.code;
          clearTimeout(idleTimer);
          send(ws, { type: 'joined', owner: null, code: room.code, name, role: 'spectate' });
          broadcast(room);
          return;
        }
        const owner = msg.role === 'host' ? 0 : 1;
        if (seatTaken(room, owner)) { reject(ws, '房間已有人，請稍後再試。'); return; }
        if (owner === 1 && !room.players[0] && !room.reconnecting[0]) { reject(ws, '尚無房主，請先建立房間。'); return; }
        if (owner === 0 && msg.color === 2 && room.game.state === 'ready') {
          room.game.reset(2); room.game.state = 'ready'; room.ready.fill(false);
        }
        const token = issueToken();
        claimSeat(room, ws, owner, token, name);
        clearTimeout(idleTimer);
        send(ws, { type: 'joined', owner, sessionToken: token, code: room.code, name, role: 'player' });
        broadcast(room);
        return;
      }
      const room = roomOf(ws);
      if (!room) return;
      if (ws.seat === 'spectate') {
        if (msg.type === 'leave') {
          ws.released = true;
          room.spectators.delete(ws);
          broadcast(room);
          return;
        }
        return;
      }
      const owner = ws.seat;
      if (room.players[owner] !== ws) return;
      if (msg.type === 'leave') {
        ws.released = true;
        if (matchActive(room)) forfeitToLobby(room, owner);
        else lobbyDepart(room, owner);
        return;
      }
      if (msg.type === 'ready' && room.game.state === 'ready') room.ready[owner] = !room.ready[owner];
      else if (msg.type === 'color' && owner === 0 && room.game.state === 'ready' && [1, 2].includes(msg.color)) {
        room.game.reset(msg.color); room.game.state = 'ready'; room.ready.fill(false);
      } else if (msg.type === 'start' && owner === 0 && room.game.state === 'ready' && room.players.every(Boolean) && room.ready.every(Boolean)) {
        room.game.reset(room.game.sides[0].color); stopInput(room); beginMatch(room);
      } else if (msg.type === 'restart' && owner === 0 && room.game.state === 'over' && !room.reconnecting.some(Boolean)) {
        room.game.reset(room.game.sides[0].color); room.game.state = 'ready'; room.ready.fill(false); stopInput(room);
        room.matchKey = null; room.recorded = false;
      } else if (msg.type === 'pause' && room.game.state === 'playing') { room.game.pause(); stopInput(room); }
      else if (msg.type === 'resume' && room.game.state === 'paused' && room.players.every(Boolean) && !room.reconnecting.some(Boolean)) { room.game.pause(); stopInput(room); }
      else if (msg.type === 'input' && room.game.state === 'playing') {
        if (msg.action === 'left') room.game.move(owner, -1);
        else if (msg.action === 'right') room.game.move(owner, 1);
        else if (msg.action === 'rotate') room.game.rotate(owner);
        else if (msg.action === 'drop') room.game.step(owner, true);
        else if (msg.action === 'step') room.game.step(owner);
        else if (msg.action === 'soft' && typeof msg.down === 'boolean') {
          room.fast[owner] = msg.down; room.fastUntil[owner] = Date.now() + 1500;
        } else return;
      } else return;
      if (room.game.state === 'over') recordOutcome(room, room.game.winner);
      broadcast(room);
    });
    ws.on('close', () => {
      clearTimeout(idleTimer);
      dropSocket(ws.clientIp);
      if (ws.released) return;
      const room = roomOf(ws);
      if (!room) return;
      if (ws.seat === 'spectate') {
        room.spectators.delete(ws);
        broadcast(room);
        return;
      }
      if (ws.seat !== 0 && ws.seat !== 1) return;
      if (room.players[ws.seat] !== ws) return;
      if (matchActive(room)) startReconnect(room, ws.seat);
      else lobbyDepart(room, ws.seat);
    });
  });
}

module.exports = { createSender, invalid, attachUpgrade, attachConnections };
