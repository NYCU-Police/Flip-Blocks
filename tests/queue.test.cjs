const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { createServer, MAX_QUEUE_PER_IP, QUEUE_IDLE_MS } = require('../server/index.cjs');
const { createMatchQueue } = require('../server/queue.cjs');

async function start(t, options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'flip-queue-'));
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('two queue joins become a ready lobby without recording a win', async t => {
  assert.equal(MAX_QUEUE_PER_IP, 2);
  assert.equal(QUEUE_IDLE_MS, 5 * 60 * 1000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-queue-board-'));
  const { open, port, app } = await start(t, { dataDir });
  const a = await open({ type: 'queue', name: 'Ada', color: 2 });
  await a.wait(m => m.type === 'queued');
  const b = await open({ type: 'queue', name: 'Bea' });
  const aJoin = await a.wait(m => m.type === 'joined');
  const bJoin = await b.wait(m => m.type === 'joined');
  assert.equal(aJoin.owner, 0);
  assert.equal(bJoin.owner, 1);
  assert.equal(aJoin.role, 'player');
  assert.match(aJoin.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(bJoin.code, aJoin.code);
  const state = await a.wait(m => m.type === 'state');
  assert.equal(state.game.state, 'ready');
  assert.deepEqual(state.connected, [true, true]);
  assert.equal(state.game.sides[0].color, 2);
  assert.equal(app.rooms.size, 1);
  const board = await (await fetch(`http://127.0.0.1:${port}/leaderboard`)).json();
  assert.deepEqual(board.rankings, []);
});

test('a second queue on the same socket does not leave a ghost waiter', async t => {
  const { open, app } = await start(t);
  const a = await open({ type: 'queue', name: 'Ada' });
  await a.wait(m => m.type === 'queued');
  a.send({ type: 'queue', name: 'Ada' });
  await sleep(40);
  assert.equal(app.queue.size(), 1);
  const b = await open({ type: 'queue', name: 'Bea' });
  await a.wait(m => m.type === 'joined');
  await b.wait(m => m.type === 'joined');
  const c = await open({ type: 'queue', name: 'Cara' });
  await c.wait(m => m.type === 'queued');
  assert.ok(!c.messages.some(m => m.type === 'joined'));
  assert.equal(app.queue.size(), 1);
});

test('same IP cannot occupy more than maxQueuePerIp queue slots', async t => {
  const isolated = createMatchQueue({ maxQueuePerIp: 2 });
  assert.equal(isolated.enqueue({ clientIp: '198.51.100.1' }, 'Ada', 1).ok, true);
  assert.equal(isolated.enqueue({ clientIp: '198.51.100.1' }, 'Bea', 1).ok, true);
  assert.equal(isolated.enqueue({ clientIp: '198.51.100.1' }, 'Cara', 1).ok, false);

  const pair = await start(t, { maxQueuePerIp: 2 });
  const host = await pair.open({ type: 'queue', name: 'Ada' });
  await host.wait(m => m.type === 'queued');
  const guest = await pair.open({ type: 'queue', name: 'Bea' });
  assert.equal((await host.wait(m => m.type === 'joined')).owner, 0);
  assert.equal((await guest.wait(m => m.type === 'joined')).owner, 1);

  const capped = await start(t, { maxQueuePerIp: 1 });
  const first = await capped.open({ type: 'queue', name: 'One' });
  await first.wait(m => m.type === 'queued');
  const extra = await capped.open({ type: 'queue', name: 'Two' });
  assert.equal((await extra.wait(m => m.type === 'error')).message, '無法配對，請稍後再試。');
  assert.equal(capped.app.queue.size(), 1);
  assert.ok(!first.messages.some(m => m.type === 'joined'));
});

test('disconnecting a waiter removes them so the next person keeps waiting', async t => {
  const { open, app } = await start(t);
  const a = await open({ type: 'queue', name: 'Ada' });
  await a.wait(m => m.type === 'queued');
  a.ws.close();
  await once(a.ws, 'close');
  await sleep(40);
  assert.equal(app.queue.size(), 0);
  const b = await open({ type: 'queue', name: 'Bea' });
  await b.wait(m => m.type === 'queued');
  assert.ok(!b.messages.some(m => m.type === 'joined'));
  assert.equal(app.queue.size(), 1);
});

test('leave cancels a queued waiter so the next person is not matched', async t => {
  const { open, app } = await start(t);
  const a = await open({ type: 'queue', name: 'Ada' });
  await a.wait(m => m.type === 'queued');
  a.send({ type: 'leave' });
  await sleep(40);
  assert.equal(app.queue.size(), 0);
  const b = await open({ type: 'queue', name: 'Bea' });
  await b.wait(m => m.type === 'queued');
  assert.ok(!b.messages.some(m => m.type === 'joined'));
  assert.equal(app.queue.size(), 1);
});

test('drain clears the queue, notifies waiters, and rejects a new queue', async t => {
  const { app, open } = await start(t);
  const waiter = await open({ type: 'queue', name: 'Ada' });
  await waiter.wait(m => m.type === 'queued');
  const host = await open({ type: 'join', role: 'host', name: 'Stay' });
  const code = (await host.wait(m => m.type === 'joined')).code;
  const guest = await open({ type: 'join', role: 'guest', name: 'Quit', code });
  await guest.wait(m => m.connected?.every(Boolean));
  host.send({ type: 'ready' }); guest.send({ type: 'ready' });
  await host.wait(m => m.ready?.every(Boolean));
  host.send({ type: 'start' });
  await host.wait(m => m.game?.state === 'playing');
  const draining = app.drain(4000);
  await sleep(30);
  assert.equal(app.isDraining(), true);
  assert.equal((await waiter.wait(m => m.type === 'error')).message, '無法建立房間，請稍後再試。');
  const late = await open({ type: 'queue', name: 'Late' });
  assert.equal((await late.wait(m => m.type === 'error')).message, '無法建立房間，請稍後再試。');
  guest.send({ type: 'leave' });
  await draining;
});

test('quota failure rejects the head with an error and leaves the next person queued', async t => {
  const { open } = await start(t, { maxRoomsPerIp: 1 });
  const occupied = await open({ type: 'join', role: 'host', name: 'Keep' });
  await occupied.wait(m => m.type === 'joined');
  const a = await open({ type: 'queue', name: 'Ada' });
  await a.wait(m => m.type === 'queued');
  const b = await open({ type: 'queue', name: 'Bea' });
  assert.equal((await a.wait(m => m.type === 'error')).message, '無法建立房間，請稍後再試。');
  await b.wait(m => m.type === 'queued');
  assert.ok(!b.messages.some(m => m.type === 'joined'));
  assert.ok(!a.messages.some(m => m.type === 'joined'));
});

test('queued waiters stay online past JOIN_IDLE_MS and still receive heartbeats', async t => {
  const { open, app } = await start(t, { joinIdleMs: 80, heartbeatMs: 40 });
  const a = await open({ type: 'queue', name: 'Ada' });
  await a.wait(m => m.type === 'queued');
  await a.wait(m => m.type === 'heartbeat');
  await sleep(200);
  assert.equal(a.ws.readyState, WebSocket.OPEN);
  assert.ok(!a.messages.some(m => m.type === 'joined' || m.type === 'error'));
  assert.equal(app.queue.size(), 1);
});

test('a queued match uses the existing room forfeit path', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-queue-forfeit-'));
  const { open, port } = await start(t, { dataDir });
  const host = await open({ type: 'queue', name: 'Stay' });
  await host.wait(m => m.type === 'queued');
  const guest = await open({ type: 'queue', name: 'Quit' });
  await host.wait(m => m.type === 'joined');
  await guest.wait(m => m.type === 'joined');
  await host.wait(m => m.game?.state === 'ready' && m.connected?.every(Boolean));
  host.send({ type: 'ready' }); guest.send({ type: 'ready' });
  await host.wait(m => m.ready?.every(Boolean));
  host.send({ type: 'start' });
  await host.wait(m => m.game?.state === 'playing');
  guest.send({ type: 'leave' });
  await host.wait(m => m.game?.state === 'ready' && m.connected?.[1] === false);
  const after = await (await fetch(`http://127.0.0.1:${port}/leaderboard`)).json();
  assert.deepEqual(after.rankings, [{ name: 'Stay', wins: 1 }]);
});

test('a queued room can be spectated with the issued code', async t => {
  const { open } = await start(t);
  const host = await open({ type: 'queue', name: 'Ada' });
  await host.wait(m => m.type === 'queued');
  const guest = await open({ type: 'queue', name: 'Bea' });
  const joined = await host.wait(m => m.type === 'joined');
  await guest.wait(m => m.type === 'joined');
  const watch = await open({ type: 'join', role: 'spectate', name: 'Eye', code: joined.code });
  const seen = await watch.wait(m => m.type === 'joined');
  assert.equal(seen.role, 'spectate');
  const state = await watch.wait(m => m.type === 'state' && m.spectators === 1);
  assert.deepEqual(state.names, ['Ada', 'Bea']);
  assert.equal(state.game.state, 'ready');
});

test('a queued waiter is removed after QUEUE_IDLE_MS', async t => {
  const { open, app } = await start(t, { queueIdleMs: 80, heartbeatMs: 10_000 });
  const a = await open({ type: 'queue', name: 'Ada' });
  await a.wait(m => m.type === 'queued');
  assert.equal((await a.wait(m => m.type === 'error')).message, '等待逾時，請重新配對。');
  await sleep(40);
  assert.equal(app.queue.size(), 0);
});
