/**
 * Judgment execution (KTD8–KTD10): decide which passages need the engine,
 * run only those, validate what comes back, and persist it.
 *
 *  - Cache first, keyed by the effective decision identity; with no
 *    identity nothing is read or written (unsafe reuse is disabled).
 *  - The engine is built lazily, only when a miss exists, so fully cached
 *    work needs no credentials and an empty scope never touches an engine.
 *  - Scores are validated (cardinality, finite, within [0, 1]) BEFORE they
 *    are persisted or used; a bad batch is an engine failure, never a score.
 *  - Work is bounded (`maxFresh`), concurrency is bounded (`workers` lanes
 *    over one engine), and cancellation is honoured between batches.
 *  - Interruption is reported, not hidden: completed scores are kept and
 *    every passage that was not judged is listed as unchecked.
 *
 * A score is an engine output under a configured bar. Only `isSupported`
 * reads it; a low score is the absence of support, never a contradiction.
 */

import { agentSafeDetail } from "../safe-detail.ts";
import type { DatabaseSync } from "../registry.ts";

import type { ClaimEngine } from "./claim.ts";
import { CancelledError, EngineError, isRowFailure } from "./claim.ts";
import { cachedJudgments, claimHashOf, saveJudgments, type JudgmentIdentity } from "./store.ts";

export interface JudgeOptions {
  db: DatabaseSync;
  queue: { runExclusive<T>(fn: () => T | Promise<T>): Promise<T> };
  now: () => Date;
  /** Effective decision identity; null disables the judgment cache. */
  identity: JudgmentIdentity | null;
  /** Called at most once, and only when a passage needs a fresh judgment. */
  createEngine: () => ClaimEngine;
  /** Concurrent `engine.run` calls (lanes over the one engine). */
  workers: number;
  /** Rows per `engine.run` call. */
  batchSize: number;
  /** Fresh judgments this call may spend; cache hits are free. */
  maxFresh: number;
  signal?: AbortSignal;
}

export interface JudgeResult {
  /** passage hash → engine P(true), for every passage judged or cached. */
  scores: Map<string, number>;
  cached: number;
  fresh: number;
  /** Hashes needing a judgment that did not get one, in input order. */
  unchecked: string[];
  interruption: { reason: "budget" | "cancelled" | "engine_failure"; detail: string } | null;
}

/** Support = engine P(true) at or above the configured bar. Nothing else is inferred. */
export const isSupported = (pTrue: number, bar: number): boolean => pTrue >= bar;

/** One judged passage of a paper: the exact unit text sent as `state`, keyed by its hash. */
export interface JudgeUnit {
  text: string;
  hash: string;
}

/** One paper's judged units crossed with the claims citing it. */
export interface GridBundle {
  units: JudgeUnit[];
  claims: string[];
}

/** Paper/claim standing: any bar-meeting score supports; an unscored unit
 *  leaves the question open; otherwise nothing supports. */
export type Verdict = "supported" | "unsupported" | "incomplete";

export interface GridResult {
  /** claimHash → unitHash → engine P(true), for every cell judged or cached. */
  scores: Map<string, Map<string, number>>;
  cached: number;
  fresh: number;
  /** Cells needing a judgment that did not get one, in input order. */
  unchecked: { claimHash: string; hash: string }[];
  interruption: { reason: "budget" | "cancelled" | "engine_failure"; detail: string } | null;
}

/**
 * Fold one paper's unit scores to a verdict: any score at or above the bar
 * supports (via isSupported); else any unscored unit leaves the paper
 * incomplete; else nothing supports. An empty paper supports nothing.
 */
export function paperVerdict(unitHashes: string[], scoreOf: (hash: string) => number | undefined, bar: number): Verdict {
  if (unitHashes.length === 0) return "unsupported";
  let sawUnscored = false;
  for (const hash of unitHashes) {
    const score = scoreOf(hash);
    if (score !== undefined && isSupported(score, bar)) return "supported";
    if (score === undefined) sawUnscored = true;
  }
  return sawUnscored ? "incomplete" : "unsupported";
}

/**
 * Fold paper verdicts to a claim verdict: any unsupported paper sinks the
 * claim; then any incomplete paper leaves it incomplete; else supported.
 * No papers is no support.
 */
export function claimVerdict(papers: Verdict[]): Verdict {
  if (papers.length === 0) return "unsupported";
  if (papers.includes("unsupported")) return "unsupported";
  if (papers.includes("incomplete")) return "incomplete";
  return "supported";
}

