/**
 * Unit selection for claim verification (V4): judge whole paper sections, not
 * 512-token chunks. A unit is a section (or a sentence-cut piece of an
 * oversize section) from paper-units.ts; bibliography sections are excluded
 * and the exclusion is disclosed. No new index or table: BM25 still runs over
 * chunk_fts and folds to units; candidates keep the existing Candidate shape
 * so stage 1/2, nextWork, EvidenceRow and containEvidence run unchanged.
 */
import type { DatabaseSync } from "../registry.ts";
import { getSourceText, unitIdOf } from "./store.ts";
import type { Candidate } from "./retrieve.ts";
import { paperUnits, type PaperUnit } from "./paper-units.ts";

/** A paper's judging units with what was skipped. */
export interface LoadedPaperUnits {
  revision: string;
  text: string;
  pageStarts: number[] | null;
  /** Non-reference units, in reading order. */
  units: PaperUnit[];
  /** Reference units skipped (disclosed, never judged). */
  excluded: number;
}

/** The paper's non-reference section units, each at most `cap` chars. */
export function loadPaperUnits(db: DatabaseSync, doi: string, cap: number): LoadedPaperUnits | null {
  const src = getSourceText(db, doi);
  if (src === null) return null;
  const all = paperUnits(src.text, src.sections ?? [], cap);
  return { revision: src.revision, text: src.text, pageStarts: src.pageStarts, units: all.filter((u) => !u.references), excluded: all.filter((u) => u.references).length };
}

/** Rank-folded selection: one entry per chosen unit, in rank order. */
export interface FoldedUnit {
  doi: string;
  unit: PaperUnit;
}

/**
 * Fold BM25-ranked chunk starts to units (pure): a unit's rank is its
 * best-ranked chunk; a unit appears once; a chunk maps to the unit containing
 * its start; reference units are skipped.
 */
export function foldRankedToUnits(
  ranked: { doi: string; start: number }[],
  unitsOf: (doi: string) => PaperUnit[],
  opts: { perPaper?: number; top?: number } = {},
): FoldedUnit[] {
  const cache = new Map<string, PaperUnit[]>();
  const of = (doi: string): PaperUnit[] => {
    let u = cache.get(doi);
    if (u === undefined) {
      u = unitsOf(doi);
      cache.set(doi, u);
    }
    return u;
  };
  const seen = new Map<string, FoldedUnit>();
  for (const r of ranked) {
    // A chunk maps to the unit containing its start (units tile the text).
    const unit = of(r.doi).find((u) => !u.references && u.start <= r.start && r.start < u.end);
    if (unit === undefined) continue;
    const key = `${r.doi}|${unit.start}|${unit.end}`;
    if (!seen.has(key)) seen.set(key, { doi: r.doi, unit });
  }
  let out = [...seen.values()];
  if (opts.perPaper !== undefined) {
    const per = new Map<string, number>();
    out = out.filter((e) => {
      const n = per.get(e.doi) ?? 0;
      if (n >= opts.perPaper!) return false;
      per.set(e.doi, n + 1);
      return true;
    });
  }
  if (opts.top !== undefined) out = out.slice(0, opts.top);
  return out;
}

/** Candidates in the existing shape (chunkId = unitIdOf, chunkIndex = ordinal). */
export function unitCandidates(doi: string, revision: string, cap: number, units: PaperUnit[], firstIndex = 0): Candidate[] {
  return units.map((u, i) => ({
    doi,
    chunkIndex: firstIndex + i,
    chunkId: unitIdOf(doi, revision, cap, u.start, u.end),
    revision,
    start: u.start,
    end: u.end,
    text: u.text,
    hash: u.hash,
  }));
}
