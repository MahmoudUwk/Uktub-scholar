/**
 * verify_claim (R5, R7–R15; AE3–AE6): one claim over all registered papers or
 * an explicit subset, with source preparation, retrieval and judgment inside.
 * The agent receives supporting evidence plus four separate coverage
 * dimensions — never full text, never a score masquerading as a verdict.
 * Offline: fake provider traffic, fake download, fake engine, real SQLite.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";

import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry, deregisterPapers, registerPaper } from "../src/core/registry.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import { MAX_EVIDENCE_PER_PAGE, MAX_PAGE_EXCERPT_CHARS, VerifyClaimOutput, verifyClaimTool, type VerifyClaimArgs, type VerifyHooks } from "../src/core/tools/verify.ts";
import { EngineError } from "../src/core/verify/claim.ts";
import { chunksOf, getSource, publishSource, resolvePointer } from "../src/core/verify/store.ts";
import { SourceError } from "../src/core/source/extract.ts";
import type { DownloadLike } from "../src/core/source/download.ts";
import { createFakeFetch } from "./helpers/provider-fakes.ts";
import { makePdf } from "./helpers/pdf.ts";

const CLAIM = "Cells age faster at high temperature.";
const MARK = "cells age faster at high temperature";
const NOW = () => new Date("2026-10-04T12:00:00Z");
const BIB = "@article{x, title={T}, author={Holder, Ada}, year={2024}}";

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-vc-"));
  db = createRegistry(root);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// ── fixtures ───────────────────────────────────────────────────────────────

const filler = (tag: string, n = 330): string => `${tag} ` + "The experiment records many independent measurements of the cell. ".repeat(Math.ceil(n / 65)).slice(0, n);
const SUPPORT = "Experiments show that cells age faster at high temperature than at room temperature, with capacity loss reaching twelve percent.";
/** n paragraphs of filler; the supporting sentence sits in the paragraph at `at`. Distinctive tags let tests prove no body text leaks. */
function paperText(tag: string, n: number, at: number | null): { text: string; paragraphs: string[] } {
  const paragraphs = Array.from({ length: n }, (_, i) => (i === at ? `${filler(`${tag}-p${i}`, 150)} ${SUPPORT}` : filler(`${tag}-p${i}`)));
  return { text: paragraphs.join("\n\n"), paragraphs };
}

let digestN = 0;
function addPaper(doi: string, title: string, text: string | null): void {
  registerPaper(db, { doi, title, authors: ["Holder, Ada"], year: 2024, bibtex: BIB.replace("x,", `${doi.slice(-3)},`), bibtexSource: "crossref" }, { now: NOW });
  if (text === null) return;
  const cfg = { chunk_tokens: 8192, overlap_tokens: 128, chars_per_token: 2.8, boundary: "paragraph" as const };
  publishSource(db, doi, { kind: "local-file", ref: `${doi.slice(-3)}.pdf`, license: null, digest: String(++digestN).padStart(64, "0"), extraction: "t@1", text, pageStarts: [0] }, cfg, NOW());
}

function writeConfig(opts: { chunkTokens?: number; maxJudgments?: number; workers?: number; engine?: string; boundary?: "paragraph" | "section" | "hard" } = {}): void {
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "chunking.yaml"),
    `chunking:\n  chunk_tokens: ${opts.chunkTokens ?? 8192}\n  overlap_tokens: 0\n  chars_per_token: 2.8\n  boundary: ${opts.boundary ?? "paragraph"}\nverification:\n  engine: ${opts.engine ?? "k2"}\n  min_confidence: 0.99\n  workers: ${opts.workers ?? 2}\n  max_judgments: ${opts.maxJudgments ?? 120}\n`,
  );
}

/** Scores 0.999 for rows whose passage carries the marker and the right claim; 0.05 otherwise. */
function engine(over: { failAfter?: number; onRun?: () => void } = {}): { hooks: VerifyHooks; stats: { rows: number; calls: number; builds: number } } {
  const stats = { rows: 0, calls: 0, builds: 0 };
  const hooks: VerifyHooks = {
    fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    createEngine: () => {
      stats.builds++;
      return {
        run: async (rows) => {
          stats.calls++;
          if (over.failAfter !== undefined && stats.calls > over.failAfter) throw new EngineError("HTTP 429 daily limit reached");
          stats.rows += rows.length;
          over.onRun?.();
          return rows.map((r) => (r.state.toLowerCase().includes(MARK) && r.instructions === CLAIM ? 0.999 : 0.05));
        },
      };
    },
  };
  return { hooks, stats };
}

const NO_ENGINE: VerifyHooks = {
  createEngine: () => {
    throw new Error("an engine must not be built here");
  },
  fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
};

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    root,
    fetch: (async () => {
      throw new Error("no network");
    }) as ToolContext["fetch"],
    env: { UKTUB_VERIFY_MODEL_ID: "test-model" },
    now: NOW,
    queue: new WriteQueue(),
    ...over,
  };
}
const run = (args: Partial<VerifyClaimArgs> & { claim?: string }, hooks: VerifyHooks, c: ToolContext = ctx()) =>
  verifyClaimTool(c, { claim: CLAIM, ...args } as VerifyClaimArgs, hooks);
const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join("\n");
const refused = (r: { details: Record<string, unknown> }): string | undefined => (r.details.refused as { code?: string } | undefined)?.code;
const S = (r: { structuredContent: unknown }) => r.structuredContent as Record<string, any>;
const sourceText = (doi: string): string => (db.prepare("SELECT text FROM paper_sources WHERE doi = ?").get(doi) as { text: string }).text;

// ── argument contract ──────────────────────────────────────────────────────