/**
 * Judge every (claim, unit) cell of the bundles (V2/V3 grid; the old
 * `judgePassages` path is untouched). Cells run bundle → unit → claim,
 * deduped by (claimHash, unit.hash) (a unit shared by papers is asked once
 * per claim). Engine calls are built per BUNDLE (a paper): rows in unit-major
 * order (unit, then claim), chunked to at most `batchSize` rows; a call never
 * mixes bundles. The judgment cache is read per distinct claim when the
 * identity is non-null; with a null identity nothing is read or written. The
 * first `maxFresh` misses are in budget (cells). Each call runs
 * `engine.run` with rows {state: unit.text, instructions: claim}, over up to
 * `workers` lanes. A number must be finite in [0, 1] or the whole call
 * fails; a RowFailure or a thrown non-cancel error leaves only that call's
 * affected cells unscored (the detail names no submitted text). Successes
 * persist per claim with saveJudgments in one runExclusive. A lane stops only
 * on abort; every unit is attempted once. Precedence: cancelled >
 * engine_failure > budget. VERIFY_ENGINE_MISSING stays a caller decision
 * (engine_failure and no scores).
 */
export async function judgeGrid(o: JudgeOptions, bundles: GridBundle[]): Promise<GridResult> {
  // Cells in input order, deduped: one paper's list is already post-exclusion.
  const seenCells = new Set<string>();
  const cells: { bundle: number; claim: string; claimHash: string; unit: JudgeUnit }[] = [];
  const claimText = new Map<string, string>();
  bundles.forEach((bundle, bundleIdx) => {
    for (const unit of bundle.units) {
      for (const claim of bundle.claims) {
        const claimHash = claimHashOf(claim);
        const key = `${claimHash} ${unit.hash}`;
        if (seenCells.has(key)) continue;
        seenCells.add(key);
        cells.push({ bundle: bundleIdx, claim, claimHash, unit });
        if (!claimText.has(claimHash)) claimText.set(claimHash, claim);
      }
    }
  });
  const scores = new Map<string, Map<string, number>>();
  const setScore = (claimHash: string, hash: string, pTrue: number): void => {
    let byUnit = scores.get(claimHash);
    if (byUnit === undefined) {
      byUnit = new Map();
      scores.set(claimHash, byUnit);
    }
    byUnit.set(hash, pTrue);
  };
  const isScored = (claimHash: string, hash: string): boolean => scores.get(claimHash)?.has(hash) === true;
  const result: GridResult = { scores, cached: 0, fresh: 0, unchecked: [], interruption: null };

  if (o.identity !== null) {
    const byClaim = new Map<string, string[]>();
    for (const cell of cells) {
      const hashes = byClaim.get(cell.claimHash);
      if (hashes === undefined) byClaim.set(cell.claimHash, [cell.unit.hash]);
      else hashes.push(cell.unit.hash);
    }
    for (const [claimHash, hashes] of byClaim) {
      for (const [hash, pTrue] of cachedJudgments(o.db, claimText.get(claimHash)!, o.identity, hashes)) {
        setScore(claimHash, hash, pTrue);
        result.cached++;
      }
    }
  }

  const misses = cells.filter((cell) => !isScored(cell.claimHash, cell.unit.hash));
  const missCells = misses.map((cell) => ({ claimHash: cell.claimHash, hash: cell.unit.hash }));
  // An already-aborted call reports cancellation before touching an engine,
  // even when every judgment is cached: valid cached scores stay.
  if (o.signal?.aborted === true) {
    result.interruption = { reason: "cancelled", detail: "the request was cancelled" };
    result.unchecked = missCells;
    return result;
  }
  if (misses.length === 0) return result;

  // Local binding: the early-abort check above narrows `o.signal?.aborted`
  // for the rest of this scope, so later comparisons use this alias.
  const signal = o.signal;
  let engine: ClaimEngine;
  try {
    engine = o.createEngine();
  } catch (err) {
    result.interruption = { reason: "engine_failure", detail: agentSafeDetail(err, cells.flatMap((cell) => [cell.unit.text, cell.claim])) };
    result.unchecked = missCells;
    return result;
  }

  const budget = misses.slice(0, o.maxFresh);
  const overBudget = misses.slice(o.maxFresh).length > 0;
  // Per-bundle calls in unit-major order (unit, then claim), chunked to at
  // most `batchSize` rows; a call never mixes bundles.
  const byBundle = new Map<number, typeof budget>();
  for (const miss of budget) {
    const group = byBundle.get(miss.bundle);
    if (group === undefined) byBundle.set(miss.bundle, [miss]);
    else group.push(miss);
  }
  const calls: { claims: string[]; units: JudgeUnit[] }[] = [];
  const batch = Math.max(1, o.batchSize);
  for (const group of byBundle.values()) {
    for (let i = 0; i < group.length; i += batch) {
      const slice = group.slice(i, i + batch);
      calls.push({ claims: slice.map((m) => m.claim), units: slice.map((m) => m.unit) });
    }
  }

  let next = 0;
  let cancelled = false;
  let failure: { reason: "engine_failure"; detail: string } | null = null;

  const lane = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted === true) {
        cancelled = true;
        return;
      }
      const index = next++;
      if (index >= calls.length) return;
      const call = calls[index];
      try {
        const out = await engine.run(
          call.claims.map((claim, i) => ({ state: call.units[i].text, instructions: claim })),
          { signal: o.signal },
        );
        // A number must be finite in [0, 1] or the whole call fails; a
        // RowFailure element fails only its own cell (handled below).
        const whole = out.length === call.claims.length && out.every((s) => isRowFailure(s) || (typeof s === "number" && Number.isFinite(s) && s >= 0 && s <= 1));
        if (!whole) {
          failure ??= {
            reason: "engine_failure",
            detail: agentSafeDetail(new EngineError(`invalid engine output: expected ${call.claims.length} score(s)`), [...call.units.map((u) => u.text), ...call.claims]),
          };
          continue; // the lane continues: only this call's cells stay unscored
        }
        const scored: { claim: string; claimHash: string; hash: string; pTrue: number }[] = [];
        call.claims.forEach((claim, i) => {
          const s = out[i];
          if (isRowFailure(s)) {
            failure ??= { reason: "engine_failure", detail: agentSafeDetail(new EngineError(s.failed), [call.units[i].text, claim]) };
            return;
          }
          scored.push({ claim, claimHash: claimHashOf(claim), hash: call.units[i].hash, pTrue: s as number });
        });
        for (const row of scored) {
          setScore(row.claimHash, row.hash, row.pTrue);
          result.fresh++;
        }
        const identity = o.identity;
        if (identity !== null && scored.length > 0) {
          const rowsByClaim = new Map<string, { passageHash: string; pTrue: number }[]>();
          for (const row of scored) {
            const rows = rowsByClaim.get(row.claim);
            if (rows === undefined) rowsByClaim.set(row.claim, [{ passageHash: row.hash, pTrue: row.pTrue }]);
            else rows.push({ passageHash: row.hash, pTrue: row.pTrue });
          }
          await o.queue.runExclusive(() => {
            for (const [claim, rows] of rowsByClaim) saveJudgments(o.db, claim, identity, rows, o.now());
          });
        }
        // A call that resolved completely before the abort was noticed is
        // valid completed work: it stays validated, recorded and cached, and
        // no NEW call dispatches after abort.
        if (signal !== undefined && signal.aborted) {
          cancelled = true;
          return;
        }
      } catch (err) {
        // Cancellation is reported as cancelled, never as an engine failure;
        // any other failure fails only this call's cells and the lane moves on.
        if ((signal !== undefined && signal.aborted) || err instanceof CancelledError) {
          cancelled = true;
          return;
        }
        failure ??= { reason: "engine_failure", detail: agentSafeDetail(err, [...call.units.map((u) => u.text), ...call.claims]) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.workers, calls.length)) }, lane));

  result.unchecked = cells.filter((cell) => !isScored(cell.claimHash, cell.unit.hash)).map((cell) => ({ claimHash: cell.claimHash, hash: cell.unit.hash }));
  result.interruption =
    cancelled || signal?.aborted === true
      ? { reason: "cancelled", detail: "the request was cancelled" }
      : (failure ?? (overBudget ? { reason: "budget", detail: `the per-call limit of ${o.maxFresh} fresh judgments was reached` } : null));
  return result;
}

