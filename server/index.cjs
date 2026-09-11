'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { Game } = require('../docs/game-core.js');
const { encodeBoard, parseName, parseCode, parseToken, ROOM_ALPHABET } = require('../docs/network.js');
const { openLeaderboard } = require('./leaderboard.cjs');

const RECONNECT_MS = 60000;
const ROOM_TTL_MS = 5 * 60 * 1000;
const MAX_ROOMS = 50;
const RATE_LIMIT = 30;
const MAX_CLIENTS = 256;
const MAX_ROOMS_PER_IP = 3;
const MAX_SOCKETS_PER_IP = 10;
const CREATE_PER_MIN = 5;
const HTTP_PER_MIN = 60;
const MAX_PAYLOAD = 4096;
const JOIN_IDLE_MS = 30000;
const STATS_MS = 10 * 60 * 1000;

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function envInt(name, fallback, min = 1, max = 1e9) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function firstHeader(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value[0] || '';
  return typeof value === 'string' ? value : '';
}

function normalizeIp(raw) {
  if (typeof raw !== 'string') return '';
  let ip = raw.trim();
  if (!ip || ip.length > 64) return '';
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end < 2) return '';
    ip = ip.slice(1, end);
  } else {
    const v4port = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
    if (v4port) ip = v4port[1];
  }
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7);
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    return ip.split('.').every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255) ? ip : '';
  }
  if (/^[0-9a-fA-F:]+$/.test(ip) && ip.includes(':') && ip.length <= 45) {
    if (ip.split('::').length > 2) return '';
    return ip.toLowerCase();
  }
  return '';
}

function resolveClientIp(req, trustProxy = false) {
  if (trustProxy) {
    const cf = normalizeIp(firstHeader(req.headers, 'cf-connecting-ip'));
    if (cf) return cf;
    const forwarded = firstHeader(req.headers, 'x-forwarded-for');
    if (forwarded) {
      const first = normalizeIp(forwarded.split(',')[0]);
      if (first) return first;
    }
  }
  return normalizeIp(req.socket?.remoteAddress) || 'unknown';
}

function pruneHits(list, now, windowMs) {
  return list.filter(time => now - time < windowMs);
}

