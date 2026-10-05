/**
 * Unified Stdio MCP server for uktub-scholar.
 * Exposes the 5 canonical scholar tools over Model Context Protocol:
 * search_papers, paper_registry, compile_document, verify_claim, search_passages.
 */

import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { WriteQueue } from "../core/queue.ts";
import { createSafeDownloader } from "../core/source/download.ts";
import {
  refusalResult,
  validateContext,
  type Confinement,
  type ToolContext,
  type ToolResult,
} from "../core/tools/context.ts";
import {
  CompileDocumentOutput,
  CompileDocumentParams,
  compileDocumentTool,
  type CompileDocumentArgs,
} from "../core/tools/compile.ts";
import {
  PaperRegistryOutput,
  PaperRegistryParams,
  paperRegistryTool,
  type PaperRegistryArgs,
} from "../core/tools/registry.ts";
import {
  SearchPapersOutput,
  SearchPapersParams,
  searchPapersTool,
  type SearchPapersArgs,
} from "../core/tools/search.ts";
import {
  VerifyClaimOutput,
  VerifyClaimParams,
  verifyClaimTool,
  type VerifyClaimArgs,
} from "../core/tools/verify.ts";
import {
  SearchPassagesOutput,
  SearchPassagesParams,
  searchPassagesTool,
  type SearchPassagesArgs,
} from "../core/tools/passages.ts";

export interface McpServerOptions {
  targetDir?: string;
  fetch?: ToolContext["fetch"];
  env?: ToolContext["env"];
  now?: ToolContext["now"];
  queue?: ToolContext["queue"];
  download?: ToolContext["download"];
  providerConfig?: ToolContext["providerConfig"];
}

const REFUSAL_SEMANTICS =
  "On failure the result is an error carrying a stable code — " +
  "e.g. `Refused: CODE — what happened. Next: what to do.`";

export const TOOL_DEFINITIONS = [
  {
    name: "search_papers",
    description:
      "Search OpenAlex, Crossref, and Semantic Scholar for papers matching a query. " +
      "Returns merged candidates in a deterministic relevance order with per-provider warnings; " +
      "a single provider failing degrades the result, and a DOI-shaped query still searches. " +
      "At most 20 results per call (client policy after a tool-payload incident). " +
      REFUSAL_SEMANTICS,
    inputSchema: SearchPapersParams,
    outputSchema: SearchPapersOutput,
  },
  {
    name: "paper_registry",
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
    inputSchema: PaperRegistryParams,
    outputSchema: PaperRegistryOutput,
  },
  {
    name: "compile_document",
    description:
      "Compile the project's LaTeX entry with a local Tectonic engine (the user's binary: PATH or " +
      "UKTUB_TECTONIC_BIN). Entry defaults to manuscript/main.tex, then main.tex, then a lone top-level " +
      ".tex; with several candidates the refusal names them. Output (PDF) lands in build/; structured " +
      "diagnostics (severity, file, line, message) come back on failure, so fix and recompile. " +
      "The engine must be installed — a missing engine is a refusal, not a download. " +
      REFUSAL_SEMANTICS,
    inputSchema: CompileDocumentParams,
    outputSchema: CompileDocumentOutput,
  },
  {
    name: "verify_claim",
    description:
      "Find support for ONE claim in the registered papers: papers is \"all\" or an explicit list of DOIs/citekeys. The package prepares " +
      "sources, searches and judges internally; you receive only supporting passages with exact pointers (doi@revision#start-end) and four " +
      "separate coverage reports — sources, candidates, work, output. \"No support found\" is not evidence that the claim is false. An " +
      "optional query only narrows WHICH passages are checked (the search is then query-limited, not exhaustive). If the response carries a " +
      "continuation, repeat the same request with it to continue unfinished checking or page more evidence. Rare direct path: " +
      "passages=[{source: pointer}|{text}] judges exactly those passages; text carries no paper provenance. Engine and bar come from " +
      "verification.* in config/chunking.yaml or the documented defaults. " +
      REFUSAL_SEMANTICS,
    inputSchema: VerifyClaimParams,
    outputSchema: VerifyClaimOutput,
  },
  {
    name: "search_passages",
    description:
      "Exploratory retrieval over the registered papers' full text: describe a topic, question or phrase and get the best-matching passages, " +
      "each with its paper, section, page, an exact pointer (doi@revision#start-end) and a verbatim excerpt (withheld, with its reason, when it " +
      "would export too much of one paper — the pointer still identifies it). papers is \"all\" (default) or an explicit list of DOIs/citekeys; " +
      "limit at most 10. Search is keyword (BM25) and, when an embedding server is configured (UKTUB_EMBED_URL), semantic as well; a failing " +
      "embedder degrades to keyword results and says so. Results are retrieval, not verification: check a claim with verify_claim before you cite it. " +
      REFUSAL_SEMANTICS,
    inputSchema: SearchPassagesParams,
    outputSchema: SearchPassagesOutput,
  },
] as const;

