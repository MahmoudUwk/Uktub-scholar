/**
 * The browser app writes `UKTUB_MAIN_TEX_TEMPLATE` into every new project. It must state nothing: any prose in it is an
 * uncited, unlabelled statement that the pre-completion gate flags in every fresh project (found 2026-10-21: the
 * template's "Hello, Uktub." fired the gate in a live probe).
 */
import { it } from "node:test";
import assert from "node:assert/strict";

import { linesFromString, parsePaper } from "../src/core/review/latex.ts";
import { auditProvenance } from "../src/core/provenance/audit.ts";
import { UKTUB_MAIN_TEX_TEMPLATE } from "../web/src/services/uktubPaths.ts";

it("the new-project main.tex template holds no statement for the provenance audit", () => {
  const tex = UKTUB_MAIN_TEX_TEMPLATE;
  const audit = auditProvenance({ paper: parsePaper(linesFromString(tex)), tex, papers: [], ledger: () => null });
  assert.equal(audit.summary.unlabelledUnverified, 0, JSON.stringify(audit.units.map((u) => u.unit.plain)));
  assert.equal(audit.summary.audited, 0);
  assert.deepEqual(audit.summary.citeKeys, []);
});
