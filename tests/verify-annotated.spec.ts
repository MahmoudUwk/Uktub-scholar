/**
 * W4 annotated verification, snapshots w4a (pure helpers) and w4b (prime+replay).
 * w4a offline: no registry, no engine, invented headings only.
 * w4b offline: fake engine via hooks, invented fixture text, real SQLite,
 * parsed input from the real parseAnnotatedOutput, no units env flag.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
// Side-effect import first: tools/verify.ts and verify/document.ts import each
// other, so document.ts must never evaluate first (else VerifyParams reads an
// uninitialized MAX_DOCUMENT_UNITS).
import "../src/core/tools/verify.ts";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { SourceRef } from "../src/core/verify/annotations.ts";
import { parseAnnotatedOutput } from "../src/core/verify/annotations.ts";
import { matchStatedUnits, type MatchUnit } from "../src/core/verify/annotated.ts";
import type { GridResult } from "../src/core/verify/judge.ts";
import { mergeGrids } from "../src/core/verify/annotated.ts";
import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry, registerPaper } from "../src/core/registry.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import { verifyAnnotatedTool, verifyClaimTool, type VerifyHooks } from "../src/core/tools/verify.ts";
import { documentWorkflow, type DocumentRequest } from "../src/core/verify/document.ts";
import type { SectionMark } from "../src/core/sections.ts";
import { publishSource, claimHashOf } from "../src/core/verify/store.ts";
import { loadPaperUnits } from "../src/core/verify/unit-select.ts";
import { SECTION_UNIT_MAX_CHARS } from "../src/core/verify/paper-units.ts";

const DOI = "10.9999/invented-a";
const REV = "0123456789abcdef";

const units = (sections: string[]): MatchUnit[] => {
  let off = 0;
  return sections.map((section) => {
    const u = { start: off, end: off + 100, section };
    off += 100;
    return u;
  });
};

const sectionRef = (heading: string): SourceRef => ({ kind: "section", heading });
const ptrRef = (doi: string, revision: string, start: number, end: number): SourceRef => ({
  kind: "pointer",
  pointer: `${doi}@${revision}#${start}-${end}`,
  doi,
  revision,
  start,
  end,
});

const grid = (over: Partial<GridResult> = {}): GridResult => ({
  scores: new Map(),
  cached: 0,
  fresh: 0,
  unchecked: [],
  interruption: null,
  ...over,
});

describe("W4.1 stated-section matcher", () => {
  it("W4.1 section match is whitespace-collapsed exact-case", () => {
    const u = units(["Results"]);
    const hit = matchStatedUnits(u, DOI, REV, [sectionRef("  Results\n\t")]);
    assert.deepEqual(hit.matched, [0]);
    assert.deepEqual(hit.unresolved, []);
    const miss = matchStatedUnits(u, DOI, REV, [sectionRef("results")]);
    assert.deepEqual(miss.matched, []);
    assert.equal(miss.unresolved.length, 1);
  });

  it("W4.1 all pieces of an oversize section match", () => {
    const u = units(["Results", "Results", "Method"]);
    const hit = matchStatedUnits(u, DOI, REV, [sectionRef("Results")]);
    assert.deepEqual(hit.matched, [0, 1]);
  });

  it("W4.1 unknown heading is unresolved", () => {
    const u = units(["Results"]);
    const ref = sectionRef("NoSuchHeading");
    const hit = matchStatedUnits(u, DOI, REV, [ref]);
    assert.deepEqual(hit.matched, []);
    assert.deepEqual(hit.unresolved, [ref]);
  });

  it("W4.1 a 300-char heading matches in its clipLabel form", () => {
    const long = `Invented heading ${"x".repeat(283)}`;
    assert.equal(long.length, 300);
    const clipped = `${long.slice(0, 199)}…`;
    const u = units([clipped]);
    const full = matchStatedUnits(u, DOI, REV, [sectionRef(long)]);
    assert.deepEqual(full.matched, [0]);
    const clip = matchStatedUnits(u, DOI, REV, [sectionRef(clipped)]);
    assert.deepEqual(clip.matched, [0]);
  });
});

describe("W4.2 stated-pointer matcher", () => {
  it("W4.2 an inner pointer matches its unit", () => {
    const u = units(["Results"]);
    u[0] = { start: 100, end: 200, section: "Results" };
    const hit = matchStatedUnits(u, DOI, REV, [ptrRef(DOI, REV, 120, 150)]);
    assert.deepEqual(hit.matched, [0]);
  });

  it("W4.2 a pointer touching the end does not match", () => {
    const u = [{ start: 100, end: 200, section: "Results" }];
    const ref = ptrRef(DOI, REV, 200, 250);
    const hit = matchStatedUnits(u, DOI, REV, [ref]);
    assert.deepEqual(hit.matched, []);
    assert.deepEqual(hit.unresolved, [ref]);
  });

  it("W4.2 a pointer spanning two units matches both", () => {
    const u = [
      { start: 0, end: 100, section: "Results" },
      { start: 100, end: 200, section: "Results" },
    ];
    const hit = matchStatedUnits(u, DOI, REV, [ptrRef(DOI, REV, 50, 150)]);
    assert.deepEqual(hit.matched, [0, 1]);
  });

  it("W4.2 another revision or doi is unresolved", () => {
    const u = [{ start: 0, end: 200, section: "Results" }];
    const rev = matchStatedUnits(u, DOI, REV, [ptrRef(DOI, "fedcba9876543210", 10, 20)]);
    assert.deepEqual(rev.matched, []);
    assert.equal(rev.unresolved.length, 1);
    const doi = matchStatedUnits(u, DOI, REV, [ptrRef("10.9999/invented-b", REV, 10, 20)]);
    assert.deepEqual(doi.matched, []);
    assert.equal(doi.unresolved.length, 1);
  });
});

describe("W4.3 mergeGrids", () => {
  it("W4.3 scores union and counts sum", () => {
    const a = grid({ scores: new Map([["c1", new Map([["u1", 0.99]])]]), cached: 1, fresh: 2 });
    const b = grid({ scores: new Map([["c1", new Map([["u2", 0.5]])]]), cached: 3, fresh: 4 });
    const m = mergeGrids(a, b);
    assert.equal(m.scores.get("c1")?.get("u1"), 0.99);
    assert.equal(m.scores.get("c1")?.get("u2"), 0.5);
    assert.equal(m.cached, 4);
    assert.equal(m.fresh, 6);
  });

  it("W4.3 interruption precedence is cancelled over engine_failure over budget", () => {
    const cancelled = grid({ interruption: { reason: "cancelled", detail: "a" } });
    const failed = grid({ interruption: { reason: "engine_failure", detail: "b" } });
    const budget = grid({ interruption: { reason: "budget", detail: "c" } });
    assert.equal(mergeGrids(failed, budget).interruption?.reason, "engine_failure");
    assert.equal(mergeGrids(cancelled, budget).interruption?.reason, "cancelled");
    assert.equal(mergeGrids(failed, cancelled).interruption?.reason, "cancelled");
    assert.equal(mergeGrids(grid(), budget).interruption?.reason, "budget");
    assert.equal(mergeGrids(grid(), grid()).interruption, null);
  });

  it("W4.3 a duplicate cell keeps the first grid score", () => {
    const a = grid({ scores: new Map([["c1", new Map([["u1", 0.99]])]]) });
    const b = grid({ scores: new Map([["c1", new Map([["u1", 0.01]])]]) });
    assert.equal(mergeGrids(a, b).scores.get("c1")?.get("u1"), 0.99);
  });
});

// ── w4b fixtures: registry, sectioned papers, fake engine, real parser ──────

const NOW = (): Date => new Date("2026-10-04T12:00:00Z");
const BIB = "@article{x, title={T}, author={Holder, Ada}, year={2024}}";
// No UKTUB_VERIFY_STRATEGY: the annotated path must take the unit path on its own.
const ENV = { UKTUB_VERIFY_MODEL_ID: "test-model" };

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-w4b-"));
  db = createRegistry(root);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const filler = (tag: string, n: number): string => `${tag} ` + "The experiment records many independent measurements of the cell. ".repeat(Math.ceil(n / 65)).slice(0, n);

function sectionedPaper(sections: [string, string][]): { text: string; marks: SectionMark[] } {
  const parts: string[] = [];
  const marks: SectionMark[] = [];
  let off = 0;
  sections.forEach(([heading, body], i) => {
    if (i > 0) {
      parts.push("\n\n");
      off += 2;
    }
    marks.push({ start: off, heading, level: 1 });
    const chunk = `${heading}\n\n${body}`;
    parts.push(chunk);
    off += chunk.length;
  });
  return { text: parts.join(""), marks };
}

function addPaper(doi: string, title: string, text: string, marks?: SectionMark[]): void {
  registerPaper(db, { doi, title, authors: ["Holder, Ada"], year: 2024, bibtex: BIB.replace("x,", `${doi.slice(-3)},`), bibtexSource: "crossref" }, { now: NOW });
  const cfg = { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 2.8, boundary: "paragraph" as const };
  publishSource(db, doi, { kind: "local-file", ref: `${doi.slice(-3)}.pdf`, license: null, digest: `${doi.length}${doi}`.padStart(64, "0"), extraction: "t@1", text, pageStarts: [0], ...(marks === undefined ? {} : { sections: marks }) }, cfg, NOW());
}

function writeConfig(opts: { maxJudgments?: number; engine?: string } = {}): void {
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "chunking.yaml"),
    `chunking:\n  chunk_tokens: 256\n  overlap_tokens: 0\n  chars_per_token: 2.8\n  boundary: paragraph\nverification:\n  engine: ${opts.engine ?? "hosted"}\n  min_confidence: 0.99\n  workers: 2\n  max_judgments: ${opts.maxJudgments ?? 200}\n`,
  );
}

type Scorer = (row: { state: string; instructions: string }) => number;

function engine(score: Scorer): { hooks: VerifyHooks; calls: { state: string; instructions: string }[][] } {
  const calls: { state: string; instructions: string }[][] = [];
  const hooks: VerifyHooks = {
    fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    createEngine: () => ({
      run: async (rows) => {
        calls.push(rows.map((r) => ({ state: r.state, instructions: r.instructions })));
        return rows.map(score);
      },
    }),
  };
  (hooks as { calls?: { state: string; instructions: string }[][] }).calls = calls;
  return { hooks, calls };
}

function ctx(): ToolContext {
  return {
    root,
    fetch: (async () => {
      throw new Error("no network");
    }) as ToolContext["fetch"],
    env: ENV,
    now: NOW,
    queue: new WriteQueue(),
  };
}

const keysOf = (doi: string): string => (db.prepare("SELECT citekey FROM papers WHERE doi = ?").get(doi) as { citekey: string }).citekey;
const cite = (k: string): string => `\\cite{${k}}`;

/** Writer output for one claim per paragraph plus its source lines, through the real parser. */
function parseClaim(lines: { text: string; cites: string; marker: number }[], sources: string[]): ReturnType<typeof parseAnnotatedOutput> {
  const body = ["\\section{S}", ...lines.map((l) => `${l.text} ${l.cites} % c${l.marker}`)];
  return parseAnnotatedOutput(`${body.join("\n\n")}\n---SOURCES---\n${sources.join("\n")}\n`);
}

