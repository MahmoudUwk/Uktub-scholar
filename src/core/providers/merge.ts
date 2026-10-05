/**
 * Candidate merging — how the same work reported by several providers becomes
 * one record, and how the providers' separate rankings become one ranking.
 *
 * Ported verbatim (rules and constants) from `UktubAI_Agentic/apps/control-api/
 * src/tools/providers/merge.ts`; `endpoint` rides the existing
 * first-reporter-wins provenance rule.
 */

import { titleKey, type PaperCandidate } from "./types.ts";

function richerCandidate(a: PaperCandidate, b: PaperCandidate): PaperCandidate {
  const openAccess = mergedOpenAccess(a.isOpenAccess, b.isOpenAccess);
  return {
    dedupKey: a.dedupKey,
    title: longerText(a.title, b.title),
    doi: a.doi ?? b.doi,
    authors: a.authors.length >= b.authors.length ? a.authors : b.authors,
    venue: longerString(a.venue, b.venue),
    year: a.year ?? b.year,
    abstract: longerString(a.abstract, b.abstract),
    citationCount: largerCount(a.citationCount, b.citationCount),
    provider: a.provider,
    providerId: a.providerId,
    endpoint: a.endpoint,
    ...(openAccess !== undefined ? { isOpenAccess: openAccess } : {}),
  };
}

function mergedOpenAccess(a: boolean | undefined, b: boolean | undefined): boolean | undefined {
  if (a === true || b === true) return true;
  if (a === false || b === false) return false;
  return undefined;
}

/** Longer of two non-null strings. */
function longerText(a: string, b: string): string {
  return b.length > a.length ? b : a;
}

/** Longer of two nullable strings; a non-null value always beats null. */
function longerString(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return longerText(a, b);
}

function largerCount(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * Reciprocal Rank Fusion constant `k`: a work's score is the sum over the
 * provider lists that hold it of `1 / (k + rank)`, rank being 1-based in that
 * provider's own order. 60 is the value Cormack, Clarke & Büttcher (SIGIR
 * 2009) fixed and the default of Elasticsearch's RRF retriever. Provider
 * scores are never compared: OpenAlex's `relevance_score` has a per-query
 * scale, so only each list's order is used.
 */
const RRF_K = 60;

/**
 * Two RRF scores closer than this are one score. A three-term sum added in a
 * different order can differ in the last floating-point bit (about 1e-17 at
 * these magnitudes), and that noise must not decide a tie the citation-count
 * rule is meant to break. Distinct rank-sum scores never come this close: an
 * exhaustive check over every rank combination the search page sizes allow
 * found a smallest genuine gap of about 4e-13.
 */
const RRF_SCORE_EPSILON = 1e-15;

/** Tie-break for equal fusion scores: citation count descending (unknown counts
 *  last), then title ascending by code unit — locale-independent, so the order
 *  cannot drift between environments and a caller sees a stable list. */
function compareCandidates(a: PaperCandidate, b: PaperCandidate): number {
  const left = a.citationCount ?? -1;
  const right = b.citationCount ?? -1;
  if (left !== right) return right - left;
  if (a.title === b.title) return 0;
  return a.title < b.title ? -1 : 1;
}

/**
 * Merge candidates from several providers: DOI-first dedup (title-slug
 * fallback, both from `dedupKey`), richest record wins per field, and the
 * result ordered by Reciprocal Rank Fusion over each list's own order — a work
 * that several providers rank highly outranks one a single provider ranks
 * first. A work repeated inside one list counts once, at its first position.
 * Equal scores fall back to `compareCandidates`, so the order is deterministic.
 * Every rule is order-independent in the fields; the merge is invariant under
 * permuted input list order by construction. Returns a new array; the inputs
 * are not touched.
 */
export function mergeCandidates(lists: PaperCandidate[][]): PaperCandidate[] {
  const merged = new Map<string, PaperCandidate>();
  const scores = new Map<string, number>();
  for (const list of lists) {
    const scoredInList = new Set<string>();
    list.forEach((candidate, index) => {
      const key = candidate.dedupKey;
      const existing = merged.get(key);
      merged.set(key, existing === undefined ? candidate : richerCandidate(existing, candidate));
      if (scoredInList.has(key)) return;
      scoredInList.add(key);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }
  foldDoiless(merged, scores);
  return [...merged.values()].sort((a, b) => {
    const gap = (scores.get(b.dedupKey) ?? 0) - (scores.get(a.dedupKey) ?? 0);
    return Math.abs(gap) > RRF_SCORE_EPSILON ? gap : compareCandidates(a, b);
  });
}

/**
 * A record without a DOI that restates a DOI-bearing one (same title slug, same year — or either year unknown) is the same work seen by a
 * provider that lacks the DOI (e.g. an arXiv listing). It cannot be registered anyway, so it is folded into the DOI record and counts as
 * one more provider reporting it. Two DOI-bearing records are never folded: a preprint and its published version are distinct works.
 */
function foldDoiless(merged: Map<string, PaperCandidate>, scores: Map<string, number>): void {
  const byTitle = new Map<string, string>();
  for (const [key, c] of merged) if (c.doi !== null) byTitle.set(titleKey(c.title), key);
  for (const [key, dup] of [...merged]) {
    if (dup.doi !== null) continue;
    const survivorKey = byTitle.get(titleKey(dup.title));
    const survivor = survivorKey === undefined ? undefined : merged.get(survivorKey);
    if (survivorKey === undefined || survivor === undefined) continue;
    if (survivor.year !== null && dup.year !== null && survivor.year !== dup.year) continue;
    merged.set(survivorKey, richerCandidate(survivor, dup));
    scores.set(survivorKey, (scores.get(survivorKey) ?? 0) + (scores.get(key) ?? 0));
    merged.delete(key);
    scores.delete(key);
  }
}
