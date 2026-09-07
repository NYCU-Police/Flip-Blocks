'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { Game } = require('../docs/game-core.js');
const { encodeBoard } = require('../docs/network.js');

const RECONNECT_MS = 60000;

// A server owns one two-player room. Clients send actions, never board state.
function createServer({ heartbeatMs = 5000, reconnectMs = RECONNECT_MS } = {}) {
  const game = new Game();
  const players = [null, null], fast = [false, false], fastUntil = [0, 0];
  const ready = [false, false];
  const sessions = [null, null];
  const reconnecting = [null, null];
  let pausedForReconnect = false;
  let revision = 0;
  const assets = new Map([
    ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
    ['/game.js', ['game.js', 'text/javascript']], ['/game-core.js', ['game-core.js', 'text/javascript']],
    ['/network.js', ['network.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
    ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
  ]);
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { res.writeHead(400); res.end('Invalid URL'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const asset = assets.get(url.pathname);
    if (!asset) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(path.join(__dirname, '../docs', asset[0])).pipe(res);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    // Browser clients connect only from the page served by this host.
    let validOrigin = !req.headers.origin;
    try { validOrigin ||= new URL(req.headers.origin).host === req.headers.host; } catch {}
    if (req.url !== '/match' || !validOrigin || wss.clients.size >= 16) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  function send(ws, data) {
    if (ws?.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > 256 * 1024) { ws.terminate(); return; }
      ws.send(JSON.stringify(data));
    }
  }
  function reconnectInfo() {
    const owner = reconnecting.findIndex(Boolean);
    if (owner < 0) return null;
    return { owner, deadline: reconnecting[owner].deadline };
  }
  function round3(n) { return Math.round(n * 1000) / 1000; }
  function publicGame() {
    return {
      state: game.state, sides: game.sides, board: encodeBoard(game.board), queues: game.queues,
      pieces: game.pieces, timers: [round3(game.timers[0]), round3(game.timers[1])],
      locked: game.locked, elapsed: round3(game.elapsed), winner: game.winner, lastFlips: game.lastFlips
    };
  }
  function broadcast(kind = 'full') {
    if (kind === 'tick') {
      const data = {
        type: 'tick', revision: ++revision, elapsed: round3(game.elapsed), pieces: game.pieces,
        timers: [round3(game.timers[0]), round3(game.timers[1])], locked: game.locked,
        state: game.state, lastFlips: game.lastFlips
      };
      for (const ws of players) send(ws, data);
      return;
    }
    const data = { type: 'state', revision: ++revision, game: publicGame(), connected: players.map(Boolean), ready, reconnect: reconnectInfo() };
    for (const ws of players) send(ws, data);
  }
  function stopInput() { fast.fill(false); fastUntil.fill(0); }
  function matchActive() { return game.state === 'playing' || game.state === 'paused'; }
  function seatTaken(owner) { return Boolean(players[owner] || reconnecting[owner]); }
  function issueToken() { return crypto.randomBytes(16).toString('hex'); }
  function startReconnect(owner) {
    players[owner] = null;
    ready[owner] = false;
    stopInput();
    if (game.state === 'playing') {
      game.pause();
      pausedForReconnect = true;
    }
    const deadline = Date.now() + reconnectMs;
    reconnecting[owner] = { deadline };
    const payload = { type: 'reconnect-waiting', owner, deadline };
    for (const ws of players) send(ws, payload);
    broadcast();
  }
  function resumeIfReady() {
    if (reconnecting.every(slot => !slot) && pausedForReconnect && game.state === 'paused' && players.every(Boolean)) {
      game.pause();
      pausedForReconnect = false;
    }
  }
  function timeoutReconnect(owner) {
    const remaining = 1 - owner;
    reconnecting[owner] = null;
    sessions[owner] = null;
    players[owner] = null;
    ready.fill(false);
    stopInput();
    pausedForReconnect = false;
    const payload = { type: 'reconnect-timeout', owner, winner: remaining };
    for (const ws of players) send(ws, payload);
    game.reset(game.sides[0].color);
    game.state = 'ready';
    broadcast();
  }
  function lobbyDepart(owner) {
    players[owner] = null;
    sessions[owner] = null;
    reconnecting[owner] = null;
    ready.fill(false);
    stopInput();
    pausedForReconnect = false;
    if (owner === 0) {
      const guest = players[1];
      players[1] = null;
      sessions[1] = null;
      send(guest, { type: 'error', message: '房主已離開，請重新加入或建立房間。' });
      guest?.close(1000);
      game.state = 'ready';
    } else {
      game.state = 'ready';
      broadcast();
    }
  }
  function forfeitToLobby(owner) {
    reconnecting[owner] = null;
    sessions[owner] = null;
    players[owner] = null;
    ready.fill(false);
    stopInput();
    pausedForReconnect = false;
    game.reset(game.sides[0].color);
    game.state = 'ready';
    broadcast();
  }
  function claimSeat(ws, owner, token) {
    players[owner] = ws;
    ws.owner = owner;
    sessions[owner] = token;
    ready[owner] = false;
  }
  wss.on('connection', ws => {
    ws.owner = -1; ws.alive = true; ws.messages = 0; ws.windowStart = Date.now();
    ws.released = false;
    const joinTimer = setTimeout(() => { if (ws.owner === -1) ws.close(1008, 'Join timeout'); }, 10000);
    ws.on('error', () => {});
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (raw, binary) => {
      if (Date.now() - ws.windowStart >= 1000) { ws.messages = 0; ws.windowStart = Date.now(); }
      if (++ws.messages > 100 || binary) { ws.close(1008, 'Invalid traffic'); return; }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { ws.close(1008, 'Invalid JSON'); return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      if (ws.owner === -1) {
        if (msg.type === 'reconnect') {
          if (typeof msg.sessionToken !== 'string' || !msg.sessionToken) {
            send(ws, { type: 'error', message: '無效的重連憑證。' }); ws.close(1008); return;
          }
          const owner = sessions.findIndex(token => token === msg.sessionToken);
          if (owner < 0) {
            send(ws, { type: 'error', message: '無效的重連憑證。' }); ws.close(1008); return;
          }
          if (players[owner]) {
            send(ws, { type: 'error', message: '此座位仍在線，無法重連。' }); ws.close(1008); return;
          }
          claimSeat(ws, owner, sessions[owner]);
          reconnecting[owner] = null;
          clearTimeout(joinTimer);
          resumeIfReady();
          send(ws, { type: 'joined', owner, sessionToken: sessions[owner] });
          const restored = { type: 'reconnected', owner };
          for (const seat of players) send(seat, restored);
          broadcast();
          return;
        }
        if (msg.type !== 'join' || !['host', 'guest'].includes(msg.role)) return;
        const owner = msg.role === 'host' ? 0 : 1;
        const error = seatTaken(owner) ? '房間已有人，請稍後再試。' : owner === 1 && !players[0] && !reconnecting[0] ? '尚無房主，請先建立房間。' : '';
        if (error) { send(ws, { type: 'error', message: error }); ws.close(1008); return; }
        if (owner === 0) { game.reset(msg.color === 2 ? 2 : 1); game.state = 'ready'; ready.fill(false); }
        claimSeat(ws, owner, issueToken());
        clearTimeout(joinTimer);
        send(ws, { type: 'joined', owner, sessionToken: sessions[owner] }); broadcast(); return;
      }
      const owner = ws.owner;
      if (players[owner] !== ws) return;
      if (msg.type === 'leave') {
        ws.released = true;
        if (matchActive()) forfeitToLobby(owner);
        else lobbyDepart(owner);
        return;
      }
      if (msg.type === 'ready' && game.state === 'ready') ready[owner] = !ready[owner];
      else if (msg.type === 'color' && owner === 0 && game.state === 'ready' && [1, 2].includes(msg.color)) {
        game.reset(msg.color); game.state = 'ready'; ready.fill(false);
      } else if (msg.type === 'start' && owner === 0 && game.state === 'ready' && players.every(Boolean) && ready.every(Boolean)) {
        game.reset(game.sides[0].color); stopInput();
      } else if (msg.type === 'restart' && owner === 0 && game.state !== 'ready' && !reconnecting.some(Boolean)) {
        game.reset(game.sides[0].color); game.state = 'ready'; ready.fill(false); stopInput();
      } else if (msg.type === 'pause' && game.state === 'playing') { game.pause(); stopInput(); }
      else if (msg.type === 'resume' && game.state === 'paused' && players.every(Boolean) && !reconnecting.some(Boolean)) { game.pause(); stopInput(); }
      else if (msg.type === 'input' && game.state === 'playing') {
        // Ignore any owner supplied by the client; its socket determines its side.
        if (msg.action === 'left') game.move(owner, -1);
        else if (msg.action === 'right') game.move(owner, 1);
        else if (msg.action === 'rotate') game.rotate(owner);
        else if (msg.action === 'drop') game.step(owner, true);
        else if (msg.action === 'step') game.step(owner);
        else if (msg.action === 'soft' && typeof msg.down === 'boolean') {
          fast[owner] = msg.down; fastUntil[owner] = Date.now() + 1500;
        } else return;
      } else return;
      broadcast();
    });
    ws.on('close', () => {
      clearTimeout(joinTimer);
      if (ws.released) return;
      if (ws.owner < 0 || players[ws.owner] !== ws) return;
      const owner = ws.owner;
      if (matchActive()) startReconnect(owner);
      else lobbyDepart(owner);
    });
  });
  let lastTick = performance.now(), lastTickSent = 0;
  const tick = setInterval(() => {
    const now = performance.now(), dt = (now - lastTick) / 1000; lastTick = now;
    for (let i = 0; i < 2; i++) if (Date.now() > fastUntil[i]) fast[i] = false;
    for (let i = 0; i < 2; i++) if (reconnecting[i] && Date.now() >= reconnecting[i].deadline) timeoutReconnect(i);
    if (game.state === 'playing') {
      const lockBefore = `${game.locked[0]},${game.locked[1]},${game.state}`;
      const pieceBefore = JSON.stringify(game.pieces);
      game.tick(dt, fast);
      if (`${game.locked[0]},${game.locked[1]},${game.state}` !== lockBefore) broadcast('full');
      else if (JSON.stringify(game.pieces) !== pieceBefore || now - lastTickSent >= 200) {
        lastTickSent = now;
        broadcast('tick');
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
  async function close() {
    clearInterval(tick); clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
  return { server, close };
}
if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('PORT 必須是 1–65535。'); process.exit(1); }
  const app = createServer();
  app.server.on('error', error => { console.error(`無法啟動連線主機：${error.code}（連接埠 ${port}）`); app.close().finally(() => process.exit(1)); });
  app.server.listen(port, '0.0.0.0', () => {
    console.log(`翻轉方塊連線主機已啟動。房主開啟 http://localhost:${port} 後按「建立房間」。`);
    for (const addresses of Object.values(os.networkInterfaces())) for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) console.log(`同一區域網路的玩家可開啟 http://${address.address}:${port} 加入。`);
    }
    console.log('每個主機限一個雙人房間；Ctrl+C 關閉。');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit()));
}
module.exports = { createServer, RECONNECT_MS };