type AnnOutcome = { status: string; supportWhere?: { citekey: string; at: string }[]; unresolvedStated?: string[]; pointers: string[]; failedCites?: string[]; suggested: string[]; complete: boolean };
const annUnits = (r: { result: Record<string, any> }): AnnOutcome[] => r.result.units as AnnOutcome[];

async function checkAnnotated(parsed: ReturnType<typeof parseAnnotatedOutput>, hooks: VerifyHooks): Promise<{ result: Record<string, any>; calls: { state: string; instructions: string }[][] }> {
  assert.equal(parsed.mode, "annotated");
  const req: DocumentRequest = { text: parsed.latex, annotated: { claims: parsed.claims } };
  const out = await documentWorkflow(ctx(), db, req, hooks);
  assert.equal(out.kind, "ok", out.kind === "refused" ? `${out.code}: ${out.message}` : "ok");
  return { result: (out as { result: Record<string, any> }).result, calls: (hooks as { calls?: { state: string; instructions: string }[][] }).calls ?? [] };
}

const byMark =
  (mark: string): Scorer =>
  (r) =>
    r.state.toLowerCase().includes(mark) && r.instructions.toLowerCase().includes(mark) ? 0.999 : 0.05;

const spanOf = (text: string, marks: SectionMark[], i: number): [number, number] => [
  marks[i].start,
  i + 1 < marks.length ? marks[i + 1].start : text.length,
];
const pointerSpan = (pointer: string): [number, number] => {
  const m = /#(\d+)-(\d+)$/.exec(pointer);
  assert.ok(m !== null, `pointer has a span: ${pointer}`);
  return [Number(m![1]), Number(m![2])];
};

