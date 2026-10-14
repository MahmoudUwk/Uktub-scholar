// serve.mjs — dependency-free static file server for the probe page.
// Usage: node serve.mjs [port]  (default 8000). Serves this directory on 127.0.0.1.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8' };

export function startStatic(port = 0, root = ROOT) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!p.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
    if (p.endsWith(path.sep)) p += 'index.html';
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}

const cliPort = Number(process.argv[2] || 8000);
if (process.argv[1] && process.argv[1].endsWith('serve.mjs')) {
  startStatic(cliPort).then(({ port }) => console.log(`probe page on http://127.0.0.1:${port}/index.html`));
}
