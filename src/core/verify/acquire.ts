/**
 * Source acquisition for registered papers: the shared work behind `verify_claim`'s on-demand preparation, `paper_registry acquire`
 * and the registration hook. One acquisition per paper at a time (an in-flight map shared by every caller in this process), bounded
 * per call, and a recent negative answer is not repeated.
 */
import type { DatabaseSync } from "node:sqlite";

import { loadChunkConfig, type ChunkConfig } from "../config.ts";
import { openRegistry, selectPapers } from "../registry.ts";
import { acquireSource } from "../source/prepare.ts";
import type { SourceFailureCode } from "../source/extract.ts";
import { providerConfigOf, type ToolContext } from "../tools/context.ts";
import type { ScopePaper } from "./scope.ts";
import { getSource, publishSource, recordSourceFailure } from "./store.ts";

/** Client policy: sources acquired concurrently (each is a lookup, a download and a parse). */
export const SOURCE_PREP_CONCURRENCY = 3;
/** Client policy: a failed acquisition is not retried for 24 hours (a retry can cost a download). */
export const RETRY_FAILED_AFTER_MS = 24 * 60 * 60 * 1000;
/** Client policy: "no open copy found" is not looked up again for an hour (it costs up to three provider lookups). Shorter than a failure:
 *  the answer may only mean a provider was busy. */
export const RETRY_UNAVAILABLE_AFTER_MS = 60 * 60 * 1000;
/** Client policy: acquisitions (lookup + download + parse) attempted per call. Each can cost a download
 *  and seconds of parsing; the rest are reported as deferred and reached on the next call. */
export const MAX_ACQUISITIONS_PER_CALL = 20;

export type SourceReport = { doi: string; citekey: string; status: string; code: string | null; detail: string | null }[];

const inFlight = new Map<string, Promise<void>>();
const keyOf = (root: string, doi: string): string => `${root}\u0000${doi}`;
/** True while an acquisition for this paper is running in this process. */
export const isAcquiring = (root: string, doi: string): boolean => inFlight.has(keyOf(root, doi));

export async function prepareSources(ctx: ToolContext, db: DatabaseSync, papers: ScopePaper[], cfg: ChunkConfig, report: SourceReport): Promise<void> {
  const state = new Map(papers.map((p) => [p.doi, getSource(db, p.doi)]));
  const candidates = papers.filter((p) => {
    const src = state.get(p.doi);
    if (src?.status === "ready") return false;
    if (isAcquiring(ctx.root, p.doi)) return true; // join the running acquisition instead of repeating it
    // A recent negative answer is not repeated: a failed ACQUISITION for a day, "no open copy" for an hour. A failed local attach says
    // nothing about open-access availability, so it never throttles acquisition.
    const age = src == null ? Number.POSITIVE_INFINITY : ctx.now().getTime() - Date.parse(src.preparedAt);
    if (src?.status === "failed" && src.kind !== "local-file" && age < RETRY_FAILED_AFTER_MS) return false;
    if (src?.status === "unavailable" && src.failureCode === "no_open_copy" && age < RETRY_UNAVAILABLE_AFTER_MS) return false;
    return true;
  });
  // Never-attempted papers first, then the longest-waiting: repeated calls reach every paper.
  candidates.sort((a, b) => {
    const sa = state.get(a.doi);
    const sb = state.get(b.doi);
    if ((sa === null) !== (sb === null)) return sa === null ? -1 : 1;
    return (sa?.preparedAt ?? "") < (sb?.preparedAt ?? "") ? -1 : (sa?.preparedAt ?? "") > (sb?.preparedAt ?? "") ? 1 : 0;
  });
  const need = candidates.slice(0, MAX_ACQUISITIONS_PER_CALL);
  for (const p of candidates.slice(MAX_ACQUISITIONS_PER_CALL)) {
    report.push({ doi: p.doi, citekey: p.citekey, status: "unavailable", code: "deferred", detail: `not attempted in this call (at most ${MAX_ACQUISITIONS_PER_CALL} acquisitions per call); repeat the request to continue` });
  }
  const acquireOne = async (p: ScopePaper): Promise<void> => {
    const got = await acquireSource({ fetch: ctx.fetch, download: ctx.download!, cfg: providerConfigOf(ctx), signal: ctx.signal }, { doi: p.doi, title: p.title });
    if (got.ok) await ctx.queue.runExclusive(() => publishSource(db, p.doi, got.source, cfg.chunking, ctx.now()));
    else await ctx.queue.runExclusive(() => recordSourceFailure(db, p.doi, got.status, got.code, got.detail, ctx.now()));
  };
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < need.length) {
      ctx.signal?.throwIfAborted();
      const p = need[next++];
      if (ctx.download === undefined) {
        report.push({ doi: p.doi, citekey: p.citekey, status: "unavailable", code: "acquisition_disabled" satisfies SourceFailureCode, detail: "this host provides no document download" });
        continue;
      }
      const key = keyOf(ctx.root, p.doi);
      let pending = inFlight.get(key);
      if (pending === undefined) {
        pending = acquireOne(p).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      await pending;
      if (getSource(db, p.doi) === null) report.push({ doi: p.doi, citekey: p.citekey, status: "unavailable", code: "no_open_copy", detail: "the paper was removed while its source was prepared" });
    }
  };
  await Promise.all(Array.from({ length: Math.min(SOURCE_PREP_CONCURRENCY, need.length) }, lane));
  // Whatever is still not ready keeps its stored reason in the report.
  for (const p of papers) {
    const src = getSource(db, p.doi);
    if (src !== null && src.status !== "ready" && !report.some((r) => r.doi === p.doi)) {
      report.push({ doi: p.doi, citekey: p.citekey, status: src.status, code: src.failureCode, detail: src.failureDetail });
    }
  }
}

/**
 * Fire-and-forget acquisition after registration, for a long-lived host (the MCP server). Runs in batches until every named paper was
 * attempted, never uses the request's cancellation signal (the request that registered them has ended) and never throws.
 */
export async function startBackgroundAcquisition(ctx: ToolContext, dois: string[]): Promise<void> {
  const bg: ToolContext = { ...ctx, signal: undefined };
  try {
    const db = openRegistry(ctx.root);
    try {
      const cfg = loadChunkConfig(ctx.root, { env: ctx.env });
      const papers: ScopePaper[] = selectPapers(db, { dois, limit: Math.max(1, dois.length) }).map((p) => ({ doi: p.doi, citekey: p.citekey, title: p.title, citable: p.citable }));
      for (let round = 0; round < Math.ceil(papers.length / MAX_ACQUISITIONS_PER_CALL) + 1; round++) {
        const report: SourceReport = [];
        await prepareSources(bg, db, papers, cfg, report);
        if (!report.some((r) => r.code === "deferred")) break;
      }
    } finally {
      db.close();
    }
  } catch {
    // Background work only improves the next call; a failure here is reported by the next acquire or verify_claim.
  }
}