describe("scope and arguments", () => {
  it("requires exactly one scope: papers or passages", async () => {
    for (const args of [{}, { papers: "all", passages: [{ text: "x".repeat(20) }] }]) {
      assert.equal(refused(await run(args as never, NO_ENGINE)), "ARGUMENT_INVALID");
    }
  });
  it("refuses an empty explicit ID list (never read as all) and an out-of-range claim", async () => {
    assert.equal(refused(await run({ papers: [] }, NO_ENGINE)), "ARGUMENT_INVALID");
    assert.equal(refused(await run({ claim: "short", papers: "all" }, NO_ENGINE)), "ARGUMENT_INVALID");
    assert.equal(refused(await run({ claim: "x".repeat(2001), papers: "all" }, NO_ENGINE)), "ARGUMENT_INVALID");
  });
  it("an empty registry is a valid empty scope and needs no engine", async () => {
    const r = await run({ papers: "all" }, NO_ENGINE);
    assert.equal(S(r).result.supportFound, false);
    assert.equal(S(r).coverage.sources.selected, 0);
    assert.match(text(r), /no registered papers/i);
  });
  it("unknown IDs are listed and never broaden the scope; if none resolve, nothing is checked", async () => {
    addPaper("10.1111/aaa", "Alpha", paperText("A", 30, 5).text);
    const r = await run({ papers: ["10.9999/never"] }, NO_ENGINE);
    assert.deepEqual(S(r).coverage.sources.unresolved, [{ handle: "10.9999/never", reason: "not_registered" }]);
    assert.equal(S(r).coverage.sources.selected, 0);
    assert.match(text(r), /10\.9999\/never/);
  });
  it("a locator with no searchable words is refused", async () => {
    addPaper("10.1111/aaa", "Alpha", paperText("A", 30, 5).text);
    assert.equal(refused(await run({ papers: "all", query: "((( )))" }, NO_ENGINE)), "ARGUMENT_INVALID");
  });
  it("invalid configuration is refused, absent YAML is not", async () => {
    addPaper("10.1111/aaa", "Alpha", paperText("A", 30, 5).text);
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", "chunking.yaml"), "chunking: [");
    assert.equal(refused(await run({ papers: "all" }, NO_ENGINE)), "CONFIG_INVALID");
    rmSync(join(root, "config"), { recursive: true });
    assert.equal(refused(await run({ papers: "all" }, engine().hooks, ctx({ env: { UKTUB_VERIFY_ENGINE: "k2", UKTUB_VERIFY_MODEL_ID: "m" } }))), undefined);
  });
});

// ── AE3: no manual preparation ─────────────────────────────────────────────

describe("source preparation inside verification (R7, AE3)", () => {
  const TITLE = "Cycle Life of Lithium Cells Under Thermal Stress";
  it("metadata-only registration → verification acquires the source itself and returns a reconstructable passage", async () => {
    addPaper("10.1234/cells", TITLE, null);
    const lines = [TITLE, ...paperText("Z", 48, 23).paragraphs.flatMap((p) => p.match(/.{1,90}(\s|$)/g) ?? [])];
    const pdf = makePdf(Array.from({ length: Math.ceil(lines.length / 45) }, (_, i) => lines.slice(i * 45, i * 45 + 45)));
    const { fetchFn } = createFakeFetch([{ match: (u) => u.startsWith("https://api.openalex.test/works/"), body: JSON.stringify({ doi: "https://doi.org/10.1234/cells", locations: [{ is_oa: true, pdf_url: "https://repo.example/cells.pdf", license: "cc-by" }] }) }]);
    const download: DownloadLike = async (url) => ({ finalUrl: url, contentType: null, bytes: pdf });
    const { hooks } = engine();
    const r = await run({ papers: "all" }, hooks, ctx({ fetch: fetchFn, download, providerConfig: { openalexBaseUrl: "https://api.openalex.test" } }));
    assert.equal(S(r).result.supportFound, true, text(r));
    const src = getSource(db, "10.1234/cells")!;
    assert.deepEqual([src.status, src.kind], ["ready", "openalex-pdf-url"]);
    const [ev] = S(r).evidence;
    const back = resolvePointer(db, ev.pointer);
    assert.equal(back.status, "current");
    assert.equal((back as { text: string }).text, ev.excerpt, "the excerpt is exactly the captured span");
    assert.match(ev.excerpt.toLowerCase().replace(/\s+/g, " "), /cells age faster at high temperature/);
    assert.ok(chunksOf(db, "10.1234/cells").length > 0);
  });

  it("a source taken from an arXiv preprint of the work is disclosed as a preprint; an ordinary source is not", async () => {
    addPaper("10.1234/cells", TITLE, null);
    const lines = [TITLE, ...paperText("Z", 48, 23).paragraphs.flatMap((p) => p.match(/.{1,90}(\s|$)/g) ?? [])];
    const pdf = makePdf(Array.from({ length: Math.ceil(lines.length / 45) }, (_, i) => lines.slice(i * 45, i * 45 + 45)));
    const { fetchFn } = createFakeFetch([
      { match: (u) => u.startsWith("https://api.openalex.test/works/"), body: JSON.stringify({ doi: "https://doi.org/10.1234/cells", locations: [], open_access: { is_oa: false } }) },
      { match: (u) => u.startsWith("https://api.semanticscholar.test/graph/v1/paper/DOI:"), body: JSON.stringify({ externalIds: { DOI: "10.1234/cells", ArXiv: "2511.04015" }, openAccessPdf: { url: "" } }) },
    ]);
    const download: DownloadLike = async (url) => {
      assert.equal(url, "https://arxiv.org/pdf/2511.04015");
      return { finalUrl: url, contentType: null, bytes: pdf };
    };
    const providerConfig = { openalexBaseUrl: "https://api.openalex.test", semanticScholarBaseUrl: "https://api.semanticscholar.test", sleep: async () => {} };
    const r = await run({ papers: "all" }, engine().hooks, ctx({ fetch: fetchFn, download, providerConfig }));
    assert.equal(S(r).result.supportFound, true, text(r));
    assert.equal(getSource(db, "10.1234/cells")!.kind, "arxiv-preprint-pdf");
    const [{ citekey }] = S(r).coverage.candidates.perPaper;
    assert.deepEqual(S(r).coverage.sources.preprint, [citekey]);
    assert.match(text(r), new RegExp(`preprint: ${citekey}[^\\n]*may differ from the published version`));
    addPaper("10.1111/aaa", "Alpha", paperText("A", 30, 5).text);
    const plain = await run({ papers: ["10.1111/aaa"] }, engine().hooks);
    assert.deepEqual(S(plain).coverage.sources.preprint, []);
    assert.doesNotMatch(text(plain), /preprint/i);
  });

  it("a paper whose source cannot be acquired is reported with its reason; others still contribute", async () => {
    addPaper("10.1111/aaa", "Alpha", paperText("A", 30, 5).text);
    addPaper("10.2222/bbb", "Beta Unreachable", null);
    const { fetchFn } = createFakeFetch([{ match: (u) => u.startsWith("https://api.openalex.test/works/"), status: 404, body: "{}" }]);
    const r = await run({ papers: "all" }, engine().hooks, ctx({ fetch: fetchFn, download: async () => { throw new SourceError("download_failed", "x"); }, providerConfig: { openalexBaseUrl: "https://api.openalex.test" } }));
    assert.equal(S(r).result.supportFound, true);
    assert.equal(S(r).result.complete, false, "support was found but coverage is incomplete");
    assert.ok(S(r).result.limitations.includes("sources_unavailable"));
    assert.deepEqual(S(r).coverage.sources.unavailable.map((u: { doi: string; code: string }) => [u.doi, u.code]), [["10.2222/bbb", "no_open_copy"]]);
    assert.equal(getSource(db, "10.2222/bbb")!.status, "unavailable");
    assert.match(text(r), /10\.2222\/bbb[^\n]*no_open_copy/);
  });

  it("when no paper has a usable source nothing is judged and no engine is built", async () => {
    addPaper("10.2222/bbb", "Beta", null);
    const r = await run({ papers: "all" }, NO_ENGINE);
    assert.equal(S(r).result.supportFound, false);
    assert.ok(S(r).result.limitations.includes("sources_unavailable"));
    assert.equal(S(r).coverage.work.checked, 0);
    assert.match(text(r), /no usable source/i);
  });

  it("a recent failed attempt is not retried (no repeated paid downloads); an unavailable one is", async () => {
    addPaper("10.2222/bbb", "Beta", null);
    db.prepare("INSERT INTO paper_sources (doi, status, prepared_at, failure_code, failure_detail) VALUES (?, 'failed', ?, 'identity_mismatch', 'x')").run("10.2222/bbb", "2026-10-04T11:00:00Z");
    let lookups = 0;
    const c = ctx({ fetch: (async () => { lookups++; return new Response("{}", { status: 404 }); }) as unknown as ToolContext["fetch"], download: async () => { throw new Error("unused"); } });
    await run({ papers: "all" }, NO_ENGINE, c);
    assert.equal(lookups, 0, "failed < 24 h ago: skipped");
    db.prepare("UPDATE paper_sources SET status = 'unavailable', failure_code = 'no_open_copy'").run();
    await run({ papers: "all" }, NO_ENGINE, c);
    assert.ok(lookups > 0, "unavailable: looked up again");
  });
});

// ── evidence: exhaustive, query-limited, localized ─────────────────────────

describe("supporting evidence (R8–R11, R13, AE4)", () => {
  beforeEach(() => {
    addPaper("10.1111/aaa", "Alpha", paperText("A", 80, 41).text); // ~26k chars: two stage-1 chunks
    addPaper("10.2222/bbb", "Beta", paperText("B", 40, null).text); // no support anywhere
  });

  it("exhaustive: checks every usable chunk, localizes support to a verbatim excerpt, returns an exact pointer", async () => {
    // Large stage-1 chunks (over the excerpt limit) are what localization exists for: pin that policy here.
    // At the default 512-token section policy a chunk is already a releasable passage and needs no recheck.
    writeConfig({ chunkTokens: 1024, engine: "eos" });
    const { hooks, stats } = engine();
    const r = await run({ papers: "all" }, hooks);
    const s = S(r);
    assert.deepEqual([s.result.supportFound, s.result.searched, s.result.complete], [true, "exhaustive", true]);
    assert.equal(s.evidence.length, 1);
    const ev = s.evidence[0];
    assert.equal(ev.doi, "10.1111/aaa");
    assert.equal(ev.attested, true);
    assert.ok(ev.excerpt.includes(SUPPORT));
    assert.ok(ev.excerpt.length <= 1_500, "a passage, not a chunk");
    assert.equal(sourceText("10.1111/aaa").slice(ev.span.start, ev.span.end), ev.excerpt);
    assert.equal(ev.span.unit, "utf16");
    assert.match(ev.pointer, new RegExp(`^10\\.1111/aaa@${ev.revision}#${ev.span.start}-${ev.span.end}$`));
    assert.deepEqual(Object.keys(ev.judgment).sort(), ["minConfidence", "model", "protocol", "score"]);
    assert.equal(ev.judgment.minConfidence, 0.99);
    const chunks = chunksOf(db, "10.1111/aaa").length + chunksOf(db, "10.2222/bbb").length;
    assert.equal(s.coverage.candidates.total, chunks);
    assert.equal(s.coverage.work.checked, chunks);
    assert.ok(stats.rows > chunks, "stage-1 judgments plus localization rechecks");
    assert.ok(Value.Check(VerifyClaimOutput, s));
  });

  it("under the default policy (section chunks capped at 512 tokens) a chunk is already a passage: support needs no localization recheck", async () => {
    const { hooks, stats } = engine(); // no config file: the documented defaults
    const s = S(await run({ papers: "all" }, hooks));
    assert.equal(s.evidence.length, 1);
    const ev = s.evidence[0];
    assert.ok(ev.excerpt.includes(SUPPORT));
    assert.ok(ev.excerpt.length <= 1_500);
    assert.equal(sourceText("10.1111/aaa").slice(ev.span.start, ev.span.end), ev.excerpt);
    const chunks = chunksOf(db, "10.1111/aaa").length + chunksOf(db, "10.2222/bbb").length;
    assert.equal(s.coverage.work.checked, chunks);
    assert.equal(stats.rows, chunks, "one judgment per chunk and nothing else: the chunk IS the passage");
    assert.ok(chunksOf(db, "10.1111/aaa").every((c) => c.text.length <= 1_433 && c.section !== null));
  });

  it("returns only supporting records: non-supporting text never reaches the agent (R10, R5)", async () => {
    const r = await run({ papers: "all" }, engine().hooks);
    const all = JSON.stringify(r);
    for (const tag of ["B-p0 ", "B-p17 ", "A-p3 ", "A-p77 ", "A-p5 "]) assert.ok(!all.includes(tag), `body text ${tag.trim()} leaked`); // tags are anchored: A-p39 may appear inside the supporting excerpt
    assert.ok(!/refut|contradict/i.test(all), "no response surface speaks of refutation or contradiction");
  });

  it("no support under exhaustive coverage is 'no support found', never a refutation, and says so", async () => {
    const r = await run({ papers: ["10.2222/bbb"] }, engine().hooks);
    const s = S(r);
    assert.deepEqual([s.result.supportFound, s.result.complete, s.evidence.length], [false, true, 0]);
    assert.match(text(r), /NO SUPPORT FOUND/);
    assert.match(text(r), /not evidence that the claim is false/i);
    assert.ok(!("verdict" in s) && !("refuted" in s));
  });

  it("AE4: an irrelevant locator misses what the exhaustive pass finds, and reports a limited search", async () => {
    const { hooks } = engine();
    const limited = await run({ papers: "all", query: "quantum chromodynamics lattice" }, hooks);
    assert.deepEqual([S(limited).result.supportFound, S(limited).result.searched], [false, "query_limited"]);
    assert.ok(S(limited).result.limitations.includes("no_candidates"));
    assert.ok(S(limited).result.limitations.includes("query_limited"));
    assert.match(text(limited), /query-limited/i);
    assert.match(text(limited), /not a finding about the papers/i);
    assert.equal(S(limited).coverage.work.checked, 0);
    const exhaustive = await run({ papers: "all" }, hooks);
    assert.equal(S(exhaustive).result.supportFound, true);
  });

  it("a relevant locator finds the support with far fewer judgments, with per-paper accounting for every selected paper", async () => {
    const full = engine();
    await run({ papers: "all" }, full.hooks);
    db.exec("DELETE FROM claim_judgments");
    const guided = engine();
    const r = await run({ papers: "all", query: "cells age faster high temperature" }, guided.hooks);
    assert.equal(S(r).result.supportFound, true);
    assert.equal(S(r).result.searched, "query_limited");
    assert.ok(guided.stats.rows <= full.stats.rows);
    assert.deepEqual(S(r).coverage.candidates.perPaper.map((p: { doi: string }) => p.doi).sort(), ["10.1111/aaa", "10.2222/bbb"]);
  });

  it("judged work is reused: an identical request costs zero engine calls and returns the same evidence", async () => {
    const first = engine();
    const a = await run({ papers: "all" }, first.hooks);
    const second = engine();
    const b = await run({ papers: "all" }, second.hooks);
    assert.equal(second.stats.rows, 0);
    assert.equal(second.stats.builds, 0, "a fully cached run builds no engine");
    assert.deepEqual(S(b).evidence.map((e: { pointer: string }) => e.pointer), S(a).evidence.map((e: { pointer: string }) => e.pointer));
    assert.equal(S(b).coverage.work.cached, S(a).coverage.work.checked);
  });

  it("a different model identity does not reuse judgments", async () => {
    await run({ papers: "all" }, engine().hooks);
    const other = engine();
    await run({ papers: "all" }, other.hooks, ctx({ env: { UKTUB_VERIFY_MODEL_ID: "another-model" } }));
    assert.ok(other.stats.rows > 0);
  });

  it("an engine with no establishable identity never reuses judgments (and says so)", async () => {
    writeConfig({ engine: "k2" }); // an endpoint engine; the injected probe answers 404, so no identity can be established
    const a = engine();
    await run({ papers: ["10.2222/bbb"] }, a.hooks, ctx({ env: {} }));
    const b = engine();
    const r = await run({ papers: ["10.2222/bbb"] }, b.hooks, ctx({ env: {} }));
    assert.ok(b.stats.rows > 0);
    assert.equal(S(r).engine.cache, false);
    assert.equal(S(r).engine.model, null);
  });

  it("evidence records cite the registered paper (citekey, title, citability) and the effective policy", async () => {
    const r = await run({ papers: "all" }, engine().hooks);
    const ev = S(r).evidence[0];
    assert.deepEqual([ev.citekey.length > 0, ev.title, ev.citable], [true, "Alpha", true]);
    assert.equal(ev.judgment.model, "declared:test-model");
    assert.match(text(r), new RegExp(ev.citekey));
    assert.ok(text(r).includes(ev.pointer));
    assert.ok(text(r).includes(SUPPORT.slice(0, 40)), "the excerpt is in the model-visible text");
  });

  it("is deterministic for identical requests", async () => {
    const a = await run({ papers: "all" }, engine().hooks);
    db.exec("DELETE FROM claim_judgments");
    const b = await run({ papers: "all" }, engine().hooks);
    const strip = (r: typeof a) => JSON.stringify(S(r).evidence);
    assert.equal(strip(a), strip(b));
  });
});

// ── containment (AE6) ──────────────────────────────────────────────────────

describe("full-text containment (R5, AE6)", () => {
  it("a short single-chunk paper's support is pointer-only: the body is never exported", async () => {
    const short = `${SUPPORT} Only a little more text follows here.`;
    addPaper("10.3333/short", "Short Note", short);
    const r = await run({ papers: "all" }, engine().hooks);
    const [ev] = S(r).evidence;
    assert.deepEqual([ev.excerpt, ev.withheld], [null, "whole_source"]);
    assert.ok(ev.pointer.startsWith("10.3333/short@"));
    assert.ok(!JSON.stringify(r).includes("Only a little more text"), "no part of the body in any response surface");
    assert.match(text(r), /withheld/i);
  });

  it("many supporting passages in one paper stop releasing text at the share limit but keep every pointer", async () => {
    const paragraphs = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? `${filler(`S-p${i}`, 900)} ${SUPPORT}` : filler(`S-p${i}`, 900)));
    addPaper("10.4444/many", "Many Supports", paragraphs.join("\n\n"));
    const hooks = engine().hooks;
    const first = await run({ papers: "all" }, hooks);
    const ev = [...S(first).evidence] as { excerpt: string | null; withheld: string | null }[];
    for (let token: string | null = S(first).continuation, guard = 0; token !== null && guard++ < 30; ) {
      const n = await run({ papers: "all", continuation: token }, hooks);
      ev.push(...S(n).evidence);
      token = S(n).continuation;
    }
    const r = first;
    const total = sourceText("10.4444/many").length;
    const released = ev.reduce((n, e) => n + (e.excerpt?.length ?? 0), 0);
    assert.ok(released <= 0.25 * total, `released ${released} of ${total}`);
    assert.ok(ev.some((e) => e.withheld === "source_share"));
    assert.ok(S(r).coverage.output.withheld > 0);
    assert.ok(ev.length > 12, "every supporting pointer is still reported");
  });
});

