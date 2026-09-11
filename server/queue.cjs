'use strict';
const { MAX_QUEUE_PER_IP, QUEUE_IDLE_MS } = require('./limits.cjs');

function createMatchQueue({ maxQueuePerIp = MAX_QUEUE_PER_IP, queueIdleMs = QUEUE_IDLE_MS } = {}) {
  const waiting = new Map();
  const byIp = new Map();

  function countIp(ip) {
    return byIp.get(ip) || 0;
  }

  function enqueue(ws, name, color) {
    if (waiting.has(ws)) return { ok: true, already: true };
    const ip = ws.clientIp;
    if (countIp(ip) >= maxQueuePerIp) return { ok: false, reason: 'limit' };
    waiting.set(ws, { name, color, enqueuedAt: Date.now() });
    byIp.set(ip, countIp(ip) + 1);
    ws.queued = true;
    return { ok: true, already: false };
  }

  function remove(ws) {
    if (!ws || !waiting.has(ws)) return false;
    waiting.delete(ws);
    ws.queued = false;
    const ip = ws.clientIp;
    const next = countIp(ip) - 1;
    if (next <= 0) byIp.delete(ip);
    else byIp.set(ip, next);
    return true;
  }

  function peek() {
    for (const [ws, entry] of waiting) return { ws, ...entry };
    return null;
  }

  function take() {
    const first = peek();
    if (!first) return null;
    remove(first.ws);
    return first;
  }

  function sweepIdle(now = Date.now()) {
    const expired = [];
    for (const [ws, entry] of waiting) {
      if (now - entry.enqueuedAt >= queueIdleMs) expired.push(ws);
    }
    for (const ws of expired) remove(ws);
    return expired;
  }

  function drainAll() {
    const list = [...waiting.keys()];
    for (const ws of list) remove(ws);
    return list;
  }

  return {
    waiting, enqueue, remove, peek, take, sweepIdle, drainAll,
    maxQueuePerIp, queueIdleMs,
    size() { return waiting.size; },
    has(ws) { return waiting.has(ws); },
    countIp
  };
}

module.exports = { createMatchQueue, MAX_QUEUE_PER_IP, QUEUE_IDLE_MS };
