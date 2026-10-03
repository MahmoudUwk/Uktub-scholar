/**
 * Verify-store spec: v1→v2 additive migration, chunk replace (idempotent,
 * cascade), verdict cache hit/miss, pointers, and the trace join.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createRegistry, openRegistry, REGISTRY_SCHEMA_VERSION } from "../src/core/registry.ts";
import { replaceChunks, cachedVerdicts, saveVerdicts, savePointers, traceDocument, claimHashOf, chunksOf } from "../src/core/verify/store.ts";
import type { ChunkTextConfig } from "../src/core/chunk.ts";

let root: string;
const CFG: ChunkTextConfig = { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 4.0, boundary: "hard" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-store-"));
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

describe("verify store", () => {
  it("v1 registry migrates additively to v2 on open (rows preserved)", () => {
    const db = openRegistry(root);
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(v.user_version, REGISTRY_SCHEMA_VERSION);
    const papers = db.prepare("SELECT doi FROM papers").all() as { doi: string }[];
    assert.deepEqual(papers.map((p) => p.doi), ["10.1234/x"]);
    db.close();
  });

  it("replaceChunks is idempotent and cascades on paper delete", () => {
    const db = openRegistry(root);
    const text = "para one.\n\npara two.\n\npara three.";
    const a = replaceChunks(db, "10.1234/x", text, CFG);
    const b = replaceChunks(db, "10.1234/x", text, CFG);
    assert.equal(a.length, b.length);
    const rows = chunksOf(db, "10.1234/x");
    assert.equal(rows.length, a.length);
    db.prepare("DELETE FROM papers WHERE doi = ?").run("10.1234/x");
    assert.equal(chunksOf(db, "10.1234/x").length, 0, "cascade removes chunks");
    db.close();
  });

  it("verdict cache: miss then hit, keyed by claim+chunk+model+bar", () => {
    const db = openRegistry(root);
    replaceChunks(db, "10.1234/x", "some text", CFG);
    const chunks = chunksOf(db, "10.1234/x");
    assert.equal(cachedVerdicts(db, "claim", "m", 0.99, [chunks[0].content_hash]).size, 0);
    saveVerdicts(db, [{ claim_hash: claimHashOf("claim"), chunk_hash: chunks[0].content_hash, model: "m", min_confidence: 0.99, verdict: "supported", confidence: 0.995, evidence_quote: null }]);
    const hit = cachedVerdicts(db, "  claim  ", "m", 0.99, [chunks[0].content_hash]); // normalized claim hash matches
    assert.equal(hit.size, 1);
    assert.equal(hit.get(chunks[0].content_hash)?.verdict, "supported");
    // different bar → different key → miss
    assert.equal(cachedVerdicts(db, "claim", "m", 0.9, [chunks[0].content_hash]).size, 0);
    db.close();
  });

  it("pointers + trace join resolve claim → paper → chunk with evidence", () => {
    const db = openRegistry(root);
    replaceChunks(db, "10.1234/x", "The tower is in Paris. It was built in 1889.", CFG);
    const chunks = chunksOf(db, "10.1234/x");
    saveVerdicts(db, [{ claim_hash: claimHashOf("The tower is in Paris."), chunk_hash: chunks[0].content_hash, model: "m", min_confidence: 0.99, verdict: "supported", confidence: 0.995, evidence_quote: "The tower is in Paris." }]);
    savePointers(db, [{ doc_id: "thesis-ch1", claim_text: "The tower is in Paris.", claim_hash: claimHashOf("The tower is in Paris."), doi: "10.1234/x", chunk_index: chunks[0].chunk_index, char_start: chunks[0].char_start, char_end: chunks[0].char_end, verdict: "supported", confidence: 0.995, model: "m", min_confidence: 0.99 }]);
    const rows = traceDocument(db, "thesis-ch1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].citekey, "x2026");
    assert.equal(rows[0].chunk_id, `${"10.1234/x"}#c0`);
    assert.equal(rows[0].evidence_quote, "The tower is in Paris.");
    db.close();
  });
});