describe("W4.4 stated-first prime and replay", () => {
  it("W4.4 stated support judges only stated units, reports stated, points inside them", async () => {
    const { text, marks } = sectionedPaper([
      ["Background", `${filler("backgroundonly", 400)}`],
      ["Results", `${filler("re", 300)}\n\nAlphamark finding holds in the tested cells with scatter below twelve percent.\n\n${filler("re-b", 300)}`],
      ["Appendix", `${filler("appendixonly", 400)}`],
    ]);
    addPaper("10.1111/w44a", "Paper A", text, marks);
    writeConfig();
    const ka = keysOf("10.1111/w44a");
    const parsed = parseClaim(
      [{ text: "The alphamark finding holds in the tested cells today", cites: cite(ka), marker: 1 }],
      [`c1 | ${ka} | section=Results`],
    );
    const { hooks, calls } = engine(byMark("alphamark"));
    const { result } = await checkAnnotated(parsed, hooks);
    const [u] = annUnits({ result });
    assert.equal(u.status, "supported");
    assert.deepEqual(u.supportWhere, [{ citekey: ka, at: "stated" }]);
    const [rStart, rEnd] = spanOf(text, marks, 1);
    const resultsText = text.slice(rStart, rEnd);
    assert.ok(calls.length > 0, "the engine was called");
    for (const call of calls) {
      for (const row of call) {
        assert.ok(resultsText.includes(row.state), `every sent state is a Results slice, got ${row.state.length} chars`);
        assert.ok(!row.state.includes("backgroundonly"), "no Background text ever sent");
        assert.ok(!row.state.includes("appendixonly"), "no Appendix text ever sent");
      }
    }
    assert.ok(u.pointers.length > 0, "a pointer is present");
    for (const p of u.pointers) {
      const [s, e] = pointerSpan(p);
      assert.ok(s >= rStart && e <= rEnd, `pointer ${p} lies inside Results`);
    }
  });
});

