/**
 * `verify` document mode: check the TEXT AS WRITTEN. Units come from the
 * product's own extractor (`provenance/units.ts` over the entry with its
 * includes expanded, or over a LaTeX fragment). Each unit is verified
 * verbatim through the single-claim workflow, so supported evidence is
 * released through the existing path and the ledger records the exact unit
 * text (provenance then shows `verified` while the wording is kept verbatim).
 *
 * Per unit: cited units are checked against their own cited papers; uncited
 * units against all registered papers. A unit whose check finds no support in
 * its own scope is checked once more against all papers: support elsewhere is
 * `missing-citation` (with the suggested citekeys), never silent.
 */
import { readFileSync } from "node:fs";
import { sep } from "node:path";

import { resolveEntry } from "../compile/run.ts";
import { DEFAULTS, loadChunkConfig } from "../config.ts";
import { expandSource, linesFromString, parsePaper, type Paper } from "../review/latex.ts";
import { auditProvenance, type UnitAudit } from "../provenance/audit.ts";
import { readProvenanceInputs } from "../provenance/read.ts";
import { collectResultLines } from "../provenance/results.ts";
import type { ResultLine } from "../provenance/audit.ts";
import type { Unit } from "../provenance/units.ts";
import { extractUnits } from "../provenance/units.ts";
import type { RefusalCode } from "../refusals.ts";
import type { DocumentUnitStatus } from "./document-status.ts";
export type { DocumentUnitStatus } from "./document-status.ts";
import { openRegistry } from "../registry.ts";
import type { ToolContext } from "../tools/context.ts";
import { resolveProjectFile } from "../tools/context.ts";
import { MAX_CLAIM_CHARS, MIN_CLAIM_CHARS } from "../tools/verify.ts";
import { resolveScope, type ScopePaper } from "./scope.ts";
import { prepareSources } from "./acquire.ts";
import { CancelledError, type ClaimEngine } from "./claim.ts";
import { gridBatchSizeOf } from "./engines.ts";
import { localizePassages } from "./evidence.ts";
import { claimVerdict, isSupported, judgeGrid, paperVerdict, type GridBundle, type Verdict } from "./judge.ts";
import type { AnnotatedClaim, StatedSource } from "./annotations.ts";
import { matchStatedUnits, mergeGrids } from "./annotated.ts";
import type { PaperUnit } from "./paper-units.ts";
import { unitPathFromEnv } from "./strategy.ts";
import { ensureChunks, getSource, passageHashOf, claimHashOf } from "./store.ts";
import { loadPaperUnits } from "./unit-select.ts";
import {
  loadVerifySetup,
  newUnitSelection,
  verifyWorkflow,
  type PrimeSession,
  type WorkflowHooks,
  type WorkflowOutcome,
} from "./workflow.ts";

/** Client policy: units checked per document call (each unit costs its own top-10 candidate checks under the hosted default). */
export const MAX_DOCUMENT_UNITS = 50;
/** Client policy: largest manuscript file read for a document check (the review command's limit). */
const MAX_FILE_BYTES = 4_000_000;
/** Characters of the unit's own wording carried per unit (bounded, verbatim, pointer-bound). */
const EXCERPT_CHARS = 120;

/** Row-level figure check of a `table-row` unit: found in the cited paper, missing (open or unsourced), or only weakly checkable. */
export interface TableRowFigures { found: number; missing: number; check: number }
/** The wording caveat every `table-row` unit carries: its figures are checked, its wording is not verified. */
export const TABLE_ROW_NOTE = "figures checked against the cited paper; row wording not verified";

export interface DocumentUnitResult {
  id: string;
  kind: Unit["kind"];
  file: string;
  line: number;
  section: string;
  /** First EXCERPT_CHARS characters of the unit as written (plain text, no cite commands). */
  excerpt: string;
  status: DocumentUnitStatus;
  cites: string[];
  /** Pointers to the supporting spans (supported) or the suggested spans (missing-citation). */
  pointers: string[];
  /** Citekeys the unit cites that no registered paper supported (absent when every cite supports). */
  failedCites?: string[];
  /** Per-cited-paper support location (annotated mode; absent otherwise). */
  supportWhere?: ClaimSupportWhere[];
  /** Stated refs that resolved to no unit, by citekey (annotated mode; absent otherwise). */
  unresolvedStated?: string[];
  /** Citekeys suggested for a missing-citation unit (registered papers with support the unit does not cite). */
  suggested: string[];
  /** Citekeys the unit cites that no registered paper matches (empty when every cite resolved). */
  unregistered: string[];
  /** Why a skipped unit was not checked (`too short`, or `too long — split it`); absent otherwise. */
  reason?: string;
  /** Figure counts of a `table-row` unit (never sent to the claim engine); absent otherwise. */
  figures?: TableRowFigures;
  /** The wording caveat of a `table-row` unit; absent otherwise. */
  note?: string;
  /** False when the unit's own check was interrupted before all passages were judged. */
  complete: boolean;
}

