'use strict';
(function (root) {
  const KEY = 'flip-blocks-record';
  function empty() { return { wins: 0, losses: 0, p1: 0, p2: 0 }; }
  function load(store) {
    try {
      const raw = (store || root.sessionStorage)?.getItem(KEY);
      if (!raw) return empty();
      const data = JSON.parse(raw);
      if (![data.wins, data.losses, data.p1, data.p2].every(n => Number.isInteger(n) && n >= 0)) return empty();
      return data;
    } catch { return empty(); }
  }
  function save(data, store) {
    try { (store || root.sessionStorage)?.setItem(KEY, JSON.stringify(data)); } catch {}
    return data;
  }
  function recordOutcome(winner, myOwner, store) {
    const data = load(store);
    if (winner === 0 || winner === 1) data[winner === 0 ? 'p1' : 'p2'] += 1;
    if (myOwner === 0 || myOwner === 1) {
      if (winner === myOwner) data.wins += 1;
      else if (winner === 0 || winner === 1) data.losses += 1;
    }
    return save(data, store);
  }
  function format(data, networked, owner) {
    const rec = data || empty();
    if (networked && owner !== null && owner !== undefined) return `本場連線 ${rec.wins} 勝 ${rec.losses} 負`;
    return `本機戰績 玩家一 ${rec.p1} 勝 · 玩家二 ${rec.p2} 勝`;
  }
  const api = { KEY, load, save, recordOutcome, format };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlipRecord = api;
})(globalThis);
