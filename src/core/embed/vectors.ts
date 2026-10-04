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

/** The stored vectors and the query live in different vector spaces (a dimension differs under one embedder identity). */
export class VectorSpaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorSpaceError";
  }
}

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

/** In-process serialisation per embedder identity: a second concurrent call finds the first one's vectors instead of embedding
 *  the same passages again (another process may still duplicate work; the unique key makes that harmless). */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Make sure the distinct passages of `dois` have a vector under `embedder.id`, embedding at most `maxNew` missing ones this call
 * (`pending` reports how many are still missing). Embeds first and commits each batch in its own short transaction, so an
 * interrupted run keeps its progress and the registry write lock is never held across a network call. Passages that no longer
 * exist anywhere lose their vectors first.
 */
export function ensureVectors(
  db: DatabaseSync,
  embedder: Embedder,
  dois: string[],
  now: Date,
  o: { batchSize?: number; signal?: AbortSignal; maxNew?: number } = {},
): Promise<{ embedded: number; reused: number; pending: number }> {
  const prev = inFlight.get(embedder.id) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => ensureNow(db, embedder, dois, now, o));
  inFlight.set(embedder.id, run.catch(() => undefined));
  return run;
}

async function ensureNow(
  db: DatabaseSync,
  embedder: Embedder,
  dois: string[],
  now: Date,
  o: { batchSize?: number; signal?: AbortSignal; maxNew?: number },
): Promise<{ embedded: number; reused: number; pending: number }> {
  if (dois.length === 0) return { embedded: 0, reused: 0, pending: 0 };
  inTransaction(db, () => pruneVectors(db));
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
  const todo = missing.slice(0, Math.max(0, o.maxNew ?? missing.length));
  const batchSize = Math.max(1, Math.floor(o.batchSize ?? ENSURE_BATCH));
  const insert = db.prepare("INSERT INTO passage_vectors (content_hash, embed_id, dim, vector, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING");
  let embedded = 0;
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const vectors = await embedder.embedDocuments(batch.map((b) => b.text), o.signal);
    inTransaction(db, () => {
      batch.forEach((b, k) => insert.run(b.hash, embedder.id, vectors[k].length, encodeVector(vectors[k]), iso(now)));
    });
    embedded += batch.length;
  }
  return { embedded, reused, pending: missing.length - embedded };
}

/** Delete vectors whose passage text no longer exists in any paper. Returns the number removed. */
export function pruneVectors(db: DatabaseSync): number {
  return Number(db.prepare("DELETE FROM passage_vectors WHERE content_hash NOT IN (SELECT content_hash FROM chunks)").run().changes);
}

/** Remove this embedder's vectors whose dimension differs from `dim` (a different model served under the same identity). */
export function dropVectorsOfOtherDimension(db: DatabaseSync, embedId: string, dim: number): number {
  return Number(db.prepare("DELETE FROM passage_vectors WHERE embed_id = ? AND dim != ?").run(embedId, dim).changes);
}

export interface VectorHit {
  doi: string;
  chunkIndex: number;
  /** Content-addressed chunk id (includes the source revision): a stable handle across awaits. */
  chunkId: string;
  /** Cosine similarity (vectors are unit length). Used for ordering; never exposed. */
  score: number;
}

/** Exact cosine ranking of the passages of `dois` that have a vector under `embedId`, best first. */
export function rankByVector(db: DatabaseSync, embedId: string, query: Float32Array, dois: string[], limit: number): VectorHit[] {
  if (dois.length === 0 || limit <= 0) return [];
  const rows = db
    .prepare(
      `SELECT c.doi AS doi, c.chunk_index AS idx, c.chunk_id AS cid, v.dim AS dim, v.vector AS vector
       FROM chunks c JOIN passage_vectors v ON v.content_hash = c.content_hash AND v.embed_id = ?
       WHERE c.doi IN (${marks(dois.length)})`,
    )
    .all(embedId, ...dois) as unknown as { doi: string; idx: number; cid: string; dim: number; vector: Uint8Array }[];
  const hits: VectorHit[] = [];
  for (const r of rows) {
    if (Number(r.dim) !== query.length) throw new VectorSpaceError(`the query vector has dimension ${query.length} but stored vectors have dimension ${r.dim}`);
    const v = decodeVector(r.vector, query.length);
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * query[i];
    hits.push({ doi: r.doi, chunkIndex: Number(r.idx), chunkId: r.cid, score: dot });
  }
  hits.sort((a, b) => b.score - a.score || (a.doi < b.doi ? -1 : a.doi > b.doi ? 1 : 0) || a.chunkIndex - b.chunkIndex);
  return hits.slice(0, limit);
}