// ── interruption, continuation, output ─────────────────────────────────────

describe("bounded work and continuation (R14, R15)", () => {
  beforeEach(() => {
    writeConfig({ chunkTokens: 256, maxJudgments: 6, workers: 1 }); // ~716-char windows: 2 paragraphs per chunk
  });
  const supports = (n: number): string => paperText("M", n, null).paragraphs.map((p, i) => (i % 8 === 7 ? `${filler(`M-p${i}`, 200)} ${SUPPORT}` : p)).join("\n\n");

  it("stops at the work budget, reports checked vs unchecked separately, and continues exactly where it stopped", async () => {
    addPaper("10.5555/long", "Long Paper", supports(64));
    const hooks1 = engine();
    const a = await run({ papers: "all" }, hooks1.hooks);
    const total = S(a).coverage.candidates.total;
    assert.ok(total > 12, `${total} candidates`);
    assert.equal(S(a).result.complete, false);
    assert.equal(S(a).coverage.work.interruption.reason, "budget");
    assert.equal(S(a).coverage.work.checked, 6);
    assert.equal(S(a).coverage.work.unchecked, total - 6);
    assert.ok(S(a).continuation);
    assert.match(text(a), /continuation/i);
    let all = [...S(a).evidence];
    let token: string | null = S(a).continuation;
    let guard = 0;
    let rows = hooks1.stats.rows;
    while (token !== null && guard++ < 20) {
      const h = engine();
      const n = await run({ papers: "all", continuation: token }, h.hooks);
      all = all.concat(S(n).evidence);
      token = S(n).continuation;
      rows += h.stats.rows;
    }
    assert.ok(guard < 20);
    const single = engine();
    db.exec("DELETE FROM claim_judgments");
    writeConfig({ chunkTokens: 256, maxJudgments: 1000, workers: 1 });
    const whole = await run({ papers: "all" }, single.hooks);
    assert.deepEqual(all.map((e) => e.pointer), S(whole).evidence.map((e: { pointer: string }) => e.pointer), "the continuation chain finds exactly what one uninterrupted run finds");
    assert.ok(rows <= single.stats.rows + 2, "completed work was not redone");
  });

  it("evidence beyond one output page is paged without redoing any verification", async () => {
    addPaper("10.5555/long", "Long Paper", supports(400));
    writeConfig({ chunkTokens: 256, maxJudgments: 10_000, workers: 2 });
    const a = await run({ papers: "all" }, engine().hooks);
    assert.ok(S(a).evidence.length >= 1 && S(a).evidence.length <= MAX_EVIDENCE_PER_PAGE);
    assert.ok(S(a).coverage.output.available > S(a).evidence.length, "more evidence exists than one page carries");
    assert.ok(S(a).continuation);
    assert.equal(S(a).coverage.work.complete, true, "all work finished; only output remains");
    const seen = [...S(a).evidence];
    let token: string | null = S(a).continuation;
    const h = engine();
    while (token !== null) {
      const n = await run({ papers: "all", continuation: token }, h.hooks);
      seen.push(...S(n).evidence);
      token = S(n).continuation;
    }
    assert.equal(h.stats.rows, 0, "pagination of checked support performs no verifier work");
    assert.equal(new Set(seen.map((e) => e.pointer)).size, seen.length, "no duplicates across pages");
    assert.equal(seen.length, S(a).coverage.output.available);
    const chars = S(a).evidence.reduce((n: number, e: { excerpt: string | null }) => n + (e.excerpt?.length ?? 0), 0);
    assert.ok(chars <= MAX_PAGE_EXCERPT_CHARS);
  });

  it("cancellation stops between batches: checked evidence is kept, the rest is continuable", async () => {
    addPaper("10.5555/long", "Long Paper", supports(64));
    writeConfig({ chunkTokens: 256, maxJudgments: 1000, workers: 1 });
    const ctl = new AbortController();
    const { hooks } = engine({ onRun: () => ctl.abort() });
    const r = await run({ papers: "all" }, hooks, ctx({ signal: ctl.signal }));
    assert.equal(S(r).coverage.work.interruption.reason, "cancelled");
    assert.ok(S(r).coverage.work.checked >= 1 && S(r).coverage.work.unchecked > 0);
    assert.ok(S(r).continuation);
  });

  it("an engine failure mid-run keeps completed work, names the failure, and is continuable", async () => {
    addPaper("10.5555/long", "Long Paper", supports(64));
    writeConfig({ chunkTokens: 256, maxJudgments: 1000, workers: 1 });
    const { hooks } = engine({ failAfter: 2 });
    const r = await run({ papers: "all" }, hooks);
    assert.equal(S(r).coverage.work.interruption.reason, "engine_failure");
    assert.match(S(r).coverage.work.interruption.detail, /429/);
    assert.ok(S(r).coverage.work.checked > 0 && S(r).continuation);
    assert.ok(S(r).result.limitations.includes("interrupted"));
  });

  it("an engine that cannot start is a VERIFY_ENGINE_MISSING refusal with an actionable hint", async () => {
    addPaper("10.5555/long", "Long Paper", supports(16));
    const r = await run({ papers: "all" }, { fetchImpl: NO_ENGINE.fetchImpl, createEngine: () => { throw new EngineError("openrouter decisions engine: OPENROUTER_API_KEY is not set"); } });
    assert.equal(refused(r), "VERIFY_ENGINE_MISSING");
    assert.match(text(r), /OPENROUTER_API_KEY/);
  });

  it("the hint names the DEFAULT engine's setup too: a new user with no Python environment gets a path forward", async () => {
    addPaper("10.5555/long", "Long Paper", supports(16));
    const r = await run({ papers: "all" }, { fetchImpl: NO_ENGINE.fetchImpl, createEngine: () => { throw new EngineError("eos engine failed to load: No module named 'torch'"); } });
    assert.equal(refused(r), "VERIFY_ENGINE_MISSING");
    assert.match(text(r), /UKTUB_EOS_PYTHON/);
    assert.match(text(r), /torch/);
    assert.match(text(r), /tell the user/i, "the agent must relay this, not improvise");
    assert.match(text(r), /uktub-scholar eos install --yes/, "the no-PyTorch route is a single command");
    assert.match(text(r), /eos-onnx/, "and the engine name to select after it");
  });

  it("refuses continuations that do not match: garbage, another claim, or a source that changed", async () => {
    addPaper("10.5555/long", "Long Paper", supports(64));
    const a = await run({ papers: "all" }, engine().hooks);
    const token = S(a).continuation as string;
    assert.equal(refused(await run({ papers: "all", continuation: "garbage" }, NO_ENGINE)), "CONTINUATION_INVALID");
    assert.equal(refused(await run({ claim: "A different claim entirely.", papers: "all", continuation: token }, NO_ENGINE)), "CONTINUATION_INVALID");
    assert.equal(refused(await run({ papers: ["10.5555/long"], continuation: token }, NO_ENGINE)), "CONTINUATION_INVALID", "different scope");
    publishSource(db, "10.5555/long", { kind: "local-file", ref: "n.pdf", license: null, digest: "e".repeat(64), extraction: "t@1", text: supports(40), pageStarts: null }, { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 2.8, boundary: "paragraph" }, NOW());
    assert.equal(refused(await run({ papers: "all", continuation: token }, NO_ENGINE)), "CONTINUATION_INVALID", "the source changed since the run began");
  });
});

