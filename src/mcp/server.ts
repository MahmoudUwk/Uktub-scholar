/**
 * Unified Stdio MCP server for uktub-scholar (server id `uktub`).
 * Exposes the 6 canonical scholar tools over Model Context Protocol:
 * papers, registry, compile, verify, passages, doctor.
 */

import { readFileSync } from "node:fs";
import { AGENT_RULES } from "../core/agent-rules.ts";
import { MCP_SERVER_NAME, normalizeToolName } from "../core/tool-names.ts";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { WriteQueue } from "../core/queue.ts";
import { startBackgroundAcquisition } from "../core/verify/acquire.ts";
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
  VerifyParams,
  verifyClaimTool,
  type VerifyArgs,
} from "../core/tools/verify.ts";
import {
  SearchPassagesOutput,
  SearchPassagesParams,
  searchPassagesTool,
  type SearchPassagesArgs,
} from "../core/tools/passages.ts";
import {
  DoctorOutput,
  DoctorParams,
  doctorTool,
} from "../core/tools/doctor.ts";

export interface McpServerOptions {
  targetDir?: string;
  fetch?: ToolContext["fetch"];
  env?: ToolContext["env"];
  now?: ToolContext["now"];
  queue?: ToolContext["queue"];
  download?: ToolContext["download"];
  providerConfig?: ToolContext["providerConfig"];
  /** Milliseconds between progress heartbeats on a running tool call (default HEARTBEAT_MS). */
  heartbeatMs?: number;
}

/**
 * Client policy: hosts time a request out (Pi: 60 s) unless the server reports progress, and a verification on a CPU engine, the first
 * compile (tectonic fetches its TeX bundle) or a large attach can take longer. A heartbeat every 15 s keeps those calls alive.
 */
export const HEARTBEAT_MS = 15_000;

const REFUSAL_SEMANTICS =
  "On failure the result is an error carrying a stable code — " +
  "e.g. `Refused: CODE — what happened. Next: what to do.`";

