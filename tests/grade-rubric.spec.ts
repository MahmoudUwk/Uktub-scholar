/**
 * Rubric v1 grounding (PLAN section 4.6 + brief decided 5): every verbatim example comes from a dev
 * note (never held-out), and each quoted sentence matches its fixture unit text. Constructed
 * minimal-pair variants are exempt but must be marked [constructed].
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEV = ["iter-06", "iter-07", "iter-09", "iter-14", "iter-20"];
const HELDOUT = ["iter-01", "iter-02", "iter-03", "iter-04", "iter-08", "iter-10", "iter-11", "iter-12", "iter-13", "iter-15", "iter-17", "iter-18", "iter-19"];
const RUBRIC = readFileSync(resolve(import.meta.dirname, "../experiments/harness/factcheck-rubric-v1.md"), "utf8");

const fixtures = new Map(DEV.map((n) => {
  const units = JSON.parse(readFileSync(resolve(import.meta.dirname, `fixtures/provenance-units-golden/${n}.units.json`), "utf8")) as Array<{ id: string; text: string }>;
  return [n, new Map(units.map((u) => [u.id, u.text]))] as const;
}));

describe("factcheck rubric v1", () => {
  it("carries the PLAN section 4.6 definitions and rules verbatim", () => {
    for (const s of [
      "Same fact, number, setting, comparator and direction; only intensity words are stronger.",
      "any transfer to another model, task, dataset, rank, precision or hardware",
      "a missing comparator",
      "absolute wording for a partial result",
      "citing only unregistered papers",
      "Contradicts the value, direction or negation.",
      "Stated by another registered paper, not the cited one.",
      "Generic textbook fact, or no factual claim",
      "Any uncited number, measured result, method property, hardware requirement or attribution.",
      "wrong > misattributed > unsupported > overstated > supported",
      "at most 300 char",
    ]) {
      assert.ok(RUBRIC.includes(s), `rubric lost: ${s}`);
    }
  });

  it("quotes no held-out note", () => {
    for (const n of HELDOUT) assert.ok(!RUBRIC.includes(n), `held-out ${n} quoted in the rubric`);
  });

  it("grounds every verbatim example in its dev-note fixture text", () => {
    const lines = RUBRIC.split("\n");
    let checked = 0;
    for (const line of lines) {
      const m = /^\d+\.\s+(?:\[constructed[^\]]*\]\s+)?(?:\((iter-\d+) (u\d+)\)\s+)?"(.*)"(?:\s+\[.*\])?$/.exec(line.trim());
      if (m === null) continue;
      if (line.includes("[constructed")) continue; // minimal-pair variant: anchored, not verbatim
      const [, note, id, quote] = m as unknown as [string, string, string, string];
      assert.ok(note !== undefined && id !== undefined && quote !== undefined, `unparseable example: ${line}`);
      assert.ok(DEV.includes(note), `${note} is not a dev note`);
      const text = fixtures.get(note)?.get(id);
      assert.ok(text !== undefined, `${note} ${id} not in fixtures`);
      assert.ok(text.includes(quote.slice(0, 40)), `${note} ${id}: quote start not in fixture text`);
      checked++;
    }
    assert.ok(checked >= 20, `only ${checked} verbatim examples grounded, need >= 20`);
  });

  it("gives 5 positive and 5 negative examples per boundary", () => {
    for (const b of ["### B1.", "### B2.", "### B3.", "### B4.", "### B5.", "### B6."]) {
      const start = RUBRIC.indexOf(b);
      const next = RUBRIC.indexOf("### B", start + 1);
      const section = RUBRIC.slice(start, next === -1 ? RUBRIC.indexOf("## 4.") : next);
      const examples = section.split("\n").filter((l) => /^\d+\.\s+/.test(l.trim()));
      assert.equal(examples.length, 10, `${b} has ${examples.length} examples, need 10`);
    }
  });
});
