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

import { ConfigError, loadChunkConfig, type ChunkConfig } from "../config.ts";
import { selectPapers, type DatabaseSync } from "../registry.ts";
import type { RefusalCode } from "../refusals.ts";
import type { ToolContext } from "../tools/context.ts";
import { MAX_ACQUISITIONS_PER_CALL, RETRY_FAILED_AFTER_MS, SOURCE_PREP_CONCURRENCY, prepareSources } from "./acquire.ts";
export { MAX_ACQUISITIONS_PER_CALL, RETRY_FAILED_AFTER_MS, SOURCE_PREP_CONCURRENCY };
import type { ClaimEngine } from "./claim.ts";
import { createConfiguredEngine, gridBatchSizeOf, resolveEngineIdentityCached, type EngineIdentity } from "./engines.ts";
import { EXCERPT_MAX_CHARS, containEvidence, localizePassages, type ContainedEvidence, type PriorDelivery, type SupportedPassage } from "./evidence.ts";
import { isSupported, judgeClaimUnits, judgePassages, type GridResult, type JudgeResult } from "./judge.ts";
import { locatorTokens, selectCandidates, lexicalRank, UNITS_PER_PAPER_QUERY, type Candidate } from "./retrieve.ts";
import { TOP_K, topCandidates, unitPathFromEnv, verifySwitchFromEnv, type VerifyStrategy } from "./strategy.ts";
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
  parsePointer,
  passageHashOf,
  resolvePointer,
  saveEvidence,
  setRunState,
  markDelivered,
  pointerIssued,
  claimHashOf,
  unitIdOf,
  SECTION_CHUNKING_VERSION,
  type EvidenceRow,
  type RunCarry,
  type RunSnapshot,
} from "./store.ts";
import { SECTION_UNIT_MAX_CHARS } from "./paper-units.ts";
import { foldRankedToUnits, loadPaperUnits, unitCandidates, type LoadedPaperUnits } from "./unit-select.ts";

/** Client policy: rows per engine call — bounds how long a cancellation waits. */
export const JUDGE_BATCH_SIZE = 8;
/** Client policy: evidence records per response, and excerpt characters per response (≈ 3k tokens). */
export const MAX_EVIDENCE_PER_PAGE = 20;
export const MAX_PAGE_EXCERPT_CHARS = 12_000;

export interface WorkflowHooks {
  createEngine?: (engineName: string) => ClaimEngine;
  /** Fetch used for the engine-identity probe (tests inject; production uses global fetch). */
  fetchImpl?: typeof fetch;
  /** Judging-unit cap for the unit path (a bench-only knob; default SECTION_UNIT_MAX_CHARS). */
  unitMaxChars?: number;
  /** Annotated checking always uses the unit path through this hook (not env, not config, not a schema field). */
  unitPath?: boolean;
}

/** Primed page grids (V5a document mode): round 1 judges every claim over its
 *  paper units; round 2 judges localization windows of supported units plus
 *  the "all" rechecks of claims no cited paper supports. */
