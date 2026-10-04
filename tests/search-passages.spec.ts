/**
 * Hybrid passage search (roadmap step 3): FTS5/BM25 and exact-cosine vector rankings fused with
 * Reciprocal Rank Fusion (k = 60), a lexical fallback whenever the vector leg is absent or fails, and
 * hits that carry exactly what a caller needs to cite them — pointer parts, section, page — without
 * ever exposing a score. Offline: a controlled embedder stands in for the model.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createRegistry, registerPaper } from "../src/core/registry.ts";
import type { ChunkTextConfig } from "../src/core/chunk.ts";
import { EmbedError, type Embedder } from "../src/core/embed/embedder.ts";
import { RRF_K, rrfFuse, searchPassages } from "../src/core/rag/search.ts";
import { publishSource } from "../src/core/verify/store.ts";

const NOW = new Date("2026-10-04T10:00:00Z");
const SEC: ChunkTextConfig = { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 1, boundary: "section" }; // 256-char cap
const A = "10.1234/aaa";
const B = "10.1234/bbb";

describe("rrfFuse", () => {
  it("scores 1/(k + rank) per list, sums across lists, orders best first and breaks ties by key", () => {
    assert.equal(RRF_K, 60);
    const fused = rrfFuse([["x", "y", "z"], ["y", "x", "w"]]);
    // x: 1/61 + 1/62; y: 1/62 + 1/61 — a tie, broken by key; z: 1/63; w: 1/63 — a tie, broken by key
    assert.deepEqual(fused.map((f) => f.key), ["x", "y", "w", "z"]);
    assert.ok(Math.abs(fused[0].score - (1 / 61 + 1 / 62)) < 1e-12);
    assert.ok(Math.abs(fused[2].score - 1 / 63) < 1e-12);
  });

  it("a key present in one list only still counts, and a key high in both beats keys high in one", () => {
    const fused = rrfFuse([["a", "b", "c"], ["c", "d", "e"]]);
    assert.equal(fused[0].key, "c", "rank 3 + rank 1 beats rank 1 + absent: 1/63+1/61 > 1/61");
    assert.deepEqual(rrfFuse([]), []);
    assert.deepEqual(rrfFuse([[], []]), []);
  });

  it("duplicate keys inside one list count once, at the first position", () => {
    const fused = rrfFuse([["a", "a", "b"]]);
    assert.deepEqual(fused.map((f) => f.key), ["a", "b"]);
    assert.ok(Math.abs(fused[1].score - 1 / 62) < 1e-12, "b is rank 2, not 3");
  });
});

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-search-"));
  db = createRegistry(root);
  for (const doi of [A, B]) registerPaper(db, { doi, title: `Paper ${doi}`, authors: ["A. Author"], year: 2026, bibtex: "@article{x,\n title={T},\n year={2026}\n}", bibtexSource: "crossref" }, { now: () => NOW });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const filler = (n: number): string => " Further sentences about the experimental setup continue here.".repeat(n);
const SECTIONED_A = [
  `1. Introduction\nBattery cells age faster at high temperature and under heavy cycling load.${filler(1)}`,
  `2. Methods\nWe cycled cells between two voltage limits in a climate chamber.${filler(1)}`,
  `3. Results\nSolar panels offset household consumption during the afternoon hours.${filler(1)}`,
].join("\n");
const TEXT_B = `1. Introduction\nWind turbines generate electricity from moving air.${filler(1)}\n2. Discussion\nBattery storage smooths the output of wind generation.${filler(1)}`;
const marksOf = (text: string, heads: string[]): { start: number; heading: string; level: number }[] => heads.map((h) => ({ start: text.indexOf(h), heading: h, level: 1 }));

function publish(doi: string, text: string, heads: string[], pageStarts: number[] | null = null): void {
  publishSource(db, doi, { kind: "local-file", ref: "x.pdf", license: null, digest: doi.padEnd(64, "0"), extraction: "t@1", text, pageStarts, sections: marksOf(text, heads) }, SEC, NOW);
}

/** Concept embedder: texts about the same concept share an axis, regardless of the words used. */
const CONCEPTS: [string, string[]][] = [
  ["energy", ["solar", "wind", "sun", "turbine", "electricity", "consumption"]],
  ["battery", ["battery", "cells", "voltage", "cycled"]],
];
function conceptEmbedder(id = "concept|none", over: { failQuery?: boolean; failDocs?: boolean } = {}): Embedder & { docCalls: number } {
  const vec = (t: string): Float32Array => {
    const v = CONCEPTS.map(([, words]) => 0.05 + words.filter((w) => t.toLowerCase().includes(w)).length);
    const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
    return Float32Array.from(v.map((x) => x / n));
  };
  const e = {
    id,
    docCalls: 0,
    async embedQuery(t: string) {
      if (over.failQuery) throw new EmbedError("embedding server answered HTTP 503");
      return vec(t.replace("sunshine", "sun"));
    },
    async embedDocuments(ts: string[]) {
      e.docCalls++;
      if (over.failDocs) throw new EmbedError("embedding server answered HTTP 500");
      return ts.map(vec);
    },
  };
  return e;
}

