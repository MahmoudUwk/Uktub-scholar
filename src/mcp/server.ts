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
import { TOOL_DEFINITIONS } from "../core/tools/definitions.ts";
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
  compileDocumentTool,
  type CompileDocumentArgs,
} from "../core/tools/compile.ts";
import {
  paperRegistryTool,
  type PaperRegistryArgs,
} from "../core/tools/registry.ts";
import {
  searchPapersTool,
  type SearchPapersArgs,
} from "../core/tools/search.ts";
import {
  verifyClaimTool,
  type VerifyArgs,
} from "../core/tools/verify.ts";
import {
  searchPassagesTool,
  type SearchPassagesArgs,
} from "../core/tools/passages.ts";
import {
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