export interface PrimeSession {
  round1: GridResult;
  round2: GridResult;
  /** Annotated replay guard: claimHash → unit hashes the replay may serve (absent = unguarded). */
  only?: Map<string, Set<string>>;
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

/** The token only names the run and its path version; everything else (what was delivered, where the work stopped) lives with the run.
 *  v3: chunk runs freeze their candidate order at creation; v4: unit runs freeze pointer candidates.
 *  Older versions (whose top-10 order was never captured) are refused. */
const encodeToken = (runId: string, version: 3 | 4): string => Buffer.from(JSON.stringify({ v: version, r: runId })).toString("base64url");

function decodeToken(token: string): { runId: string; version: number } | null {
  try {
    const t = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { v?: number; r?: unknown };
    return (t.v === 3 || t.v === 4) && typeof t.r === "string" ? { runId: t.r, version: t.v } : null;
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

// ── setup (shared by the claim entry and the document prime) ────────────────

export interface VerifySetup {
  cfg: ChunkConfig;
  engineName: string;
  getEngine: () => ClaimEngine;
  identityOf: () => Promise<EngineIdentity | null>;
  /** Judging-unit cap for the unit path. */
  cap: number;
}

/** Config, engine and identity for one call (throws ConfigError like the entry). */
export function loadVerifySetup(ctx: ToolContext, hooks: WorkflowHooks): VerifySetup {
  const cfg = loadChunkConfig(ctx.root, { env: ctx.env });
  const engineName = cfg.verification.engine;
  const fetchImpl = hooks.fetchImpl ?? (ctx.fetch as unknown as typeof fetch);
  const getEngine = once(() => (hooks.createEngine ? hooks.createEngine(engineName) : createConfiguredEngine(ctx.env, engineName, { fetchImpl })));
  const identityOf = async (): Promise<EngineIdentity | null> => resolveEngineIdentityCached(ctx.env, engineName, { fetchImpl });
  return { cfg, engineName, getEngine, identityOf, cap: hooks.unitMaxChars ?? SECTION_UNIT_MAX_CHARS };
}

// ── entry ───────────────────────────────────────────────────────────────────

export async function verifyWorkflow(ctx: ToolContext, db: DatabaseSync, req: VerifyRequest, hooks: WorkflowHooks, session?: PrimeSession): Promise<WorkflowOutcome> {
  let setup: VerifySetup;
  try {
    setup = loadVerifySetup(ctx, hooks);
  } catch (err) {
    if (err instanceof ConfigError) return refuse("CONFIG_INVALID", err.message);
    throw err;
  }
  const { cfg, engineName, getEngine, identityOf, cap: unitCap } = setup;
  const unitPath = hooks.unitPath ?? unitPathFromEnv(ctx.env);
  const baseJudge = (identity: EngineIdentity | null, passages: { text: string; hash: string }[]): Promise<JudgeResult> =>
    unitPath
      ? judgeClaimUnits(
          {
            db,
            queue: ctx.queue,
            now: ctx.now,
            identity,
            createEngine: getEngine,
            workers: cfg.verification.workers,
            batchSize: gridBatchSizeOf(engineName),
            maxFresh: cfg.verification.max_judgments,
            signal: ctx.signal,
          },
          req.claim,
          passages,
        )
      : judgePassages(
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
  const judge = session !== undefined && unitPath ? sessionJudge(session, req.claim, baseJudge) : baseJudge;

  if (req.passages !== undefined) return directWorkflow(ctx, db, req, cfg, identityOf, baseJudge);
  return registryWorkflow(ctx, db, req, cfg, engineName, identityOf, judge, unitPath, unitCap, session);
}

/**
 * A primed page's judge: scores the grid already holds are served (scored if
 * known; unchecked if the grid left the cell unscored); anything the prime
 * never covered falls back to a real grid judgment.
 */
function sessionJudge(session: PrimeSession, claim: string, base: Judge): Judge {
  return async (identity, passages) => {
    const claimHash = claimHashOf(claim);
    const scoreOf = (hash: string): number | undefined => session.round1.scores.get(claimHash)?.get(hash) ?? session.round2.scores.get(claimHash)?.get(hash);
    const primedUnchecked = (hash: string): boolean =>
      session.round1.unchecked.some((u) => u.claimHash === claimHash && u.hash === hash) ||
      session.round2.unchecked.some((u) => u.claimHash === claimHash && u.hash === hash);
    const scores = new Map<string, number>();
    const unchecked: string[] = [];
    const miss: { text: string; hash: string }[] = [];
    for (const p of passages) {
      const s = scoreOf(p.hash);
      if (s !== undefined) scores.set(p.hash, s);
      else if (primedUnchecked(p.hash)) unchecked.push(p.hash);
      else miss.push(p);
    }
    if (miss.length === 0) {
      return {
        scores,
        cached: 0,
        fresh: 0,
        unchecked,
        interruption: unchecked.length > 0 ? { reason: "engine_failure", detail: "the primed page check left passages unscored" } : null,
      };
    }
    const fb = await base(identity, miss);
    for (const [h, s] of fb.scores) scores.set(h, s);
    unchecked.push(...fb.unchecked);
    return {
      scores,
      cached: fb.cached,
      fresh: fb.fresh,
      unchecked,
      interruption: fb.interruption ?? (unchecked.length > fb.unchecked.length ? { reason: "engine_failure", detail: "the primed page check left passages unscored" } : null),
    };
  };
}

type Judge = (identity: EngineIdentity | null, passages: { text: string; hash: string }[]) => Promise<JudgeResult>;

// ── adopted strategy: narrow the exhaustive candidate list ────────────────

interface Narrowed {
  units: Candidate[];
  stats: RunSnapshot["selection"];
}

/**
 * Unit-path candidate selection (V4): explicit lists (no query) judge all
 * non-reference units exhaustively on any engine; "all" without a query judges
 * the BM25 top-10 units (candidate_limited); a locator query judges the top 3
 * units per paper (query_limited); a claim with no searchable words under
 * "all" falls back to exhaustive. Frozen "all"/query candidates are pointers.
 */
export function newUnitSelection(
  db: DatabaseSync,
  ready: ScopePaper[],
  requested: "all" | "ids",
  query: string | null,
  claim: string,
  cap: number,
): { stats: RunSnapshot["selection"]; limited: boolean; candidates: Candidate[]; candidateIds: string[] | null; excluded: { doi: string; count: number }[] } {
  const loaded = new Map<string, LoadedPaperUnits>();
  for (const p of ready) {
    const l = loadPaperUnits(db, p.doi, cap);
    if (l !== null) loaded.set(p.doi, l);
  }
  const excluded = [...loaded].filter(([, l]) => l.excluded > 0).map(([doi, l]) => ({ doi, count: l.excluded }));
  const unitsOf = (doi: string) => loaded.get(doi)?.units ?? [];
  const orderOf = new Map(ready.map((p, i) => [p.doi, i]));
  const inReadingOrder = <T extends { doi: string; unit: { start: number } }>(list: T[]): T[] =>
    [...list].sort((a, b) => (orderOf.get(a.doi) ?? 0) - (orderOf.get(b.doi) ?? 0) || a.unit.start - b.unit.start);

  const exhaustive = (): { stats: RunSnapshot["selection"]; limited: boolean; candidates: Candidate[]; candidateIds: string[] | null } => {
    const candidates: Candidate[] = [];
    const stats: RunSnapshot["selection"] = [];
    for (const p of ready) {
      const paperUnits = unitsOf(p.doi);
      candidates.push(...unitCandidates(p.doi, loaded.get(p.doi)?.revision ?? "", cap, paperUnits, candidates.length));
      stats.push({ doi: p.doi, chunksTotal: paperUnits.length, matched: paperUnits.length, selected: paperUnits.length });
    }
    return { stats, limited: false, candidates, candidateIds: null };
  };

  // BM25 still runs over chunk_fts: ask for the chunk count of the selected
  // papers, then fold the ranked chunk starts to units.
  const chunkTotal =
    ready.length === 0
      ? 0
      : Number((db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE doi IN (${ready.map(() => "?").join(",")})`).get(...ready.map((p) => p.doi)) as { n: number }).n);
  const buildRanked = (rankQuery: string, cut: { perPaper?: number; top?: number }): { stats: RunSnapshot["selection"]; candidates: Candidate[]; candidateIds: string[] } => {
    const ranked = lexicalRank(db, [...loaded.keys()], rankQuery, chunkTotal);
    const starts = ranked.map((r) => ({ doi: r.doi, start: r.start }));
    const uncut = foldRankedToUnits(starts, unitsOf);
    const cutFolded = inReadingOrder(foldRankedToUnits(starts, unitsOf, cut));
    const matched = new Map<string, number>();
    for (const f of uncut) matched.set(f.doi, (matched.get(f.doi) ?? 0) + 1);
    const candidates: Candidate[] = [];
    const stats: RunSnapshot["selection"] = [];
    for (const p of ready) {
      const paperUnits = cutFolded.filter((f) => f.doi === p.doi).map((f) => f.unit);
      candidates.push(...unitCandidates(p.doi, loaded.get(p.doi)?.revision ?? "", cap, paperUnits, candidates.length));
      stats.push({ doi: p.doi, chunksTotal: unitsOf(p.doi).length, matched: matched.get(p.doi) ?? 0, selected: paperUnits.length });
    }
    return { stats, candidates, candidateIds: candidates.map((c) => formatPointer(c.doi, c.revision, c.start, c.end)) };
  };

  if (query !== null) {
    const r = buildRanked(query, { perPaper: UNITS_PER_PAPER_QUERY });
    return { ...r, limited: false, excluded };
  }
  if (requested === "ids" || locatorTokens(claim).length === 0) {
    return { ...exhaustive(), excluded };
  }
  const r = buildRanked(claim, { top: TOP_K });
  return { ...r, limited: true, excluded };
}

/**
 * Narrow `all` (the exhaustive candidates) to the strategy's top-K judge
 * units. A claim with no searchable words cannot be pre-filtered: null falls
 * back to exhaustive (checked, never skipped). Ranking is deterministic, but
 * a continuation never re-narrows: the first call freezes the narrowed order
 * in the run, and later calls replay it.
 */
function narrowCandidates(db: DatabaseSync, all: Candidate[], claim: string, strategy: VerifyStrategy): Narrowed | null {
  if (locatorTokens(claim).length === 0) return null;
  if (strategy !== "top10") return null;
  const dois = [...new Set(all.map((c) => c.doi))].sort();
  const ranked = lexicalRank(db, dois, claim, TOP_K);
  const units = topCandidates(all, ranked.map((r) => r.chunkId));
  const totals = new Map<string, number>();
  for (const c of all) totals.set(c.doi, (totals.get(c.doi) ?? 0) + 1);
  const matched = new Map<string, number>();
  for (const r of ranked) matched.set(r.doi, (matched.get(r.doi) ?? 0) + 1);
  const selected = new Map<string, number>();
  for (const u of units) selected.set(u.doi, (selected.get(u.doi) ?? 0) + 1);
  return { units, stats: dois.map((doi) => ({ doi, chunksTotal: totals.get(doi) ?? 0, matched: matched.get(doi) ?? 0, selected: selected.get(doi) ?? 0 })) };
}

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
  unitPath: boolean,
  unitCap: number,
  session?: PrimeSession,
): Promise<WorkflowOutcome> {
  const bar = cfg.verification.min_confidence;
  const policy = chunkPolicyOf(cfg.chunking);
  const query = req.query !== undefined && req.query.trim().length > 0 ? req.query : null;
  if (query !== null && locatorTokens(query).length === 0) {
    return refuse("ARGUMENT_INVALID", "the locator query has no searchable words; use words or numbers, or omit the query to check every passage");
  }
  const requested: "all" | "ids" = req.papers === "all" ? "all" : "ids";

  // The requested selection, resolved NOW: used to key a new run and to check a continuation against it.
  // The applicable candidate strategy is part of that identity: switching
  // top10/exhaustive between calls would judge a different list, so the
  // continuation is refused before any judgment. Query mode never applies
  // the strategy, so its key ignores the override.
  const { selected, unresolved } = resolveScope(db, req.papers);
  const strategy = verifySwitchFromEnv(ctx.env, engineName);
  const baseKey = requested === "all" ? "all" : digest12(`${selected.map((p) => p.doi).sort().join(",")}|${unresolved.map((u) => u.handle).sort().join(",")}`);
  // The unit path judges different candidates than the chunk path; non-query
  // runs name it in the scope key (query mode's key ignores the strategy).
  const scopeKey = query === null ? `${baseKey}|strategy:${unitPath ? "units" : strategy}` : baseKey;

  const detailsOf = (dois: string[]): Map<string, ScopePaper> =>
    new Map(selectPapers(db, { dois, limit: Math.max(1, dois.length) }).map((p) => [p.doi, { doi: p.doi, citekey: p.citekey, title: p.title, citable: p.citable }]));

  let runId: string;
  let snapshot: RunSnapshot;
  let carry: RunCarry;
  let startWork = 0;
  let scopePapers: ScopePaper[] = [];
  const continuing = req.continuation !== undefined;
  let candidateStats: RunSnapshot["selection"];
  let candidateLimited: boolean;
  let units: Candidate[];

  const effectiveOf = (snap: RunSnapshot): EngineIdentity | null => (snap.model === null ? null : { model: snap.model, protocol: snap.protocol });

  if (continuing) {
    const token = decodeToken(req.continuation!);
    const run = token === null ? null : getRun(db, token.runId, ctx.now());
    if (token === null || run === null) return refuse("CONTINUATION_INVALID", "the continuation is not a live token this tool issued (it may have expired)");
    const snap = run.snapshot;
    if (run.claimHash !== claimHashOf(req.claim) || snap.mode === "direct" || snap.requested !== requested || snap.query !== query || snap.scopeKey !== scopeKey) {
      return refuse("CONTINUATION_INVALID", "the continuation was issued for a different claim, scope, locator query or candidate strategy");
    }
    // The token version must agree with the snapshot's path (and the run's
    // unit cap): v3 under units, v4 without, or a changed cap is refused
    // before any judgment.
    if (unitPath) {
      if (token.version !== 4 || snap.unitPolicy === undefined) {
        return refuse("CONTINUATION_INVALID", "the continuation was issued for a different claim, scope, locator query or candidate strategy");
      }
      if (unitCap !== snap.unitPolicy.maxChars) {
        return refuse("CONTINUATION_INVALID", "the judging-unit cap changed since the run began; repeat the request without a continuation");
      }
    } else if (token.version !== 3 || snap.unitPolicy !== undefined) {
      return refuse("CONTINUATION_INVALID", "the continuation was issued for a different claim, scope, locator query or candidate strategy");
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
    if ((identity?.protocol ?? "unidentified") !== snap.protocol) return refuse("CONTINUATION_INVALID", "the decision protocol changed since the run began");
    runId = run.runId;
    snapshot = snap;
    carry = run.carry;
    startWork = run.nextWork ?? -1;
    const details = detailsOf(snap.papers.map((p) => p.doi));
    scopePapers = snap.papers.map((p) => details.get(p.doi)).filter((p): p is ScopePaper => p !== undefined);
    candidateStats = snap.selection;
    const savedIds: unknown = snap.candidateIds;
    if (savedIds !== null) {
      // The run froze its candidates at creation: replay them in saved order,
      // never recompute them. A missing or unreadable entry is refused, not
      // skipped: skipping would silently shift every later work index.
      if (!Array.isArray(savedIds) || savedIds.some((id) => typeof id !== "string" || id.length === 0)) {
        return refuse("CONTINUATION_INVALID", "the run's saved candidates are unreadable; repeat the request without a continuation");
      }
      if (snap.unitPolicy !== undefined) {
        // Unit runs freeze pointers: re-resolve each against its paper's
        // current revision (the revision guard above already pins it).
        const frozen: Candidate[] = [];
        for (const [ordinal, id] of savedIds.entries()) {
          const p = parsePointer(id);
          const src = p === null ? null : getSourceText(db, p.doi);
          if (p === null || src === null || src.revision !== p.revision || p.start < 0 || p.end > src.text.length) {
            return refuse("CONTINUATION_INVALID", "a passage saved with the run is no longer in the registry; repeat the request without a continuation");
          }
          const slice = src.text.slice(p.start, p.end);
          frozen.push({ doi: p.doi, chunkIndex: ordinal, chunkId: unitIdOf(p.doi, p.revision, snap.unitPolicy.maxChars, p.start, p.end), revision: p.revision, start: p.start, end: p.end, text: slice, hash: passageHashOf(slice) });
        }
        candidateLimited = query === null;
        units = frozen;
      } else {
        const sel = db.prepare("SELECT doi, chunk_index, chunk_id, revision, char_start, char_end, content_hash, text FROM chunks WHERE chunk_id = ?");
        const frozen: Candidate[] = [];
        for (const id of savedIds) {
          const r = sel.get(id) as { doi: string; chunk_index: number; chunk_id: string; revision: string; char_start: number; char_end: number; content_hash: string; text: string } | undefined;
          if (r === undefined) {
            return refuse("CONTINUATION_INVALID", "a passage saved with the run is no longer in the registry; repeat the request without a continuation");
          }
          frozen.push({ doi: r.doi, chunkIndex: r.chunk_index, chunkId: r.chunk_id, revision: r.revision, start: r.char_start, end: r.char_end, text: r.text, hash: r.content_hash });
        }
        // A frozen non-query list is the limited strategy's capture; a frozen
        // query list stays query-limited (the strategy never applies to it).
        candidateLimited = query === null;
        units = frozen;
      }
    } else if (snap.unitPolicy !== undefined) {
      // An exhaustive unit run freezes nothing: reload the current units
      // (the revision and cap guards above pin them).
      candidateLimited = false;
      units = [];
      for (const p of snap.papers) {
        const loaded = loadPaperUnits(db, p.doi, snap.unitPolicy.maxChars);
        if (loaded !== null) units.push(...unitCandidates(p.doi, loaded.revision, snap.unitPolicy.maxChars, loaded.units, units.length));
      }
    } else {
      candidateLimited = false;
      units = selectCandidates(db, snap.papers.map((p) => p.doi), query).flatMap((p) => p.candidates);
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
    if (unitPath) {
      const sel = newUnitSelection(db, ready, requested, query, req.claim, unitCap);
      candidateStats = sel.stats;
      candidateLimited = sel.limited;
      // Annotated replay guard: the prime judged only these unit hashes for
      // this claim (identical normalized wording shares the claimHash entry),
      // so the replay serves primed scores and never sends an unprimed cell.
      const onlySet = session?.only?.get(claimHashOf(req.claim));
      units = onlySet === undefined ? sel.candidates : sel.candidates.filter((c) => onlySet.has(c.hash));
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
        candidateIds: sel.candidateIds,
        selection: candidateStats,
        engine: engineName,
        model: identity?.model ?? null,
        protocol: identity?.protocol ?? "unidentified",
        minConfidence: bar,
        unitPolicy: { maxChars: unitCap, chunking: SECTION_CHUNKING_VERSION },
      };
      carry = { unavailable: sourceReport, unresolved, staleDropped: 0, excluded: sel.excluded };
    } else {
      const perPaper = selectCandidates(db, ready.map((p) => p.doi), query);
      const all = perPaper.flatMap((p) => p.candidates);
      candidateStats = perPaper.map((p) => ({ doi: p.doi, chunksTotal: p.chunksTotal, matched: p.matched, selected: p.candidates.length }));
      // Freeze the strategy's narrowed order with the run: continuations replay
      // these ids in this order and never re-rank. Exhaustive stays null (with
      // its source revision and policy guard); a narrowing that cannot rank
      // falls back to exhaustive and still reports exhaustive honestly.
      const narrowed = strategy !== "exhaustive" && query === null ? narrowCandidates(db, all, req.claim, strategy) : null;
      candidateLimited = narrowed !== null;
      units = narrowed === null ? all : narrowed.units;
      if (narrowed !== null) candidateStats = narrowed.stats;
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
        candidateIds: query === null ? (narrowed === null ? null : narrowed.units.map((c) => c.chunkId)) : all.map((c) => c.chunkId),
        selection: candidateStats,
        engine: engineName,
        model: identity?.model ?? null,
        protocol: identity?.protocol ?? "unidentified",
        minConfidence: bar,
      };
      carry = { unavailable: sourceReport, unresolved, staleDropped: 0 };
    }
    runId = randomBytes(8).toString("hex");
    const created = { runId, snapshot, carry };
    await ctx.queue.runExclusive(() => createRun(db, created.runId, req.claim, created.snapshot, created.carry, ctx.now()));
  }
  const byDoi = new Map(scopePapers.map((p) => [p.doi, p]));
  // Adopted strategy (hosted only): the hosted engine judges the top-10
  // retrieval candidates per claim; a locator query already limits
  // candidates, so the strategy only narrows the otherwise-exhaustive path.
  // `units` and `candidateLimited` come from the run above: a new run narrows
  // then freezes, a continuation replays the freeze.
  const effective = effectiveOf(snapshot);
  const evidenceIdentity = effective ?? { model: `unidentified:${engineName}`, protocol: snapshot.protocol };
  const citekeyOf = (doi: string): string => byDoi.get(doi)?.citekey ?? doi;

  // ── stage 1: judge candidate chunks ─────────────────────────────────────
  let interruption: JudgeResult["interruption"] = null;
  let checked = 0;
  let fresh = 0;
  let cached = 0;
  let unchecked = 0;
  let nextWork: number | null = null;
  const evidenceRows: EvidenceRow[] = [];
  let localizationFresh = 0;

  if (startWork !== -1 && units.length > startWork) {
    const slice = units.slice(startWork);
    const s1 = await judge(effective, slice.map((c) => ({ text: c.text, hash: c.hash })));
    // A primed page reports zero-success at the page level, never per claim:
    // a claim with no primed score is incomplete, not a refusal.
    if (s1.interruption?.reason === "engine_failure" && s1.scores.size === 0 && session === undefined) {
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
    const supportedChunks = slice.filter((u) => {
      const p = s1.scores.get(u.hash);
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
      localizationFresh += s2.fresh;
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
        const idx = startWork + slice.findIndex((u) => u.hash === chunk.hash);
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
    checked = units.length;
  }

  // ── persist (freshness-checked), then deliver exactly once ───────────────
  const staleDropped = evidenceRows.length === 0 ? 0 : await ctx.queue.runExclusive(() => saveEvidence(db, runId, evidenceRows, ctx.now()));
  carry = { ...carry, staleDropped: carry.staleDropped + staleDropped };
  if (continuing || units.length > 0 || staleDropped > 0) await ctx.queue.runExclusive(() => setRunState(db, runId, nextWork, carry));

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
  await ctx.queue.runExclusive(() => markDelivered(db, runId, page.map((e) => ({ doi: e.doi, revision: e.revision, start: e.start, end: e.end, released: e.excerpt?.length ?? 0 })), { claim: req.claim, now: ctx.now() }));
  const outputRemaining = contained.length - page.length;
  const continuation = nextWork !== null || outputRemaining > 0 ? encodeToken(runId, snapshot.unitPolicy !== undefined ? 4 : 3) : null;
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
  const excludedTotal = (carry.excluded ?? []).reduce((n, e) => n + e.count, 0);
  const limitations: string[] = [];
  if (carry.unavailable.length > 0) limitations.push("sources_unavailable");
  if (carry.unavailable.some((u) => u.code === "deferred")) limitations.push("sources_deferred");
  if (carry.unresolved.length > 0) limitations.push("unresolved_scope");
  if (query !== null) limitations.push("query_limited");
  // A limited strategy checks retrieval-selected candidates, never exhaustively: said plainly, always.
  if (candidateLimited) limitations.push("candidate_limited");
  if (query !== null && (units.length === 0 || noCandidates.length > 0)) limitations.push("no_candidates");
  if (candidateLimited && units.length === 0) limitations.push("no_candidates");
  if (excludedTotal > 0) limitations.push("references_not_checked");
  if (interruption !== null) limitations.push("interrupted");
  if (carry.staleDropped > 0) limitations.push("source_changed");
  if (outputRemaining > 0) limitations.push("output_paged");
  const workComplete = interruption === null && nextWork === null;
  const complete = workComplete && !candidateLimited && query === null && carry.unavailable.length === 0 && carry.unresolved.length === 0 && carry.staleDropped === 0;

  return {
    kind: "ok",
    result: {
      claim: req.claim,
      mode: query === null ? "registry" : "query",
      result: { supportFound: available > 0, searched: query === null ? (candidateLimited ? "candidate_limited" : "exhaustive") : "query_limited", complete, limitations },
      engine: { name: engineName, model: effective?.model ?? null, protocol: snapshot.protocol, minConfidence: bar, cache: effective !== null },
      coverage: {
        sources: { selected: snapshot.selected, ready: snapshot.papers.length, unavailable: carry.unavailable, unresolved: carry.unresolved, preprint: snapshot.papers.filter((p) => getSource(db, p.doi)?.kind === "arxiv-preprint-pdf").map((p) => citekeyOf(p.doi)) },
        candidates: {
          total: units.length,
          ...(snapshot.unitPolicy !== undefined ? { excluded: excludedTotal } : {}),
          perPaper: candidateStats.map((p) => ({
            doi: p.doi,
            citekey: citekeyOf(p.doi),
            ...(snapshot.unitPolicy !== undefined ? { units: p.chunksTotal } : { chunks: p.chunksTotal }),
            matched: p.matched,
            selected: p.selected,
          })),
        },
        work: { checked, fresh, cached, unchecked, localizationFresh, complete: workComplete, interruption },
        output: { available, returned: page.length, deliveredEarlier: delivered.length, withheld: withheldCount, staleDropped: carry.staleDropped },
      },
      evidence,
      continuation,
    },
  };
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
        sources: { selected: items.filter((i) => i.kind === "registered").length, ready: items.filter((i) => i.kind === "registered" && i.status === "judged").length, unavailable: [], unresolved: [], preprint: [] },
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

