/**
 * Scholarly provider layer — the shared vocabulary every provider client and
 * the DOI cascade speak: one candidate shape, one config, one typed failure.
 *
 * Two owner rules are load-bearing:
 *
 *  1. Results are NORMALIZED paper candidates. Three very different envelopes
 *     (OpenAlex inverted-index abstracts, Crossref arrays + JATS, Semantic
 *     Scholar plain fields) collapse into one `PaperCandidate`, and
 *     `mergeCandidates` folds the same work reported by several providers into
 *     one record instead of showing the caller the same paper three times.
 *  2. BibTeX is provider-supplied or it does not exist. Crossref and DataCite
 *     content negotiation supply BibTeX; when they yield nothing the record
 *     comes back `bibtex: null, citable: false`. BibTeX is never synthesized
 *     or "repaired" from the metadata already in hand — a fabricated
 *     bibliography entry is a fabricated citation (R13).
 *
 * Ported from `UktubAI_Agentic/apps/control-api/src/tools/providers/types.ts`.
 * Dropped for v0 (no consumer): `openAccessArxivOnly`, `fullText`,
 * `openalexContentBaseUrl` (all acquisition-era; plan U3). Added from Feynman
 * (MIT, commit `e17f5fd`): `endpoint` provenance on every candidate.
 *
 * Nothing here reads env or a global `fetch` — the tool context injects both
 * (R19: optional API keys arrive through the injected env).
 */

import { hashHex, normalizeRegistryDoi } from "../doi.ts";

/** DOI-first dedup key with title-slug fallback. */
export function dedupKey(input: { doi?: string | null; title: string }): string {
  if (input.doi && input.doi.trim().length > 0) {
    const norm = normalizeRegistryDoi(input.doi);
    if (norm !== null) return `doi:${norm}`;
    const bare = input.doi.trim().replace(/^doi:\s*/i, "").toLowerCase();
    return `doi:${bare}`;
  }
  const rawSlug = input.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+/g, "");
  const slug = Array.from(rawSlug)
    .slice(0, 80)
    .join("")
    .replace(/-+$/g, "");
  if (slug.length === 0) {
    return `title:${hashHex(input.title.trim().toLowerCase())}`;
  }
  return `title:${slug}`;
}

export type ProviderName = "openalex" | "crossref" | "semantic-scholar" | "datacite";

export interface PaperCandidate {
  dedupKey: string;
  title: string;
  doi: string | null;
  authors: string[];
  venue: string | null;
  year: number | null;
  abstract: string | null;
  citationCount: number | null;
  provider: ProviderName;
  providerId: string | null;
  /** Whether the work is open access (OpenAlex reports it; the merge keeps
   *  the optimistic answer). No acquisition behavior attaches in v0. */
  isOpenAccess?: boolean;
  /** Feynman adoption (KTD3): the provider endpoint URL that produced this
   *  candidate, so provenance survives the merge (the first reporter's). */
  endpoint: string;
}

export interface PaperRecord extends Omit<PaperCandidate, "providerId"> {
  /** Provider-SUPPLIED BibTeX text only. null means "no verified BibTeX exists". */
  bibtex: string | null;
  citable: boolean;
}

export interface ProviderConfig {
  openalexBaseUrl: string;
  crossrefBaseUrl: string;
  semanticScholarBaseUrl: string;
  /** Optional; Semantic Scholar rate-limits anonymous callers hard. */
  semanticScholarApiKey?: string;
  /** Optional; an OpenAlex key multiplies the daily content/call budget. */
  openalexApiKey?: string;
  /** Origin the OpenAlex Content API serves from; the API key is only ever
   *  sent to URLs on exactly this origin (default https://content.openalex.org). */
  openalexContentOrigin?: string;
  /** Optional Crossref polite-pool contact (`CROSSREF_MAILTO`); injected env,
   *  never `process.env` (R19). */
  crossrefMailto?: string;
  /** Private per-attempt HTTP timeout; unset preserves the 15-second default. */
  timeoutMs?: number;
  /** Injected for tests; defaults to a real sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SearchFilters {
  yearFrom?: number;
  yearTo?: number;
  venue?: string;
  author?: string;
}

/**
 * A provider answered with a status this layer cannot use, or with a body that
 * is not the JSON it promised. An empty result set is `[]`; a broken call is
 * thrown, so a caller can never mistake "provider is down" for "no papers".
 */
export class ProviderRequestError extends Error {
  readonly provider: ProviderName;
  readonly status: number | null;

  constructor(provider: ProviderName, status: number | null, detail: string) {
    super(`${provider}: ${status === null ? "unusable response" : `HTTP ${status}`} (${detail})`);
    this.name = "ProviderRequestError";
    this.provider = provider;
    this.status = status;
  }
}

/** Minimal fetch surface (structural: no HTTP dependency, injectable fakes). */
export interface FetchLike {
  (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    },
  ): Promise<{
    status: number;
    ok?: boolean;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
    /** Undici responses carry a cancelable stream; structural fakes omit it. */
    body?: { cancel(): Promise<void> } | null;
  }>;
}

export interface FetchResult {
  status: number;
  body: string;
}