export interface DocumentRequest {
  document?: string;
  text?: string;
  /** Index of the first unit to check (a page of MAX_DOCUMENT_UNITS units; the result names the next offset). */
  offset?: number;
  /** Annotated mode: claims bound to units by unit.id after toUnits(parsed.latex) (absent = document mode). */
  annotated?: { claims: AnnotatedClaim[]; scope?: readonly string[] };
}

export type DocumentOutcome = WorkflowOutcome;

const refuse = (code: RefusalCode, message: string): DocumentOutcome => ({ kind: "refused", code, message });

interface Checkable { paper: Paper; tex: string; units: Unit[]; source: string }

function toUnits(req: DocumentRequest, root: string): Checkable | { error: string } {
  if (req.document !== undefined) {
    const entry = resolveEntry(root, req.document);
    if (!entry.ok) return { error: entry.message };
    const lines = expandSource((rel) => {
      const f = resolveProjectFile(root, rel, MAX_FILE_BYTES);
      return f.ok ? readFileSync(f.abs, "utf8") : undefined;
    }, entry.rel.split(sep).join("/"));
    if (lines.length === 0) return { error: `${req.document} could not be read inside the project` };
    const paper = parsePaper(lines);
    return { paper, tex: lines.map((l) => l.text).join("\n"), units: extractUnits(paper), source: entry.rel.split(sep).join("/") };
  }
  const lines = linesFromString(req.text ?? "", "fragment.tex");
  const paper = parsePaper(lines);
  return { paper, tex: lines.map((l) => l.text).join("\n"), units: extractUnits(paper), source: "text" };
}

/**
 * Figure counts per table row, from the provenance audit of the same text against the same registry (D4): a row's
 * figures are matched with the audit's own rules (cited papers' texts, or the project's result files for a row that
 * cites no registered paper), so `verify` and `provenance` never disagree about a row. Rows only; the audit's ledger is
 * not used (rows are never released as verified wording).
 */
function tableRowFigures(ctx: ToolContext, db: ReturnType<typeof openRegistry>, checkable: Checkable): Map<string, TableRowFigures> {
  let glob = DEFAULTS.provenance.results_glob;
  try {
    glob = loadChunkConfig(ctx.root, { env: ctx.env ?? {} }).provenance.results_glob;
  } catch {
    // keep the default, as the provenance audit does: an invalid config never blocks the check
  }
  const results: ResultLine[] = collectResultLines(ctx.root, glob);
  const { papers } = readProvenanceInputs(db);
  const audit = auditProvenance({ paper: checkable.paper, tex: checkable.tex, papers, ledger: () => null, results });
  const out = new Map<string, TableRowFigures>();
  for (const u of audit.units) if (u.unit.kind === "row") out.set(u.unit.id, figureCounts(u));
  return out;
}

function figureCounts(u: UnitAudit): TableRowFigures {
  const c: TableRowFigures = { found: 0, missing: 0, check: 0 };
  for (const f of u.figures) {
    if (f.status === "ok" || f.status === "computed") c.found++;
    else if (f.status === "open" || f.status === "unsourced") c.missing++;
    else if (f.status === "check" || f.status === "unavailable") c.check++;
  }
  return c;
}

const excerptOf = (plain: string): string => (plain.length <= EXCERPT_CHARS ? plain : `${plain.slice(0, EXCERPT_CHARS - 1)}…`);

type ClaimResult = Record<string, any>;

async function checkClaim(
  ctx: ToolContext,
  db: ReturnType<typeof openRegistry>,
  req: { claim: string; papers: "all" | string[] },
  hooks: WorkflowHooks,
  session?: PrimeSession,
): Promise<{ result: ClaimResult } | { code: RefusalCode; message: string }> {
  const out = await verifyWorkflow(ctx, db, req, hooks, session);
  if (out.kind === "refused") return { code: out.code, message: out.message };
  return { result: out.result };
}

// ── V5a: prime, then replay ─────────────────────────────────────────────────

/** One checkable prose unit with its cited keys. */
export interface PrimeReq {
  claim: string;
  cites: string[];
  /** Stated sources of an annotated claim (absent = document mode). */
  stated?: StatedSource[];
}

/** Where a cited paper's support was found (annotated mode; absent otherwise). */
export interface ClaimSupportWhere {
  citekey: string;
  at: "stated" | "elsewhere" | "unstated";
}

