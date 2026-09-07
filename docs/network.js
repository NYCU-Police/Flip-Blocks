'use strict';
(function (root) {
  function serverAddress(value) {
    const raw = value.trim();
    if (!raw) throw new Error('請輸入主機 IP，例如 192.168.1.20:8787。');
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error('請輸入 IP 或主機名稱，可加上連接埠。');
    if (!url.port && !raw.includes('://')) url.port = '8787';
    return url;
  }
  class Connection {
    constructor(onChange, onState) {
      this.onChange = onChange; this.onState = onState;
      this.active = false; this.owner = null; this.connected = [false, false]; this.ready = [false, false];
      this.message = ''; this.socket = null;
    }
    connect(role, color) {
      this.leave(); this.active = true;
      this.message = '正在連線…'; this.onChange();
      const url = new URL('/match', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let ws;
      try { ws = new WebSocket(url); } catch { this.fail('請先啟動連線主機，再開啟主機提供的網址。'); return; }
      this.socket = ws;
      this.lastMessage = Date.now();
      this.watchdog = setInterval(() => {
        if (this.socket === ws && Date.now() - this.lastMessage > 15000) this.fail('主機沒有回應，請檢查網路後重新加入。');
      }, 1000);
      const timeout = setTimeout(() => { if (this.socket === ws && this.owner === null) this.fail('連線逾時，請確認主機已啟動及 IP 正確。'); }, 8000);
      ws.onopen = () => { if (this.socket === ws) this.send({ type: 'join', role, color }); };
      ws.onmessage = event => {
        if (this.socket !== ws) return;
        this.lastMessage = Date.now();
        let data; try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'error') { this.fail(data.message); return; }
        if (data.type === 'joined') {
          clearTimeout(timeout); this.owner = data.owner;
          this.message = ''; this.onChange();
        } else if (data.type === 'state' && this.owner !== null) {
          this.connected = data.connected; this.ready = data.ready;
          this.onState(data.game); this.onChange();
        }
      };
      ws.onerror = () => { if (this.socket === ws) this.message = '無法連線，請確認已執行 npm start、IP／連接埠正確，且防火牆允許連線。'; };
      ws.onclose = () => {
        clearTimeout(timeout);
        if (this.socket === ws) this.fail(this.message || '連線已中斷，請重新加入房間。');
      };
    }
    send(message) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
    fail(message) {
      this.leave(); this.message = message; this.onChange();
    }
    leave() {
      clearInterval(this.watchdog);
      const ws = this.socket; this.socket = null;
      if (ws) { ws.onclose = null; ws.close(); }
      this.active = false; this.owner = null; this.connected = [false, false]; this.ready = [false, false];
    }
  }
  const api = { Connection, serverAddress };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlipNetwork = api;
})(globalThis);
