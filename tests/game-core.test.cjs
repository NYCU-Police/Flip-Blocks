const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Game,SHAPES,cells,inBounds,acceptBoardPointer}=require('../docs/game-core.js');

test('both color choices start 50/50, with each color connected to its own home',()=>{
  for(const color of [1,2]) {
    const game=new Game(()=>0);game.reset(color);
    assert.deepEqual(game.counts(),[100,100]);
    assert.equal(game.sides[0].color,color);
    assert.equal(game.board[0][0],1);assert.equal(game.board[19][0],2);
    assert.equal(game.capture(1),0);assert.equal(game.capture(2),0);
    assert.equal(game.queues[0].length,3);assert.equal(game.queues[1].length,3);
    for(const owner of [0,1]) {
      const fresh=new Game(()=>0);fresh.reset(color);fresh.step(owner,true);
      assert.equal(fresh.counts()[fresh.sides[owner].color-1],104);
      assert.equal(fresh.locked[owner],1);
    }
  }
});
test('every tetromino and rotation has four unique cells and lands inside the board',()=>{
  for(const shape of Object.keys(SHAPES)) for(let rot=0;rot<4;rot++) for(const owner of [0,1]) {
    const game=new Game();game.reset();
    Object.assign(game.pieces[owner],{shape,rot});
    const ghost=game.ghost(owner);
    assert.equal(new Set(cells(ghost).map(String)).size,4);
    assert.ok(cells(ghost).every(([x,y])=>inBounds(x,y)));
    assert.ok(!game.canAdvance(ghost));
    assert.ok(cells(ghost).every(([x,y])=>game.board[y][x]!==ghost.color));
    game.step(owner,true);assert.equal(game.counts()[owner],104);
  }
});
test('movement and rotation stay between walls, including a wall kick',()=>{
  const game=new Game(()=>0);game.reset();
  for(let i=0;i<30;i++) game.move(0,-1);
  assert.equal(Math.min(...cells(game.pieces[0]).map(([x])=>x)),0);
  Object.assign(game.pieces[0],{shape:'I',rot:1,x:7});
  game.rotate(0);
  assert.equal(game.pieces[0].rot,2);assert.equal(game.pieces[0].x,6);
  for(let i=0;i<30;i++) game.move(0,1);
  assert.equal(Math.max(...cells(game.pieces[0]).map(([x])=>x)),9);
});
test('only defenders disconnected from their home row flip; diagonal contact does not connect',()=>{
  const game=new Game();game.reset();
  game.board[8][1]=2;game.board[8][2]=2;game.board[7][1]=2;
  game.board[9][3]=2; // Connected upward to the white home.
  assert.equal(game.capture(1),3);
  assert.equal(game.board[8][2],1);assert.equal(game.board[9][3],2);
  assert.equal(game.capture(1),0);
});
test('capture works symmetrically for white attacking black',()=>{
  const game=new Game();game.reset(2);
  game.board[13][4]=1;game.board[14][4]=1;
  assert.equal(game.capture(2),2);
  assert.equal(game.board[13][4],2);assert.equal(game.board[0][4],1);
});
test('69.5% does not end the game; 70% selects the right player with either color',()=>{
  for(const p1Color of [1,2]) for(const winnerColor of [1,2]) {
    const game=new Game();game.reset(p1Color);
    game.board=Array.from({length:20},(_,y)=>Array.from({length:10},(_,x)=>y*10+x<139?winnerColor:3-winnerColor));
    game.checkWinner();assert.equal(game.state,'playing');
    game.board[13][9]=winnerColor;game.checkWinner();
    assert.equal(game.state,'over');assert.equal(game.winner,game.sides.findIndex(s=>s.color===winnerColor));
    const before=JSON.stringify(game.board);game.step(1,true);game.tick(.1);
    assert.equal(JSON.stringify(game.board),before);
  }
});
test('original all-20-rows victory is preserved',()=>{
  const game=new Game();game.reset();
  for(let y=10;y<20;y++) game.board[y][0]=1;
  game.checkWinner();assert.equal(game.state,'over');assert.equal(game.winner,0);
});
test('pause freezes board, pieces, and clock; restart clears a completed match',()=>{
  const game=new Game();game.reset();game.pause();
  const before=JSON.stringify(game);game.tick(.1,[true,true]);game.move(0,1);game.rotate(1);game.step(0,true);
  assert.equal(JSON.stringify(game),before);
  game.pause();game.tick(.1);assert.equal(game.elapsed,.1);
  game.state='over';game.winner=0;game.reset(2);
  assert.equal(game.winner,null);assert.deepEqual(game.counts(),[100,100]);
  assert.deepEqual(game.locked,[0,0]);assert.equal(game.elapsed,0);
});
test('hard drops terminate even when a column has no friendly cells',()=>{
  for(const owner of [0,1]) {
    const game=new Game(()=>.2);game.reset();
    const p=game.pieces[owner];game.board.forEach(row=>row.fill(3-p.color));
    const ghost=game.ghost(owner);
    assert.ok(cells(ghost).some(([x,y])=>inBounds(x,y)));
    assert.ok(!game.canAdvance(ghost));game.step(owner,true);
    assert.equal(game.locked[owner],1);
  }
});
test('soft drop is faster and tab suspension cannot fast-forward a match',()=>{
  const normal=new Game(()=>0),fast=new Game(()=>0);normal.reset();fast.reset();
  for(let i=0;i<5;i++) {normal.tick(.08);fast.tick(.08,[true,false]);}
  assert.ok(fast.pieces[0].y<normal.pieces[0].y);
  const before=normal.elapsed;normal.tick(60);assert.ok(normal.elapsed-before<=.10001);
});
test('seeded random matches preserve territory and always terminate each move',()=>{
  let seed=123456;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let match=0;match<100;match++) {
    const game=new Game(random);game.reset(match%2+1);
    for(let turn=0;turn<200&&game.state==='playing';turn++) {
      const owner=turn%2;
      for(let i=0,n=Math.floor(random()*4);i<n;i++) game.rotate(owner);
      for(let i=0,n=Math.floor(random()*9)-4;i<Math.abs(n);i++) game.move(owner,Math.sign(n));
      game.step(owner,true);
      assert.equal(game.counts().reduce((a,b)=>a+b),200);
      assert.ok(game.board.flat().every(c=>c===1||c===2));
      assert.ok(game.pieces.every(p=>cells(p).every(([x])=>x>=0&&x<10)));
    }
    assert.equal(game.state,'over');
  }
});
test('second finger cannot steal or finish a board gesture',()=>{
  let gesture=null;
  function down(id) {
    if(!acceptBoardPointer(gesture,id,true)) return 'ignored';
    gesture={id};
    return 'started';
  }
  function up(id) {
    if(!acceptBoardPointer(gesture,id,false)) return 'ignored';
    const ended=gesture;
    gesture=null;
    return ended.id;
  }
  assert.equal(down(1),'started');
  assert.equal(down(2),'ignored');
  assert.equal(up(2),'ignored');
  assert.equal(gesture.id,1);
  assert.equal(up(1),1);
  assert.equal(gesture,null);
  assert.equal(acceptBoardPointer(null,2,false),false);
});
