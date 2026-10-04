/**
 * Evidence-quality metric code (plan: "validate metric code with hand-checkable
 * cases"). Pure functions only — the experiment runner is not exercised here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { locateQuote, overlapChars, summarize, type ClaimRun } from "../scripts/bench-evidence-metrics.ts";

const TEXT = "Intro words here. The fourth is a WiFi CSI dataset with 840 three- channel samples [14]. Together, the pretraining corpus totals roughly 25 000 samples. Later section about masking.";

describe("locateQuote", () => {
  it("finds an exact quote with its character span", () => {
    const q = "Together, the pretraining corpus totals roughly 25 000 samples"; // location is token-based: trailing punctuation is not part of the span
    const at = TEXT.indexOf(q);
    assert.deepEqual(locateQuote(TEXT, q), { start: at, end: at + q.length, coverage: 1 });
  });

  it("tolerates whitespace, line-break and hyphenation differences between extractors", () => {
    const q = "The fourth is a WiFi CSI dataset with 840 threechannel samples [14]";
    const hit = locateQuote(TEXT, q)!;
    assert.ok(hit !== null && hit.coverage >= 0.5);
    assert.ok(TEXT.slice(hit.start, hit.end).includes("WiFi CSI dataset"));
    assert.ok(hit.start >= TEXT.indexOf("The fourth") - 2 && hit.end <= TEXT.indexOf("Together"));
  });

  it("returns null for a quote that is not in the text", () => {
    assert.equal(locateQuote(TEXT, "Quantum chromodynamics describes the strong interaction between quarks."), null);
  });

  it("prefers the densest region when a phrase repeats", () => {
    const t = "alpha beta gamma delta epsilon. " + "filler ".repeat(40) + "alpha beta gamma delta epsilon zeta eta theta iota kappa.";
    const q = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const hit = locateQuote(t, q)!;
    assert.equal(hit.start, t.lastIndexOf("alpha"));
  });

  it("works on non-Latin text and rejects empty input", () => {
    const t = "前置き。電池の寿命は温度が高いほど短くなることが示された。以上。";
    assert.ok(locateQuote(t, "電池の寿命は温度が高いほど短くなることが示された") !== null);
    assert.equal(locateQuote(TEXT, ""), null);
    assert.equal(locateQuote("", "something"), null);
  });
});

describe("overlapChars", () => {
  it("counts shared characters of two half-open spans", () => {
    assert.equal(overlapChars({ start: 0, end: 10 }, { start: 5, end: 20 }), 5);
    assert.equal(overlapChars({ start: 0, end: 10 }, { start: 10, end: 20 }), 0);
    assert.equal(overlapChars({ start: 3, end: 8 }, { start: 0, end: 100 }), 5);
  });
});

describe("summarize", () => {
  const run = (o: Partial<ClaimRun> & Pick<ClaimRun, "label">): ClaimRun => ({ gold: null, candidates: [], evidence: [], freshJudgments: 0, ...o });

  it("hand-checkable: recall, gold-hit precision and false-support rate", () => {
    const runs: ClaimRun[] = [
      // found: candidate contains gold, one evidence overlaps gold, one is extra
      run({ label: "TRUE", gold: { start: 100, end: 200 }, candidates: [{ start: 0, end: 500 }], evidence: [{ start: 120, end: 180 }, { start: 900, end: 950 }], freshJudgments: 10 }),
      // candidate selected, but no evidence returned
      run({ label: "TRUE", gold: { start: 100, end: 200 }, candidates: [{ start: 0, end: 500 }], evidence: [], freshJudgments: 6 }),
      // gold not even among the candidates
      run({ label: "TRUE", gold: { start: 100, end: 200 }, candidates: [{ start: 600, end: 900 }], evidence: [], freshJudgments: 4 }),
      // gold could not be located: excluded from recall, still counted
      run({ label: "TRUE", gold: null, candidates: [], evidence: [{ start: 0, end: 10 }], freshJudgments: 0 }),
      // FALSE claims: one gets (wrong) support, one does not
      run({ label: "FALSE", evidence: [{ start: 1, end: 2 }], freshJudgments: 5 }),
      run({ label: "FALSE", evidence: [], freshJudgments: 5 }),
    ];
    const s = summarize(runs);
    assert.equal(s.trueClaims, 4);
    assert.equal(s.goldLocated, 3);
    assert.equal(s.candidateRecall, 2 / 3);
    assert.equal(s.supportRecall, 1 / 3);
    assert.equal(s.goldHitPrecision, 1 / 2, "of the 2 spans returned for located-gold claims, 1 overlaps gold (extras need independent review)");
    assert.equal(s.meanEvidencePerTrue, (2 + 0 + 0 + 1) / 4);
    assert.equal(s.falseClaims, 2);
    assert.equal(s.falseSupportRate, 0.5);
    assert.equal(s.verifierCalls, 30);
  });

  it("empty and degenerate inputs give null rates, never NaN", () => {
    const s = summarize([]);
    assert.deepEqual([s.trueClaims, s.candidateRecall, s.supportRecall, s.goldHitPrecision, s.falseSupportRate, s.verifierCalls], [0, null, null, null, null, 0]);
    const noEvidence = summarize([{ label: "TRUE", gold: { start: 0, end: 5 }, candidates: [{ start: 0, end: 9 }], evidence: [], freshJudgments: 1 }]);
    assert.equal(noEvidence.goldHitPrecision, null);
    assert.equal(noEvidence.supportRecall, 0);
  });
});
