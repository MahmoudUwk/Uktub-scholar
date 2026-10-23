/**
 * Semantic Scholar provider client — the one provider with a request-start
 * rate budget, so its start-spacer lives here too.
 *
 * Ported from `UktubAI_Agentic/apps/control-api/src/tools/providers/
 * semantic-scholar.ts`; `endpoint` provenance added (Feynman, KTD3).
 *
 * The shape below was verified live on 2026-09-17 in the product; the curl
 * that produced it is quoted next to the normalizer that depends on it.
 */

import {
  abortableSleep,
  asArray,
  asInteger,
  asRecord,
  asString,
  clampLimit,
  doiOrNull,
  fetchWithRetry,
  parseJsonBody,
  plainText,
  retryOpts,
  untilAborted,
} from "./http.ts";
import {
  dedupKey,
  ProviderRequestError,
  type FetchLike,
  type FetchResult,
  type PaperCandidate,
  type ProviderConfig,
  type SearchFilters,
} from "./types.ts";

/**
 * Semantic Scholar `limit` ceiling: "Must be <= 100" (live swagger,
 * `/paper/search`). Provider page cap — documented, not a client invention
 * (R19).
 */
const SEMANTIC_SCHOLAR_MAX_LIMIT = 100;

/**
 * Semantic Scholar: one request per second, measured on request START. The
 * skill documents 1 rps with a key and a shared keyless pool that 429s as a
 * matter of course; the spacing is enforced across calls, not within one.
 */
const SEMANTIC_SCHOLAR_MIN_START_SPACING_MS = 1000;

/** Plain fields, unlike OpenAlex's index. `citationStyles.bibtex` is NOT
 *  accepted by search endpoints (the live swagger serves it on
 *  `/paper/{id}` only), which is one more reason BibTeX comes from Crossref. */
const SEMANTIC_SCHOLAR_FIELDS = "paperId,title,abstract,year,venue,authors,citationCount,externalIds";

export interface StartSpacer {
  /** Resolves when it is this caller's turn to start a request. With `signal`,
   *  rejects promptly with `signal.reason` on abort; an aborted waiter takes no
   *  slot, so the callers queued behind it keep their own spacing. */
  wait(signal?: AbortSignal): Promise<void>;
}

/**
 * Serialized start-spacing gate. Each `wait()` resolves at least
 * `minIntervalMs` after the previous one, and concurrent callers queue on a
 * promise chain instead of racing — a rate budget belongs to the endpoint, not
 * to one call. `sleep` and `now` are injected so a test can drive the clock
 * rather than wait on it.
 *
 * A waiter's place in the queue is released when its turn ends or its caller
 * aborts, whichever comes first. The start time is recorded only by a turn that
 * actually completed, so an aborted waiter neither consumes a slot nor delays
 * the callers behind it.
 */
export function createStartSpacer(opts: {
  minIntervalMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
}): StartSpacer {
  let lastStartMs = Number.NEGATIVE_INFINITY;
  let queue: Promise<void> = Promise.resolve();
  return {
    wait(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) return Promise.reject(signal.reason);
      // The turn still runs in queue order: an abort ends it at once (its sleep is
      // raced against the signal) and records no start, but never before the turns
      // ahead of it, so a later caller is always spaced from the last real start.
      const turn = queue.then(async () => {
        signal?.throwIfAborted();
        const elapsed = opts.now() - lastStartMs;
        if (elapsed < opts.minIntervalMs) await untilAborted(opts.sleep(opts.minIntervalMs - elapsed, signal), signal);
        lastStartMs = opts.now();
      });
      // The chain has to survive a rejected sleep or an aborted turn: the next
      // caller still takes its turn instead of inheriting a rejected queue.
      queue = turn.then(
        () => undefined,
        () => undefined,
      );
      return untilAborted(turn, signal);
    },
  };
}

/**
 * One spacer per Semantic Scholar base URL: the 1 req/s budget belongs to the
 * endpoint (or to the key), so the spacing outlives a single call. The
 * injected `sleep` is part of the identity — a config that brings its own
 * clock (tests do) gets its own spacer instead of inheriting a real one.
 */
const semanticScholarSpacers = new Map<
  string,
  { sleep: (ms: number) => Promise<void>; spacer: StartSpacer }
>();

export function semanticScholarSpacer(cfg: ProviderConfig): StartSpacer {
  const sleep = cfg.sleep ?? abortableSleep;
  const existing = semanticScholarSpacers.get(cfg.semanticScholarBaseUrl);
  if (existing !== undefined && existing.sleep === sleep) return existing.spacer;
  const spacer = createStartSpacer({
    minIntervalMs: SEMANTIC_SCHOLAR_MIN_START_SPACING_MS,
    sleep,
    now: () => Date.now(),
  });
  semanticScholarSpacers.set(cfg.semanticScholarBaseUrl, { sleep, spacer });
  return spacer;
}

