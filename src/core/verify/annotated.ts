/**
 * Annotated verification helpers (W4): bind the writer's stated sources to
 * paper units, and fold prime grids. Pure: no I/O and no state.
 */

import { clipLabel } from "../sections.ts";
import type { SourceRef } from "./annotations.ts";
import type { GridResult } from "./judge.ts";

/** The judging units a stated source is matched against (paper order). */
export interface MatchUnit {
  start: number;
  end: number;
  section: string;
}

/** Collapse whitespace for heading comparison (exact case kept). */
const collapse = (s: string): string => s.trim().replace(/\s+/g, " ");

/**
 * Bind stated sources to paper units (paper order). A section ref matches
 * every unit whose label equals the collapsed heading, or its clipped form
 * (a long heading matches as passages printed it); oversize-section pieces
 * share the label, so all match. A pointer ref matches units overlapping
 * [start, end) of the same doi and revision (end-exclusive: touching the end
 * is no overlap). Anything else is unresolved.
 */
export function matchStatedUnits(
  units: readonly MatchUnit[],
  doi: string,
  revision: string,
  refs: readonly SourceRef[],
): { matched: number[]; unresolved: SourceRef[] } {
  const matched: number[] = [];
  const unresolved: SourceRef[] = [];
  for (const ref of refs) {
    const hit: number[] = [];
    if (ref.kind === "section") {
      const want = collapse(ref.heading);
      const clipped = clipLabel(want);
      units.forEach((u, i) => {
        if (collapse(u.section) === want || collapse(u.section) === clipped) hit.push(i);
      });
    } else if (ref.doi === doi && ref.revision === revision) {
      units.forEach((u, i) => {
        if (u.start < ref.end && ref.start < u.end) hit.push(i);
      });
    }
    if (hit.length > 0) {
      for (const i of hit) if (!matched.includes(i)) matched.push(i);
    } else {
      unresolved.push(ref);
    }
  }
  return { matched: matched.sort((a, b) => a - b), unresolved };
}

/**
 * Fold two prime grids (round 1 plus round 1b) into one session grid:
 * score union (the first grid wins a duplicate cell), summed counts,
 * concatenated unchecked cells (deduped), precedence
 * cancelled > engine_failure > budget.
 */
export function mergeGrids(a: GridResult, b: GridResult): GridResult {
  const scores = new Map<string, Map<string, number>>();
  for (const g of [a, b]) {
    for (const [claimHash, byUnit] of g.scores) {
      let out = scores.get(claimHash);
      if (out === undefined) {
        out = new Map();
        scores.set(claimHash, out);
      }
      for (const [hash, score] of byUnit) if (!out.has(hash)) out.set(hash, score);
    }
  }
  const seen = new Set<string>();
  const unchecked: GridResult["unchecked"] = [];
  for (const u of [...a.unchecked, ...b.unchecked]) {
    const key = `${u.claimHash} ${u.hash}`;
    if (!seen.has(key)) {
      seen.add(key);
      unchecked.push(u);
    }
  }
  const rank = (g: GridResult): number =>
    g.interruption === null ? -1 : g.interruption.reason === "cancelled" ? 2 : g.interruption.reason === "engine_failure" ? 1 : 0;
  return {
    scores,
    cached: a.cached + b.cached,
    fresh: a.fresh + b.fresh,
    unchecked,
    interruption: rank(a) >= rank(b) ? a.interruption : b.interruption,
  };
}
