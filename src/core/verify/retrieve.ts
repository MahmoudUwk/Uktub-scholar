/**
 * Locator retrieval (KTD6): candidate selection over the registry's derived
 * passages. Two modes with different guarantees, kept apart on purpose:
 *
 *  - no query → EVERY usable chunk of every selected paper (exhaustive);
 *  - query    → SQLite FTS5/BM25 candidates, a few per paper, with per-paper
 *               accounting. A locator only chooses what to check; it never
 *               replaces the claim, and "no candidates" is a statement about
 *               the search, never about the paper.
 *
 * The query is reduced to plain words and every word is quoted, so no FTS5
 * operator, column filter or wildcard in caller text can change the search.
 * Ranking scores are used for ordering only and are never exposed.
 */

import type { DatabaseSync } from "node:sqlite";

/** Client policy: bounds the FTS expression a caller can build (a sentence-scale locator is far below it). */
export const QUERY_MAX_TOKENS = 32;
/** Client policy: locator candidates verified per paper — about one paper's worth of 8k-token
 *  windows. Recall at this depth is measured in docs/benchmarks (evidence-quality report). */
export const CANDIDATES_PER_PAPER = 5;

export interface Candidate {
  doi: string;
  chunkIndex: number;
  chunkId: string;
  revision: string;
  start: number;
  end: number;
  text: string;
  /** Content address of `text`: the judgment-cache key half. */
  hash: string;
}

export interface PaperCandidates {
  doi: string;
  /** Usable chunks the paper has. */
  chunksTotal: number;
  /** Chunks the selection matched (all of them without a query). */
  matched: number;
  /** The chunks to verify, in reading order. */
  candidates: Candidate[];
}

/** Searchable lowercase words (letters/digits in any script), deduplicated, bounded. */
export function locatorTokens(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)].slice(0, QUERY_MAX_TOKENS);
}

interface ChunkRow {
  doi: string;
  chunk_index: number;
  chunk_id: string;
  revision: string;
  char_start: number;
  char_end: number;
  content_hash: string;
  text: string;
}

const toCandidate = (r: ChunkRow): Candidate => ({
  doi: r.doi,
  chunkIndex: r.chunk_index,
  chunkId: r.chunk_id,
  revision: r.revision,
  start: r.char_start,
  end: r.char_end,
  text: r.text,
  hash: r.content_hash,
});

/**
 * Candidates for `dois` (papers without usable chunks are simply absent — the
 * caller reports their source readiness). Papers come back in citekey order.
 * A query with no searchable words is refused rather than read as "match
 * nothing" or "match everything".
 */
export function selectCandidates(db: DatabaseSync, dois: string[], query: string | null, perPaper: number = CANDIDATES_PER_PAPER): PaperCandidates[] {
  if (dois.length === 0) return [];
  const marks = dois.map(() => "?").join(",");
  const tokens = query === null ? null : locatorTokens(query);
  if (tokens !== null && tokens.length === 0) throw new Error("the locator query has no searchable words; use words or numbers, or omit the query to check every passage");

  const papers = db
    .prepare(
      `SELECT p.doi AS doi, COUNT(c.chunk_index) AS n FROM papers p JOIN chunks c ON c.doi = p.doi
       WHERE p.doi IN (${marks}) GROUP BY p.doi ORDER BY p.citekey`,
    )
    .all(...dois) as { doi: string; n: number }[];
  if (papers.length === 0) return [];

  if (tokens === null) {
    const sel = db.prepare("SELECT doi, chunk_index, chunk_id, revision, char_start, char_end, content_hash, text FROM chunks WHERE doi = ? ORDER BY chunk_index");
    return papers.map((p) => {
      const candidates = (sel.all(p.doi) as unknown as ChunkRow[]).map(toCandidate);
      return { doi: p.doi, chunksTotal: Number(p.n), matched: candidates.length, candidates };
    });
  }

  const expression = tokens.map((t) => `"${t}"`).join(" OR ");
  const ranked = db
    .prepare(
      `SELECT c.doi AS doi, c.chunk_index, c.chunk_id, c.revision, c.char_start, c.char_end, c.content_hash, c.text
       FROM chunk_fts JOIN chunks c ON c.rowid = chunk_fts.rowid
       WHERE chunk_fts MATCH ? AND c.doi IN (${marks})
       ORDER BY bm25(chunk_fts), c.doi, c.chunk_index`,
    )
    .all(expression, ...dois) as unknown as ChunkRow[];
  const byDoi = new Map<string, ChunkRow[]>();
  for (const r of ranked) (byDoi.get(r.doi) ?? byDoi.set(r.doi, []).get(r.doi)!).push(r);
  return papers.map((p) => {
    const hits = byDoi.get(p.doi) ?? [];
    const top = hits.slice(0, perPaper).sort((a, b) => a.chunk_index - b.chunk_index);
    return { doi: p.doi, chunksTotal: Number(p.n), matched: hits.length, candidates: top.map(toCandidate) };
  });
}
