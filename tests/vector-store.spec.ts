/**
 * Passage vector cache (roadmap step 3). A vector is a pure compute cache keyed by what it
 * represents — the passage content and the embedder identity — so it survives rechunking that
 * keeps a passage, is shared by papers that contain the same text, and is never trusted for a
 * different embedder. Exact cosine over stored vectors (corpora are per-project and small).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createRegistry, deregisterPapers, registerPaper } from "../src/core/registry.ts";
import type { ChunkTextConfig } from "../src/core/chunk.ts";
import { EmbedError, type Embedder } from "../src/core/embed/embedder.ts";
import { decodeVector, encodeVector, ensureVectors, pruneVectors, rankByVector } from "../src/core/embed/vectors.ts";
import { chunksOf, publishSource } from "../src/core/verify/store.ts";

const NOW = new Date("2026-10-04T10:00:00Z");
const CFG: ChunkTextConfig = { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 1, boundary: "paragraph" }; // 256-char chunks
const A = "10.1234/aaa";
const B = "10.1234/bbb";

const para = (tag: string): string => `${tag}: ` + "battery cells age faster at high temperature and under heavy load. ".repeat(3).trim();
const textOf = (...tags: string[]): string => tags.map(para).join("\n\n");

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-vec-"));
  db = createRegistry(root);
  for (const doi of [A, B]) registerPaper(db, { doi, title: `Paper ${doi}`, authors: ["A. Author"], year: 2026, bibtex: "@article{x,\n title={T},\n year={2026}\n}", bibtexSource: "crossref" }, { now: () => NOW });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const publish = (doi: string, text: string): void => {
  publishSource(db, doi, { kind: "local-file", ref: "x.pdf", license: null, digest: doi.padEnd(64, "0"), extraction: "t@1", text, pageStarts: null }, CFG, NOW);
};
const count = (table: string): number => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

/** A deterministic embedder: the vector of a text is a fixed unit vector per distinct text, in 8 dimensions. */
function fakeEmbedder(id = "fake|none", opts: { failOnCall?: number; vectorOf?: (t: string) => number[] } = {}): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  const unit = (v: number[]): Float32Array => {
    const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
    return Float32Array.from(v.map((x) => x / n));
  };
  const vectorOf =
    opts.vectorOf ??
    ((t: string): number[] => {
      let h = 7;
      for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return Array.from({ length: 8 }, (_, i) => ((h >>> i) & 1 ? 1 : -1) + (i + 1) / 100);
    });
  return {
    id,
    calls,
    async embedQuery(t) {
      return unit(vectorOf(t));
    },
    async embedDocuments(texts) {
      calls.push(texts);
      if (opts.failOnCall !== undefined && calls.length === opts.failOnCall) throw new EmbedError("server went away");
      return texts.map((t) => unit(vectorOf(t)));
    },
  };
}

describe("vector encoding", () => {
  it("round-trips a Float32 vector bit-exactly and refuses a wrong-length blob", () => {
    const v = Float32Array.from([0.25, -0.5, 1e-7, 0.8660254]);
    assert.deepEqual([...decodeVector(encodeVector(v), 4)], [...v]);
    assert.throws(() => decodeVector(encodeVector(v), 5), /length/);
    assert.throws(() => decodeVector(new Uint8Array(7), 2), /length/);
  });
});

