/**
 * Pure metrics of claim-verification-v2 (docs/plans/2026-10-11-claim-verification-v2-benchmark-plan.md). Everything is recomputed from one
 * score per claim: the highest probability any chunk of the claim's paper received. A claim whose paper could not be checked has a null score:
 * it is never supported and is counted as unchecked, never as a low score.
 */
export interface Item {
  id: string;
  paper: string;
  /** Cross-fit fold of the claim's paper: the bar applied to a fold is fitted on the other folds. */
  fold: number;
  positive: boolean;
  /** Why a negative is a negative (perturbed, fabricated, contradiction, general-knowledge). */
  negType?: string;
  score: number | null;
}

export interface Rates {
  positives: number;
  negatives: number;
  tp: number;
  fp: number;
  recall: number | null;
  falseRate: number | null;
  unchecked: number;
  falseByType: Record<string, { n: number; fp: number; rate: number }>;
}

/**
 * The bar for a false-support rate: a claim is supported when its score is ABOVE the returned threshold, which leaves at most
 * `rate` of the checked negatives supported (ties at the bar are not supported, so the rate can only be met from below). Positives and
 * unchecked negatives play no part. With no checked negative there is nothing to fit against: nothing is supported (Infinity).
 */
export function thresholdForFalseRate(items: Item[], rate: number): number {
  const negatives = items.filter((x) => !x.positive && x.score !== null).map((x) => x.score as number).sort((a, b) => b - a);
  if (negatives.length === 0) return Infinity;
  const allowed = Math.floor(rate * negatives.length + 1e-9);
  return allowed >= negatives.length ? -Infinity : (negatives[allowed] as number);
}

/** Every claim is judged by a bar fitted on the OTHER folds, so no paper helps set the bar that is applied to it. */
export function crossFit(items: Item[], rate: number): { supported: Map<string, boolean>; thresholds: Record<number, number> } {
  const thresholds: Record<number, number> = {};
  const supported = new Map<string, boolean>();
  for (const fold of [...new Set(items.map((x) => x.fold))].sort((a, b) => a - b)) {
    const t = thresholdForFalseRate(items.filter((x) => x.fold !== fold), rate);
    thresholds[fold] = t;
    for (const x of items) if (x.fold === fold) supported.set(x.id, x.score !== null && x.score > t);
  }
  return { supported, thresholds };
}

export function ratesOf(items: Item[], supported: Map<string, boolean>): Rates {
  const positives = items.filter((x) => x.positive);
  const negatives = items.filter((x) => !x.positive);
  const tp = positives.filter((x) => supported.get(x.id) === true).length;
  const fp = negatives.filter((x) => supported.get(x.id) === true).length;
  const falseByType: Rates["falseByType"] = {};
  for (const x of negatives) {
    const key = x.negType ?? "other";
    const cell = (falseByType[key] ??= { n: 0, fp: 0, rate: 0 });
    cell.n += 1;
    if (supported.get(x.id) === true) cell.fp += 1;
    cell.rate = cell.fp / cell.n;
  }
  return {
    positives: positives.length, negatives: negatives.length, tp, fp,
    recall: positives.length > 0 ? tp / positives.length : null,
    falseRate: negatives.length > 0 ? fp / negatives.length : null,
    unchecked: items.filter((x) => x.score === null).length,
    falseByType,
  };
}

/** Supported positives minus `w` per false support, over the positives: `w` is how many misses one false citation is worth. */
export function utility(tp: number, fp: number, positives: number, w: number): number {
  return (tp - w * fp) / positives;
}

/**
 * Mean recall over false-support rates from 0 to `maxFalseRate` (the area under the ROC curve up to that rate, divided by it): 1 for a
 * perfect ranking, 0 for a reversed one, the AUC at a limit of 1. An unchecked claim ranks below everything.
 */
export function partialAuc(items: Item[], maxFalseRate: number): number | null {
  const P = items.filter((x) => x.positive).length;
  const N = items.length - P;
  if (P === 0 || N === 0) return null;
  const groups = new Map<number, { pos: number; neg: number }>();
  for (const x of items) {
    const g = groups.get(x.score ?? -Infinity) ?? { pos: 0, neg: 0 };
    if (x.positive) g.pos += 1;
    else g.neg += 1;
    groups.set(x.score ?? -Infinity, g);
  }
  const points: Array<[number, number]> = [[0, 0]];
  let tp = 0;
  let fp = 0;
  for (const score of [...groups.keys()].sort((a, b) => b - a)) {
    const g = groups.get(score) as { pos: number; neg: number };
    tp += g.pos;
    fp += g.neg;
    points.push([fp / N, tp / P]);
  }
  let area = 0;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1] as [number, number];
    const [x1, y1] = points[i] as [number, number];
    if (x0 >= maxFalseRate) break;
    if (x1 === x0) continue;
    const xc = Math.min(x1, maxFalseRate);
    const yc = y0 + ((y1 - y0) * (xc - x0)) / (x1 - x0);
    area += ((xc - x0) * (y0 + yc)) / 2;
  }
  return area / maxFalseRate;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The statistic on resamples of whole papers (claims of one paper are not independent, so the paper is the unit): as many papers as
 * there are, drawn with replacement, all their claims kept together. The statistic is recomputed on each resample, so a statistic that
 * fits a bar refits it every time.
 */
export function bootstrapByPaper(items: Item[], statistic: (xs: Item[]) => number | null, opts: { draws?: number; seed?: number } = {}): (number | null)[] {
  const byPaper = new Map<string, Item[]>();
  for (const x of items) byPaper.set(x.paper, [...(byPaper.get(x.paper) ?? []), x]);
  const papers = [...byPaper.values()];
  const rand = mulberry32(opts.seed ?? 20261011);
  return Array.from({ length: opts.draws ?? 2000 }, () => statistic(papers.length === 0 ? [] : Array.from({ length: papers.length }, () => papers[Math.floor(rand() * papers.length)] as Item[]).flat()));
}

/** The 2.5th and 97.5th percentile of the draws that have a value. */
export function interval(samples: (number | null)[]): { lo: number; hi: number } | null {
  const xs = samples.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  return { lo: xs[Math.min(xs.length - 1, Math.floor(0.025 * xs.length))] as number, hi: xs[Math.min(xs.length - 1, Math.floor(0.975 * xs.length))] as number };
}

/**
 * The difference of a statistic between two runs of the same claims (candidate minus reference), on resamples of whole papers that are THE SAME
 * for both runs: the claims of a paper are not independent, and neither are two engines' scores on them, so the interval of the difference is
 * much tighter than two separate intervals suggest. A resample where either side has no value gives null.
 */
export function pairedBootstrapByPaper(candidate: Item[], reference: Item[], statistic: (xs: Item[]) => number | null, opts: { draws?: number; seed?: number } = {}): (number | null)[] {
  const group = (items: Item[]): Map<string, Item[]> => {
    const by = new Map<string, Item[]>();
    for (const x of items) by.set(x.paper, [...(by.get(x.paper) ?? []), x]);
    return by;
  };
  const c = group(candidate);
  const r = group(reference);
  const papers = [...c.keys()];
  const rand = mulberry32(opts.seed ?? 20261011);
  return Array.from({ length: opts.draws ?? 2000 }, () => {
    const drawn = papers.length === 0 ? [] : Array.from({ length: papers.length }, () => papers[Math.floor(rand() * papers.length)] as string);
    const a = statistic(drawn.flatMap((p) => c.get(p) ?? []));
    const b = statistic(drawn.flatMap((p) => r.get(p) ?? []));
    return a === null || b === null ? null : a - b;
  });
}
