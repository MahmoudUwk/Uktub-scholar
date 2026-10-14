/**
 * claim-verification-v2: one score per claim from the registry's judgment cache, and the report numbers computed from those scores
 * (docs/plans/2026-10-11-claim-verification-v2-benchmark-plan.md). Pure; the runner (bench-claims-v2.ts) feeds it.
 */
import { isSupported } from "../src/core/verify/judge.ts";
import { bootstrapByPaper, crossFit, interval, pairedBootstrapByPaper, partialAuc, ratesOf, utility, type Item, type Rates } from "./bench-claims-v2-metrics.ts";

/** The product's support bar (`verification.min_confidence` default): the extra row shows what the current setting returns. */
export const PRODUCT_BAR = 0.99;
/** False-support rates the comparison is made at (plan, metric 1). */
export const FALSE_RATES = [0.01, 0.02];
/** Misses one false citation is worth (plan, metric 3): a grid, not a choice. */
export const PENALTIES = [5, 10, 20];
/** Partial AUC limit (plan, metric 4). */
export const PARTIAL_AUC_LIMIT = 0.05;

/**
 * The highest probability any chunk of the paper got. `judged` holds every judgment of the claim (including localization sub-passages,
 * which are not chunks), so only the paper's own chunk hashes count. A chunk with no judgment, or a paper with no chunk, gives null: an
 * unchecked claim is never a low score.
 */
export function chunkScore(chunkHashes: string[], judged: Map<string, number>): { score: number | null; unjudged: number } {
  const scores = chunkHashes.map((h) => judged.get(h));
  const unjudged = scores.filter((s) => s === undefined).length;
  if (chunkHashes.length === 0 || unjudged > 0) return { score: null, unjudged };
  return { score: Math.max(...(scores as number[])), unjudged: 0 };
}

export function itemOf(claim: { id: string; paper: string; label: "TRUE" | "FALSE"; type: string }, fold: number, score: number | null): Item {
  const positive = claim.label === "TRUE";
  return { id: claim.id, paper: claim.paper, fold, positive, ...(positive ? {} : { negType: claim.type }), score };
}

type Interval = { lo: number; hi: number } | null;
export interface Estimate { value: number | null; interval: Interval }
export interface RateRow {
  rate: number;
  /** The bar fitted on the other folds, per fold. */
  thresholds: Record<number, number>;
  rates: Rates;
  recallInterval: Interval;
  falseRateInterval: Interval;
  utility: { w: number; value: number; interval: Interval }[];
}
export interface Analysis {
  positives: number;
  negatives: number;
  unchecked: number;
  auc: Estimate;
  pauc: Estimate;
  /** AUC of the positives against the negatives of one type: where the ranking fails, not only how often. */
  aucByType: Record<string, number | null>;
  atRate: RateRow[];
  productBar: { bar: number; rates: Rates; utility: { w: number; value: number }[] };
}

/** Every number of the report, each with a paper-level bootstrap interval where it is a statistic of the sample. */
export function analyse(items: Item[], opts: { draws?: number; seed?: number } = {}): Analysis {
  const boot = (statistic: (xs: Item[]) => number | null): Interval => interval(bootstrapByPaper(items, statistic, opts));
  const ratesAt = (xs: Item[], rate: number): Rates => ratesOf(xs, crossFit(xs, rate).supported);
  const util = (r: Rates, w: number): number => (r.positives === 0 ? NaN : utility(r.tp, r.fp, r.positives, w));
  const atRate = FALSE_RATES.map((rate): RateRow => {
    const fit = crossFit(items, rate);
    const rates = ratesOf(items, fit.supported);
    return {
      rate,
      thresholds: fit.thresholds,
      rates,
      recallInterval: boot((xs) => ratesAt(xs, rate).recall),
      falseRateInterval: boot((xs) => ratesAt(xs, rate).falseRate),
      utility: PENALTIES.map((w) => ({ w, value: util(rates, w), interval: boot((xs) => { const r = ratesAt(xs, rate); return r.positives === 0 ? null : util(r, w); }) })),
    };
  });
  const atBar = (xs: Item[]): Rates => ratesOf(xs, new Map(xs.map((x) => [x.id, x.score !== null && isSupported(x.score, PRODUCT_BAR)])));
  const barRates = atBar(items);
  return {
    positives: items.filter((x) => x.positive).length,
    negatives: items.filter((x) => !x.positive).length,
    unchecked: items.filter((x) => x.score === null).length,
    auc: { value: partialAuc(items, 1), interval: boot((xs) => partialAuc(xs, 1)) },
    pauc: { value: partialAuc(items, PARTIAL_AUC_LIMIT), interval: boot((xs) => partialAuc(xs, PARTIAL_AUC_LIMIT)) },
    aucByType: Object.fromEntries([...new Set(items.filter((x) => !x.positive).map((x) => x.negType ?? "other"))].sort().map((t) => [t, partialAuc([...items.filter((x) => x.positive), ...items.filter((x) => !x.positive && (x.negType ?? "other") === t)], 1)])),
    atRate,
    productBar: { bar: PRODUCT_BAR, rates: barRates, utility: PENALTIES.map((w) => ({ w, value: util(barRates, w) })) },
  };
}

export interface Delta { value: number | null; interval: Interval }

/**
 * The difference to a reference model (this minus reference), with paired by-paper intervals: AUC, and the low-false-support region the product works in
 * (partial AUC up to 5 % false supports, recall at 1 % and at 2 %). A model can win the whole ranking and still not be distinguishable where it matters.
 */
export function pairedVsReference(items: Item[], reference: Item[], opts: { draws?: number; seed?: number } = {}): { recallAt1: Delta; recallAt2: Delta; auc: Delta; pauc: Delta } {
  const recallAt = (rate: number) => (xs: Item[]): number | null => ratesOf(xs, crossFit(xs, rate).supported).recall;
  const auc = (xs: Item[]): number | null => partialAuc(xs, 1);
  const delta = (statistic: (xs: Item[]) => number | null): Delta => {
    const a = statistic(items);
    const b = statistic(reference);
    return { value: a === null || b === null ? null : a - b, interval: interval(pairedBootstrapByPaper(items, reference, statistic, opts)) };
  };
  return { recallAt1: delta(recallAt(FALSE_RATES[0] as number)), recallAt2: delta(recallAt(FALSE_RATES[1] as number)), auc: delta(auc), pauc: delta((xs) => partialAuc(xs, PARTIAL_AUC_LIMIT)) };
}