describe("ensureVectors", () => {
  it("embeds each distinct passage once and reuses it afterwards; identical text in two papers shares one vector", async () => {
    publish(A, textOf("p0", "p1", "p2"));
    publish(B, textOf("p1", "p3")); // p1 is the same text in both papers
    const e = fakeEmbedder();
    const first = await ensureVectors(db, e, [A, B], NOW);
    const distinct = new Set([...chunksOf(db, A), ...chunksOf(db, B)].map((c) => c.content_hash)).size;
    assert.equal(first.embedded, distinct);
    assert.equal(count("passage_vectors"), distinct);
    assert.ok(distinct < chunksOf(db, A).length + chunksOf(db, B).length, "a shared passage is stored once");
    const second = await ensureVectors(db, e, [A, B], NOW);
    assert.deepEqual([second.embedded, second.reused], [0, distinct]);
    assert.equal(e.calls.flat().length, distinct, "no passage is sent twice");
  });

  it("embeds the chunk text exactly (the heading and body a reader sees)", async () => {
    publish(A, textOf("only"));
    const e = fakeEmbedder();
    await ensureVectors(db, e, [A], NOW);
    assert.deepEqual(e.calls.flat(), chunksOf(db, A).map((c) => c.text));
  });

  it("a different embedder identity is a separate vector space: vectors are embedded again and the old ones kept", async () => {
    publish(A, textOf("p0", "p1"));
    await ensureVectors(db, fakeEmbedder("m1|none"), [A], NOW);
    const n = count("passage_vectors");
    const second = fakeEmbedder("m2|none");
    const r = await ensureVectors(db, second, [A], NOW);
    assert.ok(r.embedded > 0 && r.reused === 0);
    assert.equal(count("passage_vectors"), n * 2);
  });

  it("a failure part-way keeps what was stored; the next call embeds only the rest", async () => {
    publish(A, textOf(...Array.from({ length: 40 }, (_, i) => `q${i}`)));
    const total = chunksOf(db, A).length;
    const e1 = fakeEmbedder("m|none", { failOnCall: 2 });
    await assert.rejects(ensureVectors(db, e1, [A], NOW, { batchSize: 10 }), (err) => err instanceof EmbedError);
    const stored = count("passage_vectors");
    assert.equal(stored, 10, "the first batch was committed");
    const e2 = fakeEmbedder("m|none");
    const r = await ensureVectors(db, e2, [A], NOW, { batchSize: 10 });
    assert.equal(r.embedded, total - stored);
    assert.equal(r.reused, stored);
    assert.equal(count("passage_vectors"), total);
  });

  it("papers outside the scope are not embedded; a scope with no usable chunks is a no-op", async () => {
    publish(A, textOf("p0"));
    publish(B, textOf("p9"));
    const e = fakeEmbedder();
    await ensureVectors(db, e, [A], NOW);
    assert.equal(count("passage_vectors"), chunksOf(db, A).length);
    assert.deepEqual(await ensureVectors(db, e, [], NOW), { embedded: 0, reused: 0, pending: 0 });
  });
});

describe("pruneVectors", () => {
  it("removes vectors whose passage no longer exists in any paper and keeps shared ones", async () => {
    publish(A, textOf("p0", "p1"));
    publish(B, textOf("p1", "p3"));
    await ensureVectors(db, fakeEmbedder(), [A, B], NOW);
    const before = count("passage_vectors");
    deregisterPapers(db, [A]);
    const removed = pruneVectors(db);
    assert.ok(removed > 0);
    assert.equal(count("passage_vectors"), before - removed);
    const left = new Set(chunksOf(db, B).map((c) => c.content_hash));
    const kept = (db.prepare("SELECT content_hash h FROM passage_vectors").all() as { h: string }[]).map((r) => r.h);
    assert.ok(kept.every((h) => left.has(h)), "only paper B's passages remain");
    assert.ok([...left].every((h) => kept.includes(h)), "none of B's vectors were pruned");
  });
});

describe("rankByVector", () => {
  /** Axis embedder: a text mentioning `tag` points at axis index of that tag, so cosine order is known. */
  const AXES = ["alpha", "beta", "gamma"];
  const axisVector = (t: string): number[] => {
    const v = AXES.map((a) => (t.includes(a) ? 1 : 0.01));
    return v;
  };

  it("orders passages by exact cosine, descending, deterministically, within the scope and the limit", async () => {
    publish(A, ["alpha one two three", "beta four five six", "gamma seven eight", "alpha beta mixed"].map((s) => s + " ".repeat(0) + " filler".repeat(40)).join("\n\n"));
    publish(B, ["alpha in the other paper " + "filler ".repeat(40)].join("\n\n"));
    const e = fakeEmbedder("axes|none", { vectorOf: axisVector });
    await ensureVectors(db, e, [A, B], NOW);
    const q = await e.embedQuery("alpha");
    const ranked = rankByVector(db, e.id, q, [A], 10);
    const chunks = chunksOf(db, A);
    const alphaOnly = chunks.findIndex((c) => c.text.includes("alpha one"));
    assert.equal(ranked[0].doi, A);
    assert.equal(ranked[0].chunkIndex, alphaOnly, "the pure-alpha passage is closest");
    assert.ok(ranked.every((r) => r.doi === A), "scope respected");
    for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].score >= ranked[i].score, "descending");
    assert.equal(rankByVector(db, e.id, q, [A, B], 2).length, 2, "limit respected");
    assert.deepEqual(rankByVector(db, e.id, q, [A, B], 10), rankByVector(db, e.id, q, [A, B], 10), "deterministic");
  });

  it("ignores vectors of another embedder identity and refuses a query of another dimension", async () => {
    publish(A, textOf("p0", "p1"));
    const e = fakeEmbedder("m1|none");
    await ensureVectors(db, e, [A], NOW);
    const q = await e.embedQuery("x");
    assert.deepEqual(rankByVector(db, "someone-else|none", q, [A], 5), []);
    assert.throws(() => rankByVector(db, "m1|none", Float32Array.from([1, 0, 0]), [A], 5), /dimension/);
  });

  it("no vectors yet means no ranking, not an error", () => {
    publish(A, textOf("p0"));
    assert.deepEqual(rankByVector(db, "m|none", Float32Array.from([1, 0]), [A], 5), []);
  });
});
