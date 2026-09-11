/* Flip Blocks rules. Coordinates start at the bottom-left of the board. */
(function (root) {
  'use strict';
  const COLS = 10, ROWS = 20;
  // 佔領勝門檻。靜態文案（index.html、README）須與此 WIN_PCT 一致。
  const WIN_PCT = 75;
  const WIN_CELLS = Math.round(COLS * ROWS * WIN_PCT / 100);
  const SHAPES = {
    I: [[[0,1],[1,1],[2,1],[3,1]],[[2,0],[2,1],[2,2],[2,3]],[[0,2],[1,2],[2,2],[3,2]],[[1,0],[1,1],[1,2],[1,3]]],
    O: Array.from({length:4}, () => [[1,0],[2,0],[1,1],[2,1]]),
    T: [[[1,0],[0,1],[1,1],[2,1]],[[1,0],[1,1],[2,1],[1,2]],[[0,1],[1,1],[2,1],[1,2]],[[1,0],[0,1],[1,1],[1,2]]],
    S: [[[1,0],[2,0],[0,1],[1,1]],[[1,0],[1,1],[2,1],[2,2]],[[1,1],[2,1],[0,2],[1,2]],[[0,0],[0,1],[1,1],[1,2]]],
    Z: [[[0,0],[1,0],[1,1],[2,1]],[[2,0],[1,1],[2,1],[1,2]],[[0,1],[1,1],[1,2],[2,2]],[[1,0],[0,1],[1,1],[0,2]]],
    J: [[[0,0],[0,1],[1,1],[2,1]],[[1,0],[2,0],[1,1],[1,2]],[[0,1],[1,1],[2,1],[2,2]],[[1,0],[1,1],[0,2],[1,2]]],
    L: [[[2,0],[0,1],[1,1],[2,1]],[[1,0],[1,1],[1,2],[2,2]],[[0,1],[1,1],[2,1],[0,2]],[[0,0],[1,0],[1,1],[1,2]]]
  };
  const inBounds = (x,y) => x >= 0 && x < COLS && y >= 0 && y < ROWS;
  const cells = (p, x=p.x, y=p.y, rot=p.rot) => SHAPES[p.shape][rot].map(([dx,dy]) => [x+dx,y+dy]);
  class Game {
    constructor(random=Math.random) { this.random=random; this.reset(1); this.state='ready'; }
    reset(p1Color=1) {
      if (![1,2].includes(p1Color)) throw new Error('Invalid color');
      this.sides=[p1Color,3-p1Color].map(color => ({color, dir:color===1?-1:1}));
      // Black always owns the bottom home row; white always owns the top.
      this.board=Array.from({length:ROWS}, (_,y) => Array(COLS).fill(y<ROWS/2?1:2));
      this.queues=[[],[]]; this.pieces=[null,null]; this.timers=[0,0];
      this.locked=[0,0]; this.elapsed=0; this.winner=null; this.lastFlips=0;
      this.state='playing'; this.spawn(0); this.spawn(1);
    }
    spawn(owner) {
      const q=this.queues[owner], keys=Object.keys(SHAPES), side=this.sides[owner];
      while(q.length<4) q.push(keys[Math.floor(this.random()*keys.length)]);
      this.pieces[owner]={owner,shape:q.shift(),rot:0,x:3,y:side.dir===-1?20:-4,...side};
      this.timers[owner]=0;
    }
    canStay(p,x=p.x,y=p.y,rot=p.rot) {
      return cells(p,x,y,rot).every(([cx,cy]) => cx>=0 && cx<COLS &&
        (p.dir===-1 ? cy>=0 : cy<ROWS));
    }
    canAdvance(p) {
      const y=p.y+p.dir;
      return this.canStay(p,p.x,y) && !cells(p,p.x,y).some(([x,cy])=>inBounds(x,cy)&&this.board[cy][x]===p.color);
    }
    move(owner,dx) {
      if(this.state!=='playing') return;
      const p=this.pieces[owner];
      if(this.canStay(p,p.x+dx)) p.x+=dx;
    }
    rotate(owner) {
      if(this.state!=='playing') return;
      const p=this.pieces[owner], rot=(p.rot+1)%4;
      for(const dx of [0,-1,1,-2,2]) if(this.canStay(p,p.x+dx,p.y,rot)) {p.x+=dx;p.rot=rot;break;}
    }
    ghost(owner) {
      const p={...this.pieces[owner]};
      for(let i=0;i<ROWS+8 && this.canAdvance(p);i++) p.y+=p.dir;
      return p;
    }
    step(owner,hard=false) {
      if(this.state!=='playing') return;
      const p=this.pieces[owner];
      if(hard) p.y=this.ghost(owner).y;
      else if(this.canAdvance(p)) {p.y+=p.dir;return;}
      let painted=0;
      for(const [x,y] of cells(p)) if(inBounds(x,y)) {this.board[y][x]=p.color;painted++;}
      if(painted) {
        this.locked[owner]++;
        this.lastFlips=this.capture(p.color);
        this.checkWinner();
      }
      if(this.state==='playing') this.spawn(owner);
    }
    capture(attacker) {
      const defender=3-attacker, home=defender===1?0:ROWS-1;
      const connected=new Set(), queue=[];
      for(let x=0;x<COLS;x++) if(this.board[home][x]===defender) {queue.push([x,home]);connected.add(home*COLS+x);}
      for(let i=0;i<queue.length;i++) {
        const [x,y]=queue[i];
        for(const [nx,ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]) {
          const id=ny*COLS+nx;
          if(inBounds(nx,ny)&&this.board[ny][nx]===defender&&!connected.has(id)) {connected.add(id);queue.push([nx,ny]);}
        }
      }
      let count=0;
      for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++)
        if(this.board[y][x]===defender&&!connected.has(y*COLS+x)) {this.board[y][x]=attacker;count++;}
      return count;
    }
    counts() { const black=this.board.flat().filter(c=>c===1).length;return [black,COLS*ROWS-black]; }
    checkWinner() {
      const counts=this.counts();
      for(const color of [1,2]) {
        if(counts[color-1]>=WIN_CELLS || this.board.every(row=>row.includes(color))) {
          this.winner=this.sides.findIndex(s=>s.color===color);this.state='over';return;
        }
      }
    }
    pause() { if(this.state==='playing') this.state='paused'; else if(this.state==='paused') this.state='playing'; }
    tick(dt,fast=[false,false]) {
      if(this.state!=='playing') return;
      dt=Math.min(Math.max(dt,0),0.1); this.elapsed+=dt;
      for(let owner=0;owner<2 && this.state==='playing';owner++) {
        this.timers[owner]+=dt;
        const interval=fast[owner]?0.08:0.45;
        if(this.timers[owner]>=interval) {this.timers[owner]=0;this.step(owner);}
      }
    }
  }
  function acceptBoardPointer(gesture, pointerId, starting) {
    if (starting) return !gesture;
    return Boolean(gesture && gesture.id === pointerId);
  }
  const api={Game,SHAPES,COLS,ROWS,WIN_PCT,WIN_CELLS,cells,inBounds,acceptBoardPointer};
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
  else root.FlipBlocks=api;
})(globalThis);
