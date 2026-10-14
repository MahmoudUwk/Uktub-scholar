/**
 * claim-verification-v2 metrics (docs/plans/2026-10-11-claim-verification-v2-benchmark-plan.md): the bar comes from other papers, a miss and a false
 * support are both counted, and every interval resamples whole papers. Offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bootstrapByPaper, pairedBootstrapByPaper, crossFit, interval, partialAuc, ratesOf, thresholdForFalseRate, utility, type Item } from "../scripts/bench-claims-v2-metrics.ts";

let n = 0;
const item = (over: Partial<Item> & { positive: boolean; score: number | null }): Item => ({ id: `c${++n}`, paper: "p1", fold: 0, ...over });
const neg = (score: number | null, over: Partial<Item> = {}) => item({ positive: false, negType: "fabricated", score, ...over });
const pos = (score: number | null, over: Partial<Item> = {}) => item({ positive: true, score, ...over });
const supportedBy = (items: Item[], t: number) => new Map(items.map((x) => [x.id, x.score !== null && x.score > t]));

describe("the bar for a false-support rate", () => {
  const negs = [0.9, 0.8, 0.7, 0.6, 0.5].map((s) => neg(s));
  it("lets through as many negatives as the rate allows and no more: 1 of 5 at a rate of 0.2", () => {
    const t = thresholdForFalseRate(negs, 0.2);
    assert.equal(negs.filter((x) => (x.score as number) > t).length, 1);
  });
  it("a rate of 0 sits above the highest negative", () => {
    const t = thresholdForFalseRate(negs, 0);
    assert.equal(negs.filter((x) => (x.score as number) > t).length, 0);
  });
  it("never exceeds the rate when negatives tie at the bar (ties are not supported)", () => {
    const tied = [0.9, 0.9, 0.5].map((s) => neg(s));
    const t = thresholdForFalseRate(tied, 1 / 3);
    assert.ok(tied.filter((x) => (x.score as number) > t).length / 3 <= 1 / 3);
  });
  it("supports everything when the rate allows every negative, and ignores positives and unchecked negatives when fitting", () => {
    assert.equal(thresholdForFalseRate(negs, 1), -Infinity);
    const t = thresholdForFalseRate([...negs, pos(0.99), neg(null)], 0);
    assert.equal(t, 0.9);
  });
});

describe("the cross-fit", () => {
  it("fits the bar for a fold on the other folds only: a negative that outscores everything is a false support in its own fold", () => {
    const f0 = [neg(0.99, { fold: 0, paper: "a", id: "x0" }), pos(0.95, { fold: 0, paper: "a" })];
    const rest = [0.5, 0.4, 0.3, 0.2].map((s, i) => neg(s, { fold: 1 + (i % 2), paper: `b${i}` }));
    const all = [...f0, ...rest];
    const { supported, thresholds } = crossFit(all, 0);
    assert.equal(thresholds[0], 0.5, "fold 0 is judged by the highest negative of the OTHER folds");
    assert.equal(supported.get("x0"), true, "so its 0.99 negative is supported, as a bar fitted on all the data would have hidden");
    const fitOnAll = thresholdForFalseRate(all, 0);
    assert.ok(fitOnAll >= 0.99, "the bar fitted on everything would have refused it");
  });
  it("gives every item a decision, and unchecked items are never supported", () => {
    const items = [pos(0.9, { fold: 0 }), neg(0.1, { fold: 1 }), pos(null, { fold: 1, paper: "q" })];
    const { supported } = crossFit(items, 0.5);
    assert.equal(supported.size, 3);
    assert.equal(supported.get(items[2]!.id), false);
  });
});

describe("rates", () => {
  const items = [pos(0.95), pos(0.6), pos(null), neg(0.97, { negType: "perturbed" }), neg(0.2, { negType: "perturbed" }), neg(0.1, { negType: "fabricated" }), neg(null, { negType: "fabricated" })];
  const r = ratesOf(items, supportedBy(items, 0.9));
  it("counts supported positives and false supports, and keeps unchecked claims apart", () => {
    assert.deepEqual([r.positives, r.negatives, r.tp, r.fp, r.unchecked], [3, 4, 1, 1, 2]);
    assert.ok(Math.abs((r.recall as number) - 1 / 3) < 1e-12);
    assert.equal(r.falseRate, 0.25);
  });
  it("splits the false-support rate by the reason a claim is a negative", () => {
    assert.deepEqual(r.falseByType.perturbed, { n: 2, fp: 1, rate: 0.5 });
    assert.deepEqual(r.falseByType.fabricated, { n: 2, fp: 0, rate: 0 });
  });
  it("has no recall or rate when a class is empty", () => {
    const only = [pos(0.9)];
    const o = ratesOf(only, supportedBy(only, 0.5));
    assert.deepEqual([o.recall, o.falseRate], [1, null]);
  });
});

describe("utility", () => {
  it("is supported positives minus the penalty per false support, over the positives", () => {
    assert.equal(utility(37, 1, 74, 10), 27 / 74);
    assert.equal(utility(54, 0, 74, 20), 54 / 74);
    assert.equal(utility(0, 3, 74, 5), -15 / 74);
  });
});

describe("partial AUC", () => {
  const set = (p: number[], q: number[]) => [...p.map((s) => pos(s)), ...q.map((s) => neg(s))];
  it("is the mean recall over false-support rates up to the limit: 1 for a perfect ranking, 0 for a reversed one", () => {
    assert.equal(partialAuc(set([0.9, 0.8], [0.2, 0.1]), 0.5), 1);
    assert.equal(partialAuc(set([0.1, 0.2], [0.8, 0.9]), 0.5), 0);
  });
  it("matches a hand-computed curve", () => {
    // ranked 0.9+ 0.8+ 0.7- 0.4+ 0.3-: recall is 2/3 until the first negative; area up to a rate of 0.5 is 1/3, over 0.5
    assert.ok(Math.abs((partialAuc(set([0.9, 0.8, 0.4], [0.7, 0.3]), 0.5) as number) - 2 / 3) < 1e-12);
    assert.ok(Math.abs((partialAuc(set([0.9, 0.8, 0.4], [0.7, 0.3]), 1) as number) - 5 / 6) < 1e-12, "at a limit of 1 it is the AUC");
  });
  it("treats an unchecked claim as ranked last, and has no value without both classes", () => {
    assert.equal(partialAuc([pos(null), neg(0.5)], 1), 0);
    assert.equal(partialAuc([pos(0.9)], 0.5), null);
  });
});

describe("intervals by paper", () => {
  const papers = [item({ positive: true, score: 0.9, paper: "A" }), ...[1, 2, 3].map(() => item({ positive: true, score: 0.9, paper: "B" }))];
  it("resamples whole papers: a paper of one claim and a paper of three give totals of 2, 4 or 6, never 1, 3 or 5", () => {
    const samples = bootstrapByPaper(papers, (xs) => xs.length, { draws: 200, seed: 1 });
    assert.equal(samples.length, 200);
    assert.ok(samples.every((s) => s === 2 || s === 4 || s === 6), JSON.stringify([...new Set(samples)]));
    assert.ok(new Set(samples).size === 3, "all three totals occur");
  });
  it("is reproducible for a seed, differs between seeds, and is a point when there is one paper", () => {
    const stat = (xs: Item[]) => xs.filter((x) => x.paper === "A").length / xs.length;
    const a = bootstrapByPaper(papers, stat, { draws: 100, seed: 7 });
    assert.deepEqual(a, bootstrapByPaper(papers, stat, { draws: 100, seed: 7 }));
    assert.notDeepEqual(a, bootstrapByPaper(papers, stat, { draws: 100, seed: 8 }));
    const one = papers.filter((x) => x.paper === "B");
    assert.deepEqual(interval(bootstrapByPaper(one, (xs) => xs.length, { draws: 50, seed: 3 })), { lo: 3, hi: 3 });
  });
  it("the interval is the 2.5th and 97.5th percentile of the samples and skips draws that have no value", () => {
    const samples: (number | null)[] = [...Array.from({ length: 100 }, (_, i) => i), null, null];
    const iv = interval(samples) as { lo: number; hi: number };
    assert.deepEqual([iv.lo, iv.hi], [2, 97]);
    assert.equal(interval([null, null]), null);
  });
});

describe("paired intervals by paper", () => {
  const mk = (id: string, paper: string, positive: boolean, score: number): Item => ({ id, paper, fold: 0, positive, score });
  const ref = [mk("a1", "A", true, 0.9), mk("b1", "B", true, 0.9), mk("b2", "B", true, 0.9), mk("b3", "B", true, 0.9), mk("n1", "A", false, 0.1)];
  it("resamples the SAME papers for both runs: a statistic that only counts claims never differs between them", () => {
    const draws = pairedBootstrapByPaper(ref, ref.map((x) => ({ ...x, score: 0.5 })), (xs) => xs.length, { draws: 200, seed: 1 });
    assert.ok(draws.every((d) => d === 0), JSON.stringify([...new Set(draws)]));
  });
  it("is the candidate's statistic minus the reference's, recomputed on every resample", () => {
    const better = ref.map((x) => (x.positive ? { ...x, score: 0.95 } : x));
    const stat = (xs: Item[]) => { const p = xs.filter((x) => x.positive); return p.length === 0 ? null : p.reduce((s, x) => s + (x.score as number), 0) / p.length; };
    const draws = pairedBootstrapByPaper(better, ref, stat, { draws: 100, seed: 2 });
    assert.ok(draws.every((d) => d === null || Math.abs(d - 0.05) < 1e-9));
    assert.deepEqual(interval(draws)!.lo > 0.049, true);
  });
  it("is null on a resample where either side has no value, and reproducible for a seed", () => {
    const stat = (xs: Item[]) => (xs.some((x) => x.paper === "A") ? 1 : null);
    const d1 = pairedBootstrapByPaper(ref, ref, stat, { draws: 50, seed: 3 });
    assert.ok(d1.some((d) => d === null) && d1.some((d) => d === 0));
    assert.deepEqual(d1, pairedBootstrapByPaper(ref, ref, stat, { draws: 50, seed: 3 }));
  });
});

