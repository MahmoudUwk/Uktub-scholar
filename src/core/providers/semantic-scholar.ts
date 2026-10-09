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
  asArray,
  asInteger,
  asRecord,
  asString,
  clampLimit,
  defaultSleep,
  doiOrNull,
  getJson,
  plainText,
  withHeaders,
} from "./http.ts";
import { dedupKey, type FetchLike, type PaperCandidate, type ProviderConfig, type SearchFilters } from "./types.ts";

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
  /** Resolves when it is this caller's turn to start a request. */
  wait(): Promise<void>;
}

/**
 * Serialized start-spacing gate. Each `wait()` resolves at least
 * `minIntervalMs` after the previous one, and concurrent callers queue on a
 * promise chain instead of racing — a rate budget belongs to the endpoint, not
 * to one call. `sleep` and `now` are injected so a test can drive the clock
 * rather than wait on it.
 */
export function createStartSpacer(opts: {
  minIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}): StartSpacer {
  let lastStartMs = Number.NEGATIVE_INFINITY;
  let queue: Promise<void> = Promise.resolve();
  return {
    wait(): Promise<void> {
      const turn = queue.then(async () => {
        const elapsed = opts.now() - lastStartMs;
        if (elapsed < opts.minIntervalMs) await opts.sleep(opts.minIntervalMs - elapsed);
        lastStartMs = opts.now();
      });
      // The chain has to survive a rejected sleep: the next caller still takes
      // its turn instead of inheriting a rejected queue.
      queue = turn.then(
        () => undefined,
        () => undefined,
      );
      return turn;
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
  const sleep = cfg.sleep ?? defaultSleep;
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

  const apiKey = cfg.semanticScholarApiKey?.trim() ?? "";
  // The spec is explicit that the key is sent as the `x-api-key` header.
  const callFetch = apiKey.length === 0 ? fetchFn : withHeaders(fetchFn, { "x-api-key": apiKey });
  await semanticScholarSpacer(cfg).wait();
  const url = `${cfg.semanticScholarBaseUrl}/graph/v1/paper/search?${params.toString()}`;
  const body = await getJson(callFetch, cfg, "semantic-scholar", url);

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
