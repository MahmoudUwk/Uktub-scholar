/**
 * Verification pipeline (KTD6): cache-integrated, parallel claim-vs-chunk
 * verification. The ClaimEngine interface is untouched — fan-out happens HERE
 * across N resident engines (index-stride partition, order-independent
 * reassembly), and the verdict cache is checked before any engine work.
 *
 * Paper-level aggregation (owner rule): a claim is `supported` when ANY chunk
 * of the paper supports it; else `refuted` when any chunk refutes it; else
 * `unverified`.
 */

import type { DatabaseSync } from "node:sqlite";

import { claimHashOf, cachedVerdicts, saveVerdicts, type VerdictCacheRow } from "./store.ts";
import type { ClaimVerdict } from "./claim.ts";

export interface PaperPairInput {
  doi: string;
  claim: string;
}

export interface ChunkVerdict {
  chunk_index: number;
  chunk_hash: string;
  p_true: number;
  verdict: ClaimVerdict["verdict"];
  confidence: number;
  cached: boolean;
}

export interface PaperClaimResult {
  doi: string;
  claim: string;
  verdict: ClaimVerdict["verdict"];
  confidence: number;
  chunks: ChunkVerdict[];
}

interface EngineFactory {
  (): {
    run(rows: { state: string; instructions: string }[]): Promise<number[]>;
  };
}

/** Index-stride parallel map over pairs; reassembles by original index. */
export async function mapParallel<T, R>(items: T[], workers: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const outs = new Array<R>(items.length);
  let cursor = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      outs[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, lane));
  return outs;
}

export async function verifyPairsParallel(
  createEngine: EngineFactory,
  pairs: { state: string; instructions: string }[],
  workers: number,
): Promise<number[]> {
  const engines = Array.from({ length: Math.max(1, Math.min(workers, pairs.length)) }, () => createEngine());
  const rows = pairs.map((p, i) => ({ pair: p, i }));
  const buckets = rows.reduce<Record<number, typeof rows>>((acc, r) => {
    (acc[r.i % engines.length] ??= []).push(r);
    return acc;
  }, {});
  const parts = await Promise.all(
    engines.map((eng, w) => eng.run(buckets[w].map((r) => r.pair)).then((ps) => ({ w, ps }))),
  );
  const pTrues = new Array<number>(pairs.length);
  parts.forEach(({ w, ps }) => {
    buckets[w].forEach((r, j) => {
      pTrues[r.i] = ps[j];
    });
  });
  return pTrues;
}

export interface VerifyInPaperDeps {
  chunksOf: (db: DatabaseSync, doi: string) => { chunk_index: number; content_hash: string; text: string }[];
  cachedVerdicts: typeof cachedVerdicts;
  saveVerdicts: typeof saveVerdicts;
}

/** Verify one claim against EVERY chunk of a paper: cache first, engine for
 * misses (same claim query against every chunk, in parallel), persist fresh
 * verdicts, aggregate to the paper-level verdict. */
export async function verifyClaimInPaper(
  db: DatabaseSync,
  deps: VerifyInPaperDeps,
  opts: {
    createEngine: EngineFactory;
    doi: string;
    claim: string;
    model: string;
    minConfidence: number;
    workers: number;
    now?: () => string;
  },
): Promise<PaperClaimResult> {
  const chunks = deps.chunksOf(db, opts.doi);
  if (chunks.length === 0) {
    return { doi: opts.doi, claim: opts.claim, verdict: "unverified", confidence: 0, chunks: [] };
  }
  const cached = deps.cachedVerdicts(db, opts.claim, opts.model, opts.minConfidence, chunks.map((c) => c.content_hash));

  const misses = chunks.filter((c) => !cached.has(c.content_hash));
  let fresh: { chunk_hash: string; p_true: number }[] = [];
  if (misses.length > 0) {
    const rows = misses.map((c) => ({ state: c.text, instructions: opts.claim }));
    const engines = Array.from({ length: Math.max(1, Math.min(opts.workers, misses.length)) }, () => opts.createEngine());
    const buckets = misses.reduce<Record<number, typeof misses>>((acc, c) => {
      (acc[c.chunk_index % engines.length] ??= []).push(c);
      return acc;
    }, {});
    const parts = await Promise.all(
      engines.map((eng, w) => eng.run(buckets[w].map((c) => ({ state: c.text, instructions: opts.claim }))).then((ps) => ({ w, ps }))),
    );
    parts.forEach(({ w, ps }) => {
      buckets[w].forEach((c, j) => fresh.push({ chunk_hash: c.content_hash, p_true: ps[j] }));
    });
    const ch = claimHashOf(opts.claim);
    deps.saveVerdicts(
      db,
      fresh.map((f) => {
        const mapped = mapChunkVerdict(f.p_true, opts.minConfidence);
        return {
          claim_hash: ch,
          chunk_hash: f.chunk_hash,
          model: opts.model,
          min_confidence: opts.minConfidence,
          verdict: mapped.verdict,
          confidence: mapped.confidence,
          evidence_quote: null as string | null,
        } satisfies VerdictCacheRow;
      }),
    );
  }

  const chunkVerdicts: ChunkVerdict[] = chunks.map((c) => {
    const hit = cached.get(c.content_hash);
    const freshHit = fresh.find((f) => f.chunk_hash === c.content_hash);
    const pTrue = hit ? hit.confidence : freshHit ? freshHit.p_true : 0;
    const verdict = hit ? hit.verdict : mapChunkVerdict(pTrue, opts.minConfidence).verdict;
    return { chunk_index: c.chunk_index, chunk_hash: c.content_hash, p_true: pTrue, verdict, confidence: pTrue, cached: Boolean(hit) };
  });

  const supported = chunkVerdicts.find((c) => c.verdict === "supported");
  const refuted = chunkVerdicts.find((c) => c.verdict === "refuted");
  const best = supported ?? refuted;
  return {
    doi: opts.doi,
    claim: opts.claim,
    verdict: best ? best.verdict : "unverified",
    confidence: best ? best.confidence : 0,
    chunks: chunkVerdicts,
  };
}

/** Per-chunk verdict mapping (chunk-level, bar applied per chunk). */
export function mapChunkVerdict(pTrue: number, minConfidence: number): { verdict: "supported" | "refuted" | "unverified"; confidence: number } {
  if (pTrue >= minConfidence) return { verdict: "supported", confidence: pTrue };
  if (1 - pTrue >= minConfidence) return { verdict: "refuted", confidence: 1 - pTrue };
  return { verdict: "unverified", confidence: pTrue };
}
