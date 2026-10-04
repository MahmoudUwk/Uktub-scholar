#!/usr/bin/env node
// A stand-in for llama-server in tests: parses the flags the package passes and serves /health,
// /v1/models and /v1/embeddings. FAKE_MODE: ok (default) | exit (fail at once) | hang (never healthy) | slow (healthy after 300 ms).
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
if (process.env.FAKE_ARGS_LOG) appendFileSync(process.env.FAKE_ARGS_LOG, JSON.stringify(argv) + "\n");
const mode = process.env.FAKE_MODE ?? "ok";
if (mode === "exit") {
  process.stderr.write("x".repeat(600) + "\nerror: failed to load model: bad magic (the end)\n");
  process.exit(3);
}
const started = Date.now();
const vec = (t) => {
  const sunny = /solar|sun/i.test(t);
  return [sunny ? 1 : 0.05, 0.05];
};
const server = createServer((req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/health") {
    const ready = mode === "ok" || (mode === "slow" && Date.now() - started > 300);
    return json(ready ? 200 : 503, ready ? { status: "ok" } : { error: { message: "Loading model" } });
  }
  if (req.url === "/v1/models") return json(200, { data: [{ id: String(flag("-m") ?? "fake").split("/").pop(), meta: { n_embd: 2, size: 4242, ftype: "Q8_0" } }] });
  if (req.url === "/v1/embeddings" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => json(200, { data: JSON.parse(body).input.map((t, index) => ({ index, embedding: vec(t) })) }));
    return;
  }
  json(404, { error: "not found" });
});
server.listen(Number(flag("--port")), flag("--host") ?? "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