class InvalidEngineOutput extends Error {}

function validateScores(scores: unknown, expected: number): number[] {
  if (!Array.isArray(scores) || scores.length !== expected) {
    throw new InvalidEngineOutput(`invalid engine output: expected ${expected} score(s), got ${Array.isArray(scores) ? scores.length : typeof scores}`);
  }
  for (const s of scores) {
    if (typeof s !== "number" || !Number.isFinite(s) || s < 0 || s > 1) {
      throw new InvalidEngineOutput(`invalid engine output: score ${JSON.stringify(s)} is not a finite probability in [0, 1]`);
    }
  }
  return scores as number[];
}

/**
 * Judge one claim over whole-section units (V4): an adapter over judgeGrid
 * (one bundle {units, claims:[claim]}) mapped back to today's JudgeResult.
 * The judge seam and stage code are unchanged.
 */
export async function judgeClaimUnits(o: JudgeOptions, claim: string, units: { text: string; hash: string }[]): Promise<JudgeResult> {
  const claimHash = claimHashOf(claim);
  const grid = await judgeGrid(o, units.length === 0 ? [] : [{ units, claims: [claim] }]);
  return {
    scores: grid.scores.get(claimHash) ?? new Map(),
    cached: grid.cached,
    fresh: grid.fresh,
    unchecked: grid.unchecked.map((u) => u.hash),
    interruption: grid.interruption,
  };
}

