/**
 * One-claim verification workflow (R7–R15; KTD2–KTD10): scope → source
 * preparation → candidate selection → judgment → localization → containment →
 * evidence plus four separate coverage dimensions.
 *
 *   sources     which selected papers have a usable captured source
 *   candidates  which passages were selected for checking (all, or query-limited)
 *   work        how many selected passages were actually judged
 *   output      how much supporting evidence exists vs was returned
 *
 * Nothing here returns scores as confidence, a refutation, or text that was
 * not itself judged as supporting. Network, parsing and model work all happen
 * outside write transactions; publication and evidence persistence run through
 * the write queue and re-check source freshness (KTD9).
 */

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { ConfigError, loadChunkConfig, type ChunkConfig } from "../config.ts";
import { selectPapers } from "../registry.ts";
import type { RefusalCode } from "../refusals.ts";
import { acquireSource } from "../source/prepare.ts";
import type { SourceFailureCode } from "../source/extract.ts";
import { providerConfigOf, type ToolContext } from "../tools/context.ts";
import type { ClaimEngine } from "./claim.ts";
import { createConfiguredEngine, resolveEngineIdentity, type EngineIdentity } from "./engines.ts";
import { EXCERPT_MAX_CHARS, containEvidence, localizePassages, type ContainedEvidence, type PriorDelivery, type SupportedPassage } from "./evidence.ts";
import { isSupported, judgePassages, type JudgeResult } from "./judge.ts";
import { locatorTokens, selectCandidates, type Candidate } from "./retrieve.ts";
import { resolveScope, type ScopePaper } from "./scope.ts";
import {
  chunkPolicyOf,
  createRun,
  ensureChunks,
  evidenceOfRun,
  formatPointer,
  getRun,
  getSource,
  getSourceText,
  pageOf,
  passageHashOf,
  publishSource,
  recordSourceFailure,
  resolvePointer,
  saveEvidence,
  setRunState,
  markDelivered,
  pointerIssued,
  claimHashOf,
  type EvidenceRow,
  type RunCarry,
  type RunSnapshot,
} from "./store.ts";

/** Client policy: rows per engine call — bounds how long a cancellation waits. */
export const JUDGE_BATCH_SIZE = 8;
/** Client policy: papers whose sources are acquired at once (provider courtesy). */
export const SOURCE_PREP_CONCURRENCY = 3;
/** Client policy: a failed acquisition is not retried sooner than this (a retry can cost a paid download). */
export const RETRY_FAILED_AFTER_MS = 24 * 60 * 60 * 1000;
/** Client policy: evidence records per response, and excerpt characters per response (≈ 3k tokens). */
export const MAX_EVIDENCE_PER_PAGE = 20;
export const MAX_PAGE_EXCERPT_CHARS = 12_000;

export interface WorkflowHooks {
  createEngine?: (engineName: string) => ClaimEngine;
  /** Fetch used for the engine-identity probe (tests inject; production uses global fetch). */
  fetchImpl?: typeof fetch;
}

export interface VerifyRequest {
  claim: string;
  papers?: "all" | string[];
  query?: string;
  passages?: ({ source: string } | { text: string })[];
  continuation?: string;
}

export type WorkflowOutcome =
  | { kind: "ok"; result: Record<string, any> }
  | { kind: "refused"; code: RefusalCode; message: string };

const refuse = (code: RefusalCode, message: string): WorkflowOutcome => ({ kind: "refused", code, message });

// ── continuation tokens ─────────────────────────────────────────────────────

/** The token only names the run; everything else (what was delivered, where the work stopped) lives with the run. */
const encodeToken = (runId: string): string => Buffer.from(JSON.stringify({ v: 2, r: runId })).toString("base64url");

function decodeToken(token: string): { runId: string } | null {
  try {
    const t = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { v?: number; r?: unknown };
    return t.v === 2 && typeof t.r === "string" ? { runId: t.r } : null;
  } catch {
    return null;
  }
}

