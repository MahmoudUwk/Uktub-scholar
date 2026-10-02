/**
 * OpenAlex provider client.
 *
 * Ported from `UktubAI_Agentic/apps/control-api/src/tools/providers/openalex.ts`.
 * Dropped for v0 (no consumer, plan U3): the `openAccessArxivOnly` flag and its
 * `hasArxivHost` dependency. Added (Feynman, KTD3): `endpoint` provenance.
 *
 * Every shape below was verified live on 2026-09-17 in the product; the curl
 * that produced it is quoted next to the normalizer that depends on it.
 */

import {
  asArray,
  asInteger,
  asNumber,
  asRecord,
  asString,
  clampLimit,
  doiOrNull,
  getJson,
  plainText,
} from "./http.ts";
import { dedupKey, type PaperCandidate, type ProviderConfig, type SearchFilters } from "./types.ts";

/**
 * OpenAlex `per-page` ceiling: 1..100 (200 is accepted legacy and deprecated).
 * Provider page cap — documented, not a client invention (R19).
 */
const OPENALEX_MAX_PER_PAGE = 100;

/** Root-level fields only (`select` rejects dot paths); all of these are
 *  returned live for a /works search, `abstract_inverted_index` included. */
const OPENALEX_SELECT = "id,doi,title,publication_year,authorships,primary_location,cited_by_count,abstract_inverted_index,open_access,locations";

/**
 * OpenAlex ships NO plaintext abstract: the only abstract attribute on a work
 * is `abstract_inverted_index`. Reconstructed by placing every word at its
 * listed positions and reading them off in ascending position order. Returns
 * null when there is no index.
 */
function reconstructAbstract(value: unknown): string | null {
  const index = asRecord(value);
  if (index === null) return null;
  const placed: Array<{ position: number; word: string }> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of asArray(positions)) {
      const at = asNumber(position);
      if (at !== null) placed.push({ position: at, word });
    }
  }
  if (placed.length === 0) return null;
  placed.sort((a, b) => a.position - b.position);
  return placed.map((entry) => entry.word).join(" ");
}

/** OpenAlex authors live under `authorships[].author.display_name` (capped at
 *  the first 100 authorships by the API itself). */
function openAlexAuthors(value: unknown): string[] {
  const names: string[] = [];
  for (const authorship of asArray(value)) {
    const name = asString(asRecord(asRecord(authorship)?.["author"])?.["display_name"]);
    if (name !== null) names.push(name);
  }
  return names;
}

/**
 * OpenAlex filters venues by SOURCE ID, not by name: `primary_location.source.id`
 * is the only venue filter on /works. The name is resolved the way the
 * skill's procedure prescribes ("resolve names to IDs first, never filter by
 * name"): `/sources?search=<name>`, top hit. Returns null when no source
 * matches — a strict filter that cannot be satisfied matches nothing, rather
 * than silently searching without it.
 */
async function resolveOpenAlexSourceId(
  fetchFn: Parameters<typeof getJson>[0],
  cfg: ProviderConfig,
  venue: string,
): Promise<string | null> {
  const params = new URLSearchParams({ search: venue.trim(), "per-page": "1", select: "id,display_name" });
  const body = await getJson(fetchFn, cfg, "openalex", `${cfg.openalexBaseUrl}/sources?${params.toString()}`);
  const results = asArray(asRecord(body)?.["results"]);
  return asString(asRecord(results[0])?.["id"]);
}

/** One OpenAlex work → one candidate. A record without a title cannot be
 *  deduped or cited, so it is skipped rather than returned as an empty-title
 *  paper. */
function normalizeOpenAlexWork(value: unknown, endpoint: string): PaperCandidate | null {
  const work = asRecord(value);
  if (work === null) return null;
  const title = plainText(asString(work["title"]) ?? asString(work["display_name"]));
  if (title === null) return null;
  const doi = doiOrNull(work["doi"]);
  const source = asRecord(asRecord(work["primary_location"])?.["source"]);
  const isOa = asRecord(work["open_access"])?.["is_oa"];
  return {
    dedupKey: dedupKey({ doi, title }),
    title,
    doi,
    authors: openAlexAuthors(work["authorships"]),
    venue: plainText(asString(source?.["display_name"])),
    year: asInteger(work["publication_year"]),
    abstract: reconstructAbstract(work["abstract_inverted_index"]),
    citationCount: asInteger(work["cited_by_count"]),
    provider: "openalex",
    providerId: asString(work["id"]),
    endpoint,
    ...(typeof isOa === "boolean" ? { isOpenAccess: isOa } : {}),
  };
}

/**
 * Search OpenAlex works. `search=` is the keyword search and the caller's text
 * is passed through as written, trimmed only (cross-provider pass-through
 * discipline — never translated, KTD3). Never throws for an empty result set.
 */
export async function searchOpenAlex(
  fetchFn: Parameters<typeof getJson>[0],
  cfg: ProviderConfig,
  query: string,
  filters: SearchFilters = {},
  limit?: number,
): Promise<PaperCandidate[]> {
  const params = new URLSearchParams();
  params.set("search", query.trim());
  params.set("per-page", String(clampLimit(limit, OPENALEX_MAX_PER_PAGE)));
  params.set("select", OPENALEX_SELECT);
  const apiKey = cfg.openalexApiKey?.trim() ?? "";
  if (apiKey.length > 0) params.set("api_key", apiKey);

  const filterParts: string[] = [];
  if (filters.yearFrom !== undefined) filterParts.push(`from_publication_date:${filters.yearFrom}-01-01`);
  if (filters.yearTo !== undefined) filterParts.push(`to_publication_date:${filters.yearTo}-12-31`);
  // `raw_author_name.search` is OpenAlex's byline filter for /works. It
  // searches the byline string, so a name never has to be resolved to an
  // author ID first.
  const author = filters.author?.trim() ?? "";
  if (author.length > 0) filterParts.push(`raw_author_name.search:${author}`);
  const venue = filters.venue?.trim() ?? "";
  if (venue.length > 0) {
    const sourceId = await resolveOpenAlexSourceId(fetchFn, cfg, venue);
    if (sourceId === null) return [];
    filterParts.push(`primary_location.source.id:${sourceId}`);
  }
  if (filterParts.length > 0) params.set("filter", filterParts.join(","));

  const url = `${cfg.openalexBaseUrl}/works?${params.toString()}`;
  const body = await getJson(fetchFn, cfg, "openalex", url);
  const candidates: PaperCandidate[] = [];
  for (const work of asArray(asRecord(body)?.["results"])) {
    const candidate = normalizeOpenAlexWork(work, url);
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates;
}