export async function judgePassages(
  o: JudgeOptions,
  claim: string,
  passages: { text: string; hash: string }[],
): Promise<JudgeResult> {
  const seen = new Set<string>();
  const unique = passages.filter((p) => (seen.has(p.hash) ? false : (seen.add(p.hash), true)));
  const scores = new Map<string, number>();
  if (o.identity !== null) for (const [h, p] of cachedJudgments(o.db, claim, o.identity, unique.map((p) => p.hash))) scores.set(h, p);
  const cached = scores.size;

  const misses = unique.filter((p) => !scores.has(p.hash));
  const budget = misses.slice(0, o.maxFresh);
  const overBudget = misses.slice(o.maxFresh);
  const result: JudgeResult = { scores, cached, fresh: 0, unchecked: [], interruption: null };
  // An already-aborted call reports cancellation before touching an engine
  // (creation can fail and must not masquerade as the cause), even when every
  // judgment is cached: valid cached scores stay, but the abort is disclosed.
  if (o.signal?.aborted === true) {
    result.interruption = { reason: "cancelled", detail: "the request was cancelled" };
    result.unchecked = misses.map((p) => p.hash);
    return result;
  }
  if (misses.length === 0) return result;

  let engine: ClaimEngine;
  try {
    engine = o.createEngine();
  } catch (err) {
    result.interruption = { reason: "engine_failure", detail: agentSafeDetail(err, misses.map((p) => p.text)) };
    result.unchecked = misses.map((p) => p.hash);
    return result;
  }

  const batches: (typeof misses)[] = [];
  for (let i = 0; i < budget.length; i += o.batchSize) batches.push(budget.slice(i, i + o.batchSize));
  const judged = new Set<string>();
  let next = 0;
  let stop: JudgeResult["interruption"] = null;

  const lane = async (): Promise<void> => {
    while (stop === null && next < batches.length) {
      if (o.signal?.aborted) {
        stop = { reason: "cancelled", detail: "the request was cancelled" };
        return;
      }
      const batch = batches[next++];
      try {
        const out = await engine.run(
          batch.map((p) => ({ state: p.text, instructions: claim })),
          { signal: o.signal },
        );
        const failed = out.find(isRowFailure);
        if (failed !== undefined) throw new EngineError(failed.failed);
        const valid = validateScores(out, batch.length);
        batch.forEach((p, i) => {
          scores.set(p.hash, valid[i]);
          judged.add(p.hash);
        });
        result.fresh += batch.length;
        const identity = o.identity;
        if (identity !== null) {
          await o.queue.runExclusive(() => saveJudgments(o.db, claim, identity, batch.map((p, i) => ({ passageHash: p.hash, pTrue: valid[i] })), o.now()));
        }
        // A batch that resolved completely before the abort was noticed is
        // valid completed work: it stays validated, recorded and cached. A
        // rejected or incomplete batch is never cached, and no NEW batch
        // dispatches after abort.
        if (o.signal?.aborted === true) {
          stop = { reason: "cancelled", detail: "the request was cancelled" };
          return;
        }
      } catch (err) {
        // Cancellation is reported as cancelled, never as an engine failure —
        // otherwise a zero-score abort would masquerade as VERIFY_ENGINE_MISSING.
        stop ??= o.signal?.aborted === true || err instanceof CancelledError
          ? { reason: "cancelled", detail: "the request was cancelled" }
          : { reason: "engine_failure", detail: agentSafeDetail(err, batch.map((p) => p.text)) };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.workers, batches.length)) }, lane));

  result.unchecked = misses.filter((p) => !judged.has(p.hash)).map((p) => p.hash);
  result.interruption = stop ?? (overBudget.length > 0 ? { reason: "budget", detail: `the per-call limit of ${o.maxFresh} fresh judgments was reached` } : null);
  return result;
}