const digest12 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

const once = <T>(fn: () => T): (() => T) => {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value;
  };
};

// ── entry ───────────────────────────────────────────────────────────────────

export async function verifyWorkflow(ctx: ToolContext, db: DatabaseSync, req: VerifyRequest, hooks: WorkflowHooks): Promise<WorkflowOutcome> {
  let cfg: ChunkConfig;
  try {
    cfg = loadChunkConfig(ctx.root, { env: ctx.env });
  } catch (err) {
    if (err instanceof ConfigError) return refuse("CONFIG_INVALID", err.message);
    throw err;
  }
  const engineName = cfg.verification.engine;
  const getEngine = once(() => (hooks.createEngine ? hooks.createEngine(engineName) : createConfiguredEngine(ctx.env, engineName)));
  const identityOf = async (): Promise<EngineIdentity | null> => resolveEngineIdentity(ctx.env, engineName, { fetchImpl: hooks.fetchImpl });
  const judge = (identity: EngineIdentity | null, passages: { text: string; hash: string }[]): Promise<JudgeResult> =>
    judgePassages(
      {
        db,
        queue: ctx.queue,
        now: ctx.now,
        identity,
        createEngine: getEngine,
        workers: cfg.verification.workers,
        batchSize: JUDGE_BATCH_SIZE,
        maxFresh: cfg.verification.max_judgments,
        signal: ctx.signal,
      },
      req.claim,
      passages,
    );

  if (req.passages !== undefined) return directWorkflow(ctx, db, req, cfg, identityOf, judge);
  return registryWorkflow(ctx, db, req, cfg, engineName, identityOf, judge);
}

type Judge = (identity: EngineIdentity | null, passages: { text: string; hash: string }[]) => Promise<JudgeResult>;

// ── registry (all / ids, with or without a locator query) ───────────────────

type SourceReport = RunCarry["unavailable"];

