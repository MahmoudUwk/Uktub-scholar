/**
 * Verification pipeline spec: parallel partition + reassembly, paper-level
 * any-supported aggregation, and cache-integrated skip — fully offline with
 * fake engines (no model, no network).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRegistry, openRegistry } from "../src/core/registry.ts";
import { replaceChunks, cachedVerdicts } from "../src/core/verify/store.ts";
import { verifyClaimInPaper, mapChunkVerdict } from "../src/core/verify/pipeline.ts";
import type { ChunkTextConfig } from "../src/core/chunk.ts";

let root: string;
const CFG: ChunkTextConfig = { chunk_tokens: 128, overlap_tokens: 0, chars_per_token: 4.0, boundary: "hard" };
const storeDeps = {
  chunksOf: (db: unknown, doi: string) => chunksOf(db as import("node:sqlite").DatabaseSync, doi),
  cachedVerdicts,
  saveVerdicts,
};
import { chunksOf, saveVerdicts, claimHashOf } from "../src/core/verify/store.ts";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-pipe-"));
  createRegistry(root);
  const db = openRegistry(root);
  db.prepare(
    "INSERT INTO papers (doi, citekey, title, authors_json, year, venue, provider_bibtex, bibtex_source, citable, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("10.1234/x", "x2026", "Paper X", '["A"]', 2026, null, "bibtex", "crossref", 1, "2026-10-02T00:00:00Z");
  db.close();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakeEngine(pTrueFor: (state: string, claim: string) => number, log?: { calls: number; rows: number }) {
  return () => ({
    run: async (rows: { state: string; instructions: string }[]) => {
      if (log) {
        log.calls++;
        log.rows += rows.length;
      }
      return rows.map((r) => pTrueFor(r.state, r.instructions));
    },
  });
}


describe("verifyClaimInPaper regression (gemini review)", () => {
  it("congruent chunk_index misses never leave an engine bucket undefined", async () => {
    const db = openRegistry(root);
    // Four 20-char paragraphs at a 32-char chunk target yield exactly three
    // chunks (probe-verified): caching the middle one leaves misses
    // {chunk_index 0, 2} — congruent mod 2 engines, the exact condition that
    // crashed the old chunk_index-keyed bucketing (undefined bucket).
    const CFG3 = { chunk_tokens: 8, overlap_tokens: 0, chars_per_token: 4.0, boundary: "hard" as const };
    const text = Array.from({ length: 4 }, (_, i) => String(i).repeat(10) + "x".repeat(10)).join("\n\n");
    replaceChunks(db, "10.1234/x", text, CFG3);
    const all = chunksOf(db, "10.1234/x");
    const middle = all.find((c) => c.chunk_index === 1)!;
    const ch = claimHashOf("The tower is in Paris.");
    saveVerdicts(db, [{ claim_hash: ch, chunk_hash: middle.content_hash, model: "m", min_confidence: 0.99, verdict: "unverified", confidence: 0.5, evidence_quote: null }]);
    const log = { calls: 0, rows: 0 };
    const r = await verifyClaimInPaper(
      db,
      storeDeps,
      { createEngine: fakeEngine(() => 0.2, log), doi: "10.1234/x", claim: "The tower is in Paris.", model: "m", minConfidence: 0.99, workers: 2 },
    );
    assert.equal(log.rows, 2, "both misses verified");
    assert.equal(r.chunks.length, all.length);
    assert.equal(log.calls, 2, "two engines, one row each");
  });

  it("refuted fresh chunk reports confidence-in-verdict (1 - p), not raw p", async () => {
    const db = openRegistry(root);
    replaceChunks(db, "10.1234/x", "only chunk.", CFG);
    const r = await verifyClaimInPaper(
      db,
      storeDeps,
      { createEngine: fakeEngine(() => 0.001), doi: "10.1234/x", claim: "The tower is in Paris.", model: "m", minConfidence: 0.99, workers: 1 },
    );
    assert.equal(r.verdict, "refuted");
    assert.equal(r.confidence > 0.99, true, `confidence should be 1 - p = 0.999, got ${r.confidence}`);
    assert.equal(r.chunks[0].confidence > 0.99, true);
    assert.equal(r.chunks[0].p_true, 0.001);
  });
});

describe("verifyClaimInPaper", () => {
  it("any-supported aggregation: one supporting chunk out of many → paper verdict supported", async () => {
    const db = openRegistry(root);
    replaceChunks(db, "10.1234/x", "chunk zero filler.\n\nthe tower is in paris here.\n\nchunk two filler.", CFG);
    const r = await verifyClaimInPaper(
      db,
      storeDeps,
      { createEngine: fakeEngine((state) => (state.includes("paris") ? 0.995 : 0.1)), doi: "10.1234/x", claim: "The tower is in Paris.", model: "m", minConfidence: 0.99, workers: 2 },
    );
    assert.equal(r.verdict, "supported");
    assert.equal(r.confidence, 0.995);
    assert.equal(r.chunks.filter((c) => c.verdict === "supported").length, 1);
  });

  it("cache: second run performs ZERO engine calls and returns identical verdicts", async () => {
    const db = openRegistry(root);
    replaceChunks(db, "10.1234/x", "alpha text.\n\nbeta text.", CFG);
    const log = { calls: 0, rows: 0 };
    const opts = { createEngine: fakeEngine(() => 0.999, log), doi: "10.1234/x", claim: "Something true.", model: "m", minConfidence: 0.99, workers: 2 };
    const first = await verifyClaimInPaper(db, storeDeps, opts);
    assert.equal(first.verdict, "supported");
    const firstRows = log.rows;
    const second = await verifyClaimInPaper(db, storeDeps, opts);
    assert.deepEqual(second.chunks.map((c) => [c.verdict, c.chunk_hash]), first.chunks.map((c) => [c.verdict, c.chunk_hash]));
    assert.equal(log.rows, firstRows, "no new engine rows on the cached run");
  });

  it("workers: 135-style partition — every chunk verified exactly once across engines", async () => {
    const db = openRegistry(root);
    replaceChunks(db, "10.1234/x", "0123456789".repeat(60), CFG); // many hard-split chunks
    const seen = new Set<string>();
    const engine = () => ({
      run: async (rows: { state: string }[]) => {
        for (const r of rows) {
          assert.ok(!seen.has(r.state), "same chunk verified twice across engines");
          seen.add(r.state);
        }
        return rows.map(() => 0.2);
      },
    });
    const r = await verifyClaimInPaper(db, storeDeps, { createEngine: engine, doi: "10.1234/x", claim: "claim", model: "m", minConfidence: 0.99, workers: 4 });
    assert.equal(r.verdict, "unverified");
    const chunkCount = chunksOf(db, "10.1234/x").length;
    assert.equal(seen.size, chunkCount);
  });

  it("mapChunkVerdict mirrors the owner bar", () => {
    assert.equal(mapChunkVerdict(0.995, 0.99).verdict, "supported");
    assert.equal(mapChunkVerdict(0.004, 0.99).verdict, "refuted");
    assert.equal(mapChunkVerdict(0.53, 0.99).verdict, "unverified");
  });
});
