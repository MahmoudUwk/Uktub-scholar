/** Tiny static file server for the browser tests. Plain HTTP, no COOP/COEP. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".db": "application/octet-stream",
};

export function serveDirectory(dir, { host = "127.0.0.1", port = 0 } = {}) {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      let file = path.join(dir, rel);
      if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      if (!fs.existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(500); res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const url = `http://${host}:${typeof addr === "object" && addr ? addr.port : port}`;
      resolve({ url, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