async function registryWorkflow(
  ctx: ToolContext,
  db: DatabaseSync,
  req: VerifyRequest,
  cfg: ChunkConfig,
  engineName: string,
  identityOf: () => Promise<EngineIdentity | null>,
  judge: Judge,
): Promise<WorkflowOutcome> {
  const bar = cfg.verification.min_confidence;
  const policy = chunkPolicyOf(cfg.chunking);
  const query = req.query !== undefined && req.query.trim().length > 0 ? req.query : null;
  if (query !== null && locatorTokens(query).length === 0) {
    return refuse("ARGUMENT_INVALID", "the locator query has no searchable words; use words or numbers, or omit the query to check every passage");
  }
  const requested: "all" | "ids" = req.papers === "all" ? "all" : "ids";

  // The requested selection, resolved NOW: used to key a new run and to check a continuation against it.
  const { selected, unresolved } = resolveScope(db, req.papers);
  const scopeKey = requested === "all" ? "all" : digest12(`${selected.map((p) => p.doi).sort().join(",")}|${unresolved.map((u) => u.handle).sort().join(",")}`);

  const detailsOf = (dois: string[]): Map<string, ScopePaper> =>
    new Map(selectPapers(db, { dois, limit: Math.max(1, dois.length) }).map((p) => [p.doi, { doi: p.doi, citekey: p.citekey, title: p.title, citable: p.citable }]));

  let runId: string;
  let snapshot: RunSnapshot;
  let carry: RunCarry;
  let startWork = 0;
  let scopePapers: ScopePaper[] = [];
  const continuing = req.continuation !== undefined;
  let candidateStats: RunSnapshot["selection"];
  let all: Candidate[];

  const effectiveOf = (snap: RunSnapshot): EngineIdentity | null => (snap.model === null ? null : { model: snap.model, protocol: snap.protocol });

  if (continuing) {
    const token = decodeToken(req.continuation!);
    const run = token === null ? null : getRun(db, token.runId, ctx.now());
    if (token === null || run === null) return refuse("CONTINUATION_INVALID", "the continuation is not a live token this tool issued (it may have expired)");
    const snap = run.snapshot;
    if (run.claimHash !== claimHashOf(req.claim) || snap.mode === "direct" || snap.requested !== requested || snap.query !== query || snap.scopeKey !== scopeKey) {
      return refuse("CONTINUATION_INVALID", "the continuation was issued for a different claim, scope or locator query");
    }
    for (const p of snap.papers) {
      const src = getSource(db, p.doi);
      if (src === null || src.status !== "ready" || src.revision !== p.revision || src.chunkPolicy !== p.policy) {
        return refuse("CONTINUATION_INVALID", `a source changed since the run began (${p.doi}); repeat the request without a continuation`);
      }
    }
    if (snap.minConfidence !== bar || snap.engine !== engineName) return refuse("CONTINUATION_INVALID", "the verification engine or confidence bar changed since the run began");
    const identity = await identityOf();
    if ((identity?.model ?? null) !== snap.model) return refuse("CONTINUATION_INVALID", "the model identity changed since the run began");
    runId = run.runId;
    snapshot = snap;
    carry = run.carry;
    startWork = run.nextWork ?? -1;
    const details = detailsOf(snap.papers.map((p) => p.doi));
    scopePapers = snap.papers.map((p) => details.get(p.doi)).filter((p): p is ScopePaper => p !== undefined);
    candidateStats = snap.selection;
    if (snap.candidateIds !== null) {
      // Query mode: the candidates captured at the start, never a recomputed (corpus-dependent) BM25 list.
      const sel = db.prepare("SELECT doi, chunk_index, chunk_id, revision, char_start, char_end, content_hash, text FROM chunks WHERE chunk_id = ?");
      all = snap.candidateIds.flatMap((id) => {
        const r = sel.get(id) as { doi: string; chunk_index: number; chunk_id: string; revision: string; char_start: number; char_end: number; content_hash: string; text: string } | undefined;
        return r === undefined ? [] : [{ doi: r.doi, chunkIndex: r.chunk_index, chunkId: r.chunk_id, revision: r.revision, start: r.char_start, end: r.char_end, text: r.text, hash: r.content_hash }];
      });
    } else {
      all = selectCandidates(db, snap.papers.map((p) => p.doi), null).flatMap((p) => p.candidates);
    }
  } else {
    const sourceReport: SourceReport = [];
    await prepareSources(ctx, db, selected, cfg, sourceReport);
    for (const p of selected) {
      const src = getSource(db, p.doi);
      if (src?.status === "ready") ensureChunks(db, p.doi, cfg.chunking);
    }
    const ready: ScopePaper[] = [];
    for (const p of selected) {
      const src = getSource(db, p.doi);
      if (src?.status === "ready") ready.push(p);
      else if (!sourceReport.some((r) => r.doi === p.doi)) {
        sourceReport.push({ doi: p.doi, citekey: p.citekey, status: src?.status ?? "metadata_only", code: src?.failureCode ?? null, detail: src?.failureDetail ?? null });
      }
    }
    scopePapers = ready;
    const identity = ready.length > 0 ? await identityOf() : null;
    const perPaper = selectCandidates(db, ready.map((p) => p.doi), query);
    all = perPaper.flatMap((p) => p.candidates);
    candidateStats = perPaper.map((p) => ({ doi: p.doi, chunksTotal: p.chunksTotal, matched: p.matched, selected: p.candidates.length }));
    snapshot = {
      mode: query === null ? "registry" : "query",
      query,
      requested,
      papers: ready.map((p) => {
        const src = getSource(db, p.doi)!;
        return { doi: p.doi, revision: src.revision!, policy: src.chunkPolicy ?? policy };
      }),
      scopeKey,
      selected: selected.length,
      candidateIds: query === null ? null : all.map((c) => c.chunkId),
      selection: candidateStats,
      engine: engineName,
      model: identity?.model ?? null,
      protocol: identity?.protocol ?? "unidentified",
      minConfidence: bar,
    };
    carry = { unavailable: sourceReport, unresolved, staleDropped: 0 };
    runId = randomBytes(8).toString("hex");
    const created = { runId, snapshot, carry };
    await ctx.queue.runExclusive(() => createRun(db, created.runId, req.claim, created.snapshot, created.carry, ctx.now()));
  }
  const byDoi = new Map(scopePapers.map((p) => [p.doi, p]));
  const effective = effectiveOf(snapshot);
  const evidenceIdentity = effective ?? { model: `unidentified:${engineName}`, protocol: snapshot.protocol };
  const citekeyOf = (doi: string): string => byDoi.get(doi)?.citekey ?? doi;

  // ── stage 1: judge candidate chunks ──────────────────────────────────────
  let interruption: JudgeResult["interruption"] = null;
  let checked = 0;
  let fresh = 0;
  let cached = 0;
  let unchecked = 0;
  let nextWork: number | null = null;
  const evidenceRows: EvidenceRow[] = [];
  let localizationFresh = 0;

  if (startWork !== -1 && all.length > startWork) {
    const slice = all.slice(startWork);
    const s1 = await judge(effective, slice.map((c) => ({ text: c.text, hash: c.hash })));
    if (s1.interruption?.reason === "engine_failure" && s1.scores.size === 0) {
      return refuse("VERIFY_ENGINE_MISSING", `${s1.interruption.detail}`);
    }
    interruption = s1.interruption;
    fresh = s1.fresh;
    cached = s1.cached;
    unchecked = s1.unchecked.length;
    checked = slice.length - unchecked;
    const firstUnchecked = slice.findIndex((c) => s1.unchecked.includes(c.hash));
    nextWork = firstUnchecked === -1 ? null : startWork + firstUnchecked;

    // ── stage 2: localize supported chunks to excerpt-sized passages ───────
    const supportedChunks = slice.filter((c) => {
      const p = s1.scores.get(c.hash);
      return p !== undefined && isSupported(p, bar);
    });
    const sub = new Map<string, { text: string; hash: string }>();
    const plan = supportedChunks.map((c) => {
      const parts = localizePassages({ start: c.start, text: c.text });
      const single = parts.length === 1 && parts[0].text === c.text;
      const items = parts.map((p) => ({ ...p, hash: passageHashOf(p.text) }));
      if (!single) for (const it of items) sub.set(it.hash, { text: it.text, hash: it.hash });
      return { chunk: c, items, single };
    });
    let s2: JudgeResult | null = null;
    if (sub.size > 0) {
      s2 = await judge(effective, [...sub.values()]);
      localizationFresh = s2.fresh;
      interruption ??= s2.interruption === null ? null : { reason: s2.interruption.reason, detail: `while localizing supported passages: ${s2.interruption.detail}` };
    }
    const sources = new Map<string, ReturnType<typeof getSourceText>>();
    const pageFor = (doi: string, offset: number): number | null => {
      if (!sources.has(doi)) sources.set(doi, getSourceText(db, doi));
      return pageOf(sources.get(doi)?.pageStarts ?? null, offset);
    };
    const rowOf = (c: Candidate, start: number, end: number, pTrue: number, page: number | null): EvidenceRow => ({
      doi: c.doi, revision: c.revision, start, end, page, chunkId: c.chunkId, model: evidenceIdentity.model, protocol: evidenceIdentity.protocol, minConfidence: bar, pTrue,
    });
    for (const { chunk, items, single } of plan) {
      const chunkScore = s1.scores.get(chunk.hash)!;
      if (single) {
        evidenceRows.push(rowOf(chunk, chunk.start, chunk.end, chunkScore, pageFor(chunk.doi, chunk.start)));
        continue;
      }
      // Unfinished localization is unfinished WORK, not evidence: the chunk is re-checked on continuation
      // (its completed judgments are free) instead of being reported as a misleading chunk-scale pointer.
      if (items.some((it) => s2?.scores.get(it.hash) === undefined)) {
        const idx = startWork + slice.indexOf(chunk);
        nextWork = nextWork === null ? idx : Math.min(nextWork, idx);
        continue;
      }
      let localized = 0;
      for (const it of items) {
        const sc = s2!.scores.get(it.hash)!;
        if (isSupported(sc, bar)) {
          localized++;
          evidenceRows.push(rowOf(chunk, it.start, it.end, sc, pageFor(chunk.doi, it.start)));
        }
      }
      // Support the engine found only at chunk scale: report the exact chunk span, pointer-only.
      if (localized === 0) evidenceRows.push(rowOf(chunk, chunk.start, chunk.end, chunkScore, pageFor(chunk.doi, chunk.start)));
    }
  } else if (startWork === -1) {
    // a run whose work is already complete: only output remains
    checked = all.length;
  }

  // ── persist (freshness-checked), then deliver exactly once ───────────────
  const staleDropped = evidenceRows.length === 0 ? 0 : await ctx.queue.runExclusive(() => saveEvidence(db, runId, evidenceRows, ctx.now()));
  carry = { ...carry, staleDropped: carry.staleDropped + staleDropped };
  if (continuing || all.length > 0 || staleDropped > 0) await ctx.queue.runExclusive(() => setRunState(db, runId, nextWork, carry));

  const stored = evidenceOfRun(db, runId);
  const delivered = stored.filter((e) => e.releasedChars !== null);
  const pending = stored.filter((e) => e.releasedChars === null);
  const prior: PriorDelivery = new Map();
  for (const e of delivered) {
    const p = prior.get(e.doi) ?? prior.set(e.doi, { released: 0, spans: [] }).get(e.doi)!;
    p.released += e.releasedChars!;
    p.spans.push({ start: e.start, end: e.end });
  }
  const withText: SupportedPassage[] = pending.flatMap((e) => {
    const src = getSourceText(db, e.doi);
    if (src === null || src.revision !== e.revision) return [];
    return [{ doi: e.doi, citekey: e.citekey, revision: e.revision, chunkId: e.chunkId, start: e.start, end: e.end, page: e.page, pTrue: e.pTrue, text: src.text.slice(e.start, e.end) }];
  });
  const lengths = new Map<string, number>();
  const lengthOf = (doi: string): number => (lengths.get(doi) ?? lengths.set(doi, getSourceText(db, doi)?.text.length ?? 0).get(doi)!);
  const contained = containEvidence(withText, lengthOf, prior);
  const storedBy = new Map(stored.map((e) => [`${e.doi}|${e.start}|${e.end}`, e]));

  const page: ContainedEvidence[] = [];
  let chars = 0;
  for (const e of contained) {
    const len = e.excerpt?.length ?? 0;
    if (page.length >= MAX_EVIDENCE_PER_PAGE || (page.length > 0 && chars + len > MAX_PAGE_EXCERPT_CHARS)) break;
    page.push(e);
    chars += len;
  }
  await ctx.queue.runExclusive(() => markDelivered(db, runId, page.map((e) => ({ doi: e.doi, revision: e.revision, start: e.start, end: e.end, released: e.excerpt?.length ?? 0 }))));
  const outputRemaining = contained.length - page.length;
  const continuation = nextWork !== null || outputRemaining > 0 ? encodeToken(runId) : null;
  const available = delivered.length + contained.length;
  const withheldCount = delivered.filter((e) => e.releasedChars === 0).length + contained.filter((e) => e.excerpt === null).length;

  const evidence = page.map((e) => {
    const row = storedBy.get(`${e.doi}|${e.start}|${e.end}`)!;
    return {
      attested: true,
      doi: e.doi,
      citekey: e.citekey,
      title: row.title,
      citable: row.citable,
      pointer: formatPointer(e.doi, e.revision, e.start, e.end),
      revision: e.revision,
      span: { start: e.start, end: e.end, unit: "utf16" },
      page: e.page,
      chunkId: e.chunkId,
      excerpt: e.excerpt,
      withheld: e.withheld,
      localized: e.end - e.start <= EXCERPT_MAX_CHARS,
      judgment: { model: row.model, protocol: row.protocol, minConfidence: row.minConfidence, score: row.pTrue },
    };
  });

  // ── assemble ──────────────────────────────────────────────────────────────
  const noCandidates = candidateStats.filter((p) => p.matched === 0).map((p) => p.doi);
  const limitations: string[] = [];
  if (carry.unavailable.length > 0) limitations.push("sources_unavailable");
  if (carry.unavailable.some((u) => u.code === "deferred")) limitations.push("sources_deferred");
  if (carry.unresolved.length > 0) limitations.push("unresolved_scope");
  if (query !== null) limitations.push("query_limited");
  if (query !== null && (all.length === 0 || noCandidates.length > 0)) limitations.push("no_candidates");
  if (interruption !== null) limitations.push("interrupted");
  if (carry.staleDropped > 0) limitations.push("source_changed");
  if (outputRemaining > 0) limitations.push("output_paged");
  const workComplete = interruption === null && nextWork === null;
  const complete = workComplete && query === null && carry.unavailable.length === 0 && carry.unresolved.length === 0 && carry.staleDropped === 0;

  return {
    kind: "ok",
    result: {
      claim: req.claim,
      mode: query === null ? "registry" : "query",
      result: { supportFound: available > 0, searched: query === null ? "exhaustive" : "query_limited", complete, limitations },
      engine: { name: engineName, model: effective?.model ?? null, protocol: snapshot.protocol, minConfidence: bar, cache: effective !== null },
      coverage: {
        sources: { selected: snapshot.selected, ready: snapshot.papers.length, unavailable: carry.unavailable, unresolved: carry.unresolved },
        candidates: {
          total: all.length,
          perPaper: candidateStats.map((p) => ({ doi: p.doi, citekey: citekeyOf(p.doi), chunks: p.chunksTotal, matched: p.matched, selected: p.selected })),
        },
        work: { checked, fresh, cached, unchecked, localizationFresh, complete: workComplete, interruption },
        output: { available, returned: page.length, deliveredEarlier: delivered.length, withheld: withheldCount, staleDropped: carry.staleDropped },
      },
      evidence,
      continuation,
    },
  };
}

