/**
 * Phase V4: free-style claim mode on whole-section units.
 * Offline: fake engine via hooks, invented fixture text, real SQLite.
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
import { VerifyClaimOutput, verifyClaimTool, type VerifyClaimArgs, type VerifyHooks } from "../src/core/tools/verify.ts";
import type { SectionMark } from "../src/core/sections.ts";
import { gridBatchSizeOf } from "../src/core/verify/engines.ts";
import { localizePassages } from "../src/core/verify/evidence.ts";
import { passageHashOf, publishSource, resolvePointer } from "../src/core/verify/store.ts";

const CLAIM = "Quasar luminosity rises with redshift in the survey sample.";
const MARK = "quasar luminosity rises with redshift";
const NOW = () => new Date("2026-10-04T12:00:00Z");
const BIB = "@article{x, title={T}, author={Holder, Ada}, year={2024}}";
const SUPPORT = "Measurements show quasar luminosity rises with redshift in the survey sample, with scatter below twelve percent.";

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-vu-"));
  db = createRegistry(root);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// ── fixtures ───────────────────────────────────────────────────────────────

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

const sectionSpan = (text: string, marks: SectionMark[], i: number): [number, number] => [
  marks[i].start,
  i + 1 < marks.length ? marks[i + 1].start : text.length,
];

function addPaper(doi: string, title: string, text: string, marks?: SectionMark[]): void {
  registerPaper(db, { doi, title, authors: ["Holder, Ada"], year: 2024, bibtex: BIB.replace("x,", `${doi.slice(-3)},`), bibtexSource: "crossref" }, { now: NOW });
  // Fine paragraph chunks (256 tokens): BM25 ranks chunk starts and folds to
  // section units; coarse chunks would starve the rank list.
  const cfg = { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 2.8, boundary: "paragraph" as const };
  publishSource(db, doi, { kind: "local-file", ref: `${doi.slice(-3)}.pdf`, license: null, digest: `${doi.length}${doi}`.padStart(64, "0"), extraction: "t@1", text, pageStarts: [0], ...(marks === undefined ? {} : { sections: marks }) }, cfg, NOW());
}

function writeConfig(opts: { maxJudgments?: number; workers?: number; engine?: string; chunkTokens?: number } = {}): void {
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "chunking.yaml"),
    `chunking:\n  chunk_tokens: ${opts.chunkTokens ?? 256}\n  overlap_tokens: 0\n  chars_per_token: 2.8\n  boundary: paragraph\nverification:\n  engine: ${opts.engine ?? "llama-cpp"}\n  min_confidence: 0.99\n  workers: ${opts.workers ?? 2}\n  max_judgments: ${opts.maxJudgments ?? 120}\n`,
  );
}

type Scorer = (row: { state: string; instructions: string }) => number | { failed: string };
const byMark: Scorer = (r) => (r.state.toLowerCase().includes(MARK) && r.instructions === CLAIM ? 0.999 : 0.05);

function engine(score: Scorer = byMark): { hooks: VerifyHooks; stats: { rows: number; calls: number; builds: number; states: string[] } } {
  const stats = { rows: 0, calls: 0, builds: 0, states: [] as string[] };
  const hooks: VerifyHooks = {
    fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    createEngine: () => {
      stats.builds++;
      return {
        run: async (rows) => {
          stats.calls++;
          stats.rows += rows.length;
          stats.states.push(...rows.map((r) => r.state));
          return rows.map(score);
        },
      };
    },
  };
  return { hooks, stats };
}

const UNITS_ENV = { UKTUB_VERIFY_MODEL_ID: "test-model", UKTUB_VERIFY_STRATEGY: "units" };

function ctx(over: Partial<ToolContext> = {}, env: Record<string, string | undefined> = UNITS_ENV): ToolContext {
  return {
    root,
    fetch: (async () => {
      throw new Error("no network");
    }) as ToolContext["fetch"],
    env,
    now: NOW,
    queue: new WriteQueue(),
    ...over,
  };
}
const run = (args: Partial<VerifyClaimArgs> & { claim?: string }, hooks: VerifyHooks, c: ToolContext = ctx()) =>
  verifyClaimTool(c, { claim: CLAIM, ...args } as VerifyClaimArgs, hooks);
type Doc = Record<string, any>;
const S = (r: { structuredContent: unknown }): Doc => r.structuredContent as Doc;
const refused = (r: { details: Record<string, unknown> }): string | undefined => (r.details.refused as { code?: string } | undefined)?.code;
const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join("\n");

const stdPaper = (): { text: string; marks: SectionMark[] } =>
  sectionedPaper([
    ["Background", `${filler("bg", 500)}\n\n${filler("bg-b", 500)}`],
    ["Methods", `${filler("me", 500)}\n\n${filler("me-b", 500)}`],
    ["Results", `${filler("re", 500)}\n\n${SUPPORT}\n\n${filler("re-b", 500)}`],
  ]);

// ── T4.0 pin ───────────────────────────────────────────────────────────────

describe("T4.0 chunk-path pin", () => {
  it("env unset -> chunk states <= 1,434 chars", async () => {
    const { text: paper, marks } = stdPaper();
    addPaper("10.1111/t40a", "Pin Paper", paper, marks);
    const { hooks, stats } = engine();
    const r = await run({ papers: "all" }, hooks, ctx({}, { UKTUB_VERIFY_MODEL_ID: "test-model" }));
    const s = S(r);
    assert.equal(s.result.supportFound, true);
    assert.ok(stats.states.length > 0);
    assert.ok(Math.max(...stats.states.map((t) => t.length)) <= 1_434, `chunk state over 1,434 chars`);
  });
});

// ── explicit lists ─────────────────────────────────────────────────────────

describe("explicit unit lists", () => {
  it("T4.1 explicit list of a 3-section paper sends exactly the 3 section slices, candidates.total 3", async () => {
    const { text: paper, marks } = stdPaper();
    addPaper("10.1111/t41a", "Three Sections", paper, marks);
    writeConfig();
    const { hooks, stats } = engine();
    const r = await run({ papers: ["10.1111/t41a"] }, hooks);
    const s = S(r);
    assert.equal(s.coverage.candidates.total, 3);
    assert.equal(s.result.searched, "exhaustive");
    assert.deepEqual(s.result.limitations.filter((l: string) => l === "candidate_limited"), []);
    const expected = [0, 1, 2].map((i) => {
      const [a, b] = sectionSpan(paper, marks, i);
      return paper.slice(a, b);
    });
    assert.deepEqual(stats.states, expected);
  });

  it("T4.2 References + Results: references text never sent, references_not_checked, excluded 1, complete", async () => {
    const { text: paper, marks } = sectionedPaper([
      ["Results", `${filler("re", 500)}\n\n${SUPPORT}\n\n${filler("re-b", 500)}`],
      ["References", `ZQZQBIB entry one: Holder, Ada (2024). Unrelated bibliography record alpha.\n\nZQZQBIB entry two: Holder, Ada (2023). Unrelated bibliography record beta.`],
    ]);
    addPaper("10.1111/t42a", "With References", paper, marks);
    writeConfig();
    const { hooks, stats } = engine();
    const r = await run({ papers: ["10.1111/t42a"] }, hooks);
    const s = S(r);
    assert.equal(s.result.supportFound, true);
    assert.ok(stats.states.every((t) => !t.includes("ZQZQBIB")), "references text was sent to the engine");
    assert.ok((s.result.limitations as string[]).includes("references_not_checked"));
    assert.equal(s.coverage.candidates.excluded, 1);
    assert.equal(s.result.complete, true);
  });

  it("T4.3 explicit 15 sections on hosted judges all 15, exhaustive", async () => {
    const sections = Array.from({ length: 15 }, (_, i) => [`Section ${i + 1}`, `${filler(`s${i}`, 1400)}\n\n${i === 7 ? `${SUPPORT}\n\n` : ""}${filler(`s${i}-b`, 200)}`] as [string, string]);
    const { text: paper, marks } = sectionedPaper(sections);
    assert.ok(paper.length >= 20_000, `paper too short for excerpt release: ${paper.length}`);
    addPaper("10.1111/t43a", "Fifteen Sections", paper, marks);
    writeConfig({ engine: "hosted" });
    const { hooks, stats } = engine();
    const r = await run({ papers: ["10.1111/t43a"] }, hooks);
    const s = S(r);
    assert.equal(s.result.supportFound, true);
    assert.equal(s.coverage.candidates.total, 15);
    // All 15 units were judged (stage-1 states are the full section slices;
    // stage 2 additionally re-judges localization windows of the support).
    for (let i = 0; i < 15; i++) {
      const [a, b] = sectionSpan(paper, marks, i);
      assert.ok(stats.states.includes(paper.slice(a, b)), `section ${i + 1} never judged`);
    }
    assert.equal(s.result.searched, "exhaustive");
    assert.equal(s.result.complete, true);
  });
});

// ── ranked selection ───────────────────────────────────────────────────────

const MATCH_PARA = "Paragraph noting quasar luminosity and redshift measurements in the sample.";

function rankedPapers(): { A: { text: string; marks: SectionMark[] }; B: { text: string; marks: SectionMark[] } } {
  const a3 = [`Quasar Survey Results`, `${MATCH_PARA} ${filler("a3-0", 200)}\n\n${MATCH_PARA} ${filler("a3-1", 200)}\n\n${SUPPORT}\n\n${MATCH_PARA} ${filler("a3-2", 200)}\n\n${MATCH_PARA} ${filler("a3-3", 200)}\n\n${MATCH_PARA} ${filler("a3-4", 200)}`];
  const aSections: [string, string][] = [
    ["Survey Design", `${MATCH_PARA}\n\n${filler("a1", 1500)}`],
    ["Calibration", `${filler("a2", 1500)}\n\n${MATCH_PARA}`],
    a3 as [string, string],
    ["Noise Model", `${filler("a4", 1500)}\n\n${MATCH_PARA}`],
    ["Data Release", `${MATCH_PARA}\n\n${filler("a5", 1500)}`],
    ["Appendix Tables", filler("a6", 1500)],
    ["Observing Log", filler("a7", 1500)],
    ["Glossary", filler("a8", 1500)],
  ];
  const bSections: [string, string][] = [1, 2, 3, 4, 5, 6].map((i) => [`Part ${i}`, i <= 5 ? `${MATCH_PARA}\n\n${filler(`b${i}`, 1500)}` : filler(`b${i}`, 1500)] as [string, string]);
  const A = sectionedPaper(aSections);
  const B = sectionedPaper(bSections);
  assert.ok(A.text.length >= 10_000 && B.text.length >= 8_000);
  addPaper("10.1111/t44a", "Ranked A", A.text, A.marks);
  addPaper("10.1111/t44b", "Ranked B", B.text, B.marks);
  return { A, B };
}

describe("ranked unit selection", () => {
  it("T4.4 'all' over 2 papers x 8 units judges exactly 10 distinct units, best unit included, six-paragraph section once", async () => {
    const { A } = rankedPapers();
    writeConfig();
    const { hooks, stats } = engine();
    const r = await run({ papers: "all" }, hooks);
    const s = S(r);
    assert.equal(s.coverage.candidates.total, 10);
    // All 10 candidates judged (stage 2 additionally re-judges localization
    // windows, so raw engine states are not distinct units).
    assert.equal(s.coverage.work.unchecked, 0);
    const [a3s, a3e] = sectionSpan(A.text, A.marks, 2);
    const a3slice = A.text.slice(a3s, a3e);
    assert.equal(stats.states.filter((t) => t === a3slice).length, 1);
    assert.ok(stats.states.some((t) => t.includes(SUPPORT)), "best (supporting) unit not judged");
    assert.equal(s.result.searched, "candidate_limited");
    assert.ok((s.result.limitations as string[]).includes("candidate_limited"));
    const per = s.coverage.candidates.perPaper as { selected: number }[];
    assert.equal(per.reduce((n, p) => n + p.selected, 0), 10);
  });

  it("T4.5 query -> perPaper selected 3, query_limited", async () => {
    rankedPapers();
    writeConfig();
    const { hooks } = engine();
    const r = await run({ papers: "all", query: "quasar luminosity" }, hooks);
    const s = S(r);
    assert.equal(s.result.searched, "query_limited");
    assert.ok((s.result.limitations as string[]).includes("query_limited"));
    const per = s.coverage.candidates.perPaper as { selected: number }[];
    assert.deepEqual(
      per.map((p) => p.selected),
      [3, 3],
    );
  });
});

// ── localization ───────────────────────────────────────────────────────────

function longPaper(): { text: string; marks: SectionMark[] } {
  const results = `${filler("lr-0", 400)}\n\n${filler("lr-1", 400)}\n\n${SUPPORT}\n\n${filler("lr-2", 400)}\n\n${filler("lr-3", 400)}`;
  return sectionedPaper([
    ["Introduction", filler("li", 8000)],
    ["Results", results],
    ["Methods", filler("lm", 8000)],
  ]);
}

describe("localization on units", () => {
  it("T4.7a marker window supports -> one record <= 1,500 chars, localized, excerpt present", async () => {
    const { text: paper, marks } = longPaper();
    const [rs, re] = sectionSpan(paper, marks, 1);
    assert.ok(re - rs > 1_500 && re - rs < 5_000, `results unit is ${re - rs} chars`);
    addPaper("10.1111/t47a", "Long Paper", paper, marks);
    writeConfig();
    const { hooks } = engine();
    const r = await run({ papers: ["10.1111/t47a"] }, hooks);
    const s = S(r);
    assert.equal(s.result.supportFound, true);
    assert.equal(s.evidence.length, 1);
    const e = s.evidence[0];
    assert.ok(e.span.end - e.span.start <= 1_500);
    assert.equal(e.localized, true);
    assert.ok(typeof e.excerpt === "string" && e.excerpt.includes(SUPPORT));
    const windows = localizePassages({ start: rs, text: paper.slice(rs, re) });
    assert.ok(windows.length > 1);
    assert.equal(s.coverage.work.localizationFresh, windows.length);
  });

  it("T4.7b no window supports -> one unit-span record, localized false, excerpt withheld excerpt_cap, pointer resolves", async () => {
    const { text: paper, marks } = longPaper();
    const [rs, re] = sectionSpan(paper, marks, 1);
    addPaper("10.1111/t47b", "Long Paper B", paper, marks);
    writeConfig();
    const { hooks } = engine((row) => (row.state.includes(MARK) && row.state.length > 1_500 ? 0.999 : 0.05));
    const r = await run({ papers: ["10.1111/t47b"] }, hooks);
    const s = S(r);
    assert.equal(s.result.supportFound, true);
    assert.equal(s.evidence.length, 1);
    const e = s.evidence[0];
    assert.deepEqual([e.span.start, e.span.end], [rs, re]);
    assert.equal(e.localized, false);
    assert.equal(e.excerpt, null);
    assert.equal(e.withheld, "excerpt_cap");
    const resolved = resolvePointer(db, e.pointer);
    assert.equal(resolved.status, "current");
    assert.equal((resolved as { text: string }).text, paper.slice(rs, re));
  });
});

// ── caching ────────────────────────────────────────────────────────────────

describe("unit judgment cache", () => {
  it("T4.8 passage_hash is the section slice sha256, user_version 6, second identical call sends 0 rows", async () => {
    // Two ~2k sections: no chunk-path localization window ever equals a
    // whole section slice, so the section hash in the cache proves unit judging.
    const { text: paper, marks } = sectionedPaper([
      ["Background", `${filler("h1", 900)}\n\n${SUPPORT}\n\n${filler("h1-b", 900)}`],
      ["Methods", `${filler("h2", 900)}\n\n${filler("h2-b", 900)}`],
    ]);
    const [as, ae] = sectionSpan(paper, marks, 0);
    assert.ok(ae - as > 1_500, `support section is ${ae - as} chars`);
    addPaper("10.1111/t48a", "Cache Paper", paper, marks);
    writeConfig();
    const { hooks, stats } = engine();
    const first = await run({ papers: ["10.1111/t48a"] }, hooks);
    assert.equal(S(first).result.supportFound, true);
    const rowsAfterFirst = stats.rows;
    assert.ok(rowsAfterFirst > 0);
    const slice = paper.slice(as, ae);
    assert.ok(stats.states.includes(slice), "the section slice was never judged");
    const expected = passageHashOf(slice);
    const cached = db.prepare("SELECT COUNT(*) AS n FROM claim_judgments WHERE passage_hash = ?").get(expected) as { n: number };
    assert.ok(cached.n > 0, "support section hash not in the judgment cache");
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 6);
    const buildsAfterFirst = stats.builds;
    await run({ papers: ["10.1111/t48a"] }, hooks);
    assert.equal(stats.rows - rowsAfterFirst, 0);
    assert.equal(stats.builds, buildsAfterFirst);
  });
});

// ── paging ─────────────────────────────────────────────────────────────────

function fiveSections(): { text: string; marks: SectionMark[] } {
  return sectionedPaper(
    Array.from({ length: 5 }, (_, i) => [`Part ${i + 1}`, `${filler(`p${i}`, 900)}\n\n${i === 2 ? `${SUPPORT}\n\n` : ""}${filler(`p${i}-b`, 200)}`] as [string, string]),
  );
}

describe("unit paging", () => {
  it("T4.9 max_judgments 2 with 5 units -> token v4, snapshot unitPolicy, pages judge [2,2,1] in frozen order", async () => {
    const { text: paper, marks } = fiveSections();
    addPaper("10.1111/t49a", "Five Sections", paper, marks);
    writeConfig({ maxJudgments: 2 });
    const { hooks } = engine();
    const fresh: number[] = [];
    let r = await run({ papers: ["10.1111/t49a"] }, hooks);
    fresh.push(S(r).coverage.work.fresh as number);
    let token = S(r).continuation as string | null;
    assert.ok(typeof token === "string");
    assert.equal(JSON.parse(Buffer.from(token, "base64url").toString("utf8")).v, 4);
    const snap = JSON.parse((db.prepare("SELECT snapshot_json AS j FROM verify_runs").get() as { j: string }).j) as Record<string, any>;
    assert.deepEqual(snap.unitPolicy, { maxChars: 16000, chunking: "sections-v2" });
    while (token !== null) {
      r = await run({ papers: ["10.1111/t49a"], continuation: token }, hooks);
      fresh.push(S(r).coverage.work.fresh as number);
      token = S(r).continuation as string | null;
    }
    assert.deepEqual(fresh, [2, 2, 1]);
    assert.equal(S(r).result.supportFound, true);
    assert.equal(S(r).result.complete, true);
  });
});

// ── continuation integrity ─────────────────────────────────────────────────

describe("unit continuation integrity", () => {
  const threePaper = (): { text: string; marks: SectionMark[] } =>
    sectionedPaper([
      ["One", `${filler("c1", 800)}\n\n${filler("c1-b", 200)}`],
      ["Two", `${filler("c2", 800)}\n\n${SUPPORT}\n\n${filler("c2-b", 200)}`],
      ["Three", `${filler("c3", 800)}\n\n${filler("c3-b", 200)}`],
    ]);

  const unitToken = async (): Promise<{ token: string; stats: { builds: number } }> => {
    const { text: paper, marks } = threePaper();
    addPaper("10.1111/t4x", "Three", paper, marks);
    writeConfig({ maxJudgments: 1 });
    const e = engine();
    const r = await run({ papers: "all" }, e.hooks);
    const token = S(r).continuation as string | null;
    assert.ok(typeof token === "string");
    return { token, stats: e.stats };
  };

  it("T4.10 v3 under units, v4 without units, changed cap, tampered pointer -> CONTINUATION_INVALID with no engine call", async () => {
    const { token, stats } = await unitToken();
    const builtAfterToken = stats.builds;
    assert.ok(builtAfterToken > 0);
    const v3 = Buffer.from(JSON.stringify({ v: 3, r: JSON.parse(Buffer.from(token, "base64url").toString("utf8")).r })).toString("base64url");
    const attempt = (continuation: string, useHooks: VerifyHooks) => run({ papers: "all", continuation }, useHooks);
    const eh = engine();
    assert.equal(refused(await attempt(v3, eh.hooks)), "CONTINUATION_INVALID");
    assert.equal(eh.stats.builds, 0);

    const chunkCtx = ctx({}, { UKTUB_VERIFY_MODEL_ID: "test-model" });
    const ch = engine();
    const chunkRun = await run({ papers: ["10.1111/t4x"] }, ch.hooks, chunkCtx);
    const chunkToken = S(chunkRun).continuation as string | null;
    assert.ok(typeof chunkToken === "string");
    const v4 = Buffer.from(JSON.stringify({ v: 4, r: JSON.parse(Buffer.from(chunkToken, "base64url").toString("utf8")).r })).toString("base64url");
    const ch2 = engine();
    assert.equal(refused(await run({ papers: ["10.1111/t4x"], continuation: v4 }, ch2.hooks, chunkCtx)), "CONTINUATION_INVALID");
    assert.equal(ch2.stats.builds, 0);

    const capped = engine();
    assert.equal(refused(await run({ papers: "all", continuation: token }, { ...capped.hooks, unitMaxChars: 8000 })), "CONTINUATION_INVALID");
    assert.equal(capped.stats.builds, 0);

    const row = db.prepare("SELECT snapshot_json AS j FROM verify_runs WHERE snapshot_json LIKE '%unitPolicy%'").get() as { j: string };
    const snap = JSON.parse(row.j) as Record<string, any>;
    assert.ok(Array.isArray(snap.candidateIds) && snap.candidateIds.length > 0);
    snap.candidateIds = ["bogus-pointer"];
    db.prepare("UPDATE verify_runs SET snapshot_json = ? WHERE snapshot_json LIKE '%unitPolicy%'").run(JSON.stringify(snap));
    const tampered = engine();
    assert.equal(refused(await attempt(token, tampered.hooks)), "CONTINUATION_INVALID");
    assert.equal(tampered.stats.builds, 0);
    assert.equal(stats.builds, builtAfterToken);
  });
});

// ── engine failure ─────────────────────────────────────────────────────────

describe("unit engine failure", () => {
  it("T4.11 one unit's rows fail -> others scored and cached, unchecked 1, continuation retries only the failed unit; all failing -> VERIFY_ENGINE_MISSING", async () => {
    const { text: paper, marks } = fiveSections();
    addPaper("10.1111/t4fa", "Fail Paper", paper, marks);
    writeConfig();
    let failOne = true;
    const { hooks, stats } = engine((row) => {
      if (failOne && row.state.includes("Part 2")) return { failed: "x" };
      return byMark(row);
    });
    void stats;
    const first = await run({ papers: ["10.1111/t4fa"] }, hooks);
    assert.equal(refused(first), undefined, "one failed unit must not refuse the call");
    const s1 = S(first);
    assert.equal(s1.coverage.work.unchecked, 1);
    assert.equal(s1.coverage.work.interruption?.reason, "engine_failure");
    assert.equal(s1.result.supportFound, true);
    assert.ok(typeof s1.continuation === "string");
    failOne = false;
    const second = await run({ papers: ["10.1111/t4fa"], continuation: s1.continuation }, hooks);
    const s2 = S(second);
    assert.equal(s2.coverage.work.fresh, 1);
    assert.equal(s2.coverage.work.interruption, null);
    assert.equal(s2.result.complete, true);

    const { hooks: doomed } = engine(() => {
      throw new Error("down");
    });
    const r = await run({ claim: "Unrelated assertion about laboratory glassware.", papers: ["10.1111/t4fa"] }, doomed);
    assert.equal(refused(r), "VERIFY_ENGINE_MISSING");
  });
});

// ── render and schema ──────────────────────────────────────────────────────

describe("unit render and output schema", () => {
  it("T4.12 render says sections and references not checked; Value.Check passes with excluded", async () => {
    const { text: paper, marks } = sectionedPaper([
      ["Results", `${filler("re", 500)}\n\n${SUPPORT}`],
      ["References", "Holder, Ada (2024). Unrelated bibliography record."],
    ]);
    addPaper("10.1111/t4ra", "Render Paper", paper, marks);
    writeConfig();
    const { hooks } = engine();
    const r = await run({ papers: ["10.1111/t4ra"] }, hooks);
    const s = S(r);
    assert.equal(Value.Check(VerifyClaimOutput, s), true);
    assert.ok(text(r).includes("section"), `render says nothing about sections:\n${text(r)}`);
    assert.ok(text(r).includes("references: 1 section(s) not checked"));
  });

  it("T4.13 gridBatchSizeOf is 20/20/8/8/8", async () => {
    assert.equal(gridBatchSizeOf("hosted"), 20);
    assert.equal(gridBatchSizeOf("openrouter"), 20);
    assert.equal(gridBatchSizeOf("eos"), 8);
    assert.equal(gridBatchSizeOf("eos-onnx"), 8);
    assert.equal(gridBatchSizeOf("llama-cpp"), 8);
  });
});
