'use strict';
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { WebSocketServer } = require('ws');
const { openLeaderboard } = require('./leaderboard.cjs');
const {
  RECONNECT_MS, ROOM_TTL_MS, MAX_ROOMS, RATE_LIMIT, MAX_CLIENTS,
  MAX_ROOMS_PER_IP, MAX_SOCKETS_PER_IP, CREATE_PER_MIN, HTTP_PER_MIN,
  MAX_PAYLOAD, JOIN_IDLE_MS, STATS_MS,
  envFlag, envInt, resolveClientIp, createAbuseState
} = require('./limits.cjs');
const { createRoomLife } = require('./rooms.cjs');
const { createRequestListener } = require('./http.cjs');
const { createSender, attachUpgrade, attachConnections } = require('./ws.cjs');

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
  const abuse = createAbuseState({ trustProxy, createWindowMs, httpWindowMs, httpPerMin });
  const {
    socketsByIp, roomsByIp, createHits, httpHits, rejected,
    allowWindow, pruneMaps, addSocket, dropSocket, takeRoom, releaseRoom, limitedApi
  } = abuse;
  const board = openLeaderboard(dataDir);
  const send = createSender();
  const life = createRoomLife({
    rooms, tokens, reconnectMs, roomTtlMs, board, send, releaseRoom, pruneMaps
  });
  const server = http.createServer(createRequestListener({
    started, rooms, board, limitedApi, docsDir: path.join(__dirname, '../docs')
  }));
  const wss = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });
  attachUpgrade(server, wss, {
    trustProxy, maxClients, maxSocketsPerIp, socketsByIp, rejected, addSocket
  });
  attachConnections(wss, {
    rooms, tokens, rejected, maxRooms, maxRoomsPerIp, createPerMin, createWindowMs,
    rateLimit, maxPayload, joinIdleMs, roomsByIp, createHits, allowWindow, takeRoom,
    dropSocket, send, ...life
  });
  let lastTick = performance.now();
  const tick = setInterval(() => {
    const now = performance.now(), dt = (now - lastTick) / 1000; lastTick = now;
    life.sweepRooms();
    for (const room of rooms.values()) {
      for (let i = 0; i < 2; i++) if (Date.now() > room.fastUntil[i]) room.fast[i] = false;
      for (let i = 0; i < 2; i++) if (room.reconnecting[i] && Date.now() >= room.reconnecting[i].deadline) life.timeoutReconnect(room, i);
      if (room.game.state === 'playing') {
        const lockBefore = `${room.game.locked[0]},${room.game.locked[1]},${room.game.state}`;
        const pieceBefore = JSON.stringify(room.game.pieces);
        room.game.tick(dt, room.fast);
        if (room.game.state === 'over') life.recordOutcome(room, room.game.winner);
        if (`${room.game.locked[0]},${room.game.locked[1]},${room.game.state}` !== lockBefore) life.broadcast(room, 'full');
        else if (JSON.stringify(room.game.pieces) !== pieceBefore || now - room.lastTickSent >= 200) {
          room.lastTickSent = now;
          life.broadcast(room, 'tick');
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