describe("W4.5 elsewhere", () => {
  it("W4.5 stated miss then rest-of-paper support is elsewhere", async () => {
    const { text, marks } = sectionedPaper([
      ["Background", `${filler("backgroundonly", 300)}`],
      ["Method", `${filler("methodonly", 500)}`],
      ["Appendix", `${filler("ap", 200)}\n\nBetamark finding repeats across the control samples.\n\n${filler("ap-b", 200)}`],
    ]);
    addPaper("10.1111/w45a", "Paper B", text, marks);
    writeConfig();
    const kb = keysOf("10.1111/w45a");
    const parsed = parseClaim(
      [{ text: "The betamark finding repeats across the control samples today", cites: cite(kb), marker: 1 }],
      [`c1 | ${kb} | section=Method`],
    );
    const { hooks, calls } = engine(byMark("betamark"));
    const { result } = await checkAnnotated(parsed, hooks);
    const [u] = annUnits({ result });
    assert.equal(u.status, "supported");
    assert.deepEqual(u.supportWhere, [{ citekey: kb, at: "elsewhere" }]);
    const [mStart, mEnd] = spanOf(text, marks, 1);
    const methodText = text.slice(mStart, mEnd);
    assert.ok(calls.length >= 2, `expected a first and a later call, got ${calls.length}`);
    for (const row of calls[0]) assert.ok(methodText.includes(row.state), "the first call sends only Method");
    assert.ok(calls.slice(1).some((call) => call.some((row) => row.state.includes("Betamark"))), "a later call sends the rest");
    const [aStart, aEnd] = spanOf(text, marks, 2);
    for (const p of u.pointers) {
      const [s, e] = pointerSpan(p);
      assert.ok(s >= aStart && e <= aEnd, `pointer ${p} lies inside Appendix`);
    }
  });
});

describe("W4.6 every cited paper", () => {
  it("W4.6 stated plus elsewhere support; a nowhere paper fails with its pointer kept and no third text", async () => {
    const a = sectionedPaper([
      ["Background", `${filler("abg", 300)}`],
      ["Results", `${filler("are", 200)}\n\nAlphamark finding holds in the tested cells.\n\n${filler("are-b", 200)}`],
    ]);
    addPaper("10.1111/w46a", "Paper A", a.text, a.marks);
    const b = sectionedPaper([
      ["Background", `${filler("bbg", 300)}`],
      ["Method", `${filler("bme", 400)}`],
      ["Discussion", `${filler("bdi", 200)}\n\nBetamark finding repeats across the control samples.\n\n${filler("bdi-b", 200)}`],
    ]);
    addPaper("10.1111/w46b", "Paper B", b.text, b.marks);
    const c = sectionedPaper([["Results", `${filler("gammaonly", 600)}`]]);
    addPaper("10.1111/w46c", "Paper C", c.text, c.marks);
    writeConfig();
    const ka = keysOf("10.1111/w46a");
    const kb = keysOf("10.1111/w46b");
    const both: Scorer = (r) =>
      byMark("alphamark")(r) === 0.999 || byMark("betamark")(r) === 0.999 ? 0.999 : 0.05;
    const parsed = parseClaim(
      [{ text: "The alphamark finding holds and the betamark finding repeats today", cites: `${cite(ka)} ${cite(kb)}`, marker: 1 }],
      [`c1 | ${ka} | section=Results`, `c1 | ${kb} | section=Method`],
    );
    const g1 = engine(both);
    const r1 = await checkAnnotated(parsed, g1.hooks);
    const [u1] = annUnits(r1);
    assert.equal(u1.status, "supported");
    assert.deepEqual(u1.supportWhere, [
      { citekey: ka, at: "stated" },
      { citekey: kb, at: "elsewhere" },
    ]);

    const parsed2 = parseClaim(
      [{ text: "The alphamark finding holds in the tested cells today", cites: `${cite(ka)} ${cite(kb)}`, marker: 1 }],
      [`c1 | ${ka} | section=Results`, `c1 | ${kb} | section=Method`],
    );
    const g2 = engine(both);
    const r2 = await checkAnnotated(parsed2, g2.hooks);
    const [u2] = annUnits(r2);
    assert.equal(u2.status, "cited-unsupported");
    assert.deepEqual(u2.failedCites, [kb]);
    // A paper that supports nowhere has no support location: only supporting cites are labelled.
    assert.deepEqual(u2.supportWhere, [{ citekey: ka, at: "stated" }]);
    assert.ok(u2.pointers.length > 0, "the supporting cite keeps its pointer");
    for (const call of g2.calls) {
      for (const row of call) assert.ok(!row.state.includes("gammaonly"), "no third paper text ever sent");
    }
  });
});