/** What the prime resolved and judged for one claim. */
export interface PrimedClaim {
  claim: string;
  cites: string[];
  /** Resolved citekeys (registered), in scope order. */
  resolved: string[];
  /** Citekeys no registered paper matches. */
  unregistered: string[];
  /** Resolved papers with no ready source. */
  unsourced: { doi: string; citekey: string }[];
  /** Resolved, sourced papers in scope order. */
  ready: ScopePaper[];
  /** The judged units per ready paper (doi → units). */
  unitsByDoi: Map<string, { start: number; end: number; text: string; hash: string }[]>;
  /** Per-paper verdicts over the primed round-1 scores. */
  verdicts: Map<string, Verdict>;
  /** Claim verdict over the cited papers (empty → unsupported). */
  overall: Verdict;
  /** "all"-scope selection (uncited units and rechecks), candidates in order. */
  allUnits: { doi: string; start: number; end: number; text: string; hash: string }[] | null;
  /** No cited paper supports: the "all" recheck is primed. */
  recheck: boolean;
  /** Per-cited-paper support location (annotated mode; empty in document mode). */
  where: ClaimSupportWhere[];
  /** Stated refs that resolved to no unit, by citekey (annotated mode; empty otherwise). */
  unresolvedStated: string[];
}

export interface PrimePage {
  session: PrimeSession;
  primed: PrimedClaim[];
  /** Prime cost: distinct round-1 cells, fresh/cached judgments, engine calls. */
  work: { cells: number; fresh: number; cached: number; calls: number };
}

export type PrimePageOutcome = { kind: "ok"; page: PrimePage } | { kind: "refused"; code: RefusalCode; message: string };

const primeRefuse = (code: RefusalCode, message: string): PrimePageOutcome => ({ kind: "refused", code, message });

/**
 * Prime one document page (V5a): resolve every claim's selection with V4's
 * functions, then judge. Round 1 groups claims by (paper, identical unit
 * list) into GridBundles — a narrowed ("all") claim is its own bundle — and
 * runs one judgeGrid call with batchSize = gridBatchSizeOf(engine). Round 2
 * judges the localization windows of supported units plus the "all" rechecks
 * of claims no cited paper supports. Refuses VERIFY_ENGINE_MISSING when the
 * page had zero successes; per-claim runs then never refuse, they go
 * incomplete. Page budget (client policy): max_judgments × checked claims per
 * round.
 */
