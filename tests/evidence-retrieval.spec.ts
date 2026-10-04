/**
 * Internal candidate selection and supporting passages (KTD6–KTD7, R8–R11,
 * R13–R15; AE4, AE6): no-query enumeration is exhaustive, locator queries
 * prune with per-paper accounting, excerpts are verbatim source text, and
 * containment keeps support from becoming a full-text export path.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { ChunkTextConfig } from "../src/core/chunk.ts";
import { createRegistry, deregisterPapers, registerPaper } from "../src/core/registry.ts";
import { CANDIDATES_PER_PAPER, QUERY_MAX_TOKENS, locatorTokens, selectCandidates } from "../src/core/verify/retrieve.ts";
import { EXCERPT_MAX_CHARS, PASSAGE_CFG, SOURCE_SHARE_MAX, containEvidence, localizePassages, type SupportedPassage } from "../src/core/verify/evidence.ts";
import { publishSource } from "../src/core/verify/store.ts";

const NOW = new Date("2026-10-04T00:00:00Z");
const CFG: ChunkTextConfig = { chunk_tokens: 300, overlap_tokens: 0, chars_per_token: 1, boundary: "paragraph" };

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-retr-"));
  db = createRegistry(root);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function paper(doi: string, title: string, paragraphs: string[], digest = "a".repeat(64)): void {
  registerPaper(db, { doi, title, authors: [] }, { now: () => NOW });
  publishSource(db, doi, { kind: "local-file", ref: "x.pdf", license: null, digest, extraction: "t@1", text: paragraphs.join("\n\n"), pageStarts: null }, CFG, NOW);
}
const filler = (word: string) => `${word} `.repeat(40).trim() + ".";
const BAT = "10.1111/bat";
const WLS = "10.1111/wls";

describe("locatorTokens", () => {
  it("extracts searchable words and numbers across scripts and never leaks query syntax", () => {
    assert.deepEqual(locatorTokens("99.5% accuracy (Table IV)"), ["99", "5", "accuracy", "table", "iv"]);
    assert.deepEqual(locatorTokens("Zürich naïve 45 °C"), ["zürich", "naïve", "45", "c"]);
    assert.deepEqual(locatorTokens("電池 寿命"), ["電池", "寿命"]);
    assert.deepEqual(locatorTokens('battery AND NOT "x'), ["battery", "and", "not", "x"], "operators are plain words");
    assert.deepEqual(locatorTokens("((( ))) *** --- :::"), []);
    assert.ok(locatorTokens("w ".repeat(500)).length <= QUERY_MAX_TOKENS, "bounded");
  });
});

describe("selectCandidates", () => {
  beforeEach(() => {
    paper(BAT, "Battery Aging", [filler("alpha"), "Cells fade faster at 45 degrees; capacity loss reaches twelve percent. " + filler("beta"), filler("gamma"), filler("delta")]);
    paper(WLS, "Wireless Models", [filler("encoder"), filler("masking"), filler("channel")]);
  });

  it("no query: every usable chunk of every selected paper, in a deterministic order, with per-paper totals", () => {
    const out = selectCandidates(db, [BAT, WLS], null);
    assert.deepEqual(out.map((p) => p.doi), [BAT, WLS]);
    for (const p of out) {
      assert.equal(p.candidates.length, p.chunksTotal);
      assert.equal(p.matched, p.chunksTotal, "exhaustive: all chunks are candidates");
      assert.deepEqual(p.candidates.map((c) => c.chunkIndex), [...p.candidates.map((c) => c.chunkIndex)].sort((a, b) => a - b));
    }
    assert.deepEqual(selectCandidates(db, [BAT, WLS], null), out);
  });

  it("candidates carry the exact source revision, span and verbatim text", () => {
    const [p] = selectCandidates(db, [BAT], null);
    const full = (db.prepare("SELECT text FROM paper_sources WHERE doi = ?").get(BAT) as { text: string }).text;
    const rev = (db.prepare("SELECT revision FROM paper_sources WHERE doi = ?").get(BAT) as { revision: string }).revision;
    for (const c of p.candidates) {
      assert.equal(c.revision, rev);
      assert.equal(full.slice(c.start, c.end), c.text);
    }
  });

  it("a query prunes to matching chunks, accounts for every selected paper and reports no-candidate papers", () => {
    const out = selectCandidates(db, [BAT, WLS], "capacity loss at 45 degrees");
    const bat = out.find((p) => p.doi === BAT)!;
    const wls = out.find((p) => p.doi === WLS)!;
    assert.ok(bat.candidates.length >= 1 && bat.candidates.length < bat.chunksTotal);
    assert.ok(bat.candidates[0].text.includes("capacity loss"));
    assert.deepEqual([wls.matched, wls.candidates.length], [0, 0], "present in the accounting with zero candidates, not silently omitted");
    assert.equal(wls.chunksTotal > 0, true);
  });

  it("AE4: an irrelevant locator misses the supporting chunk that the exhaustive pass includes", () => {
    const exhaustive = selectCandidates(db, [BAT], null)[0].candidates.some((c) => c.text.includes("capacity loss reaches twelve percent"));
    const irrelevant = selectCandidates(db, [BAT], "quantum chromodynamics lattice")[0];
    assert.equal(exhaustive, true);
    assert.equal(irrelevant.candidates.length, 0);
    assert.equal(irrelevant.matched, 0);
  });

  it("caps candidates per paper and says how many matched", () => {
    const many = Array.from({ length: CANDIDATES_PER_PAPER + 6 }, (_, i) => `Thermal runaway note ${i}. ` + filler(`w${i}`));
    paper("10.1111/many", "Many Matches", many);
    const p = selectCandidates(db, ["10.1111/many"], "thermal runaway")[0];
    assert.equal(p.candidates.length, CANDIDATES_PER_PAPER);
    assert.ok(p.matched > CANDIDATES_PER_PAPER, "matched reports the full count, not the cap");
    assert.equal(p.matched, p.chunksTotal, "every chunk mentions the locator");
  });

  it("hostile query text never errors, never changes meaning through operators", () => {
    for (const q of ['battery AND NOT "x', "col:val", "NEAR(a b)", "a*", "-neg", "99.5%", "°C", "Zürich naïve", "電池 寿命", "' OR 1=1 --", "batt\u0000ery capacity"]) {
      assert.doesNotThrow(() => selectCandidates(db, [BAT], q), JSON.stringify(q));
    }
    assert.equal(selectCandidates(db, [BAT], "capacity AND loss")[0].candidates.length >= 1, true, "AND is an ordinary word, not a boolean");
  });

  it("a query with no searchable words is not treated as 'match nothing' or 'match everything'", () => {
    assert.throws(() => selectCandidates(db, [BAT], "((( )))"), /searchable/);
  });

  it("replaced or removed sources leave no obsolete hits", () => {
    paper(BAT, "Battery Aging", [filler("omega"), "Brand new text about supercapacitors. " + filler("sigma")], "b".repeat(64));
    assert.equal(selectCandidates(db, [BAT], "capacity loss")[0].candidates.length, 0);
    assert.ok(selectCandidates(db, [BAT], "supercapacitors")[0].candidates.length >= 1);
    deregisterPapers(db, [BAT]);
    assert.deepEqual(selectCandidates(db, [BAT], "supercapacitors"), []);
  });

  it("papers without a ready source are not candidates (the caller reports them as source coverage)", () => {
    registerPaper(db, { doi: "10.1111/meta", title: "Metadata Only", authors: [] }, { now: () => NOW });
    assert.deepEqual(selectCandidates(db, ["10.1111/meta", WLS], null).map((p) => p.doi), [WLS]);
  });
});

describe("localizePassages", () => {
  it("splits a large supported chunk into verbatim passages no larger than the excerpt limit", () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence ${i} reports value ${i} at 45 °C.`).join(" ");
    const parts = localizePassages({ start: 1000, text });
    assert.ok(parts.length > 1);
    for (const p of parts) {
      assert.ok(p.text.length <= EXCERPT_MAX_CHARS);
      assert.equal(p.text, text.slice(p.start - 1000, p.end - 1000), "spans are absolute and slice back exactly");
    }
  });

  it("a chunk already within the limit is its own passage (no second judgment needed)", () => {
    const parts = localizePassages({ start: 50, text: "Short chunk that fits." });
    assert.deepEqual(parts, [{ start: 50, end: 72, text: "Short chunk that fits." }]);
  });

  it("passage windows are the documented policy (≈1,200 characters, below the excerpt limit)", () => {
    assert.ok(Math.floor(PASSAGE_CFG.chunk_tokens * PASSAGE_CFG.chars_per_token) <= EXCERPT_MAX_CHARS);
  });
});

describe("containEvidence", () => {
  const p = (over: Partial<SupportedPassage>): SupportedPassage => ({ doi: BAT, citekey: "bat2024", revision: "r".repeat(16), chunkId: "c", start: 0, end: 100, page: null, pTrue: 0.995, text: "x".repeat(100), ...over });

  it("releases verbatim excerpts for a normal paper", () => {
    const out = containEvidence([p({ start: 0, end: 200, text: "a".repeat(200) }), p({ start: 5_000, end: 5_300, text: "b".repeat(300), pTrue: 0.999 })], () => 100_000);
    assert.deepEqual(out.map((e) => [e.start, e.withheld, e.excerpt?.length]), [[0, null, 200], [5_000, null, 300]]);
  });

  it("AE6: a short single-chunk paper is never exported through its own support (pointer only)", () => {
    const [e] = containEvidence([p({ start: 0, end: 900, text: "t".repeat(900) })], () => 1_000);
    assert.equal(e.excerpt, null);
    assert.equal(e.withheld, "whole_source");
    assert.deepEqual([e.start, e.end], [0, 900], "the exact pointer is kept");
  });

  it("AE6: many supported passages that would collectively reproduce the body stop releasing text at the source-share limit", () => {
    const len = 10_000;
    const passages = Array.from({ length: 20 }, (_, i) => p({ start: i * 500, end: i * 500 + 400, text: "z".repeat(400), pTrue: 0.99 + i / 10_000, chunkId: `c${i}` }));
    const out = containEvidence(passages, () => len);
    const released = out.filter((e) => e.excerpt !== null).reduce((n, e) => n + e.excerpt!.length, 0);
    assert.ok(released <= SOURCE_SHARE_MAX * len, `released ${released}`);
    assert.ok(out.some((e) => e.withheld === "source_share"));
    assert.equal(out.length, 20, "every supporting pointer is still reported");
    const releasedStarts = out.filter((e) => e.excerpt !== null).map((e) => e.start);
    const withheldStarts = out.filter((e) => e.excerpt === null).map((e) => e.start);
    assert.ok(Math.max(...releasedStarts) < Math.min(...withheldStarts), "text is released in reading order, so a continuation can never release more than one call would");
  });

  it("an oversize span is withheld as excerpt_cap, never clipped", () => {
    const [e] = containEvidence([p({ start: 0, end: 20_000, text: "q".repeat(20_000) })], () => 1_000_000);
    assert.deepEqual([e.withheld, e.excerpt], ["excerpt_cap", null]);
  });

  it("overlapping support in one paper collapses to the strongest passage; other papers are untouched", () => {
    const out = containEvidence(
      [p({ start: 0, end: 400, pTrue: 0.992, chunkId: "a" }), p({ start: 300, end: 700, pTrue: 0.999, chunkId: "b" }), p({ doi: WLS, citekey: "wls2024", start: 0, end: 400, chunkId: "c" })],
      () => 100_000,
    );
    assert.deepEqual(out.map((e) => [e.doi, e.chunkId]), [[BAT, "b"], [WLS, "c"]]);
  });

  it("returns evidence in reading order: citekey, then position", () => {
    const out = containEvidence([p({ start: 900, end: 1000 }), p({ doi: WLS, citekey: "aaa", start: 5, end: 80 }), p({ start: 100, end: 200 })], () => 100_000);
    assert.deepEqual(out.map((e) => [e.citekey, e.start]), [["aaa", 5], ["bat2024", 100], ["bat2024", 900]]);
  });
});
