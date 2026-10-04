/**
 * Test doubles for the provider layer (`tests/scholarly.spec.ts`), ported from
 * `UktubAI_Agentic/tests/contract/helpers/provider-fakes.ts`. Nothing here
 * touches a network — the base URLs point at `.test` hosts, so a request that
 * escaped a fake fails DNS instead of reaching a real provider.
 */
import type {
  FetchLike,
  PaperCandidate,
  ProviderConfig,
} from "../../src/core/providers/types.ts";
import { dedupKey } from "../../src/core/providers/types.ts";

const BASE_CONFIG: ProviderConfig = {
  openalexBaseUrl: "https://api.openalex.test",
  crossrefBaseUrl: "https://api.crossref.test",
  semanticScholarBaseUrl: "https://api.semanticscholar.test",
};

export function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { ...BASE_CONFIG, ...overrides };
}

interface FakeRoute {
  match: (url: string) => boolean;
  status?: number;
  body: string;
  headers?: Record<string, string>;
}

interface RecordedRequest {
  url: string;
  headers: Record<string, string> | undefined;
}

/**
 * The provider layer hands an API key through a WIDER init object than
 * `FetchLike` declares (object types are structural), so the fake reads it the
 * same way.
 */
interface InitWithHeaders {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** URL-keyed fake fetch: routes are tried in order; an unmatched URL throws. */
export function createFakeFetch(routes: FakeRoute[]): { fetchFn: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fake = async (url: string, init?: InitWithHeaders) => {
    requests.push({ url, headers: init?.headers });
    const route = routes.find((candidate) => candidate.match(url));
    if (route === undefined) throw new Error(`NO_FAKE_ROUTE: ${url}`);
    return new Response(route.body, { status: route.status ?? 200, headers: route.headers ?? {} });
  };
  return { fetchFn: fake, requests };
}

/** Minimal candidate builder: only the fields a test cares about. */
export function candidate(overrides: Partial<PaperCandidate> & { title: string }): PaperCandidate {
  const { title, doi: requestedDoi, endpoint, ...rest } = overrides;
  const doi = requestedDoi ?? null;
  return {
    title,
    doi,
    authors: [],
    venue: null,
    year: null,
    abstract: null,
    citationCount: null,
    provider: "openalex",
    providerId: null,
    endpoint: endpoint ?? "test://candidate",
    ...rest,
    dedupKey: overrides.dedupKey ?? dedupKey({ doi, title }),
  };
}

// ── search_papers fan-out ───────────────────────────────────────────────────

/** A work as a test states it; each provider's envelope is built from it. */
export interface FakeWork {
  title: string;
  doi?: string;
  citations?: number;
}

/** `count` distinct works, ranks 1..count. */
export function fakeWorks(prefix: string, count: number): FakeWork[] {
  return Array.from({ length: count }, (_, index) => ({
    title: `${prefix} ${index + 1}`,
    doi: `10.1000/${prefix}-${index + 1}`,
  }));
}

/** A provider's ranked pool, "down" for HTTP 500, or "rate-limited" for a
 *  persistent 429 (the retry policy exhausts its retries, the provider fails). */
export type FakeProviderPool = FakeWork[] | "down" | "rate-limited";

const noSleep = async (_ms: number): Promise<void> => {};

/** Provider config with an injected clock: no real backoff, no real S2 spacer. */
export const SEARCH_CFG: ProviderConfig = cfg({ sleep: noSleep });

function openAlexEnvelope(works: FakeWork[]): unknown {
  return {
    results: works.map((work, index) => ({
      id: `https://openalex.org/W${index + 1}`,
      doi: work.doi === undefined ? null : `https://doi.org/${work.doi}`,
      title: work.title,
      cited_by_count: work.citations ?? null,
    })),
  };
}

function crossrefEnvelope(works: FakeWork[]): unknown {
  return {
    message: {
      items: works.map((work) => ({
        ...(work.doi === undefined ? {} : { DOI: work.doi }),
        title: [work.title],
        ...(work.citations === undefined ? {} : { "is-referenced-by-count": work.citations }),
      })),
    },
  };
}

function semanticScholarEnvelope(works: FakeWork[]): unknown {
  return {
    data: works.map((work, index) => ({
      paperId: `S${index + 1}`,
      title: work.title,
      externalIds: work.doi === undefined ? {} : { DOI: work.doi },
      citationCount: work.citations ?? null,
    })),
  };
}

/**
 * The three search endpoints behind one fake fetch. Each answers like the real
 * provider does for its page-size parameter, its pool cut to the requested
 * size in the pool's own order. `requests` records every URL.
 */
export function createSearchFetch(pools: {
  openalex: FakeProviderPool;
  crossref: FakeProviderPool;
  semanticScholar: FakeProviderPool;
}): { fetchFn: FetchLike; requests: string[] } {
  const requests: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    requests.push(url);
    const [pool, envelope, sizeParam] =
      url.startsWith(SEARCH_CFG.openalexBaseUrl) ? ([pools.openalex, openAlexEnvelope, "per-page"] as const)
      : url.startsWith(SEARCH_CFG.crossrefBaseUrl) ? ([pools.crossref, crossrefEnvelope, "rows"] as const)
      : ([pools.semanticScholar, semanticScholarEnvelope, "limit"] as const);
    if (pool === "down") return new Response("boom", { status: 500 });
    if (pool === "rate-limited") {
      return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    }
    const size = Number(new URL(url).searchParams.get(sizeParam));
    return new Response(JSON.stringify(envelope(pool.slice(0, size))), { status: 200 });
  };
  return { fetchFn, requests };
}

/** The page size a provider was asked for: `param` on the first request to `base`. */
export function requestedPageSize(requests: string[], base: string, param: "per-page" | "rows" | "limit"): number {
  const url = requests.find((candidate) => candidate.startsWith(base));
  if (url === undefined) throw new Error(`NO_REQUEST_TO: ${base}`);
  return Number(new URL(url).searchParams.get(param));
}

// ── DOI cascade ─────────────────────────────────────────────────────────────

/** Crossref `/works/{doi}` JSON envelope for one paper. */
export function crossrefWorkEnvelope(overrides: {
  doi: string;
  title: string;
  authors?: unknown;
  year?: number;
  venue?: string;
  citations?: number;
  /** JATS abstract as Crossref ships it. */
  abstract?: string;
}): string {
  return JSON.stringify({
    message: {
      DOI: overrides.doi,
      title: [overrides.title],
      ...(overrides.authors !== undefined ? { author: overrides.authors } : {}),
      ...(overrides.year !== undefined ? { issued: { "date-parts": [[overrides.year]] } } : {}),
      ...(overrides.venue !== undefined ? { "container-title": [overrides.venue] } : {}),
      ...(overrides.citations !== undefined ? { "is-referenced-by-count": overrides.citations } : {}),
      ...(overrides.abstract !== undefined ? { abstract: overrides.abstract } : {}),
    },
  });
}
