const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game, cells, inBounds, SHAPES } = require('../docs/game-core.js');
const { listPlacements, evaluatePlacement, chooseMove, enact, cloneGame } = require('../docs/ai.js');

const FLIP = {
  flip: 10, paint: 0, win: 1000, lose: -1000,
  approach: 0, deny: 0, height: 0, holes: 0, bump: 0, lookahead: 0.5
};

function fill(game, color) {
  game.board = Array.from({ length: 20 }, () => Array(10).fill(color));
}

function whitePiece(game, shape, queue) {
  Object.assign(game.pieces[1], { shape, rot: 0, x: 3, y: -4, color: 2, dir: 1 });
  game.queues[1] = queue.slice();
}

test('enumerator covers every rotation and column without illegal landings', () => {
  for (const shape of Object.keys(SHAPES)) {
    const game = new Game(() => 0);
    game.reset(1);
    Object.assign(game.pieces[0], { shape, rot: 0, x: 3 });
    const spots = listPlacements(game, 0);
    const rots = new Set(spots.map(s => s.rot));
    const xs = new Set(spots.map(s => s.x));
    assert.equal(rots.size, 4, shape + ' rotations');
    assert.ok(xs.size >= 6, shape + ' should try many columns');
    for (const spot of spots) {
      const copy = cloneGame(game);
      Object.assign(copy.pieces[0], { rot: spot.rot, x: spot.x, y: game.pieces[0].y });
      assert.equal(copy.canStay(copy.pieces[0]), true);
      const ghost = copy.ghost(0);
      assert.equal(ghost.y, spot.y);
      assert.ok(cells(ghost).every(([x, y]) => inBounds(x, y)));
      assert.equal(copy.canAdvance(ghost), false);
    }
  }
});

test('fixed weights pick the landing that flips the most cells', () => {
  const game = new Game(() => 0);
  game.reset(1);
  fill(game, 2);
  for (let y = 0; y <= 4; y++) game.board[y].fill(1);
  game.board[5].fill(2);
  game.board[5][4] = 1;
  for (const y of [6, 7, 8]) {
    game.board[y].fill(2);
    game.board[y][3] = 1;
    game.board[y][4] = 1;
    game.board[y][5] = 1;
  }
  whitePiece(game, 'I', ['T', 'L', 'J']);
  const spots = listPlacements(game, 1);
  assert.ok(spots.length > 0);
  let best = null;
  for (const spot of spots) {
    const ev = evaluatePlacement(game, 1, spot, { weights: FLIP, lookAhead: 1 });
    if (!best || ev.flips > best.flips) best = ev;
  }
  assert.ok(best.flips >= 6, 'constructed island should flip at least 6');
  const chosen = chooseMove(game, 1, 'normal', { weights: FLIP, lookAhead: 1, random: () => 0 });
  const picked = evaluatePlacement(game, 1, chosen, { weights: FLIP, lookAhead: 1 });
  assert.equal(picked.flips, best.flips);
});

test('hard two-step look-ahead beats greedy one-step on a setup board', () => {
  const game = new Game(() => 0);
  game.reset(1);
  for (let y = 10; y <= 12; y++) for (let x = 2; x <= 7; x++) game.board[y][x] = 1;
  game.board[9].fill(2);
  game.board[9][5] = 1;
  game.board[13][5] = 2;
  game.board[6][4] = 2;
  game.board[8][6] = 2;
  game.board[8][3] = 2;
  game.board[3][2] = 2;
  game.board[3][3] = 2;
  game.board[6][2] = 2;
  game.board[6][3] = 2;
  game.board[4][1] = 2;
  game.board[5][1] = 2;
  whitePiece(game, 'O', ['I', 'T', 'L']);

  const greedy = chooseMove(game, 1, 'normal', { weights: FLIP, lookAhead: 1, random: () => 0 });
  const planned = chooseMove(game, 1, 'hard', { weights: FLIP, lookAhead: 2, random: () => 0 });
  const greedyNow = evaluatePlacement(game, 1, greedy, { weights: FLIP, lookAhead: 1 });
  const planNow = evaluatePlacement(game, 1, planned, { weights: FLIP, lookAhead: 1 });
  assert.ok(greedyNow.flips > planNow.flips, `one-step ${greedyNow.flips} should beat immediate ${planNow.flips}`);
  assert.ok(greedy.x !== planned.x || greedy.rot !== planned.rot, 'look-ahead should pick a different landing');

  const afterGreedy = cloneGame(game);
  enact(afterGreedy, 1, greedy);
  const afterPlan = cloneGame(game);
  enact(afterPlan, 1, planned);
  const nextGreedy = chooseMove(afterGreedy, 1, 'normal', { weights: FLIP, lookAhead: 1, random: () => 0 });
  const nextPlan = chooseMove(afterPlan, 1, 'normal', { weights: FLIP, lookAhead: 1, random: () => 0 });
  const totalGreedy = greedyNow.flips + evaluatePlacement(afterGreedy, 1, nextGreedy, { weights: FLIP, lookAhead: 1 }).flips;
  const totalPlan = planNow.flips + evaluatePlacement(afterPlan, 1, nextPlan, { weights: FLIP, lookAhead: 1 }).flips;
  assert.ok(totalPlan > totalGreedy, `two-step ${totalPlan} should beat one-step ${totalGreedy}`);
});

test('an AI match can be fast-forwarded from kickoff to a winner', () => {
  let seed = 20260907;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const game = new Game(random);
  game.reset(1);
  for (let i = 0; i < 250 && game.state === 'playing'; i++) {
    const spots = listPlacements(game, 0);
    if (spots.length) enact(game, 0, spots[Math.floor(random() * spots.length)]);
    if (game.state !== 'playing') break;
    const move = chooseMove(game, 1, 'normal', { random: () => 0, lookAhead: 1 });
    if (move) enact(game, 1, move);
  }
  assert.equal(game.state, 'over');
  assert.ok(game.winner === 0 || game.winner === 1);
  assert.ok(game.locked[0] + game.locked[1] > 4);
});
