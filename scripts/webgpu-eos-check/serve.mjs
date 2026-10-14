import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
const here = new URL('.', import.meta.url).pathname;
const modelDir = join(homedir(), '.cache/uktub-scholar/models/eos-onnx-6369be38417e');
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.onnx_data': 'application/octet-stream' };
export function serve(port = 0) {
  const srv = createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = url === '/' ? join(here, 'index.html') : url.startsWith('/model/') ? join(modelDir, url.slice(7)) : join(here, url.slice(1));
    if (!file.startsWith(here) && !file.startsWith(modelDir) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
    const size = statSync(file).size; const h = { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' };
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) { const start = range[1] ? Number(range[1]) : 0; const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1; res.writeHead(206, { ...h, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 }); createReadStream(file, { start, end }).pipe(res); }
    else { res.writeHead(200, { ...h, 'content-length': size }); createReadStream(file).pipe(res); }
  });
  return new Promise((ok) => srv.listen(port, '127.0.0.1', () => ok(srv)));
}
