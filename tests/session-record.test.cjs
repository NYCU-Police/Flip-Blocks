const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, recordOutcome, format } = require('../docs/session-record.js');

function memoryStore(seed = {}) {
  const data = { ...seed };
  return {
    getItem: key => Object.hasOwn(data, key) ? data[key] : null,
    setItem: (key, value) => { data[key] = String(value); }
  };
}

test('session records start empty and ignore corrupt storage', () => {
  assert.deepEqual(load(memoryStore()), { wins: 0, losses: 0, p1: 0, p2: 0 });
  assert.deepEqual(load(memoryStore({ 'flip-blocks-record': '{bad' })), { wins: 0, losses: 0, p1: 0, p2: 0 });
});

test('local outcomes tally seat wins; networked outcomes also tally self win/loss', () => {
  const store = memoryStore();
  recordOutcome(0, null, store);
  recordOutcome(1, null, store);
  recordOutcome(0, 0, store);
  const data = recordOutcome(1, 0, store);
  assert.deepEqual(data, { wins: 1, losses: 1, p1: 2, p2: 2 });
  assert.match(format(data, false, null), /玩家一 2 勝/);
  assert.equal(format(data, true, 0), '本場連線 1 勝 1 負');
});