export async function primePage(ctx: ToolContext, db: ReturnType<typeof openRegistry>, reqs: PrimeReq[], hooks: WorkflowHooks, opts?: { scope?: readonly string[] }): Promise<PrimePageOutcome> {
  // SectionScope.keys replaces the literal "all" for uncited units and the wider recheck in annotated mode.
  const scope = opts?.scope;
  let setup: ReturnType<typeof loadVerifySetup>;
  try {
    setup = loadVerifySetup(ctx, hooks);
  } catch (err) {
    if (err instanceof Error && err.name === "ConfigError") return primeRefuse("CONFIG_INVALID", err.message);
    throw err;
  }
  const { cfg, engineName, getEngine, identityOf, cap } = setup;
  const bar = cfg.verification.min_confidence;
  const identity = await identityOf();
  // Count prime engine calls for the annotated work ledger (one memoized engine).
  let primeCalls = 0;
  let counted: ClaimEngine | null = null;
  const countingEngine = (): ClaimEngine => {
    if (counted === null) {
      const inner = getEngine();
      counted = { run: async (rows) => { primeCalls++; return inner.run(rows); } };
    }
    return counted;
  };
  const judgeOpts = (maxFresh: number) => ({
    db,
    queue: ctx.queue,
    now: ctx.now,
    identity,
    createEngine: countingEngine,
    workers: cfg.verification.workers,
    batchSize: gridBatchSizeOf(engineName),
    maxFresh,
    signal: ctx.signal,
  });
  const budget = Math.max(0, cfg.verification.max_judgments * reqs.length);

  // Sources and section marks first, exactly as a claim run prepares them (workflow.ts): a source stored under an
  // older section policy gets its marks re-derived here, so the primed units are the units the per-claim replay judges.
  const toPrepare = new Map<string, ScopePaper>();
  for (const req of reqs) for (const p of resolveScope(db, req.cites.length > 0 ? req.cites : scope !== undefined ? [...scope] : "all").selected) toPrepare.set(p.doi, p);
  await prepareSources(ctx, db, [...toPrepare.values()], cfg, []);
  for (const p of toPrepare.values()) if (getSource(db, p.doi)?.status === "ready") ensureChunks(db, p.doi, cfg.chunking);

  const primed: PrimedClaim[] = reqs.map((req) => {
    const { selected, unresolved } = resolveScope(db, req.cites.length > 0 ? req.cites : scope !== undefined ? [...scope] : "all");
    const ready: ScopePaper[] = [];
    const unsourced: { doi: string; citekey: string }[] = [];
    for (const p of selected) {
      if (getSource(db, p.doi)?.status === "ready") ready.push(p);
      else unsourced.push({ doi: p.doi, citekey: p.citekey });
    }
    const unitsByDoi = new Map<string, { start: number; end: number; text: string; hash: string }[]>();
    let allUnits: PrimedClaim["allUnits"] = null;
    if (req.cites.length === 0) {
      const sel = newUnitSelection(db, ready, "all", null, req.claim, cap);
      const byDoi = new Map<string, { start: number; end: number; text: string; hash: string }[]>();
      for (const c of sel.candidates) {
        const list = byDoi.get(c.doi) ?? byDoi.set(c.doi, []).get(c.doi)!;
        list.push({ start: c.start, end: c.end, text: c.text, hash: c.hash });
      }
      for (const [doi, list] of byDoi) unitsByDoi.set(doi, list);
      allUnits = sel.candidates.map((c) => ({ doi: c.doi, start: c.start, end: c.end, text: c.text, hash: c.hash }));
    } else {
      for (const p of ready) {
        const loaded = loadPaperUnits(db, p.doi, cap);
        if (loaded !== null) unitsByDoi.set(p.doi, loaded.units.map((u: PaperUnit) => ({ start: u.start, end: u.end, text: u.text, hash: u.hash })));
      }
    }
    return {
      claim: req.claim,
      cites: req.cites,
      resolved: selected.map((p) => p.citekey),
      unregistered: unresolved.map((u) => u.handle),
      unsourced,
      ready,
      unitsByDoi,
      verdicts: new Map(),
      overall: "unsupported" as Verdict,
      allUnits,
      recheck: false,
      where: [],
      unresolvedStated: [],
    };
  });

  // Annotated claims bind stated sources to paper units here; document-mode
  // claims (stated undefined) keep today's path exactly. Per claim and ready
  // paper: the stated unit hashes, whether any ref named the paper, and the
  // citekey for unresolved refs.
  const statedByReq: { doi: string; citekey: string; hashes: string[]; hasRefs: boolean }[][] = primed.map((pc, i) => {
    const stated = reqs[i].stated;
    if (stated === undefined) return [];
    const keyToDoi = new Map(pc.ready.map((p) => [p.citekey, p.doi]));
    return pc.ready.flatMap((p) => {
      const loaded = loadPaperUnits(db, p.doi, cap);
      if (loaded === null) return [];
      const refs = stated.filter((s) => keyToDoi.get(s.citekey) === p.doi);
      const { matched, unresolved } = matchStatedUnits(loaded.units, p.doi, loaded.revision, refs.map((s) => s.ref));
      if (unresolved.length > 0 && !pc.unresolvedStated.includes(p.citekey)) pc.unresolvedStated.push(p.citekey);
      return [{ doi: p.doi, citekey: p.citekey, hashes: matched.map((idx) => loaded.units[idx]!.hash), hasRefs: refs.length > 0 }];
    });
  });

  // Round 1: one bundle per (paper, identical unit list); narrowed claims own
  // theirs. Annotated claims judge only their stated units, keyed
  // doi|stated hashes; unstated claims keep today's grouping.
  const bundles: GridBundle[] = [];
  const grouped = new Map<string, { units: { text: string; hash: string }[]; claims: string[] }>();
  const groupCell = (doi: string, units: { text: string; hash: string }[], claim: string): void => {
    const key = `${doi}|${units.map((u) => u.hash).join(",")}`;
    const g = grouped.get(key) ?? grouped.set(key, { units, claims: [] }).get(key)!;
    if (!g.claims.includes(claim)) g.claims.push(claim);
  };
  primed.forEach((pc, i) => {
    if (pc.allUnits !== null) {
      bundles.push({ units: pc.allUnits.map((u) => ({ text: u.text, hash: u.hash })), claims: [pc.claim] });
      return;
    }
    if (reqs[i].stated === undefined) {
      for (const [doi, units] of pc.unitsByDoi) groupCell(doi, units.map((u) => ({ text: u.text, hash: u.hash })), pc.claim);
      return;
    }
    const byHash = new Map([...pc.unitsByDoi.values()].flat().map((u) => [u.hash, u.text]));
    for (const s of statedByReq[i]) {
      if (s.hashes.length === 0) continue;
      groupCell(s.doi, s.hashes.map((h) => ({ text: byHash.get(h)!, hash: h })), pc.claim);
    }
  });
  for (const g of grouped.values()) bundles.push({ units: g.units, claims: g.claims });

  let round1 = await judgeGrid(judgeOpts(budget), bundles);
  // claimHash → unit hashes the replay may serve (absent = unguarded).
  const only = new Map<string, Set<string>>();
  const keepForReplay = (claim: string, hashes: string[]): void => {
    const set = only.get(claimHashOf(claim)) ?? only.set(claimHashOf(claim), new Set()).get(claimHashOf(claim))!;
    for (const h of hashes) set.add(h);
  };
  if (reqs.every((r) => r.stated === undefined)) {
    if (round1.scores.size === 0 && round1.interruption?.reason === "engine_failure") {
      return primeRefuse("VERIFY_ENGINE_MISSING", round1.interruption.detail);
    }
    const scoreOf = (claim: string, hash: string): number | undefined => round1.scores.get(claimHashOf(claim))?.get(hash);
    for (const pc of primed) {
      for (const [doi, units] of pc.unitsByDoi) {
        pc.verdicts.set(doi, paperVerdict(units.map((u) => u.hash), (h) => scoreOf(pc.claim, h), bar));
      }
      pc.overall = claimVerdict([...pc.verdicts.values()]);
    }
  } else {
    // Round 1b ("elsewhere"): for each annotated (claim, paper) the stated
    // units did not support, judge the rest of the paper — including pairs
    // whose refs resolved to no unit (their stated set is empty, so the rest
    // is every unit) — and merge into the session round 1.
    const scoreOfR1 = (claim: string, hash: string): number | undefined => round1.scores.get(claimHashOf(claim))?.get(hash);
    const round1bBundles: GridBundle[] = [];
    primed.forEach((pc, i) => {
      if (reqs[i].stated === undefined) return;
      for (const s of statedByReq[i]) {
        if (paperVerdict(s.hashes, (h) => scoreOfR1(pc.claim, h), bar) === "supported") continue;
        const rest = (pc.unitsByDoi.get(s.doi) ?? []).filter((u) => !s.hashes.includes(u.hash));
        if (rest.length > 0) round1bBundles.push({ units: rest.map((u) => ({ text: u.text, hash: u.hash })), claims: [pc.claim] });
      }
    });
    const round1b = await judgeGrid(judgeOpts(budget), round1bBundles);
    round1 = mergeGrids(round1, round1b);
    if (round1.scores.size === 0 && (round1.interruption?.reason === "engine_failure" || round1b.interruption?.reason === "engine_failure")) {
      return primeRefuse("VERIFY_ENGINE_MISSING", round1.interruption?.detail ?? round1b.interruption?.detail ?? "the engine failed");
    }
    const scoreOf = (claim: string, hash: string): number | undefined => round1.scores.get(claimHashOf(claim))?.get(hash);
    primed.forEach((pc, i) => {
      if (reqs[i].stated === undefined) {
        for (const [doi, units] of pc.unitsByDoi) {
          pc.verdicts.set(doi, paperVerdict(units.map((u) => u.hash), (h) => scoreOf(pc.claim, h), bar));
        }
        pc.overall = claimVerdict([...pc.verdicts.values()]);
        return;
      }
      for (const citekey of reqs[i].cites) {
        const paper = pc.ready.find((p) => p.citekey === citekey);
        if (paper === undefined) continue;
        const st = statedByReq[i].find((s) => s.doi === paper.doi)!;
        const all = (pc.unitsByDoi.get(paper.doi) ?? []).map((u) => u.hash);
        const statedOk = paperVerdict(st.hashes, (h) => scoreOf(pc.claim, h), bar) === "supported";
        // Only a supporting paper has a support location; one that supports nowhere is a failed cite.
        if (paperVerdict(all, (h) => scoreOf(pc.claim, h), bar) === "supported") {
          pc.where.push({ citekey, at: !st.hasRefs ? "unstated" : statedOk ? "stated" : "elsewhere" });
        }
        keepForReplay(pc.claim, statedOk ? st.hashes : all);
      }
      for (const [doi, units] of pc.unitsByDoi) {
        pc.verdicts.set(doi, paperVerdict(units.map((u) => u.hash), (h) => scoreOf(pc.claim, h), bar));
      }
      pc.overall = claimVerdict([...pc.verdicts.values()]);
    });
  }

  // Round 2: windows of supported units, plus "all" rechecks where needed.
  // Scores come from the merged round 1 (round 1b folded in for annotated).
  const scoreOfMerged = (claim: string, hash: string): number | undefined => round1.scores.get(claimHashOf(claim))?.get(hash);
  const round2bundles: GridBundle[] = [];
  const windowed = new Map<string, { unit: { start: number; text: string; hash: string }; claims: string[] }>();
  for (const pc of primed) {
    for (const units of pc.unitsByDoi.values()) {
      for (const u of units) {
        const s = scoreOfMerged(pc.claim, u.hash);
        if (s === undefined || !isSupported(s, bar)) continue;
        const w = windowed.get(u.hash) ?? windowed.set(u.hash, { unit: u, claims: [] }).get(u.hash)!;
        if (!w.claims.includes(pc.claim)) w.claims.push(pc.claim);
      }
    }
  }
  for (const { unit, claims } of windowed.values()) {
    const windows = localizePassages({ start: unit.start, text: unit.text });
    round2bundles.push({ units: windows.map((w) => ({ text: w.text, hash: passageHashOf(w.text) })), claims });
  }
  const allReady = [...new Map(primed.flatMap((pc) => pc.ready).map((p) => [p.doi, p])).values()].filter(
    (p) => scope === undefined || scope.includes(p.citekey),
  );
  for (const pc of primed) {
    if (pc.allUnits !== null || [...pc.verdicts.values()].includes("supported")) continue;
    // No cited paper supports: prime the "all" recheck (top 10 units).
    pc.recheck = true;
    const sel = newUnitSelection(db, allReady, "all", null, pc.claim, cap);
    pc.allUnits = sel.candidates.map((c) => ({ doi: c.doi, start: c.start, end: c.end, text: c.text, hash: c.hash }));
    round2bundles.push({ units: sel.candidates.map((c) => ({ text: c.text, hash: c.hash })), claims: [pc.claim] });
  }
  const round2 = await judgeGrid(judgeOpts(budget), round2bundles);
  let cells = 0;
  for (const byUnit of round1.scores.values()) cells += byUnit.size;
  cells += round1.unchecked.length;
  return {
    kind: "ok",
    page: {
      session: { round1, round2, ...(only.size > 0 ? { only } : {}) },
      primed,
      work: { cells, fresh: round1.fresh + round2.fresh, cached: round1.cached + round2.cached, calls: primeCalls },
    },
  };
}

