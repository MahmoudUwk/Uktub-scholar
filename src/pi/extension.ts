import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Type } from "typebox";

import { WriteQueue } from "../core/queue.ts";
import { ListPapersOutput, listPapersTool } from "../core/tools/list.ts";
import { RegisterPapersOutput, registerPapersTool } from "../core/tools/register.ts";
import { SearchPapersOutput, searchPapersTool } from "../core/tools/search.ts";
import { refusalResult, validateContext, type ToolContext, type ToolResult } from "../core/tools/context.ts";
import { resolve } from "node:path";

/**
 * Uktub Scholar Pi extension (U5, R14, KTD7): registers exactly the three v0 tools
 * and nothing else — no prompt mutation, no commands, no providers — and fails
 * closed at load if the Pi 1.0 API surface is missing.
 *
 * Installed-type notes (they win over the plan's quotes):
 *  - `execute` is 5-arg: `(toolCallId, params, signal, onUpdate, ctx)`; the
 *    plan documented a 4-arg form.
 *  - `ToolDefinition.outputSchema?: TSchema` exists — the core tools' TypeBox
 *    output schemas are declared to the host verbatim.
 *  - `ExtensionToolContext.cwd` exists — used for the one-time root resolution.
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

function toolCtx(rootFor: (ctx: ExtensionToolContext) => string, ctx: ExtensionToolContext): ToolContext | ToolResult<never> {
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
  return { root, fetch: fetchLike, env: liveEnv, now, queue };
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // `signal` is not forwarded: the core FetchLike surface takes no abort
      // signal in v0; a cancelled call's writes still serialize through the
      // queue and land or roll back atomically (KTD5).
      const toolContext = toolCtx(rootFor, ctx);
      if (!("root" in toolContext)) return toPiResult(toolContext);
      return toPiResult(await def.run(toolContext, params));
    },
  };
  pi.registerTool(tool);
}

export default function uktubOaExtension(pi: ExtensionAPI): void {
  if (typeof pi.registerTool !== "function") {
    throw new Error(
      "Refused: PI_EXTENSION_API_UNAVAILABLE — uktub-scholar requires Pi 1.0+ exposing pi.registerTool. Next: upgrade Pi to >= 1.0.0.",
    );
  }
  const rootFor = makeRootResolver();

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
    name: "register_papers",
    label: "Register papers by DOI",
    description:
      "Register papers by DOI (at most 50 per call — client policy): resolves each DOI to provider " +
      "metadata and provider-supplied BibTeX, writes the local registry, and re-renders " +
      "refs/references.bib. Returns one outcome per DOI in input order (registered | updated | refused). " +
      "A paper without provider BibTeX registers as citable: false — BibTeX is never synthesized. " +
      "Citekeys are pinned once and never re-keyed. " +
      REFUSAL_SEMANTICS,
    parameters: Type.Object({
      dois: Type.Array(Type.String(), { maxItems: 50, description: "DOIs in their 10.xxxx/suffix form" }),
    }),
    outputSchema: RegisterPapersOutput,
    run: (ctx, params) => registerPapersTool(ctx, params as { dois: string[] }),
  });

  registerTool(pi, rootFor, {
    name: "list_papers",
    label: "List registered papers",
    description:
      "List every paper in the local registry in citekey order — citekey, DOI, title, authors, year, " +
      "venue, citability, and BibTeX provenance — so you can pick stable \\cite{} keys. " +
      "Over the cap the result is explicitly truncated with a remaining count. " +
      REFUSAL_SEMANTICS,
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Max rows to return (cap 200)" })),
    }),
    outputSchema: ListPapersOutput,
    run: (ctx, params) => listPapersTool(ctx, params as { limit?: number }),
  });
}