// ── provenance under concurrent change (AE5) ───────────────────────────────

describe("provenance races (R11, AE5)", () => {
  it("a source replaced during an awaited judgment cannot publish a pointer into text it was not judged on", async () => {
    addPaper("10.1111/aaa", "Alpha", paperText("A", 80, 41).text);
    let swapped = false;
    const { hooks } = engine({
      onRun: () => {
        if (swapped) return;
        swapped = true;
        publishSource(db, "10.1111/aaa", { kind: "local-file", ref: "n.pdf", license: null, digest: "f".repeat(64), extraction: "t@1", text: paperText("N", 50, 10).text, pageStarts: null }, { chunk_tokens: 8192, overlap_tokens: 128, chars_per_token: 2.8, boundary: "paragraph" }, NOW());
      },
    });
    const r = await run({ papers: "all" }, hooks);
    assert.equal(S(r).evidence.length, 0, "no stale evidence is returned");
    assert.ok(S(r).coverage.output.staleDropped >= 1 || S(r).result.limitations.includes("source_changed"));
    assert.equal(S(r).result.complete, false);
  });

  it("a paper removed during judgment leaves no evidence and no dangling rows", async () => {
    addPaper("10.1111/aaa", "Alpha", paperText("A", 80, 41).text);
    let removed = false;
    const { hooks } = engine({ onRun: () => { if (!removed) { removed = true; deregisterPapers(db, ["10.1111/aaa"]); } } });
    const r = await run({ papers: "all" }, hooks);
    assert.equal(S(r).evidence.length, 0);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM claim_evidence").get() as { n: number }).n, 0);
  });
});

