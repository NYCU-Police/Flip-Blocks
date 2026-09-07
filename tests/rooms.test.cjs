const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { createServer, RATE_LIMIT } = require('../server/index.cjs');
const { parseName, parseCode, escapeHtml, ROOM_ALPHABET } = require('../docs/network.js');
const { openLeaderboard } = require('../server/leaderboard.cjs');

async function start(t, options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'flip-lobby-'));
  const app = createServer({ ...options, dataDir });
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
  return { app, port, open, dataDir };
}

test('room codes skip confusing characters and parseName rejects junk', () => {
  assert.equal(parseName('  小明  '), '小明');
  assert.equal(parseName('x'), '');
  assert.equal(parseName('abcdefghijklm'), '');
  assert.equal(parseName('a\u0001'), '');
  assert.equal(parseCode('ab23cd'), 'AB23CD');
  assert.equal(parseCode('ROOM0O'), '');
  assert.equal(parseCode('ABC12'), '');
  assert.ok(!ROOM_ALPHABET.includes('0') && !ROOM_ALPHABET.includes('O'));
  assert.ok(!ROOM_ALPHABET.includes('1') && !ROOM_ALPHABET.includes('I'));
  assert.equal(escapeHtml('<x&y>'), '&lt;x&amp;y&gt;');
});

test('rooms isolate broadcasts and reject a bad room code', async t => {
  const { open } = await start(t);
  const a = await open({ type: 'join', role: 'host', name: 'Ada', color: 1 });
  const aJoin = await a.wait(m => m.type === 'joined');
  const b = await open({ type: 'join', role: 'host', name: 'Bea', color: 1 });
  const bJoin = await b.wait(m => m.type === 'joined');
  assert.notEqual(aJoin.code, bJoin.code);
  assert.match(aJoin.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  const aGuest = await open({ type: 'join', role: 'guest', name: 'Ace', code: aJoin.code });
  await aGuest.wait(m => m.connected?.every(Boolean));
  aGuest.send({ type: 'ready' }); a.send({ type: 'ready' });
  await a.wait(m => m.ready?.every(Boolean));
  a.send({ type: 'start' });
  await aGuest.wait(m => m.game?.state === 'playing');
  a.send({ type: 'input', action: 'drop' });
  await a.wait(m => m.game?.locked?.[0] === 1);
  const bState = b.messages.filter(m => m.type === 'state').at(-1);
  assert.equal(bState.game.locked[0], 0);
  const bad = await open({ type: 'join', role: 'guest', name: 'Zoe', code: 'ROOM0O' });
  assert.match((await bad.wait(m => m.type === 'error')).message, /代碼/);
});

test('empty rooms are recycled after the TTL and new rooms stop at the cap', async t => {
  const { open } = await start(t, { roomTtlMs: 120, maxRooms: 2 });
  const first = await open({ type: 'join', role: 'host', name: 'One' });
  const code = (await first.wait(m => m.type === 'joined')).code;
  first.send({ type: 'leave' });
  first.ws.close();
  await new Promise(resolve => setTimeout(resolve, 250));
  const stale = await open({ type: 'join', role: 'guest', name: 'Late', code });
  assert.match((await stale.wait(m => m.type === 'error')).message, /找不到房間/);
  const a = await open({ type: 'join', role: 'host', name: 'A1' });
  await a.wait(m => m.type === 'joined');
  const b = await open({ type: 'join', role: 'host', name: 'B1' });
  await b.wait(m => m.type === 'joined');
  const c = await open({ type: 'join', role: 'host', name: 'C1' });
  assert.match((await c.wait(m => m.type === 'error')).message, /已滿/);
});

test('spectators receive state but cannot move pieces', async t => {
  const { open } = await start(t);
  const host = await open({ type: 'join', role: 'host', name: 'Host' });
  const code = (await host.wait(m => m.type === 'joined')).code;
  const guest = await open({ type: 'join', role: 'guest', name: 'Guest', code });
  await guest.wait(m => m.connected?.every(Boolean));
  const watch = await open({ type: 'join', role: 'spectate', name: 'Eye', code });
  const joined = await watch.wait(m => m.type === 'joined');
  assert.equal(joined.role, 'spectate');
  const seen = await watch.wait(m => m.type === 'state' && m.spectators === 1);
  assert.deepEqual(seen.spectatorNames, ['Eye']);
  assert.deepEqual(seen.names, ['Host', 'Guest']);
  host.send({ type: 'ready' }); guest.send({ type: 'ready' });
  await host.wait(m => m.ready?.every(Boolean));
  host.send({ type: 'start' });
  await watch.wait(m => m.game?.state === 'playing');
  watch.send({ type: 'input', action: 'drop' });
  watch.send({ type: 'ready' });
  watch.send({ type: 'start' });
  await new Promise(resolve => setTimeout(resolve, 80));
  const later = watch.messages.filter(m => m.type === 'state').at(-1);
  assert.deepEqual(later.game.locked, [0, 0]);
  assert.equal(later.game.state, 'playing');
});

test('invalid nicknames are disconnected and the leaderboard records each match once', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-board-'));
  const { open, port } = await start(t, { dataDir, reconnectMs: 120 });
  const bad = await open({ type: 'join', role: 'host', name: 'x' });
  assert.match((await bad.wait(m => m.type === 'error')).message, /暱稱/);
  const host = await open({ type: 'join', role: 'host', name: 'Winner' });
  const code = (await host.wait(m => m.type === 'joined')).code;
  const guest = await open({ type: 'join', role: 'guest', name: 'Loser', code });
  await guest.wait(m => m.connected?.every(Boolean));
  host.send({ type: 'ready' }); guest.send({ type: 'ready' });
  await host.wait(m => m.ready?.every(Boolean));
  host.send({ type: 'start' });
  await host.wait(m => m.game?.state === 'playing');
  guest.ws.close();
  await host.wait(m => m.type === 'reconnect-timeout', 2000);
  const first = await (await fetch(`http://127.0.0.1:${port}/leaderboard`)).json();
  assert.deepEqual(first.rankings, [{ name: 'Winner', wins: 1 }]);
  const db = openLeaderboard(dataDir);
  assert.equal(db.record({
    room: code, matchKey: `${code}:1`, winnerName: 'Winner', loserName: 'Loser', winnerPct: 70, loserPct: 30
  }), false);
  db.close();
  const again = await (await fetch(`http://127.0.0.1:${port}/leaderboard`)).json();
  assert.equal(again.rankings[0].wins, 1);
});

test('rate-limited connections are closed', async t => {
  const { open } = await start(t, { rateLimit: 8 });
  const host = await open({ type: 'join', role: 'host', name: 'Fast' });
  await host.wait(m => m.type === 'joined');
  const closed = host.ws.readyState === WebSocket.CLOSED ? Promise.resolve() : once(host.ws, 'close');
  for (let i = 0; i < 20; i++) host.send({ type: 'ready' });
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('rate limit did not close')), 1000))]);
  assert.ok([WebSocket.CLOSING, WebSocket.CLOSED].includes(host.ws.readyState));
  assert.ok(RATE_LIMIT >= 8);
});
