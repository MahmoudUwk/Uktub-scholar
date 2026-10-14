/**
 * claim-verification-v2 report (docs/plans/2026-10-11-claim-verification-v2-benchmark-plan.md): what a reader sees of a run, from its
 * results file alone. Offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parityOf, renderReport, restrictTo, timingOf, verdictAgreement, type ResultsFile } from "../scripts/bench-claims-v2-report.ts";
import type { RunRecord } from "../scripts/bench-claims-v2.ts";

let n = 0;
const rec = (over: Partial<RunRecord> & Pick<RunRecord, "label" | "score">): RunRecord => ({
  id: `c${++n}`, paper: `p${n % 8}`, type: over.label === "TRUE" ? "reworded" : "fabricated", fold: n % 4, unjudged: 0, chunks: 50,
  supportFound: over.score !== null && over.score >= 0.99, fresh: 50, cached: 0, localizationFresh: 0, wallMs: 40_000, refused: null, ...over,
});

const records: RunRecord[] = [];
for (let i = 0; i < 40; i++) records.push(rec({ label: "TRUE", score: i < 30 ? 0.995 : 0.3 })); // 30 supported at the product bar
for (let i = 0; i < 40; i++) records.push(rec({ label: "FALSE", score: i === 0 ? 0.999 : 0.05, type: i === 0 ? "perturbed" : "fabricated" }));
const results: ResultsFile = {
  schema: "bench-claims-v2/1", date: "2026-10-12", engine: "eos-onnx", device: "cpu", label: "eos-onnx-cpu",
  identity: { model: "eos-onnx:m@r", protocol: "decision2-noul-v1", minConfidence: 0.99 }, commit: "abc1234", dirty: false,
  dataset: { claimsSha256: "ff00", corpusSha256: "ee00", papers: 8, claims: 80, stride: 1, offset: 0 },
  chunking: { chunk_tokens: 512, overlap_tokens: 0, chars_per_token: 2.8, boundary: "section" }, maxJudgmentsRaisedFrom: 120,
  machine: { cpu: "Test CPU", cores: 24, memoryGb: 32, node: "v26" }, run: { startedAt: "2026-10-12T00:00:00Z", loadavgStart: [1, 1, 1], loadavgEnd: [2, 2, 2], seconds: 3200 },
  records,
};

describe("timing", () => {
  it("gives seconds per claim and per judgment, localization checks counted as judgments", () => {
    const t = timingOf([rec({ label: "TRUE", score: 1, wallMs: 10_000, fresh: 8, localizationFresh: 2 }), rec({ label: "TRUE", score: 1, wallMs: 30_000, fresh: 20, localizationFresh: 0 })]);
    assert.equal(t.meanClaimS, 20);
    assert.equal(t.medianClaimS, 20);
    assert.equal(t.secondsPerJudgment, 40 / 30);
    assert.equal(t.meanChunks, 50);
  });
  it("counts reused judgments as no work", () => {
    assert.equal(timingOf([rec({ label: "TRUE", score: 1, wallMs: 1000, fresh: 0, cached: 50 })]).secondsPerJudgment, null);
  });
});

describe("agreement of the product's own verdict with the score", () => {
  it("counts the claims where `supportFound` is not `score >= bar`, a check that the scores read back are the ones the product used", () => {
    const rs = [rec({ label: "TRUE", score: 0.995 }), rec({ label: "TRUE", score: 0.5 }), rec({ label: "FALSE", score: 0.995, supportFound: false })];
    assert.deepEqual(verdictAgreement(rs, 0.99), { agree: 2, total: 3, disagreeing: [rs[2]!.id] });
  });
});

describe("the report", () => {
  const md = renderReport([results], { draws: 100, seed: 1 });
  it("names the engine, device, commit and dataset hash so a number can be traced", () => {
    for (const s of ["eos-onnx-cpu", "abc1234", "ff00", "Test CPU", "2026-10-12"]) assert.ok(md.includes(s), s);
  });
  it("shows the recall and false-support rate at 1 % and 2 % with intervals, and the utility grid for w = 5, 10, 20", () => {
    assert.match(md, /1 % of negatives/);
    assert.match(md, /2 % of negatives/);
    assert.match(md, /w = 5/);
    assert.match(md, /w = 20/);
    assert.match(md, /\d+\.\d%.*\(\d+\.\d–\d+\.\d\)/, "a percentage with its interval");
  });
  it("shows what the product bar returns on this set: 30 of 40 positives and 1 of 40 negatives", () => {
    assert.match(md, /product bar 0\.99[^\n]*\|\s*30\s*\|\s*1\s*\|/i);
  });
  it("breaks the false supports down by negative type and states that no support found is not a finding of falsehood", () => {
    assert.match(md, /perturbed/);
    assert.match(md, /not a finding that a claim is false/i);
  });
  it("gives the ranking against each type of negative, so a type the engine cannot tell from a positive shows", () => {
    assert.match(md, /\| perturbed \| 1 \| 0\.000 \|/, "the one perturbed negative outscores every positive");
    assert.match(md, /\| fabricated \| 39 \| 1\.000 \|/);
  });
  it("warns, in the report itself, when claims were not checked or the machine was busy", () => {
    const bad = renderReport([{ ...results, records: [...records, rec({ label: "TRUE", score: null, unjudged: 3 })], run: { ...results.run, loadavgStart: [20, 20, 20] } }], { draws: 20, seed: 1 });
    assert.match(bad, /1 claim\(s\) could not be checked/);
    assert.match(bad, /load average/i);
  });
  it("says when the claims were chosen by id rather than sampled, so no accuracy is read off them", () => {
    const sel = renderReport([{ ...results, dataset: { ...results.dataset, selection: "40 claims chosen by id from near-bar-negatives.json" } }], { draws: 20, seed: 1 });
    assert.match(sel, /selection, not a sample/i);
    assert.match(sel, /near-bar-negatives\.json/);
    assert.doesNotMatch(md, /selection, not a sample/i);
  });
  it("labels a subset run as a subset", () => {
    const sub = renderReport([{ ...results, dataset: { ...results.dataset, stride: 4 } }], { draws: 20, seed: 1 });
    assert.match(sub, /subset/i);
  });
});

describe("agreement between two runs of the same claims", () => {
  const a = [rec({ id: "x1", label: "TRUE", score: 0.9906 }), rec({ id: "x2", label: "TRUE", score: 0.5 }), rec({ id: "x3", label: "FALSE", score: 0.3 }), rec({ id: "only-a", label: "TRUE", score: 0.9 }), rec({ id: "x4", label: "TRUE", score: null })];
  const b = [rec({ id: "x1", label: "TRUE", score: 0.9888 }), rec({ id: "x2", label: "TRUE", score: 0.55 }), rec({ id: "x3", label: "FALSE", score: 0.3 }), rec({ id: "only-b", label: "TRUE", score: 0.9 }), rec({ id: "x4", label: "TRUE", score: 0.7 })];
  const p = parityOf(a, b, 0.99);
  it("compares only the claims both runs scored, and counts the ones whose decision at the bar flips", () => {
    assert.equal(p.n, 3, "x4 has no score in the first run, only-a and only-b are in one run");
    assert.deepEqual(p.flips, [{ id: "x1", a: 0.9906, b: 0.9888 }]);
  });
  it("gives the mean and largest score difference", () => {
    assert.ok(Math.abs(p.meanAbsDiff - (0.0018 + 0.05 + 0) / 3) < 1e-9);
    assert.ok(Math.abs(p.maxAbsDiff - 0.05) < 1e-9);
  });
  it("is part of the report when two runs are given, and names which run the other is compared with", () => {
    const second: ResultsFile = { ...results, label: "other-run", records: records.map((r) => ({ ...r })) };
    const md = renderReport([results, second], { draws: 20, seed: 1 });
    assert.match(md, /Agreement of other-run with eos-onnx-cpu/);
    assert.match(md, /80 claims/);
    assert.doesNotMatch(renderReport([results], { draws: 20, seed: 1 }), /Agreement of/);
  });
});

describe("limiting a run to the claims of another", () => {
  it("keeps only those claims, says so in the label, and updates the claim count", () => {
    const ids = new Set(records.slice(0, 10).map((r) => r.id));
    const r = restrictTo(results, ids, "(the same 10 claims)");
    assert.equal(r.records.length, 10);
    assert.equal(r.dataset.claims, 10);
    assert.equal(r.label, "eos-onnx-cpu (the same 10 claims)");
    assert.match(r.dataset.selection ?? "", /10 claims/, "a restricted run is a selection, so its accuracy tables are left out");
    assert.equal(results.records.length, 80, "the original is untouched");
  });
});

describe("accuracy tables of a run that covers only some claims", () => {
  const section = (md: string, heading: string): string => (md.split(/^## /m).find((x) => x.startsWith(heading)) ?? "");
  const subset: ResultsFile = { ...results, label: "subset-run", dataset: { ...results.dataset, stride: 4 }, records: records.filter((_, i) => i % 4 === 0) };
  const picked: ResultsFile = { ...results, label: "picked-run", dataset: { ...results.dataset, selection: "20 claims chosen by id from x.json" }, records: records.slice(40, 60) };
  const md = renderReport([results, subset, picked], { draws: 20, seed: 1 });
  it("are left out: ranking, fitted-bar and by-type tables list only the runs that cover the dataset", () => {
    for (const h of ["Ranking", "Bar fitted for a false-support rate of 1 %", "Bar fitted for a false-support rate of 2 %", "False supports by the reason"]) {
      const body = section(md, h);
      assert.ok(body.includes("eos-onnx-cpu"), `${h}: the full run is there`);
      assert.ok(!body.includes("subset-run") && !body.includes("picked-run"), `${h}: no accuracy of a subset or a selection`);
    }
  });
  it("show their cost, and their agreement with the first run as counts at the bar on the SAME claims (the product-bar table is for full runs only: counts over different claims must not sit side by side)", () => {
    assert.ok(!section(md, "What the product bar returns").includes("subset-run"));
    assert.ok(section(md, "Cost").includes("picked-run"));
    assert.match(md, /Agreement of subset-run with eos-onnx-cpu/);
    assert.match(md, /positives supported 8 \(eos-onnx-cpu\) and 8 \(subset-run\) of 10; negatives supported 1 and 1 of 10/);
  });
  it("count, for claims the two runs both scored, the positives and negatives each supports at the bar", () => {
    const a = [rec({ id: "t1", label: "TRUE", score: 0.995 }), rec({ id: "t2", label: "TRUE", score: 0.995 }), rec({ id: "f1", label: "FALSE", score: 0.995 }), rec({ id: "f2", label: "FALSE", score: 0.1 })];
    const b = [rec({ id: "t1", label: "TRUE", score: 0.995 }), rec({ id: "t2", label: "TRUE", score: 0.98 }), rec({ id: "f1", label: "FALSE", score: 0.98 }), rec({ id: "f2", label: "FALSE", score: 0.1 })];
    assert.deepEqual(parityOf(a, b, 0.99).atBar, { positives: { n: 2, a: 2, b: 1 }, negatives: { n: 2, a: 1, b: 0 } });
  });
  it("say so in the read-first list", () => {
    assert.match(section(md, "Read first"), /subset-run[^\n]*accuracy tables/);
  });
});

