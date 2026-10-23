/**
 * claim-verification-v2: scoring through a System One HTTP server, here the AUTHOR'S OWN Kev server (the exact prompt rendering of Kev lives
 * in its repository, so a re-implementation would not be faithful). Three small pieces: the question a claim becomes, the engine that posts it
 * (one `noul` question per row to `/v1/systemone`, `answers.c.noul` = P(supported)), and the wait for a server to come up.
 *
 * `criteria` is the claim wording every other candidate of the table is asked (`claim-noul-criteria-v1`, identical to the Decision 2.0, Decision
 * 3.0 and Intern workers); `native` is the claim alone, which is what the product's own System One engine sends to a System One server.
 */
import { spawn, type ChildProcess } from "node:child_process";

import { EngineError, type ClaimEngine } from "../src/core/verify/claim.ts";
import { criteriaQuestion, type SystemOneWording } from "../src/core/verify/wording.ts";

export type Wording = SystemOneWording;

/** The `noul` question for a claim (shared product/benchmark wording; re-exported for existing importers). */
export { criteriaQuestion };

/** Client policy: one row on a long passage must not stall a run for ever (the CPU path of a 0.8B model takes seconds). */
const REQUEST_TIMEOUT_MS = 120_000;
/** Client policy: a hosted endpoint answers 429 with Retry-After when a per-minute budget is used up (docs of decision.vllm-sr.ai); wait it out, bounded, then fail the call rather than read a score that never came. */
const RETRYABLE_STATUS = new Set([429, 503, 504]);
const MAX_ATTEMPTS = 10;
const MAX_SLEEP_MS = 120_000;

export interface HttpEngineOptions {
  /** Sent as the `model` field of every request (a hosted endpoint routes on it); omitted for a server that needs none. */
  model?: string;
  /** Extra headers of every request, e.g. the key of a hosted endpoint (held in the closure, never logged). */
  headers?: Record<string, string>;
  /** Rows in flight at once (default 1: one request after another, as before). */
  concurrency?: number;
  /** Attempts per row on a retryable status (default MAX_ATTEMPTS); then the call fails. */
  maxAttempts?: number;
  /** Per-attempt wall time in milliseconds (feeds the run's latency percentiles). */
  onLatency?: (ms: number) => void;
  /** Wait seam (tests stub it; the run sleeps for real). */
  sleepImpl?: (ms: number) => Promise<void>;
}

export function httpEngine(baseUrl: string, wording: Wording, fetchImpl: typeof fetch = fetch, opts: HttpEngineOptions = {}): ClaimEngine {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/systemone`;
  const headers = { "content-type": "application/json", ...opts.headers };
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? MAX_ATTEMPTS));
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const postOne = async (row: { state: string; instructions: string }): Promise<number> => {
    const body = JSON.stringify({ ...(opts.model === undefined ? {} : { model: opts.model }), state: row.state, questions: { c: criteriaQuestion(row.instructions, wording) } });
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const t = Date.now();
      const res = await fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      opts.onLatency?.(Date.now() - t);
      if (res.ok) {
        const parsed = (await res.json()) as { answers?: Record<string, { noul?: number }> };
        const p = parsed.answers?.c?.noul;
        if (typeof p !== "number") throw new EngineError(`system one server ${url}: response missing answers.c.noul`);
        return p;
      }
      if (attempt < maxAttempts && RETRYABLE_STATUS.has(res.status)) {
        await res.arrayBuffer().catch(() => null); // release the body before waiting
        const retryAfter = Number(res.headers.get("retry-after") ?? "NaN");
        const base = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
        await sleep(Math.min(base + Math.random() * 250, MAX_SLEEP_MS));
        continue;
      }
      throw new EngineError(`system one server ${url}: HTTP ${res.status}`);
    }
  };
  return {
    async run(rows) {
      const out = new Array<number>(rows.length);
      let next = 0;
      const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= rows.length) return;
          out[i] = await postOne(rows[i] as { state: string; instructions: string });
        }
      });
      await Promise.all(workers);
      return out;
    },
  };
}

/** Polls `/v1/models` until it answers 200; rejects with the address after `timeoutMs`. */
export async function waitForServer(baseUrl: string, opts: { timeoutMs: number; intervalMs: number }): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(250, opts.intervalMs)) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`no server answered at ${baseUrl} within ${opts.timeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

/** Starts the server as its own process group (so every child dies with it) and returns a stop function. */
export function startServer(spec: { cwd: string; command: string[]; env: Record<string, string>; logFile?: string }): { child: ChildProcess; stop: () => Promise<void> } {
  const child = spawn(spec.command[0] as string, spec.command.slice(1), { cwd: spec.cwd, env: spec.env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const log: string[] = [];
  const keep = (d: Buffer) => { log.push(d.toString()); if (log.length > 200) log.shift(); };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const stop = async (): Promise<void> => {
    if (child.pid === undefined || child.exitCode !== null) return;
    process.kill(-child.pid, "SIGTERM");
    await new Promise<void>((done) => {
      const t = setTimeout(() => { try { process.kill(-(child.pid as number), "SIGKILL"); } catch { /* gone */ } done(); }, 15_000);
      child.once("exit", () => { clearTimeout(t); done(); });
    });
  };
  return { child, stop };
}
