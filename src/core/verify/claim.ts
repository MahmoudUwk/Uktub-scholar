/**
 * Engine adapters return P(entailed) for claim/passage pairs. The only decision
 * the package takes from a score is "support at or above the configured bar"
 * (verify/judge.ts); there is no refutation. Benchmark evidence is in docs/benchmarks/.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Owner bar for scientific writing: support needs ≥99% engine confidence. */
export const DEFAULT_MIN_CONFIDENCE = 0.99;
/** Env override for the bar (labelled client policy, not a provider limit). */
export const MIN_CONFIDENCE_ENV = "UKTUB_VERIFY_MIN_CONFIDENCE";

export interface ClaimEngine {
  /** One resident process answers N rows; implementations may batch freely. */
  run(rows: { state: string; instructions: string }[]): Promise<number[]>;
}

export function minConfidenceFromEnv(env: Record<string, string | undefined>): number {
  const raw = env[MIN_CONFIDENCE_ENV];
  if (raw === undefined || raw === "") return DEFAULT_MIN_CONFIDENCE;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0.5 || v > 1) return DEFAULT_MIN_CONFIDENCE;
  return v;
}

/**
 * Julia-1 engine adapter: spawns `python3 scripts/julia_decide.py` (resident:
 * the 550 MB checkpoint loads once), pipes rows as JSONL, reads one
 * `{"p_true": …}` per row. Model: `UKTUB_JULIA_MODEL` (path or HF id).
 */
export function juliaEngine(opts: {
  env: Record<string, string | undefined>;
  pythonBin?: string;
  spawnImpl?: typeof spawn;
}): ClaimEngine {
  return workerEngine({ ...opts, script: "julia_decide.py", envName: "UKTUB_JULIA_PYTHON", label: "julia" });
}

/**
 * Laya engine adapter: resident Router-mode worker (`scripts/laya_decide.py`)
 * — the model card's recommended Router usage, pinned to
 * `model="multilingual"` + `max_len=8192` (the card's long-document
 * prescription; the English checkpoint reads only 512 tokens). Same JSONL
 * protocol as the julia worker. Python: `UKTUB_LAYA_PYTHON`.
 */
export function layaEngine(opts: {
  env: Record<string, string | undefined>;
  pythonBin?: string;
  spawnImpl?: typeof spawn;
}): ClaimEngine {
  return workerEngine({ ...opts, script: "laya_decide.py", envName: "UKTUB_LAYA_PYTHON", label: "laya", respawnEveryRows: 60 });
}

/** Pinned Decision 2.0 Eos checkpoint (reviewed custom code; see docs/benchmarks status report). */
export const EOS_MODEL = "vllm-sr/Decision-2.0-Eos-0.8B";
export const EOS_REVISION = "3594047d69f476f1d01cf84c593e213fc3a4dfe0";

/**
 * Eos engine (vllm-sr/Decision-2.0-Eos-0.8B, owner-selected default 2026-10-04): the
 * resident worker `scripts/decision2_decide.py` loads the PINNED checkpoint once and
 * answers rows over JSONL (same protocol as the julia worker). Python with torch and
 * transformers>=5.17 is the user's: `UKTUB_EOS_PYTHON` (default `python3`);
 * `UKTUB_EOS_MODEL` (local snapshot dir or HF id) and `UKTUB_EOS_REVISION` override the pin.
 * The worker refuses inputs over the model's 16,384-token limit instead of truncating;
 * that surfaces as an engine failure for the batch (the default 8,192-token windows leave
 * ample headroom).
 */
export function eosEngine(opts: {
  env: Record<string, string | undefined>;
  pythonBin?: string;
  spawnImpl?: typeof spawn;
}): ClaimEngine {
  const env = {
    ...opts.env,
    UKTUB_DECISION2_MODEL: opts.env.UKTUB_EOS_MODEL ?? EOS_MODEL,
    UKTUB_DECISION2_REVISION: opts.env.UKTUB_EOS_REVISION ?? EOS_REVISION,
  };
  return workerEngine({ ...opts, env, script: "decision2_decide.py", envName: "UKTUB_EOS_PYTHON", label: "eos" });
}

