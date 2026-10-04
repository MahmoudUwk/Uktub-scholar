/**
 * Benchmark metric spec: hand-checkable cases for the pure functions behind
 * scripts/bench-claim-verify.ts. Covers tie-correct AUC, support-oriented
 * metrics recomputed from raw scores, the labelled two-sided compatibility
 * metric, mixed cached/fresh alignment, empty fresh batches, and threshold
 * sweeps that never reuse verdicts fixed at another bar. Fully offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aucTieCorrect,
  claimScore,
  compatibilityAt,
  compatibilityScore,
  resolveScores,
  scoreKey,
  supportAt,
  sweep,
  type ScoredClaim,
} from "../scripts/bench-metrics.ts";

const pos = (score: number) => ({ score, positive: true });
const neg = (score: number) => ({ score, positive: false });

describe("aucTieCorrect", () => {
  it("perfect separation is 1.0 and reversed is 0.0", () => {
    assert.equal(aucTieCorrect([pos(0.9), pos(0.8), neg(0.2), neg(0.1)]), 1);
    assert.equal(aucTieCorrect([neg(0.9), neg(0.8), pos(0.2), pos(0.1)]), 0);
  });

  it("all scores tied is 0.5 whatever the input order", () => {
    assert.equal(aucTieCorrect([pos(0.5), pos(0.5), neg(0.5), neg(0.5)]), 0.5);
    assert.equal(aucTieCorrect([neg(0.5), neg(0.5), pos(0.5), pos(0.5)]), 0.5);
  });

  it("mixed ties count half: pairs 1 + 1 + 0.5 + 1 over 4 = 0.875", () => {
    assert.equal(aucTieCorrect([pos(0.9), pos(0.5), neg(0.5), neg(0.1)]), 0.875);
    assert.equal(aucTieCorrect([neg(0.1), neg(0.5), pos(0.5), pos(0.9)]), 0.875);
  });

  it("a single class has no AUC", () => {
    assert.equal(aucTieCorrect([pos(0.9), pos(0.1)]), null);
    assert.equal(aucTieCorrect([]), null);
  });
});

describe("claimScore", () => {
  it("is the maximum checked chunk probability; unchecked chunks never count as zero", () => {
    assert.equal(claimScore([0.2, 0.7, null]), 0.7);
    assert.equal(claimScore([null, null]), null);
    assert.equal(claimScore([]), null);
  });
});

// A TRUE supported; B TRUE abstains; C FALSE falsely supported; D FALSE low score;
// E TRUE never checked; F FALSE partly checked.
const claims: ScoredClaim[] = [
  { id: "A", label: "TRUE", chunkP: [0.2, 0.995] },
  { id: "B", label: "TRUE", chunkP: [0.5] },
  { id: "C", label: "FALSE", chunkP: [0.991, 0.1] },
  { id: "D", label: "FALSE", chunkP: [0.01] },
  { id: "E", label: "TRUE", chunkP: [null, null] },
  { id: "F", label: "FALSE", chunkP: [0.3, null] },
];

describe("supportAt (support-oriented, from raw scores)", () => {
  it("counts false supports, precision, recall, abstention and checked coverage at 0.99", () => {
    const s = supportAt(claims, 0.99);
    assert.equal(s.bar, 0.99);
    assert.equal(s.supported, 2);
    assert.equal(s.truePositives, 1);
    assert.equal(s.falseSupports, 1);
    assert.equal(s.supportPrecision, 0.5);
    assert.equal(s.supportRecall, 1 / 3);
    assert.equal(s.abstained, 4);
    assert.equal(s.abstentionRate, 4 / 6);
    assert.equal(s.unchecked, 1);
    assert.equal(s.fullyCheckedClaims, 4);
    assert.equal(s.checkedCoverage, 4 / 6);
    assert.equal(s.checkedChunks, 7);
    assert.equal(s.totalChunks, 10);
    assert.equal(s.chunkCoverage, 0.7);
  });

  it("precision is null when nothing is supported (no 0/0 coerced to a number)", () => {
    const s = supportAt([{ id: "x", label: "TRUE", chunkP: [0.4] }], 0.99);
    assert.equal(s.supported, 0);
    assert.equal(s.supportPrecision, null);
    assert.equal(s.supportRecall, 0);
  });

  it("a low score is abstention, never refutation", () => {
    const s = supportAt([{ id: "d", label: "FALSE", chunkP: [0.001] }], 0.99);
    assert.equal(s.abstained, 1);
    assert.equal(s.falseSupports, 0);
  });
});

describe("compatibilityAt (labelled two-sided historical metric)", () => {
  it("decides refuted at <= 1-bar and scores accuracy over decided claims only", () => {
    const c = compatibilityAt(claims, 0.99);
    assert.equal(c.metric, "compatibility-decided-accuracy");
    assert.deepEqual([c.tp, c.fp, c.tn, c.fn], [1, 1, 1, 0]);
    assert.equal(c.decided, 3);
    assert.equal(c.unverified, 3);
    assert.equal(c.dangerous, 1);
    assert.equal(c.decidedAccuracy, 2 / 3);
  });

  it("decided accuracy is null (not 0) when nothing is decided", () => {
    const c = compatibilityAt([{ id: "u", label: "TRUE", chunkP: [0.5] }], 0.99);
    assert.equal(c.decided, 0);
    assert.equal(c.decidedAccuracy, null);
  });

  it("supported wins over refuted when chunks disagree", () => {
    const c = compatibilityAt([{ id: "m", label: "TRUE", chunkP: [0.999, 0.001] }], 0.99);
    assert.deepEqual([c.tp, c.tn, c.fn], [1, 0, 0]);
  });
});

describe("compatibilityScore (historical aggregate, for old-report comparison only)", () => {
  it("supported: best supporting chunk; refuted: weakest refuting chunk; else best; unchecked ignored", () => {
    assert.equal(compatibilityScore([0.995, 0.5], 0.99), 0.995);
    assert.equal(compatibilityScore([0.001, 0.5], 0.99), 0.001);
    assert.equal(compatibilityScore([0.5, 0.6], 0.99), 0.6);
    assert.equal(compatibilityScore([null, 0.6], 0.99), 0.6);
    assert.equal(compatibilityScore([null], 0.99), null);
  });
});

describe("sweep (recomputed from raw per-chunk probabilities)", () => {
  it("ignores stale verdicts stored from another bar", () => {
    const stale = claims.map((c) => ({ ...c, verdict: "unverified" }));
    const rows = sweep(stale, [0.5, 0.99]);
    assert.equal(rows.length, 2);
    const at50 = rows[0].support;
    // 0.5: A (0.995), B (0.5, inclusive) and C (0.991) are supported.
    assert.equal(at50.supported, 3);
    assert.equal(at50.truePositives, 2);
    assert.equal(at50.falseSupports, 1);
    assert.equal(at50.supportPrecision, 2 / 3);
    assert.equal(at50.supportRecall, 2 / 3);
    assert.equal(rows[1].support.supported, 2);
    assert.equal(rows[1].compatibility.decided, 3);
    assert.equal(rows[0].compatibility.bar, 0.5);
  });
});

describe("resolveScores (cache merge)", () => {
  it("aligns mixed cached and fresh chunks by chunk, not by position in the missing list", async () => {
    const keys = ["k0", "k1", "k2", "k3"];
    const cache = new Map([["k0", 0.11], ["k2", 0.33]]);
    let asked: number[] = [];
    const out = await resolveScores(keys, cache, async (missing) => {
      asked = missing;
      return missing.map((i) => 0.5 + i / 100); // k1 -> 0.51, k3 -> 0.53
    });
    assert.deepEqual(asked, [1, 3]);
    assert.deepEqual(out.scores, [0.11, 0.51, 0.33, 0.53]);
    assert.equal(out.fresh, 2);
  });

  it("never calls the engine for an empty fresh batch", async () => {
    const cache = new Map([["k0", 0.2], ["k1", 0.4]]);
    const out = await resolveScores(["k0", "k1"], cache, async (missing) => {
      if (missing.length === 0) throw new TypeError("verifyPairsParallel crashes on an empty batch");
      return missing.map(() => 0);
    });
    assert.deepEqual(out.scores, [0.2, 0.4]);
    assert.equal(out.fresh, 0);
  });

  it("keeps refused chunks as null (unchecked) and does not alias them to cached values", async () => {
    const out = await resolveScores(["a", "b"], new Map([["a", 0.9]]), async () => [null]);
    assert.deepEqual(out.scores, [0.9, null]);
  });

  it("rejects a wrong-length or non-finite engine reply instead of misaligning", async () => {
    await assert.rejects(resolveScores(["a", "b"], new Map(), async () => [0.1]), /expected 2/);
    await assert.rejects(resolveScores(["a"], new Map(), async () => [Number.NaN]), /invalid probability/);
    await assert.rejects(resolveScores(["a"], new Map(), async () => [1.2]), /invalid probability/);
  });
});

describe("scoreKey", () => {
  it("separates engine, revision, claim and chunk without delimiter collisions", () => {
    const base = scoreKey("e", "r", "c", "h");
    assert.notEqual(base, scoreKey("e2", "r", "c", "h"));
    assert.notEqual(base, scoreKey("e", "r2", "c", "h"));
    assert.notEqual(base, scoreKey("e", "r", "c2", "h"));
    assert.notEqual(base, scoreKey("e", "r", "c", "h2"));
    assert.notEqual(scoreKey("a:b", "c", "d", "e"), scoreKey("a", "b:c", "d", "e"));
  });
});
