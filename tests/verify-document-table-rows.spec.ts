/**
 * `verify` document mode, decision D4: a table row is never sent to the claim engine. It gets status `table-row`
 * with a row-level figure check that reuses the provenance audit's verdicts (the same figures, papers and
 * matching rules), so `verify` and `provenance` cannot disagree about a row. Offline: fake engine, real SQLite.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";

import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry, registerPaper } from "../src/core/registry.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import { VerifyDocumentOutput, verifyClaimTool, type VerifyArgs, type VerifyHooks } from "../src/core/tools/verify.ts";
import { auditProvenance } from "../src/core/provenance/audit.ts";
import { readProvenanceInputs } from "../src/core/provenance/read.ts";
import { linesFromString, parsePaper } from "../src/core/review/latex.ts";
import { publishSource } from "../src/core/verify/store.ts";

const NOW = () => new Date("2026-10-18T12:00:00Z");
const BIB = "@article{x, title={T}, author={Holder, Ada}, year={2024}}";
const TEMP = "Cells age faster at high temperature than at room temperature";
const cite = (k: string): string => `\\cite{${k}}`;
const section = (t: string): string => `\\section{${t}}`;

let root: string;
let db: DatabaseSync;
let keys: Record<string, string>;
let calls: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-vrows-"));
  db = createRegistry(root);
  keys = {};
  calls = [];
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const REALM_DOI = "10.1111/realm-paper";
const OTHER_DOI = "10.1111/other-paper";

function addPaper(doi: string, title: string, paragraphs: string[]): void {
  registerPaper(db, { doi, title, authors: ["Holder, Ada"], year: 2024, bibtex: BIB.replace("x,", `${doi.slice(-4)},`), bibtexSource: "crossref" }, { now: NOW });
  const cfg = { chunk_tokens: 8192, overlap_tokens: 0, chars_per_token: 2.8, boundary: "paragraph" as const };
  publishSource(db, doi, { kind: "local-file", ref: `${doi.slice(-4)}.pdf`, license: null, digest: `${doi.length}`.padStart(64, "0"), extraction: "t@1", text: paragraphs.join("\n\n"), pageStarts: [0] }, cfg, NOW());
  keys[doi] = (db.prepare("SELECT citekey FROM papers WHERE doi = ?").get(doi) as { citekey: string }).citekey;
}

function papers(): void {
  addPaper(REALM_DOI, "REALM", [`Filler paragraph about retrieval pretraining in general terms.`, `On the benchmark REALM reports 40.4% EM for its best model.`, `${TEMP} (temperature study).`]);
  addPaper(OTHER_DOI, "Other", ["Filler paragraph about unrelated control software and scheduling."]);
}

/** Counts every engine call; supports only the temperature sentence, found in REALM's text (rows must never reach it). */
function hooks(): VerifyHooks {
  return {
    fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    createEngine: () => ({
      run: async (rows) => {
        for (const r of rows) calls.push(r.instructions);
        return rows.map((r) => (r.state.includes("temperature study") && r.instructions.includes("Cells age faster") ? 0.999 : 0.05));
      },
    }),
  };
}

function ctx(): ToolContext {
  return {
    root,
    fetch: (async () => { throw new Error("no network"); }) as ToolContext["fetch"],
    env: { UKTUB_VERIFY_MODEL_ID: "test-model" },
    now: NOW,
    queue: new WriteQueue(),
  };
}

const table = (rows: string[]): string => ["\\begin{tabular}{lc}", ...rows, "\\end{tabular}"].join("\n");
const headerRow = "Method & Score \\\\";
const realmRow = (figure = "40.4\\% EM"): string => `REALM ${cite(keys[REALM_DOI]!)} & ${figure} \\\\`;

type Doc = Record<string, any>;
const S = (r: { structuredContent: unknown }): Doc => r.structuredContent as Doc;
const unitsOf = (s: Doc): Doc[] => s.units as Doc[];
const rowOf = (s: Doc, plainStart: string): Doc | undefined => unitsOf(s).find((u) => u.kind === "row" && (u.excerpt as string).startsWith(plainStart));
const refused = (r: { details: Record<string, unknown> }): string | undefined => (r.details.refused as { code?: string } | undefined)?.code;