describe("W4.7 unresolved refs", () => {
  it("W4.7 refs resolving to no unit are judged over all units, elsewhere, named", async () => {
    const { text, marks } = sectionedPaper([
      ["Background", `${filler("backgroundonly", 300)}`],
      ["Results", `${filler("re", 400)}`],
      ["Appendix", `${filler("ap", 200)}\n\nDeltamark finding holds across the cohorts.\n\n${filler("ap-b", 200)}`],
    ]);
    addPaper("10.1111/w47a", "Paper D", text, marks);
    writeConfig();
    const kd = keysOf("10.1111/w47a");
    const parsed = parseClaim(
      [{ text: "The deltamark finding holds across the cohorts today", cites: cite(kd), marker: 1 }],
      [`c1 | ${kd} | section=NoSuchSection`, `c1 | ${kd} | ptr=10.1111/w47a@fedcba9876543210#0-10`],
    );
    const { hooks, calls } = engine(byMark("deltamark"));
    const { result } = await checkAnnotated(parsed, hooks);
    const [u] = annUnits({ result });
    assert.equal(u.status, "supported");
    assert.deepEqual(u.supportWhere, [{ citekey: kd, at: "elsewhere" }]);
    assert.ok((u.unresolvedStated ?? []).includes(kd), "unresolvedStated names the ref");
    const states = calls.flat().map((row) => row.state);
    assert.ok(states.some((s) => s.includes("backgroundonly")), "judged over all units");
    assert.ok(states.some((s) => s.includes("Deltamark")), "judged over all units");
  });
});

describe("W4.8 unstated", () => {
  it("W4.8 a source-missing cite is checked over all units, at unstated", async () => {
    const a = sectionedPaper([
      ["Background", `${filler("abg", 300)}`],
      ["Results", `${filler("are", 200)}\n\nAlphamark finding holds in the tested cells.\n\n${filler("are-b", 200)}`],
    ]);
    addPaper("10.1111/w48a", "Paper A", a.text, a.marks);
    const b = sectionedPaper([
      ["Background", `${filler("bbg", 300)}`],
      ["Discussion", `${filler("bdi", 200)}\n\nBetamark finding repeats across the control samples.\n\n${filler("bdi-b", 200)}`],
    ]);
    addPaper("10.1111/w48b", "Paper B", b.text, b.marks);
    writeConfig();
    const ka = keysOf("10.1111/w48a");
    const kb = keysOf("10.1111/w48b");
    const both: Scorer = (r) =>
      byMark("alphamark")(r) === 0.999 || byMark("betamark")(r) === 0.999 ? 0.999 : 0.05;
    const parsed = parseClaim(
      [{ text: "The alphamark finding holds and the betamark finding repeats today", cites: `${cite(ka)} ${cite(kb)}`, marker: 1 }],
      [`c1 | ${ka} | section=Results`],
    );
    assert.ok(parsed.problems.some((p) => p.code === "source-missing"), "the second cite is source-missing");
    const { hooks, calls } = engine(both);
    const { result } = await checkAnnotated(parsed, hooks);
    const [u] = annUnits({ result });
    assert.equal(u.status, "supported");
    assert.deepEqual(u.supportWhere, [
      { citekey: ka, at: "stated" },
      { citekey: kb, at: "unstated" },
    ]);
    const states = calls.flat().map((row) => row.state);
    assert.ok(states.some((s) => s.includes("Betamark")), "the unstated paper is checked over all units");
  });
});

describe("W4.10 unit path without the env", () => {
  it("W4.10 states are section slices and the replay sends no unprimed cell", async () => {
    const { text, marks } = sectionedPaper([
      ["Background", `${filler("backgroundonly", 400)}`],
      ["Results", `${filler("re", 900)}\n\nAlphamark finding holds in the tested cells with scatter below twelve percent.\n\n${filler("re-b", 900)}`],
    ]);
    addPaper("10.1111/w410a", "Paper A", text, marks);
    writeConfig();
    const ka = keysOf("10.1111/w410a");
    const parsed = parseClaim(
      [{ text: "The alphamark finding holds in the tested cells today", cites: cite(ka), marker: 1 }],
      [`c1 | ${ka} | section=Results`],
    );
    const { hooks, calls } = engine(byMark("alphamark"));
    const { result } = await checkAnnotated(parsed, hooks);
    const [u] = annUnits({ result });
    assert.equal(u.status, "supported");
    const states = calls.flat().map((row) => row.state);
    assert.ok(states.some((s) => s.length > 1434), "a state is a section slice, not a 512-token chunk");
    assert.ok(states.every((s) => !s.includes("backgroundonly")), "no unprimed section ever sent");
    assert.equal(calls.length, 2, `prime round 1 plus localization windows only, got ${calls.length}`);
  });
});

