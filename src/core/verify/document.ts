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
import { expandSource, linesFromString, parsePaper } from "../review/latex.ts";
import type { Unit } from "../provenance/units.ts";
import { extractUnits } from "../provenance/units.ts";
import type { RefusalCode } from "../refusals.ts";
import { openRegistry } from "../registry.ts";
import type { ToolContext } from "../tools/context.ts";
import { resolveProjectFile } from "../tools/context.ts";
import { resolveScope } from "./scope.ts";
import { verifyWorkflow, type WorkflowHooks, type WorkflowOutcome } from "./workflow.ts";

/** Client policy: units checked per document call (each unit costs its own exhaustive checks). */
export const MAX_DOCUMENT_UNITS = 50;
/** Client policy: largest manuscript file read for a document check (the review command's limit). */
const MAX_FILE_BYTES = 4_000_000;
/** Characters of the unit's own wording carried per unit (bounded, verbatim, pointer-bound). */
const EXCERPT_CHARS = 120;

export type DocumentUnitStatus = "supported" | "cited-unsupported" | "missing-citation" | "unsourced" | "unregistered";

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

function toUnits(req: DocumentRequest, root: string): { units: Unit[]; source: string } | { error: string } {
  if (req.document !== undefined) {
    const entry = resolveEntry(root, req.document);
    if (!entry.ok) return { error: entry.message };
    const lines = expandSource((rel) => {
      const f = resolveProjectFile(root, rel, MAX_FILE_BYTES);
      return f.ok ? readFileSync(f.abs, "utf8") : undefined;
    }, entry.rel.split(sep).join("/"));
    if (lines.length === 0) return { error: `${req.document} could not be read inside the project` };
    return { units: extractUnits(parsePaper(lines)), source: entry.rel.split(sep).join("/") };
  }
  return { units: extractUnits(parsePaper(linesFromString(req.text ?? "", "fragment.tex"))), source: "text" };
}

const excerptOf = (plain: string): string => (plain.length <= EXCERPT_CHARS ? plain : `${plain.slice(0, EXCERPT_CHARS - 1)}…`);

type ClaimResult = Record<string, any>;

async function checkClaim(ctx: ToolContext, db: ReturnType<typeof openRegistry>, req: { claim: string; papers: "all" | string[] }, hooks: WorkflowHooks): Promise<{ result: ClaimResult } | { code: RefusalCode; message: string }> {
  const out = await verifyWorkflow(ctx, db, req, hooks);
  if (out.kind === "refused") return { code: out.code, message: out.message };
  return { result: out.result };
}

const pointersOf = (r: ClaimResult): { pointers: string[]; citekeys: string[]; complete: boolean } => ({
  pointers: ((r.evidence as { pointer?: string }[] | undefined) ?? []).map((e) => String(e.pointer ?? "")).filter((p) => p !== ""),
  citekeys: [...new Set(((r.evidence as { citekey?: string }[] | undefined) ?? []).map((e) => String(e.citekey ?? "")).filter((k) => k !== ""))],
  complete: (r.result as { complete?: boolean } | undefined)?.complete !== false,
});

export async function documentWorkflow(ctx: ToolContext, db: ReturnType<typeof openRegistry>, req: DocumentRequest, hooks: WorkflowHooks): Promise<DocumentOutcome> {
  const got = toUnits(req, ctx.root);
  if ("error" in got) return refuse("ARGUMENT_INVALID", got.error);
  const { units: all, source } = got;
  const offset = req.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || (offset > 0 && offset >= all.length)) return refuse("ARGUMENT_INVALID", `offset must be an integer from 0 to ${Math.max(0, all.length - 1)}`);
  // A page of at most MAX_DOCUMENT_UNITS units (client policy); judgments are cached, so paging through a document costs nothing twice.
  const units = all.slice(offset, offset + MAX_DOCUMENT_UNITS);
  const next = offset + units.length < all.length ? offset + units.length : null;

  const results: DocumentUnitResult[] = [];
  let engine: ClaimResult["engine"] | null = null;
  let bar = 0.99;
  for (const unit of units) {
    const { selected, unresolved } = resolveScope(db, unit.cites.length > 0 ? unit.cites : "all");
    const base: DocumentUnitResult = {
      id: unit.id, kind: unit.kind, file: unit.file, line: unit.line, section: unit.section,
      excerpt: excerptOf(unit.plain), status: "unsourced", cites: unit.cites, pointers: [], suggested: [], complete: true,
    };
    if (unresolved.length > 0) {
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
        incomplete: results.filter((r) => !r.complete).length,
      },
      engine: engine ?? { name: "unknown", model: null, protocol: "unidentified", minConfidence: bar, cache: false },
      units: results,
      next,
    },
  };
}
