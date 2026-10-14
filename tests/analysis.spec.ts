/**
 * Tests for scripts/live/analysis.ts: the acceptance-decision and power-planning module.
 * PLAN.md rev 3, section 4.7: pooled bad-row rate, note-cluster bootstrap and linearized
 * CIs, Korn-Graubard FDR interval, beta-binomial simulation, grader agreement.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  agreement,
  bootstrapCI,
  clopperPearson,
  deff,
  fitBetaBinomial,
  kornGraubard,
  linearizedCI,
  passesOD1,
  pooledRate,
  simulate,
  tQuantile,
  type GradeLabel,
  type NoteCount,
} from "../scripts/live/analysis.ts";

const ARCHIVED: NoteCount[] = [
  { id: "n01", bad: 5, rows: 44 },
  { id: "n02", bad: 7, rows: 49 },
  { id: "n03", bad: 2, rows: 49 },
  { id: "n04", bad: 6, rows: 62 },
  { id: "n05", bad: 1, rows: 30 },
  { id: "n06", bad: 7, rows: 49 },
  { id: "n07", bad: 2, rows: 54 },
  { id: "n08", bad: 0, rows: 45 },
  { id: "n09", bad: 2, rows: 50 },
  { id: "n10", bad: 6, rows: 47 },
  { id: "n11", bad: 2, rows: 50 },
  { id: "n12", bad: 2, rows: 65 },
];

describe("tQuantile", () => {
  it("matches textbook 0.975 quantiles", () => {
    assert.ok(Math.abs(tQuantile(0.975, 4) - 2.776445) < 1e-6);
    assert.ok(Math.abs(tQuantile(0.975, 11) - 2.200985) < 1e-6);
    assert.ok(Math.abs(tQuantile(0.975, 14) - 2.144787) < 1e-6);
  });

  it("is symmetric about 0.5 and zero at the median", () => {
    assert.equal(tQuantile(0.5, 7), 0);
    assert.ok(Math.abs(tQuantile(0.025, 9) + tQuantile(0.975, 9)) < 1e-12);
  });
});

describe("clopperPearson", () => {
  it("x=0, n=36: lower 0, upper 1-0.025^(1/36)", () => {
    const cp = clopperPearson(0, 36);
    assert.equal(cp.lower, 0);
    assert.ok(Math.abs(cp.upper - (1 - Math.pow(0.025, 1 / 36))) < 1e-9);
  });

  it("x=n=36: lower 0.025^(1/36), upper 1", () => {
    const cp = clopperPearson(36, 36);
    assert.ok(Math.abs(cp.lower - Math.pow(0.025, 1 / 36)) < 1e-9);
    assert.equal(cp.upper, 1);
  });
});

describe("pooledRate and passesOD1", () => {
  it("pools bad/rows over notes", () => {
    assert.equal(pooledRate(ARCHIVED), 42 / 594);
  });

  it("OD1 passes iff pooled <= 0.05 and CI upper <= 0.10", () => {
    assert.equal(passesOD1(0.04, 0.09), true);
    assert.equal(passesOD1(0.05, 0.1), true);
    assert.equal(passesOD1(0.051, 0.09), false);
    assert.equal(passesOD1(0.04, 0.101), false);
  });
});

describe("bootstrapCI", () => {
  it("is deterministic under a seed and matches the pooled rate", () => {
    const a = bootstrapCI(ARCHIVED, { replicates: 500, seed: 7 });
    const b = bootstrapCI(ARCHIVED, { replicates: 500, seed: 7 });
    assert.deepEqual(a, b);
    assert.equal(a.pooled, 42 / 594);
    assert.ok(a.lower <= a.pooled && a.pooled <= a.upper);
  });

  it("differs across seeds on dispersed data", () => {
    const a = bootstrapCI(ARCHIVED, { replicates: 500, seed: 7 });
    const b = bootstrapCI(ARCHIVED, { replicates: 500, seed: 8 });
    assert.ok(a.lower !== b.lower || a.upper !== b.upper);
  });
});

describe("linearizedCI and deff", () => {
  it("centres on the pooled rate with a t(n-1) margin", () => {
    const ci = linearizedCI(ARCHIVED);
    assert.equal(ci.pooled, 42 / 594);
    assert.ok(ci.lower < ci.pooled && ci.pooled < ci.upper);
    assert.ok(ci.upper - ci.pooled > 0 && ci.upper <= 1 && ci.lower >= 0);
  });

  it("floors DEFF at 1 on underdispersed data", () => {
    const flat: NoteCount[] = [
      { id: "a", bad: 2, rows: 20 },
      { id: "b", bad: 2, rows: 20 },
      { id: "c", bad: 2, rows: 20 },
    ];
    assert.equal(deff(flat), 1);
  });

  it("uses DEFF 1 with zero bad rows (Korn-Graubard stays valid)", () => {
    const zero: NoteCount[] = [
      { id: "a", bad: 0, rows: 10 },
      { id: "b", bad: 0, rows: 10 },
    ];
    assert.equal(deff(zero), 1);
    const kg = kornGraubard(zero);
    assert.equal(kg.lower, 0);
    assert.ok(Math.abs(kg.upper - (1 - Math.pow(0.025, 1 / 20))) < 1e-9);
  });
});

describe("agreement", () => {
  // Hand-computed 2x2: a=8 both bad, b=2 A-only, c=4 B-only, d=86 neither (N=100).
  const inA = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const inB = new Set([0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13]);
  const label = (bad: Set<number>): GradeLabel[] =>
    Array.from({ length: 100 }, (_, i) => ({ note: "n", unit: `u${i}`, bad: bad.has(i) }));
  const A = label(inA);
  const B = label(inB);

  it("matches the hand-computed PA, kappa, observed agreement and gap", () => {
    const m = agreement(A, B);
    assert.deepEqual({ a: m.a, b: m.b, c: m.c, d: m.d }, { a: 8, b: 2, c: 4, d: 86 });
    assert.ok(Math.abs(m.paBad - 16 / 22) < 1e-12);
    assert.ok(Math.abs(m.observed - 0.94) < 1e-12);
    assert.ok(Math.abs(m.kappa - 0.136 / 0.196) < 1e-12);
    assert.ok(Math.abs(m.gap - 0.02) < 1e-12);
    assert.ok(Math.abs(m.rateA - 0.1) < 1e-12 && Math.abs(m.rateB - 0.12) < 1e-12);
  });

  it("rejects unpaired label sets", () => {
    assert.throws(() => agreement(A, B.slice(1)));
  });
});

describe("fitBetaBinomial", () => {
  it("gives rho 0 on constant per-note rates", () => {
    const flat: NoteCount[] = [
      { id: "a", bad: 2, rows: 20 },
      { id: "b", bad: 2, rows: 20 },
      { id: "c", bad: 2, rows: 20 },
      { id: "d", bad: 2, rows: 20 },
    ];
    const fit = fitBetaBinomial(flat);
    assert.ok(Math.abs(fit.mean - 0.1) < 1e-12);
    assert.equal(fit.rho, 0);
  });

  it("matches a hand-computed rho on 0/20, 10/20, 5/20", () => {
    // p = 0, 0.5, 0.25; m = 0.25; v = 0.0625; binomial mean = 0.009375;
    // vBeta = 0.053125; rho = 0.053125 / 0.1875 = 17/60.
    const notes: NoteCount[] = [
      { id: "a", bad: 0, rows: 20 },
      { id: "b", bad: 10, rows: 20 },
      { id: "c", bad: 5, rows: 20 },
    ];
    const fit = fitBetaBinomial(notes);
    assert.ok(Math.abs(fit.mean - 0.25) < 1e-12);
    assert.ok(Math.abs(fit.rho - 17 / 60) < 1e-9);
  });
});

describe("simulate", () => {
  it("returns the full grid with probabilities in range", () => {
    const tiny: NoteCount[] = [
      { id: "a", bad: 3, rows: 40 },
      { id: "b", bad: 1, rows: 50 },
      { id: "c", bad: 4, rows: 45 },
      { id: "d", bad: 2, rows: 55 },
    ];
    const r = simulate(tiny, { reps: 10, seed: 1, rates: [0.05], ns: [12], deltas: [0.05], bootReplicates: 200 });
    assert.equal(r.coverage.length, 2 * 1 * 1);
    assert.equal(r.pPass.length, 2 * 1 * 1);
    assert.equal(r.abSize.length, 1);
    for (const c of r.coverage) assert.ok(c.coverage >= 0 && c.coverage <= 1);
    for (const p of r.pPass) assert.ok(p.pPass >= 0 && p.pPass <= 1);
    assert.ok(r.abSize[0] !== undefined && (r.abSize[0]?.nPerArm ?? 0) >= 2);
  });
});