describe("W4.15 batching bound", () => {
  it("W4.15 twelve stated claims over four papers send stated cells in bounded calls", async () => {
    const dois: string[] = [];
    for (let p = 0; p < 4; p++) {
      const doi = `10.1111/w415${String.fromCharCode(97 + p)}`;
      dois.push(doi);
      const { text, marks } = sectionedPaper([
        ["Background", filler(`bgonly${p}`, 300)],
        ["Results", `${filler(`re${p}`, 1200)}\n\nZetamark finding holds in trial ${["one", "two", "three", "four"][p]}.\n\n${filler(`reb${p}`, 1200)}`],
      ]);
      addPaper(doi, `Paper ${p}`, text, marks);
    }
    writeConfig();
    const keys = dois.map(keysOf);
    const numerals = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
    const lines = numerals.map((n, i) => ({
      text: `The zetamark finding holds in run ${n} today`,
      cites: cite(keys[i % 4]),
      marker: i + 1,
    }));
    const sources = numerals.map((_, i) => `c${i + 1} | ${keys[i % 4]} | section=Results`);
    const parsed = parseClaim(lines, sources);
    assert.equal(parsed.mode, "annotated");
    assert.equal(parsed.claims.length, 12);
    const { hooks, calls } = engine(byMark("zetamark"));
    const req: DocumentRequest = { text: parsed.latex, annotated: { claims: parsed.claims } };
    const out = await documentWorkflow(ctx(), db, req, hooks);
    assert.equal(out.kind, "ok");
    const result = (out as { result: Record<string, any> }).result;
    assert.equal((result.summary as { supported: number }).supported, 12);
    const fullUnitRows = calls.flat().filter((row) => row.state.length > 1500).length;
    assert.equal(fullUnitRows, 12, `round-1 rows are the stated cells, got ${fullUnitRows}`);
    assert.ok(calls.length <= 4 + 0 + 12, `total calls bounded, got ${calls.length}`);
  });
});

describe("W4.9 fallback and unmarked units", () => {
  it("W4.9 fallback mode equals the claim-mode check of the bare latex", async () => {
    const { text, marks } = sectionedPaper([
      ["Background", `${filler("backgroundonly", 300)}`],
      ["Results", `${filler("re", 200)}\n\nAlphamark finding holds in the tested cells.\n\n${filler("re-b", 200)}`],
    ]);
    addPaper("10.1111/w49a", "Paper A", text, marks);
    writeConfig();
    const ka = keysOf("10.1111/w49a");
    const parsed = parseAnnotatedOutput(`\\section{S}\n\nThe alphamark finding holds in the tested cells today ${cite(ka)}.\n`);
    assert.equal(parsed.mode, "fallback");
    const g1 = engine(byMark("alphamark"));
    const r1 = await verifyAnnotatedTool(ctx(), { parsed }, g1.hooks);
    const g2 = engine(byMark("alphamark"));
    const r2 = await verifyClaimTool(ctx(), { text: parsed.latex }, g2.hooks);
    assert.deepEqual(
      (r1.structuredContent as { units: unknown }).units,
      (r2.structuredContent as { units: unknown }).units,
      "fallback matches document mode unit for unit",
    );
    for (const call of g1.calls) {
      for (const row of call) assert.ok(row.state.length <= 1434, `chunk-path states stay small, got ${row.state.length}`);
    }
  });

  it("W4.9 an unmarked unit is checked over all units of its cited papers with no supportWhere", async () => {
    const a = sectionedPaper([
      ["Background", `${filler("abg", 300)}`],
      ["Results", `${filler("are", 200)}\n\nAlphamark finding holds in the tested cells.\n\n${filler("are-b", 200)}`],
    ]);
    addPaper("10.1111/w49b", "Paper A", a.text, a.marks);
    const b = sectionedPaper([
      ["Background", `${filler("bgonly", 300)}`],
      ["Results", `${filler("bre", 200)}\n\nBetamark finding repeats across the control samples.\n\n${filler("bre-b", 200)}`],
    ]);
    addPaper("10.1111/w49c", "Paper B", b.text, b.marks);
    writeConfig();
    const ka = keysOf("10.1111/w49b");
    const kb = keysOf("10.1111/w49c");
    const both: Scorer = (r) =>
      byMark("alphamark")(r) === 0.999 || byMark("betamark")(r) === 0.999 ? 0.999 : 0.05;
    const parsed = parseAnnotatedOutput(
      `\\section{S}\n\nThe alphamark finding holds in the tested cells today ${cite(ka)}. % c1\n\nThe betamark finding repeats across the control samples today ${cite(kb)}.\n---SOURCES---\nc1 | ${ka} | section=Results\n`,
    );
    assert.equal(parsed.mode, "annotated");
    assert.equal(parsed.claims.length, 1);
    const { hooks, calls } = engine(both);
    const r = await verifyAnnotatedTool(ctx(), { parsed }, hooks);
    const units = annUnits({ result: r.structuredContent as Record<string, any> });
    assert.equal(units.length, 2);
    assert.equal(units[0].status, "supported");
    assert.deepEqual(units[0].supportWhere, [{ citekey: ka, at: "stated" }]);
    assert.equal(units[1].status, "supported");
    assert.equal(units[1].supportWhere, undefined, "an unmarked unit carries no supportWhere");
    const states = calls.flat().map((row) => row.state);
    assert.ok(states.some((s) => s.includes("bgonly")), "the unmarked unit is checked over all units");
  });
});

