/**
 * Segmentation freeze: units recomputed from the 18 archived manuscripts
 * (copied verbatim into fixtures) must equal the frozen units JSON. Any
 * change to the splitter, headings or plain-text rendering voids this test —
 * and after G1, voids all grader labels. Never regenerate the JSON to make
 * this pass; fix the segmentation instead.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expandSource, parsePaper } from "../src/core/review/latex.ts";
import { extractUnits } from "../src/core/provenance/units.ts";

const BASE = join(import.meta.dirname, "fixtures", "provenance-units-golden");
const ITERS = readdirSync(BASE, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

describe("provenance units golden", () => {
  assert.equal(ITERS.length, 18, "one fixture dir per archived note");
  for (const iter of ITERS) {
    it(`${iter} segments exactly as frozen`, () => {
      const dir = join(BASE, iter);
      const files = new Map<string, string>();
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".tex")) files.set(f, readFileSync(join(dir, f), "utf8"));
      }
      assert.ok(files.has("main.tex"), `${iter} keeps its main.tex`);
      const lines = expandSource((rel) => files.get(rel), "main.tex");
      const actual = extractUnits(parsePaper(lines)).map((u) => ({
        id: u.id,
        kind: u.kind,
        file: u.file,
        line: u.line,
        section: u.section,
        text: u.plain,
        cites: u.cites,
      }));
      const frozen = JSON.parse(readFileSync(join(BASE, `${iter}.units.json`), "utf8")) as unknown;
      assert.deepEqual(actual, frozen);
    });
  }
});