function makeCode(taken) {
  for (let i = 0; i < 64; i++) {
    const code = Array.from(crypto.randomBytes(6), byte => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join('');
    if (!taken.has(code)) return code;
  }
  throw new Error('room code exhausted');
}

function createRoom(code) {
  const game = new Game();
  game.state = 'ready';
  return {
    code,
    game,
    players: [null, null],
    names: ['', ''],
    spectators: new Map(),
    ready: [false, false],
    sessions: [null, null],
    reconnecting: [null, null],
    fast: [false, false],
    fastUntil: [0, 0],
    pausedForReconnect: false,
    revision: 0,
    lastTickSent: 0,
    emptySince: null,
    matchSeq: 0,
    matchKey: null,
    recorded: false
  };
}

function createServer({
  heartbeatMs = 5000,
  reconnectMs = envInt('RECONNECT_MS', RECONNECT_MS, 1000, 3_600_000),
  maxRooms = envInt('MAX_ROOMS', MAX_ROOMS, 1, 10_000),
  roomTtlMs = envInt('ROOM_TTL_MS', ROOM_TTL_MS, 1000, 86_400_000),
  rateLimit = envInt('RATE_LIMIT', RATE_LIMIT, 1, 10_000),
  trustProxy = envFlag('TRUST_PROXY', false),
  maxRoomsPerIp = envInt('MAX_ROOMS_PER_IP', MAX_ROOMS_PER_IP, 1, 1000),
  maxSocketsPerIp = envInt('MAX_SOCKETS_PER_IP', MAX_SOCKETS_PER_IP, 1, 10_000),
  createPerMin = envInt('CREATE_PER_MIN', CREATE_PER_MIN, 1, 10_000),
  httpPerMin = envInt('HTTP_PER_MIN', HTTP_PER_MIN, 1, 100_000),
  maxClients = envInt('MAX_CLIENTS', MAX_CLIENTS, 1, 100_000),
  createWindowMs = 60000,
  httpWindowMs = 60000,
  maxPayload = envInt('MAX_PAYLOAD', MAX_PAYLOAD, 256, 1024 * 1024),
  joinIdleMs = envInt('JOIN_IDLE_MS', JOIN_IDLE_MS, 1000, 600_000),
  statsMs = envInt('STATS_MS', STATS_MS, 0, 86_400_000),
  dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data')
} = {}) {
  const started = Date.now();
  const rooms = new Map();
  const tokens = new Map();
  const socketsByIp = new Map();
  const roomsByIp = new Map();
  const createHits = new Map();
  const httpHits = new Map();
  const rejected = { rooms: 0, sockets: 0, create: 0, http: 0, payload: 0, idle: 0 };
  const board = openLeaderboard(dataDir);
  const assets = new Map([
    ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
    ['/game.js', ['game.js', 'text/javascript']], ['/game-core.js', ['game-core.js', 'text/javascript']],
    ['/network.js', ['network.js', 'text/javascript']], ['/ai.js', ['ai.js', 'text/javascript']], ['/audio.js', ['audio.js', 'text/javascript']],
    ['/session-record.js', ['session-record.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
    ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
  ]);
  function allowWindow(map, ip, windowMs, limit) {
    const now = Date.now();
    const next = pruneHits(map.get(ip) || [], now, windowMs);
    if (next.length >= limit) { map.set(ip, next); return false; }
    next.push(now);
    map.set(ip, next);
    return true;
  }
  function pruneMaps() {
    const now = Date.now();
    for (const [ip, list] of createHits) {
      const next = pruneHits(list, now, createWindowMs);
      if (next.length) createHits.set(ip, next); else createHits.delete(ip);
    }
    for (const [ip, list] of httpHits) {
      const next = pruneHits(list, now, httpWindowMs);
      if (next.length) httpHits.set(ip, next); else httpHits.delete(ip);
    }
  }
  function addSocket(ip) {
    socketsByIp.set(ip, (socketsByIp.get(ip) || 0) + 1);
  }
  function dropSocket(ip) {
    if (!ip) return;
    const next = (socketsByIp.get(ip) || 0) - 1;
    if (next <= 0) socketsByIp.delete(ip);
    else socketsByIp.set(ip, next);
  }
  function takeRoom(ip, code) {
    let owned = roomsByIp.get(ip);
    if (!owned) { owned = new Set(); roomsByIp.set(ip, owned); }
    owned.add(code);
  }
  function releaseRoom(room) {
    if (!room || room.quotaReleased) return;
    room.quotaReleased = true;
    const owned = roomsByIp.get(room.createdByIp);
    if (!owned) return;
    owned.delete(room.code);
    if (!owned.size) roomsByIp.delete(room.createdByIp);
  }
  function limitedApi(req, res) {
    const ip = resolveClientIp(req, trustProxy);
    if (!allowWindow(httpHits, ip, httpWindowMs, httpPerMin)) {
      rejected.http += 1;
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('請稍後再試');
      return true;
    }
    return false;
  }
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { res.writeHead(400); res.end('Invalid URL'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    if (url.pathname === '/healthz') {
      if (limitedApi(req, res)) return;
      const body = JSON.stringify({
        ok: true,
        uptime: Math.round((Date.now() - started) / 1000),
        rooms: rooms.size,
        playing: [...rooms.values()].filter(room => room.game.state === 'playing').length
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') res.end();
      else res.end(body);
      return;
    }
    if (url.pathname === '/leaderboard') {
      if (limitedApi(req, res)) return;
      const body = JSON.stringify({ rankings: board.top(20) });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=30',
        'X-Content-Type-Options': 'nosniff'
      });
      if (req.method === 'HEAD') res.end();
      else res.end(body);
      return;
    }
    const asset = assets.get(url.pathname);
    if (!asset) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(path.join(__dirname, '../docs', asset[0])).pipe(res);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });
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
  function send(ws, data) {
    if (ws?.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > 256 * 1024) { ws.terminate(); return; }
      ws.send(JSON.stringify(data));
    }
  }
  function roomOf(ws) { return ws?.roomCode ? rooms.get(ws.roomCode) : null; }
  function recipients(room) {
    return [...room.players.filter(Boolean), ...room.spectators.keys()];
  }
  function reconnectInfo(room) {
    const owner = room.reconnecting.findIndex(Boolean);
    if (owner < 0) return null;
    return { owner, deadline: room.reconnecting[owner].deadline };
  }
  function round3(n) { return Math.round(n * 1000) / 1000; }
  function publicGame(room) {
    const game = room.game;
    return {
      state: game.state, sides: game.sides, board: encodeBoard(game.board), queues: game.queues,
      pieces: game.pieces, timers: [round3(game.timers[0]), round3(game.timers[1])],
      locked: game.locked, elapsed: round3(game.elapsed), winner: game.winner, lastFlips: game.lastFlips
    };
  }
  function spectatorNames(room) { return [...room.spectators.values()]; }
  function markEmpty(room) {
    const idle = !room.players[0] && !room.players[1] && !room.reconnecting[0] && !room.reconnecting[1];
    room.emptySince = idle ? (room.emptySince || Date.now()) : null;
  }
  function dropToken(token) { if (token) tokens.delete(token); }
  function broadcast(room, kind = 'full') {
    if (kind === 'tick') {
      const data = {
        type: 'tick', revision: ++room.revision, elapsed: round3(room.game.elapsed), pieces: room.game.pieces,
        timers: [round3(room.game.timers[0]), round3(room.game.timers[1])], locked: room.game.locked,
        state: room.game.state, lastFlips: room.game.lastFlips
      };
      for (const ws of recipients(room)) send(ws, data);
      return;
    }
    const data = {
      type: 'state', revision: ++room.revision, game: publicGame(room),
      connected: room.players.map(Boolean), ready: room.ready, reconnect: reconnectInfo(room),
      names: room.names.slice(), spectators: room.spectators.size, spectatorNames: spectatorNames(room),
      code: room.code
    };
    for (const ws of recipients(room)) send(ws, data);
  }
  function stopInput(room) { room.fast.fill(false); room.fastUntil.fill(0); }
  function matchActive(room) { return room.game.state === 'playing' || room.game.state === 'paused'; }
  function seatTaken(room, owner) { return Boolean(room.players[owner] || room.reconnecting[owner]); }
  function issueToken() { return crypto.randomBytes(16).toString('hex'); }
  function pct(count) { return Number((count / 2).toFixed(1)); }
  function recordOutcome(room, winner) {
    try {
      if (room.recorded || winner !== 0 && winner !== 1) return;
      const winnerName = room.names[winner], loserName = room.names[1 - winner];
      if (!winnerName || !loserName || !room.matchKey) return;
      const counts = room.game.counts();
      const winColor = room.game.sides[winner].color;
      const loseColor = room.game.sides[1 - winner].color;
      room.recorded = board.record({
        room: room.code,
        matchKey: room.matchKey,
        winnerName,
        loserName,
        winnerPct: pct(counts[winColor - 1]),
        loserPct: pct(counts[loseColor - 1])
      }) || room.recorded;
    } catch (error) {
      console.error('無法寫入排行榜：', error);
    }
  }
  function beginMatch(room) {
    room.matchSeq += 1;
    room.matchKey = `${room.code}:${room.matchSeq}`;
    room.recorded = false;
  }
  function startReconnect(room, owner) {
    room.players[owner] = null;
    room.ready[owner] = false;
    stopInput(room);
    if (room.game.state === 'playing') {
      room.game.pause();
      room.pausedForReconnect = true;
    }
    const deadline = Date.now() + reconnectMs;
    room.reconnecting[owner] = { deadline };
    const payload = { type: 'reconnect-waiting', owner, deadline };
    for (const ws of recipients(room)) send(ws, payload);
    markEmpty(room);
    broadcast(room);
  }
  function resumeIfReady(room) {
    if (room.reconnecting.every(slot => !slot) && room.pausedForReconnect && room.game.state === 'paused' && room.players.every(Boolean)) {
      room.game.pause();
      room.pausedForReconnect = false;
    }
  }
  function timeoutReconnect(room, owner) {
    const remaining = 1 - owner;
    if (matchActive(room) && room.players[remaining]) recordOutcome(room, remaining);
    room.reconnecting[owner] = null;
    dropToken(room.sessions[owner]);
    room.sessions[owner] = null;
    room.players[owner] = null;
    room.names[owner] = '';
    room.ready.fill(false);
    stopInput(room);
    room.pausedForReconnect = false;
    const payload = { type: 'reconnect-timeout', owner, winner: remaining };
    for (const ws of recipients(room)) send(ws, payload);
    room.game.reset(room.game.sides[0].color);
    room.game.state = 'ready';
    room.matchKey = null;
    room.recorded = false;
    markEmpty(room);
    broadcast(room);
  }
  function lobbyDepart(room, owner) {
    dropToken(room.sessions[owner]);
    room.players[owner] = null;
    room.sessions[owner] = null;
    room.reconnecting[owner] = null;
    room.names[owner] = '';
    room.ready.fill(false);
    stopInput(room);
    room.pausedForReconnect = false;
    room.game.state = 'ready';
    markEmpty(room);
    broadcast(room);
  }
  function forfeitToLobby(room, owner) {
    const remaining = 1 - owner;
    if (matchActive(room) && room.names[remaining]) recordOutcome(room, remaining);
    dropToken(room.sessions[owner]);
    room.reconnecting[owner] = null;
    room.sessions[owner] = null;
    room.players[owner] = null;
    room.names[owner] = '';
    room.ready.fill(false);
    stopInput(room);
    room.pausedForReconnect = false;
    room.game.reset(room.game.sides[0].color);
    room.game.state = 'ready';
    room.matchKey = null;
    room.recorded = false;
    markEmpty(room);
    broadcast(room);
  }
  function claimSeat(room, ws, owner, token, name) {
    room.players[owner] = ws;
    room.names[owner] = name;
    room.sessions[owner] = token;
    room.ready[owner] = false;
    room.emptySince = null;
    ws.roomCode = room.code;
    ws.seat = owner;
    ws.joined = true;
    tokens.set(token, { code: room.code, owner });
  }
  function destroyRoom(room) {
    for (const ws of recipients(room)) {
      send(ws, { type: 'error', message: '房間已關閉。' });
      ws.close(1000);
    }
    for (const token of room.sessions) dropToken(token);
    rooms.delete(room.code);
    releaseRoom(room);
  }
  function sweepRooms() {
    const now = Date.now();
    pruneMaps();
    for (const room of rooms.values()) {
      markEmpty(room);
      if (room.emptySince && now - room.emptySince >= roomTtlMs) destroyRoom(room);
    }
  }
  function reject(ws, message) {
    send(ws, { type: 'error', message });
    ws.close(1008);
  }
  function invalid(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return true;
    if (typeof msg.type !== 'string' || !msg.type || msg.type.length > 32) return true;
    for (const value of Object.values(msg)) {
      if (typeof value === 'string' && value.length > 64) return true;
    }
    return false;
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
  let lastTick = performance.now();
  const tick = setInterval(() => {
    const now = performance.now(), dt = (now - lastTick) / 1000; lastTick = now;
    sweepRooms();
    for (const room of rooms.values()) {
      for (let i = 0; i < 2; i++) if (Date.now() > room.fastUntil[i]) room.fast[i] = false;
      for (let i = 0; i < 2; i++) if (room.reconnecting[i] && Date.now() >= room.reconnecting[i].deadline) timeoutReconnect(room, i);
      if (room.game.state === 'playing') {
        const lockBefore = `${room.game.locked[0]},${room.game.locked[1]},${room.game.state}`;
        const pieceBefore = JSON.stringify(room.game.pieces);
        room.game.tick(dt, room.fast);
        if (room.game.state === 'over') recordOutcome(room, room.game.winner);
        if (`${room.game.locked[0]},${room.game.locked[1]},${room.game.state}` !== lockBefore) broadcast(room, 'full');
        else if (JSON.stringify(room.game.pieces) !== pieceBefore || now - room.lastTickSent >= 200) {
          room.lastTickSent = now;
          broadcast(room, 'tick');
        }
      }
    }
  }, 50);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
      send(ws, { type: 'heartbeat' });
    }
  }, heartbeatMs);
  function writeStats() {
    let sockets = 0;
    for (const count of socketsByIp.values()) sockets += count;
    console.log(`flip-blocks rooms=${rooms.size} sockets=${sockets} rejected room_limit=${rejected.rooms} socket_limit=${rejected.sockets} create_rate=${rejected.create} http=${rejected.http} payload=${rejected.payload} idle=${rejected.idle}`);
    rejected.rooms = rejected.sockets = rejected.create = rejected.http = rejected.payload = rejected.idle = 0;
  }
  const stats = statsMs > 0 ? setInterval(writeStats, statsMs) : null;
  async function close() {
    clearInterval(tick); clearInterval(heartbeat); if (stats) clearInterval(stats);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    board.close();
  }
  return {
    server, close, leaderboard: board, rooms,
    limits: { maxRooms, maxRoomsPerIp, maxSocketsPerIp, createPerMin, httpPerMin, maxPayload, maxClients, rateLimit }
  };
}
if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('PORT 必須是 1–65535。'); process.exit(1); }
  const app = createServer();
  app.server.on('error', error => { console.error(`無法啟動連線主機：${error.code}（連接埠 ${port}）`); app.close().finally(() => process.exit(1)); });
  app.server.listen(port, '0.0.0.0', () => {
    console.log(`翻轉方塊連線主機已啟動。開啟 http://localhost:${port} 後建立房間，把 6 位房間代碼分給朋友。`);
    for (const addresses of Object.values(os.networkInterfaces())) for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) console.log(`同一區域網路的玩家可開啟 http://${address.address}:${port} 加入。`);
    }
    console.log(`空房逾時後回收。TRUST_PROXY=${envFlag('TRUST_PROXY', false) ? 'true' : 'false'}。Ctrl+C 關閉。`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit()));
}
module.exports = {
  createServer, resolveClientIp,
  RECONNECT_MS, ROOM_TTL_MS, MAX_ROOMS, RATE_LIMIT,
  MAX_ROOMS_PER_IP, MAX_SOCKETS_PER_IP, CREATE_PER_MIN, HTTP_PER_MIN,
  MAX_PAYLOAD, JOIN_IDLE_MS
};
