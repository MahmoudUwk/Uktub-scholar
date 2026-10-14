/** Local two-origin harness servers (loopback only, plain HTTP). No provider quota. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Seen {
  method: string | undefined;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  query: URLSearchParams;
}

export interface Harness {
  a: Server;
  b: Server;
  urlA: string;
  urlB: string;
  seenA: Seen[];
  seenB: Seen[];
  close(): Promise<void>;
}

const record = (req: IncomingMessage, log: Seen[]): URL => {
  const url = new URL(req.url ?? "/", "http://x");
  const headers: Seen["headers"] = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
  log.push({ method: req.method, path: url.pathname, headers, query: url.searchParams });
  return url;
};

const pdf = (n: number): Buffer => {
  const head = Buffer.from("%PDF-1.4\n");
  const body = Buffer.alloc(Math.max(0, n - head.length - 6), 0x61);
  return Buffer.concat([head, body, Buffer.from("\n%%EOF")]);
};

const TEST_HTML = `<!doctype html><meta charset="utf8"><title>net harness</title>
<script type="module">
import * as download from "/dist/download.bundle.js";
import * as providerFetch from "/dist/provider-fetch.bundle.js";
import * as arxiv from "/dist/arxiv.bundle.js";
globalThis.__mods = { download, providerFetch, arxiv };
</script>`;

/** Serves the test page + transpiled page modules from tests-browser-net/dist-page. */
async function servePage(pathname: string, res: ServerResponse): Promise<void> {
  try {
    if (pathname === "/test.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(TEST_HTML);
      return;
    }
    const file = join(new URL(import.meta.url).pathname.replace(/\/servers\.(ts|js)$/, ""), "dist-page", pathname.replace(/^\/dist\//, ""));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "content-length": body.length });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

export async function startHarness(): Promise<Harness> {
  const seenA: Seen[] = [];
  const seenB: Seen[] = [];
  let urlA = "";
  let urlB = "";

  const a = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = record(req, seenA);
    if (url.pathname === "/test.html" || url.pathname.startsWith("/dist/")) {
      void servePage(url.pathname, res);
      return;
    }
    const cors = { "access-control-allow-origin": "*" };
    if (url.pathname === "/small.pdf") {
      const body = pdf(2048);
      res.writeHead(200, { ...cors, "content-type": "application/pdf", "content-length": body.length });
      res.end(body);
    } else if (url.pathname === "/exact.bin") {
      const n = Number(url.searchParams.get("n") ?? "64");
      const body = pdf(n);
      res.writeHead(200, { ...cors, "content-type": "application/pdf", "content-length": body.length });
      res.end(body);
    } else if (url.pathname === "/big.bin") {
      const n = Number(url.searchParams.get("n") ?? "4096");
      const body = pdf(n);
      res.writeHead(200, { ...cors, "content-type": "application/pdf", "content-length": body.length });
      res.end(body);
    } else if (url.pathname === "/declared-big.bin") {
      // Declares more than it sends capacity for: header alone exceeds small caps.
      const declared = Number(url.searchParams.get("declared") ?? "100000");
      const body = pdf(128);
      res.writeHead(200, { ...cors, "content-type": "application/pdf", "content-length": declared });
      res.end(body);
    } else if (url.pathname === "/slow") {
      // One byte per 200 ms; a 300 ms client cap must fire mid-body.
      res.writeHead(200, { ...cors, "content-type": "application/pdf" });
      let i = 0;
      const t = setInterval(() => {
        i += 1;
        if (i > 20) {
          clearInterval(t);
          res.end();
          return;
        }
        res.write("x");
      }, 200);
    } else if (url.pathname === "/to-b-ok") {
      res.writeHead(302, { ...cors, location: `${urlB}/final-ok` });
      res.end();
    } else if (url.pathname === "/to-b-noacao") {
      res.writeHead(302, { ...cors, location: `${urlB}/final-noacao` });
      res.end();
    } else if (url.pathname === "/echo") {
      res.writeHead(200, { ...cors, "content-type": "application/pdf", "content-length": 8 });
      res.end(pdf(64));
    } else {
      res.writeHead(404, cors);
      res.end();
    }
  });

  const b = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = record(req, seenB);
    if (url.pathname === "/final-ok") {
      const body = pdf(512);
      res.writeHead(200, {
        "access-control-allow-origin": "*",
        "content-type": "application/pdf",
        "content-length": body.length,
      });
      res.end(body);
    } else if (url.pathname === "/final-noacao") {
      const body = pdf(512);
      res.writeHead(200, { "content-type": "application/pdf", "content-length": body.length });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => a.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => b.listen(0, "127.0.0.1", resolve));
  // Different ORIGINS: 127.0.0.1 vs localhost (same loopback, distinct hosts).
  urlA = `http://127.0.0.1:${(a.address() as AddressInfo).port}`;
  urlB = `http://localhost:${(b.address() as AddressInfo).port}`;
  return {
    a,
    b,
    urlA,
    urlB,
    seenA,
    seenB,
    close: async () => {
      await new Promise<void>((resolve) => a.close(() => resolve()));
      await new Promise<void>((resolve) => b.close(() => resolve()));
    },
  };
}
