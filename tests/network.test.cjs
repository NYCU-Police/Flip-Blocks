const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createServer } = require('../server/index.cjs');
const { serverAddress, reconnectDelay, encodeBoard, decodeBoard, applyGame } = require('../docs/network.js');

async function fixture(t, options = {}) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'flip-rooms-'));
  const app = createServer({ ...options, dataDir });
  t.after(() => app.close());
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const port = app.server.address().port;
  let roomCode = options.code || '';
  async function client(role, color = 1, wsOptions = {}, extra = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/match`, wsOptions);
    const messages = [];
    ws.on('message', data => messages.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    const send = data => ws.send(JSON.stringify(data));
    const name = extra.name || (role === 'host' ? 'Host' : role === 'spectate' ? 'Watch' : 'Guest');
    if (role === 'host') send({ type: 'join', role: 'host', color, name, code: extra.code });
    else if (role === 'guest') send({ type: 'join', role: 'guest', color, name, code: extra.code || roomCode });
    else if (role === 'spectate') send({ type: 'join', role: 'spectate', name, code: extra.code || roomCode });
    async function wait(predicate, after = 0, ms = 2500) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const found = messages.slice(after).find(predicate);
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`Message timeout: ${JSON.stringify(messages.slice(-2))}`);
    }
    if (role === 'host') {
      const joined = await wait(m => m.type === 'joined' || m.type === 'error');
      if (joined.type === 'joined' && joined.code) roomCode = joined.code;
    }
    const state = (predicate = () => true, after = 0) => wait(m => m.type === 'state' && predicate(m), after);
    return { ws, messages, send, wait, state, get code() { return roomCode; } };
  }
  async function playing() {
    const host = await client('host'); await host.state();
    const guest = await client('guest'); await guest.state();
    host.send({ type: 'ready' }); guest.send({ type: 'ready' });
    await host.state(m => m.ready.every(Boolean));
    host.send({ type: 'start' }); await guest.state(m => m.game.state === 'playing');
    return { host, guest, code: roomCode };
  }
  return { app, port, client, playing, get code() { return roomCode; } };
}

test('IP entry accepts IP, port, IPv6 and HTTPS while rejecting unsafe URLs', () => {
  assert.equal(serverAddress(' 192.168.1.20 ').href, 'http://192.168.1.20:8787/');
  assert.equal(serverAddress('localhost:9000').port, '9000');
  assert.equal(serverAddress('[::1]:8787').hostname, '[::1]');
  assert.equal(serverAddress('https://game.example').href, 'https://game.example/');
  for (const input of ['', 'javascript://alert(1)', 'ftp://host', 'http://a:b@host', 'host/path', 'host?x=1', 'host:99999']) {
    assert.throws(() => serverAddress(input));
  }
  assert.equal(reconnectDelay(0), 500);
  assert.equal(reconnectDelay(1), 1000);
  assert.equal(reconnectDelay(4), 5000);
  const board = Array.from({ length: 20 }, (_, y) => Array(10).fill(y < 10 ? 1 : 2));
  assert.equal(encodeBoard(board).length, 200);
  assert.deepEqual(decodeBoard(encodeBoard(board)), board);
  const target = { board: encodeBoard(board), elapsed: 1 };
  applyGame(target, { elapsed: 2, board: encodeBoard(board) });
  assert.equal(target.elapsed, 2);
  assert.deepEqual(target.board, board);
});

test('server serves the game and rejects unrelated files and cross-origin upgrades', async t => {
  const { port } = await fixture(t);
  for (const asset of ['/', '/game.js', '/game-core.js', '/ai.js', '/network.js', '/audio.js', '/session-record.js', '/style.css']) assert.equal((await fetch(`http://127.0.0.1:${port}${asset}`)).status, 200);
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.uptime, 'number');
  assert.equal(body.rooms, 0);
  const board = await fetch(`http://127.0.0.1:${port}/leaderboard`);
  assert.equal(board.status, 200);
  assert.deepEqual((await board.json()).rankings, []);
  for (const asset of ['/server/index.cjs', '/.git/config', '/package.json']) assert.equal((await fetch(`http://127.0.0.1:${port}${asset}`)).status, 404);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/match`, { origin: 'https://another.example' });
  const [error] = await once(ws, 'error'); assert.match(error.message, /403/);
});

test('joining requires a host and rooms reject third players', async t => {
  const { client } = await fixture(t);
  const missing = await client('guest', 1, {}, { code: 'ABC234' });
  assert.match((await missing.wait(m => m.type === 'error')).message, /找不到房間/);
  const host = await client('host'); await host.state();
  const guest = await client('guest'); await guest.state(m => m.connected.every(Boolean));
  const extra = await client('guest'); assert.match((await extra.wait(m => m.type === 'error')).message, /已有人/);
  const extraHost = await client('host', 1, {}, { code: host.code });
  await extraHost.wait(m => m.type === 'error');
});

test('both players must prepare; color changes reset readiness and only host starts', async t => {
  const { client } = await fixture(t);
  const host = await client('host', 2); await host.state();
  const guest = await client('guest'); assert.equal((await guest.state()).game.sides[0].color, 2);
  host.send({ type: 'start' }); host.send({ type: 'ready' });
  assert.equal((await host.state(m => m.ready[0])).game.state, 'ready');
  guest.send({ type: 'ready' }); await host.state(m => m.ready.every(Boolean));
  const after = host.messages.length;
  host.send({ type: 'color', color: 1 });
  const changed = await host.state(m => m.game.sides[0].color === 1, after);
  assert.deepEqual(changed.ready, [false, false]);
  host.send({ type: 'ready' }); guest.send({ type: 'start' }); guest.send({ type: 'ready' });
  assert.equal((await host.state(m => m.ready.every(Boolean), after)).game.state, 'ready');
  host.send({ type: 'start' }); await guest.state(m => m.game.state === 'playing');
});

test('authoritative state matches for both players and spoofed owner cannot control opponent', async t => {
  const { playing } = await fixture(t);
  const { host, guest } = await playing();
  guest.send({ type: 'input', owner: 0, action: 'drop', board: [] });
  const state = await guest.state(m => m.game.locked[1] === 1);
  assert.deepEqual(state.game.locked, [0, 1]);
  const same = await host.state(m => m.revision === state.revision);
  assert.deepEqual(same.game, state.game);
  host.send({ type: 'input', owner: 1, action: 'drop' });
  await guest.state(m => m.game.locked[0] === 1);
});

test('pause freezes simulation, resume synchronizes, rematch needs new preparation', async t => {
  const { playing } = await fixture(t);
  const { host, guest } = await playing();
  guest.send({ type: 'pause' }); const paused = await host.state(m => m.game.state === 'paused');
  const after = host.messages.length;
  guest.send({ type: 'input', action: 'drop' });
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(host.messages.length, after);
  host.send({ type: 'resume' });
  const resumed = await guest.state(m => m.game.state === 'playing' && m.revision > paused.revision);
  assert.equal(resumed.game.elapsed, paused.game.elapsed);
  guest.send({ type: 'restart' }); host.send({ type: 'pause' });
  await host.state(m => m.game.state === 'paused' && m.revision > resumed.revision);
  host.send({ type: 'restart' }); const reset = await guest.state(m => m.game.state === 'ready' && m.revision > resumed.revision);
  assert.deepEqual(reset.ready, [false, false]); assert.deepEqual(reset.game.locked, [0, 0]);
});

test('guest leaving the lobby frees the seat; host departure closes room', async t => {
  const { client } = await fixture(t);
  const host = await client('host'); await host.state();
  const guest = await client('guest'); await guest.state(m => m.connected.every(Boolean));
  guest.ws.close(); const stopped = await host.state(m => !m.connected[1] && m.game.state === 'ready');
  assert.deepEqual(stopped.ready, [false, false]);
  const replacement = await client('guest'); const joined = await replacement.state();
  assert.equal(joined.game.state, 'ready');
  host.ws.close();
  const vacated = await replacement.state(m => !m.connected[0] && m.game.state === 'ready');
  assert.deepEqual(vacated.connected, [false, true]);
  const newHost = await client('host', 1, {}, { code: host.code });
  assert.deepEqual((await newHost.state()).connected, [true, true]);
});

test('disconnect keeps the match paused and notifies the remaining player', async t => {
  const { playing } = await fixture(t);
  const { host, guest } = await playing();
  guest.send({ type: 'input', action: 'drop' });
  const before = await guest.state(m => m.game.locked[1] === 1);
  guest.ws.close();
  const waiting = await host.wait(m => m.type === 'reconnect-waiting');
  assert.equal(waiting.owner, 1);
  assert.ok(waiting.deadline > Date.now());
  const paused = await host.state(m => m.game.state === 'paused' && m.reconnect?.owner === 1);
  assert.deepEqual(paused.game.board, before.game.board);
  assert.deepEqual(paused.game.locked, before.game.locked);
  assert.deepEqual(paused.game.pieces, before.game.pieces);
  assert.deepEqual(paused.game.queues, before.game.queues);
  assert.deepEqual(paused.connected, [true, false]);
  const after = host.messages.length;
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(host.messages.slice(after).some(m => m.type === 'state' && m.game.elapsed !== paused.game.elapsed), false);
});

test('session token reconnect restores the match', async t => {
  const { playing, client } = await fixture(t);
  const { host, guest } = await playing();
  guest.send({ type: 'input', action: 'drop' });
  const before = await guest.state(m => m.game.locked[1] === 1);
  const token = guest.messages.find(m => m.type === 'joined').sessionToken;
  assert.equal(typeof token, 'string');
  assert.match(token, /^[0-9a-f]{32}$/);
  guest.ws.close();
  await host.wait(m => m.type === 'reconnect-waiting');
  const back = await client();
  back.send({ type: 'reconnect', sessionToken: token, code: guest.code });
  const joined = await back.wait(m => m.type === 'joined');
  assert.equal(joined.owner, 1);
  assert.equal(joined.sessionToken, token);
  await back.wait(m => m.type === 'reconnected' && m.owner === 1);
  const restored = await back.state(m => m.game.state === 'playing' && !m.reconnect);
  assert.deepEqual(restored.game.board, before.game.board);
  assert.deepEqual(restored.game.locked, before.game.locked);
  assert.deepEqual(restored.game.pieces, before.game.pieces);
  const hostResumed = await host.state(m => m.game.state === 'playing' && m.connected.every(Boolean) && !m.reconnect && m.revision > before.revision);
  assert.deepEqual(hostResumed.game.locked, before.game.locked);
  back.send({ type: 'input', action: 'drop' });
  await host.state(m => m.game.locked[1] === 2);
});

test('reconnect timeout awards the remaining player and returns to the lobby', async t => {
  const { playing, client } = await fixture(t, { reconnectMs: 200 });
  const { host, guest } = await playing();
  guest.ws.close();
  const timeout = await host.wait(m => m.type === 'reconnect-timeout', 0, 2000);
  assert.equal(timeout.owner, 1);
  assert.equal(timeout.winner, 0);
  const lobby = await host.state(m => m.game.state === 'ready' && !m.connected[1] && !m.reconnect);
  assert.deepEqual(lobby.connected, [true, false]);
  const replacement = await client('guest');
  const joined = await replacement.state();
  assert.equal(joined.game.state, 'ready');
  assert.deepEqual(joined.connected, [true, true]);
});

test('missing or wrong session token cannot claim a reconnecting seat', async t => {
  const { playing, client } = await fixture(t);
  const { host, guest } = await playing();
  const token = guest.messages.find(m => m.type === 'joined').sessionToken;
  guest.ws.close();
  await host.wait(m => m.type === 'reconnect-waiting');
  const noToken = await client('guest');
  assert.match((await noToken.wait(m => m.type === 'error')).message, /已有人/);
  const wrong = await client();
  wrong.send({ type: 'reconnect', sessionToken: 'not-a-valid-token', code: guest.code });
  assert.match((await wrong.wait(m => m.type === 'error')).message, /憑證/);
  const empty = await client();
  empty.send({ type: 'reconnect', sessionToken: '', code: guest.code });
  assert.match((await empty.wait(m => m.type === 'error')).message, /憑證/);
  const usurper = await client();
  usurper.send({ type: 'join', role: 'guest', name: 'Usurper', code: guest.code });
  assert.match((await usurper.wait(m => m.type === 'error')).message, /已有人/);
  const back = await client();
  back.send({ type: 'reconnect', sessionToken: token, code: guest.code });
  assert.equal((await back.wait(m => m.type === 'joined')).owner, 1);
  await host.state(m => m.game.state === 'playing' && m.connected.every(Boolean));
});

test('malformed and oversized packets cannot crash the server', async t => {
  const { client } = await fixture(t);
  for (const payload of ['{broken', 'x'.repeat(3000)]) {
    const bad = await client(); const closed = once(bad.ws, 'close'); bad.ws.send(payload); await closed;
  }
  const host = await client('host'); await host.state();
  for (const message of [{ type: 'color', color: 3 }, { type: 'input', action: '__proto__' }]) host.send(message);
  host.send({ type: 'ready' }); assert.equal((await host.state(m => m.ready[0])).game.state, 'ready');
});

test('playing ticks stay smaller than compact snapshots, which stay smaller than naive boards', async t => {
  const { playing } = await fixture(t);
  const { guest } = await playing();
  guest.send({ type: 'input', action: 'drop' });
  const full = await guest.state(m => m.game.locked[1] === 1);
  assert.equal(typeof full.game.board, 'string');
  assert.equal(full.game.board.length, 200);
  const compactBytes = Buffer.byteLength(JSON.stringify(full));
  const naive = { ...full, game: { ...full.game, board: decodeBoard(full.game.board) } };
  const naiveBytes = Buffer.byteLength(JSON.stringify(naive));
  const tick = await guest.wait(m => m.type === 'tick', 0, 2500);
  const tickBytes = Buffer.byteLength(JSON.stringify(tick));
  assert.ok(compactBytes < naiveBytes, `compact ${compactBytes} should beat naive ${naiveBytes}`);
  assert.ok(tickBytes < compactBytes, `tick ${tickBytes} should beat compact ${compactBytes}`);
});

test('heartbeat removes an unresponsive player and stops the match', async t => {
  const { client } = await fixture(t, { heartbeatMs: 100 });
  const host = await client('host'); await host.state();
  await host.wait(m => m.type === 'heartbeat', 0, 2500);
  const guest = await client('guest', 1, { autoPong: false }); await guest.state();
  const closed = once(guest.ws, 'close'); await closed;
  await host.state(m => !m.connected[1] && m.revision > 2);
});

test('heartbeat drop during a match waits for reconnect instead of ending it', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const app = createServer({ heartbeatMs: 80, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'flip-hb-')) });
  t.after(() => app.close());
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const port = app.server.address().port;
  let hostCode = '';
  async function join(role, wsOptions = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/match`, wsOptions);
    const messages = [];
    ws.on('message', data => messages.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'join', role, color: 1, name: role === 'host' ? 'Host' : 'Guest', code: role === 'guest' ? hostCode : undefined }));
    const wait = async (predicate, ms = 2500) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('timeout');
    };
    return { ws, send: data => ws.send(JSON.stringify(data)), wait };
  }
  const host = await join('host');
  hostCode = (await host.wait(m => m.type === 'joined')).code;
  await host.wait(m => m.type === 'state');
  const guest = await join('guest', { autoPong: false }); await guest.wait(m => m.connected?.every(Boolean));
  host.send({ type: 'ready' }); guest.send({ type: 'ready' });
  await host.wait(m => m.ready?.every(Boolean));
  host.send({ type: 'start' }); await host.wait(m => m.game?.state === 'playing');
  await once(guest.ws, 'close');
  const waiting = await host.wait(m => m.type === 'reconnect-waiting', 2500);
  assert.equal(waiting.owner, 1);
});