// ── direct passages (R12) ──────────────────────────────────────────────────

describe("direct passages", () => {
  beforeEach(() => addPaper("10.1111/aaa", "Alpha", paperText("A", 80, 41).text));

  it("a registered source reference is validated against its revision and judged exactly as supplied", async () => {
    const found = await run({ papers: "all" }, engine().hooks);
    const ptr: string = S(found).evidence[0].pointer;
    const { hooks, stats } = engine();
    const r = await run({ passages: [{ source: ptr }] }, hooks);
    assert.equal(S(r).mode, "direct");
    assert.equal(S(r).result.searched, "direct");
    const [ev] = S(r).evidence;
    assert.deepEqual([ev.attested, ev.pointer, ev.doi], [true, ptr, "10.1111/aaa"]);
    assert.equal(stats.rows + S(r).coverage.work.cached, 1, "exactly the supplied passage was judged (or its cached judgment reused)");
    assert.deepEqual(S(r).direct.map((d: { kind: string; status: string }) => [d.kind, d.status]), [["registered", "judged"]]);
  });

  it("a stale, removed or malformed reference is reported and never judged against current text", async () => {
    const found = await run({ papers: "all" }, engine().hooks);
    const ptr: string = S(found).evidence[0].pointer;
    publishSource(db, "10.1111/aaa", { kind: "local-file", ref: "n.pdf", license: null, digest: "e".repeat(64), extraction: "t@1", text: paperText("N", 50, 10).text, pageStarts: null }, { chunk_tokens: 8192, overlap_tokens: 128, chars_per_token: 2.8, boundary: "paragraph" }, NOW());
    const { hooks, stats } = engine();
    const r = await run({ passages: [{ source: ptr }, { source: "10.9999/none@0123456789abcdef#0-30" }, { source: "garbage" }] }, hooks);
    assert.deepEqual(S(r).direct.map((d: { status: string }) => d.status), ["stale", "removed", "invalid"]);
    assert.equal(stats.rows, 0);
    assert.equal(S(r).evidence.length, 0);
  });

  it("caller-supplied text is judged without any attributed provenance, and cannot claim a paper", async () => {
    const { hooks } = engine();
    const r = await run({ passages: [{ text: `${SUPPORT} (supplied by the caller)` }] }, hooks);
    const [ev] = S(r).evidence;
    assert.deepEqual([ev.attested, ev.provenance], [false, "caller_supplied_text"]);
    assert.ok(!("doi" in ev) && !("pointer" in ev) && !("citekey" in ev));
    assert.match(text(r), /no authenticated paper provenance/i);
    assert.equal(refused(await run({ passages: [{ text: SUPPORT, doi: "10.1111/aaa" }] as never }, hooks)), "ARGUMENT_INVALID");
  });

  it("direct mode never registers anything and never mixes with a registry scope", async () => {
    const before = (db.prepare("SELECT COUNT(*) n FROM papers").get() as { n: number }).n;
    await run({ passages: [{ text: SUPPORT + " extra words here" }] }, engine().hooks);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM papers").get() as { n: number }).n, before);
    assert.equal(refused(await run({ passages: [{ text: SUPPORT + " words" }], query: "x" } as never, NO_ENGINE)), "ARGUMENT_INVALID");
  });
});

