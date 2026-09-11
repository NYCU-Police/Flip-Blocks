'use strict';
const crypto = require('node:crypto');
const { Game } = require('../docs/game-core.js');
const { encodeBoard, ROOM_ALPHABET } = require('../docs/network.js');

function makeCode(taken) {
  for (let i = 0; i < 64; i++) {
    const code = Array.from(crypto.randomBytes(6), byte => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join('');
    if (!taken.has(code)) return code;
  }
  throw new Error('room code exhausted');
}

function createRoom(code) {
  const game = new Game();
  game.state = 'ready';
  return {
    code,
    game,
    players: [null, null],
    names: ['', ''],
    spectators: new Map(),
    ready: [false, false],
    sessions: [null, null],
    reconnecting: [null, null],
    fast: [false, false],
    fastUntil: [0, 0],
    pausedForReconnect: false,
    revision: 0,
    lastTickSent: 0,
    emptySince: null,
    matchSeq: 0,
    matchKey: null,
    recorded: false
  };
}

function createRoomLife({
  rooms, tokens, reconnectMs, roomTtlMs, board,
  send, releaseRoom, pruneMaps
}) {
  function recipients(room) {
    return [...room.players.filter(Boolean), ...room.spectators.keys()];
  }
  function roomOf(ws) { return ws?.roomCode ? rooms.get(ws.roomCode) : null; }
  function reconnectInfo(room) {
    const owner = room.reconnecting.findIndex(Boolean);
    if (owner < 0) return null;
    return { owner, deadline: room.reconnecting[owner].deadline };
  }
  function round3(n) { return Math.round(n * 1000) / 1000; }
  function publicGame(room) {
    const game = room.game;
    return {
      state: game.state, sides: game.sides, board: encodeBoard(game.board), queues: game.queues,
      pieces: game.pieces, timers: [round3(game.timers[0]), round3(game.timers[1])],
      locked: game.locked, elapsed: round3(game.elapsed), winner: game.winner, lastFlips: game.lastFlips
    };
  }
  function spectatorNames(room) { return [...room.spectators.values()]; }
  function markEmpty(room) {
    const idle = !room.players[0] && !room.players[1] && !room.reconnecting[0] && !room.reconnecting[1];
    room.emptySince = idle ? (room.emptySince || Date.now()) : null;
  }
  function dropToken(token) { if (token) tokens.delete(token); }
  function broadcast(room, kind = 'full') {
    if (kind === 'tick') {
      const data = {
        type: 'tick', revision: ++room.revision, elapsed: round3(room.game.elapsed), pieces: room.game.pieces,
        timers: [round3(room.game.timers[0]), round3(room.game.timers[1])], locked: room.game.locked,
        state: room.game.state, lastFlips: room.game.lastFlips
      };
      for (const ws of recipients(room)) send(ws, data);
      return;
    }
    const data = {
      type: 'state', revision: ++room.revision, game: publicGame(room),
      connected: room.players.map(Boolean), ready: room.ready, reconnect: reconnectInfo(room),
      names: room.names.slice(), spectators: room.spectators.size, spectatorNames: spectatorNames(room),
      code: room.code
    };
    for (const ws of recipients(room)) send(ws, data);
  }
  function stopInput(room) { room.fast.fill(false); room.fastUntil.fill(0); }
  function matchActive(room) { return room.game.state === 'playing' || room.game.state === 'paused'; }
  function seatTaken(room, owner) { return Boolean(room.players[owner] || room.reconnecting[owner]); }
  function issueToken() { return crypto.randomBytes(16).toString('hex'); }
  function pct(count) { return Number((count / 2).toFixed(1)); }
  function recordOutcome(room, winner) {
    try {
      if (room.recorded || winner !== 0 && winner !== 1) return;
      const winnerName = room.names[winner], loserName = room.names[1 - winner];
      if (!winnerName || !loserName || !room.matchKey) return;
      const counts = room.game.counts();
      const winColor = room.game.sides[winner].color;
      const loseColor = room.game.sides[1 - winner].color;
      room.recorded = board.record({
        room: room.code,
        matchKey: room.matchKey,
        winnerName,
        loserName,
        winnerPct: pct(counts[winColor - 1]),
        loserPct: pct(counts[loseColor - 1])
      }) || room.recorded;
    } catch (error) {
      console.error('無法寫入排行榜：', error);
    }
  }
  function beginMatch(room) {
    room.matchSeq += 1;
    room.matchKey = `${room.code}:${room.matchSeq}`;
    room.recorded = false;
  }
  function startReconnect(room, owner) {
    room.players[owner] = null;
    room.ready[owner] = false;
    stopInput(room);
    if (room.game.state === 'playing') {
      room.game.pause();
      room.pausedForReconnect = true;
    }
    const deadline = Date.now() + reconnectMs;
    room.reconnecting[owner] = { deadline };
    const payload = { type: 'reconnect-waiting', owner, deadline };
    for (const ws of recipients(room)) send(ws, payload);
    markEmpty(room);
    broadcast(room);
  }
  function resumeIfReady(room) {
    if (room.reconnecting.every(slot => !slot) && room.pausedForReconnect && room.game.state === 'paused' && room.players.every(Boolean)) {
      room.game.pause();
      room.pausedForReconnect = false;
    }
  }
  function timeoutReconnect(room, owner) {
    const remaining = 1 - owner;
    if (matchActive(room) && room.players[remaining]) recordOutcome(room, remaining);
    room.reconnecting[owner] = null;
    dropToken(room.sessions[owner]);
    room.sessions[owner] = null;
    room.players[owner] = null;
    room.names[owner] = '';
    room.ready.fill(false);
    stopInput(room);
    room.pausedForReconnect = false;
    const payload = { type: 'reconnect-timeout', owner, winner: remaining };
    for (const ws of recipients(room)) send(ws, payload);
    room.game.reset(room.game.sides[0].color);
    room.game.state = 'ready';
    room.matchKey = null;
    room.recorded = false;
    markEmpty(room);
    broadcast(room);
  }
  function lobbyDepart(room, owner) {
    dropToken(room.sessions[owner]);
    room.players[owner] = null;
    room.sessions[owner] = null;
    room.reconnecting[owner] = null;
    room.names[owner] = '';
    room.ready.fill(false);
    stopInput(room);
    room.pausedForReconnect = false;
    room.game.state = 'ready';
    markEmpty(room);
    broadcast(room);
  }
  function forfeitToLobby(room, owner) {
    const remaining = 1 - owner;
    if (matchActive(room) && room.names[remaining]) recordOutcome(room, remaining);
    dropToken(room.sessions[owner]);
    room.reconnecting[owner] = null;
    room.sessions[owner] = null;
    room.players[owner] = null;
    room.names[owner] = '';
    room.ready.fill(false);
    stopInput(room);
    room.pausedForReconnect = false;
    room.game.reset(room.game.sides[0].color);
    room.game.state = 'ready';
    room.matchKey = null;
    room.recorded = false;
    markEmpty(room);
    broadcast(room);
  }
  function claimSeat(room, ws, owner, token, name) {
    room.players[owner] = ws;
    room.names[owner] = name;
    room.sessions[owner] = token;
    room.ready[owner] = false;
    room.emptySince = null;
    ws.roomCode = room.code;
    ws.seat = owner;
    ws.joined = true;
    tokens.set(token, { code: room.code, owner });
  }
  function destroyRoom(room) {
    for (const ws of recipients(room)) {
      send(ws, { type: 'error', message: '房間已關閉。' });
      ws.close(1000);
    }
    for (const token of room.sessions) dropToken(token);
    rooms.delete(room.code);
    releaseRoom(room);
  }
  function sweepRooms() {
    const now = Date.now();
    pruneMaps();
    for (const room of rooms.values()) {
      markEmpty(room);
      if (room.emptySince && now - room.emptySince >= roomTtlMs) destroyRoom(room);
    }
  }
  return {
    recipients, roomOf, reconnectInfo, round3, publicGame, spectatorNames, markEmpty, dropToken,
    broadcast, stopInput, matchActive, seatTaken, issueToken, pct, recordOutcome,
    beginMatch, startReconnect, resumeIfReady, timeoutReconnect, lobbyDepart,
    forfeitToLobby, claimSeat, destroyRoom, sweepRooms
  };
}

module.exports = { makeCode, createRoom, createRoomLife };
