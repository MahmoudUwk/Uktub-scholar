/**
 * JSONL client for scripts/decision2_decide.py (Decision 2.0 Kai/Eos).
 *
 * The worker speaks the same protocol as julia_decide.py (rows in,
 * {"p_true"} out, "ready" line first). The package adapter (workerEngine in
 * src/core/verify/claim.ts) fails a whole batch on one {"error"} row, which
 * would turn a context refusal into a dead run. This client keeps row-level
 * outcomes: a refusal or error is a result (p = null), never a score, so the
 * benchmark can count it as unchecked. `asEngine()` offers the strict
 * ClaimEngine view (EngineError on any row error) over the same process.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EngineError, type ClaimEngine } from "../src/core/verify/claim.ts";

export interface WorkerReady {
  model: string;
  model_ref?: string;
  revision: string;
  model_sha256: string;
  max_input_tokens: number;
  device: string;
  load_s: number;
  vram_after_load_mib?: number | null;
  versions?: Record<string, string | null>;
  gpu?: string | null;
}
export interface RowResult {
  /** P(true); null when the row was refused or failed (unchecked, never a low score). */
  p: number | null;
  tokens: number | null;
  refused: boolean;
  error: string | null;
}
export interface WorkerStats {
  rows_scored: number;
  tokens_scored: number;
  infer_s: number;
  peak_vram_mib: number | null;
  peak_vram_reserved_mib?: number | null;
}
export interface Row {
  state: string;
  instructions: string;
}
export interface Decision2Worker {
  ready: Promise<WorkerReady>;
  score(row: Row): Promise<RowResult>;
  scoreMany(rows: Row[]): Promise<RowResult[]>;
  count(row: Row): Promise<{ tokens: number; limit: number }>;
  stats(): Promise<WorkerStats>;
  asEngine(): ClaimEngine;
  close(): Promise<void>;
}

const TIMEOUT_MS = 600_000; // client policy: one model load, or one row on a long input

export function decision2Worker(opts: {
  env: Record<string, string | undefined>;
  pythonBin?: string;
  script?: string;
  timeoutMs?: number;
}): Decision2Worker {
  const pythonBin = opts.pythonBin ?? opts.env.UKTUB_DECISION2_PYTHON ?? "python3";
  const script = opts.script ?? join(dirname(fileURLToPath(import.meta.url)), "decision2_decide.py");
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const child: ChildProcessWithoutNullStreams = spawn(pythonBin, [script], {
    env: opts.env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  let isReady = false;
  let dead: EngineError | null = null;
  const waiting: { resolve: (o: Record<string, unknown>) => void; reject: (e: EngineError) => void; timer: NodeJS.Timeout }[] = [];
  let resolveReady!: (r: WorkerReady) => void;
  let rejectReady!: (e: EngineError) => void;
  const ready = new Promise<WorkerReady>((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => undefined); // surfaced to callers that await it; avoid an unhandled rejection otherwise
  const loadTimer = setTimeout(() => die(`decision2 worker exceeded the ${timeoutMs / 1000} s load limit`), timeoutMs);

  function die(message: string): void {
    if (dead) return;
    dead = new EngineError(message);
    clearTimeout(loadTimer);
    if (!isReady) rejectReady(dead);
    for (const w of waiting.splice(0)) { clearTimeout(w.timer); w.reject(dead); }
    child.kill("SIGKILL");
  }

  child.stdout.on("data", (d: Buffer) => {
    buffer += d.toString();
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        if (!isReady) continue; // library noise before the ready line
        die(`decision2 worker emitted a non-JSON line: ${line.slice(-200)}`);
        return;
      }
      if (!isReady) {
        if (parsed.ready === true) {
          isReady = true;
          clearTimeout(loadTimer);
          resolveReady(parsed as unknown as WorkerReady);
        } else if (typeof parsed.error === "string") {
          die(`decision2 worker failed to load: ${parsed.error}`);
          return;
        }
        continue;
      }
      const next = waiting.shift();
      if (!next) { die(`decision2 worker emitted an unexpected line: ${line.slice(-200)}`); return; }
      clearTimeout(next.timer);
      next.resolve(parsed);
    }
  });
  child.stderr.on("data", () => undefined); // diagnostics go to UKTUB_DECISION2_STDERR in the worker
  child.on("error", (e) => die(`decision2 worker not startable (${pythonBin}): ${e.message}`));
  child.on("close", (code) => die(`decision2 worker exited (code ${code}) with ${waiting.length} replies outstanding`));

  // One request at a time keeps replies matched to rows.
  let chain: Promise<unknown> = Promise.resolve();
  function request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const run = async (): Promise<Record<string, unknown>> => {
      await ready;
      if (dead) throw dead;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => die(`decision2 worker did not answer within ${timeoutMs / 1000} s`), timeoutMs);
        waiting.push({ resolve, reject, timer });
        child.stdin.write(JSON.stringify(payload) + "\n");
      });
    };
    const p = chain.then(run, run);
    chain = p.catch(() => undefined);
    return p;
  }

  const toResult = (o: Record<string, unknown>): RowResult => {
    const tokens = typeof o.tokens === "number" ? o.tokens : null;
    if (typeof o.p_true === "number") return { p: o.p_true, tokens, refused: false, error: null };
    return { p: null, tokens, refused: o.refused === true, error: typeof o.error === "string" ? o.error : "no p_true" };
  };

  const worker: Decision2Worker = {
    ready,
    score: async (row) => toResult(await request({ state: row.state, instructions: row.instructions })),
    async scoreMany(rows) {
      const out: RowResult[] = [];
      for (const r of rows) out.push(await worker.score(r));
      return out;
    },
    async count(row) {
      const o = await request({ count: true, state: row.state, instructions: row.instructions });
      if (typeof o.tokens !== "number" || typeof o.limit !== "number") throw new EngineError(`decision2 count failed: ${String(o.error ?? "no tokens")}`);
      return { tokens: o.tokens, limit: o.limit };
    },
    async stats() {
      const o = await request({ stats: true });
      return o.stats as WorkerStats;
    },
    asEngine() {
      return {
        async run(rows) {
          if (rows.length === 0) return [];
          const results = await worker.scoreMany(rows);
          const bad = results.findIndex((r) => r.p === null);
          if (bad !== -1) throw new EngineError(`decision2 engine row ${bad + 1}: ${results[bad].error}`);
          return results.map((r) => r.p as number);
        },
      };
    },
    async close() {
      if (dead) return;
      const closed = new Promise<void>((res) => child.once("close", () => res()));
      child.stdin.write(JSON.stringify({ exit: true }) + "\n");
      const killer = setTimeout(() => child.kill("SIGKILL"), 30_000); // client policy: clean exit window before VRAM is reclaimed by force
      await closed;
      clearTimeout(killer);
    },
  };
  return worker;
}
