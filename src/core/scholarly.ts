/**
 * Scholarly tool handlers — the provider-facing half of the package's tools.
 *
 * Ported from `UktubAI_Agentic/apps/control-api/src/tools/scholarly.ts` (plus
 * the product's DOI cascade, inlined here — DOI normalization itself lives in
 * `../doi.ts`). Owner decisions kept verbatim: results are normalized
 * candidates; BibTeX is only ever the provider's own text (a paper without it
 * is reported uncitable, never repaired or fabricated — R13); a partial
 * provider outage degrades the answer with typed warnings rather than failing
 * the whole search, unless every provider fails.
 *
 * Feynman hardening adopted (KTD3, verified at commit `e17f5fd`):
 *  - tool-schema caps: search `limit` defaults to 5 and maxes at 20
 *    (incident-derived: uncapped requests returned 100–240 KB responses; R19);
 *  - `endpoint` provenance on every candidate;
 *  - a DOI-shaped query still searches pass-through, with a hint in the
 *    result (`hint`, never a refusal or a re-route);
 *  - cross-provider pass-through discipline: the query goes to every provider
 *  unchanged — never translated into provider-specific syntax.
 *
 * Query handling is deliberately dumb: the query is trimmed and passed
 * through. A DOI may additionally be recognized in the shapes a model
 * actually writes it (`10.x/y`, `doi:10.x/y`, `https://doi.org/10.x/y`,
 * `arxiv:YYMM.NNNNN`) — meaning-preserving normalization only, since all of
 * them name the same DOI.
 */

import { arxivDoi, isArxivDoi, normalizeRegistryDoi } from "./doi.ts";
import { asInteger, asRecord, asString, firstString, parseJsonBody, plainText } from "./providers/http.ts";
import { crossrefAuthors, crossrefGet, crossrefWorkUrl, crossrefYear, searchCrossref } from "./providers/crossref.ts";
import { fetchArxivPaperByDoi } from "./providers/datacite.ts";
import { mergeCandidates } from "./providers/merge.ts";
import { searchOpenAlex } from "./providers/openalex.ts";
import { searchSemanticScholar } from "./providers/semantic-scholar.ts";
import {
  dedupKey,
  ProviderRequestError,
  type FetchLike,
  type PaperCandidate,
  type PaperRecord,
  type ProviderConfig,
  type SearchFilters,
} from "./providers/types.ts";

export interface ProviderWarning {
  provider: string;
  code: string;
  message: string;
}

export interface SearchPapersArgs {
  query: string;
  filters?: SearchFilters;
  limit?: number;
}

export interface SearchPapersResult {
  candidates: PaperCandidate[];
  /** Providers that could not answer this request. Empty means all answered. */
  warnings: ProviderWarning[];
  /** The limit this search applied: the caller's `limit` clamped to
   *  [1, SEARCH_LIMIT_MAX], or the default page when none was given. */
  requested: number;
  /** `candidates.length` — what came back. Below `requested` when the
   *  providers held or returned fewer distinct works than asked for. */
  returned: number;
  /** The merged, deduped set held more than `requested` works and the
   *  lowest-ranked were cut. */
  truncated: boolean;
  /** Feynman adoption: set when the query itself normalizes as a DOI
   *  (including the `arxiv:` form) — registration via `paper_registry` is the
   *  precise instrument for that identifier. The search still ran. */
  hint: string | null;
}

export class SearchUnavailableError extends Error {
  readonly warnings: ProviderWarning[];
  constructor(warnings: ProviderWarning[]) {
    super("SEARCH_UNAVAILABLE");
    this.name = "SearchUnavailableError";
    this.warnings = warnings;
  }
}

export class InvalidDoiError extends Error {
  constructor() {
    super("INVALID_DOI");
    this.name = "InvalidDoiError";
  }
}

export function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Largest `limit` one search applies. Feynman incident-derived cap (KTD3, R19):
 * uncapped searches returned 100–240 KB responses and blew the payload budget.
 */
const SEARCH_LIMIT_MAX = 20;

/** Default `limit` when the caller gives none — same incident source (R19). */
const SEARCH_LIMIT_DEFAULT = 5;

/**
 * Each provider is asked for twice the caller's `limit` so works several
 * providers report (deduped away) and works a provider's own filter drops
 * (Semantic Scholar's author match) still leave `limit` distinct candidates to
 * fuse. A client policy, not a provider rule. The provider clients clamp the
 * request to their documented page maximum (OpenAlex `per-page` 100, Semantic
 * Scholar `limit` 100, Crossref `rows` 1000), so a provider is asked for
 * min(2 × limit, maximum).
 */
const OVERFETCH_FACTOR = 2;

/** Clamp the caller's `limit` into [1, SEARCH_LIMIT_MAX]; none given → the
 *  Feynman-derived default. */
export function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SEARCH_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.trunc(limit), 1), SEARCH_LIMIT_MAX);
}

/** DOI shapes a model writes (`10.x/y`, `doi:…`, `https://doi.org/…`), plus
 *  the EXPLICITLY prefixed arXiv form (`arxiv:YYMM.NNNNN`). The bare arXiv id
 *  is deliberately NOT accepted here (KTD8: it fails DOI normalization — use
 *  its `10.48550/arxiv.*` form). */
