'use strict';
(function (root) {
  const TOKEN_KEY = 'flip-blocks-session';
  const DEFAULT_WINDOW_MS = 60000;
  function serverAddress(value) {
    const raw = value.trim();
    if (!raw) throw new Error('請輸入主機 IP，例如 192.168.1.20:8787。');
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error('請輸入 IP 或主機名稱，可加上連接埠。');
    if (!url.port && !raw.includes('://')) url.port = '8787';
    return url;
  }
  function storage() {
    try { return root.sessionStorage || null; } catch { return null; }
  }
  function loadToken() {
    return storage()?.getItem(TOKEN_KEY) || '';
  }
  function saveToken(token) {
    const store = storage();
    if (!store) return;
    if (token) store.setItem(TOKEN_KEY, token);
    else store.removeItem(TOKEN_KEY);
  }
  function reconnectDelay(attempt) {
    return Math.min(500 * (2 ** Math.max(attempt, 0)), 5000);
  }
  function encodeBoard(board) {
    if (typeof board === 'string') return board;
    return board.map(row => row.join('')).join('');
  }
  function decodeBoard(encoded) {
    if (Array.isArray(encoded)) return encoded;
    const board = [];
    for (let y = 0; y < 20; y++) {
      const row = [];
      for (let x = 0; x < 10; x++) row.push(Number(encoded[y * 10 + x]));
      board.push(row);
    }
    return board;
  }
  function applyGame(target, snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return target;
    Object.assign(target, snapshot);
    if (typeof target.board === 'string') target.board = decodeBoard(target.board);
    return target;
  }
  function remainText(deadline) {
    const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    return `對方斷線，等待重連中（剩餘 ${secs} 秒）`;
  }
  class Connection {
    constructor(onChange, onState) {
      this.onChange = onChange; this.onState = onState;
      this.active = false; this.owner = null; this.connected = [false, false]; this.ready = [false, false];
      this.message = ''; this.socket = null;
      this.sessionToken = ''; this.role = null; this.color = 1;
      this.reconnect = null; this.reconnectUntil = 0; this.reconnectAttempt = 0;
      this.pendingReconnect = false; this.intentionalLeave = false;
      this.watchdog = 0; this.reconnectTimer = 0;
      this.countdown = setInterval(() => {
        if (this.reconnect?.deadline) {
          this.message = remainText(this.reconnect.deadline);
          this.onChange();
        }
      }, 500);
    }
    connect(role, color) {
      if (this.socket) this.send({ type: 'leave' });
      this.detach(true);
      this.active = true; this.role = role; this.color = color;
      this.message = '正在連線…'; this.onChange();
      this.openSocket(false);
    }
    resumeSession() {
      const token = loadToken();
      if (!token) return false;
      this.detach(false);
      this.active = true; this.sessionToken = token; this.pendingReconnect = true;
      this.reconnectUntil = Date.now() + DEFAULT_WINDOW_MS;
      this.message = '正在恢復對局…'; this.onChange();
      this.openSocket(true);
      return true;
    }
    openSocket(reclaim) {
      this.intentionalLeave = false;
      const url = new URL('/match', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let ws;
      try { ws = new WebSocket(url); } catch { this.fail('請先啟動連線主機，再開啟主機提供的網址。'); return; }
      this.socket = ws;
      this.lastMessage = Date.now();
      this.watchdog = setInterval(() => {
        if (this.socket === ws && Date.now() - this.lastMessage > 15000) ws.close();
      }, 1000);
      const timeout = setTimeout(() => {
        if (this.socket === ws && this.owner === null && !this.pendingReconnect) this.fail('連線逾時，請確認主機已啟動及 IP 正確。');
        else if (this.socket === ws && this.pendingReconnect && this.owner === null) ws.close();
      }, 8000);
      ws.onopen = () => {
        if (this.socket !== ws) return;
        if (reclaim && this.sessionToken) this.send({ type: 'reconnect', sessionToken: this.sessionToken });
        else this.send({ type: 'join', role: this.role, color: this.color });
      };
      ws.onmessage = event => {
        if (this.socket !== ws) return;
        this.lastMessage = Date.now();
        let data; try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'error') { this.fail(data.message); return; }
        if (data.type === 'joined') {
          clearTimeout(timeout);
          this.owner = data.owner;
          this.pendingReconnect = false;
          this.reconnectAttempt = 0;
          if (data.sessionToken) { this.sessionToken = data.sessionToken; saveToken(data.sessionToken); }
          this.message = ''; this.onChange();
        } else if (data.type === 'state' && this.owner !== null) {
          this.connected = data.connected; this.ready = data.ready;
          const wasWaiting = this.reconnect;
          this.reconnect = data.reconnect || null;
          if (this.reconnect) {
            this.reconnectUntil = this.reconnect.deadline;
            this.message = remainText(this.reconnect.deadline);
          } else if (wasWaiting && this.message.startsWith('對方斷線')) this.message = '';
          this.onState(data.game); this.onChange();
        } else if (data.type === 'tick' && this.owner !== null) {
          this.onState({
            elapsed: data.elapsed, pieces: data.pieces, timers: data.timers,
            locked: data.locked, state: data.state, lastFlips: data.lastFlips
          });
        } else if (data.type === 'reconnect-waiting') {
          this.reconnect = { owner: data.owner, deadline: data.deadline };
          this.reconnectUntil = data.deadline;
          this.message = remainText(data.deadline);
          this.onChange();
        } else if (data.type === 'reconnected') {
          this.reconnect = null; this.pendingReconnect = false; this.message = ''; this.onChange();
        } else if (data.type === 'reconnect-timeout') {
          this.reconnect = null;
          if (data.owner === this.owner) { this.sessionToken = ''; saveToken(''); }
          this.message = data.winner === this.owner ? '對方逾時未歸，你獲勝。' : '重連逾時，對局已結束。';
          this.onChange();
        }
      };
      ws.onerror = () => { if (this.socket === ws) this.message = '無法連線，請確認已執行 npm start、IP／連接埠正確，且防火牆允許連線。'; };
      ws.onclose = () => {
        clearTimeout(timeout);
        if (this.socket !== ws) return;
        clearInterval(this.watchdog);
        this.socket = null;
        if (this.intentionalLeave) return;
        if (this.sessionToken && (this.owner !== null || this.pendingReconnect)) {
          if (!this.reconnectUntil) this.reconnectUntil = Date.now() + DEFAULT_WINDOW_MS;
          this.scheduleReconnect();
          return;
        }
        this.fail(this.message || '連線已中斷，請重新加入房間。');
      };
    }
    scheduleReconnect() {
      const remaining = this.reconnectUntil - Date.now();
      if (remaining <= 0) { this.fail('重連逾時，請重新加入房間。'); return; }
      this.pendingReconnect = true;
      this.message = '連線已中斷，正在重新連線…';
      this.onChange();
      const delay = Math.min(reconnectDelay(this.reconnectAttempt++), remaining);
      this.reconnectTimer = setTimeout(() => this.openSocket(true), delay);
    }
    send(message) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
    fail(message) {
      this.detach(true); this.message = message; this.onChange();
    }
    disconnect() {
      const ws = this.socket; this.socket = null;
      clearInterval(this.watchdog); clearTimeout(this.reconnectTimer);
      if (ws) { ws.onclose = null; ws.close(); }
    }
    leave() {
      this.intentionalLeave = true;
      this.send({ type: 'leave' });
      this.detach(true);
    }
    detach(clearToken) {
      this.intentionalLeave = true;
      clearInterval(this.watchdog);
      clearTimeout(this.reconnectTimer);
      const ws = this.socket; this.socket = null;
      if (ws) { ws.onclose = null; ws.close(); }
      this.active = false; this.owner = null; this.connected = [false, false]; this.ready = [false, false];
      this.reconnect = null; this.pendingReconnect = false; this.reconnectUntil = 0; this.reconnectAttempt = 0;
      if (clearToken) { this.sessionToken = ''; saveToken(''); }
    }
  }
  const api = { Connection, serverAddress, reconnectDelay, encodeBoard, decodeBoard, applyGame };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlipNetwork = api;
})(globalThis);