/**
 * Normalize host-namespaced tool identifiers (e.g. `mcp__uktub_scholar__search_papers`
 * or `uktub-scholar/search_papers`) to the bare scholar tool name.
 */
export function normalizeToolName(name: string): string {
  return name.replace(/^(?:mcp__)?uktub[-_]scholar(?:_{1,2}|[/:])/, "");
}

export function validateTargetDir(targetDir?: string): Confinement {
  const root = targetDir ?? process.cwd();
  return validateContext({
    root,
    fetch: () => {
      throw new Error("unreachable");
    },
    env: {},
    now: () => new Date(),
    queue: { runExclusive: async (fn) => fn() },
  });
}

export function toCallToolResult<T>(result: ToolResult<T>): CallToolResult {
  const isRefusal = result.details["refused"] !== undefined;
  const out: CallToolResult = {
    content: result.content,
  };
  if (isRefusal) {
    out.isError = true;
  }
  if (!isRefusal && result.structuredContent !== null && result.structuredContent !== undefined) {
    out.structuredContent = result.structuredContent as Record<string, unknown>;
  }
  return out;
}

export function createMcpServer(targetDirOrOptions?: string | McpServerOptions): Server {
  const options: McpServerOptions =
    typeof targetDirOrOptions === "string"
      ? { targetDir: targetDirOrOptions }
      : (targetDirOrOptions ?? {});

  const rawTarget = options.targetDir;
  let rawRoot: string;
  if (rawTarget !== undefined) {
    if (rawTarget.split(/[\\/]/).includes("..")) {
      rawRoot = rawTarget;
    } else {
      rawRoot = resolve(rawTarget);
    }
  } else {
    rawRoot = process.cwd();
  }
  const root = resolve(rawRoot);
  const queue = options.queue ?? new WriteQueue();
  const download = options.download ?? createSafeDownloader();
  const fetchFn = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const now = options.now ?? (() => new Date());

  function getContext(signal?: AbortSignal): ToolContext | ToolResult<never> {
    const rawCtx: ToolContext = {
      root: rawRoot,
      fetch: fetchFn,
      env,
      now,
      queue,
      download,
      providerConfig: options.providerConfig,
      signal,
    };
    const confinement = validateContext(rawCtx);
    if (!confinement.ok) {
      return refusalResult({ code: confinement.code, message: confinement.message });
    }
    return { ...rawCtx, root };
  }

  const server = new Server(
    {
      name: "uktub-scholar",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as unknown as {
          type: "object";
          properties?: Record<string, unknown>;
          required?: string[];
          [key: string]: unknown;
        },
        outputSchema: tool.outputSchema as unknown as {
          type: "object";
          properties?: Record<string, unknown>;
          required?: string[];
          [key: string]: unknown;
        },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolCtx = getContext(extra?.signal);
    if (!("root" in toolCtx)) {
      return toCallToolResult(toolCtx);
    }

    const { name, arguments: args } = request.params;
    const toolName = normalizeToolName(name);
    const safeArgs = typeof args === "object" && args !== null && !Array.isArray(args) ? args : {};

    try {
      switch (toolName) {
        case "search_papers":
          return toCallToolResult(await searchPapersTool(toolCtx, safeArgs as SearchPapersArgs));
        case "paper_registry":
          return toCallToolResult(await paperRegistryTool(toolCtx, safeArgs as PaperRegistryArgs));
        case "compile_document":
          return toCallToolResult(await compileDocumentTool(toolCtx, safeArgs as CompileDocumentArgs));
        case "verify_claim":
          return toCallToolResult(await verifyClaimTool(toolCtx, safeArgs as VerifyClaimArgs));
        case "search_passages":
          return toCallToolResult(await searchPassagesTool(toolCtx, safeArgs as SearchPassagesArgs));
        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error executing tool ${name}: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

export async function runMcpServer(targetDirOrOptions?: string | McpServerOptions): Promise<void> {
  const server = createMcpServer(targetDirOrOptions);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