const INCOMPLETE_LIMITATIONS = new Set(["interrupted", "sources_unavailable", "sources_deferred", "unresolved_scope", "source_changed"]);

const pointersOf = (r: ClaimResult): { pointers: string[]; citekeys: string[]; complete: boolean } => ({
  pointers: ((r.evidence as { pointer?: string }[] | undefined) ?? []).map((e) => String(e.pointer ?? "")).filter((p) => p !== ""),
  citekeys: [...new Set(((r.evidence as { citekey?: string }[] | undefined) ?? []).map((e) => String(e.citekey ?? "")).filter((k) => k !== ""))],
  complete:
    (r.coverage as { work?: { complete?: boolean } } | undefined)?.work?.complete !== false &&
    !(((r.result as { limitations?: string[] } | undefined)?.limitations ?? []).some((l) => INCOMPLETE_LIMITATIONS.has(l))),
});

/**
 * Check one primed page (V5a): verdicts come from the primed grids via
 * paperVerdict/claimVerdict over the unit selection, while evidence, runs,
 * ledgers and containment run through the unchanged per-claim path with the
 * session judge. Every cited, resolved, sourced paper must support for
 * `supported`; a unit no cited paper supports gets the "all" recheck; an
 * unregistered or sourceless cite blocks `supported` (O1).
 */
