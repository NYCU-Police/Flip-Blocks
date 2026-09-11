const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { createServer } = require('../server/index.cjs');

async function start(t, options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'flip-drain-'));
  const app = createServer({ statsMs: 0, ...options, dataDir });
  t.after(() => app.close());
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = app.server.address().port;
  async function open(payload) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/match`);
    const messages = [];
    ws.on('message', data => messages.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    if (payload) ws.send(JSON.stringify(payload));
    async function wait(predicate, ms = 2500) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`timeout ${JSON.stringify(messages.slice(-3))}`);
    }
    return { ws, messages, send: data => ws.send(JSON.stringify(data)), wait };
  }
  return { app, port, open };
}

async function playing(open, hostName = 'Host', guestName = 'Guest') {
  const host = await open({ type: 'join', role: 'host', name: hostName });
  const code = (await host.wait(m => m.type === 'joined')).code;
  const guest = await open({ type: 'join', role: 'guest', name: guestName, code });
  await guest.wait(m => m.connected?.every(Boolean));
  host.send({ type: 'ready' }); guest.send({ type: 'ready' });
  await host.wait(m => m.ready?.every(Boolean));
  host.send({ type: 'start' });
  await host.wait(m => m.game?.state === 'playing');
  return { host, guest, code };
}

test('drain with no live match closes immediately and close is safe to call twice', async t => {
  const { app } = await start(t);
  const began = Date.now();
  await app.drain(5000);
  assert.ok(Date.now() - began < 800);
  await app.close();
});

test('drain rejects new rooms, waits for a live match to end, and still allows joining an existing lobby', async t => {
  const { app, open } = await start(t);
  const lobby = await open({ type: 'join', role: 'host', name: 'Lobby' });
  const lobbyCode = (await lobby.wait(m => m.type === 'joined')).code;
  const { host, guest } = await playing(open, 'Stay', 'Quit');
  assert.equal(app.isDraining(), false);
  const waiting = app.drain(4000);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(app.isDraining(), true);
  const late = await open({ type: 'join', role: 'host', name: 'Late' });
  assert.equal((await late.wait(m => m.type === 'error')).message, '無法建立房間，請稍後再試。');
  const seat = await open({ type: 'join', role: 'guest', name: 'Joiner', code: lobbyCode });
  assert.equal((await seat.wait(m => m.type === 'joined')).role, 'player');
  guest.send({ type: 'leave' });
  await host.wait(m => m.game?.state === 'ready');
  await waiting;
});

test('drain times out while a match is still playing', async t => {
  const { app, open } = await start(t);
  await playing(open);
  const began = Date.now();
  await app.drain(80);
  assert.ok(Date.now() - began >= 80);
  assert.ok(Date.now() - began < 800);
});