/** Shared resident-python JSONL worker: spawn once per run, stream rows, map replies. */
function workerEngine(opts: {
  env: Record<string, string | undefined>;
  pythonBin?: string;
  spawnImpl?: typeof spawn;
  script: string;
  envName: string;
  label: string;
  /** Recycle the resident child after N answered rows: long-context GPU
   * runs accumulate allocator fragmentation that eventually aborts the
   * process natively; a fresh child resets the CUDA context. */
  respawnEveryRows?: number;
}): ClaimEngine {
  const pythonBin = opts.pythonBin ?? opts.env[opts.envName] ?? "python3";
  const script = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts", opts.script);
  const doSpawn = opts.spawnImpl ?? spawn;
  // One resident child across run() calls: model load is paid once. run()
  // calls are serialized so rows and replies never interleave. A crashed
  // child marks the session dead; the next run() respawns it.
  let child: ChildProcessWithoutNullStreams | null = null;
  let buffer = "";
  let ready = false;
  let answeredSinceSpawn = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let draining: Promise<void> | null = null; // retired child exiting; its CUDA context must be gone before the next spawn
  let pending: {
    rows: { state: string; instructions: string }[];
    resolve: (pTrues: number[]) => void;
    reject: (e: EngineError) => void;
    answers: number[];
  } | null = null;

  const fail = (message: string) => {
    const current = pending;
    pending = null;
    child?.kill("SIGKILL");
    child = null;
    ready = false;
    buffer = "";
    current?.reject(new EngineError(message));
  };

  /** Keep the process alive only while a request is outstanding. */
  const hold = (active: boolean): void => {
    const c = child;
    if (c === null) return;
    const handles: unknown[] = [c, c.stdin, c.stdout, c.stderr];
    for (const h of handles) {
      const x = h as { ref?: () => void; unref?: () => void };
      (active ? x.ref : x.unref)?.call(x);
    }
  };

  const spawnWorker = () => {
    ready = false;
    buffer = "";
    child = doSpawn(pythonBin, [script], {
      env: { ...opts.env, PYTORCH_CUDA_ALLOC_CONF: opts.env.PYTORCH_CUDA_ALLOC_CONF ?? "expandable_segments:True" } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const current = child;
    // A resident worker must never keep the host process alive while IDLE, and must not outlive it:
    // its handles are unref'd (kill on exit); `hold(true)` re-refs them for as long as a request is in flight.
    process.once("exit", () => current.kill("SIGKILL"));
    hold(false);
    const timer = setTimeout(() => fail(`${opts.label} engine exceeded the 600 s load+batch limit`), 600_000); // client policy: load + one batch
    const finish = () => {
      clearTimeout(timer);
      if (!pending) return;
      if (!ready) {
        const lines = buffer.split("\n").filter((l) => l.trim().length > 0);
        const errText = lines.find((l) => l.includes("error")) ?? lines[0] ?? "no output";
        fail(`${opts.label} engine failed to load: ${errText.slice(-400)}`);
        return;
      }
      fail(`${opts.label} engine exited before answering ${pending.rows.length - pending.answers.length} remaining rows`);
    };
    current.stdout!.on("data", (d: Buffer) => {
      if (child !== current) return; // retired child's stragglers are ignored
      buffer += d.toString();
      if (!ready) {
        const readyIdx = buffer.indexOf('"ready"');
        if (readyIdx === -1) return;
        const lineEnd = buffer.indexOf("\n", readyIdx);
        if (lineEnd === -1) return; // wait for the ready line's newline
        ready = true;
        buffer = buffer.slice(lineEnd + 1);
      }
      let idx: number;
      while (pending && (idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let parsed: { p_true?: number; error?: string };
        try {
          parsed = JSON.parse(line) as { p_true?: number; error?: string };
        } catch {
          fail(`${opts.label} engine emitted a non-JSON line: ${line.slice(-200)}`);
          return;
        }
        if (typeof parsed.p_true !== "number") {
          fail(`${opts.label} engine row ${pending.answers.length + 1}: ${parsed.error ?? "no p_true"}`);
          return;
        }
        pending.answers.push(parsed.p_true);
        if (pending.answers.length === pending.rows.length) {
          clearTimeout(timer);
          const done = pending;
          pending = null;
          hold(false);
          done.resolve(done.answers);
          if (opts.respawnEveryRows && ++answeredSinceSpawn >= opts.respawnEveryRows) {
            // Clean retirement: sentinel lets the worker exit between rows —
            // killing mid-forward-pass orphans CUDA state and races pipes.
            answeredSinceSpawn = 0;
            ready = false;
            const retiring = child;
            child = null;
            draining = new Promise<void>((res) => retiring?.once("close", () => res()));
            retiring?.stdin!.write(JSON.stringify({ exit: true }) + "\n");
          }
        }
      }
    });
    current.stderr!.on("data", (d: Buffer) => {
      /* diagnostics only — laya/torch print benign warnings mentioning CUDA
         here; real failures surface as row-level {"error": …} lines, close,
         or timeout */
      void d;
    });
    current.on("error", (e) => fail(`${opts.label} engine not startable (${pythonBin}): ${e.message}`));
    current.on("close", () => {
      if (child !== current) return; // retired child: only its drain promise watches this close
      finish();
    });
    return current;
  };

  return {
    run(rows) {
      if (rows.length === 0) return Promise.resolve([]);
      const attempt = async (): Promise<number[]> => {
        if (draining) {
          const wait = draining;
          draining = null;
          await wait; // retiring worker released its CUDA context — safe to spawn now
        }
        return new Promise((resolveRun, rejectRun) => {
          pending = { rows, resolve: resolveRun, reject: rejectRun, answers: [] };
          child ??= spawnWorker();
          hold(true);
          // The child answers one line per row; a respawn on the previous
          // failure path may still be loading — replies are matched by count.
          for (const row of rows) child.stdin!.write(JSON.stringify(row) + "\n");
        });
      };
      return (chain = chain.then(attempt, attempt));
    },
  };
}

/**
 * K2-Type engine adapter (jev decision server, resident on one CUDA GPU):
 * POSTs one `noul` question per row to TypeSafe `/v1/systemone` —
 * `{"state": <passage>, "questions": {"c": {"type": "noul", "instructions": <claim>}}}`
 * → `answers.c.noul` = P(true). The server is the owner of the fit limit:
 * inputs over 8192 tokens are refused with HTTP 413 (documented provider
 * limit) — surfaced as an EngineError, never truncated. URL:
 * `UKTUB_K2_URL` (default http://127.0.0.1:8000). Stateless client; a
 * worker-safe factory returns independent instances sharing the one server.
 */
export function k2Engine(opts: { env: Record<string, string | undefined>; fetchImpl?: typeof fetch }): ClaimEngine {
  return systemoneEndpointEngine({
    env: opts.env,
    fetchImpl: opts.fetchImpl,
    url: (opts.env.UKTUB_K2_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "") + "/v1/systemone",
    label: "k2",
  });
}

/** bev-decider (avbiswas/bev-decider-0.4B): System One server, 2,048-token state limit (provider limit — pair with the 2048-token chunk config). URL: `UKTUB_BEV_URL`. */
export function bevEngine(opts: { env: Record<string, string | undefined>; fetchImpl?: typeof fetch }): ClaimEngine {
  return systemoneEndpointEngine({
    env: opts.env,
    fetchImpl: opts.fetchImpl,
    url: (opts.env.UKTUB_BEV_URL ?? "http://127.0.0.1:8009").replace(/\/+$/, "") + "/v1/systemone",
    label: "bev",
  });
}

/** Lumma-fev (FrontiersMind/lumma-fev-0.6b): System One server, 8,192-token states. URL: `UKTUB_LUMMA_URL`. */
export function lummaEngine(opts: { env: Record<string, string | undefined>; fetchImpl?: typeof fetch }): ClaimEngine {
  return systemoneEndpointEngine({
    env: opts.env,
    fetchImpl: opts.fetchImpl,
    url: (opts.env.UKTUB_LUMMA_URL ?? "http://127.0.0.1:8010").replace(/\/+$/, "") + "/v1/systemone",
    label: "lumma",
  });
}

/** Shared TypeSafe System One HTTP client: one `noul` row per request, `answers.c.noul` = P(true). Stateless, worker-safe. */
export function systemoneEndpointEngine(opts: {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  url: string;
  label: string;
}): ClaimEngine {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async run(rows) {
      if (rows.length === 0) return [];
      const pTrues: number[] = [];
      for (const row of rows) {
        const res = await doFetch(opts.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: row.state, questions: { c: { type: "noul", instructions: row.instructions } } }),
          signal: AbortSignal.timeout(120_000), // client policy: local cold-start outliers
        }).catch((e: unknown) => {
          throw new EngineError(`${opts.label} engine unreachable at ${opts.url}: ${e instanceof Error ? e.message : String(e)}`);
        });
        if (!res.ok) throw new EngineError(`${opts.label} engine HTTP ${res.status}: ${(await res.text()).slice(-300)}`);
        const parsed = (await res.json()) as { answers?: Record<string, { noul?: number }> };
        const p = parsed.answers?.c?.noul;
        if (typeof p !== "number") throw new EngineError(`${opts.label} engine: response missing answers.c.noul`);
        pTrues.push(p);
      }
      return pTrues;
    },
  };
}