async function documentUnitsPage(
  ctx: ToolContext,
  db: ReturnType<typeof openRegistry>,
  checkable: { unit: Unit; base: DocumentUnitResult; selected: ScopePaper[]; stated?: StatedSource[] }[],
  hooks: WorkflowHooks,
  opts: { annotated: boolean; scope?: readonly string[] },
): Promise<{ code: RefusalCode; message: string } | { results: DocumentUnitResult[]; engine: ClaimResult["engine"] | null; bar: number; work: PrimePage["work"] }> {
  // Annotated checking always runs the unit path (never the env switch).
  const h = opts.annotated ? { ...hooks, unitPath: true } : hooks;
  const prime = await primePage(
    ctx,
    db,
    checkable.map((c) => ({ claim: c.unit.plain, cites: c.unit.cites, ...(c.stated !== undefined ? { stated: c.stated } : {}) })),
    h,
    { scope: opts.scope },
  );
  if (prime.kind === "refused") return { code: prime.code, message: prime.message };
  const { session, primed } = prime.page;
  const pageResults: DocumentUnitResult[] = [];
  let engine: ClaimResult["engine"] | null = null;
  let bar = 0.99;
  const throwIfCancelled = (): void => {
    if (ctx.signal?.aborted === true) throw new CancelledError();
  };
  const note = (r: { result: ClaimResult }): void => {
    engine ??= r.result.engine ?? null;
    if (typeof r.result.engine?.minConfidence === "number") bar = r.result.engine.minConfidence;
  };
  const supportedBy = (r: ClaimResult): boolean => (r.result as { supportFound?: boolean } | undefined)?.supportFound === true;
  // The wider scope in annotated mode is the assigned set, never the registry.
  const wide: "all" | string[] = opts.scope === undefined ? "all" : [...opts.scope];
  // supportWhere rides only on marked, cited units; unmarked units carry none.
  const annFields = (pc: PrimedClaim, i: number): { supportWhere: ClaimSupportWhere[]; unresolvedStated: string[] } | Record<string, never> =>
    opts.annotated && checkable[i].stated !== undefined && checkable[i].unit.cites.length > 0
      ? { supportWhere: pc.where, unresolvedStated: pc.unresolvedStated }
      : {};
  for (const [i, { unit, base }] of checkable.entries()) {
    throwIfCancelled();
    const pc = primed[i];
    const cited = unit.cites.length > 0;
    const scope = pc.ready.map((p) => p.doi);
    if (!cited) {
      // Uncited units are checked against everything: support is a missing citation.
      const all = await checkClaim(ctx, db, { claim: unit.plain, papers: wide }, h, session);
      if ("code" in all) return { code: all.code, message: all.message };
      note({ result: all.result });
      const found = pointersOf(all.result);
      pageResults.push(
        supportedBy(all.result)
          ? { ...base, status: "missing-citation", pointers: found.pointers, suggested: found.citekeys.filter((k) => !unit.cites.includes(k)), complete: found.complete, ...annFields(pc, i) }
          : { ...base, status: "unsourced", complete: found.complete, ...annFields(pc, i) },
      );
      continue;
    }
    const supporting = new Set([...pc.verdicts].filter(([, v]) => v === "supported").map(([doi]) => pc.ready.find((p) => p.doi === doi)?.citekey ?? doi));
    const failed = unit.cites.filter((k) => !supporting.has(k));
    const failedField = failed.length > 0 ? { failedCites: failed } : {};
    const first = await checkClaim(ctx, db, { claim: unit.plain, papers: scope }, h, session);
    if ("code" in first) return { code: first.code, message: first.message };
    note({ result: first.result });
    const found = pointersOf(first.result);
    if (supportedBy(first.result) && pc.overall === "supported" && pc.unregistered.length === 0 && pc.unsourced.length === 0) {
      pageResults.push({ ...base, status: "supported", pointers: found.pointers, complete: found.complete, ...annFields(pc, i) });
      continue;
    }
    if (supportedBy(first.result)) {
      // Some cites support, some fail: no wider recheck.
      pageResults.push({ ...base, status: "cited-unsupported", pointers: found.pointers, ...failedField, complete: found.complete && pc.unregistered.length === 0, ...annFields(pc, i) });
      continue;
    }
    // No cited paper supports: one check against everything.
    throwIfCancelled();
    const second = await checkClaim(ctx, db, { claim: unit.plain, papers: wide }, h, session);
    if ("code" in second) return { code: second.code, message: second.message };
    note({ result: second.result });
    const wider = pointersOf(second.result);
    const complete = found.complete && wider.complete && pc.unregistered.length === 0 && pc.unsourced.length === 0;
    if (supportedBy(second.result)) {
      pageResults.push({ ...base, status: "missing-citation", pointers: wider.pointers, suggested: wider.citekeys.filter((k) => !unit.cites.includes(k)), ...failedField, complete, ...annFields(pc, i) });
      continue;
    }
    pageResults.push({ ...base, status: "cited-unsupported", ...failedField, complete, ...annFields(pc, i) });
  }
  return { results: pageResults, engine, bar, work: prime.page.work };
}

