#!/usr/bin/env node
// Local dev server: serves apps/web and mounts api/firms.js at /api/firms, like Vercel does.
// No dependencies, no login. Reads FIRMS_MAP_KEY from .env.local (or the environment).
//   npm run dev      ->  http://localhost:3000     (PORT=4000 npm run dev to change)
const http = require('http'), fs = require('fs'), path = require('path'), url = require('url');
const root = path.join(__dirname, '..');
const webRoot = path.join(root, 'apps', 'web');

if(typeof fetch !== 'function'){ console.error('Node 18+ is required (global fetch). Found ' + process.version); process.exit(1); }

// Minimal .env.local / .env loader (KEY=VALUE, optional quotes, # comments). Real env vars win.
for(const f of ['.env.local', '.env']){
  let text; try{ text = fs.readFileSync(path.join(root, f), 'utf8'); }catch(e){ continue; }
  for(const line of text.split(/\r?\n/)){
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if(!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if(v && process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const handler = require('../api/firms.js');
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
                '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };

http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  if(u.pathname === '/api/firms'){
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };
    res.send = (t) => { res.end(t); return res; };
    return Promise.resolve(handler({ method: req.method, query: u.query }, res)).catch(() => { res.statusCode = 500; res.end('{"error":"internal error"}'); });
  }
  const rel = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
  const file = path.join(webRoot, rel);
  if(!file.startsWith(webRoot + path.sep)){ res.statusCode = 403; return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if(err){ res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
}).listen(Number(process.env.PORT) || 3000, () => {
  const port = Number(process.env.PORT) || 3000;
  console.log('EMBER dev server: http://localhost:' + port);
  console.log(process.env.FIRMS_MAP_KEY ? 'FIRMS_MAP_KEY: found (live fire detections enabled)'
                                        : 'FIRMS_MAP_KEY: NOT set -- app will use the cached fire. Create .env.local (see .env.example).');
});
