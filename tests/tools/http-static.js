#!/usr/bin/env node
/* 零依赖静态服务器：供内网离线演练使用（无需 Python）。
   node tests/tools/http-static.js 8936  → http://127.0.0.1:8936/ */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.cwd();
const port = parseInt(process.argv[2] || '8936', 10);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.md': 'text/plain; charset=utf-8' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.resolve(root, '.' + p);
  if (!f.startsWith(root)) { res.writeHead(403); res.end('403'); return; }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(port, '127.0.0.1', () => console.log('[static] http://127.0.0.1:' + port + '/'));
