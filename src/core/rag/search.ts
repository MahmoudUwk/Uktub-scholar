/**
 * Hybrid passage search over the registry's chunks: FTS5/BM25 and exact-cosine vector rankings fused
 * with Reciprocal Rank Fusion. The same chunks serve claim verification, so a hit is always a unit
 * the decision engine can read whole. Lexical search is the floor: with no embedder configured, or
 * when the embedder fails, results are BM25 only and any failure is stated, never hidden. Ranking
 * scores are used for ordering and never exposed.
 */
import type { DatabaseSync } from "node:sqlite";

import { EmbedError, type Embedder } from "../embed/embedder.ts";
import { VectorSpaceError, dropVectorsOfOtherDimension, ensureVectors, rankByVector } from "../embed/vectors.ts";
import { lexicalRank } from "../verify/retrieve.ts";
import { pageOf } from "../verify/store.ts";

/** RRF constant (Cormack, Clarke & Büttcher 2009; the value every major hybrid-search engine defaults to). */
export const RRF_K = 60;
/** Client policy: candidates taken from each ranking before fusion. */
export const LEG_POOL = 50;

/** Reciprocal Rank Fusion over rankings of keys (best first). Ties break by key, so the order is total and stable. */
export function rrfFuse(lists: string[][]): { key: string; score: number }[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    let rank = 0;
    for (const key of list) {
      if (seen.has(key)) continue;
      seen.add(key);
      rank++;
      score.set(key, (score.get(key) ?? 0) + 1 / (RRF_K + rank));
    }
  }
  return [...score].map(([key, s]) => ({ key, score: s })).sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export interface SearchHit {
  doi: string;
  citekey: string;
  revision: string;
  /** Span of the passage in the captured text (UTF-16 offsets, end exclusive). */
  start: number;
  end: number;
  /** Heading of the section the passage starts in; null under a fixed-window chunk policy. */
  section: string | null;
  page: number | null;
  /** The passage text. The caller applies output containment before anything leaves the package. */
  text: string;
  /** Which rankings found it. */
  found: ("lexical" | "vector")[];
}

export interface SearchResult {
  hits: SearchHit[];
  mode: "hybrid" | "lexical";
  limitations: string[];
}

/** Client policy: passages embedded per search call. A cold index of a large corpus is built over several calls (each states
 *  how far it got) instead of blocking one call for minutes; ≈ 10 s on a CPU at the measured 35 passages per second. */
export const MAX_NEW_EMBEDDINGS_PER_CALL = 256;

export async function searchPassages(
  db: DatabaseSync,
  a: { query: string; dois: string[]; limit: number; embedder: Embedder | null; now: Date; signal?: AbortSignal; maxNewEmbeddings?: number },
): Promise<SearchResult> {
  // The corpus can change under a call (another process republishes a paper while the query is being embedded). Hits are
  // handles to content-addressed chunks, so a changed chunk is detected, not served as different text; one retry re-ranks
  // on the new corpus, after which anything still missing is dropped.
  let result = await searchOnce(db, a);
  if (result.changed) result = await searchOnce(db, a);
  return { hits: result.hits, mode: result.mode, limitations: result.limitations };
}

async function searchOnce(
  db: DatabaseSync,
  a: { query: string; dois: string[]; limit: number; embedder: Embedder | null; now: Date; signal?: AbortSignal; maxNewEmbeddings?: number },
): Promise<SearchResult & { changed: boolean }> {
  const limit = Math.max(0, Math.floor(a.limit));
  const lexical = lexicalRank(db, a.dois, a.query, LEG_POOL).map((h) => h.chunkId);
  let vector: string[] = [];
  let mode: SearchResult["mode"] = "lexical";
  const limitations: string[] = [];
  if (a.embedder !== null && a.dois.length > 0) {
    const vectorLeg = async (): Promise<{ ids: string[]; partial: string | null }> => {
      const built = await ensureVectors(db, a.embedder!, a.dois, a.now, { signal: a.signal, maxNew: a.maxNewEmbeddings ?? MAX_NEW_EMBEDDINGS_PER_CALL });
      const q = await a.embedder!.embedQuery(a.query, a.signal);
      const ids = rankByVector(db, a.embedder!.id, q, a.dois, LEG_POOL).map((h) => h.chunkId);
      const total = built.embedded + built.reused + built.pending;
      return { ids, partial: built.pending > 0 ? `semantic index is partial (${built.embedded + built.reused} of ${total} passages embedded); repeat the search to extend it` : null };
    };
    try {
      let leg: { ids: string[]; partial: string | null };
      try {
        leg = await vectorLeg();
      } catch (err) {
        if (!(err instanceof VectorSpaceError)) throw err;
        // a different model is serving under this identity: its old vectors are in another space — replace them once
        const probe = await a.embedder.embedQuery(a.query, a.signal);
        dropVectorsOfOtherDimension(db, a.embedder.id, probe.length);
        leg = await vectorLeg();
      }
      vector = leg.ids;
      mode = "hybrid";
      if (leg.partial !== null) limitations.push(leg.partial);
    } catch (err) {
      // only the embedder's own failures degrade to keyword results; anything else (a locked registry, a bug) is not an
      // embedding problem and must not be reported as one
      if (!(err instanceof EmbedError || err instanceof VectorSpaceError)) throw err;
      limitations.push(`vector search unavailable (${err instanceof EmbedError ? err.message : "the stored vectors do not match the configured embedder"}); lexical results only`);
    }
  }
  const fused = rrfFuse(mode === "hybrid" ? [lexical, vector] : [lexical]).slice(0, limit);
  const inLexical = new Set(lexical);
  const inVector = new Set(vector);
  const row = db.prepare(
    `SELECT c.doi AS doi, c.revision AS revision, c.char_start AS start, c.char_end AS end, c.section AS section, c.text AS text, p.citekey AS citekey, s.page_starts_json AS pages
     FROM chunks c JOIN papers p ON p.doi = c.doi LEFT JOIN paper_sources s ON s.doi = c.doi WHERE c.chunk_id = ?`,
  );
  const hits: SearchHit[] = [];
  let changed = false;
  for (const f of fused) {
    const r = row.get(f.key) as { doi: string; revision: string; start: number; end: number; section: string | null; text: string; citekey: string; pages: string | null } | undefined;
    if (r === undefined) {
      changed = true; // the chunk was replaced between ranking and reading
      continue;
    }
    const found: SearchHit["found"] = [];
    if (inLexical.has(f.key)) found.push("lexical");
    if (inVector.has(f.key)) found.push("vector");
    hits.push({
      doi: r.doi,
      citekey: r.citekey,
      revision: r.revision,
      start: Number(r.start),
      end: Number(r.end),
      section: r.section,
      page: pageOf(r.pages === null ? null : (JSON.parse(r.pages) as number[]), Number(r.start)),
      text: r.text,
      found,
    });
  }
  return { hits, mode, limitations, changed };
}
