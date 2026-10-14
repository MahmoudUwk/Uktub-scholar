/**
 * Tests for the post-compose replay's pure parts: unit selection per pass,
 * label join by id, and metric arithmetic including zero denominators.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BAD_CITED,
  computeGroup,
  computeMetrics,
  joinLabel,
  p95,
  passOf,
  type UnitRow,
} from "../scripts/live/post-compose-metrics.ts";

const row = (over: Partial<UnitRow>): UnitRow => ({
  iter: "iter-01",
  note: "n1",
  id: "u1",
  kind: "sentence",
  pass: "A",
  label: "supported",
  cites: ["k1"],
  outcome: "promoted",
  supportingPapers: ["k1"],
  noteCited: ["k1"],
  complete: true,
  timeMs: 100,
  judgments: 5,
  ...over,
});

describe("passOf", () => {
  it("sends cited units to Pass A and uncited units to Pass B", () => {
    assert.equal(passOf(["hu2021lora"]), "A");
    assert.equal(passOf(["a", "b"]), "A");
    assert.equal(passOf([]), "B");
  });
});

describe("joinLabel", () => {
  it("joins by unit id and yields null for unknown ids", () => {
    const m = new Map([["u1", "supported"], ["u2", "specific"]]);
    assert.equal(joinLabel(m, "u1"), "supported");
    assert.equal(joinLabel(m, "u9"), null);
  });
});

describe("p95", () => {
  it("returns null on empty input", () => {
    assert.equal(p95([]), null);
  });
  it("returns the max for a single value and a sane quantile otherwise", () => {
    assert.equal(p95([7]), 7);
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(p95(xs), 95);
  });
});

describe("computeGroup", () => {
  it("computes promotion rate, FDR with counts, and recall on supported", () => {
    const rows = [
      row({ id: "u1", pass: "A", label: "supported", outcome: "promoted" }),
      row({ id: "u2", pass: "A", label: "supported", outcome: "not-found" }),
      row({ id: "u3", pass: "A", label: "unsupported", outcome: "promoted" }),
      row({ id: "u4", pass: "A", label: "supported", outcome: "skipped" }),
    ];
    const g = computeGroup(rows);
    assert.equal(g.passA.n, 4);
    assert.equal(g.passA.verified, 3);
    assert.deepEqual(g.passA.promotion, { num: 2, den: 3, rate: 2 / 3 });
    assert.equal(g.passA.badPromoted, 1);
    assert.deepEqual(g.passA.fdr, { num: 1, den: 2, rate: 0.5 });
    assert.deepEqual(g.passA.recallSupported, { num: 1, den: 2, rate: 0.5 });
    assert.equal(g.skipped, 1);
  });

  it("treats wrong and misattributed as bad but not overstated", () => {
    assert.ok(BAD_CITED.has("unsupported") && BAD_CITED.has("wrong") && BAD_CITED.has("misattributed"));
    assert.ok(!BAD_CITED.has("overstated") && !BAD_CITED.has("supported"));
  });

  it("splits Pass B into specific vs background and flags cited-elsewhere hits", () => {
    const rows = [
      row({ id: "u1", pass: "B", label: "specific", outcome: "promoted", supportingPapers: ["k9"], noteCited: ["k1", "k9"] }),
      row({ id: "u2", pass: "B", label: "specific", outcome: "not-found", supportingPapers: [], noteCited: ["k1"] }),
      row({ id: "u3", pass: "B", label: "background", outcome: "promoted", supportingPapers: ["kx"], noteCited: ["k1"] }),
    ];
    const g = computeGroup(rows);
    assert.deepEqual(g.passB.specific.share, { num: 1, den: 2, rate: 0.5 });
    assert.deepEqual(g.passB.background.share, { num: 1, den: 1, rate: 1 });
    assert.deepEqual(g.passB.hitsCitedElsewhere, { num: 1, den: 2, rate: 0.5 });
  });

  it("uses null rates on zero denominators and still counts", () => {
    const g = computeGroup([]);
    assert.equal(g.passA.promotion.rate, null);
    assert.equal(g.passA.fdr.rate, null);
    assert.equal(g.passA.recallSupported.rate, null);
    assert.equal(g.passB.specific.share.rate, null);
    assert.equal(g.passB.hitsCitedElsewhere.rate, null);
    assert.equal(g.wallMs, 0);

    const onlyB = computeGroup([row({ id: "u1", pass: "B", label: "specific", outcome: "promoted", supportingPapers: [] })]);
    assert.equal(onlyB.passA.promotion.rate, null);
    assert.equal(onlyB.passA.n, 0);
    assert.deepEqual(onlyB.passB.specific.share, { num: 1, den: 1, rate: 1 });
  });
});

describe("computeMetrics", () => {
  it("splits dev vs held-out and aggregates per note", () => {
    const rows = [
      row({ iter: "iter-06", note: "dev1", id: "u1", pass: "A", label: "supported", outcome: "promoted" }),
      row({ iter: "iter-01", note: "h1", id: "u1", pass: "B", label: "specific", outcome: "not-found", supportingPapers: [] }),
    ];
    const m = computeMetrics(rows, { dev: ["iter-06"], heldout: ["iter-01"] });
    assert.equal(m.dev.passA.promoted, 1);
    assert.equal(m.heldout.passA.promoted, 0);
    assert.equal(m.overall.passA.promoted, 1);
    assert.equal(Object.keys(m.perNote).length, 2);
    assert.equal(m.perNote["dev1"]?.passA.promoted, 1);
    assert.equal(m.perNote["h1"]?.passB.specific.verified, 1);
  });
});