describe("W4.11 scope", () => {
  it("W4.11 out-of-scope support is unsourced; in-scope names the citation", async () => {
    const o = sectionedPaper([
      ["Background", `${filler("obg", 300)}`],
      ["Results", `${filler("omegaonly", 200)}\n\nOmegamark finding holds in the tested cohorts.\n\n${filler("ore-b", 200)}`],
    ]);
    addPaper("10.1111/w411o", "Paper O", o.text, o.marks);
    const ins = sectionedPaper([["Results", `${filler("inonly", 600)}`]]);
    addPaper("10.1111/w411i", "Paper I", ins.text, ins.marks);
    writeConfig();
    const ko = keysOf("10.1111/w411o");
    const ki = keysOf("10.1111/w411i");
    const parsed = parseAnnotatedOutput(`\\section{S}\n\nThe omegamark finding holds in the tested cohorts today. % c1\n---SOURCES---\n`);
    assert.equal(parsed.mode, "annotated");
    const out = engine(byMark("omegamark"));
    const rOut = await verifyAnnotatedTool(ctx(), { parsed, scope: [ki] }, out.hooks);
    const [uOut] = annUnits({ result: rOut.structuredContent as Record<string, any> });
    assert.equal(uOut.status, "unsourced");
    assert.deepEqual(uOut.suggested, []);
    for (const call of out.calls) {
      for (const row of call) assert.ok(!row.state.includes("omegaonly"), "no row carries out-of-scope text");
    }
    const ins2 = engine(byMark("omegamark"));
    const rIn = await verifyAnnotatedTool(ctx(), { parsed, scope: [ki, ko] }, ins2.hooks);
    const [uIn] = annUnits({ result: rIn.structuredContent as Record<string, any> });
    assert.equal(uIn.status, "missing-citation");
    assert.ok(uIn.suggested.includes(ko), "the in-scope supporter is named");
  });
});

describe("W4.12 ledger", () => {
  it("W4.12 a supported two-paper claim ledgers both dois with pointers in the units", async () => {
    const a = sectionedPaper([
      ["Background", `${filler("abg", 300)}`],
      ["Results", `${filler("are", 200)}\n\nAlphamark finding holds in the tested cells.\n\n${filler("are-b", 200)}`],
    ]);
    addPaper("10.1111/w412a", "Paper A", a.text, a.marks);
    const b = sectionedPaper([
      ["Background", `${filler("bbg", 300)}`],
      ["Discussion", `${filler("bdi", 200)}\n\nBetamark finding repeats across the control samples.\n\n${filler("bdi-b", 200)}`],
    ]);
    addPaper("10.1111/w412b", "Paper B", b.text, b.marks);
    writeConfig();
    const ka = keysOf("10.1111/w412a");
    const kb = keysOf("10.1111/w412b");
    const both: Scorer = (r) =>
      byMark("alphamark")(r) === 0.999 || byMark("betamark")(r) === 0.999 ? 0.999 : 0.05;
    const parsed = parseClaim(
      [{ text: "The alphamark finding holds and the betamark finding repeats today", cites: `${cite(ka)} ${cite(kb)}`, marker: 1 }],
      [`c1 | ${ka} | section=Results`, `c1 | ${kb} | section=Discussion`],
    );
    const { hooks } = engine(both);
    const r = await verifyAnnotatedTool(ctx(), { parsed }, hooks);
    const [u] = annUnits({ result: r.structuredContent as Record<string, any> });
    assert.equal(u.status, "supported");
    const ch = claimHashOf(parsed.claims[0].plain);
    const rows = db.prepare("SELECT doi, char_start, char_end FROM claim_ledger WHERE claim_hash = ?").all(ch) as {
      doi: string;
      char_start: number;
      char_end: number;
    }[];
    const dois = new Set(rows.map((row) => row.doi));
    assert.ok(dois.has("10.1111/w412a") && dois.has("10.1111/w412b"), `both dois ledgered, got ${[...dois]}`);
    for (const row of rows) {
      const loaded = loadPaperUnits(db, row.doi, SECTION_UNIT_MAX_CHARS);
      assert.ok(loaded !== null, `units load for ${row.doi}`);
      assert.ok(
        loaded!.units.some((un) => un.start <= row.char_start && row.char_end <= un.end),
        `pointer ${row.char_start}-${row.char_end} lies inside a judged unit of ${row.doi}`,
      );
    }
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 6);
  });
});

