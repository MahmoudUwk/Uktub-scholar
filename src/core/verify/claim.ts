/**
 * Engine adapters return P(entailed) for claim/passage pairs. The only decision
 * the package takes from a score is "support at or above the configured bar"
 * (verify/judge.ts); there is no refutation. Benchmark evidence is in docs/benchmarks/.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEosOnnxLock, withManagedEosOnnx } from "./eos-onnx.ts";
import { criteriaQuestion } from "./wording.ts";

/** Owner bar for scientific writing: support needs an engine score of at least 0.99. A raw score, not a calibrated probability: Eos's measured support precision at this bar is 0.97 (docs/benchmarks/). */
export const DEFAULT_MIN_CONFIDENCE = 0.99;
/** Env override for the bar (labelled client policy, not a provider limit). */
export const MIN_CONFIDENCE_ENV = "UKTUB_VERIFY_MIN_CONFIDENCE";

export interface ClaimEngine {
  /** One resident process answers N rows; implementations may batch freely. */
  run(rows: { state: string; instructions: string }[], opts?: RunOptions): Promise<number[]>;
}

/** Optional per-call cancellation. Aborting stops new work promptly; an
 *  in-flight native batch drains (the shared resident worker is never killed). */
export interface RunOptions {
  signal?: AbortSignal;
}

/** The host cancelled the request: not an engine failure, never cached. */
export class CancelledError extends Error {
  constructor(message = "the request was cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

const throwIfCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted === true) throw new CancelledError();
};

/** Per-request transport signal: the existing 120 s timeout plus the caller's
 *  abort, composed with the supported native API (as in source/download.ts).
 *  The composed signal stays live for the whole response read, so a caller
 *  abort stops body parsing too. */
const requestSignal = (signal?: AbortSignal): AbortSignal =>
  signal === undefined
    ? AbortSignal.timeout(120_000) // client policy: hosted cold-start outliers
    : AbortSignal.any([signal, AbortSignal.timeout(120_000)]);

/** Production delay: clears its timer and drops its listener on both wake
 *  and abort, so a cancelled wait owns no timer, promise or listener. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new CancelledError());
  if (signal === undefined) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function minConfidenceFromEnv(env: Record<string, string | undefined>): number {
  const raw = env[MIN_CONFIDENCE_ENV];
  if (raw === undefined || raw === "") return DEFAULT_MIN_CONFIDENCE;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0.5 || v > 1) return DEFAULT_MIN_CONFIDENCE;
  return v;
}

/** Pinned Decision 2.0 Eos checkpoint (reviewed custom code; see docs/benchmarks status report). */
export const EOS_MODEL = "vllm-sr/Decision-2.0-Eos-0.8B";
export const EOS_REVISION = "3594047d69f476f1d01cf84c593e213fc3a4dfe0";

/**
 * Eos engine (vllm-sr/Decision-2.0-Eos-0.8B, the default before 2026-10-15, still selectable): the
 * resident worker `scripts/decision2_decide.py` loads the PINNED checkpoint once and
 * answers rows over JSONL. Python with torch and
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

/**
 * Eos on ONNX Runtime (engine `eos-onnx`): `scripts/decision2_onnx.py` speaks the same protocol with onnxruntime, numpy and tokenizers
 * only (no PyTorch). The 8-bit export agrees with the torch worker 100% at the 0.99 bar (docs/benchmarks/eos-onnx-parity-2026-10-05.md).
 * Model directory and interpreter come from `UKTUB_EOS_ONNX_DIR` / `UKTUB_EOS_ONNX_PYTHON`, else an installed managed copy
 * (`uktub-scholar eos install --yes`); `UKTUB_EOS_ONNX_REVISION` / `_SHA256` override the pin.
 */
