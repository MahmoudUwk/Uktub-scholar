/**
 * Local System One endpoint: puts any scorer behind the package's existing
 * `llama-cpp` engine path (`UKTUB_VERIFY_ENGINE=llama-cpp`, `UKTUB_VERIFY_URL`).
 * The package learns nothing about the model behind it except what
 * `/v1/models` reports, which becomes the judgment identity.
 *
 * Protocol (exactly what src/core/verify/claim.ts speaks):
 *   POST /v1/systemone  {state, questions: {c: {type: "noul", instructions}}}
 *                       → {answers: {c: {noul: P(true)}}}
 *   GET  /v1/models     → {data: [{id}]}
 * An input the scorer refuses (over its context limit) is HTTP 413 — never a
 * low score; a scorer failure is HTTP 500.
 *
 * Run a Decision 2.0 model behind it (isolated env from the benchmark track):
 *   UKTUB_DECISION2_PYTHON=… UKTUB_DECISION2_MODEL=… \
 *     node scripts/system-one-server.ts --port 8099
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface Scorer {
  score(row: { state: string; instructions: string }): Promise<{ p: number | null; refused: boolean; error: string | null }>;
  identity(): Promise<string>;
}

/** Client policy: bounded request body (a passage plus a claim; 8,192 tokens ≈ 25 KB of text). */
const MAX_BODY_BYTES = 1_000_000;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function serveSystemOne(scorer: Scorer, port: number, host = "127.0.0.1"): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/v1/models") {
        if (req.method !== "GET") return send(res, 405, { error: "GET only" });
        return send(res, 200, { object: "list", data: [{ id: await scorer.identity(), object: "model" }] });
      }
      if (path !== "/v1/systemone") return send(res, 404, { error: "not found" });
      if (req.method !== "POST") return send(res, 405, { error: "POST only" });
      const raw = await readBody(req);
      if (raw === null) return send(res, 413, { error: "request body too large" });
      let body: { state?: unknown; questions?: { c?: { type?: unknown; instructions?: unknown } } };
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "body is not JSON" });
      }
      const q = body.questions?.c;
      if (typeof body.state !== "string" || q?.type !== "noul" || typeof q.instructions !== "string") {
        return send(res, 400, { error: "expected {state, questions: {c: {type: 'noul', instructions}}}" });
      }
      const out = await scorer.score({ state: body.state, instructions: q.instructions });
      if (out.refused) return send(res, 413, { error: "input exceeds the model's context limit" });
      if (out.error !== null || out.p === null) return send(res, 500, { error: out.error ?? "no score" });
      return send(res, 200, { answers: { c: { noul: out.p } } });
    } catch (err) {
      return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

// ── entry: Decision 2.0 worker behind the endpoint ──────────────────────────

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { decision2Worker } = await import("./decision2-client.ts");
  const arg = (name: string, fallback: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
  };
  const worker = decision2Worker({ env: process.env as Record<string, string | undefined> });
  const ready = await worker.ready;
  const identity = `${ready.model}@${ready.revision.slice(0, 12)}`;
  const server = await serveSystemOne(
    { identity: async () => identity, score: async (row) => {
        const r = await worker.score(row);
        return { p: r.p, refused: r.refused, error: r.error };
      } },
    Number(arg("port", "8099")),
    arg("host", "127.0.0.1"),
  );
  console.log(`system-one endpoint for ${identity} on http://${arg("host", "127.0.0.1")}:${(server.address() as { port: number }).port}`);
  const stop = (): void => {
    server.close();
    void worker.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