// ── independent-review regressions ─────────────────────────────────────────

describe("review regressions: paging, continuation and direct-pointer safety", () => {
  const sup = (n: number, marks: Record<number, string> = {}): string =>
    paperText("R", n, null).paragraphs.map((p, i) => (marks[i] !== undefined ? `${filler(`R-p${i}`, 150)} ${SUPPORT} ${marks[i]}` : p)).join("\n\n");
  const drain = async (first: Awaited<ReturnType<typeof run>>, hooks: VerifyHooks, args: Partial<VerifyClaimArgs> = { papers: "all" }) => {
    const all = [...S(first).evidence] as { pointer: string }[];
    let token: string | null = S(first).continuation;
    for (let guard = 0; token !== null && guard < 30; guard++) {
      const n = await run({ ...args, continuation: token } as never, hooks);
      all.push(...S(n).evidence);
      token = S(n).continuation;
    }
    return all.map((e) => e.pointer);
  };

  it("output paging never skips or duplicates evidence when a work continuation adds earlier support after cached later support", async () => {
    writeConfig({ chunkTokens: 256, maxJudgments: 3, workers: 1 });
    addPaper("10.5555/long", "Long Paper", sup(50, { 10: "", 40: "zebra" }));
    const warm = engine();
    await run({ papers: "all", query: "zebra" }, warm.hooks); // caches the later chunk
    const hooks = engine().hooks;
    const first = await run({ papers: "all" }, hooks);
    const chain = await drain(first, hooks);
    writeConfig({ chunkTokens: 256, maxJudgments: 100_000, workers: 1 });
    db.exec("DELETE FROM claim_judgments");
    const whole = await run({ papers: "all" }, engine().hooks);
    assert.equal(new Set(chain).size, chain.length, "no pointer is delivered twice");
    assert.deepEqual([...chain].sort(), S(whole).evidence.map((e: { pointer: string }) => e.pointer).sort(), "the chain delivers exactly what one uninterrupted run finds");
  });

  it("a later page says what it delivers now and what was delivered earlier, instead of 'shown 0 of N'", async () => {
    writeConfig({ chunkTokens: 256, maxJudgments: 3, workers: 1 });
    addPaper("10.5555/long", "Long Paper", sup(50, { 10: "" }));
    const hooks = engine().hooks;
    const first = await run({ papers: "all" }, hooks);
    let token: string | null = S(first).continuation;
    let last = first;
    for (let g = 0; token !== null && g++ < 30; ) {
      last = await run({ papers: "all", continuation: token }, hooks);
      token = S(last).continuation;
    }
    assert.ok(S(last).coverage.output.deliveredEarlier >= 1);
    assert.match(text(last), /delivered on earlier pages/i);
    assert.doesNotMatch(text(last), /in the paper\(s\)/);
  });

  it("excerpt text released across pages never exceeds the per-source share", async () => {
    const paragraphs = Array.from({ length: 60 }, (_, i) => `${filler(`S-p${i}`, 900)} ${SUPPORT}`);
    addPaper("10.4444/many", "Many Supports", paragraphs.join("\n\n"));
    const hooks = engine().hooks;
    const first = await run({ papers: "all" }, hooks);
    let released = S(first).evidence.reduce((n: number, e: { excerpt: string | null }) => n + (e.excerpt?.length ?? 0), 0);
    for (let token: string | null = S(first).continuation, g = 0; token !== null && g++ < 40; ) {
      const n = await run({ papers: "all", continuation: token }, hooks);
      released += S(n).evidence.reduce((m: number, e: { excerpt: string | null }) => m + (e.excerpt?.length ?? 0), 0);
      token = S(n).continuation;
    }
    assert.ok(released <= 0.25 * sourceText("10.4444/many").length, `released ${released}`);
  });

  it("a hand-built source pointer is refused: only pointers this package issued as evidence can be judged directly", async () => {
    addPaper("10.1111/aaa", "Alpha", paperText("A", 80, 41).text);
    const rev = (db.prepare("SELECT revision FROM paper_sources WHERE doi = ?").get("10.1111/aaa") as { revision: string }).revision;
    const { hooks, stats } = engine();
    const r = await run({ passages: [{ source: `10.1111/aaa@${rev}#0-1400` }] }, hooks);
    assert.deepEqual(S(r).direct.map((d: { status: string }) => d.status), ["not_issued"]);
    assert.equal(stats.rows, 0);
    assert.equal(S(r).evidence.length, 0);
  });

  it("a continuation is bound to the exact id list, not just 'ids'", async () => {
    writeConfig({ chunkTokens: 256, maxJudgments: 3, workers: 1 });
    addPaper("10.1111/aaa", "Alpha", sup(50, { 10: "" }));
    addPaper("10.3333/ccc", "Gamma", sup(20, {}));
    const a = await run({ papers: ["10.1111/aaa"] }, engine().hooks);
    const token = S(a).continuation as string;
    assert.ok(token);
    assert.equal(refused(await run({ papers: ["10.3333/ccc"], continuation: token }, NO_ENGINE)), "CONTINUATION_INVALID");
    assert.equal(refused(await run({ papers: ["10.1111/aaa", "10.9999/never"], continuation: token }, NO_ENGINE)), "CONTINUATION_INVALID", "an extra unresolved handle is a different request");
  });

  it("limitations from the first call are not forgotten on later pages", async () => {
    writeConfig({ chunkTokens: 256, maxJudgments: 6, workers: 1 });
    addPaper("10.1111/aaa", "Alpha", sup(50, { 10: "" }));
    addPaper("10.2222/bbb", "Beta No Source", null);
    const hooks = engine().hooks;
    const first = await run({ papers: ["10.1111/aaa", "10.2222/bbb", "10.9999/never"] }, hooks);
    assert.ok(S(first).result.limitations.includes("sources_unavailable"));
    let token: string | null = S(first).continuation;
    let last = first;
    for (let g = 0; token !== null && g++ < 30; ) {
      last = await run({ papers: ["10.1111/aaa", "10.2222/bbb", "10.9999/never"], continuation: token }, hooks);
      token = S(last).continuation;
    }
    assert.equal(S(last).result.complete, false, "unavailable and unresolved scope still make the result incomplete");
    for (const l of ["sources_unavailable", "unresolved_scope"]) assert.ok(S(last).result.limitations.includes(l), l);
    assert.equal(S(last).coverage.sources.unavailable.length, 1);
    assert.equal(S(last).coverage.sources.unresolved.length, 1);
  });

  it("an interrupted localization is unfinished work, never misleading chunk-scale evidence; the continuation completes it", async () => {
    writeConfig({ chunkTokens: 8192, maxJudgments: 120, workers: 2 }); // large windows: stage 1 is one batch, then ~25 localization rows
    addPaper("10.1111/aaa", "Alpha", paperText("A", 80, 41).text);
    const stage1Calls = 1; // both chunks go in one batch
    const failing = engine({ failAfter: stage1Calls });
    const a = await run({ papers: "all" }, failing.hooks);
    assert.equal(S(a).coverage.work.interruption.reason, "engine_failure");
    assert.match(S(a).coverage.work.interruption.detail, /localiz/i);
    assert.equal(S(a).evidence.length, 0, "no chunk-scale pointer-only evidence is emitted for unfinished localization");
    assert.ok(S(a).continuation, "the unfinished localization is continuable");
    const ok = engine();
    const b = await run({ papers: "all", continuation: S(a).continuation }, ok.hooks);
    assert.equal(S(b).evidence.length, 1);
    assert.ok(S(b).evidence[0].excerpt.includes(SUPPORT));
    assert.equal(S(b).result.complete, true);
  });

  it("a locator continuation keeps the candidate list it began with, even when another paper is registered meanwhile", async () => {
    writeConfig({ chunkTokens: 256, maxJudgments: 2, workers: 1 });
    const alpha = Array.from({ length: 40 }, (_, i) => `${filler(`A-p${i}`, 330)} alpha beta ${"alpha ".repeat(i % 5)}`).join("\n\n");
    addPaper("10.1111/aaa", "Alpha", alpha);
    const seen: string[] = [];
    const { hooks } = engine({ onRun: () => undefined });
    const spy: VerifyHooks = { ...hooks, createEngine: (n) => { const e = hooks.createEngine!(n); return { run: async (rows) => { seen.push(...rows.map((r) => r.state)); return e.run(rows); } }; } };
    const first = await run({ papers: "all", query: "alpha beta" }, spy);
    assert.ok(S(first).continuation);
    addPaper("10.7777/new", "Newcomer", Array.from({ length: 30 }, (_, i) => `NEW-p${i} alpha alpha alpha alpha beta beta beta ${filler(`N${i}`, 200)}`).join("\n\n"));
    for (let token: string | null = S(first).continuation, g = 0; token !== null && g++ < 20; ) {
      const n = await run({ papers: "all", query: "alpha beta", continuation: token }, spy);
      token = S(n).continuation;
    }
    assert.ok(seen.length > 0 && seen.every((s) => !s.includes("NEW-p")), "the newcomer's chunks were never judged by this run");
  });
});

