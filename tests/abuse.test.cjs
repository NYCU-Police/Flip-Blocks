const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const {
  createServer, resolveClientIp,
  MAX_ROOMS_PER_IP, MAX_SOCKETS_PER_IP, CREATE_PER_MIN, HTTP_PER_MIN, MAX_PAYLOAD
} = require('../server/index.cjs');

function req(headers, remote = '10.0.0.8') {
  return { headers, socket: { remoteAddress: remote } };
}

async function start(t, options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'flip-abuse-'));
  const app = createServer({ statsMs: 0, ...options, dataDir });
  t.after(() => app.close());
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = app.server.address().port;
  async function open(payload, headers = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/match`, { headers });
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
  function denied(headers = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/match`, { headers });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('upgrade was not rejected')), 2000);
      ws.on('open', () => { clearTimeout(timer); reject(new Error('upgrade should fail')); });
      ws.on('error', error => { clearTimeout(timer); resolve(error); });
    });
  }
  return { app, port, open, denied };
}

test('TRUST_PROXY uses CF-Connecting-IP then X-Forwarded-For, otherwise the socket', () => {
  const headers = { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.2, 10.1.1.1' };
  assert.equal(resolveClientIp(req(headers, '::ffff:127.0.0.1'), false), '127.0.0.1');
  assert.equal(resolveClientIp(req(headers, '10.0.0.8'), false), '10.0.0.8');
  assert.equal(resolveClientIp(req(headers), true), '203.0.113.9');
  assert.equal(resolveClientIp(req({ 'x-forwarded-for': '198.51.100.2, 10.1.1.1' }), true), '198.51.100.2');
  assert.equal(resolveClientIp(req({ 'cf-connecting-ip': 'not-an-ip' }, '::ffff:192.168.1.4'), true), '192.168.1.4');
  assert.equal(resolveClientIp(req({ 'x-forwarded-for': '2001:db8::1' }), true), '2001:db8::1');
  assert.equal(MAX_ROOMS_PER_IP, 3);
  assert.equal(MAX_SOCKETS_PER_IP, 10);
  assert.equal(CREATE_PER_MIN, 5);
  assert.equal(HTTP_PER_MIN, 60);
  assert.equal(MAX_PAYLOAD, 4096);
});

test('TRUST_PROXY isolates room quotas by header IP; direct mode uses the socket', async t => {
  const proxied = await start(t, { trustProxy: true, maxRoomsPerIp: 1 });
  const first = await proxied.open({ type: 'join', role: 'host', name: 'Ada' }, { 'CF-Connecting-IP': '203.0.113.10' });
  assert.equal((await first.wait(m => m.type === 'joined')).type, 'joined');
  const same = await proxied.open({ type: 'join', role: 'host', name: 'Ada2' }, { 'CF-Connecting-IP': '203.0.113.10' });
  assert.equal((await same.wait(m => m.type === 'error')).message, '無法建立房間，請稍後再試。');
  const other = await proxied.open({ type: 'join', role: 'host', name: 'Bea' }, { 'X-Forwarded-For': '198.51.100.8, 10.0.0.1' });
  assert.ok((await other.wait(m => m.type === 'joined')).code);

  const direct = await start(t, { trustProxy: false, maxRoomsPerIp: 1 });
  const local = await direct.open({ type: 'join', role: 'host', name: 'Cara' }, { 'CF-Connecting-IP': '203.0.113.20' });
  await local.wait(m => m.type === 'joined');
  const spoof = await direct.open({ type: 'join', role: 'host', name: 'Dana' }, { 'CF-Connecting-IP': '198.51.100.20' });
  assert.equal((await spoof.wait(m => m.type === 'error')).message, '無法建立房間，請稍後再試。');
});

test('per-IP room and socket caps release after close or recycle', async t => {
  const rooms = await start(t, { maxRoomsPerIp: 1, roomTtlMs: 80 });
  const host = await rooms.open({ type: 'join', role: 'host', name: 'One' });
  await host.wait(m => m.type === 'joined');
  const blocked = await rooms.open({ type: 'join', role: 'host', name: 'Two' });
  assert.equal((await blocked.wait(m => m.type === 'error')).message, '無法建立房間，請稍後再試。');
  host.send({ type: 'leave' });
  host.ws.close();
  await once(host.ws, 'close');
  const stillHeld = await rooms.open({ type: 'join', role: 'host', name: 'Two' });
  assert.equal((await stillHeld.wait(m => m.type === 'error')).message, '無法建立房間，請稍後再試。');
  await new Promise(resolve => setTimeout(resolve, 200));
  const again = await rooms.open({ type: 'join', role: 'host', name: 'Two' });
  assert.equal((await again.wait(m => m.type === 'joined' || m.type === 'error')).type, 'joined');

  const sockets = await start(t, { maxSocketsPerIp: 2 });
  const a = await sockets.open();
  const b = await sockets.open();
  const denied = await sockets.denied();
  assert.match(denied.message, /403/);
  a.ws.close();
  await once(a.ws, 'close');
  const freed = await sockets.open({ type: 'join', role: 'host', name: 'Free' });
  assert.equal((await freed.wait(m => m.type === 'joined')).type, 'joined');
  b.ws.close();
});

test('create-room rate is a soft reject and HTTP APIs return 429', async t => {
  const { open, port } = await start(t, {
    trustProxy: true, createPerMin: 1, httpPerMin: 2, maxRoomsPerIp: 5
  });
  const host = await open({ type: 'join', role: 'host', name: 'Rate' }, { 'CF-Connecting-IP': '203.0.113.30' });
  await host.wait(m => m.type === 'joined');
  const retry = await open({ type: 'join', role: 'host', name: 'Rate2' }, { 'CF-Connecting-IP': '203.0.113.30' });
  assert.equal((await retry.wait(m => m.type === 'error')).message, '無法建立房間，請稍後再試。');

  const headers = { 'CF-Connecting-IP': '203.0.113.40' };
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`, { headers })).status, 200);
  const board = await fetch(`http://127.0.0.1:${port}/leaderboard`, { headers });
  assert.equal(board.status, 200);
  assert.equal(board.headers.get('cache-control'), 'public, max-age=30');
  const limited = await fetch(`http://127.0.0.1:${port}/healthz`, { headers });
  assert.equal(limited.status, 429);
  assert.equal(await limited.text(), '請稍後再試');
  const other = await fetch(`http://127.0.0.1:${port}/leaderboard`, { headers: { 'CF-Connecting-IP': '198.51.100.40' } });
  assert.equal(other.status, 200);
  assert.deepEqual(await other.json(), { rankings: [] });
});

test('oversized and idle connections are closed without echoing input', async t => {
  const { open } = await start(t, { joinIdleMs: 80, maxPayload: 4096 });
  const idle = await open();
  await once(idle.ws, 'close');
  assert.ok([WebSocket.CLOSING, WebSocket.CLOSED].includes(idle.ws.readyState));

  const huge = await open({ type: 'join', role: 'host', name: 'Keep' });
  await huge.wait(m => m.type === 'joined');
  const closed = huge.ws.readyState === WebSocket.CLOSED ? Promise.resolve() : once(huge.ws, 'close');
  huge.ws.send(Buffer.alloc(5000, 97));
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('oversize did not close')), 1000))
  ]);
  assert.ok(!huge.messages.some(message => JSON.stringify(message).includes('a'.repeat(20))));
});

test('environment variables override limit constants', async t => {
  const key = 'MAX_ROOMS_PER_IP';
  const previous = process.env[key];
  process.env[key] = '7';
  t.after(() => {
    if (previous == null) delete process.env[key];
    else process.env[key] = previous;
  });
  const { app } = await start(t);
  assert.equal(app.limits.maxRoomsPerIp, 7);
  assert.equal(MAX_ROOMS_PER_IP, 3);
});