describe("searchPassages", () => {
  it("lexical only (no embedder): BM25 order, section label, exact spans, page, revision — and no score", async () => {
    publish(A, SECTIONED_A, ["1. Introduction", "2. Methods", "3. Results"], [0, 100]);
    const r = await searchPassages(db, { query: "battery cells temperature", dois: [A], limit: 3, embedder: null, now: NOW });
    assert.equal(r.mode, "lexical");
    assert.deepEqual(r.limitations, [], "lexical-only by configuration is not a degradation");
    assert.equal(r.hits[0].section, "1. Introduction");
    const h = r.hits[0];
    assert.equal(SECTIONED_A.slice(h.start, h.end), h.text);
    assert.match(h.revision, /^[0-9a-f]{16}$/);
    assert.equal(h.doi, A);
    assert.ok(h.page === 1 || h.page === 2);
    assert.ok(!("score" in h), "ranking scores are never exposed");
  });

  it("the vector leg surfaces a passage that shares no words with the query (what BM25 cannot do)", async () => {
    publish(A, SECTIONED_A, ["1. Introduction", "2. Methods", "3. Results"]);
    const lexical = await searchPassages(db, { query: "sunshine", dois: [A], limit: 3, embedder: null, now: NOW });
    assert.deepEqual(lexical.hits, [], "no passage contains the word 'sunshine'");
    const e = conceptEmbedder();
    const hybrid = await searchPassages(db, { query: "sunshine", dois: [A], limit: 3, embedder: e, now: NOW });
    assert.equal(hybrid.mode, "hybrid");
    assert.equal(hybrid.hits[0].section, "3. Results", "the solar-energy passage is the nearest concept");
  });

  it("fuses both legs: a passage found by both outranks passages found by one", async () => {
    publish(A, SECTIONED_A, ["1. Introduction", "2. Methods", "3. Results"]);
    const r = await searchPassages(db, { query: "solar consumption", dois: [A], limit: 3, embedder: conceptEmbedder(), now: NOW });
    assert.equal(r.hits[0].section, "3. Results");
    assert.deepEqual(r.hits[0].found.sort(), ["lexical", "vector"]);
  });

  it("embeds passages lazily and once: a second search sends no document to the server", async () => {
    publish(A, SECTIONED_A, ["1. Introduction", "2. Methods", "3. Results"]);
    const e = conceptEmbedder();
    await searchPassages(db, { query: "solar", dois: [A], limit: 2, embedder: e, now: NOW });
    const first = e.docCalls;
    assert.ok(first >= 1);
    await searchPassages(db, { query: "battery", dois: [A], limit: 2, embedder: e, now: NOW });
    assert.equal(e.docCalls, first);
  });

  it("falls back to lexical results, with a stated limitation, when the embedder fails — never quoting passage text", async () => {
    publish(A, SECTIONED_A, ["1. Introduction", "2. Methods", "3. Results"]);
    for (const [i, over] of [{ failQuery: true }, { failDocs: true }].entries()) {
      // a distinct embedder identity per case: vectors cached by an earlier case must not hide the failure
      const r = await searchPassages(db, { query: "battery temperature", dois: [A], limit: 3, embedder: conceptEmbedder(`c${i}|none`, over), now: NOW });
      assert.equal(r.mode, "lexical");
      assert.ok(r.hits.length > 0, "lexical results are still returned");
      assert.equal(r.limitations.length, 1);
      assert.match(r.limitations[0], /vector search unavailable/);
    }
  });

  it("scopes to the requested papers and bounds the number of hits", async () => {
    publish(A, SECTIONED_A, ["1. Introduction", "2. Methods", "3. Results"]);
    publish(B, TEXT_B, ["1. Introduction", "2. Discussion"]);
    const onlyB = await searchPassages(db, { query: "battery", dois: [B], limit: 5, embedder: null, now: NOW });
    assert.ok(onlyB.hits.length > 0 && onlyB.hits.every((h) => h.doi === B));
    const both = await searchPassages(db, { query: "battery", dois: [A, B], limit: 1, embedder: null, now: NOW });
    assert.equal(both.hits.length, 1);
    assert.deepEqual(await searchPassages(db, { query: "battery", dois: [], limit: 5, embedder: null, now: NOW }).then((r) => r.hits), []);
  });

  it("a query with no searchable words is refused; FTS operators in the query cannot change the search", async () => {
    publish(A, SECTIONED_A, ["1. Introduction", "2. Methods", "3. Results"]);
    await assert.rejects(searchPassages(db, { query: "!!! ??? ***", dois: [A], limit: 3, embedder: null, now: NOW }), /searchable words/);
    const hostile = await searchPassages(db, { query: 'battery" OR "x* NEAR(a b) -cells', dois: [A], limit: 3, embedder: null, now: NOW });
    assert.ok(hostile.hits.length > 0);
  });

  it("is deterministic", async () => {
    publish(A, SECTIONED_A, ["1. Introduction", "2. Methods", "3. Results"]);
    const run = (): Promise<unknown> => searchPassages(db, { query: "cells energy", dois: [A], limit: 3, embedder: conceptEmbedder(), now: NOW });
    assert.deepEqual(await run(), await run());
  });
});
