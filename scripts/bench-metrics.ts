/**
 * Pure benchmark metrics for scripts/bench-claim-verify.ts. Everything is
 * recomputed from RAW per-chunk probabilities: nothing here reads a verdict
 * that was fixed at another threshold.
 *
 * Chunk probabilities are `number` (checked) or `null` (not checked: refused
 * over the context limit, engine error, input unavailable). `null` is never
 * treated as a low score — it only ever means "unchecked".
 *
 * Support-oriented metrics are the package's question: does any chunk of the
 * paper support the claim at the bar? A low score abstains; it never refutes.
 * `compatibilityAt` keeps the historical two-sided classification for
 * comparison with docs/benchmarks/ reports and is labelled as such.
 */
import { createHash } from "node:crypto";

export type Label = "TRUE" | "FALSE";
export interface ScoredClaim {
  id: string;
  label: Label;
  /** One entry per chunk of the claim's paper (whole-paper mode: one entry). */
  chunkP: (number | null)[];
}

/** Mann-Whitney AUC with average ranks for ties (perfect 1, reversed 0, all tied 0.5). */
export function aucTieCorrect(items: { score: number; positive: boolean }[]): number | null {
  const n1 = items.filter((x) => x.positive).length;
  const n0 = items.length - n1;
  if (n1 === 0 || n0 === 0) return null;
  const sorted = [...items].sort((a, b) => a.score - b.score);
  let rankSum = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].score === sorted[i].score) j++;
    const avgRank = (i + 1 + (j + 1)) / 2; // ranks are 1-based
    for (let k = i; k <= j; k++) if (sorted[k].positive) rankSum += avgRank;
    i = j + 1;
  }
  return (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}

/** Claim-level support score: the best checked chunk. Null when no chunk was checked. */
export function claimScore(chunkP: (number | null)[]): number | null {
  let best: number | null = null;
  for (const p of chunkP) if (p !== null && (best === null || p > best)) best = p;
  return best;
}

/** Historical aggregate score (supported: best supporting chunk; refuted: weakest refuting chunk; else best). Kept only to compare with old reports. */
export function compatibilityScore(chunkP: (number | null)[], bar: number): number | null {
  const ps = chunkP.filter((p): p is number => p !== null);
  if (ps.length === 0) return null;
  if (ps.some((p) => p >= bar)) return Math.max(...ps.filter((p) => p >= bar));
  if (ps.some((p) => 1 - p >= bar)) return Math.min(...ps.filter((p) => 1 - p >= bar));
  return Math.max(...ps);
}

export interface SupportMetrics {
  bar: number;
  claims: number;
  supported: number;
  truePositives: number;
  falseSupports: number;
  /** null when nothing is supported. */
  supportPrecision: number | null;
  /** supported TRUE claims / all TRUE claims. */
  supportRecall: number | null;
  /** Claims without a support verdict at the bar (includes unchecked claims). */
  abstained: number;
  abstentionRate: number;
  /** Claims with no checked chunk at all. */
  unchecked: number;
  /** Claims whose every chunk was checked. */
  fullyCheckedClaims: number;
  checkedCoverage: number;
  checkedChunks: number;
  totalChunks: number;
  chunkCoverage: number;
}

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

export function supportAt(claims: ScoredClaim[], bar: number): SupportMetrics {
  let supported = 0, tp = 0, fs = 0, unchecked = 0, full = 0, checkedChunks = 0, totalChunks = 0, trues = 0;
  for (const c of claims) {
    if (c.label === "TRUE") trues++;
    const checked = c.chunkP.filter((p) => p !== null).length;
    checkedChunks += checked;
    totalChunks += c.chunkP.length;
    if (checked === 0) unchecked++;
    if (checked === c.chunkP.length && checked > 0) full++;
    const s = claimScore(c.chunkP);
    if (s !== null && s >= bar) {
      supported++;
      c.label === "TRUE" ? tp++ : fs++;
    }
  }
  const n = claims.length;
  return {
    bar,
    claims: n,
    supported,
    truePositives: tp,
    falseSupports: fs,
    supportPrecision: ratio(tp, supported),
    supportRecall: ratio(tp, trues),
    abstained: n - supported,
    abstentionRate: n === 0 ? 0 : (n - supported) / n,
    unchecked,
    fullyCheckedClaims: full,
    checkedCoverage: n === 0 ? 0 : full / n,
    checkedChunks,
    totalChunks,
    chunkCoverage: totalChunks === 0 ? 0 : checkedChunks / totalChunks,
  };
}

export interface CompatibilityMetrics {
  /** Label so no report presents this two-sided number as the support metric. */
  metric: "compatibility-decided-accuracy";
  bar: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  unverified: number;
  dangerous: number;
  decided: number;
  /** null when nothing was decided. */
  decidedAccuracy: number | null;
}

/** Historical two-sided classification: supported = any chunk >= bar; else refuted = any chunk <= 1-bar; else unverified (unchecked claims are unverified). */
export function compatibilityAt(claims: ScoredClaim[], bar: number): CompatibilityMetrics {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const c of claims) {
    const ps = c.chunkP.filter((p): p is number => p !== null);
    const isTrue = c.label === "TRUE";
    if (ps.some((p) => p >= bar)) isTrue ? tp++ : fp++;
    else if (ps.some((p) => 1 - p >= bar)) !isTrue ? tn++ : fn++;
  }
  const decided = tp + fp + tn + fn;
  return {
    metric: "compatibility-decided-accuracy",
    bar,
    tp, fp, tn, fn,
    unverified: claims.length - decided,
    dangerous: fp + fn,
    decided,
    decidedAccuracy: decided ? (tp + tn) / decided : null,
  };
}

/** One row per bar, every number recomputed from the raw chunk probabilities. */
export function sweep(claims: ScoredClaim[], bars: number[]) {
  return bars.map((bar) => ({ bar, support: supportAt(claims, bar), compatibility: compatibilityAt(claims, bar) }));
}

/**
 * Resolve one probability per key from the cache, asking `run` only for the
 * missing keys. `run` receives the missing key INDICES and answers in the same
 * order; results are placed by index, so cached and fresh scores can never
 * shift against each other. `run` is never called with an empty batch.
 * A `null` answer (refused/unavailable) stays null and is not cached by callers.
 */
export async function resolveScores(
  keys: string[],
  cache: Map<string, number>,
  run: (missing: number[]) => Promise<(number | null)[]>,
): Promise<{ scores: (number | null)[]; fresh: number }> {
  const scores: (number | null)[] = keys.map((k) => cache.get(k) ?? null);
  const missing = keys.map((_, i) => i).filter((i) => !cache.has(keys[i]));
  if (missing.length === 0) return { scores, fresh: 0 };
  const answers = await run(missing);
  if (answers.length !== missing.length) {
    throw new Error(`engine answered ${answers.length} rows, expected ${missing.length}`);
  }
  missing.forEach((idx, j) => {
    const p = answers[j];
    if (p !== null && !(Number.isFinite(p) && p >= 0 && p <= 1)) throw new Error(`invalid probability ${String(p)} for key ${keys[idx]}`);
    scores[idx] = p;
  });
  return { scores, fresh: missing.length };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Score-cache key: (engine id, revision, claim hash, chunk hash), delimiter-safe. */
export function scoreKey(engineId: string, revision: string, claimHash: string, chunkHash: string): string {
  return JSON.stringify([engineId, revision, claimHash, chunkHash]);
}