// ── source preparation ──────────────────────────────────────────────────────

/** Client policy: acquisitions (lookup + download + parse) attempted per call. Each can cost a download
 *  and seconds of parsing; the rest are reported as deferred and reached on the next call. */
export const MAX_ACQUISITIONS_PER_CALL = 20;

async function prepareSources(ctx: ToolContext, db: DatabaseSync, papers: ScopePaper[], cfg: ChunkConfig, report: SourceReport): Promise<void> {
  const state = new Map(papers.map((p) => [p.doi, getSource(db, p.doi)]));
  const candidates = papers.filter((p) => {
    const src = state.get(p.doi);
    if (src?.status === "ready") return false;
    // A recent failed ACQUISITION is not retried (a retry can cost a download). A failed local attach says
    // nothing about open-access availability, so it never throttles acquisition.
    if (src?.status === "failed" && src.kind !== "local-file" && Date.parse(src.preparedAt) > ctx.now().getTime() - RETRY_FAILED_AFTER_MS) return false;
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
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < need.length) {
      ctx.signal?.throwIfAborted();
      const p = need[next++];
      if (ctx.download === undefined) {
        report.push({ doi: p.doi, citekey: p.citekey, status: "unavailable", code: "acquisition_disabled" satisfies SourceFailureCode, detail: "this host provides no document download" });
        continue;
      }
      const got = await acquireSource({ fetch: ctx.fetch, download: ctx.download, cfg: providerConfigOf(ctx), signal: ctx.signal }, { doi: p.doi, title: p.title });
      if (got.ok) {
        const published = await ctx.queue.runExclusive(() => publishSource(db, p.doi, got.source, cfg.chunking, ctx.now()));
        if (published === null) report.push({ doi: p.doi, citekey: p.citekey, status: "unavailable", code: "no_open_copy", detail: "the paper was removed while its source was prepared" });
      } else {
        await ctx.queue.runExclusive(() => recordSourceFailure(db, p.doi, got.status, got.code, got.detail, ctx.now()));
        report.push({ doi: p.doi, citekey: p.citekey, status: got.status, code: got.code, detail: got.detail });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SOURCE_PREP_CONCURRENCY, need.length) }, lane));
  // Papers skipped by the retry policy keep their stored reason in the report.
  for (const p of papers) {
    const src = getSource(db, p.doi);
    if (src !== null && src.status !== "ready" && !report.some((r) => r.doi === p.doi)) {
      report.push({ doi: p.doi, citekey: p.citekey, status: src.status, code: src.failureCode, detail: src.failureDetail });
    }
  }
}

