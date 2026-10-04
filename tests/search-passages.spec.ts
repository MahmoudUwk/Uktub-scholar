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
import { chunksOf, publishSource } from "../src/core/verify/store.ts";
import { ensureVectors } from "../src/core/embed/vectors.ts";
import { openRegistry } from "../src/core/registry.ts";

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

describe("searchPassages — review findings", () => {
  const CFGP: ChunkTextConfig = { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 1, boundary: "paragraph" };
  const paras = (w: string, n = 6): string => Array.from({ length: n }, (_, k) => `${w} paragraph ${k}: ` + "filler words about nothing in particular. ".repeat(5)).join("\n\n");
  const publishP = (database: DatabaseSync, doi: string, text: string, digest = doi.padEnd(64, "0")): void => {
    publishSource(database, doi, { kind: "local-file", ref: "x.pdf", license: null, digest, extraction: "t@1", text, pageStarts: null }, CFGP, NOW);
  };

  it("a paper re-published by another process while the query is being embedded never yields text from a revision the ranking did not see", async () => {
    publishP(db, A, paras("zebra"));
    const other = openRegistry(root);
    const e: Embedder = {
      id: "f|none",
      async embedDocuments(t) {
        return t.map(() => Float32Array.from([1, 0]));
      },
      async embedQuery() {
        publishP(other, A, paras("giraffe"), "f".repeat(64)); // new revision, different text, mid-call
        return Float32Array.from([1, 0]);
      },
    };
    const r = await searchPassages(db, { query: "zebra", dois: [A], limit: 5, embedder: e, now: NOW });
    other.close();
    const current = (db.prepare("SELECT revision, text FROM paper_sources WHERE doi = ?").get(A) as { revision: string; text: string });
    for (const h of r.hits) {
      assert.equal(h.revision, current.revision, "every hit comes from the current revision");
      assert.equal(current.text.slice(h.start, h.end), h.text, "and its text is exactly the span it claims");
    }
    assert.ok(r.hits.every((h) => !h.found.includes("lexical")), "the query's word is gone from the current corpus: no hit may survive from the keyword ranking of the replaced revision");
  });

  it("an error that is not the embedder's (a locked database) is not reported as an embedding problem (review finding)", async () => {
    publishP(db, A, paras("zebra"));
    const e: Embedder = {
      id: "f|none",
      async embedDocuments() {
        throw new Error("database is locked");
      },
      async embedQuery() {
        return Float32Array.from([1, 0]);
      },
    };
    await assert.rejects(searchPassages(db, { query: "zebra", dois: [A], limit: 3, embedder: e, now: NOW }), /database is locked/);
  });

  it("vectors of the wrong dimension under one embedder identity are replaced, not left to degrade every later search (review finding)", async () => {
    publishP(db, A, paras("zebra"));
    const mk = (dim: number): Embedder => ({
      id: "same-id|none",
      async embedQuery() {
        return Float32Array.from({ length: dim }, () => 1 / Math.sqrt(dim));
      },
      async embedDocuments(t) {
        return t.map(() => Float32Array.from({ length: dim }, () => 1 / Math.sqrt(dim)));
      },
    });
    await searchPassages(db, { query: "zebra", dois: [A], limit: 3, embedder: mk(3), now: NOW });
    publishP(db, B, paras("giraffe"));
    for (let i = 0; i < 2; i++) {
      const r = await searchPassages(db, { query: "giraffe", dois: [A, B], limit: 3, embedder: mk(4), now: NOW });
      assert.equal(r.mode, "hybrid", `search ${i + 1} is hybrid`);
      assert.deepEqual(r.limitations, []);
    }
    const dims = (db.prepare("SELECT DISTINCT dim FROM passage_vectors WHERE embed_id = 'same-id|none'").all() as { dim: number }[]).map((d) => d.dim);
    assert.deepEqual(dims, [4]);
  });

  it("a cold index is built a bounded amount per call and the result says so; repeating the search completes it (review finding)", async () => {
    publishP(db, A, paras("zebra", 40));
    const total = chunksOf(db, A).length;
    const calls: number[] = [];
    const e: Embedder = {
      id: "f|none",
      async embedQuery() {
        return Float32Array.from([1, 0]);
      },
      async embedDocuments(t) {
        calls.push(t.length);
        return t.map(() => Float32Array.from([1, 0]));
      },
    };
    const first = await searchPassages(db, { query: "zebra", dois: [A], limit: 3, embedder: e, now: NOW, maxNewEmbeddings: 10 });
    assert.equal(calls.reduce((a, b) => a + b, 0), 10);
    assert.equal(first.mode, "hybrid");
    assert.match(first.limitations.join(" "), /semantic index is partial \(10 of \d+ passages/);
    let guard = 0;
    let last = first;
    while (last.limitations.length > 0 && guard++ < 20) last = await searchPassages(db, { query: "zebra", dois: [A], limit: 3, embedder: e, now: NOW, maxNewEmbeddings: 10 });
    assert.deepEqual(last.limitations, []);
    assert.equal(calls.reduce((a, b) => a + b, 0), total, "every passage embedded exactly once across the calls");
  });

  it("two concurrent searches over one cold corpus do not embed the same passages twice (review finding)", async () => {
    publishP(db, A, paras("zebra", 30));
    const total = chunksOf(db, A).length;
    let embedded = 0;
    const e: Embedder = {
      id: "f|none",
      async embedQuery() {
        return Float32Array.from([1, 0]);
      },
      async embedDocuments(t) {
        await new Promise((r) => setTimeout(r, 5));
        embedded += t.length;
        return t.map(() => Float32Array.from([1, 0]));
      },
    };
    await Promise.all([ensureVectors(db, e, [A], NOW), ensureVectors(db, e, [A], NOW)]);
    assert.equal(embedded, total);
  });

  it("vectors of passages that no longer exist are pruned when vectors are next ensured (review finding)", async () => {
    publishP(db, A, paras("zebra"));
    const e: Embedder = {
      id: "f|none",
      async embedQuery() {
        return Float32Array.from([1, 0]);
      },
      async embedDocuments(t) {
        return t.map(() => Float32Array.from([1, 0]));
      },
    };
    await ensureVectors(db, e, [A], NOW);
    publishP(db, A, paras("giraffe"), "f".repeat(64)); // the old passages are gone
    await ensureVectors(db, e, [A], NOW);
    const live = new Set(chunksOf(db, A).map((c) => c.content_hash));
    const stored = (db.prepare("SELECT content_hash h FROM passage_vectors").all() as { h: string }[]).map((r) => r.h);
    assert.deepEqual(new Set(stored), live, "only live passages keep a vector");
  });
});
