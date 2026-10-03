/**
 * Chunk + verdict-cache + claim-pointer store (KTD5, KTD6): the only writer
 * of the v2 tables. All multi-row writes are single transactions (all-or-
 * nothing); reads are plain queries for the trace join.
 */

import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

import { chunkId, chunkText, type ChunkTextConfig, type TextChunk } from "../chunk.ts";

export function claimHashOf(claim: string): string {
  return createHash("sha256").update(claim.trim().replace(/\s+/g, " "), "utf8").digest("hex");
}

export interface StoredChunk {
  doi: string;
  chunk_index: number;
  chunk_id: string;
  char_start: number;
  char_end: number;
  est_tokens: number;
  content_hash: string;
  text: string;
}

/** Idempotent replace: chunk a paper's text and swap its chunk rows in one
 * transaction. Re-chunking (new text or config) deletes old rows — the FK
 * cascade removes stale pointers while content-addressed verdicts survive. */
export function replaceChunks(db: DatabaseSync, doi: string, text: string, cfg: ChunkTextConfig): StoredChunk[] {
  const chunks: TextChunk[] = chunkText(text, cfg);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM chunks WHERE doi = ?").run(doi);
    const ins = db.prepare(
      "INSERT INTO chunks (doi, chunk_index, chunk_id, char_start, char_end, est_tokens, content_hash, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const stored: StoredChunk[] = chunks.map((ch) => {
      const s: StoredChunk = {
        doi,
        chunk_index: ch.index,
        chunk_id: chunkId(doi, ch.index),
        char_start: ch.char_start,
        char_end: ch.char_end,
        est_tokens: ch.est_tokens,
        content_hash: ch.content_hash,
        text: ch.text,
      };
      ins.run(s.doi, s.chunk_index, s.chunk_id, s.char_start, s.char_end, s.est_tokens, s.content_hash, s.text);
      return s;
    });
    db.exec("COMMIT");
    return stored;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // the original error is the report
    }
    throw err;
  }
}

export function chunksOf(db: DatabaseSync, doi: string): StoredChunk[] {
  return db
    .prepare("SELECT doi, chunk_index, chunk_id, char_start, char_end, est_tokens, content_hash, text FROM chunks WHERE doi = ? ORDER BY chunk_index")
    .all(doi) as unknown as StoredChunk[];
}

export interface VerdictCacheRow {
  claim_hash: string;
  chunk_hash: string;
  model: string;
  min_confidence: number;
  verdict: "supported" | "refuted" | "unverified";
  /** RAW engine P(true) at judgment time — NOT confidence-in-verdict; derive via mapChunkVerdict(confidence, min_confidence). */
  confidence: number;
  evidence_quote: string | null;
}

/** Cached verdicts for the given (claim, chunk-hash) pairs. Missing pairs are
 * simply absent from the result — callers compute and saveVerdicts them. */
export function cachedVerdicts(
  db: DatabaseSync,
  claim: string,
  model: string,
  minConfidence: number,
  chunkHashes: string[],
): Map<string, VerdictCacheRow> {
  const ch = claimHashOf(claim);
  const out = new Map<string, VerdictCacheRow>();
  const sel = db.prepare(
    "SELECT claim_hash, chunk_hash, model, min_confidence, verdict, confidence, evidence_quote FROM claim_verdicts WHERE claim_hash = ? AND chunk_hash = ? AND model = ? AND min_confidence = ?",
  );
  for (const h of chunkHashes) {
    const row = sel.get(ch, h, model, minConfidence) as VerdictCacheRow | undefined;
    if (row) out.set(h, row);
  }
  return out;
}

export function saveVerdicts(db: DatabaseSync, rows: VerdictCacheRow[]): void {
  if (rows.length === 0) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const ins = db.prepare(
      "INSERT OR REPLACE INTO claim_verdicts (claim_hash, chunk_hash, model, min_confidence, verdict, confidence, evidence_quote, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of rows) ins.run(r.claim_hash, r.chunk_hash, r.model, r.min_confidence, r.verdict, r.confidence, r.evidence_quote, new Date().toISOString());
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // the original error is the report
    }
    throw err;
  }
}

export interface PointerRow {
  doc_id: string;
  claim_text: string;
  claim_hash: string;
  doi: string;
  chunk_index: number;
  char_start: number;
  char_end: number;
  verdict: string;
  confidence: number;
  model: string;
  min_confidence: number;
}

/** Persist supported-chunk pointers for a reviewed document (snapshot rows). */
export function savePointers(db: DatabaseSync, rows: PointerRow[]): void {
  if (rows.length === 0) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const ins = db.prepare(
      "INSERT OR REPLACE INTO claim_pointers (doc_id, claim_text, claim_hash, doi, chunk_index, char_start, char_end, verdict, confidence, model, min_confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of rows) ins.run(r.doc_id, r.claim_text, r.claim_hash, r.doi, r.chunk_index, r.char_start, r.char_end, r.verdict, r.confidence, r.model, r.min_confidence, new Date().toISOString());
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // the original error is the report
    }
    throw err;
  }
}

export interface TraceRow {
  doc_id: string;
  claim_text: string;
  verdict: string;
  confidence: number;
  model: string;
  min_confidence: number;
  doi: string;
  citekey: string;
  title: string;
  chunk_id: string;
  char_start: number;
  char_end: number;
  evidence_quote: string | null;
}

/** The trace join: every reviewed claim in a document → paper → exact chunk. */
export function traceDocument(db: DatabaseSync, docId: string): TraceRow[] {
  return db
    .prepare(
      `SELECT cp.doc_id, cp.claim_text, cp.verdict, cp.confidence, cp.model, cp.min_confidence,
              p.doi, p.citekey, p.title,
              c.chunk_id, cp.char_start, cp.char_end, cv.evidence_quote
       FROM claim_pointers cp
       JOIN papers p ON p.doi = cp.doi
       JOIN chunks  c ON c.doi = cp.doi AND c.chunk_index = cp.chunk_index
       LEFT JOIN claim_verdicts cv
              ON cv.claim_hash = cp.claim_hash AND cv.chunk_hash = c.content_hash
             AND cv.model = cp.model AND cv.min_confidence = cp.min_confidence
       WHERE cp.doc_id = ?
       ORDER BY cp.claim_hash, c.chunk_index`,
    )
    .all(docId) as unknown as TraceRow[];
}
