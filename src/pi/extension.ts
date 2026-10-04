import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Type } from "typebox";

import { WriteQueue } from "../core/queue.ts";
import { guardToolCall } from "../core/guard.ts";
import { createSafeDownloader } from "../core/source/download.ts";
import { CompileDocumentOutput, compileDocumentTool } from "../core/tools/compile.ts";
import { PaperRegistryOutput, PaperRegistryParams, paperRegistryTool, type PaperRegistryArgs } from "../core/tools/registry.ts";
import { SearchPapersOutput, searchPapersTool } from "../core/tools/search.ts";
import { VerifyClaimOutput, VerifyClaimParams, verifyClaimTool, type VerifyClaimArgs } from "../core/tools/verify.ts";
import { refusalResult, validateContext, type ToolContext, type ToolResult } from "../core/tools/context.ts";
import { resolve } from "node:path";

/**
 * Registers the search, paper-registry, compile and verify-claim tools with
 * their TypeBox schemas. Requires pi.registerTool; execute receives the host's
 * five arguments, including ExtensionToolContext.cwd.
 */

/** How the model is told each tool fails (R7): the stable refusal shape. */
const REFUSAL_SEMANTICS =
  "On failure the result is an error carrying a stable code — " +
  "e.g. `Refused: CODE — what happened. Next: what to do.`";

/**
 * The project root, resolved ONCE per extension load (one load = one process
 * load in Pi's jiti extension loading). Pi passes the session cwd via the
 * tool `ctx` (ExtensionToolContext.cwd), so the first execute call fixes the
 * root; later cwd changes are deliberately ignored — one Pi session operates
 * one project, and re-rooting mid-session would scatter registry state.
 * Limitation: the factory itself receives no context, so a session started in
 * a different directory than its first tool call would pin the call-time cwd,
 * not the launch cwd.
 */
function makeRootResolver() {
  let resolvedRoot: string | null = null;
  return (ctx: ExtensionToolContext): string => {
    resolvedRoot ??= resolve(typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd());
    return resolvedRoot;
  };
}

const fetchLike: ToolContext["fetch"] = (...args) => globalThis.fetch(...args);

/** Env is read LIVE at call time: process.env reflects keys set after load. */
const liveEnv: ToolContext["env"] = process.env;

const now: ToolContext["now"] = () => new Date();

/** The package owns write serialization (KTD5): one queue per process. */
const queue = new WriteQueue();

/** The one place document bytes are fetched from third-party hosts (HTTPS only,
 *  public addresses only, bounded, credential-scoped). */
const download = createSafeDownloader();

function toolCtx(rootFor: (ctx: ExtensionToolContext) => string, ctx: ExtensionToolContext, signal?: AbortSignal): ToolContext | ToolResult<never> {
  const root = rootFor(ctx);
  // R16 enforcement point: the resolved root is validated once, fail-closed —
  // relative roots, `..` traversal, and protected segments refuse before any
  // tool touches the filesystem.
  const check = validateContext({
    root,
    fetch: fetchLike,
    env: liveEnv,
    now,
    queue,
  });
  if (!check.ok) return refusalResult({ code: "PATH_REFUSED", message: check.message });
  return { root, fetch: fetchLike, env: liveEnv, now, queue, download, signal };
}

/** Map a core tool result onto Pi's AgentToolResult (KTD6, KTD7). */
function toPiResult<T>(result: ToolResult<T>) {
  const refused = result.details["refused"] !== undefined;
  return {
    content: result.content,
    details: result.details,
    // Refusals keep details (code + next) for programmatic callers but carry
    // no structuredContent — it is reserved for schema-conforming successes.
    ...(refused ? { isError: true } : { structuredContent: result.structuredContent ?? undefined }),
  };
}

/** Register one core tool under its stable name with its declared schemas. */
function registerTool<TParams extends TSchema, TOut>(
  pi: ExtensionAPI,
  rootFor: (ctx: ExtensionToolContext) => string,
  def: {
    name: string;
    label: string;
    description: string;
    parameters: TParams;
    outputSchema: TSchema;
    run: (ctx: ToolContext, params: unknown) => Promise<ToolResult<TOut>> | ToolResult<TOut>;
  },
): void {
  const tool: ToolDefinition<TParams> = {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    outputSchema: def.outputSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // The host's cancellation reaches long work (source preparation,
      // verification) between units; already-committed writes stay committed
      // and queued sections land or roll back atomically (KTD5).
      const toolContext = toolCtx(rootFor, ctx, signal);
      if (!("root" in toolContext)) return toPiResult(toolContext);
      return toPiResult(await def.run(toolContext, params));
    },
  };
  pi.registerTool(tool);
}