describe("verify document mode: table rows (D4)", () => {
  it("(a) a row whose figure is in its cited paper is table-row, found 1, and never reaches the engine", async () => {
    papers();
    const text = table([headerRow, realmRow()]);
    const r = await verifyClaimTool(ctx(), { text } as VerifyArgs, hooks());
    assert.equal(refused(r), undefined);
    const s = S(r);
    assert.ok(Value.Check(VerifyDocumentOutput, s), "document output matches its schema");
    const row = rowOf(s, "REALM");
    assert.equal(row?.status, "table-row");
    assert.deepEqual(row?.figures, { found: 1, missing: 0, check: 0 });
    assert.equal(row?.note, "figures checked against the cited paper; row wording not verified");
    assert.equal(row?.complete, true);
    assert.equal(calls.some((c) => c.includes("REALM")), false, "the row was not sent to the claim engine");
    assert.equal((s.summary as Doc).tableRows, 2, "header and data row both count as table rows");
    assert.equal((s.summary as Doc).tableRowsMissing, 0);
    assert.match((r as { content: { text: string }[] }).content[0]!.text, /table row/);
  });

  it("(b) a row whose figure is absent from the cited paper is table-row with missing 1 and is unresolved", async () => {
    papers();
    const r = await verifyClaimTool(ctx(), { text: table([realmRow("99.9\\% EM")]) } as VerifyArgs, hooks());
    assert.equal(refused(r), undefined);
    const s = S(r);
    const row = rowOf(s, "REALM");
    assert.equal(row?.status, "table-row");
    assert.deepEqual(row?.figures, { found: 0, missing: 1, check: 0 });
    assert.equal((s.summary as Doc).tableRowsMissing, 1);
    assert.equal(calls.some((c) => c.includes("REALM")), false, "the row was not sent to the claim engine");
  });

  it("(c) a header row without figures is table-row with zero counts and resolved", async () => {
    papers();
    const r = await verifyClaimTool(ctx(), { text: table([headerRow, realmRow()]) } as VerifyArgs, hooks());
    const s = S(r);
    const header = unitsOf(s).find((u) => u.kind === "row" && (u.excerpt as string).startsWith("Method"));
    assert.equal(header?.status, "table-row");
    assert.deepEqual(header?.figures, { found: 0, missing: 0, check: 0 });
  });

  it("(d) a row citing no registered paper gets the same figure verdict as the provenance audit", async () => {
    papers();
    const text = table([`GHOST \\cite{nosuchkey} & 99.9\\% EM \\\\`]);
    const r = await verifyClaimTool(ctx(), { text } as VerifyArgs, hooks());
    assert.equal(refused(r), undefined);
    const s = S(r);
    const row = rowOf(s, "GHOST");
    assert.equal(row?.status, "table-row");
    const { papers: inputs } = readProvenanceInputs(db);
    const audit = auditProvenance({ paper: parsePaper(linesFromString(text)), tex: text, papers: inputs, ledger: () => null });
    const audited = audit.units.find((u) => u.unit.kind === "row" && u.unit.plain.startsWith("GHOST"));
    assert.deepEqual(audited?.figures.map((f) => f.status), ["unsourced"], "the audit calls the uncited figure unsourced");
    assert.deepEqual(row?.figures, { found: 0, missing: 1, check: 0 }, "a figure the audit calls unsourced is missing here");
    assert.deepEqual(row?.unregistered, ["nosuchkey"]);
    assert.equal(calls.some((c) => c.includes("GHOST")), false);
  });

  it("(e) sentences and captions keep their status and their engine checks", async () => {
    papers();
    const text = [
      `${section("Background")} ${TEMP} ${cite(keys[REALM_DOI]!)}.`,
      `${TEMP}.`,
      `\\caption{${TEMP} ${cite(keys[REALM_DOI]!)}.}`,
      table([realmRow()]),
      "",
    ].join("\n");
    const r = await verifyClaimTool(ctx(), { text } as VerifyArgs, hooks());
    assert.equal(refused(r), undefined);
    const s = S(r);
    const sentence = unitsOf(s).find((u) => u.kind === "sentence" && (u.cites as string[]).length > 0);
    assert.equal(sentence?.status, "supported");
    assert.equal(unitsOf(s).find((u) => u.kind === "sentence" && (u.cites as string[]).length === 0)?.status, "missing-citation");
    assert.equal(unitsOf(s).find((u) => u.kind === "caption")?.status, "supported");
    assert.ok(calls.some((c) => c.includes(TEMP)), "prose and captions are still checked by the engine");
    assert.ok(calls.filter((c) => c.includes(TEMP)).length >= 1);
    assert.equal(calls.some((c) => c.includes("REALM")), false);
  });

  it("(f) a paged document counts table rows on every page and pages past the 50-unit cap", async () => {
    papers();
    const sentences = Array.from({ length: 52 }, (_, i) => `Background sentence number ${i} about nothing in particular xyzzy.`).join(" ");
    const text = `${table([headerRow, realmRow()])}\n${sentences}\n`;
    const first = await verifyClaimTool(ctx(), { text } as VerifyArgs, hooks());
    assert.equal(refused(first), undefined);
    const s1 = S(first);
    assert.equal(s1.next, 50, "the first page holds 50 units");
    assert.equal(rowOf(s1, "REALM")?.status, "table-row");
    const second = await verifyClaimTool(ctx(), { text, offset: 50 } as VerifyArgs, hooks());
    const s2 = S(second);
    assert.equal(s2.next, null);
    assert.equal(unitsOf(s2).length, (s1.summary as Doc).total - 50);
    assert.equal((s1.summary as Doc).tableRows, 2, "page one counts its two rows");
    assert.equal((s2.summary as Doc).tableRows, 0, "page two holds no rows");
  });
});
