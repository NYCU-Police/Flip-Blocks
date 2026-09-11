'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ASSETS = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/game.js', ['game.js', 'text/javascript']], ['/game-core.js', ['game-core.js', 'text/javascript']],
  ['/network.js', ['network.js', 'text/javascript']], ['/ai.js', ['ai.js', 'text/javascript']], ['/audio.js', ['audio.js', 'text/javascript']],
  ['/session-record.js', ['session-record.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
]);

function createRequestListener({ started, rooms, board, limitedApi, docsDir }) {
  const assets = ASSETS;
  return (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { res.writeHead(400); res.end('Invalid URL'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    if (url.pathname === '/healthz') {
      if (limitedApi(req, res)) return;
      const body = JSON.stringify({
        ok: true,
        uptime: Math.round((Date.now() - started) / 1000),
        rooms: rooms.size,
        playing: [...rooms.values()].filter(room => room.game.state === 'playing').length
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') res.end();
      else res.end(body);
      return;
    }
    if (url.pathname === '/leaderboard') {
      if (limitedApi(req, res)) return;
      const body = JSON.stringify({ rankings: board.top(20) });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=30',
        'X-Content-Type-Options': 'nosniff'
      });
      if (req.method === 'HEAD') res.end();
      else res.end(body);
      return;
    }
    const asset = assets.get(url.pathname);
    if (!asset) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(path.join(docsDir, asset[0])).pipe(res);
  };
}

module.exports = { createRequestListener, ASSETS };
