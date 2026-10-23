/**
 * Phase V4: unit selection helpers (pure) plus the no-marks paper path.
 * Offline: fabricated units, real SQLite for the load path.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createRegistry, registerPaper } from "../src/core/registry.ts";
import type { PaperUnit } from "../src/core/verify/paper-units.ts";
import { foldRankedToUnits, loadPaperUnits } from "../src/core/verify/unit-select.ts";
import { passageHashOf, publishSource } from "../src/core/verify/store.ts";

const NOW = new Date("2026-10-04T00:00:00Z");
const BIB = "@article{x, title={T}, author={Holder, Ada}, year={2024}}";

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-vsel-"));
  db = createRegistry(root);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const U = (start: number, end: number, references = false): PaperUnit => ({
  start,
  end,
  section: references ? "References" : "Body",
  text: `t${start}`,
  hash: `h${start}`,
  references,
});

describe("foldRankedToUnits", () => {
  const unitsOf = (doi: string): PaperUnit[] =>
    doi === "A" ? [U(0, 100), U(100, 250, true), U(250, 400)] : [U(0, 150), U(150, 300)];

  it("T4.6 best-ranked chunk wins, units appear once, reference units skipped", async () => {
    const ranked = [
      { doi: "A", start: 260 },
      { doi: "A", start: 10 },
      { doi: "B", start: 10 },
      { doi: "A", start: 110 },
      { doi: "B", start: 200 },
      { doi: "A", start: 20 },
    ];
    const out = foldRankedToUnits(ranked, unitsOf);
    assert.deepEqual(
      out.map((f) => [f.doi, f.unit.start, f.unit.end]),
      [
        ["A", 250, 400],
        ["A", 0, 100],
        ["B", 0, 150],
        ["B", 150, 300],
      ],
    );
  });

  it("T4.6 perPaper keeps the best unit per paper, top cuts overall", async () => {
    const ranked = [
      { doi: "A", start: 260 },
      { doi: "A", start: 10 },
      { doi: "B", start: 10 },
      { doi: "B", start: 200 },
    ];
    assert.deepEqual(
      foldRankedToUnits(ranked, unitsOf, { perPaper: 1 }).map((f) => [f.doi, f.unit.start]),
      [
        ["A", 250],
        ["B", 0],
      ],
    );
    assert.deepEqual(
      foldRankedToUnits(ranked, unitsOf, { top: 2 }).map((f) => [f.doi, f.unit.start]),
      [
        ["A", 250],
        ["A", 0],
      ],
    );
  });
});

describe("loadPaperUnits", () => {
  it("T4.14 no marks, 40k chars -> >= 3 units each <= 16,000 that concatenate to the text", async () => {
    const doi = "10.1111/nomarks";
    registerPaper(db, { doi, title: "No Marks", authors: ["Holder, Ada"], year: 2024, bibtex: BIB, bibtexSource: "crossref" }, { now: () => NOW });
    const text = "The experiment records many independent measurements of the cell. ".repeat(700).slice(0, 40_000);
    assert.equal(text.length, 40_000);
    publishSource(
      db,
      doi,
      { kind: "local-file", ref: "n.pdf", license: null, digest: "0".repeat(64), extraction: "t@1", text, pageStarts: [0] },
      { chunk_tokens: 8192, overlap_tokens: 0, chars_per_token: 2.8, boundary: "paragraph" },
      NOW,
    );
    const loaded = loadPaperUnits(db, doi, 16_000);
    assert.ok(loaded !== null);
    assert.ok(loaded.units.length >= 3, `expected >= 3 units, got ${loaded.units.length}`);
    for (const u of loaded.units) assert.ok(u.end - u.start <= 16_000, `unit over cap: ${u.end - u.start}`);
    assert.equal(loaded.units.map((u) => u.text).join(""), text);
    assert.equal(loaded.excluded, 0);
    for (const u of loaded.units) assert.equal(u.hash, passageHashOf(u.text));
  });
});