export function eosOnnxEngine(opts: {
  env: Record<string, string | undefined>;
  pythonBin?: string;
  spawnImpl?: typeof spawn;
}): ClaimEngine {
  const lock = readEosOnnxLock();
  const env = withManagedEosOnnx(opts.env);
  const dir = env.UKTUB_EOS_ONNX_DIR;
  if (dir === undefined || dir === "") {
    return {
      run: async () => {
        throw new EngineError("eos-onnx engine: no model installed; run `uktub-scholar eos install --yes` (or set UKTUB_EOS_ONNX_DIR to an export directory)");
      },
    } as ClaimEngine;
  }
  const weights = lock.model.files.find((f) => f.path === lock.model.weights);
  return workerEngine({
    ...opts,
    env: {
      ...env,
      UKTUB_DECISION2_ONNX_DIR: dir,
      UKTUB_DECISION2_REVISION: env.UKTUB_EOS_ONNX_REVISION ?? lock.model.revision,
      UKTUB_DECISION2_ONNX_SHA256: env.UKTUB_EOS_ONNX_SHA256 ?? weights?.sha256,
    },
    script: "decision2_onnx.py",
    envName: "UKTUB_EOS_ONNX_PYTHON",
    label: "eos-onnx",
  });
}

/** Shared resident-python JSONL worker: spawn once per run, stream rows, map replies. */
function workerEngine(opts: {
  env: Record<string, string | undefined>;
  pythonBin?: string;
  spawnImpl?: typeof spawn;
  script: string;
  envName: string;
  label: string;
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
  let chain: Promise<unknown> = Promise.resolve();
  let pending: {
    rows: { state: string; instructions: string }[];
    resolve: (pTrues: number[]) => void;
    reject: (e: EngineError) => void;
    answers: number[];
  } | null = null;
  // The current child's 600 s load+batch timer and its process-exit hook; both are released when that child is retired.
  let loadTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseExitHook: (() => void) | null = null;
  const clearLoadTimer = (): void => {
    if (loadTimer !== null) clearTimeout(loadTimer);
    loadTimer = null;
  };
  const retire = (): void => {
    clearLoadTimer();
    releaseExitHook?.();
    releaseExitHook = null;
  };

  const fail = (message: string) => {
    const current = pending;
    pending = null;
    retire();
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
    const onExit = () => current.kill("SIGKILL");
    process.once("exit", onExit);
    releaseExitHook = () => process.removeListener("exit", onExit);
    hold(false);
    // client policy: load + one batch. Only this child's timer is ever stored here, and it acts only while this child is current.
    loadTimer = setTimeout(() => {
      if (child === current) fail(`${opts.label} engine exceeded the 600 s load+batch limit`);
    }, 600_000);
    const finish = () => {
      clearLoadTimer();
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
          clearLoadTimer();
          const done = pending;
          pending = null;
          hold(false);
          done.resolve(done.answers);
        }
      }
    });
    current.stderr!.on("data", (d: Buffer) => {
      /* diagnostics only — torch prints benign warnings mentioning CUDA
         here; real failures surface as row-level {"error": …} lines, close,
         or timeout */
      void d;
    });
    current.on("error", (e) => fail(`${opts.label} engine not startable (${pythonBin}): ${e.message}`));
    // A failed write (EPIPE after the worker died) fails the current request; without a listener it would crash the host.
    current.stdin!.on("error", (e) => {
      if (child === current) fail(`${opts.label} engine stdin failed: ${e.message}`);
    });
    current.on("close", () => {
      if (child !== current) return; // retired child: only its drain promise watches this close
      finish(); // rejects a pending request; releases the timer
      // Whether or not a request was pending, this child is gone: the next run() must respawn.
      retire();
      child = null;
      ready = false;
      buffer = "";
    });
    return current;
  };

  return {
    run(rows, opts) {
      if (rows.length === 0) return Promise.resolve([]);
      // Abort is honored before queued work (at chain-turn time) and before a
      // fresh attempt starts. A batch already written to the child drains: the
      // resident process is shared per configuration and must never be killed
      // to stop one request, so mid-flight native work cannot be preempted —
      // the caller (judge) discards drained scores and starts nothing new.
      if (opts?.signal?.aborted === true) return Promise.reject(new CancelledError());
      const attempt = (): Promise<number[]> => {
        return new Promise((resolveRun, rejectRun) => {
          if (opts?.signal?.aborted === true) {
            rejectRun(new CancelledError());
            return;
          }
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

/** Shared TypeSafe System One HTTP client: one `noul` question per request in the
 *  benchmarked Decision 2.0 criteria wording (`wording.ts`, shared with the
 *  benchmark client so the two can never diverge), `answers.c.noul` = P(true). Stateless, worker-safe. An
 *  optional API key is sent only as an `Authorization: Bearer` header to an HTTPS origin (a key for a plain-HTTP URL is a
 *  construction-time EngineError, never sent and never logged); an optional model id rides in the request body.
 *  HTTP 429 uses the shared backoff below (Retry-After / rate-limit reset
 *  headers honored, else bounded exponential backoff); other statuses are
 *  never retried. */
export function systemoneEndpointEngine(opts: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  url: string;
  label: string;
  /** Bearer key for a hosted endpoint (held in the closure, never logged, never in an error). HTTPS only. */
  apiKey?: string;
  /** Model id a hosted endpoint routes on (sent as the `model` field). */
  model?: string;
  /** Test seam: wait between 429 retries (production: setTimeout). */
  sleepImpl?: (ms: number) => Promise<void>;
}): ClaimEngine {
  const doFetch = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey !== undefined && opts.apiKey !== "" ? opts.apiKey : undefined;
  const model = opts.model !== undefined && opts.model !== "" ? opts.model : undefined;
  if (apiKey !== undefined) {
    let https = false;
    try {
      https = new URL(opts.url).protocol === "https:";
    } catch {
      https = false;
    }
    // Credentials are scoped to their origin: a key travels only over HTTPS to the configured endpoint.
    if (!https) throw new EngineError(`${opts.label} engine: refusing to use an API key with a non-HTTPS URL ${opts.url}`);
  }
  const headers = { "content-type": "application/json", ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }) };
  const checkModelEcho = (parsed: { model?: unknown }): void => {
    // The server echoes the answering model id in every response: when a model is configured, an echo naming
    // another model means the weights behind the id changed, so judgments must not be cached under this identity.
    const echoed = parsed.model;
    if (model !== undefined && echoed !== undefined && echoed !== model) {
      throw new EngineError(`${opts.label} engine: the server reports model ${JSON.stringify(String(echoed)).slice(0, 120)}, not the configured ${model} — refusing judgments under a wrong identity`);
    }
  };
  const postQuestion = async (state: string, instructions: string, signal?: AbortSignal): Promise<number> => {
    let res: Response;
    try {
      res = await fetchWith429Retry(
        () =>
          doFetch(opts.url, {
            method: "POST",
            headers,
            body: JSON.stringify({ ...(model === undefined ? {} : { model }), state, questions: { c: criteriaQuestion(instructions, "criteria") } }),
            signal: requestSignal(signal),
          }),
        { label: `${opts.label} engine`, sleepImpl: opts.sleepImpl, signal },
      );
    } catch (e: unknown) {
      if (e instanceof RateLimitedError) throw new EngineError(`${e.message} — retry later, or use the local engine`);
      if (e instanceof CancelledError || signal?.aborted === true) throw new CancelledError();
      throw new EngineError(`${opts.label} engine unreachable at ${opts.url}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // The composed signal stays live through the body read, so a caller abort
    // while parsing normalizes to CancelledError instead of a transport error.
    try {
      if (res.status === 401) {
        await res.body?.cancel().catch(() => undefined);
        throw new EngineError(`${opts.label} engine HTTP 401 at ${opts.url}: unauthorized — set UKTUB_VERIFY_API_KEY (the key itself is never logged)`);
      }
      if (!res.ok) throw new EngineError(`${opts.label} engine HTTP ${res.status}: ${(await res.text()).slice(-300)}`);
      let parsed: { answers?: Record<string, { noul?: number }>; model?: unknown };
      try {
        parsed = JSON.parse(await res.text()) as typeof parsed;
      } catch {
        // A non-JSON or cut-off body is never quoted: the message is static, and an abort still normalizes below.
        throw new EngineError(`${opts.label} engine returned an unreadable response`);
      }
      checkModelEcho(parsed);
      const p = parsed.answers?.c?.noul;
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
        throw new EngineError(`${opts.label} engine: response missing a valid answers.c.noul`);
      }
      return p;
    } catch (e: unknown) {
      if (signal?.aborted === true) throw new CancelledError();
      throw e;
    }
  };
  return {
    async run(rows, opts) {
      if (rows.length === 0) return [];
      throwIfCancelled(opts?.signal);
      const pTrues: number[] = [];
      for (const row of rows) {
        throwIfCancelled(opts?.signal);
        pTrues.push(await postQuestion(row.state, row.instructions, opts?.signal));
      }
      return pTrues;
    },
  };
}
/**
 * Shared HTTP 429 backoff for the System One engines, used by both the hosted
 * endpoint engine and the OpenRouter decisions engine (the second consumer).
 * `Retry-After` / rate-limit reset headers are honored when present, else
 * bounded exponential backoff; statuses other than 429 pass through
 * untouched (never retried). Giving up throws RateLimitedError, which names
 * HTTP 429 and the total wait — engines wrap it in an EngineError with their
 * own advice. The key never appears: only timings and statuses enter errors.
 */
/** Client policy: at most 3 retries on HTTP 429 (4 attempts total). */
export const RETRY_429_MAX_RETRIES = 3;
/** Client policy: the 429 backoff starts at 1 s and doubles per retry. */
export const RETRY_429_BASE_DELAY_MS = 1_000;
/** Client policy: one 429 wait never exceeds 70 s (a rate-limit window). */
export const RETRY_429_MAX_SINGLE_WAIT_MS = 70_000;
/** Client policy: 429 backoff never stalls one engine call past ~2 min of waiting. */
export const RETRY_429_MAX_TOTAL_WAIT_MS = 120_000;
/** Client-policy etiquette: a header-named reset is padded so the retry lands inside the new window. */
export const RETRY_429_RESET_SLACK_MS = 250;

/** A 429 retry loop that gave up: carries how long it waited. */
export class RateLimitedError extends Error {
  readonly waitedMs: number;
  constructor(label: string, waitedMs: number, detail: string) {
    super(`${label}: HTTP 429 rate limited (${detail}); gave up after waiting ${(waitedMs / 1000).toFixed(1)} s`);
    this.name = "RateLimitedError";
    this.waitedMs = waitedMs;
  }
}

export interface Fetch429RetryOptions {
  label: string;
  maxRetries?: number;
  baseDelayMs?: number;
  maxSingleWaitMs?: number;
  maxTotalWaitMs?: number;
  /** A header-named reset this far out fails fast (an exhausted allowance, not a window). */
  farResetAfterMs?: number;
  farResetDetail?: (resetAt: string, source: string) => string;
  /** Test seam: may accept an optional abort signal; legacy one-arg test functions stay assignable. */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  nowImpl?: () => number;
  /** Abort stops the wait and starts no further attempts. */
  signal?: AbortSignal;
}

/** Wait named by `Retry-After` (seconds or an HTTP date) or `x-ratelimit-reset`
 *  (epoch millis, or epoch seconds below 1e12), in ms from `now`; null when absent. */
function headerResetWaitMs(res: Response, now: number): number | null {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter !== null && retryAfter !== "") {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
    return null;
  }
  const reset = res.headers.get("x-ratelimit-reset");
  if (reset !== null && reset !== "") {
    const v = Number(reset);
    if (Number.isFinite(v) && v > 0) return Math.max(0, (v < 1e12 ? v * 1000 : v) - now);
  }
  return null;
}

export async function fetchWith429Retry(send: () => Promise<Response>, opts: Fetch429RetryOptions): Promise<Response> {
  const maxRetries = opts.maxRetries ?? RETRY_429_MAX_RETRIES;
  const base = opts.baseDelayMs ?? RETRY_429_BASE_DELAY_MS;
  const singleCap = opts.maxSingleWaitMs ?? RETRY_429_MAX_SINGLE_WAIT_MS;
  const totalCap = opts.maxTotalWaitMs ?? RETRY_429_MAX_TOTAL_WAIT_MS;
  const sleep = opts.sleepImpl ?? ((ms: number, signal?: AbortSignal) => abortableDelay(ms, signal));
  const now = opts.nowImpl ?? Date.now;
  let waitedMs = 0;
  for (let attempt = 0; ; attempt++) {
    throwIfCancelled(opts.signal);
    const res = await send();
    if (res.status !== 429) return res;
    await res.body?.cancel().catch(() => undefined); // the 429 body is discarded before any wait or throw
    const at = now();
    const headerWait = headerResetWaitMs(res, at);
    if (headerWait !== null && opts.farResetAfterMs !== undefined && headerWait > opts.farResetAfterMs) {
      const source = res.headers.get("x-ratelimit-limit") ?? "the rate limit";
      const until = new Date(at + headerWait).toISOString();
      throw new RateLimitedError(opts.label, waitedMs, opts.farResetDetail?.(until, source) ?? `rate limited until ${until} (${source})`);
    }
    const wait = Math.min(headerWait === null ? base * 2 ** attempt : headerWait + RETRY_429_RESET_SLACK_MS, singleCap);
    if (attempt >= maxRetries || waitedMs + wait > totalCap) {
      throw new RateLimitedError(opts.label, waitedMs, `still rate limited after ${attempt} ${attempt === 1 ? "retry" : "retries"}`);
    }
    await sleep(wait, opts.signal);
    waitedMs += wait;
  }
}

/** Shared OpenRouter client behavior: per-call throttle (labelled client
 * policy — the free tier allows 20 req/min). Free-tier
 * models default to a 3.5 s spacing; explicit env wins. */
function openrouterThrottleMs(env: Record<string, string | undefined>, model: string): number {
  const raw = env.UKTUB_OPENROUTER_MIN_INTERVAL_MS;
  if (raw !== undefined && raw !== "") {
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 && v <= 60_000 ? v : 0;
  }
  return model.endsWith(":free") ? 3_500 : 0; // client policy: openrouter free tier is 20 req/min
}

/**
 * OpenRouter decisions-endpoint adapter (`/api/alpha/decisions`): the
 * TypeSafe `/v1/systemone` wire shape served by hosted decision models
 * (e.g. inception/mercury-decide, respan/span-01) — one `noul` question per
 * row in the benchmarked criteria wording, `answers.c.noul` = P(true). Key: `OPENROUTER_API_KEY`; model:
 * `UKTUB_OPENROUTER_MODEL`. Stateless client, worker-safe.
 */
export function openrouterDecisionsEngine(opts: {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  model: string;
  /** Test seam: wait between 429 retries; may accept an optional abort signal. */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): ClaimEngine {
  const key = opts.env.OPENROUTER_API_KEY;
  if (!key) throw new EngineError("openrouter decisions engine: OPENROUTER_API_KEY is not set");
  const doFetch = opts.fetchImpl ?? fetch;
  const throttleMs = openrouterThrottleMs(opts.env, opts.model);
  const lastCallAt = { value: 0 };
  return {
    async run(rows, ro) {
      if (rows.length === 0) return [];
      throwIfCancelled(ro?.signal);
      const pTrues: number[] = [];
      for (const row of rows) {
        throwIfCancelled(ro?.signal);
        const res = await fetchWith429Retry(
          async () => {
            const wait = lastCallAt.value + throttleMs - Date.now();
            if (wait > 0) await abortableDelay(wait, ro?.signal);
            throwIfCancelled(ro?.signal);
            lastCallAt.value = Date.now();
            return doFetch("https://openrouter.ai/api/alpha/decisions", {
              method: "POST",
              headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
              body: JSON.stringify({ model: opts.model, state: row.state, questions: { c: criteriaQuestion(row.instructions, "criteria") } }),
              signal: requestSignal(ro?.signal),
            });
          },
          {
            label: `openrouter decisions (${opts.model})`,
            // A reset far in the future is the exhausted DAILY free allowance, not a window: fail fast.
            farResetAfterMs: 90_000, // client policy: beyond one window is the daily allowance
            farResetDetail: (until, source) =>
              `rate limited until ${until} (${source}); switch model (e.g. a paid or non-free id via UKTUB_OPENROUTER_MODEL) or wait for the daily reset`,
            sleepImpl: opts.sleepImpl,
            signal: ro?.signal,
          },
        ).catch((e: unknown) => {
          if (e instanceof RateLimitedError) throw new EngineError(e.message);
          if (e instanceof CancelledError || ro?.signal?.aborted === true) throw new CancelledError();
          throw new EngineError(`openrouter decisions (${opts.model}): ${e instanceof Error ? e.message : String(e)}`);
        });
        // A caller abort while reading the body normalizes to CancelledError.
        try {
          if (!res.ok) throw new EngineError(`openrouter decisions (${opts.model}): HTTP ${res.status}: ${(await res.text()).slice(-300)}`);
          const parsed = (await res.json()) as { answers?: Record<string, { noul?: number }> };
          const p = parsed.answers?.c?.noul;
          if (typeof p !== "number") throw new EngineError(`openrouter decisions (${opts.model}): response missing answers.c.noul`);
          pTrues.push(p);
        } catch (e: unknown) {
          if (ro?.signal?.aborted === true) throw new CancelledError();
          throw e;
        }
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
