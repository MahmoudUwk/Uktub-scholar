/**
 * claim-verification-v2 scoring and analysis (docs/plans/2026-10-11-claim-verification-v2-benchmark-plan.md): one score per claim from the
 * judgment cache, and the report numbers from those scores. Offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyse, chunkScore, itemOf, pairedVsReference } from "../scripts/bench-claims-v2-score.ts";
import type { Item } from "../scripts/bench-claims-v2-metrics.ts";

describe("the score of one claim", () => {
  it("is the highest probability any chunk of the paper got", () => {
    const judged = new Map([["a", 0.2], ["b", 0.97], ["c", 0.5]]);
    assert.deepEqual(chunkScore(["a", "b", "c"], judged), { score: 0.97, unjudged: 0 });
  });
  it("ignores judgments of text that is not one of the paper's chunks (localization sub-passages)", () => {
    const judged = new Map([["a", 0.2], ["sub", 0.999]]);
    assert.deepEqual(chunkScore(["a"], judged), { score: 0.2, unjudged: 0 });
  });
  it("is null, never a low score, when a chunk was not judged or the paper has no chunks", () => {
    assert.deepEqual(chunkScore(["a", "b"], new Map([["a", 0.99]])), { score: null, unjudged: 1 });
    assert.deepEqual(chunkScore([], new Map()), { score: null, unjudged: 0 });
  });
});

describe("a dataset row as a metrics item", () => {
  it("TRUE is a positive; a FALSE claim keeps the reason it is a negative; the fold comes from the paper", () => {
    assert.deepEqual(itemOf({ id: "v2-a-01", paper: "a", label: "TRUE", type: "numeric" }, 2, 0.4), { id: "v2-a-01", paper: "a", fold: 2, positive: true, score: 0.4 });
    assert.deepEqual(itemOf({ id: "v2-a-07", paper: "a", label: "FALSE", type: "perturbed" }, 1, null), { id: "v2-a-07", paper: "a", fold: 1, positive: false, negType: "perturbed", score: null });
  });
});

describe("the analysis", () => {
  let n = 0;
  const it_ = (paper: string, fold: number, positive: boolean, score: number | null, negType = "fabricated"): Item => ({ id: `x${++n}`, paper, fold, positive, score, ...(positive ? {} : { negType }) });
  // 4 folds x 25 claims: 10 positives with scores .90 to .99, 15 negatives with scores .01 to .15
  const separable: Item[] = [];
  for (let fold = 0; fold < 4; fold++) {
    for (let i = 0; i < 10; i++) separable.push(it_(`p${fold}`, fold, true, (90 + i) / 100));
    for (let i = 0; i < 15; i++) separable.push(it_(`p${fold}`, fold, false, (1 + i) / 100));
  }
  const a = analyse(separable, { draws: 50, seed: 1 });

  it("counts the classes and reports a perfect ranking as AUC and partial AUC of 1", () => {
    assert.deepEqual([a.positives, a.negatives, a.unchecked], [40, 60, 0]);
    assert.equal(a.auc.value, 1);
    assert.equal(a.pauc.value, 1);
  });
  it("supports every positive at a 1 % and a 2 % false-support rate when the classes are separable", () => {
    assert.deepEqual(a.atRate.map((r) => r.rate), [0.01, 0.02]);
    for (const r of a.atRate) assert.deepEqual([r.rates.tp, r.rates.fp, r.rates.recall], [40, 0, 1]);
  });
  it("gives the utility for w = 5, 10 and 20, each with an interval from resampled papers", () => {
    const r = a.atRate[0]!;
    assert.deepEqual(r.utility.map((u) => u.w), [5, 10, 20]);
    for (const u of r.utility) assert.equal(u.value, 1);
    assert.ok(r.recallInterval !== null && r.recallInterval.lo <= 1 && r.recallInterval.hi === 1);
  });
  it("reports the product bar as one more row: a score of exactly 0.99 is supported (the product compares with >=)", () => {
    assert.deepEqual([a.productBar.rates.tp, a.productBar.rates.fp], [4, 0]);
    assert.equal(a.productBar.bar, 0.99);
  });
  it("counts a false support at a bar fitted on other papers, split by negative type, and unchecked claims as misses", () => {
    const items = [...separable, it_("p0", 0, false, 0.5, "perturbed"), it_("p0", 0, true, null)];
    const b = analyse(items, { draws: 20, seed: 1 });
    assert.equal(b.unchecked, 1);
    const r = b.atRate[0]!.rates;
    assert.equal(r.falseByType.perturbed!.fp, 1, "the 0.5 negative of fold 0 beats the bar (0.15) fitted on folds 1 to 3");
    assert.equal(r.tp, 40, "the unchecked positive is not supported");
    assert.equal(r.positives, 41);
  });
});

describe("the ranking against each kind of negative", () => {
  it("is the AUC of the positives against the negatives of one type: a type that outranks a positive scores below 1", () => {
    const items: Item[] = [
      { id: "p1", paper: "a", fold: 0, positive: true, score: 0.9 },
      { id: "p2", paper: "a", fold: 0, positive: true, score: 0.8 },
      { id: "n1", paper: "a", fold: 0, positive: false, negType: "perturbed", score: 0.85 },
      { id: "n2", paper: "a", fold: 0, positive: false, negType: "fabricated", score: 0.1 },
    ];
    assert.deepEqual(analyse(items, { draws: 5, seed: 1 }).aucByType, { fabricated: 1, perturbed: 0.5 });
  });
  it("ranks an unchecked negative last, which is never a false support", () => {
    const items: Item[] = [
      { id: "p1", paper: "a", fold: 0, positive: true, score: 0.9 },
      { id: "n1", paper: "a", fold: 0, positive: false, negType: "general", score: null },
    ];
    assert.deepEqual(analyse(items, { draws: 5, seed: 1 }).aucByType, { general: 1 });
  });
});

describe("a model against the reference model on the same claims", () => {
  const build = (pos: (i: number) => number, neg: (i: number) => number): Item[] => {
    const items: Item[] = [];
    for (let fold = 0; fold < 4; fold++) {
      for (let i = 0; i < 10; i++) items.push({ id: `p${fold}-${i}`, paper: `paper${fold}`, fold, positive: true, score: pos(i) });
      for (let i = 0; i < 15; i++) items.push({ id: `n${fold}-${i}`, paper: `paper${fold}`, fold, positive: false, negType: "perturbed", score: neg(i) });
    }
    return items;
  };
  const separable = build((i) => (90 + i) / 100, (i) => (1 + i) / 100);
  const mixed = build((i) => (50 + i) / 100, (i) => (40 + 2 * i) / 100);
  it("is zero, with a zero-width interval, against itself", () => {
    const d = pairedVsReference(separable, separable, { draws: 50, seed: 1 });
    assert.deepEqual([d.recallAt1.value, d.recallAt2.value, d.auc.value, d.pauc.value], [0, 0, 0, 0]);
    assert.deepEqual([d.recallAt1.interval, d.recallAt2.interval, d.auc.interval, d.pauc.interval], [{ lo: 0, hi: 0 }, { lo: 0, hi: 0 }, { lo: 0, hi: 0 }, { lo: 0, hi: 0 }]);
  });
  it("is positive in recall at 1 % false supports and in AUC for a model that ranks better, with an interval above zero", () => {
    const d = pairedVsReference(separable, mixed, { draws: 100, seed: 1 });
    assert.ok((d.recallAt1.value as number) > 0 && (d.recallAt2.value as number) > 0 && (d.auc.value as number) > 0 && (d.pauc.value as number) > 0, JSON.stringify(d));
    assert.ok((d.auc.interval?.lo as number) > 0);
  });
  it("is negative the other way round", () => {
    const d = pairedVsReference(mixed, separable, { draws: 50, seed: 1 });
    assert.ok((d.recallAt1.value as number) < 0 && (d.auc.value as number) < 0);
  });
});

