const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createServer } = require('../server/index.cjs');
const { serverAddress } = require('../docs/network.js');

async function fixture(t, options) {
  const app = createServer(options);
  t.after(() => app.close());
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const port = app.server.address().port;
  async function client(role, color = 1, wsOptions = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/match`, wsOptions);
    const messages = [];
    ws.on('message', data => messages.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    const send = data => ws.send(JSON.stringify(data));
    if (role) send({ type: 'join', role, color });
    async function wait(predicate, after = 0) {
      const end = Date.now() + 2500;
      while (Date.now() < end) {
        const found = messages.slice(after).find(predicate);
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`Message timeout: ${JSON.stringify(messages.slice(-2))}`);
    }
    const state = (predicate = () => true, after = 0) => wait(m => m.type === 'state' && predicate(m), after);
    return { ws, messages, send, wait, state };
  }
  async function playing() {
    const host = await client('host'); await host.state();
    const guest = await client('guest'); await guest.state();
    host.send({ type: 'ready' }); guest.send({ type: 'ready' });
    await host.state(m => m.ready.every(Boolean));
    host.send({ type: 'start' }); await guest.state(m => m.game.state === 'playing');
    return { host, guest };
  }
  return { app, port, client, playing };
}

test('IP entry accepts IP, port, IPv6 and HTTPS while rejecting unsafe URLs', () => {
  assert.equal(serverAddress(' 192.168.1.20 ').href, 'http://192.168.1.20:8787/');
  assert.equal(serverAddress('localhost:9000').port, '9000');
  assert.equal(serverAddress('[::1]:8787').hostname, '[::1]');
  assert.equal(serverAddress('https://game.example').href, 'https://game.example/');
  for (const input of ['', 'javascript://alert(1)', 'ftp://host', 'http://a:b@host', 'host/path', 'host?x=1', 'host:99999']) {
    assert.throws(() => serverAddress(input));
  }
});

test('server serves the game and rejects unrelated files and cross-origin upgrades', async t => {
  const { port } = await fixture(t);
  for (const asset of ['/', '/game.js', '/network.js', '/style.css']) assert.equal((await fetch(`http://127.0.0.1:${port}${asset}`)).status, 200);
  for (const asset of ['/server/index.cjs', '/.git/config', '/package.json']) assert.equal((await fetch(`http://127.0.0.1:${port}${asset}`)).status, 404);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/match`, { origin: 'https://another.example' });
  const [error] = await once(ws, 'error'); assert.match(error.message, /403/);
});

test('joining requires a host and rooms reject third players', async t => {
  const { client } = await fixture(t);
  const early = await client('guest'); assert.match((await early.wait(m => m.type === 'error')).message, /尚無房主/);
  const host = await client('host'); await host.state();
  const guest = await client('guest'); await guest.state(m => m.connected.every(Boolean));
  const extra = await client('guest'); assert.match((await extra.wait(m => m.type === 'error')).message, /已有人/);
  const extraHost = await client('host'); await extraHost.wait(m => m.type === 'error');
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

test('guest disconnect stops match and permits replacement; host departure closes room', async t => {
  const { playing, client } = await fixture(t);
  const { host, guest } = await playing();
  guest.ws.close(); const stopped = await host.state(m => m.game.state === 'ready' && !m.connected[1] && m.revision > 3);
  assert.deepEqual(stopped.ready, [false, false]);
  const replacement = await client('guest'); const joined = await replacement.state();
  assert.equal(joined.game.state, 'ready');
  host.ws.close(); assert.match((await replacement.wait(m => m.type === 'error')).message, /房主已離開/);
  const newHost = await client('host'); assert.deepEqual((await newHost.state()).connected, [true, false]);
});

test('malformed and oversized packets cannot crash the server', async t => {
  const { client } = await fixture(t);
  for (const payload of ['{broken', 'x'.repeat(3000)]) {
    const bad = await client(); const closed = once(bad.ws, 'close'); bad.ws.send(payload); await closed;
  }
  const host = await client('host'); await host.state();
  for (const message of [null, [], { type: 'color', color: 3 }, { type: 'input', action: '__proto__' }]) host.send(message);
  host.send({ type: 'ready' }); assert.equal((await host.state(m => m.ready[0])).game.state, 'ready');
});

test('heartbeat removes an unresponsive player and stops the match', async t => {
  const { client } = await fixture(t, { heartbeatMs: 100 });
  const host = await client('host'); await host.state();
  const guest = await client('guest', 1, { autoPong: false }); await guest.state();
  const closed = once(guest.ws, 'close'); await closed;
  await host.state(m => !m.connected[1] && m.revision > 2);
});
