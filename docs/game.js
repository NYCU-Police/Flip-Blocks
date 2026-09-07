'use strict';
(() => {
  const {Game,SHAPES,cells,inBounds}=FlipBlocks;
  const game=new Game(), $=id=>document.getElementById(id);
  const board=$('board'), tiles=[], held=new Set(), pointerHolds=new Map();
  let lastTime=0, previousState='', previousQueues='', previousLocks=0;
  let previousBoardKey='', previousClock='', previousHud='';
  let softSent=false, softAt=0, wasNetwork=false, heardOver=false;
  let playMode='local', onlineMode=false, ai=null;
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
  function lobbyStatus() {
    if(network.message) return network.message;
    if(!onlineMode) return '';
    if(!network.active) return '輸入暱稱後，建立房間或加入朋友的房間。';
    const code=network.code||'';
    const names=network.names||['',''];
    const secs=remainSecs();
    if(network.pendingReconnect) return '正在重新連線…';
    if(network.reconnect) return `對手斷線，${secs} 秒內可重連…`;
    if(network.spectating) return `觀戰中 · ${names[0]||'玩家一'} vs ${names[1]||'玩家二'}`;
    if(!network.connected.every(Boolean)) return `等待對手加入…（代碼 ${code}）`;
    if(game.state==='ready') {
      if(network.ready.every(Boolean)) return '雙方已準備，房主可以開始';
      return '對手已加入，雙方按準備開始';
    }
    if(game.state==='playing') return '對戰進行中';
    if(game.state==='paused') return '對戰已暫停';
    if(game.state==='over') return names[game.winner]?`${names[game.winner]} 獲勝`:'對局結束';
    return '';
  }
  function setStage(play) {
    document.body.classList.toggle('stage-pick',!play);
    document.body.classList.toggle('stage-play',play);
    $('mode-home').hidden=play;
    $('play-stage').hidden=!play;
    $('back-modes').hidden=!play;
  }
  function enterMode(mode) {
    onlineMode=mode==='online';
    playMode=mode==='ai'?'ai':'local';
    const radio=document.querySelector(`input[name="mode"][value="${playMode}"]`);
    if(radio) radio.checked=true;
    $('online-panel').hidden=!onlineMode;
    setStage(true);
    if(game.state==='ready'&&!network.active) {
      clearInput();
      game.reset(Number(document.querySelector('input[name="color"]:checked').value));
      game.state='ready';
    }
    previousState='';
    syncModeUi();
    refreshRecord();
    render();
    if(onlineMode&&!network.active) $('nickname').focus();
  }
  function exitMode() {
    if(network.active) network.leave();
    network.message='';
    stopAI();
    clearInput();
    playMode='local';
    onlineMode=false;
    game.reset(1);
    game.state='ready';
    previousLocks=0;previousQueues='';previousState='';
    $('online-panel').hidden=true;
    setStage(false);
    $('mode-label').textContent='選擇模式';
    syncModeUi();
    refreshRecord();
    render();
  }
  function networkChanged() {
    if(wasNetwork&&!network.active) {stopAI();playMode=onlineMode?'local':selectedMode();clearInput();game.state='ready';}
    wasNetwork=network.active;
    if(network.active) {
      onlineMode=true;
      $('online-panel').hidden=false;
      setStage(true);
    }
    const joined=network.owner!==null, both=network.connected.every(Boolean);
    $('mode-label').textContent=network.active?(network.spectating?'觀戰中':`線上房間 ${network.code||''}`):
      (onlineMode?'線上對戰':(playMode==='ai'?'單人對戰 AI':'同機雙人對戰'));
    $('host').disabled=network.active;$('join').disabled=network.active;$('spectate').disabled=network.active;
    $('join-ip').disabled=network.active;$('server-address').disabled=network.active;
    $('nickname').disabled=network.active;$('room-code-input').disabled=network.active;
    $('leave').hidden=!network.active;$('ready').hidden=!joined||network.spectating||game.state!=='ready'||network.reconnect||network.pendingReconnect;
    $('ready').textContent=network.ready[network.owner]?'取消準備':'我準備好了';
    $('network-status').textContent=lobbyStatus();
    $('room-share').hidden=!network.active||!network.code;
    $('room-code-display').textContent=network.code||'';
    const watchers=$('watchers');
    watchers.hidden=!network.active;
    const extra=network.spectatorNames?.length?`：${network.spectatorNames.join('、')}`:'';
    watchers.textContent=`觀戰 ${network.spectators||0} 人${extra}`;
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
    stopAI();playMode='local';onlineMode=true;
    clearInput();game.state='ready';
    enterMode('online');
    if(!['http:','https:'].includes(location.protocol)) {
      network.message='請用網站開啟此頁再進行線上對戰。';networkChanged();return;
    }
    const name=FlipNetwork.parseName($('nickname').value);
    if(!name) {network.message='請輸入 2–12 字暱稱。';networkChanged();return;}
    FlipNetwork.saveName(name);
    const code=FlipNetwork.parseCode($('room-code-input').value);
    if(role!=='host'&&!code) {network.message='請輸入 6 位房間代碼。';networkChanged();return;}
    network.connect(role,{color:Number(document.querySelector('input[name="color"]:checked').value),name,code});
  }
  function shareUrl(code) {
    const url=new URL(location.href);
    url.search='';url.hash='';
    url.searchParams.set('room',code);
    return url.href;
  }
  function flashCopied(button,label) {
    const original=button.textContent;
    button.textContent=label;
    setTimeout(()=>{button.textContent=original;},1600);
  }
  async function copyText(text,button,done) {
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(button,done);
    } catch {
      network.message='無法自動複製，請手動選取。';
      networkChanged();
    }
  }
  $('pick-ai').addEventListener('click',()=>enterMode('ai'));
  $('pick-local').addEventListener('click',()=>enterMode('local'));
  $('pick-online').addEventListener('click',()=>enterMode('online'));
  $('back-modes').addEventListener('click',exitMode);
  $('host').addEventListener('click',()=>connect('host'));
  $('join').addEventListener('click',()=>connect('guest'));
  $('spectate').addEventListener('click',()=>connect('spectate'));
  $('ready').addEventListener('click',()=>network.send({type:'ready'}));
  $('leave').addEventListener('click',()=>{network.leave();network.message='';networkChanged();reset(true);});
  $('copy-code').addEventListener('click',()=>{if(network.code) copyText(network.code,$('copy-code'),'已複製');});
  $('copy-link').addEventListener('click',()=>{if(network.code) copyText(shareUrl(network.code),$('copy-link'),'連結已複製');});
  $('room-code-input').addEventListener('input',event=>{
    const next=[...event.target.value.toUpperCase()].filter(ch=>FlipNetwork.ROOM_ALPHABET.includes(ch)).join('').slice(0,6);
    if(event.target.value!==next) event.target.value=next;
  });
  $('join-form').addEventListener('submit',event=>{
    event.preventDefault();
    try {
      const url=FlipNetwork.serverAddress($('server-address').value);
      const code=FlipNetwork.parseCode($('room-code-input').value);
      if(code) url.searchParams.set('room',code);
      if(url.origin===location.origin) connect(code?'guest':'host');
      else location.assign(url.href);
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
  function selectedMode() {return playMode==='ai'?'ai':'local';}
  function selectedDifficulty() {return document.querySelector('input[name="difficulty"]:checked')?.value||'normal';}
  function stopAI() {if(ai){ai.stop();ai=null;}}
  function syncModeUi() {
    const aiOn=playMode==='ai'&&!network.active;
    $('difficulty-picker').hidden=!aiOn||game.state!=='ready';
    document.querySelector('.player-two .player-tag').textContent=aiOn?'CPU AI':'PLAYER 02';
    document.querySelector('.player-two').classList.toggle('remote',aiOn||(network.active&&network.owner!==1)||network.spectating);
    const p1=network.active&&network.names?.[0]?network.names[0]:'玩家一';
    const p2=aiOn?'電腦 AI':(network.active&&network.names?.[1]?network.names[1]:'玩家二');
    $('p1-name').textContent=p1;
    $('p2-name').textContent=p2;
    const guide=document.querySelector('.player-two .control-guide');
    if(guide) guide.querySelector('h3').textContent=aiOn?'電腦對手':'操作方式';
    if(!network.active) $('mode-label').textContent=onlineMode?'線上對戰':(aiOn?'單人對戰 AI':'同機雙人對戰');
    if($('play-stage').hidden) $('mode-label').textContent='選擇模式';
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
    if(network.spectating) return false;
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
    if(network.spectating) return;
    if($('play-stage').hidden) return;
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
    const stateKey=JSON.stringify([game.state,network.active,network.owner,network.connected,network.ready,game.sides[0].color,remainSecs(),network.pendingReconnect,network.message,playMode,selectedDifficulty(),network.code,network.names,network.spectating,network.spectators,onlineMode,$('play-stage').hidden]);
    if(stateKey===previousState) return;
    previousState=stateKey;
    const ready=game.state==='ready', paused=game.state==='paused', over=game.state==='over';
    const waiting=Boolean(network.reconnect), restoring=Boolean(network.pendingReconnect);
    $('overlay').hidden=game.state==='playing'&&!waiting&&!restoring;
    $('color-picker').hidden=!ready||waiting||restoring;
    $('mode-picker').hidden=true;
    $('difficulty-picker').hidden=!ready||waiting||restoring||network.active||playMode!=='ai';
    $('pause').disabled=ready||over||waiting||restoring||network.spectating||$('play-stage').hidden;$('restart').disabled=ready||waiting||restoring||network.spectating||$('play-stage').hidden||(network.active&&network.owner!==0);
    $('start').disabled=false;
    document.querySelectorAll('input[name="color"]').forEach(input=>{
      input.disabled=network.active&&network.owner!==0;
      if(network.active) input.checked=Number(input.value)===game.sides[0].color;
    });
    $('pause').innerHTML=paused?'繼續 <kbd>Esc</kbd>':'暫停 <kbd>Esc</kbd>';
    document.querySelectorAll('.touch-controls button').forEach(button=>button.disabled=game.state!=='playing'||!owns(Number(button.dataset.owner)));
    if(onlineMode) $('network-status').textContent=lobbyStatus();
    if(waiting||restoring) {
      const secs=remainSecs();
      $('overlay-kicker').textContent='CONNECTION LOST';
      $('overlay-title').textContent=restoring?'正在重新連線…':'對手斷線，等待重連';
      $('overlay-description').textContent=restoring?'正在回到原本的座位，恢復後會從剛才的棋盤繼續。':
        `對局已暫停。對手還有 ${secs} 秒可以回來。`;
      $('start').textContent=restoring?'正在重新連線':'等待對手重連';
      $('start').disabled=true;
      $('overlay-note').textContent='逾時未歸則判留下的玩家獲勝';
      $('match-status').textContent=restoring?'正在重新連線':`對手斷線，${secs} 秒內可重連…`;
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
        $('overlay-title').textContent=network.spectating?`觀戰 ${network.code}`:(network.owner===null?'正在連線…':`房間 ${network.code}`);
        $('overlay-description').textContent=network.spectating?`${network.names[0]||'玩家一'} vs ${network.names[1]||'玩家二'}`:
          (network.connected.every(Boolean)?'對手已加入，雙方按準備開始':`等待對手加入…（代碼 ${network.code}）`);
        $('start').textContent=network.spectating?'觀戰中':'房主開始對戰';
        $('start').disabled=network.spectating||network.owner!==0||!network.connected.every(Boolean)||!network.ready.every(Boolean);
        $('overlay-note').textContent=network.spectating?'觀戰無法操作':'準備好後按「我準備好了」';
        $('match-status').textContent=network.spectating?'觀戰中':lobbyStatus();
      } else if(over) {
        const names=network.names||[];
        if(names[game.winner]) $('overlay-title').textContent=`${names[game.winner]} 獲勝！`;
        $('start').textContent=network.spectating?'觀戰中':(network.owner===0?'再戰 / 重新準備':'等待房主開啟新對局');
        $('start').disabled=network.spectating||network.owner!==0;
        $('overlay-note').textContent=network.spectating?'觀戰無法操作':'再戰需雙方重新準備';
      } else if(network.spectating) {
        $('start').textContent='觀戰中';$('start').disabled=true;
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
  function autoPause() {if(network.spectating) return;clearInput();if(game.state==='playing') {if(network.active) network.send({type:'pause'});else game.pause();render();}}
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
  const savedName=FlipNetwork.loadName();
  if(savedName) $('nickname').value=savedName;
  async function refreshLeaderboard() {
    if(!['http:','https:'].includes(location.protocol)) return;
    try {
      const data=await (await fetch('/leaderboard')).json();
      const list=$('leaderboard-list');
      list.textContent='';
      if(!data.rankings?.length) {const empty=document.createElement('li');empty.className='muted';empty.textContent='尚無連線對局紀錄';list.append(empty);return;}
      for(const row of data.rankings) {
        const item=document.createElement('li');
        item.textContent=`${row.name} · ${row.wins} 勝`;
        list.append(item);
      }
    } catch {}
  }
  $('leaderboard-panel').addEventListener('toggle',()=>{if($('leaderboard-panel').open) refreshLeaderboard();});
  syncMute();syncModeUi();refreshRecord();
  render();requestAnimationFrame(frame);
  const params=new URLSearchParams(location.search);
  const roomParam=FlipNetwork.parseCode(params.get('room')||'');
  const watchParam=FlipNetwork.parseCode(params.get('watch')||'');
  if(roomParam) $('room-code-input').value=roomParam;
  else if(watchParam) $('room-code-input').value=watchParam;
  const deepLink=Boolean(roomParam||watchParam);
  const resumed=!deepLink&&['http:','https:'].includes(location.protocol)&&network.resumeSession();
  if(resumed) enterMode('online');
  else if(deepLink) {
    enterMode('online');
    network.message=watchParam&&!roomParam?'代碼已填入。輸入暱稱後按「以觀戰加入」。':'代碼已填入。輸入暱稱後按「加入房間」。';
    networkChanged();
  }
})();
