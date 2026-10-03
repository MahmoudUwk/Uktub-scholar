/**
 * `compile_document` tool: compile the project's LaTeX entry with a local
 * Tectonic engine. The engine is the user's (PATH or UKTUB_TECTONIC_BIN) — the
 * package owns detection, invocation, the build/ outdir, and diagnostics.
 * The compile runs inside the package write fence: build/ is a project write
 * like any registry transaction (KTD5).
 */

import { Type } from "typebox";

import { compileDocument, describeOutcome, prodSpawn, type CompileOutcome } from "../compile/run.ts";
import { refusalResult, type ToolContext, type ToolResult } from "./context.ts";

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
});

export interface CompileDocumentStructured {
  status: "compiled" | "errors";
  engine: string;
  entry: string;
  pdfPath: string | null;
  pdfSizeBytes: number | null;
  diagnostics: CompileDocumentStructuredDiag[];
  diagnosticsTruncated: boolean;
}

interface CompileDocumentStructuredDiag {
  severity: "error" | "warning";
  file?: string;
  line?: number;
  message: string;
}

export async function compileDocumentTool(ctx: ToolContext, args: { entry?: string } = {}): Promise<ToolResult<CompileDocumentStructured>> {
  const outcome: CompileOutcome = await ctx.queue.runExclusive(() =>
    compileDocument({ root: ctx.root, env: ctx.env, spawn: prodSpawn }, args.entry),
  );
  if (outcome.kind === "refusal") {
    return refusalResult({ code: outcome.code, message: outcome.message });
  }
  const structured: CompileDocumentStructured = {
    status: outcome.kind,
    engine: `tectonic ${outcome.engineVersion}`,
    entry: outcome.entry,
    pdfPath: outcome.kind === "compiled" ? outcome.pdfPath : null,
    pdfSizeBytes: outcome.kind === "compiled" ? outcome.pdfSizeBytes : null,
    diagnostics: outcome.diagnostics,
    diagnosticsTruncated: outcome.truncated,
  };
  return {
    content: [{ type: "text", text: describeOutcome(outcome) }],
    structuredContent: structured,
    details: {},
  };
}