// ── direct passages ─────────────────────────────────────────────────────────

async function directWorkflow(
  ctx: ToolContext,
  db: DatabaseSync,
  req: VerifyRequest,
  cfg: ChunkConfig,
  identityOf: () => Promise<EngineIdentity | null>,
  judge: Judge,
): Promise<WorkflowOutcome> {
  const bar = cfg.verification.min_confidence;
  const windowChars = Math.floor(cfg.chunking.chunk_tokens * cfg.chunking.chars_per_token);
  type Item =
    | { kind: "registered"; index: number; status: string; pointer?: string; doi?: string; text?: string; revision?: string; start?: number; end?: number; page?: number | null }
    | { kind: "caller_supplied"; index: number; status: string; text?: string };
  const items: Item[] = (req.passages ?? []).map((p, index): Item => {
    if ("text" in p) return { kind: "caller_supplied", index, status: "judged", text: p.text };
    const r = resolvePointer(db, p.source);
    if (r.status !== "current") return { kind: "registered", index, status: r.status, pointer: p.source };
    if (!pointerIssued(db, r.doi, r.revision, r.start, r.end)) return { kind: "registered", index, status: "not_issued", pointer: p.source };
    if (r.end - r.start > windowChars) return { kind: "registered", index, status: "too_long", pointer: p.source };
    return { kind: "registered", index, status: "judged", pointer: p.source, doi: r.doi, text: r.text, revision: r.revision, start: r.start, end: r.end, page: r.page };
  });
  const judgeable = items.filter((i) => i.status === "judged");
  const identity = judgeable.length > 0 ? await identityOf() : null;
  const evidenceIdentity = identity ?? { model: `unidentified:${cfg.verification.engine}`, protocol: "unidentified" };
  let interruption: JudgeResult["interruption"] = null;
  let fresh = 0;
  let cached = 0;
  const scores = new Map<string, number>();
  if (judgeable.length > 0) {
    const out = await judge(identity, judgeable.map((i) => ({ text: i.text!, hash: passageHashOf(i.text!) })));
    if (out.interruption?.reason === "engine_failure" && out.scores.size === 0) return refuse("VERIFY_ENGINE_MISSING", out.interruption.detail);
    interruption = out.interruption;
    fresh = out.fresh;
    cached = out.cached;
    for (const [h, s] of out.scores) scores.set(h, s);
  }

  const supportedReg: SupportedPassage[] = [];
  const meta = new Map<string, ScopePaper>();
  const evidence: Record<string, unknown>[] = [];
  const rows: EvidenceRow[] = [];
  for (const it of items) {
    if (it.status !== "judged") continue;
    const s = scores.get(passageHashOf(it.text!));
    if (s === undefined || !isSupported(s, bar)) continue;
    if (it.kind === "caller_supplied") {
      evidence.push({
        attested: false,
        provenance: "caller_supplied_text",
        index: it.index,
        span: { start: 0, end: it.text!.length, unit: "utf16" },
        excerpt: it.text,
        judgment: { model: evidenceIdentity.model, protocol: evidenceIdentity.protocol, minConfidence: bar, score: s },
      });
    } else {
      const d = selectPapers(db, { dois: [it.doi!], limit: 1 })[0];
      meta.set(it.doi!, { doi: it.doi!, citekey: d.citekey, title: d.title, citable: d.citable });
      supportedReg.push({ doi: it.doi!, citekey: d.citekey, revision: it.revision!, chunkId: "direct", start: it.start!, end: it.end!, page: it.page ?? null, pTrue: s, text: it.text! });
      rows.push({ doi: it.doi!, revision: it.revision!, start: it.start!, end: it.end!, page: it.page ?? null, chunkId: "direct", model: evidenceIdentity.model, protocol: evidenceIdentity.protocol, minConfidence: bar, pTrue: s });
    }
  }
  let staleDropped = 0;
  if (rows.length > 0) {
    const runId = randomBytes(8).toString("hex");
    const snapshot: RunSnapshot = {
      mode: "direct", query: null, requested: "ids", papers: [], scopeKey: "direct", selected: 0, candidateIds: null, selection: [],
      engine: cfg.verification.engine, model: identity?.model ?? null, protocol: evidenceIdentity.protocol, minConfidence: bar,
    };
    const carry: RunCarry = { unavailable: [], unresolved: [], staleDropped: 0 };
    await ctx.queue.runExclusive(() => createRun(db, runId, req.claim, snapshot, carry, ctx.now()));
    staleDropped = await ctx.queue.runExclusive(() => saveEvidence(db, runId, rows, ctx.now()));
  }
  const lengthOf = (doi: string): number => getSourceText(db, doi)?.text.length ?? 0;
  const fresh_ok = supportedReg.filter((p) => getSourceText(db, p.doi)?.revision === p.revision);
  for (const e of containEvidence(fresh_ok, lengthOf)) {
    const row = rows.find((r) => r.doi === e.doi && r.start === e.start && r.end === e.end)!;
    const m = meta.get(e.doi)!;
    evidence.push({
      attested: true, doi: e.doi, citekey: m.citekey, title: m.title, citable: m.citable,
      pointer: formatPointer(e.doi, e.revision, e.start, e.end), revision: e.revision, span: { start: e.start, end: e.end, unit: "utf16" },
      page: e.page, chunkId: e.chunkId, excerpt: e.excerpt, withheld: e.withheld, localized: true,
      judgment: { model: row.model, protocol: row.protocol, minConfidence: row.minConfidence, score: row.pTrue },
    });
  }
  const limitations: string[] = ["direct_passages"];
  if (interruption !== null) limitations.push("interrupted");
  if (staleDropped > 0) limitations.push("source_changed");
  return {
    kind: "ok",
    result: {
      claim: req.claim,
      mode: "direct",
      result: { supportFound: evidence.length > 0, searched: "direct", complete: interruption === null && items.every((i) => i.status === "judged") && staleDropped === 0, limitations },
      engine: { name: cfg.verification.engine, model: identity?.model ?? null, protocol: evidenceIdentity.protocol, minConfidence: bar, cache: identity !== null },
      coverage: {
        sources: { selected: items.filter((i) => i.kind === "registered").length, ready: items.filter((i) => i.kind === "registered" && i.status === "judged").length, unavailable: [], unresolved: [] },
        candidates: { total: items.length, perPaper: [] },
        work: { checked: judgeable.length, fresh, cached, unchecked: 0, localizationFresh: 0, complete: interruption === null, interruption },
        output: { available: evidence.length, returned: evidence.length, deliveredEarlier: 0, withheld: evidence.filter((e) => e.excerpt === null).length, staleDropped },
      },
      evidence,
      direct: items.map((i) => ({ index: i.index, kind: i.kind, status: i.status, ...(i.kind === "registered" && i.pointer !== undefined ? { pointer: i.pointer } : {}) })),
      continuation: null,
    },
  };
}

