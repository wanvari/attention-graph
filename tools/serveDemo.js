#!/usr/bin/env node
// Static file server for the read-only demo (ui/demo.html). No dependencies.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const port = Number(process.argv[2]) || 8912;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.md': 'text/plain; charset=utf-8'
};

http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
  const target = urlPath === '/' ? '/ui/demo.html' : urlPath;
  const full = path.join(root, target);
  const allowed = /^\/(?:ui|lib|vendor)\/[a-zA-Z0-9._-]+$/.test(target) || target === '/fixtures/current/snapshot.json' || /^\/validation\/[a-zA-Z0-9_-]+\.(?:json|md)$/.test(target) || /^\/icon[0-9]+\.png$/.test(target);
  if (!allowed || !full.startsWith(root + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
  res.end(fs.readFileSync(full));
}).listen(port, '127.0.0.1', () => console.log(`Demo at http://localhost:${port}/ui/demo.html`));
