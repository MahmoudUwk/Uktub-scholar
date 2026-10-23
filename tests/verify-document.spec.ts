/**
 * `verify` document mode: check the TEXT AS WRITTEN. Every unit from the
 * product's own extractor is verified verbatim (cited units against their own
 * papers, uncited units against all papers), with per-unit statuses
 * supported | cited-unsupported | missing-citation | unsourced | unregistered.
 * Supported evidence is released through the existing path, so the ledger
 * records the exact unit text and provenance later marks it verified.
 * Offline: fake engine, real SQLite.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";

import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry, registerPaper } from "../src/core/registry.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import {
  MAX_DOCUMENT_UNITS,
  VerifyDocumentOutput,
  VerifyParams,
  verifyClaimTool,
  type VerifyArgs,
  type VerifyHooks,
} from "../src/core/tools/verify.ts";
import { auditProvenance, claimVariants } from "../src/core/provenance/audit.ts";
import { readProvenanceInputs } from "../src/core/provenance/read.ts";
import { linesFromString, parsePaper } from "../src/core/review/latex.ts";
import { publishSource } from "../src/core/verify/store.ts";

const MARK = "markone";
const NOW = () => new Date("2026-10-04T12:00:00Z");
const BIB = "@article{x, title={T}, author={Holder, Ada}, year={2024}}";
const TEMP = "Cells age faster at high temperature than at room temperature";
const CHEESE = "The moon is made of green cheese";
const cite = (k: string): string => `\\cite{${k}}`;
const section = (t: string): string => `\\section{${t}}`;
const beginDoc = "\\documentclass{article}\n\\begin{document}\n";
const endDoc = "\\end{document}\n";

let root: string;
let db: DatabaseSync;
let keys: Record<string, string>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-vdoc-"));
  db = createRegistry(root);
  keys = {};
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function addPaper(doi: string, title: string, paragraphs: string[]): void {
  registerPaper(db, { doi, title, authors: ["Holder, Ada"], year: 2024, bibtex: BIB.replace("x,", `${doi.slice(-3)},`), bibtexSource: "crossref" }, { now: NOW });
  const cfg = { chunk_tokens: 8192, overlap_tokens: 0, chars_per_token: 2.8, boundary: "paragraph" as const };
  publishSource(db, doi, { kind: "local-file", ref: `${doi.slice(-3)}.pdf`, license: null, digest: `${doi.length}`.padStart(64, "0"), extraction: "t@1", text: paragraphs.join("\n\n"), pageStarts: [0] }, cfg, NOW());
  keys[doi] = (db.prepare("SELECT citekey FROM papers WHERE doi = ?").get(doi) as { citekey: string }).citekey;
}

const BERLIN_A = "10.1111/berlin-a";
const BERLIN_B = "10.1111/berlin-b";
function twoPapers(): void {
  addPaper(BERLIN_A, "Berlin A", ["Filler paragraph about measurement methods used in the laboratory.", `${TEMP} (${MARK} alpha).`, "Another filler paragraph about calibration of the instruments."]);
  addPaper(BERLIN_B, "Berlin B", ["Filler paragraph about unrelated control software.", "More filler about scheduling and logging."]);
}

/** Scores 0.999 for passages carrying the mark when the claim is about temperature; 0.05 otherwise. */
function hooks(): VerifyHooks {
  return {
    fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    createEngine: () => ({
      run: async (rows) => rows.map((r) => (r.state.includes(MARK) && r.instructions.includes("high temperature") ? 0.999 : 0.05)),
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

const manuscript = (): string =>
  [section("Background"), `${TEMP} ${cite(keys[BERLIN_A])}.`, `${CHEESE} ${cite(keys[BERLIN_A])}.`, `${TEMP}.`, `${CHEESE}.`, `${TEMP} ${cite(keys[BERLIN_B])}.`, `A claim with an unknown key ${cite("nosuchkey")}.`, ""].join("\n");

type Doc = Record<string, any>;
const S = (r: { structuredContent: unknown }): Doc => r.structuredContent as Doc;
const unitsOf = (s: Doc): Doc[] => s.units as Doc[];
const refused = (r: { details: Record<string, unknown> }): string | undefined => (r.details.refused as { code?: string } | undefined)?.code;
const starts = (u: Doc, head: string): boolean => (u.excerpt as string).startsWith(head.slice(0, 20));
const cited = (u: Doc, key: string): boolean => (u.cites as string[]).includes(key);

describe("verify document mode: per-unit status", () => {
  it("classifies cited, uncited and unregistered units from a text fragment", async () => {
    twoPapers();
    const r = await verifyClaimTool(ctx(), { text: manuscript() } as VerifyArgs, hooks());
    assert.equal(refused(r), undefined);
    const s = S(r);
    assert.equal(s.mode, "document");
    assert.ok(Value.Check(VerifyDocumentOutput, s), "document output matches its schema");
    assert.ok(Value.Check(VerifyParams, { text: manuscript() }), "fragment args match the tool params");
    const us = unitsOf(s);
    const citedTemp = us.find((u) => starts(u, TEMP) && cited(u, keys[BERLIN_A]));
    assert.equal(citedTemp?.status, "supported");
    assert.ok((citedTemp?.pointers as string[]).length > 0, "supported units carry pointers");
    assert.equal(us.find((u) => starts(u, CHEESE) && cited(u, keys[BERLIN_A]))?.status, "cited-unsupported");
    const tempUncited = us.find((u) => starts(u, TEMP) && (u.cites as string[]).length === 0);
    assert.equal(tempUncited?.status, "missing-citation");
    assert.ok((tempUncited?.suggested as string[]).includes(keys[BERLIN_A]), "missing citation suggests the supporting paper");
    assert.equal(us.find((u) => starts(u, CHEESE) && (u.cites as string[]).length === 0)?.status, "unsourced");
    assert.equal(us.find((u) => cited(u, keys[BERLIN_B]))?.status, "missing-citation", "support in a paper the unit does not cite is recoverable");
    assert.equal(us.find((u) => cited(u, "nosuchkey"))?.status, "unregistered");
    assert.equal(s.summary.supported, 1);
    const again = await verifyClaimTool(ctx(), { text: manuscript() } as VerifyArgs, hooks());
    assert.match(again.content.map((c) => c.text).join("\n"), /DOCUMENT:/);
  });

  it("reads a project-relative document with includes and reports file:line", async () => {
    twoPapers();
    mkdirSync(join(root, "manuscript", "sections"), { recursive: true });
    writeFileSync(join(root, "manuscript", "main.tex"), `${beginDoc}\\input{sections/one}\n${endDoc}`);
    writeFileSync(join(root, "manuscript", "sections", "one.tex"), `${TEMP} ${cite(keys[BERLIN_A])}.\n`);
    const r = await verifyClaimTool(ctx(), { document: "manuscript/main.tex" } as VerifyArgs, hooks());
    assert.equal(refused(r), undefined);
    const s = S(r);
    assert.equal(s.mode, "document");
    const u = unitsOf(s)[0];
    assert.equal(u?.status, "supported");
    assert.match(`${u?.file}:${u?.line}`, /one\.tex:\d+/);
  });

  it("releases supported evidence so the ledger and provenance mark the verbatim unit verified", async () => {
    twoPapers();
    const r = await verifyClaimTool(ctx(), { text: manuscript() } as VerifyArgs, hooks());
    assert.equal(refused(r), undefined);
    const s = S(r);
    const supported = unitsOf(s).find((u) => u.status === "supported")!;
    const { ledger } = readProvenanceInputs(db, 0.99);
    const hit = ledger(claimVariants(`${TEMP}.`));
    assert.ok(hit !== null, "ledger holds the exact unit text");
    assert.ok(hit.dois.includes(BERLIN_A));
    const audit = auditProvenance({ paper: parsePaper(linesFromString(manuscript())), tex: manuscript(), papers: readProvenanceInputs(db, 0.99).papers, ledger });
    const audited = audit.units.find((u) => u.unit.plain === `${TEMP}.` && u.unit.cites.includes(supported.cites[0]));
    assert.equal(audited?.status, "verified", "provenance marks the verbatim unit verified");
  });

  it("pages a long document by the client-policy cap instead of refusing: the result names the next offset until every unit is checked", async () => {
    twoPapers();
    const many = Array.from({ length: MAX_DOCUMENT_UNITS + 5 }, (_, i) => `Background sentence number ${i} about nothing in particular xyzzy.`).join(" ");
    const first = await verifyClaimTool(ctx(), { text: many } as VerifyArgs, hooks());
    assert.equal(refused(first), undefined);
    assert.equal(unitsOf(S(first)).length, MAX_DOCUMENT_UNITS);
    assert.deepEqual({ total: (S(first).summary as Doc).total, next: S(first).next }, { total: MAX_DOCUMENT_UNITS + 5, next: MAX_DOCUMENT_UNITS });
    assert.match((first as { content: { text: string }[] }).content[0]!.text, new RegExp(`offset ${MAX_DOCUMENT_UNITS}`));
    const second = await verifyClaimTool(ctx(), { text: many, offset: MAX_DOCUMENT_UNITS } as VerifyArgs, hooks());
    assert.equal(unitsOf(S(second)).length, 5);
    assert.equal(S(second).next, null, "the last page names no next offset");
  });

  it("document and text are exclusive with the claim modes", async () => {
    twoPapers();
    const h = hooks();
    const bad = { claim: "Cells age faster at high temperature.", papers: "all", document: "manuscript/main.tex" };
    assert.equal(refused(await verifyClaimTool(ctx(), bad as unknown as VerifyArgs, h)), "ARGUMENT_INVALID");
    assert.equal(refused(await verifyClaimTool(ctx(), { document: "manuscript/main.tex", text: "something" } as unknown as VerifyArgs, h)), "ARGUMENT_INVALID");
    assert.equal(refused(await verifyClaimTool(ctx(), { text: "short" } as VerifyArgs, h)), undefined, "short fragments still check");
    assert.equal(refused(await verifyClaimTool(ctx(), { document: "manuscript/nope.tex" } as VerifyArgs, h)), "ARGUMENT_INVALID");
  });
});

describe("verify document mode: unit bounds, identity memo, empty input, partial cites", () => {
  it("skips units outside the claim-length bounds instead of spending checks on them", async () => {
    twoPapers();
    const builds = { n: 0 };
    const inner = hooks();
    const h: VerifyHooks = {
      fetchImpl: inner.fetchImpl,
      createEngine: (name) => {
        builds.n += 1;
        return inner.createEngine!(name);
      },
    };
    const long = `Word ${"x".repeat(3000)} end.`;
    assert.ok(long.length > 2000, "the long unit exceeds the claim maximum");
    const r = await verifyClaimTool(ctx(), { text: `${section("Length")} Boils. ${long}` } as VerifyArgs, h);
    assert.equal(refused(r), undefined);
    const s = S(r);
    assert.ok(Value.Check(VerifyDocumentOutput, s), "document output matches its schema");
    const us = unitsOf(s);
    assert.equal(us.length, 2);
    assert.equal(us[0]?.status, "skipped");
    assert.equal((us[0] as Doc).reason, "too short");
    assert.equal(us[1]?.status, "skipped");
    assert.equal((us[1] as Doc).reason, "too long — split it");
    assert.equal((s.summary as Doc).skipped, 2);
    assert.equal(builds.n, 0, "skipped units cost no engine checks");
    const text = (r as { content: { text: string }[] }).content[0]!.text;
    assert.match(text, /skipped/);
    assert.match(text, /too short/);
    assert.match(text, /too long/);
  });

  it("probes the engine identity once for a whole document call", async () => {
    twoPapers();
    let probes = 0;
    const h: VerifyHooks = {
      fetchImpl: (async () => {
        probes += 1;
        return new Response("nope", { status: 404 });
      }) as unknown as typeof fetch,
      createEngine: () => ({ run: async (rows: { state: string; instructions: string }[]) => rows.map(() => 0.05) }),
    };
    const c: ToolContext = {
      root,
      fetch: (async () => {
        throw new Error("no network");
      }) as ToolContext["fetch"],
      env: {},
      now: NOW,
      queue: new WriteQueue(),
    };
    const text = [0, 1, 2].map((i) => `Background sentence number ${i} about nothing in particular xyzzy.`).join(" ");
    const r = await verifyClaimTool(c, { text } as VerifyArgs, h);
    assert.equal(refused(r), undefined);
    assert.equal(unitsOf(S(r)).length, 3);
    assert.equal(probes, 1, "three unit checks share one identity probe");
    const again = await verifyClaimTool(c, { text } as VerifyArgs, h);
    assert.equal(refused(again), undefined);
    assert.equal(probes, 1, "the identity stays memoized per process and configuration");
  });

  it("refuses a fragment with no checkable units", async () => {
    twoPapers();
    for (const text of ["", "   "]) {
      const r = await verifyClaimTool(ctx(), { text } as VerifyArgs, hooks());
      assert.equal(refused(r), "ARGUMENT_INVALID");
      assert.match((r as { content: { text: string }[] }).content[0]!.text, /no checkable units/);
    }
  });

  it("checks units with partially unknown citekeys against the registered papers and reports the unknown keys", async () => {
    twoPapers();
    const known = keys[BERLIN_A]!;
    const text = [`${section("Background")} ${TEMP} ${cite(`${known},nosuchkey`)}.`, `A claim with an unknown key ${cite("alsounknown")}.`, ""].join("\n");
    const r = await verifyClaimTool(ctx(), { text } as VerifyArgs, hooks());
    assert.equal(refused(r), undefined);
    const s = S(r);
    assert.ok(Value.Check(VerifyDocumentOutput, s), "document output matches its schema");
    const us = unitsOf(s);
    const mixed = us.find((u) => cited(u, known));
    assert.equal(mixed?.status, "supported", "the registered paper is still checked");
    assert.deepEqual((mixed as Doc).unregistered, ["nosuchkey"]);
    const onlyUnknown = us.find((u) => cited(u, "alsounknown"));
    assert.equal(onlyUnknown?.status, "unregistered", "a unit citing only unknown keys stays unregistered");
    assert.match((r as { content: { text: string }[] }).content[0]!.text, /unknown citekey: nosuchkey/);
  });

  it("marks top-10 candidate-limited units complete when all selected candidates are judged, and incomplete only when interrupted or a source is unavailable", async () => {
    // A paper with 15 chunks (> 10) triggers candidate_limited under the hosted top10 default.
    const paragraphs = Array.from({ length: 15 }, (_, i) =>
      i === 0 ? `${TEMP} (${MARK} alpha).` : `Paragraph ${i} with distinct filler words ${"w".repeat(120)} end.`,
    );
    registerPaper(db, { doi: BERLIN_A, title: "Berlin A", authors: ["Holder, Ada"], year: 2024, bibtex: BIB.replace("x,", "ba,"), bibtexSource: "crossref" }, { now: NOW });
    const smallChunkCfg = { chunk_tokens: 40, overlap_tokens: 0, chars_per_token: 2.8, boundary: "paragraph" as const };
    publishSource(db, BERLIN_A, { kind: "local-file", ref: "ba.pdf", license: null, digest: "a".padStart(64, "0"), extraction: "t@1", text: paragraphs.join("\n\n"), pageStarts: [0] }, smallChunkCfg, NOW());
    const key = (db.prepare("SELECT citekey FROM papers WHERE doi = ?").get(BERLIN_A) as { citekey: string }).citekey;

    const text = `${section("Background")} ${TEMP} ${cite(key)}. ${CHEESE} ${cite(key)}.`;
    const r = await verifyClaimTool(ctx(), { text } as VerifyArgs, hooks());
    assert.equal(refused(r), undefined);
    const s = S(r);
    assert.equal((s.summary as Doc).incomplete, 0, "candidate-limited top10 check that judged all 10 candidates is not an incomplete document unit");
    for (const u of unitsOf(s)) assert.equal(u.complete, true);
    assert.doesNotMatch((r as { content: { text: string }[] }).content[0]!.text, /incomplete check/);
  });
});
