/* Flip Blocks AI: public game-core API only. */
(function (root) {
  'use strict';
  const core = (typeof module !== 'undefined' && module.exports)
    ? require('./game-core.js')
    : root.FlipBlocks;
  const { Game, COLS, ROWS, cells, inBounds } = core;

  const WEIGHTS = {
    flip: 12,
    paint: 1.1,
    win: 240,
    lose: -240,
    approach: 0.18,
    deny: 0.14,
    height: 0.06,
    holes: -0.32,
    bump: -0.1,
    lookahead: 0.55
  };

  const DIFFICULTIES = {
    novice: { id: 'novice', noise: 18, secondBest: 0.65, moveMs: 420, lookAhead: 1, dropScale: 0.7 },
    easy: { id: 'easy', noise: 7, secondBest: 0.3, moveMs: 260, lookAhead: 1, dropScale: 0.7 },
    normal: { id: 'normal', noise: 0, secondBest: 0, moveMs: 140, lookAhead: 1, dropScale: 1 },
    hard: { id: 'hard', noise: 0, secondBest: 0, moveMs: 85, lookAhead: 2, dropScale: 1 }
  };
  const DIFF_KEY = 'flip-blocks-ai-difficulty';

  function cloneGame(game) {
    const copy = new Game(() => 0);
    copy.sides = game.sides.map(s => ({ color: s.color, dir: s.dir }));
    copy.board = game.board.map(row => row.slice());
    copy.queues = game.queues.map(q => q.slice());
    copy.pieces = game.pieces.map(p => p && { owner: p.owner, shape: p.shape, rot: p.rot, x: p.x, y: p.y, color: p.color, dir: p.dir });
    copy.timers = game.timers.slice();
    copy.locked = game.locked.slice();
    copy.elapsed = game.elapsed;
    copy.winner = game.winner;
    copy.lastFlips = game.lastFlips;
    copy.state = game.state;
    return copy;
  }

  function listPlacements(game, owner) {
    const piece = game.pieces[owner];
    const found = [];
    if (!piece || game.state !== 'playing') return found;
    for (let rot = 0; rot < 4; rot++) {
      for (let x = -3; x < COLS; x++) {
        const copy = cloneGame(game);
        const p = copy.pieces[owner];
        p.rot = rot;
        p.x = x;
        p.y = piece.y;
        if (!copy.canStay(p)) continue;
        const ghost = copy.ghost(owner);
        const spots = cells(ghost);
        if (!spots.every(([cx, cy]) => inBounds(cx, cy))) continue;
        if (copy.canAdvance(ghost)) continue;
        found.push({ rot, x, y: ghost.y });
      }
    }
    return found;
  }

  function terrain(board, color, dir) {
    let height = 0, bump = 0, prev = null;
    for (let x = 0; x < COLS; x++) {
      let front = dir === -1 ? -1 : ROWS;
      if (dir === -1) {
        for (let y = ROWS - 1; y >= 0; y--) if (board[y][x] === color) { front = y; break; }
        height += front + 1;
      } else {
        for (let y = 0; y < ROWS; y++) if (board[y][x] === color) { front = y; break; }
        height += ROWS - front;
      }
      if (prev !== null) bump += Math.abs(front - prev);
      prev = front;
    }
    return { height, bump };
  }

  function fragile(game, owner) {
    const copy = cloneGame(game);
    return copy.capture(3 - copy.sides[owner].color);
  }

  function scoreState(game, owner, weights) {
    const w = weights || WEIGHTS;
    const side = game.sides[owner];
    const counts = game.counts();
    const mine = counts[side.color - 1];
    const theirs = counts[2 - side.color];
    const land = terrain(game.board, side.color, side.dir);
    let score = (game.lastFlips || 0) * w.flip;
    score += mine * w.approach;
    score += -theirs * w.deny;
    score += Math.max(0, mine - 110) * w.approach * 12;
    score += -Math.max(0, theirs - 110) * w.deny * 16;
    score += land.height * w.height;
    score += fragile(game, owner) * w.holes;
    score += land.bump * w.bump;
    if (game.winner === owner) score += w.win;
    else if (game.winner === 1 - owner) score += w.lose;
    return score;
  }

  function applyPlacement(game, owner, placement) {
    const p = game.pieces[owner];
    if (!p || !placement) return false;
    p.rot = placement.rot;
    p.x = placement.x;
    if (!game.canStay(p)) return false;
    const before = game.counts()[game.sides[owner].color - 1];
    game.step(owner, true);
    game._painted = game.counts()[game.sides[owner].color - 1] - before;
    return true;
  }

  function evaluatePlacement(game, owner, placement, options) {
    const opts = options || {};
    const weights = opts.weights || WEIGHTS;
    const copy = cloneGame(game);
    if (!applyPlacement(copy, owner, placement)) return { score: -Infinity, placement, flips: 0 };
    let score = scoreState(copy, owner, weights);
    score += (copy._painted || 0) * weights.paint;
    const lookAhead = opts.lookAhead == null ? 1 : opts.lookAhead;
    if (lookAhead > 1 && copy.state === 'playing') {
      const nexts = listPlacements(copy, owner);
      let best = -Infinity;
      for (const next of nexts) {
        const inner = evaluatePlacement(copy, owner, next, { weights, lookAhead: 1 });
        if (inner.score > best) best = inner.score;
      }
      if (best > -Infinity) score += weights.lookahead * best;
    }
    return { score, placement, flips: copy.lastFlips || 0, painted: copy._painted || 0 };
  }

  function specOf(difficulty, options) {
    const base = DIFFICULTIES[difficulty] || DIFFICULTIES.normal;
    return Object.assign({}, base, options || {});
  }

  function pickScored(scored, spec, random) {
    const usable = scored.filter(item => item.score > -Infinity);
    if (!usable.length) return null;
    usable.sort((a, b) => b.score - a.score || a.placement.rot - b.placement.rot || a.placement.x - b.placement.x);
    if (spec.noise) {
      for (const item of usable) item.score += (random() - 0.5) * spec.noise;
      usable.sort((a, b) => b.score - a.score || a.placement.rot - b.placement.rot || a.placement.x - b.placement.x);
    }
    if (spec.secondBest && usable.length > 1 && random() < spec.secondBest) return usable[1].placement;
    return usable[0].placement;
  }

  function chooseMove(game, owner, difficulty, options) {
    const opts = options || {};
    const spec = specOf(difficulty, opts);
    const random = opts.random || Math.random;
    const lookAhead = opts.lookAhead == null ? spec.lookAhead : opts.lookAhead;
    const weights = opts.weights || WEIGHTS;
    const scored = listPlacements(game, owner).map(placement =>
      evaluatePlacement(game, owner, placement, { weights, lookAhead }));
    return pickScored(scored, spec, random);
  }

  function scheduleWork(fn) {
    if (typeof requestIdleCallback === 'function') {
      return requestIdleCallback(() => fn(), { timeout: 32 });
    }
    return setTimeout(fn, 0);
  }

  function chooseMoveAsync(game, owner, difficulty, options, done) {
    const opts = options || {};
    const spec = specOf(difficulty, opts);
    const random = opts.random || Math.random;
    const lookAhead = opts.lookAhead == null ? spec.lookAhead : opts.lookAhead;
    const weights = opts.weights || WEIGHTS;
    const snapshot = cloneGame(game);
    const spots = listPlacements(snapshot, owner);
    const scored = [];
    let i = 0;
    const chunk = lookAhead > 1 ? 3 : 8;
    function slice() {
      const end = Math.min(i + chunk, spots.length);
      for (; i < end; i++) {
        scored.push(evaluatePlacement(snapshot, owner, spots[i], { weights, lookAhead }));
      }
      if (i < spots.length) scheduleWork(slice);
      else done(pickScored(scored, spec, random));
    }
    scheduleWork(slice);
  }

  function enact(game, owner, placement) {
    if (!placement || game.state !== 'playing') return;
    let guard = 0;
    while (game.state === 'playing' && game.pieces[owner].rot !== placement.rot && guard++ < 8) {
      game.rotate(owner);
    }
    guard = 0;
    while (game.state === 'playing' && game.pieces[owner].x !== placement.x && guard++ < 20) {
      game.move(owner, game.pieces[owner].x < placement.x ? 1 : -1);
    }
    if (game.state === 'playing') game.step(owner, true);
  }

  function pieceKey(game, owner) {
    const p = game.pieces[owner];
    return p ? `${game.locked[owner]}:${p.shape}:${p.rot}:${p.x}:${p.y}` : '';
  }

  class Controller {
    constructor(game, owner, difficulty, options) {
      this.game = game;
      this.owner = owner;
      this.difficulty = DIFFICULTIES[difficulty] ? difficulty : 'normal';
      this.options = options || {};
      this.plan = null;
      this.key = '';
      this.gen = 0;
      this.wait = 0;
      this.stopped = false;
    }
    spec() { return specOf(this.difficulty, this.options); }
    stop() {
      this.stopped = true;
      this.gen += 1;
      this.plan = null;
    }
    schedule() {
      const gen = this.gen += 1;
      const snap = cloneGame(this.game);
      chooseMoveAsync(snap, this.owner, this.difficulty, this.options, plan => {
        if (this.stopped || gen !== this.gen) return;
        this.plan = plan;
      });
    }
    tick(dt) {
      if (this.stopped || this.game.state !== 'playing') return;
      const key = pieceKey(this.game, this.owner);
      if (key.split(':').slice(0, 2).join(':') !== this.key.split(':').slice(0, 2).join(':')) {
        this.key = key;
        this.plan = null;
        this.wait = this.spec().moveMs / 2000;
        this.schedule();
      }
      this.wait -= dt;
      if (this.wait > 0 || !this.plan) return;
      this.act();
      this.wait = this.spec().moveMs / 1000;
    }
    act() {
      const p = this.game.pieces[this.owner];
      const target = this.plan;
      if (!p || !target || this.game.state !== 'playing') return;
      if (p.rot !== target.rot) { this.game.rotate(this.owner); return; }
      if (p.x < target.x) { this.game.move(this.owner, 1); return; }
      if (p.x > target.x) { this.game.move(this.owner, -1); return; }
      this.game.step(this.owner, true);
      this.plan = null;
      this.key = '';
    }
  }

  function loadDifficulty(store) {
    try {
      const value = (store || root.localStorage)?.getItem(DIFF_KEY);
      if (DIFFICULTIES[value]) return value;
    } catch {}
    return 'normal';
  }

  function saveDifficulty(value, store) {
    const id = DIFFICULTIES[value] ? value : 'normal';
    try { (store || root.localStorage)?.setItem(DIFF_KEY, id); } catch {}
    return id;
  }

  const api = {
    WEIGHTS, DIFFICULTIES, DIFF_KEY,
    cloneGame, listPlacements, scoreState, evaluatePlacement,
    chooseMove, chooseMoveAsync, enact, Controller,
    loadDifficulty, saveDifficulty
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlipAI = api;
})(globalThis);
