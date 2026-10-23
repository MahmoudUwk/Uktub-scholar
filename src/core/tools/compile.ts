/**
 * `compile` tool: compile the project's LaTeX entry with a local
 * Tectonic engine. The engine is the user's (PATH or UKTUB_TECTONIC_BIN) — the
 * package owns detection, invocation, the build/ outdir, and diagnostics.
 * The compile runs inside the package write fence: build/ is a project write
 * like any registry transaction (KTD5).
 */

import { Type, type Static } from "typebox";

import { compileDocument, describeOutcome, prodSpawn, type CompileOutcome } from "../compile/run.ts";
import { renderSummary } from "../provenance/render.ts";
import { runProvenance } from "../provenance/run.ts";
import { minConfidenceFromEnv } from "../verify/claim.ts";
import { refusalResult, type ToolContext, type ToolResult } from "./context.ts";

export const CompileDocumentParams = Type.Object({
  entry: Type.Optional(
    Type.String({ description: "Project-relative .tex path; omit to use the default entry resolution" }),
  ),
});
export type CompileDocumentArgs = Static<typeof CompileDocumentParams>;

/** Client policy: figures listed in the structured provenance summary (the text summary lists its own, grouped by row). */
const PROVENANCE_ITEMS = 12;

const ProvenanceOutput = Type.Object({
  words: Type.Integer(),
  audited: Type.Integer(),
  verified: Type.Integer(),
  cited: Type.Integer(),
  uncited: Type.Integer(),
  figures: Type.Object({ ok: Type.Integer(), check: Type.Integer(), open: Type.Integer(), info: Type.Integer(), computed: Type.Integer() }),
  unregistered: Type.Array(Type.String()),
  items: Type.Array(
    Type.Object({ severity: Type.Union([Type.Literal("open"), Type.Literal("check")]), file: Type.String(), line: Type.Integer(), token: Type.String(), why: Type.String() }),
  ),
});

export const CompileDocumentOutput = Type.Object({
  status: Type.Union([Type.Literal("compiled"), Type.Literal("errors")]),
  engine: Type.String(),
  entry: Type.String(),
  pdfPath: Type.Union([Type.String(), Type.Null()]),
  pdfSizeBytes: Type.Union([Type.Integer(), Type.Null()]),
  diagnostics: Type.Array(
    Type.Object({
      severity: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
      file: Type.Optional(Type.String()),
      line: Type.Optional(Type.Integer()),
      message: Type.String(),
    }),
  ),
  diagnosticsTruncated: Type.Boolean(),
  provenance: Type.Optional(ProvenanceOutput),
});

export interface CompileDocumentStructured {
  status: "compiled" | "errors";
  engine: string;
  entry: string;
  pdfPath: string | null;
  pdfSizeBytes: number | null;
  diagnostics: CompileDocumentStructuredDiag[];
  diagnosticsTruncated: boolean;
  provenance?: Static<typeof ProvenanceOutput>;
}

interface CompileDocumentStructuredDiag {
  severity: "error" | "warning";
  file?: string;
  line?: number;
  message: string;
}

/**
 * The document's provenance as of this compile: which statements `verify` supported word for word, which figures no cited paper
 * contains, how long the body is. Additive and best effort: null without a registry or manuscript, and `UKTUB_PROVENANCE=off`
 * switches it off. It describes and never refuses (the manuscript belongs to the user).
 */
export function provenanceBlock(ctx: ToolContext, entry: string): { lines: string[]; structured: Static<typeof ProvenanceOutput> } | null {
  if (/^(0|false|off)$/i.test(ctx.env.UKTUB_PROVENANCE ?? "")) return null;
  const out = runProvenance({ root: ctx.root, entry, now: ctx.now, minConfidence: minConfidenceFromEnv(ctx.env) });
  if (!out.ok) return null;
  const lines = renderSummary(out.audit);
  if (lines.length === 0) return null;
  const s = out.audit.summary;
  const items = out.audit.items.flatMap((i) => (i.severity === "info" ? [] : [{ severity: i.severity, file: i.file, line: i.line, token: i.token, why: i.why }])).slice(0, PROVENANCE_ITEMS);
  return { lines, structured: { words: s.words, audited: s.audited, verified: s.verified, cited: s.cited, uncited: s.uncited, figures: s.figures, unregistered: s.unregistered, items } };
}

export async function compileDocumentTool(ctx: ToolContext, args: CompileDocumentArgs = {}): Promise<ToolResult<CompileDocumentStructured>> {
  const outcome: CompileOutcome = await ctx.queue.runExclusive(() =>
    compileDocument({ root: ctx.root, env: ctx.env, spawn: prodSpawn, signal: ctx.signal }, args.entry),
  );
  if (outcome.kind === "refusal") {
    return refusalResult({ code: outcome.code, message: outcome.message });
  }
  return compileToolResult(ctx, outcome, "tectonic");
}

/**
 * Shared outcome-to-tool-result assembly (Phase 7): the Node/Tectonic tool
 * and the browser/BusyTeX worker op build the identical result shape —
 * same keys, same `describeOutcome` layout, same provenance block — through
 * this function. `engineNoun` labels the engine ("tectonic" on Node,
 * "busytex" in the browser) in `engine` and the human text.
 */
export function compileToolResult(
  ctx: ToolContext,
  outcome: Exclude<CompileOutcome, { kind: "refusal" }>,
  engineNoun = "tectonic",
): ToolResult<CompileDocumentStructured> {
  const structured: CompileDocumentStructured = {
    status: outcome.kind,
    engine: `${engineNoun} ${outcome.engineVersion}`,
    entry: outcome.entry,
    pdfPath: outcome.kind === "compiled" ? outcome.pdfPath : null,
    pdfSizeBytes: outcome.kind === "compiled" ? outcome.pdfSizeBytes : null,
    diagnostics: outcome.diagnostics,
    diagnosticsTruncated: outcome.truncated,
  };
  const provenance = outcome.kind === "compiled" ? provenanceBlock(ctx, outcome.entry) : null;
  if (provenance !== null) structured.provenance = provenance.structured;
  return {
    content: [{ type: "text", text: provenance === null ? describeOutcome(outcome, engineNoun) : `${describeOutcome(outcome, engineNoun)}\n\n${provenance.lines.join("\n")}` }],
    structuredContent: structured,
    details: {},
  };
}