describe("review regressions: acquisition throttle and bounds", () => {
  it("a failed LOCAL attach does not throttle automatic acquisition", async () => {
    addPaper("10.2222/bbb", "Beta", null);
    db.prepare("INSERT INTO paper_sources (doi, status, kind, prepared_at, failure_code, failure_detail) VALUES (?, 'failed', 'local-file', ?, 'not_a_document', 'x')").run("10.2222/bbb", "2026-10-04T11:00:00Z");
    let lookups = 0;
    const c = ctx({ fetch: (async () => { lookups++; return new Response("{}", { status: 404 }); }) as unknown as ToolContext["fetch"], download: async () => { throw new Error("unused"); } });
    await run({ papers: "all" }, NO_ENGINE, c);
    assert.ok(lookups > 0, "the user's bad file says nothing about open-access availability");
  });

  it("source preparation is bounded per call; never-attempted papers go first; the rest is reported as deferred", async () => {
    for (let i = 0; i < 25; i++) addPaper(`10.8${String(i).padStart(3, "0")}/p${i}`, `Paper Number ${i}`, null);
    const looked: string[] = [];
    // The bound is on papers attempted per call: each costs one OpenAlex lookup, plus, when OpenAlex gives no source, one Europe PMC and one Semantic Scholar lookup (at most three per paper).
    const c = ctx({ fetch: (async (u: string) => { looked.push(u); return new Response("{}", { status: 404 }); }) as unknown as ToolContext["fetch"], download: async () => { throw new Error("unused"); }, providerConfig: { sleep: async () => {} } });
    const r = await run({ papers: "all" }, NO_ENGINE, c);
    assert.ok(looked.filter((u) => u.includes("openalex")).length <= 20, `${looked.length} lookups`);
    assert.ok(looked.length <= 60, `${looked.length} lookups`);
    assert.ok(S(r).result.limitations.includes("sources_deferred"));
    const deferred = S(r).coverage.sources.unavailable.filter((u: { code: string }) => u.code === "deferred");
    assert.equal(deferred.length, 5);
    looked.length = 0;
    await run({ papers: "all" }, NO_ENGINE, c);
    const lookedDois = new Set(looked.map((u) => decodeURIComponent(u)).filter((u) => /10\.8\d{3}\/p(2[0-4])\b/.test(u)));
    assert.ok(lookedDois.size > 0, "the previously deferred papers are reached next time");
  });

  it("a locked database is a REGISTRY_BUSY refusal, not a raw error", async () => {
    addPaper("10.1111/aaa", "Alpha", paperText("A", 40, 5).text);
    const { DatabaseSync } = await import("node:sqlite");
    const other = new DatabaseSync(join(root, ".registry", "registry.db"));
    other.exec("BEGIN IMMEDIATE");
    try {
      const r = await run({ papers: "all" }, engine().hooks);
      assert.equal(refused(r), "REGISTRY_BUSY");
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
  });
});
