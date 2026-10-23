/**
 * Scholarly provider layer — the HTTP plumbing every provider client shares.
 *
 * Ported from `UktubAI_Agentic/apps/control-api/src/tools/{fetch-retry,http,
 * provider-validators,request-timeout-config}.ts` and consolidated: this
 * package has no second consumer for the split, so the retry policy, the JSON
 * guard, the limit clamp, the header-widening trick, and the structural JSON
 * readers each keep exactly one owner — here.
 *
 * The `entities` dependency is not available (zero-dependency package), so
 * `plainText` decodes the entity set providers actually ship with a minimal
 * inline decoder (named core set + numeric references). Providers never send
 * anything beyond HTML's named core set in the fields this layer reads; an
 * unknown entity passes through verbatim rather than guessed at.
 */

import { randomInt } from "node:crypto";
import {
  ProviderRequestError,
  type FetchLike,
  type FetchResult,
  type ProviderConfig,
  type ProviderName,
} from "./types.ts";
import { normalizeRegistryDoi } from "../doi.ts";
import { decodeHtmlEntities } from "../bibrender.ts";

/** Per-attempt fetch timeout (product default, `request-timeout-config.ts`).
 *  Client policy, not a provider rule. */
export const DEFAULT_SCHOLARLY_PROVIDER_TIMEOUT_MS = 15_000;

// ── fetch retry policy (ported verbatim) ────────────────────────────────────

const MAX_RETRIES = 2;

/** Exponential backoff with jitter, capped. Ported constant, single owner. */
function backoffMs(attempt: number): number {
  const capped = Math.min(2 ** attempt * 500, 5000);
  return capped + randomInt(250);
}

/**
 * Fetch with the ported retry policy: max 2 retries on 429/5xx/network only,
 * per-attempt timeout, Retry-After (delta-seconds, capped at 5s) honored.
 * Aborts via AbortController so a hung provider cannot stall the loop forever.
 * A caller `signal` cancels the current attempt and any backoff wait, is never
 * retried, and rejects with the caller's abort reason.
 */
export async function fetchWithRetry(
  fetchFn: FetchLike,
  url: string,
  opts: {
    timeoutMs?: number;
    maxRetries?: number;
    sleep?: (ms: number) => Promise<void>;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SCHOLARLY_PROVIDER_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const callerSignal = opts.signal;
  let attempt = 0;
  for (;;) {
    callerSignal?.throwIfAborted();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const attemptSignal = callerSignal === undefined ? ctrl.signal : AbortSignal.any([ctrl.signal, callerSignal]);
    try {
      const res = await fetchFn(url, {
        headers: opts.headers,
        signal: attemptSignal,
      });
      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!retryable || attempt >= maxRetries) {
        return { status: res.status, body: await res.text() };
      }
      // Release the rejected response's socket before backing off — under
      // shared-pool 429s the abandoned undici stream would otherwise stay
      // open until GC.
      await res.body?.cancel();
      const raw = res.headers.get("retry-after");
      const secs = raw !== null && /^[0-9]+$/.test(raw.trim()) ? parseInt(raw.trim(), 10) : NaN;
      const wait = Number.isNaN(secs) ? backoffMs(attempt) : Math.min(secs * 1000, 5000);
      await retryWait(wait, opts.sleep, callerSignal);
    } catch (err) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (attempt >= maxRetries) throw err;
      await retryWait(backoffMs(attempt), opts.sleep, callerSignal);
    } finally {
      clearTimeout(timer);
    }
    attempt += 1;
  }
}

// ── structural JSON readers (ported verbatim) ───────────────────────────────

/** Structural readers for untrusted provider JSON: every field stays `unknown`
 *  until it has been checked. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Provider text as plain words: Crossref and OpenAlex ship titles, venues
 *  and abstracts with HTML entities and JATS/HTML inline markup. Tags become a
 *  space, entities are decoded, and whitespace collapses — markup removed,
 *  wording untouched. */
export function plainText(value: string | null): string | null {
  if (value === null) return null;
  const text = decodeHtmlEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : null;
}

/** Trimmed non-empty string, or null. Surrounding whitespace is not meaning. */
export function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Years and citation counts are whole numbers at every provider. */
export function asInteger(value: unknown): number | null {
  const num = asNumber(value);
  return num === null ? null : Math.trunc(num);
}

/** First non-empty string of an array field (`title`, `container-title`). */
export function firstString(value: unknown): string | null {
  for (const entry of asArray(value)) {
    const text = asString(entry);
    if (text !== null) return text;
  }
  return null;
}

/** OpenAlex returns the DOI as a URL; Crossref and Semantic Scholar return it
 *  bare. One shape leaves this layer. */
export function doiOrNull(value: unknown): string | null {
  const raw = asString(value);
  return raw === null ? null : normalizeRegistryDoi(raw);
}

// ── shared request helpers ──────────────────────────────────────────────────

/**
 * Results per provider when the caller does not ask for a number. A search
 * that wants a page of 100 says so; the providers' own ceilings (in each
 * client) are what protect them.
 */
const DEFAULT_LIMIT = 10;

/** Real-time sleep; the injected seam everywhere else in this layer. */
export function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Optional provider timeout, test sleep and caller signal, passed to the retry helper. */
export function retryOpts(cfg: ProviderConfig): {
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
} {
  return {
    ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
    ...(cfg.sleep !== undefined ? { sleep: cfg.sleep } : {}),
    ...(cfg.signal !== undefined ? { signal: cfg.signal } : {}),
  };
}

/** A backoff wait that a caller abort ends at once, clearing its timer. An injected `sleep` (tests) is raced against the signal. */
function retryWait(ms: number, sleep: ((ms: number) => Promise<void>) | undefined, signal: AbortSignal | undefined): Promise<void> {
  return sleep !== undefined ? untilAborted(sleep(ms), signal) : abortableSleep(ms, signal);
}

/** Real-time sleep that an abort ends at once with the abort reason, clearing its timer. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return defaultSleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Waits for `pending`, but ends at this caller's abort with its reason; the work itself is not cancelled. */
export function untilAborted<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Clamp `limit` to the provider's own ceiling; a missing limit is the
 *  default page, never "everything". */
export function clampLimit(limit: number | undefined, providerMax: number): number {
  const fallback = Math.min(DEFAULT_LIMIT, providerMax);
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), providerMax);
}

export function parseJsonBody(body: string, provider: ProviderName): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ProviderRequestError(provider, null, "body is not JSON");
  }
}

/** One provider GET: the retry policy, then JSON. A non-200 that survived the
 *  retries is thrown, never returned as an empty result set. */
export async function getJson(
  fetchFn: FetchLike,
  cfg: ProviderConfig,
  provider: ProviderName,
  url: string,
): Promise<unknown> {
  const res = await fetchWithRetry(fetchFn, url, retryOpts(cfg));
  if (res.status !== 200) throw new ProviderRequestError(provider, res.status, "GET failed");
  return parseJsonBody(res.body, provider);
}