/** Shared OpenRouter client behavior: per-call throttle (labelled client
 * policy — the free tier allows 20 req/min) and up to three retries on 429,
 * sleeping until the rate-limit window resets (bounded at 70 s). Free-tier
 * models default to a 3.5 s spacing; explicit env wins. */
function openrouterThrottleMs(env: Record<string, string | undefined>, model: string): number {
  const raw = env.UKTUB_OPENROUTER_MIN_INTERVAL_MS;
  if (raw !== undefined && raw !== "") {
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 && v <= 60_000 ? v : 0;
  }
  return model.endsWith(":free") ? 3_500 : 0; // client policy: openrouter free tier is 20 req/min
}

async function openrouterFetchWithRetry(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  throttleMs: number,
  lastCallAt: { value: number },
): Promise<Response> {
  const send = async (): Promise<Response> => {
    const wait = lastCallAt.value + throttleMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt.value = Date.now();
    return doFetch(url, init);
  };
  let res = await send().catch((e: unknown) => {
    throw new Error(`unreachable: ${e instanceof Error ? e.message : String(e)}`);
  });
  // Free tiers use fixed per-minute windows: retry 429s up to three times,
  // sleeping to the window reset (bounded). A reset far in the future (e.g.
  // the exhausted DAILY free allowance) fails fast — sleeping would only
  // burn into the caller's timeout.
  for (let attempt = 0; res.status === 429 && attempt < 3; attempt++) {
    const resetHeader = res.headers.get("x-ratelimit-reset");
    const resetAt = resetHeader ? Number(resetHeader) : 0;
    const resetInMs = resetAt - Date.now();
    if (resetInMs > 90_000) {
      const source = res.headers.get("x-ratelimit-limit") ?? "openrouter free tier";
      throw new Error(
        `HTTP 429 rate limited until ${new Date(resetAt).toISOString()} (${source}); ` +
        "switch model (e.g. a paid or non-free id via UKTUB_OPENROUTER_MODEL) or wait for the daily reset",
      );
    }
    const sleepMs = Math.min(Math.max(resetInMs + 250, 1_000), 70_000); // client policy: bounded retry window
    await new Promise((r) => setTimeout(r, sleepMs));
    res = await send().catch((e: unknown) => {
      throw new Error(`unreachable: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(-300)}`);
  return res;
}

/**
 * OpenRouter decisions-endpoint adapter (`/api/alpha/decisions`): the
 * TypeSafe `/v1/systemone` wire shape served by hosted decision models
 * (e.g. inception/mercury-decide, respan/span-01) — one `noul` question per
 * row, `answers.c.noul` = P(true). Key: `OPENROUTER_API_KEY`; model:
 * `UKTUB_OPENROUTER_MODEL`. Stateless client, worker-safe.
 */
export function openrouterDecisionsEngine(opts: {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  model: string;
}): ClaimEngine {
  const key = opts.env.OPENROUTER_API_KEY;
  if (!key) throw new EngineError("openrouter decisions engine: OPENROUTER_API_KEY is not set");
  const doFetch = opts.fetchImpl ?? fetch;
  const throttleMs = openrouterThrottleMs(opts.env, opts.model);
  const lastCallAt = { value: 0 };
  return {
    async run(rows) {
      if (rows.length === 0) return [];
      const pTrues: number[] = [];
      for (const row of rows) {
        const res = await openrouterFetchWithRetry(
          doFetch,
          "https://openrouter.ai/api/alpha/decisions",
          {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({ model: opts.model, state: row.state, questions: { c: { type: "noul", instructions: row.instructions } } }),
            signal: AbortSignal.timeout(120_000), // client policy: hosted cold-start outliers
          },
          throttleMs,
          lastCallAt,
        ).catch((e: unknown) => {
          throw new EngineError(`openrouter decisions (${opts.model}): ${e instanceof Error ? e.message : String(e)}`);
        });
        const parsed = (await res.json()) as { answers?: Record<string, { noul?: number }> };
        const p = parsed.answers?.c?.noul;
        if (typeof p !== "number") throw new EngineError(`openrouter decisions (${opts.model}): response missing answers.c.noul`);
        pTrues.push(p);
      }
      return pTrues;
    },
  };
}

/**
 * OpenRouter chat adapter for text models that answer entailment yes/no
 * (e.g. typesafe/jev-router — the router fronts the jev decision family but
 * exposes no probabilities). Scores are binary: yes → 1, no → 0. AUC and
 * verdicts remain well-defined; treat confidence as a hard label, not a
 * calibrated probability. Key: `OPENROUTER_API_KEY`; model:
 * `UKTUB_OPENROUTER_CHAT_MODEL`.
 */
export function openrouterChatEngine(opts: {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  model: string;
}): ClaimEngine {
  const key = opts.env.OPENROUTER_API_KEY;
  if (!key) throw new EngineError("openrouter chat engine: OPENROUTER_API_KEY is not set");
  const doFetch = opts.fetchImpl ?? fetch;
  const throttleMs = openrouterThrottleMs(opts.env, opts.model);
  const lastCallAt = { value: 0 };
  return {
    async run(rows) {
      if (rows.length === 0) return [];
      const pTrues: number[] = [];
      for (const row of rows) {
        const res = await openrouterFetchWithRetry(
          doFetch,
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({
              model: opts.model,
              messages: [
                {
                  role: "user",
                  content:
                    `Passage: ${row.state}\n\nClaim: ${row.instructions}\n\n` +
                    "Does the passage state or directly entail the claim? Answer with exactly one word: yes or no.",
                },
              ],
              max_tokens: 2000, // the router's reasoning backend emits chain-of-thought before the one-word answer
              temperature: 0,
            }),
            signal: AbortSignal.timeout(120_000),
          },
          throttleMs,
          lastCallAt,
        ).catch((e: unknown) => {
          throw new EngineError(`openrouter chat (${opts.model}): ${e instanceof Error ? e.message : String(e)}`);
        });
        const parsed = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = (parsed.choices?.[0]?.message?.content ?? "").trim().toLowerCase();
        if (content.startsWith("yes")) pTrues.push(1);
        else if (content.startsWith("no")) pTrues.push(0);
        else throw new EngineError(`openrouter chat (${opts.model}): unparseable answer ${JSON.stringify(content.slice(0, 60))}`);
      }
      return pTrues;
    },
  };
}

/** Typed engine failure (R7-shaped): callers map it to a refusal result. */
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}
