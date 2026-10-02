/**
 * Crossref provider client (and the shared Crossref field readers the DOI
 * cascade reuses — Crossref is the DOI registry, so the cascade speaks the
 * same envelope).
 *
 * Ported from `UktubAI_Agentic/apps/control-api/src/tools/providers/crossref.ts`.
 * Added (Feynman, KTD3): `endpoint` provenance. Added for the injected-env
 * contract (R19): optional polite-pool `mailto` from the config.
 *
 * Every shape below was verified live on 2026-09-17 in the product; the curl
 * that produced it is quoted next to the normalizer that depends on it.
 */

import {
  asArray,
  asInteger,
  asRecord,
  asString,
  clampLimit,
  doiOrNull,
  firstString,
  getJson,
  plainText,
  retryOpts,
  fetchWithRetry,
} from "./http.ts";
import { dedupKey, type FetchLike, type PaperCandidate, type ProviderConfig, type SearchFilters } from "./types.ts";

/**
 * Crossref `rows` ceiling: 1..1000 (docs; the cap is respected live).
 * Provider page cap — documented, not a client invention (R19).
 */
const CROSSREF_MAX_ROWS = 1000;

/** Crossref returns the intersection with the record's own fields, so a record
 *  without a volume/abstract simply omits it. `query.title` is deprecated in
 *  favour of `query.bibliographic`; `abstract`, when present, is JATS XML. */
const CROSSREF_SELECT = "DOI,title,author,issued,container-title,is-referenced-by-count,abstract";

/** Crossref contributors carry `given`/`family` for people and `name` for
 *  organisations; both collapse to one display string. */
export function crossrefAuthors(value: unknown): string[] {
  const names: string[] = [];
  for (const entry of asArray(value)) {
    const contributor = asRecord(entry);
    if (contributor === null) continue;
    const organisation = asString(contributor["name"]);
    if (organisation !== null) {
      names.push(organisation);
      continue;
    }
    const given = asString(contributor["given"]);
    const family = asString(contributor["family"]);
    const name = [given, family].filter((part): part is string => part !== null).join(" ").trim();
    if (name.length > 0) names.push(name);
  }
  return names;
}

/** Crossref's year is `issued.date-parts[0][0]` (a nested array; parts are
 *  sometimes `[null, …]`, so only a real integer counts). */
export function crossrefYear(value: unknown): number | null {
  const parts = asArray(asRecord(value)?.["date-parts"]);
  return asInteger(asArray(parts[0])[0]);
}

/** One Crossref work → one candidate. `title`/`container-title` are ARRAYS; a
 *  record may carry an EMPTY title, and such a record is skipped here for the
 *  same reason as OpenAlex's. */
function normalizeCrossrefItem(value: unknown, endpoint: string): PaperCandidate | null {
  const item = asRecord(value);
  if (item === null) return null;
  const title = plainText(firstString(item["title"]));
  if (title === null) return null;
  const doi = doiOrNull(item["DOI"]);
  return {
    dedupKey: dedupKey({ doi, title }),
    title,
    doi,
    authors: crossrefAuthors(item["author"]),
    venue: plainText(firstString(item["container-title"])),
    year: crossrefYear(item["issued"]),
    abstract: plainText(asString(item["abstract"])),
    citationCount: asInteger(item["is-referenced-by-count"]),
    provider: "crossref",
    providerId: doi,
    endpoint,
  };
}

/**
 * Search Crossref. `query.bibliographic` is the citation-lookup query
 * (`query.title` is deprecated by Crossref) and the caller's text is passed
 * through as written, trimmed only (cross-provider pass-through discipline,
 * KTD3). Crossref is a DOI registry rather than a discovery engine, but it is
 * the authority for the records it holds.
 */
export async function searchCrossref(
  fetchFn: FetchLike,
  cfg: ProviderConfig,
  query: string,
  filters: SearchFilters = {},
  limit?: number,
): Promise<PaperCandidate[]> {
  const params = new URLSearchParams();
  params.set("query.bibliographic", query.trim());
  params.set("rows", String(clampLimit(limit, CROSSREF_MAX_ROWS)));
  params.set("select", CROSSREF_SELECT);
  const mailto = cfg.crossrefMailto?.trim() ?? "";
  if (mailto.length > 0) params.set("mailto", mailto);

  const filterParts: string[] = [];
  if (filters.yearFrom !== undefined) filterParts.push(`from-pub-date:${filters.yearFrom}-01-01`);
  // A full date on purpose: a bare year pads to January 1, so
  // `until-pub-date:2019` would silently exclude Feb–Dec 2019 (documented
  // Crossref date-filter trap).
  if (filters.yearTo !== undefined) filterParts.push(`until-pub-date:${filters.yearTo}-12-31`);
  // `container-title:` is an EXACT container-title filter. Crossref's filter
  // list is comma-separated with no escaping, so a venue containing a comma
  // would be read as two filters — passed through as written rather than
  // "repaired".
  const venue = filters.venue?.trim() ?? "";
  if (venue.length > 0) filterParts.push(`container-title:${venue}`);
  if (filterParts.length > 0) params.set("filter", filterParts.join(","));
  // `query.author` is a query parameter; Crossref has no author filter.
  const author = filters.author?.trim() ?? "";
  if (author.length > 0) params.set("query.author", author);

  const url = `${cfg.crossrefBaseUrl}/works?${params.toString()}`;
  const body = await getJson(fetchFn, cfg, "crossref", url);
  const items = asArray(asRecord(asRecord(body)?.["message"])?.["items"]);
  const candidates: PaperCandidate[] = [];
  for (const item of items) {
    const candidate = normalizeCrossrefItem(item, url);
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates;
}

/** The Crossref `/works/{doi}` record + BibTeX negotiation URLs the DOI
 *  cascade (`providers/doi.ts` in the product; the cascade in this package)
 *  shares with search. */
export function crossrefWorkUrl(cfg: ProviderConfig, doi: string): string {
  return `${cfg.crossrefBaseUrl}/works/${encodeURIComponent(doi)}`;
}

/** One Crossref GET returning raw status + body — the DOI cascade needs the
 *  404 distinction, which `getJson` throws away. */
export function crossrefGet(fetchFn: FetchLike, cfg: ProviderConfig, url: string) {
  return fetchWithRetry(fetchFn, url, retryOpts(cfg));
}