export async function documentWorkflow(ctx: ToolContext, db: ReturnType<typeof openRegistry>, req: DocumentRequest, hooks: WorkflowHooks): Promise<DocumentOutcome> {
  const got = toUnits(req, ctx.root);
  if ("error" in got) return refuse("ARGUMENT_INVALID", got.error);
  const { units: all, source } = got;
  // Rows never reach the claim engine; their figures are checked only when the text has rows (prose-only checks read nothing extra).
  const rowFigures = all.some((u) => u.kind === "row") ? tableRowFigures(ctx, db, got) : new Map<string, TableRowFigures>();
  if (all.length === 0) return refuse("ARGUMENT_INVALID", "no checkable units: the input has no sentences, captions or table rows to check");
  const offset = req.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || (offset > 0 && offset >= all.length)) return refuse("ARGUMENT_INVALID", `offset must be an integer from 0 to ${Math.max(0, all.length - 1)}`);
  // A page of at most MAX_DOCUMENT_UNITS units (client policy); judgments are cached, so paging through a document costs nothing twice.
  const units = all.slice(offset, offset + MAX_DOCUMENT_UNITS);
  const next = offset + units.length < all.length ? offset + units.length : null;

  const results: DocumentUnitResult[] = [];
  let engine: ClaimResult["engine"] | null = null;
  let bar = 0.99;
  const throwIfCancelled = (): void => {
    // Between units (and before the wider-scope recheck below) the host may
    // have aborted: stop starting work and reject so the owning Pi worker sees
    // the abort after the in-flight check — already awaited — settles.
    if (ctx.signal?.aborted === true) throw new CancelledError();
  };
  // First pass: rows, length bounds and wholly-unknown cites need no engine.
  // Placeholders keep manuscript order: the flows below fill them in place.
  // Annotated claims ride along by unit.id (units come from the same latex).
  const statedByUnit = new Map((req.annotated?.claims ?? []).map((c) => [c.unitId, c.sources]));
  const checkable: { unit: Unit; base: DocumentUnitResult; selected: ScopePaper[]; slot: number; stated?: StatedSource[] }[] = [];
  for (const unit of units) {
    throwIfCancelled();
    const { selected, unresolved } = resolveScope(db, unit.cites.length > 0 ? unit.cites : "all");
    const unknownKeys = unresolved.map((u) => u.handle);
    const base: DocumentUnitResult = {
      id: unit.id, kind: unit.kind, file: unit.file, line: unit.line, section: unit.section,
      excerpt: excerptOf(unit.plain), status: "unsourced", cites: unit.cites, pointers: [], suggested: [], complete: true,
      unregistered: unknownKeys,
    };
    // A table row is not a claim: its wording is not verified, only its figures against the cited paper (D4).
    if (unit.kind === "row") {
      results.push({ ...base, status: "table-row", figures: rowFigures.get(unit.id) ?? { found: 0, missing: 0, check: 0 }, note: TABLE_ROW_NOTE });
      continue;
    }
    // The claim-length bounds apply per unit: a unit outside them is not checked (a full
    // exhaustive check per tiny or huge unit would waste the engine or refuse the whole call).
    if (unit.plain.length < MIN_CLAIM_CHARS) {
      results.push({ ...base, status: "skipped", reason: "too short" });
      continue;
    }
    if (unit.plain.length > MAX_CLAIM_CHARS) {
      results.push({ ...base, status: "skipped", reason: "too long — split it" });
      continue;
    }
    // Only unknown citekeys: nothing registered to check. Partially unknown keys still
    // check the registered papers; the unknown keys ride along on the result.
    if (selected.length === 0) {
      results.push({ ...base, status: "unregistered", cites: [...unit.cites] });
      continue;
    }
    checkable.push({ unit, base, selected, slot: results.length, ...(statedByUnit.get(unit.id) !== undefined ? { stated: statedByUnit.get(unit.id)! } : {}) });
    results.push(null as unknown as DocumentUnitResult);
  }

  let work: PrimePage["work"] | null = null;
  if (req.annotated !== undefined || unitPathFromEnv(ctx.env)) {
    const page = await documentUnitsPage(ctx, db, checkable, hooks, { annotated: req.annotated !== undefined, scope: req.annotated?.scope });
    if ("code" in page) return refuse(page.code, page.message);
    // Fill the placeholders in manuscript order.
    let j = 0;
    for (let k = 0; k < results.length; k++) if (results[k] === null) results[k] = page.results[j++] as DocumentUnitResult;
    engine = page.engine;
    bar = page.bar;
    if (req.annotated !== undefined) work = page.work;
  } else {
    // The A0 path fills its placeholders in manuscript order.
    for (const { unit, base, selected, slot } of checkable) {
      throwIfCancelled();
      const cited = unit.cites.length > 0;
      const scope = cited ? selected.map((p) => p.doi) : ("all" as const);
      const first = await checkClaim(ctx, db, { claim: unit.plain, papers: scope }, hooks);
      if ("code" in first) return refuse(first.code, first.message);
      engine ??= first.result.engine ?? null;
      bar = typeof first.result.engine?.minConfidence === "number" ? first.result.engine.minConfidence : bar;
      const found = pointersOf(first.result);
      base.complete = found.complete;
      if ((first.result.result as { supportFound?: boolean } | undefined)?.supportFound === true) {
        results[slot] = cited
          ? { ...base, status: "supported", pointers: found.pointers }
          : { ...base, status: "missing-citation", pointers: found.pointers, suggested: found.citekeys };
        continue;
      }
      // No support in the unit's own scope: one check against everything, to tell
      // a missing citation (recoverable) from an unsourced claim.
      throwIfCancelled();
      const second = cited ? await checkClaim(ctx, db, { claim: unit.plain, papers: "all" }, hooks) : null;
      if (second !== null && "code" in second) return refuse(second.code, second.message);
      const widerResult = second !== null && !("code" in second) ? second.result : null;
      const wider = widerResult !== null ? pointersOf(widerResult) : null;
      const widerFound = (widerResult?.result as { supportFound?: boolean } | undefined)?.supportFound === true;
      base.complete = base.complete && (wider?.complete ?? true);
      if (wider !== null && widerFound) {
        results[slot] = { ...base, status: "missing-citation", pointers: wider.pointers, suggested: wider.citekeys.filter((k) => !unit.cites.includes(k)) };
        continue;
      }
      results[slot] = { ...base, status: cited ? "cited-unsupported" : "unsourced" };
    }
  }

  const count = (s: DocumentUnitStatus): number => results.filter((r) => r.status === s).length;
  return {
    kind: "ok",
    result: {
      mode: "document",
      source,
      summary: {
        total: all.length,
        from: offset,
        units: results.length,
        supported: count("supported"),
        missingCitation: count("missing-citation"),
        citedUnsupported: count("cited-unsupported"),
        unsourced: count("unsourced"),
        unregistered: count("unregistered"),
        skipped: count("skipped"),
        tableRows: count("table-row"),
        tableRowsMissing: results.filter((r) => r.status === "table-row" && (r.figures?.missing ?? 0) > 0).length,
        incomplete: results.filter((r) => !r.complete).length,
      },
      engine: engine ?? { name: "unknown", model: null, protocol: "unidentified", minConfidence: bar, cache: false },
      units: results,
      ...(work !== null ? { work } : {}),
      next,
    },
  };
}