describe("W4.13 cache", () => {
  it("W4.13 a repeat call sends nothing; an edited sentence resends only its cells", async () => {
    const a = sectionedPaper([
      ["Background", `${filler("abg", 300)}`],
      ["Results", `${filler("are", 200)}\n\nPrimamark finding holds in the tested cells.\n\n${filler("are-b", 200)}`],
    ]);
    addPaper("10.1111/w413a", "Paper A", a.text, a.marks);
    const b = sectionedPaper([
      ["Background", `${filler("bbg", 300)}`],
      ["Results", `${filler("bre", 200)}\n\nSecundamark finding repeats across the control samples.\n\n${filler("bre-b", 200)}`],
    ]);
    addPaper("10.1111/w413b", "Paper B", b.text, b.marks);
    writeConfig();
    const ka = keysOf("10.1111/w413a");
    const kb = keysOf("10.1111/w413b");
    const both: Scorer = (r) =>
      byMark("primamark")(r) === 0.999 || byMark("secundamark")(r) === 0.999 ? 0.999 : 0.05;
    const raw = (second: string): string =>
      `\\section{S}\n\nThe primamark finding holds in run one today ${cite(ka)}. % c1\n\n${second} ${cite(kb)}. % c2\n---SOURCES---\nc1 | ${ka} | section=Results\nc2 | ${kb} | section=Results\n`;
    const g = engine(both);
    const first = parseAnnotatedOutput(raw("The secundamark finding repeats in run two today"));
    const r1 = await verifyAnnotatedTool(ctx(), { parsed: first }, g.hooks);
    assert.equal(annUnits({ result: r1.structuredContent as Record<string, any> }).filter((u) => u.status === "supported").length, 2);
    assert.ok(g.calls.length > 0, "the first call judges");
    g.calls.length = 0;
    const repeat = parseAnnotatedOutput(raw("The secundamark finding repeats in run two today"));
    await verifyAnnotatedTool(ctx(), { parsed: repeat }, g.hooks);
    assert.equal(g.calls.length, 0, "a second identical call sends 0 rows");
    const edited = parseAnnotatedOutput(raw("The secundamark finding repeats in run two today revisededition"));
    const r3 = await verifyAnnotatedTool(ctx(), { parsed: edited }, g.hooks);
    assert.equal(annUnits({ result: r3.structuredContent as Record<string, any> }).filter((u) => u.status === "supported").length, 2);
    const resent = g.calls.flat();
    assert.ok(resent.length > 0, "the edit resends cells");
    for (const row of resent) {
      assert.ok(row.instructions.includes("revisededition"), "only the edited claim is rejudged");
      assert.ok(!row.state.includes("Primamark"), "no other claim cell is resent");
    }
  });
});

describe("W4.14 cancel and budget", () => {
  it("W4.14 cancel after round 1 sends nothing further", async () => {
    const { text, marks } = sectionedPaper([
      ["Background", `${filler("backgroundonly", 400)}`],
      ["Results", `${filler("re", 300)}\n\nAlphamark finding holds in the tested cells.\n\n${filler("re-b", 300)}`],
    ]);
    addPaper("10.1111/w414a", "Paper A", text, marks);
    writeConfig();
    const ka = keysOf("10.1111/w414a");
    const parsed = parseClaim(
      [{ text: "The alphamark finding holds in the tested cells today", cites: cite(ka), marker: 1 }],
      [`c1 | ${ka} | section=Results`],
    );
    const controller = new AbortController();
    const calls: { state: string; instructions: string }[][] = [];
    const hooks: VerifyHooks = {
      fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
      createEngine: () => ({
        run: async (rows) => {
          calls.push(rows.map((r) => ({ state: r.state, instructions: r.instructions })));
          if (calls.length >= 1) controller.abort();
          return rows.map(byMark("alphamark"));
        },
      }),
    };
    const cctx: ToolContext = { ...ctx(), signal: controller.signal };
    await assert.rejects(verifyAnnotatedTool(cctx, { parsed }, hooks), (e: unknown) => (e as Error).name === "CancelledError");
    assert.equal(calls.length, 1, `nothing sent after round 1, got ${calls.length} calls`);
  });

  it("W4.14 a tiny budget is incomplete but neither crashes nor refuses", async () => {
    const { text, marks } = sectionedPaper([
      ["Background", `${filler("backgroundonly", 400)}`],
      ["Results", `${filler("re", 200)}\n\nAlphamark finding holds in the tested cells.\n\n${filler("re-b", 2200)}`],
    ]);
    addPaper("10.1111/w414b", "Paper B", text, marks);
    writeConfig({ maxJudgments: 1 });
    const kb = keysOf("10.1111/w414b");
    const parsed = parseClaim(
      [{ text: "The alphamark finding holds in the tested cells today", cites: cite(kb), marker: 1 }],
      [`c1 | ${kb} | section=Results`],
    );
    const { hooks, calls } = engine(byMark("alphamark"));
    const r = await verifyAnnotatedTool(ctx(), { parsed }, hooks);
    assert.equal((r.details.refused as { code?: string } | undefined)?.code, undefined, "no refusal");
    assert.ok(calls.length > 0, "the budget still judges");
    const units = annUnits({ result: r.structuredContent as Record<string, any> });
    assert.ok(units.length > 0);
    for (const u of units) assert.equal(u.complete, false);
  });
});
