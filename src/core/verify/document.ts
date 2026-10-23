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
import { resolveScope } from "./scope.ts";
import { CancelledError } from "./claim.ts";
import { verifyWorkflow, type WorkflowHooks, type WorkflowOutcome } from "./workflow.ts";

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

async function checkClaim(ctx: ToolContext, db: ReturnType<typeof openRegistry>, req: { claim: string; papers: "all" | string[] }, hooks: WorkflowHooks): Promise<{ result: ClaimResult } | { code: RefusalCode; message: string }> {
  const out = await verifyWorkflow(ctx, db, req, hooks);
  if (out.kind === "refused") return { code: out.code, message: out.message };
  return { result: out.result };
}

const INCOMPLETE_LIMITATIONS = new Set(["interrupted", "sources_unavailable", "sources_deferred", "unresolved_scope", "source_changed"]);

const pointersOf = (r: ClaimResult): { pointers: string[]; citekeys: string[]; complete: boolean } => ({
  pointers: ((r.evidence as { pointer?: string }[] | undefined) ?? []).map((e) => String(e.pointer ?? "")).filter((p) => p !== ""),
  citekeys: [...new Set(((r.evidence as { citekey?: string }[] | undefined) ?? []).map((e) => String(e.citekey ?? "")).filter((k) => k !== ""))],
  complete:
    (r.coverage as { work?: { complete?: boolean } } | undefined)?.work?.complete !== false &&
    !(((r.result as { limitations?: string[] } | undefined)?.limitations ?? []).some((l) => INCOMPLETE_LIMITATIONS.has(l))),
});

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
    const cited = unit.cites.length > 0;
    const scope = cited ? selected.map((p) => p.doi) : ("all" as const);
    const first = await checkClaim(ctx, db, { claim: unit.plain, papers: scope }, hooks);
    if ("code" in first) return refuse(first.code, first.message);
    engine ??= first.result.engine ?? null;
    bar = typeof first.result.engine?.minConfidence === "number" ? first.result.engine.minConfidence : bar;
    const found = pointersOf(first.result);
    base.complete = found.complete;
    if ((first.result.result as { supportFound?: boolean } | undefined)?.supportFound === true) {
      results.push(cited ? { ...base, status: "supported", pointers: found.pointers } : { ...base, status: "missing-citation", pointers: found.pointers, suggested: found.citekeys });
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
      results.push({ ...base, status: "missing-citation", pointers: wider.pointers, suggested: wider.citekeys.filter((k) => !unit.cites.includes(k)) });
      continue;
    }
    results.push({ ...base, status: cited ? "cited-unsupported" : "unsourced" });
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
      next,
    },
  };
}
