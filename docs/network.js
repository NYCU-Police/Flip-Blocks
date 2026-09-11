'use strict';
(function (root) {
  const TOKEN_KEY = 'flip-blocks-session';
  const NAME_KEY = 'flip-blocks-nickname';
  const DEFAULT_WINDOW_MS = 60000;
  const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const ROOM_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
  function parseName(raw) {
    if (typeof raw !== 'string') return '';
    const name = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim();
    return name.length >= 2 && name.length <= 12 ? name : '';
  }
  function parseCode(raw) {
    if (typeof raw !== 'string') return '';
    const code = raw.trim().toUpperCase();
    return ROOM_CODE_RE.test(code) ? code : '';
  }
  function parseToken(raw) {
    return typeof raw === 'string' && /^[0-9a-f]{32}$/.test(raw) ? raw : '';
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }
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
  function loadSession() {
    const raw = storage()?.getItem(TOKEN_KEY);
    if (!raw) return { token: '', code: '' };
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        return { token: parseToken(data.token), code: parseCode(data.code) };
      }
    } catch {}
    return { token: parseToken(raw), code: '' };
  }
  function saveSession(token, code) {
    const store = storage();
    if (!store) return;
    const safe = parseToken(token);
    if (safe) store.setItem(TOKEN_KEY, JSON.stringify({ token: safe, code: parseCode(code) }));
    else store.removeItem(TOKEN_KEY);
  }
  function loadName(store) {
    try { return parseName((store || root.localStorage)?.getItem(NAME_KEY) || ''); }
    catch { return ''; }
  }
  function saveName(name, store) {
    const safe = parseName(name);
    try {
      const target = store || root.localStorage;
      if (!target) return safe;
      if (safe) target.setItem(NAME_KEY, safe);
      else target.removeItem(NAME_KEY);
    } catch {}
    return safe;
  }
  function loadToken() { return loadSession().token; }
  function saveToken(token) { saveSession(token, loadSession().code); }
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
    return `對手斷線，${secs} 秒內可重連…`;
  }
  class Connection {
    constructor(onChange, onState) {
      this.onChange = onChange; this.onState = onState;
      this.active = false; this.owner = null; this.connected = [false, false]; this.ready = [false, false];
      this.message = ''; this.socket = null;
      this.sessionToken = ''; this.role = null; this.color = 1;
      this.name = ''; this.names = ['', '']; this.code = '';
      this.spectating = false; this.spectators = 0; this.spectatorNames = [];
      this.queued = false;
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
    connect(role, options) {
      const opts = typeof options === 'number' ? { color: options } : (options || {});
      if (this.socket) this.send({ type: 'leave' });
      this.detach(true);
      this.active = true; this.role = role; this.color = opts.color === 2 ? 2 : 1;
      this.name = parseName(opts.name); this.code = parseCode(opts.code);
      this.spectating = role === 'spectate';
      this.queued = false;
      this.message = role === 'queue' ? '正在配對對手…' : '正在連線…'; this.onChange();
      this.openSocket(false);
    }
    resumeSession() {
      const session = loadSession();
      if (!session.token) return false;
      this.detach(false);
      this.active = true; this.sessionToken = session.token; this.code = session.code;
      this.pendingReconnect = true;
      this.reconnectUntil = Date.now() + DEFAULT_WINDOW_MS;
      this.message = '正在恢復對局…'; this.onChange();
      this.openSocket(true);
      return true;
    }
    openSocket(reclaim) {
      this.intentionalLeave = false;
      const url = new URL('/match', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let ws;
      try { ws = new WebSocket(url); } catch { this.fail('無法連到對戰伺服器，請稍後再試。'); return; }
      this.socket = ws;
      this.lastMessage = Date.now();
      this.watchdog = setInterval(() => {
        if (this.socket === ws && Date.now() - this.lastMessage > 15000) ws.close();
      }, 1000);
      const timeout = setTimeout(() => {
        if (this.socket === ws && this.owner === null && !this.pendingReconnect && !this.spectating && !this.queued) this.fail('連線逾時，請稍後再試。');
        else if (this.socket === ws && this.pendingReconnect && this.owner === null) ws.close();
      }, 8000);
      ws.onopen = () => {
        if (this.socket !== ws) return;
        if (reclaim && this.sessionToken) this.send({ type: 'reconnect', sessionToken: this.sessionToken, code: this.code });
        else if (this.role === 'queue') this.send({ type: 'queue', name: this.name, color: this.color });
        else this.send({ type: 'join', role: this.role, color: this.color, name: this.name, code: this.code });
      };
      ws.onmessage = event => {
        if (this.socket !== ws) return;
        this.lastMessage = Date.now();
        let data; try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'error') { this.fail(data.message); return; }
        if (data.type === 'heartbeat') return;
        if (data.type === 'queued') {
          clearTimeout(timeout);
          this.queued = true;
          this.message = '正在配對對手…';
          this.onChange();
          return;
        }
        if (data.type === 'joined') {
          clearTimeout(timeout);
          this.owner = data.owner === 0 || data.owner === 1 ? data.owner : null;
          this.spectating = data.role === 'spectate';
          this.code = parseCode(data.code) || this.code;
          this.pendingReconnect = false;
          this.queued = false;
          this.reconnectAttempt = 0;
          if (data.sessionToken) {
            this.sessionToken = data.sessionToken;
            saveSession(data.sessionToken, this.code);
          }
          this.message = ''; this.onChange();
        } else if (data.type === 'state' && (this.owner !== null || this.spectating)) {
          this.connected = data.connected; this.ready = data.ready;
          this.names = Array.isArray(data.names) ? data.names : this.names;
          this.spectators = Number(data.spectators) || 0;
          this.spectatorNames = Array.isArray(data.spectatorNames) ? data.spectatorNames : [];
          if (data.code) this.code = parseCode(data.code) || this.code;
          const wasWaiting = this.reconnect;
          this.reconnect = data.reconnect || null;
          if (this.reconnect) {
            this.reconnectUntil = this.reconnect.deadline;
            this.message = remainText(this.reconnect.deadline);
          } else if (wasWaiting && this.message.startsWith('對方斷線')) this.message = '';
          this.onState(data.game); this.onChange();
        } else if (data.type === 'tick' && (this.owner !== null || this.spectating)) {
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
          if (data.owner === this.owner) { this.sessionToken = ''; saveSession('', ''); }
          this.message = data.winner === this.owner ? '對方逾時未歸，你獲勝。' : '重連逾時，對局已結束。';
          this.onChange();
        }
      };
      ws.onerror = () => { if (this.socket === ws) this.message = '無法連線，請稍後再試。'; };
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
      this.queued = false;
      this.reconnect = null; this.pendingReconnect = false; this.reconnectUntil = 0; this.reconnectAttempt = 0;
      this.spectating = false; this.spectators = 0; this.spectatorNames = [];
      this.names = ['', ''];
      if (clearToken) { this.sessionToken = ''; this.code = ''; saveSession('', ''); }
    }
  }
  const api = {
    Connection, serverAddress, reconnectDelay, encodeBoard, decodeBoard, applyGame,
    parseName, parseCode, parseToken, escapeHtml, loadName, saveName, loadSession, saveSession,
    ROOM_ALPHABET, NAME_KEY, TOKEN_KEY
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlipNetwork = api;
})(globalThis);