export const TOOL_DEFINITIONS = [
  {
    name: "papers",
    description:
      "Search OpenAlex, Crossref, and Semantic Scholar for papers matching a query. " +
      "Returns merged candidates in a deterministic relevance order with per-provider warnings; " +
      "a single provider failing degrades the result, and a DOI-shaped query still searches. " +
      "At most 20 results per call (client policy after a tool-payload incident). " +
      REFUSAL_SEMANTICS,
    inputSchema: SearchPapersParams,
    outputSchema: SearchPapersOutput,
    title: "Search papers",
    // fixed provider APIs only; writes nothing
    annotations: { title: "Search papers", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "registry",
    description:
      "Manage the project's paper collection in one tool. action=register: add papers by DOI or arxiv:YYMM.NNNNN " +
      "(at most 50); every input gets an outcome in order, aliases of one paper register once, a refresh keeps the pinned citekey. " +
      "action=remove: delete explicit DOIs/citekeys (at most 50; there is no remove-all). " +
      "action=read: list all papers or an explicit subset with the fields you ask for (default title, year, citable; also authors, venue, " +
      "bibtex, bibtexSource, abstract, source, refreshedAt), paged with a cursor. " +
      "action=attach_source: prepare a PDF or GROBID TEI file inside the project as a paper's source (at most 10); the file is neither copied " +
      "nor deleted and its text is never shown to you. action=sync_bibliography: re-render refs/references.bib from the registry. " +
      "action=acquire: fetch an open-access source for papers that have none (omit handles for all of them; the same work registration starts in the background); " +
      "read with the source field shows each paper's source status: metadata_only, acquiring, ready, unavailable or failed. " +
      "A paper without provider BibTeX is citable: false — BibTeX is never synthesized. " +
      "Sources: register a paper only when the user asks or the text you write cites it, and only DOIs from search results or the user; " +
      "if the user says to use only the papers already registered, neither search nor register more. A paper the user names that is not " +
      "found is reported as not found: never substitute another work. refs/references.bib is rendered from the registry: never edit it by hand " +
      "(use sync_bibliography). Only if the user asks for a stub citation, write it in a separate .bib file with only the fields the user gave " +
      "and note={UNREGISTERED PLACEHOLDER - verify}, and say it is a placeholder. " +
      REFUSAL_SEMANTICS,
    inputSchema: PaperRegistryParams,
    outputSchema: PaperRegistryOutput,
    title: "Paper registry",
    // one annotation covers every action, so it is their union: `remove` deletes rows (cascading to sources and chunks), `sync_bibliography`
    // and `attach_source` overwrite, `register` refreshes records, `register` and `acquire` contact providers
    annotations: { title: "Paper registry", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "compile",
    description:
      "Compile the project's LaTeX entry with a local Tectonic engine (the user's binary: PATH or " +
      "UKTUB_TECTONIC_BIN). Entry defaults to manuscript/main.tex, then main.tex, then a lone top-level " +
      ".tex; with several candidates the refusal names them. Output (PDF) lands in build/; structured " +
      "diagnostics (severity, file, line, message) come back on failure, so fix and recompile. " +
      "The engine must be installed — a missing engine is a refusal, not a download. " +
      REFUSAL_SEMANTICS,
    inputSchema: CompileDocumentParams,
    outputSchema: CompileDocumentOutput,
    title: "Compile document",
    // writes only regenerable build/ output and fetches only its own TeX bundle
    annotations: { title: "Compile document", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "verify",
    description:
      "Find support for ONE claim in the registered papers: papers is \"all\" or an explicit list of DOIs/citekeys. The package prepares " +
      "sources, searches and judges internally; you receive only supporting passages with exact pointers (doi@revision#start-end) and four " +
      "separate coverage reports — sources, candidates, work, output. \"No support found\" is not evidence that the claim is false. " +
      "If verify cannot run, the claim stays unverified: passages you retrieved are unchecked reading, never support. An " +
      "optional query only narrows WHICH passages are checked (the search is then query-limited, not exhaustive). If the response carries a " +
      "continuation, repeat the same request with it to continue unfinished checking or page more evidence. Rare direct path: " +
      "passages=[{source: pointer}|{text}] judges exactly those passages; text carries no paper provenance. Engine and bar come from " +
      "verification.* in config/chunking.yaml or the documented defaults. " +
      "Document mode (exclusive with the above): {document: project-relative .tex path} or {text: LaTeX fragment} checks the text " +
      "as written, one unit at a time (cited units against their own papers, uncited units against all papers), with per-unit " +
      "supported | cited-unsupported | missing-citation | unsourced | unregistered. At most 50 units per call (client policy); " +
      "exhaustive per unit at the configured bar, so it is slow with local Eos. " +
      REFUSAL_SEMANTICS,
    inputSchema: VerifyParams,
    outputSchema: VerifyClaimOutput,
    title: "Verify claim",
    // adds a run and evidence rows on each fresh call and acquires sources on demand
    annotations: { title: "Verify claim", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "passages",
    description:
      "Exploratory retrieval over the registered papers' full text: describe a topic, question or phrase and get the best-matching passages, " +
      "each with its paper, section, page, an exact pointer (doi@revision#start-end) and a verbatim excerpt (withheld, with its reason, when it " +
      "would export too much of one paper — the pointer still identifies it). papers is \"all\" (default) or an explicit list of DOIs/citekeys; " +
      "limit at most 10. Search is keyword (BM25) and, when an embedding server is configured (UKTUB_EMBED_URL), semantic as well; a failing " +
      "embedder degrades to keyword results and says so. Results are retrieval, not verification: check a claim with verify before you cite it. " +
      REFUSAL_SEMANTICS,
    inputSchema: SearchPassagesParams,
    outputSchema: SearchPassagesOutput,
    title: "Search passages",
    // builds a derived passage index (converges after the first call); no network on the default path
    annotations: { title: "Search passages", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "doctor",
    description:
      "Diagnose the setup and say what is wrong and how to fix it: whether claim verification can run now (the configured " +
      "engine, with one minimal probe of the hosted endpoint when it is configured), whether the registry is present, whether " +
      "a LaTeX engine is available, and which optional provider keys are set. Takes no arguments. " +
      "For any check that reports an error, tell the user the fix. " +
      REFUSAL_SEMANTICS,
    inputSchema: DoctorParams,
    outputSchema: DoctorOutput,
    title: "Diagnose setup",
    // read-only; the hosted probe contacts only the configured verification endpoint
    annotations: { title: "Diagnose setup", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
] as const;

/**
 * Canonical short tool names (and the hidden legacy aliases) live in
 * `src/core/tool-names.ts`; re-exported here for existing importers.
 */
export { normalizeToolName } from "../core/tool-names.ts";
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** The shared rules (`src/core/agent-rules.ts`) as the MCP handshake's instructions. */
export const SERVER_INSTRUCTIONS = [`uktub: scholarly tools over the user's project. The registry is the bibliography.`, ...AGENT_RULES.map((rule) => `- ${rule}`)].join("\n");

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
    const ctx: ToolContext = { ...rawCtx, root };
    // The registration hook: this process is long-lived, so a newly registered paper's open-access copy is fetched in the background
    // (bounded, deduplicated with verify and `acquire`). UKTUB_ACQUIRE_ON_REGISTER=0 turns it off.
    if (!/^(0|false|off)$/i.test(env.UKTUB_ACQUIRE_ON_REGISTER ?? "")) {
      ctx.afterRegister = (dois) => {
        void startBackgroundAcquisition({ ...ctx, signal: undefined }, dois);
      };
    }
    return ctx;
  }

  const server = new Server(
    {
      name: MCP_SERVER_NAME,
      version: PACKAGE_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
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

    // MCP progress: only when the client sent a progressToken; notifications/progress resets the host's request timeout.
    const progressToken = request.params._meta?.progressToken;
    const started = Date.now();
    let beat = 0;
    const heartbeat =
      progressToken === undefined
        ? null
        : setInterval(() => {
            beat += 1;
            void extra
              .sendNotification({ method: "notifications/progress", params: { progressToken, progress: beat, message: `uktub: ${toolName} still working (${Math.round((Date.now() - started) / 1000)} s)` } })
              .catch(() => {});
          }, options.heartbeatMs ?? HEARTBEAT_MS);

    try {
      switch (toolName) {
        case "papers":
          return toCallToolResult(await searchPapersTool(toolCtx, safeArgs as SearchPapersArgs));
        case "registry":
          return toCallToolResult(await paperRegistryTool(toolCtx, safeArgs as PaperRegistryArgs));
        case "compile":
          return toCallToolResult(await compileDocumentTool(toolCtx, safeArgs as CompileDocumentArgs));
        case "verify":
          return toCallToolResult(await verifyClaimTool(toolCtx, safeArgs as VerifyArgs));
        case "passages":
          return toCallToolResult(await searchPassagesTool(toolCtx, safeArgs as SearchPassagesArgs));
        case "doctor":
          return toCallToolResult(await doctorTool(toolCtx, {}));
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
    } finally {
      if (heartbeat !== null) clearInterval(heartbeat);
    }
  });

  return server;
}
