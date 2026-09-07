'use strict';
(() => {
  const {Game,SHAPES,cells,inBounds}=FlipBlocks;
  const game=new Game(), $=id=>document.getElementById(id);
  const board=$('board'), tiles=[], held=new Set(), pointerHolds=new Map();
  let lastTime=0, previousState='', previousQueues='', previousLocks=0;
  let previousBoardKey='', previousClock='', previousHud='';
  let softSent=false, softAt=0, wasNetwork=false, heardOver=false;
  let playMode='local', ai=null;
  const network=new FlipNetwork.Connection(networkChanged, snapshot=>{
    FlipNetwork.applyGame(game,snapshot);
    previousBoardKey=''; previousState='';
    previousLocks=game.locked[0]+game.locked[1];
    heardOver=game.state==='over';
    render();
  });
  function remainSecs() {
    return network.reconnect?Math.max(0,Math.ceil((network.reconnect.deadline-Date.now())/1000)):-1;
  }
  function networkChanged() {
    if(wasNetwork&&!network.active) {stopAI();playMode=selectedMode();clearInput();game.state='ready';}
    wasNetwork=network.active;
    const joined=network.owner!==null, both=network.connected.every(Boolean);
    $('mode-label').textContent=network.active?'區域網路對戰':(playMode==='ai'?'單人對戰 AI':'同機雙人對戰');
    $('host').disabled=network.active;$('join').disabled=network.active;
    $('join-ip').disabled=network.active;$('server-address').disabled=network.active;
    $('leave').hidden=!network.active;$('ready').hidden=!joined||game.state!=='ready'||network.reconnect||network.pendingReconnect;
    $('ready').textContent=network.ready[network.owner]?'取消準備':'我準備好了';
    const secs=remainSecs();
    $('network-status').textContent=network.message||(joined?
      (network.reconnect?`對方斷線，等待重連中（剩餘 ${secs} 秒）`:
      `你是玩家${network.owner+1} · ${both?'雙方已連線':'等待玩家二加入'} · P1 ${network.ready[0]?'已準備':'未準備'} / P2 ${network.ready[1]?'已準備':'未準備'}`):
      '尚未連線。每個主機提供一間雙人房。');
    for(let owner=0;owner<2;owner++) {
      const panel=document.querySelector(owner===0?'.player-one':'.player-two');
      panel.classList.toggle('remote',joined&&owner!==network.owner);
      panel.classList.toggle('self',joined&&owner===network.owner);
    }
    syncModeUi();
    refreshRecord();
    render();
  }
  function connect(role) {
    stopAI();playMode='local';
    clearInput();game.state='ready';
    $('network-panel').open=true;
    if(!['http:','https:'].includes(location.protocol)) {
      network.message='請先執行 npm start，開啟 http://localhost:8787 建立房間；朋友可在上方輸入主機 IP。';networkChanged();return;
    }
    network.connect(role,Number(document.querySelector('input[name="color"]:checked').value));
  }
  $('host').addEventListener('click',()=>connect('host'));
  $('join').addEventListener('click',()=>connect('guest'));
  $('ready').addEventListener('click',()=>network.send({type:'ready'}));
  $('leave').addEventListener('click',()=>{network.leave();network.message='已離開連線，可開始同機對戰。';networkChanged();reset(true);});
  $('join-form').addEventListener('submit',event=>{
    event.preventDefault();
    try {
      const url=FlipNetwork.serverAddress($('server-address').value);
      if(url.origin===location.origin) connect('guest');
      else {url.searchParams.set('join','1');location.assign(url.href);}
    } catch(error) {network.message=error.message;networkChanged();}
  });
  if(['http:','https:'].includes(location.protocol)) $('server-address').value=location.origin;
  function sendSoft(down) {
    if(!network.active) return;
    const now=performance.now();
    if(down===softSent&&(!down||now-softAt<500)) return;
    softSent=down;softAt=now;network.send({type:'input',action:'soft',down});
  }
  for(let y=19;y>=0;y--) for(let x=0;x<10;x++) {
    const tile=document.createElement('div');tile.className='cell';tile.setAttribute('aria-hidden','true');
    board.append(tile);tiles.push({tile,x,y});
  }
  const pct=count=>Number((count/2).toFixed(1)).toString();
  const colorName=color=>color===1?'黑方 ↓':'白方 ↑';
  function refreshRecord() {
    if(!globalThis.FlipRecord) return;
    $('session-record').textContent=FlipRecord.format(FlipRecord.load(),network.active,network.owner,playMode==='ai'&&!network.active);
  }
  function syncMute() {
    if(!globalThis.FlipAudio) return;
    const muted=FlipAudio.isMuted();
    $('mute').textContent=muted?'音效關':'音效開';
    $('mute').setAttribute('aria-pressed',muted?'true':'false');
  }
  function cueMatch(counts) {
    const locked=game.locked[0]+game.locked[1];
    if(game.state==='playing'&&locked>previousLocks) {
      FlipAudio?.play('lock');
      if(game.lastFlips) FlipAudio?.play(game.lastFlips>=4?'capture':'flip');
    }
    if(game.state==='over'&&!heardOver&&game.winner!==null) {
      heardOver=true;
      const mine=network.active?network.owner:(playMode==='ai'?0:null);
      FlipAudio?.play(mine===null||mine===game.winner?'win':'lose');
      FlipRecord?.recordOutcome(game.winner,mine,undefined,playMode==='ai'&&!network.active);
      refreshRecord();
    }
    if(game.state!=='over') heardOver=false;
    void counts;
  }
  function clearInput() {held.clear();pointerHolds.clear();sendSoft(false);}
  function selectedMode() {return document.querySelector('input[name="mode"]:checked')?.value||'local';}
  function selectedDifficulty() {return document.querySelector('input[name="difficulty"]:checked')?.value||'normal';}
  function stopAI() {if(ai){ai.stop();ai=null;}}
  function syncModeUi() {
    const aiOn=(playMode==='ai'||selectedMode()==='ai')&&!network.active;
    $('difficulty-picker').hidden=!aiOn||game.state!=='ready';
    document.querySelector('.player-two .player-tag').textContent=aiOn?'CPU AI':'PLAYER 02';
    document.querySelector('.player-two').classList.toggle('remote',aiOn||(network.active&&network.owner!==1));
    const heading=$('p2-heading');
    if(heading) heading.childNodes[0].textContent=aiOn?'電腦 AI ':'玩家二 ';
    const guide=document.querySelector('.player-two .control-guide');
    if(guide) guide.querySelector('h3').textContent=aiOn?'電腦對手':'操作方式';
    if(!network.active) $('mode-label').textContent=aiOn?'單人對戰 AI':'同機雙人對戰';
  }
  function reset(ready=false) {
    if(network.active) {network.send({type:ready?'restart':'start'});return;}
    playMode=selectedMode();
    stopAI();
    clearInput();
    game.reset(Number(document.querySelector('input[name="color"]:checked').value));
    if(ready) game.state='ready';
    else if(playMode==='ai'&&globalThis.FlipAI) ai=new FlipAI.Controller(game,1,selectedDifficulty());
    previousLocks=0;previousQueues='';syncModeUi();render();
    if(!ready) board.focus({preventScroll:true});
  }
  function owns(owner) {
    if(network.active) return network.owner===owner;
    if(playMode==='ai') return owner===0;
    return true;
  }
  function action(owner,type) {
    if(game.state!=='playing'||!owns(owner)) return;
    if(network.active) {if(type!=='soft') network.send({type:'input',action:type});return;}
    if(type==='step') game.step(owner);
    if(type==='left') game.move(owner,-1);
    if(type==='right') game.move(owner,1);
    if(type==='rotate') game.rotate(owner);
    if(type==='drop') game.step(owner,true);
    render();
  }
  function togglePause() {
    clearInput();
    if(network.active) {network.send({type:game.state==='paused'?'resume':'pause'});return;}
    game.pause();render();
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
    const boardKey=(Array.isArray(game.board[0])?game.board.flat().join(''):String(game.board))+JSON.stringify(game.pieces)+game.state;
    if(boardKey!==previousBoardKey) {
      previousBoardKey=boardKey;
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
    }
    const hud=JSON.stringify([counts,game.locked,game.sides[0].color]);
    if(hud!==previousHud) {
      previousHud=hud;
      for(let owner=0;owner<2;owner++) {
        const p=`p${owner+1}`,side=game.sides[owner],score=pct(counts[side.color-1]);
        $(p+'-score').textContent=score;$(p+'-meter').style.width=score+'%';
        $(p+'-color').textContent=colorName(side.color);$(p+'-locked').textContent=game.locked[owner];
        document.querySelector(`[data-owner="${owner}"][data-action="drop"]`).textContent=`落定 ${side.dir===-1?'↓':'↑'}`;
      }
      $('territory-black').style.width=pct(counts[0])+'%';$('territory-white').style.width=pct(counts[1])+'%';
      board.setAttribute('aria-label',`10 欄 20 列棋盤。黑方 ${pct(counts[0])}%，白方 ${pct(counts[1])}%。`);
    }
    const queueKey=JSON.stringify(game.queues);
    if(queueKey!==previousQueues) {
      for(let owner=0;owner<2;owner++) $(`p${owner+1}-next`).innerHTML=game.queues[owner].map(nextPreview).join('');
      previousQueues=queueKey;
    }
    const seconds=Math.floor(game.elapsed);
    const clock=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
    if(clock!==previousClock) {previousClock=clock;$('clock').textContent=clock;}
    const locked=game.locked[0]+game.locked[1];
    if(locked!==previousLocks) {
      if(game.state==='playing') $('match-status').textContent=game.lastFlips?`包圍翻轉 ${game.lastFlips} 格！`:'對戰進行中';
      cueMatch(counts);previousLocks=locked;
    }
    if(game.state==='over') cueMatch(counts);
    const stateKey=JSON.stringify([game.state,network.active,network.owner,network.connected,network.ready,game.sides[0].color,remainSecs(),network.pendingReconnect,network.message,playMode,selectedDifficulty()]);
    if(stateKey===previousState) return;
    previousState=stateKey;
    const ready=game.state==='ready', paused=game.state==='paused', over=game.state==='over';
    const waiting=Boolean(network.reconnect), restoring=Boolean(network.pendingReconnect);
    $('overlay').hidden=game.state==='playing'&&!waiting&&!restoring;
    $('color-picker').hidden=!ready||waiting||restoring;
    $('mode-picker').hidden=!ready||waiting||restoring||network.active;
    $('difficulty-picker').hidden=!ready||waiting||restoring||network.active||selectedMode()!=='ai';
    $('pause').disabled=ready||over||waiting||restoring;$('restart').disabled=ready||waiting||restoring||(network.active&&network.owner!==0);
    $('start').disabled=false;
    document.querySelectorAll('input[name="color"]').forEach(input=>{
      input.disabled=network.active&&network.owner!==0;
      if(network.active) input.checked=Number(input.value)===game.sides[0].color;
    });
    $('pause').innerHTML=paused?'繼續 <kbd>Esc</kbd>':'暫停 <kbd>Esc</kbd>';
    document.querySelectorAll('.touch-controls button').forEach(button=>button.disabled=game.state!=='playing'||!owns(Number(button.dataset.owner)));
    if(waiting||restoring) {
      const secs=remainSecs();
      $('overlay-kicker').textContent='CONNECTION LOST';
      $('overlay-title').textContent=restoring?'連線已中斷，正在重新連線…':'對方斷線，等待重連中';
      $('overlay-description').textContent=restoring?'正在以工作階段憑證認領原座位，恢復後會從快照繼續。':
        `對局已暫停並保留棋盤與方塊。剩餘 ${secs} 秒。`;
      $('start').textContent=restoring?'正在重新連線':'等待對手重連';
      $('start').disabled=true;
      $('overlay-note').textContent='逾時未歸則判留下的玩家獲勝';
      $('match-status').textContent=restoring?'正在重新連線':`等待重連 ${secs}s`;
      clearInput();
    } else if(ready) {
      $('overlay-kicker').textContent='READY TO FLIP?';$('overlay-title').textContent=playMode==='ai'?'單人對戰 AI':'準備好翻轉戰局？';
      $('overlay-description').innerHTML=playMode==='ai'?'你操作玩家一（方向鍵 + Enter）。<br>AI 操作玩家二。':'兩位玩家，共用一個棋盤。<br>用方塊搶下你的領地。';
      $('start').innerHTML=playMode==='ai'?'開始對戰 AI <span>↗</span>':'開始對戰 <span>↗</span>';
      $('overlay-note').textContent=($('session-record')?.textContent)||(playMode==='ai'?'選好難度與顏色後開始':'請兩位玩家就位');
      $('match-status').textContent='等待開始';refreshRecord();
    } else if(paused) {
      $('overlay-kicker').textContent='TAKE A BREATHER';$('overlay-title').textContent='對戰已暫停';
      $('overlay-description').textContent='準備好了，就回到棋盤繼續爭奪。';
      $('start').innerHTML='繼續對戰 <span>→</span>';$('overlay-note').textContent='也可以按 Esc 繼續';
      $('match-status').textContent='已暫停';clearInput();$('start').focus({preventScroll:true});
    } else if(over) {
      const winner=game.winner,score=pct(counts[game.sides[winner].color-1]);
      $('overlay-kicker').textContent='TERRITORY CLAIMED';
      $('overlay-title').textContent=playMode==='ai'?(winner===0?'你獲勝！':'AI 獲勝！'):`玩家${winner===0?'一':'二'}獲勝！`;
      $('overlay-description').textContent=`${colorName(game.sides[winner].color).slice(0,2)}佔領 ${score}% 領地・用時 ${$('clock').textContent}`;
      $('start').innerHTML='再戰一局 <span>↗</span>';$('overlay-note').textContent='或按「新對局」重新選色';
      $('match-status').textContent=playMode==='ai'?(winner===0?'你獲勝！':'AI 獲勝！'):`玩家${winner===0?'一':'二'}獲勝！`;
      clearInput();$('start').focus({preventScroll:true});
    } else {clearInput();$('match-status').textContent='對戰進行中';if(!document.hidden) board.focus({preventScroll:true});}
    if(network.active&&!waiting&&!restoring) {
      $('ready').hidden=network.owner===null||!ready;
      if(ready) {
        clearInput();
        $('overlay-title').textContent=network.owner===null?'正在連線…':'連線房間';
        $('overlay-description').textContent=network.connected.every(Boolean)?'雙方按「我準備好了」，再由房主開始。':'等待對手加入。將主機 IP 告訴朋友。';
        $('start').textContent='房主開始對戰';
        $('start').disabled=network.owner!==0||!network.connected.every(Boolean)||!network.ready.every(Boolean);
        $('overlay-note').textContent='準備按鈕位於上方「區域網路 / IP 連線對戰」';
        $('match-status').textContent='等待雙方準備';
      } else if(over) {
        $('start').textContent=network.owner===0?'再戰 / 重新準備':'等待房主開啟新對局';
        $('start').disabled=network.owner!==0;
        $('overlay-note').textContent='再戰需雙方重新準備';
      }
    }
  }
  $('start').addEventListener('click',()=>game.state==='paused'?togglePause():reset(network.active&&game.state==='over'));
  $('pause').addEventListener('click',togglePause);
  $('restart').addEventListener('click',()=>{reset(true);$('start').focus({preventScroll:true});});
  document.querySelectorAll('input[name="color"]').forEach(input=>input.addEventListener('change',()=>network.active?network.send({type:'color',color:Number(input.value)}):reset(true)));
  document.querySelectorAll('input[name="mode"]').forEach(input=>input.addEventListener('change',()=>{
    if(game.state!=='ready'||network.active) {syncModeUi();return;}
    playMode=selectedMode();stopAI();syncModeUi();refreshRecord();previousState='';render();
  }));
  document.querySelectorAll('input[name="difficulty"]').forEach(input=>input.addEventListener('change',()=>{
    FlipAI?.saveDifficulty(selectedDifficulty());previousState='';render();
  }));
  const keys={ArrowLeft:[0,'left'],ArrowRight:[0,'right'],ArrowUp:[0,'rotate'],ArrowDown:[0,'soft'],Enter:[0,'drop'],KeyA:[1,'left'],KeyD:[1,'right'],KeyW:[1,'rotate'],KeyS:[1,'soft'],Space:[1,'drop']};
  document.addEventListener('keydown',event=>{
    if(event.code==='Escape') {if(!event.repeat) togglePause();return;}
    const binding=keys[event.code];
    if(!binding||game.state!=='playing'||event.ctrlKey||event.metaKey||event.altKey) return;
    if(playMode==='ai'&&!network.active&&binding[0]===1) return;
    // Keep ordinary keyboard activation for focused UI buttons.
    if(event.target.closest('button,input,a')) return;
    event.preventDefault();
    if(event.repeat) return;
    held.add(event.code);
    action(network.active?network.owner:binding[0],binding[1]);
  });
  document.addEventListener('keyup',event=>{held.delete(event.code);if(['ArrowDown','KeyS'].includes(event.code)) sendSoft(false);});
  document.querySelectorAll('.touch-controls button').forEach(button=>{
    button.addEventListener('pointerdown',event=>{
      if(game.state!=='playing'||!owns(Number(button.dataset.owner))) return;
      event.preventDefault();button.setPointerCapture(event.pointerId);
      const owner=Number(button.dataset.owner),type=button.dataset.action;
      pointerHolds.set(event.pointerId,{owner,type,age:0,repeat:0});action(owner,type);
    });
    const release=event=>{pointerHolds.delete(event.pointerId);sendSoft(false);};
    button.addEventListener('pointerup',release);button.addEventListener('pointercancel',release);button.addEventListener('lostpointercapture',release);
    button.addEventListener('click',event=>{if(event.detail===0) {const owner=Number(button.dataset.owner);action(owner,button.dataset.action==='soft'?'step':button.dataset.action);render();}});
  });
  function autoPause() {clearInput();if(game.state==='playing') {if(network.active) network.send({type:'pause'});else game.pause();render();}}
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
      if(age>.22 && Math.floor((age-.22)/.09)>Math.floor((before-.22)/.09)) action(network.active?network.owner:binding[0],binding[1]);
      repeats.set(code,age);
    }
    for(const hold of pointerHolds.values()) {
      hold.age+=dt;hold.repeat+=dt;
      if(hold.type==='soft') fast[hold.owner]=true;
      if(['left','right'].includes(hold.type)&&hold.age>.22&&hold.repeat>=.09) {hold.repeat=0;action(hold.owner,hold.type);}
    }
    if(game.state==='playing') {
      if(network.active) sendSoft(fast.some(Boolean));
      else {
        if(ai) ai.tick(dt);
        if(game.state==='playing') game.tick(dt,playMode==='ai'?[fast[0],false]:fast);
        render();
      }
    }
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
      if(!owns(input.player-1)) throw new Error('You can only control your own player');
      action(input.player-1,input.action);return {state:game.state,counts:game.counts(),winner:game.winner};
    }});
  }
  window.addEventListener('pagehide',()=>network.disconnect());
  $('mute').addEventListener('click',()=>{FlipAudio?.setMuted(!FlipAudio.isMuted());syncMute();});
  document.addEventListener('pointerdown',()=>FlipAudio?.unlock(),{once:true});
  const savedDiff=FlipAI?.loadDifficulty();
  if(savedDiff) {
    const radio=document.querySelector(`input[name="difficulty"][value="${savedDiff}"]`);
    if(radio) radio.checked=true;
  }
  syncMute();syncModeUi();refreshRecord();
  render();requestAnimationFrame(frame);
  const joining=new URLSearchParams(location.search).get('join')==='1';
  if(!(['http:','https:'].includes(location.protocol)&&network.resumeSession())&&joining) connect('guest');
})();