export function normalizeDoiQuery(raw: string): string | null {
  const doi = normalizeRegistryDoi(raw);
  if (doi !== null) return doi;
  return /^arxiv:/i.test(raw.trim()) ? arxivDoi(raw) : null;
}

/** Search all three providers concurrently, fuse their rankings (Reciprocal
 *  Rank Fusion over each provider's own order, `mergeCandidates`), dedupe the
 *  survivors and keep the best `limit`. */
export async function searchPapers(
  fetchFn: FetchLike,
  cfg: ProviderConfig,
  args: SearchPapersArgs,
): Promise<SearchPapersResult> {
  const query = args.query.trim();
  if (query.length === 0) throw new Error("QUERY_REQUIRED");
  const limit = clampSearchLimit(args.limit);
  const perProvider = limit * OVERFETCH_FACTOR;
  const results = await Promise.allSettled([
    searchOpenAlex(fetchFn, cfg, query, args.filters, perProvider),
    searchCrossref(fetchFn, cfg, query, args.filters, perProvider),
    searchSemanticScholar(fetchFn, cfg, query, args.filters, perProvider),
  ]);
  const names = ["openalex", "crossref", "semantic-scholar"] as const;
  const lists: PaperCandidate[][] = [];
  const warnings: ProviderWarning[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      lists.push(result.value);
      return;
    }
    warnings.push({ provider: names[index], code: "PROVIDER_FAILED", message: reasonOf(result.reason) });
  });
  if (lists.length === 0) throw new SearchUnavailableError(warnings);
  const merged = mergeCandidates(lists);
  const candidates = merged.slice(0, limit);
  return {
    candidates,
    warnings,
    requested: limit,
    returned: candidates.length,
    truncated: merged.length > limit,
    hint: normalizeDoiQuery(query) === null
      ? null
      : `query is a DOI — paper_registry (action register) with "${query.trim()}" registers it directly`,
  };
}

// ── DOI cascade (Crossref for publisher DOIs, DataCite for arXiv) ───────────

/**
 * Metadata + provider-supplied BibTeX for one DOI; null when no provider knows
 * it (the caller surfaces `DOI_NOT_FOUND`). `citable` is false whenever no
 * provider BibTeX was obtained (R13). BibTeX is NEVER synthesized from the
 * metadata fetched alongside it.
 */
export async function fetchPaperMetadata(
  fetchFn: FetchLike,
  cfg: ProviderConfig,
  args: { doi: string },
): Promise<PaperRecord | null> {
  const doi = normalizeDoiQuery(args.doi);
  if (doi === null) throw new InvalidDoiError();
  if (isArxivDoi(doi)) return fetchArxivPaperByDoi(fetchFn, cfg, doi);
  return fetchPaperByDoi(fetchFn, cfg, doi);
}

/**
 * The DOI cascade for publisher DOIs. Crossref is the DOI registry and the
 * only provider consulted here; both the JSON record (`/works/{doi}`) and the
 * content negotiation (`/works/{doi}/transform/application/x-bibtex`) go there.
 * A DOI Crossref does not hold is null, not an error: DataCite/arXiv and dblp
 * DOIs 404 with a plain-text body. When negotiation yields nothing the record
 * still comes back — with `bibtex: null` and `citable: false` (R13).
 */
async function fetchPaperByDoi(
  fetchFn: FetchLike,
  cfg: ProviderConfig,
  doi: string,
): Promise<PaperRecord | null> {
  const recordUrl = crossrefWorkUrl(cfg, doi);
  const meta = await crossrefGet(fetchFn, cfg, recordUrl);
  if (meta.status === 404) return null;
  if (meta.status !== 200) throw new ProviderRequestError("crossref", meta.status, "DOI lookup failed");
  const envelope = asRecord(parseJsonBody(meta.body, "crossref"));
  const work = asRecord(envelope?.["message"]);
  if (work === null) throw new ProviderRequestError("crossref", meta.status, "work envelope missing");

  const bibUrl = `${recordUrl}/transform/application/x-bibtex`;
  const bib = await crossrefGet(fetchFn, cfg, bibUrl);
  // Surrounding whitespace is trimmed (the live body starts with a space); the
  // entry text itself is passed through exactly as the provider wrote it.
  const bibtex = bib.status === 200 && bib.body.trim().length > 0 ? bib.body.trim() : null;

  // A title-less record is preserved here rather than skipped (the search
  // normalizers skip them): the caller named THIS DOI, so the useful answer is
  // what the registry holds — plus its BibTeX, which is what makes it citable.
  const title = plainText(firstString(work["title"])) ?? "";
  const recordDoi = asString(work["DOI"]) ?? doi;
  return {
    dedupKey: dedupKey({ doi: recordDoi, title }),
    title,
    doi: recordDoi,
    authors: crossrefAuthors(work["author"]),
    venue: plainText(firstString(work["container-title"])),
    year: crossrefYear(work["issued"]),
    abstract: plainText(asString(work["abstract"])),
    citationCount: asInteger(work["is-referenced-by-count"]),
    bibtex,
    citable: bibtex !== null,
    provider: "crossref",
    endpoint: recordUrl,
  };
}