/** Owner decision (2026-10-18): a keyed request answered with one of these is repeated once without the key, in the public pool. */
const KEY_FALLBACK_STATUSES = new Set([401, 403, 429]);

/** One Semantic Scholar GET: keyed when a key is configured (the spacer, then the retry policy). A rejected or rate-limited keyed
 *  request is repeated once without the key, after the spacer again; without a key there is never a duplicate request. */
export async function semanticScholarGet(fetchFn: FetchLike, cfg: ProviderConfig, url: string): Promise<FetchResult> {
  const key = cfg.semanticScholarApiKey?.trim() ?? "";
  await semanticScholarSpacer(cfg).wait(cfg.signal);
  // The spec is explicit that the key is sent as the `x-api-key` header.
  const res = await fetchWithRetry(fetchFn, url, { ...retryOpts(cfg), ...(key ? { headers: { "x-api-key": key } } : {}) });
  if (!key || !KEY_FALLBACK_STATUSES.has(res.status)) return res;
  await semanticScholarSpacer(cfg).wait(cfg.signal);
  return fetchWithRetry(fetchFn, url, retryOpts(cfg));
}

/** One Semantic Scholar paper → one candidate. */
function normalizeSemanticScholarPaper(value: unknown, endpoint: string): PaperCandidate | null {
  const paper = asRecord(value);
  if (paper === null) return null;
  const title = plainText(asString(paper["title"]));
  if (title === null) return null;
  const doi = doiOrNull(asRecord(paper["externalIds"])?.["DOI"]);
  const authors: string[] = [];
  for (const entry of asArray(paper["authors"])) {
    const name = asString(asRecord(entry)?.["name"]);
    if (name !== null) authors.push(name);
  }
  return {
    dedupKey: dedupKey({ doi, title }),
    title,
    doi,
    authors,
    venue: plainText(asString(paper["venue"])),
    year: asInteger(paper["year"]),
    // Semantic Scholar's abstract is already plain text, and it may be null
    // under publisher embargo.
    abstract: asString(paper["abstract"]),
    citationCount: asInteger(paper["citationCount"]),
    provider: "semantic-scholar",
    providerId: asString(paper["paperId"]),
    endpoint,
  };
}

/**
 * Search Semantic Scholar. `/paper/search` has NO author parameter (live
 * swagger, 2026-09-17), so an author filter is applied to the returned
 * candidates — a case-insensitive substring match on the normalized byline —
 * instead of being silently dropped. Year and venue are the provider's own
 * parameters.
 *
 * The caller's query is passed through as written, trimmed only (cross-provider
 * pass-through discipline, KTD3). Calls are serialized to one start per second
 * across the whole process.
 */
export async function searchSemanticScholar(
  fetchFn: FetchLike,
  cfg: ProviderConfig,
  query: string,
  filters: SearchFilters = {},
  limit?: number,
): Promise<PaperCandidate[]> {
  const params = new URLSearchParams();
  params.set("query", query.trim());
  params.set("limit", String(clampLimit(limit, SEMANTIC_SCHOLAR_MAX_LIMIT)));
  params.set("fields", SEMANTIC_SCHOLAR_FIELDS);
  if (filters.yearFrom !== undefined || filters.yearTo !== undefined) {
    // Documented grammar: `2019`, `2016-2020`, `2010-`, `-2015`.
    const from = filters.yearFrom === undefined ? "" : String(filters.yearFrom);
    const to = filters.yearTo === undefined ? "" : String(filters.yearTo);
    params.set("year", `${from}-${to}`);
  }
  // `venue` is a comma-separated list of names or ISO4 abbreviations.
  const venue = filters.venue?.trim() ?? "";
  if (venue.length > 0) params.set("venue", venue);

  const url = `${cfg.semanticScholarBaseUrl}/graph/v1/paper/search?${params.toString()}`;
  const res = await semanticScholarGet(fetchFn, cfg, url);
  if (res.status !== 200) throw new ProviderRequestError("semantic-scholar", res.status, "GET failed");
  const body = parseJsonBody(res.body, "semantic-scholar");

  const candidates: PaperCandidate[] = [];
  for (const paper of asArray(asRecord(body)?.["data"])) {
    const candidate = normalizeSemanticScholarPaper(paper, url);
    if (candidate !== null) candidates.push(candidate);
  }
  const author = filters.author?.trim() ?? "";
  if (author.length === 0) return candidates;
  const needle = author.toLowerCase();
  return candidates.filter((candidate) =>
    candidate.authors.some((name) => name.toLowerCase().includes(needle)),
  );
}
