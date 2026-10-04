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
import type { DatabaseSync } from "node:sqlite";

import type { ClaimEngine } from "./claim.ts";
import { cachedJudgments, saveJudgments, type JudgmentIdentity } from "./store.ts";

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
        const out = validateScores(await engine.run(batch.map((p) => ({ state: p.text, instructions: claim }))), batch.length);
        batch.forEach((p, i) => {
          scores.set(p.hash, out[i]);
          judged.add(p.hash);
        });
        result.fresh += batch.length;
        const identity = o.identity;
        if (identity !== null) {
          await o.queue.runExclusive(() => saveJudgments(o.db, claim, identity, batch.map((p, i) => ({ passageHash: p.hash, pTrue: out[i] })), o.now()));
        }
      } catch (err) {
        stop ??= { reason: "engine_failure", detail: agentSafeDetail(err, batch.map((p) => p.text)) };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.workers, batches.length)) }, lane));

  result.unchecked = misses.filter((p) => !judged.has(p.hash)).map((p) => p.hash);
  result.interruption = stop ?? (overBudget.length > 0 ? { reason: "budget", detail: `the per-call limit of ${o.maxFresh} fresh judgments was reached` } : null);
  return result;
}
