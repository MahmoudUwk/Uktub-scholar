/**
 * Passage vector cache and exact-cosine ranking. Vectors are keyed by passage content and embedder
 * identity (see schema.sql), computed outside the write lock (a network call) and committed in short
 * batches, so an interrupted run keeps its progress. Per-project corpora are small (a paper is tens to
 * a few hundred passages), so ranking is an exact scan; an index is added only if measurement shows
 * it is needed.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Embedder } from "./embedder.ts";
import { inTransaction } from "../verify/store.ts";

/** Client policy: passages embedded per committed batch (progress granularity of an interrupted run). */
export const ENSURE_BATCH = 32;

export function encodeVector(v: Float32Array): Uint8Array {
  const out = new Uint8Array(v.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < v.length; i++) view.setFloat32(i * 4, v[i], true);
  return out;
}

export function decodeVector(blob: Uint8Array, dim: number): Float32Array {
  if (blob.byteLength !== dim * 4) throw new Error(`stored vector has length ${blob.byteLength} bytes, expected ${dim * 4}`);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const marks = (n: number): string => Array.from({ length: n }, () => "?").join(",");

/**
 * Make sure every distinct passage of `dois` has a vector under `embedder.id`. Embeds only the missing
 * ones. The caller serialises the registry write lock around the COMMITS, not the embedding: this
 * function embeds first and then commits each batch in its own transaction.
 */
export async function ensureVectors(
  db: DatabaseSync,
  embedder: Embedder,
  dois: string[],
  now: Date,
  o: { batchSize?: number; signal?: AbortSignal } = {},
): Promise<{ embedded: number; reused: number }> {
  if (dois.length === 0) return { embedded: 0, reused: 0 };
  const rows = db
    .prepare(
      `SELECT c.content_hash AS hash, c.text AS text, EXISTS (SELECT 1 FROM passage_vectors v WHERE v.content_hash = c.content_hash AND v.embed_id = ?) AS have
       FROM chunks c WHERE c.doi IN (${marks(dois.length)}) ORDER BY c.doi, c.chunk_index`,
    )
    .all(embedder.id, ...dois) as unknown as { hash: string; text: string; have: number }[];
  const seen = new Set<string>();
  const missing: { hash: string; text: string }[] = [];
  let reused = 0;
  for (const r of rows) {
    if (seen.has(r.hash)) continue;
    seen.add(r.hash);
    if (r.have) reused++;
    else missing.push({ hash: r.hash, text: r.text });
  }
  const batchSize = Math.max(1, Math.floor(o.batchSize ?? ENSURE_BATCH));
  const insert = db.prepare("INSERT INTO passage_vectors (content_hash, embed_id, dim, vector, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING");
  let embedded = 0;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const vectors = await embedder.embedDocuments(batch.map((b) => b.text), o.signal);
    inTransaction(db, () => {
      batch.forEach((b, k) => insert.run(b.hash, embedder.id, vectors[k].length, encodeVector(vectors[k]), iso(now)));
    });
    embedded += batch.length;
  }
  return { embedded, reused };
}

/** Delete vectors whose passage text no longer exists in any paper. Returns the number removed. */
export function pruneVectors(db: DatabaseSync): number {
  return Number(db.prepare("DELETE FROM passage_vectors WHERE content_hash NOT IN (SELECT content_hash FROM chunks)").run().changes);
}

export interface VectorHit {
  doi: string;
  chunkIndex: number;
  /** Cosine similarity (vectors are unit length). Used for ordering; never exposed. */
  score: number;
}

/** Exact cosine ranking of the passages of `dois` that have a vector under `embedId`, best first. */
export function rankByVector(db: DatabaseSync, embedId: string, query: Float32Array, dois: string[], limit: number): VectorHit[] {
  if (dois.length === 0 || limit <= 0) return [];
  const rows = db
    .prepare(
      `SELECT c.doi AS doi, c.chunk_index AS idx, v.dim AS dim, v.vector AS vector
       FROM chunks c JOIN passage_vectors v ON v.content_hash = c.content_hash AND v.embed_id = ?
       WHERE c.doi IN (${marks(dois.length)})`,
    )
    .all(embedId, ...dois) as unknown as { doi: string; idx: number; dim: number; vector: Uint8Array }[];
  const hits: VectorHit[] = [];
  for (const r of rows) {
    if (Number(r.dim) !== query.length) throw new Error(`the query vector has dimension ${query.length} but stored vectors have dimension ${r.dim}`);
    const v = decodeVector(r.vector, query.length);
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * query[i];
    hits.push({ doi: r.doi, chunkIndex: Number(r.idx), score: dot });
  }
  hits.sort((a, b) => b.score - a.score || (a.doi < b.doi ? -1 : a.doi > b.doi ? 1 : 0) || a.chunkIndex - b.chunkIndex);
  return hits.slice(0, limit);
}
