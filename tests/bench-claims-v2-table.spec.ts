/**
 * claim-verification-v2 model table (docs/plans/2026-10-11-claim-verification-v2-benchmark-plan.md): one concise, comparable row per engine,
 * built only from full runs of the whole dataset, plus the engines that were not run and why. Offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CPU_GATE_SECONDS, NARROW_MARGIN, gateOf, modelRow, renderModelTable, type EngineMeta, type NotRun } from "../scripts/bench-claims-v2-table.ts";
import type { ResultsFile } from "../scripts/bench-claims-v2-report.ts";
import type { RunRecord } from "../scripts/bench-claims-v2.ts";

let n = 0;
const rec = (label: "TRUE" | "FALSE", score: number | null, over: Partial<RunRecord> = {}): RunRecord => ({
  id: `c${++n}`, paper: `p${n % 8}`, label, type: label === "TRUE" ? "reworded" : "fabricated", fold: n % 4, score, unjudged: 0, chunks: 50,
  supportFound: score !== null && score >= 0.99, fresh: 50, cached: 0, localizationFresh: 0, wallMs: 4000, refused: null, ...over,
});
const records = (positivesAtBar: number, falseAtBar: number): RunRecord[] => [
  ...Array.from({ length: 40 }, (_, i) => rec("TRUE", i < positivesAtBar ? 0.995 : 0.3)),
  ...Array.from({ length: 40 }, (_, i) => (i < falseAtBar ? rec("FALSE", 0.999, { type: "perturbed" }) : rec("FALSE", 0.05))),
];
const run = (label: string, recs: RunRecord[], over: Partial<ResultsFile> = {}): ResultsFile => ({
  schema: "bench-claims-v2/1", date: "2026-10-12", engine: "eos", device: "gpu", label,
  identity: { model: "m", protocol: "p", minConfidence: 0.99 }, commit: "abc", dirty: false,
  dataset: { claimsSha256: "ff", corpusSha256: "ee", papers: 8, claims: recs.length, stride: 1, offset: 0 },
  chunking: { chunk_tokens: 512, overlap_tokens: 0, chars_per_token: 2.8, boundary: "section" }, maxJudgmentsRaisedFrom: 120,
  machine: { cpu: "cpu", cores: 24, memoryGb: 32, node: "v26" }, run: { startedAt: "t", loadavgStart: [1, 1, 1], loadavgEnd: [1, 1, 1], seconds: 100 },
  gpu: { name: "RTX", totalMiB: 8188, baselineUsedMiB: 60, peakUsedMiB: 1760 },
  records: recs, ...over,
} as ResultsFile);
const meta = (id: string): EngineMeta => ({ id, name: `Model ${id}`, repo: `org/${id}`, revision: "abcdef123456", params: "0.8B", licence: "Apache-2.0" });

describe("the CPU gate", () => {
  it("refuses an engine that takes MORE than 2 s per chunk: 2.0 passes, 2.5 is refused, an unmeasured one is not judged", () => {
    assert.equal(CPU_GATE_SECONDS, 2);
    assert.equal(gateOf(2.0), "pass");
    assert.equal(gateOf(0.8), "pass");
    assert.equal(gateOf(2.5), "refused");
    assert.equal(gateOf(null), "not measured");
  });
});

describe("one row of the model table", () => {
  const a = run("a-gpu", records(30, 1));
  const row = modelRow(a, meta("a"), 1.0, { draws: 30, seed: 1 });
  it("counts what the product bar supports, true and false, with the class sizes", () => {
    assert.deepEqual(row.bar, { positives: 40, negatives: 40, tp: 30, fp: 1 });
  });
  it("names the negative type the engine ranks worst, with its AUC", () => {
    assert.equal(row.weakestType?.type, "perturbed");
    assert.equal(row.weakestType?.auc, 0);
  });
  it("gives the GPU seconds per claim, the GPU memory the run used above the baseline, and the CPU gate", () => {
    assert.equal(row.gpuSecondsPerClaim, 4);
    assert.equal(row.gpuMiB, 1700);
    assert.deepEqual([row.cpuSecondsPerChunk, row.gate], [1.0, "pass"]);
  });
  it("carries the recall and the utility at the bar fitted for 1 % of negatives, each with an interval", () => {
    assert.ok(row.recallAt1.value !== null && row.recallAt1.interval !== null);
    assert.ok(row.utilityAt1.value !== null && row.utilityAt1.interval !== null);
  });
  it("takes the MEDIAN seconds per claim, so a few claims disturbed by another job on the GPU do not move it", () => {
    const recs = records(30, 1).map((r, i) => (i < 3 ? { ...r, wallMs: 400_000 } : r));
    assert.equal(modelRow(run("m", recs), meta("m"), null, { draws: 5, seed: 1 }).gpuSecondsPerClaim, 4);
  });
  it("refuses a run that does not cover the dataset: a subset or a selection is not a row", () => {
    assert.throws(() => modelRow(run("s", records(30, 1), { dataset: { claimsSha256: "ff", corpusSha256: "ee", papers: 8, claims: 80, stride: 4, offset: 0 } }), meta("s"), null), /full run/);
    assert.throws(() => modelRow(run("s", records(30, 1), { dataset: { claimsSha256: "ff", corpusSha256: "ee", papers: 8, claims: 80, stride: 1, offset: 0, selection: "x" } }), meta("s"), null), /full run/);
  });
});

describe("the rendered table", () => {
  const strong = modelRow(run("strong-gpu", records(36, 0)), meta("strong"), 0.9, { draws: 30, seed: 1 });
  const weak = modelRow(run("weak-gpu", records(10, 4)), meta("weak"), 5.6, { draws: 30, seed: 1 });
  const none = modelRow(run("none-gpu", records(0, 0).map((r) => ({ ...r, score: null, supportFound: false }))), meta("none"), null, { draws: 30, seed: 1 }); // nothing could be checked
  const notRun: NotRun[] = [{ name: "Hosted X", reason: "hosted; no key", v1: "AUC 0.998 on v1" }];
  const md = renderModelTable([weak, none, strong], notRun, { date: "2026-10-12", commit: "abc1234", claims: 80 });
  const section = (h: string): string => md.split(/^## /m).find((x) => x.startsWith(h)) ?? "";
  it("orders the accuracy table by recall at 1 % false supports, best first, once per engine", () => {
    const acc = section("Accuracy");
    const order = ["Model strong", "Model weak", "Model none"].map((m) => acc.indexOf(m));
    assert.ok(order.every((i) => i >= 0), "every engine is listed");
    assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, JSON.stringify(order));
  });
  it("has a cost-and-fit table with parameters, licence, GPU cost and the CPU gate verdict", () => {
    const cost = section("Cost and fit");
    assert.match(cost, /Model strong[^\n]*0\.8B[^\n]*Apache-2\.0[^\n]*pass/);
    assert.match(cost, /Model weak[^\n]*refused/);
    assert.match(cost, /Model none[^\n]*not measured/);
  });
  it("lists the engines that were not run, with the reason and what is known from v1", () => {
    const nr = section("Not run");
    assert.match(nr, /Hosted X[^\n]*hosted; no key[^\n]*AUC 0\.998 on v1/);
  });
  it("states the setup once: the dataset size, the commit, the date, and that no support found is not a finding of falsehood", () => {
    assert.match(md, /80 claims/);
    assert.match(md, /abc1234/);
    assert.match(md, /2026-10-12/);
    assert.match(md, /not a finding that a claim is false/i);
  });
});

describe("the head-to-head against the reference model", () => {
  const refRun = run("ref-gpu", records(36, 0));
  const strongRun: ResultsFile = { ...refRun, label: "same-gpu" }; // the very same claims and scores as the reference
  const weakRun = run("weak-gpu", records(10, 4).map((r, i) => ({ ...r, id: refRun.records[i]!.id, paper: refRun.records[i]!.paper, fold: refRun.records[i]!.fold })));
  const opts = { draws: 40, seed: 1 };
  const ref = modelRow(refRun, meta("ref"), 1, opts);
  const same = modelRow(strongRun, meta("same"), 1, { ...opts, reference: refRun });
  const weak = modelRow(weakRun, meta("weak"), 1, { ...opts, reference: refRun });
  it("carries the paired difference in AUC and in recall at 1 % false supports", () => {
    assert.ok(weak.vsReference !== null && (weak.vsReference.auc.value as number) < 0, JSON.stringify(weak.vsReference));
    assert.equal(ref.vsReference, null, "the reference has no difference to itself");
  });
  it("refuses a reference that ran different claims", () => {
    assert.throws(() => modelRow(run("x-gpu", records(30, 1)), meta("x"), 1, { ...opts, reference: refRun }), /same claims/);
  });
  it("is a section of its own that names the reference, omits it, and says better, worse or not distinguishable for each metric", () => {
    const md = renderModelTable([ref, same, weak], [], { date: "2026-10-12", commit: "abc1234", claims: 80 }, "Model ref");
    const sec = md.split(/^## /m).find((x) => x.startsWith("Against Model ref")) ?? "";
    assert.ok(sec.includes("Model weak") && sec.includes("Model same"));
    assert.match(sec, /Partial AUC \(up to 5 % false supports\)/, "the low-false-support region has its own columns");
    assert.match(sec, /Recall at 2 % false supports/);
    assert.ok(!/\| Model ref \|/.test(sec), "the reference is not compared with itself");
    assert.match(sec, /Model weak[^\n]*worse/, "a model that ranks worse is called worse");
    assert.match(sec, /Model same[^\n]*not distinguishable/, "an identical model is not distinguishable");
  });
});

describe("what the table says besides the numbers", () => {
  const withNote = modelRow(run("noted-gpu", records(36, 0)), { ...meta("noted"), note: "scores are compressed toward 0.5 by the model's own temperature" }, 1.93, { draws: 20, seed: 1 });
  const plain = modelRow(run("plain-gpu", records(10, 4)), meta("plain"), 1.0, { draws: 20, seed: 1 });
  const md = renderModelTable([withNote, plain], [], { date: "2026-10-12", commit: "abc1234", claims: 80 });
  const section = (h: string): string => md.split(/^## /m).find((x) => x.startsWith(h)) ?? "";
  it("marks a CPU pass within 10 % of the limit as narrow, because two claims on one machine cannot settle it", () => {
    assert.equal(NARROW_MARGIN, 0.1);
    assert.match(section("Cost and fit"), /Model noted[^\n]*pass \(narrow\)/);
    assert.match(section("Cost and fit"), /Model plain[^\n]*\| pass \|/);
  });
  it("lists the note of a model that has one, in its own section, and no section when no model has one", () => {
    assert.match(section("Notes on individual models"), /Model noted[^\n]*compressed toward 0\.5/);
    assert.ok(!section("Notes on individual models").includes("Model plain"));
    assert.equal(section("Notes on individual models") === "", false);
    const none = renderModelTable([plain], [], { date: "2026-10-12", commit: "abc1234", claims: 80 });
    assert.ok(!none.includes("Notes on individual models"));
  });
  it("says the row order is nominal: the paired section, not the order, tells which differences are real", () => {
    assert.match(section("Accuracy"), /order[^\n]*nominal|nominal[^\n]*order/i);
  });
  it("does not let a commit stand for a run that had uncommitted changes", () => {
    const dirty = renderModelTable([plain], [], { date: "2026-10-12", commit: "abc1234", claims: 80, dirty: true });
    assert.match(dirty, /uncommitted changes/);
    assert.doesNotMatch(md, /uncommitted changes/);
  });
});

