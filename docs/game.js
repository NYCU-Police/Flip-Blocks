'use strict';
(() => {
  const {Game,SHAPES,cells,inBounds}=FlipBlocks;
  const game=new Game(), $=id=>document.getElementById(id);
  const board=$('board'), tiles=[], held=new Set(), pointerHolds=new Map();
  let lastTime=0, previousState='', previousQueues='', previousLocks=0;
  for(let y=19;y>=0;y--) for(let x=0;x<10;x++) {
    const tile=document.createElement('div');tile.className='cell';tile.setAttribute('aria-hidden','true');
    board.append(tile);tiles.push({tile,x,y});
  }
  const pct=count=>Number((count/2).toFixed(1)).toString();
  const colorName=color=>color===1?'黑方 ↓':'白方 ↑';
  function clearInput() {held.clear();pointerHolds.clear();}
  function reset(ready=false) {
    clearInput();
    game.reset(Number(document.querySelector('input[name="color"]:checked').value));
    if(ready) game.state='ready';
    previousLocks=0;previousQueues='';render();
    if(!ready) board.focus({preventScroll:true});
  }
  function action(owner,type) {
    if(game.state!=='playing') return;
    if(type==='left') game.move(owner,-1);
    if(type==='right') game.move(owner,1);
    if(type==='rotate') game.rotate(owner);
    if(type==='drop') game.step(owner,true);
    render();
  }
  function togglePause() {
    clearInput();game.pause();render();
    if(game.state==='playing') board.focus({preventScroll:true});
  }
  function nextPreview(shape) {
    const points=SHAPES[shape][0], minX=Math.min(...points.map(p=>p[0])), maxX=Math.max(...points.map(p=>p[0]));
    const minY=Math.min(...points.map(p=>p[1])), maxY=Math.max(...points.map(p=>p[1]));
    const xOffset=(48-(maxX-minX+1)*10)/2, yOffset=(48-(maxY-minY+1)*10)/2;
    return `<div class="preview"><svg viewBox="0 0 48 48" role="img" aria-label="${shape} 型方塊">${points.map(([x,y])=>`<rect x="${xOffset+(x-minX)*10}" y="${yOffset+(maxY-y)*10}" width="8" height="8" rx="1" fill="currentColor"/>`).join('')}</svg></div>`;
  }
  function render() {
    const counts=game.counts(), classes=new Map();
    if(game.state==='playing'||game.state==='paused') {
      for(let owner=0;owner<2;owner++) {
        for(const [x,y] of cells(game.ghost(owner))) if(inBounds(x,y)) classes.set(y*10+x,`ghost${owner+1}`);
      }
      for(let owner=0;owner<2;owner++) {
        for(const [x,y] of cells(game.pieces[owner])) if(inBounds(x,y)) classes.set(y*10+x,`active${owner+1}`);
      }
    }
    for(const {tile,x,y} of tiles) {
      const name=`cell${game.board[y][x]===1?' black':''} ${classes.get(y*10+x)||''}`;
      if(tile.className!==name) tile.className=name;
    }
    for(let owner=0;owner<2;owner++) {
      const p=`p${owner+1}`,side=game.sides[owner],score=pct(counts[side.color-1]);
      $(p+'-score').textContent=score;$(p+'-meter').style.width=score+'%';
      $(p+'-color').textContent=colorName(side.color);$(p+'-locked').textContent=game.locked[owner];
      document.querySelector(`[data-owner="${owner}"][data-action="drop"]`).textContent=`落定 ${side.dir===-1?'↓':'↑'}`;
    }
    const queueKey=JSON.stringify(game.queues);
    if(queueKey!==previousQueues) {
      for(let owner=0;owner<2;owner++) $(`p${owner+1}-next`).innerHTML=game.queues[owner].map(nextPreview).join('');
      previousQueues=queueKey;
    }
    $('territory-black').style.width=pct(counts[0])+'%';$('territory-white').style.width=pct(counts[1])+'%';
    board.setAttribute('aria-label',`10 欄 20 列棋盤。黑方 ${pct(counts[0])}%，白方 ${pct(counts[1])}%。`);
    const seconds=Math.floor(game.elapsed);
    $('clock').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
    const locked=game.locked[0]+game.locked[1];
    if(locked!==previousLocks && game.state==='playing') {
      $('match-status').textContent=game.lastFlips?`包圍翻轉 ${game.lastFlips} 格！`:'對戰進行中';previousLocks=locked;
    }
    if(game.state===previousState) return;
    previousState=game.state;
    const ready=game.state==='ready', paused=game.state==='paused', over=game.state==='over';
    $('overlay').hidden=game.state==='playing';$('color-picker').hidden=!ready;
    $('pause').disabled=ready||over;$('restart').disabled=ready;
    $('pause').innerHTML=paused?'繼續 <kbd>Esc</kbd>':'暫停 <kbd>Esc</kbd>';
    document.querySelectorAll('.touch-controls button').forEach(button=>button.disabled=game.state!=='playing');
    if(ready) {
      $('overlay-kicker').textContent='READY TO FLIP?';$('overlay-title').textContent='準備好翻轉戰局？';
      $('overlay-description').innerHTML='兩位玩家，共用一個棋盤。<br>用方塊搶下你的領地。';
      $('start').innerHTML='開始對戰 <span>↗</span>';$('overlay-note').textContent='請兩位玩家就位';
      $('match-status').textContent='等待開始';
    } else if(paused) {
      $('overlay-kicker').textContent='TAKE A BREATHER';$('overlay-title').textContent='對戰已暫停';
      $('overlay-description').textContent='準備好了，就回到棋盤繼續爭奪。';
      $('start').innerHTML='繼續對戰 <span>→</span>';$('overlay-note').textContent='也可以按 Esc 繼續';
      $('match-status').textContent='已暫停';clearInput();$('start').focus({preventScroll:true});
    } else if(over) {
      const winner=game.winner,score=pct(counts[game.sides[winner].color-1]);
      $('overlay-kicker').textContent='TERRITORY CLAIMED';$('overlay-title').textContent=`玩家${winner===0?'一':'二'}獲勝！`;
      $('overlay-description').textContent=`${colorName(game.sides[winner].color).slice(0,2)}佔領 ${score}% 領地・用時 ${$('clock').textContent}`;
      $('start').innerHTML='再戰一局 <span>↗</span>';$('overlay-note').textContent='或按「新對局」重新選色';
      $('match-status').textContent=`玩家${winner===0?'一':'二'}獲勝！`;clearInput();$('start').focus({preventScroll:true});
    } else $('match-status').textContent='對戰進行中';
  }
  $('start').addEventListener('click',()=>game.state==='paused'?togglePause():reset());
  $('pause').addEventListener('click',togglePause);
  $('restart').addEventListener('click',()=>{reset(true);$('start').focus({preventScroll:true});});
  document.querySelectorAll('input[name="color"]').forEach(input=>input.addEventListener('change',()=>reset(true)));
  const keys={ArrowLeft:[0,'left'],ArrowRight:[0,'right'],ArrowUp:[0,'rotate'],ArrowDown:[0,'soft'],Enter:[0,'drop'],KeyA:[1,'left'],KeyD:[1,'right'],KeyW:[1,'rotate'],KeyS:[1,'soft'],Space:[1,'drop']};
  document.addEventListener('keydown',event=>{
    if(event.code==='Escape') {if(!event.repeat) togglePause();return;}
    const binding=keys[event.code];
    if(!binding||game.state!=='playing'||event.ctrlKey||event.metaKey||event.altKey) return;
    // Keep ordinary keyboard activation for focused UI buttons.
    if(event.target.closest('button,input,a')) return;
    event.preventDefault();
    if(event.repeat) return;
    held.add(event.code);
    action(...binding);
  });
  document.addEventListener('keyup',event=>held.delete(event.code));
  document.querySelectorAll('.touch-controls button').forEach(button=>{
    button.addEventListener('pointerdown',event=>{
      if(game.state!=='playing') return;
      event.preventDefault();button.setPointerCapture(event.pointerId);
      const owner=Number(button.dataset.owner),type=button.dataset.action;
      pointerHolds.set(event.pointerId,{owner,type,age:0,repeat:0});action(owner,type);
    });
    const release=event=>pointerHolds.delete(event.pointerId);
    button.addEventListener('pointerup',release);button.addEventListener('pointercancel',release);button.addEventListener('lostpointercapture',release);
    button.addEventListener('click',event=>{if(event.detail===0) {const owner=Number(button.dataset.owner);if(button.dataset.action==='soft') game.step(owner);else action(owner,button.dataset.action);render();}});
  });
  function autoPause() {clearInput();if(game.state==='playing') {game.pause();render();}}
  window.addEventListener('blur',autoPause);
  document.addEventListener('visibilitychange',()=>{if(document.hidden) autoPause();});
  const repeats=new Map();
  function frame(time) {
    const dt=lastTime?Math.min((time-lastTime)/1000,.1):0;lastTime=time;
    const fast=[held.has('ArrowDown'),held.has('KeyS')];
    for(const [code,binding] of Object.entries(keys)) {
      if(!held.has(code)) {repeats.delete(code);continue;}
      if(!['left','right'].includes(binding[1])) continue;
      const age=(repeats.get(code)||0)+dt, before=repeats.get(code)||0;
      if(age>.22 && Math.floor((age-.22)/.09)>Math.floor((before-.22)/.09)) action(...binding);
      repeats.set(code,age);
    }
    for(const hold of pointerHolds.values()) {
      hold.age+=dt;hold.repeat+=dt;
      if(hold.type==='soft') fast[hold.owner]=true;
      if(['left','right'].includes(hold.type)&&hold.age>.22&&hold.repeat>=.09) {hold.repeat=0;action(hold.owner,hold.type);}
    }
    if(game.state==='playing') {game.tick(dt,fast);render();}
    requestAnimationFrame(frame);
  }
  // Optional agent controls use the same actions as the visible game.
  const context=document.modelContext;
  if(context?.registerTool) {
    const lifecycle=new AbortController();
    window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
    const register=tool=>{try {Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}};
    register({name:'read_flip_blocks_match',description:'Read the current Flip Blocks match, players and territory.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:()=>({state:game.state,colors:game.sides.map(s=>s.color),counts:game.counts(),winner:game.winner})});
    register({name:'play_flip_blocks_move',description:'Move, rotate or drop one player’s active piece in the running match.',inputSchema:{type:'object',properties:{player:{type:'integer',enum:[1,2]},action:{type:'string',enum:['left','right','rotate','drop']}},required:['player','action'],additionalProperties:false},annotations:{readOnlyHint:false},execute:input=>{
      if(!input||![1,2].includes(input.player)||!['left','right','rotate','drop'].includes(input.action)) throw new Error('Invalid player or action');
      if(game.state!=='playing') throw new Error('Start or resume the match first');
      action(input.player-1,input.action);return {state:game.state,counts:game.counts(),winner:game.winner};
    }});
  }
  render();requestAnimationFrame(frame);
})();