export default function uktubScholarExtension(pi: ExtensionAPI): void {
  if (typeof pi.registerTool !== "function") {
    throw new Error(
      "Refused: PI_EXTENSION_API_UNAVAILABLE — uktub-scholar requires Pi 1.0+ exposing pi.registerTool. Next: upgrade Pi to >= 1.0.0.",
    );
  }
  const rootFor = makeRootResolver();

  // Registry guard: the package contract (.registry package-owned, refs/
  // agent-read-only) holds against the host's own tools, not just ours.
  // Absent `pi.on` (older host) the guard degrades to the documented
  // convention — tools and CLI still enforce their own refusals.
  if (typeof pi.on === "function") {
    let guardRoot: string | null = null;
    pi.on("tool_call", async (event: unknown, ctx: unknown) => {
      guardRoot ??= resolve(
        typeof (ctx as { cwd?: string } | null)?.cwd === "string" && (ctx as { cwd?: string }).cwd!.length > 0
          ? (ctx as { cwd?: string }).cwd!
          : process.cwd(),
      );
      const e = event as { toolName?: string; input?: unknown };
      const verdict = guardToolCall(guardRoot, e.toolName ?? "", e.input);
      return verdict.ok ? undefined : { block: true, reason: verdict.reason };
    });
  }

  registerTool(pi, rootFor, {
    name: "search_papers",
    label: "Search papers",
    description:
      "Search OpenAlex, Crossref, and Semantic Scholar for papers matching a query. " +
      "Returns merged candidates in a deterministic relevance order with per-provider warnings; " +
      "a single provider failing degrades the result, and a DOI-shaped query still searches. " +
      "At most 20 results per call (client policy after a tool-payload incident). " +
      REFUSAL_SEMANTICS,
    parameters: Type.Object({
      query: Type.String({ description: "Free-text scholarly query; DOI-shaped strings are allowed and hinted" }),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, description: "Max candidates to return (default 5, cap 20)" }),
      ),
    }),
    outputSchema: SearchPapersOutput,
    run: (ctx, params) => searchPapersTool(ctx, params as { query: string; limit?: number }),
  });

  registerTool(pi, rootFor, {
    name: "paper_registry",
    label: "Manage the paper registry",
    description:
      "Manage the project's paper collection in one tool. action=register: add papers by DOI or arxiv:YYMM.NNNNN " +
      "(at most 50); every input gets an outcome in order, aliases of one paper register once, a refresh keeps the pinned citekey. " +
      "action=remove: delete explicit DOIs/citekeys (at most 50; there is no remove-all). " +
      "action=read: list all papers or an explicit subset with the fields you ask for (default title, year, citable; also authors, venue, " +
      "bibtex, bibtexSource, abstract, source, refreshedAt), paged with a cursor. " +
      "action=attach_source: prepare a PDF or GROBID TEI file inside the project as a paper's source (at most 10); the file is neither copied " +
      "nor deleted and its text is never shown to you. action=sync_bibliography: re-render refs/references.bib from the registry. " +
      "A paper without provider BibTeX is citable: false — BibTeX is never synthesized. " +
      REFUSAL_SEMANTICS,
    parameters: PaperRegistryParams,
    outputSchema: PaperRegistryOutput,
    run: (ctx, params) => paperRegistryTool(ctx, params as PaperRegistryArgs),
  });

  registerTool(pi, rootFor, {
    name: "compile_document",
    label: "Compile the document",
    description:
      "Compile the project's LaTeX entry with a local Tectonic engine (the user's binary: PATH or " +
      "UKTUB_TECTONIC_BIN). Entry defaults to manuscript/main.tex, then main.tex, then a lone top-level " +
      ".tex; with several candidates the refusal names them. Output (PDF) lands in build/; structured " +
      "diagnostics (severity, file, line, message) come back on failure, so fix and recompile. " +
      "The engine must be installed — a missing engine is a refusal, not a download. " +
      REFUSAL_SEMANTICS,
    parameters: Type.Object({
      entry: Type.Optional(
        Type.String({ description: "Project-relative .tex path; omit to use the default entry resolution" }),
      ),
    }),
    outputSchema: CompileDocumentOutput,
    run: (ctx, params) => compileDocumentTool(ctx, params as { entry?: string }),
  });

  registerTool(pi, rootFor, {
    name: "verify_claim",
    label: "Find support for one claim",
    description:
      "Find support for ONE claim in the registered papers: papers is \"all\" or an explicit list of DOIs/citekeys. The package prepares " +
      "sources, searches and judges internally; you receive only supporting passages with exact pointers (doi@revision#start-end) and four " +
      "separate coverage reports — sources, candidates, work, output. \"No support found\" is not evidence that the claim is false. An " +
      "optional query only narrows WHICH passages are checked (the search is then query-limited, not exhaustive). If the response carries a " +
      "continuation, repeat the same request with it to continue unfinished checking or page more evidence. Rare direct path: " +
      "passages=[{source: pointer}|{text}] judges exactly those passages; text carries no paper provenance. Engine and bar come from " +
      "verification.* in config/chunking.yaml or the documented defaults. " +
      REFUSAL_SEMANTICS,
    parameters: VerifyClaimParams,
    outputSchema: VerifyClaimOutput,
    run: (ctx, params) => verifyClaimTool(ctx, params as VerifyClaimArgs),
  });
}
