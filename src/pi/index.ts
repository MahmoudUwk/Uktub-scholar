import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type, type Static } from "typebox";

import type { ToolContext } from "../core/tools/context.ts";
import { verifyClaimTool, type VerifyArgs } from "../core/tools/verify.ts";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, normalizeToolName } from "../core/tool-names.ts";
import { WriteQueue } from "../core/queue.ts";
import { createSafeDownloader } from "../core/source/download.ts";
import { coerceSectionArgs, parsePapersParam, runWriteSection, toSectionParams, type UnitVerdict } from "./write-section.ts";
import { AGENT_RULES } from "../core/agent-rules.ts";
import { BIN_PATH } from "../core/launch.ts";
import { BLOCK_PREFIX, type Notice, clearedIds, extractNotices, footerFor } from "../core/notices.ts";
import { destructiveToolOwnedCommand, toolOwnedViolation } from "../core/tool-owned.ts";

/** The bin shim of THIS package copy: `pi install` does not link bins onto PATH, so a bare `uktub-scholar` is ENOENT. */

export default function uktubScholarExtension(pi: ExtensionAPI): void {
  pi.registerMcpServer(MCP_SERVER_NAME, {
    command: process.execPath,
    args: [BIN_PATH, "mcp"],
    // Five small tools: declared to the model directly (the codemode default hides them from a small model).
    exposure: "direct",
    description: "Scholarly research for the project: search papers, manage the paper registry and bibliography, compile LaTeX, find passages, verify a claim against registered papers.",
  });
  // Pi gives the model one line of MCP server instructions, so the rules ride in the system prompt as guidelines.
  pi.on("before_agent_start", (event) => {
    const have = event.systemPromptOptions.promptGuidelines ?? [];
    event.systemPromptOptions.promptGuidelines = [...have, ...AGENT_RULES.filter((rule) => !have.includes(rule))];
  });
  // Honesty layer: models drop tool failures and warnings from their answers, so any notice a uktub tool result carried that the final
  // answer does not mention is appended to it (rules in the prompt are not enough for a small model).
  const pending = new Map<string, Notice>();
  const continuationRuns = new Map<string, string>();
  pi.on("agent_start", () => {
    pending.clear();
    continuationRuns.clear();
  });
  pi.on("tool_result", (event) => {
    const name = (event as { toolName?: string }).toolName ?? "";
    const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    // Canonical short names first; the hidden legacy aliases normalize to the same (existing callers keep their notices).
    const tool = normalizeToolName(name);
    const ours = name.startsWith(MCP_TOOL_PREFIX) || name.startsWith("mcp__uktub_scholar__");
    if (!ours && !text.startsWith(BLOCK_PREFIX)) return undefined;
    let runId: string | undefined;
    const { toolCallId, input } = event as { toolCallId?: string; input?: { continuation?: unknown } };
    if (tool === "verify" && toolCallId !== undefined) {
      runId = typeof input?.continuation === "string" ? (continuationRuns.get(input.continuation) ?? toolCallId) : toolCallId;
      const next = /^continuation: "([^"]+)"/m.exec(text)?.[1];
      if (next !== undefined) continuationRuns.set(next, runId);
    }
    for (const id of clearedIds(tool, text, runId)) pending.delete(id);
    for (const n of extractNotices(tool, text, event.isError, runId)) pending.set(n.id ?? `${n.key}|${n.line}`, n);
    return undefined;
  });
  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content) || pending.size === 0) return undefined;
    const blocks = message.content as { type: string; text?: string }[];
    if (blocks.some((b) => b.type === "toolCall")) return undefined; // not the final answer yet
    const footer = footerFor(blocks.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("\n"), [...pending.values()]);
    pending.clear();
    return footer === null ? undefined : { message: { ...event.message, content: [...blocks, { type: "text", text: footer }] } as never };
  });
  // Agent read-only, human writable: block the edit/write route to the registry and the rendered bibliography outright, and ask the
  // human before a shell command destroys or overwrites them (without a UI there is no one to ask, so it is blocked).
  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as { path?: unknown; command?: unknown };
    if (event.toolName === "edit" || event.toolName === "write") {
      const reason = typeof input.path === "string" ? toolOwnedViolation(ctx.cwd, input.path) : null;
      return reason === null ? undefined : { block: true, reason: `${BLOCK_PREFIX} ${reason}` };
    }
    if (event.toolName !== "bash" || typeof input.command !== "string") return undefined;
    const warning = destructiveToolOwnedCommand(input.command);
    if (warning === null) return undefined;
    if (ctx.hasUI && (await ctx.ui.confirm("uktub-scholar: destructive command", `${warning}\n\n${input.command}\n\nAllow it?`))) return undefined;
    return { block: true, reason: `${BLOCK_PREFIX} ${warning} ${ctx.hasUI ? "The user declined it." : "No one could be asked."} Do not work around this or try another command for the same effect; tell the user it was not run. If the user asks again explicitly, run the command again and the dialog will be raised again.` };
  });
  if (process.env.UKTUB_SECTION_WRITER === "on") pi.registerTool(sectionWriterTool);
}

/** Params schema of the section writer (papers is ONE string: never an array). */
export const WriteSectionParams = Type.Object({
  goal: Type.String({ description: "What this section must say" }),
  papers: Type.String({ description: "ONE string of citekeys separated by spaces or commas (never an array)" }),
  query: Type.Optional(Type.String({ description: "Focus: which passages of the papers to build the section from" })),
  max_words: Type.Optional(Type.Number({ description: "Longest the section may be, in words" })),
});
export type WriteSectionArgs = Static<typeof WriteSectionParams>;

const textOfOutcome = (outcome: unknown): string => {
  const blocks = (o: unknown): Array<{ type?: string; text?: string }> => {
    if (typeof o === "string") return [{ type: "text", text: o }];
    if (Array.isArray(o)) return o as Array<{ type?: string; text?: string }>;
    if (typeof o === "object" && o !== null) {
      const r = o as { content?: unknown; result?: unknown };
      if (Array.isArray(r.content)) return r.content as Array<{ type?: string; text?: string }>;
      if (typeof r.result === "object" && r.result !== null && Array.isArray((r.result as { content?: unknown }).content)) {
        return (r.result as { content: Array<{ type?: string; text?: string }> }).content;
      }
      return [{ type: "text", text: JSON.stringify(o).slice(0, 8000) }];
    }
    return [{ type: "text", text: String(o) }];
  };
  return blocks(outcome).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
};

/** A loaded Pi SDK: just the two constructors the section writer needs. */
interface PiSdk {
  createAgentSession: (typeof import("@earendil-works/pi-coding-agent"))["createAgentSession"];
  SessionManager: (typeof import("@earendil-works/pi-coding-agent"))["SessionManager"];
}

/**
 * Load the Pi SDK. The extension file runs inside the Pi process, but module
 * resolution starts at this package's directory (the peer is optional, so it
 * may not be there): fall back to Pi's own install by walking up from the
 * launched entry to its node_modules.
 */
async function loadPiSdk(): Promise<PiSdk> {
  const PKG = "@earendil-works/pi-coding-agent";
  try {
    return (await import(PKG)) as PiSdk;
  } catch {
    // the peer is optional: fall through to Pi's own install
  }
  // Pi's own install: walk up from the launched entry, the node binary and the
  // cwd. A directory holding node_modules/<pkg> is Pi's. (CJS
  // require.resolve cannot be used here: the package's exports map is
  // import-only, so require reports it missing. A global npm layout keeps the
  // binary at <prefix>/bin and the package at <prefix>/lib/node_modules, so
  // both shapes are tried.)
  const bases = new Set<string>([process.cwd(), dirname(process.execPath)]);
  try {
    if (process.argv[1] !== undefined) bases.add(dirname(realpathSync(process.argv[1])));
  } catch {
    // without an entry path only the other bases are tried
  }
  const reasons: string[] = [];
  for (const base of bases) {
    let dir = base;
    for (let i = 0; i < 10; i++) {
      for (const pkgDir of [join(dir, "node_modules", PKG), join(dir, "lib", "node_modules", PKG)]) {
        // The package root first; then the two core modules directly. The root
        // pulls the whole extension graph (codemode included), which a Pi
        // install with skewed nested copies cannot provide; the core modules
        // import cleanly on their own.
        const sdkEntry = entryOf(pkgDir);
        const candidates = sdkEntry !== null ? [sdkEntry, null] : [null];
        for (const entry of candidates) {
          try {
            if (entry !== null) return (await import(pathToFileURL(entry).href)) as PiSdk;
            const sdk = (await import(pathToFileURL(join(pkgDir, "dist", "core", "sdk.js")).href)) as PiSdk;
            const sm = (await import(pathToFileURL(join(pkgDir, "dist", "core", "session-manager.js")).href)) as PiSdk;
            if (typeof sdk.createAgentSession === "function" && typeof sm.SessionManager !== "undefined") {
              return { createAgentSession: sdk.createAgentSession, SessionManager: sm.SessionManager };
            }
            reasons.push(`${pkgDir}: core modules lack createAgentSession/SessionManager`);
          } catch (err) {
            reasons.push(`${entry ?? join(pkgDir, "dist", "core", "sdk.js")}: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
          }
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const seen = reasons.length > 0 ? ` Tried: ${reasons.slice(0, 3).join(" | ")}` : " No installed copy found.";
  throw new Error(`write_section needs ${PKG} resolvable from the installed package or from Pi's own install (peerDependencies carry it; it is optional).${seen}`);
}

/** Entry file of an installed copy of the Pi SDK, or null when absent. */
function entryOf(pkgDir: string): string | null {
  const manifest = join(pkgDir, "package.json");
  if (!existsSync(manifest)) return null;
  try {
    const json = JSON.parse(readFileSync(manifest, "utf8")) as {
      exports?: Record<string, { import?: string } | string>;
      main?: string;
    };
    const byExports = typeof json.exports?.["."] === "object" ? (json.exports["."] as { import?: string }).import : typeof json.exports?.["."] === "string" ? (json.exports["."] as string) : undefined;
    for (const rel of [byExports, json.main, "dist/index.js"]) {
      if (typeof rel === "string" && existsSync(join(pkgDir, rel))) return join(pkgDir, rel);
    }
  } catch {
    // unreadable manifest: not a usable install
  }
  return null;
}

/** Normalize a sub-session papers value to the MCP form ("all" or a list): models omit it or send JSON strings. */
export const normalizeForwardPapers = (args: unknown): unknown => {
  const o = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  if (o.papers === undefined) return { ...o, papers: "all" };
  if (o.papers === "all") return o;
  const keys = parsePapersParam(o.papers);
  return { ...o, papers: keys.length > 0 ? keys : "all" };
};

/** The sub-session's last non-empty assistant text (its final message may be a bare tool call). */
export function lastAssistantText(session: unknown): string {
  const messages = (session as { messages?: unknown }).messages;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { role?: unknown; content?: unknown };
      if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
      const text = m.content
        .map((b) => ((b as { type?: unknown; text?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
        .join("")
        .trim();
      if (text !== "") return text;
    }
  }
  const direct = (session as { getLastAssistantText?: unknown }).getLastAssistantText;
  if (typeof direct === "function") return (session as { getLastAssistantText: () => string | undefined }).getLastAssistantText() ?? "";
  return "";
}

/**
 * Pi-only section writer (gated on UKTUB_SECTION_WRITER=on): a sub-session on
 * the same model writes the section only from the listed papers' passages
 * (tools restricted to the Uktub `passages` and `verify` forwards), then the
 * text is checked with `verify` document mode with one repair round.
 * It never writes files: the manuscript is the user's and the main agent assembles it.
 */
export const sectionWriterTool: ToolDefinition<typeof WriteSectionParams> = {
  name: "write_section",
  label: "Write section from papers",
  description:
    "Write ONE manuscript section in LaTeX for `goal`, using only facts from passages of the listed papers. " +
    "`papers` is ONE string of citekeys separated by spaces or commas. Every factual sentence ends with \\cite{key}; " +
    "anything the papers do not support is left out or marked explicitly unverified. The section is verified as written " +
    "with `verify` document mode and failures get one repair round. Returns the LaTeX, a summary, and the unresolved units. " +
    "It never writes files: place the LaTeX into the manuscript yourself.",
  parameters: WriteSectionParams,
  prepareArguments: (args: unknown): WriteSectionArgs => coerceSectionArgs(args) as WriteSectionArgs,
  execute: async (toolCallId, params, signal, onUpdate, ctx: ExtensionToolContext) => {
    let section;
    try {
      section = toSectionParams(params as unknown as Record<string, unknown>);
    } catch (err) {
      return { content: [{ type: "text", text: `write_section refused: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
    }
    const mcpNameOf = (kind: "verify" | "passages"): string => {
      const name = ctx.tools.map((t) => (typeof (t as { name?: unknown }).name === "string" ? ((t as { name: string }).name) : "")).find((n) => normalizeToolName(n) === kind);
      if (!name) throw new Error(`write_section needs the ${kind} tool in the parent session`);
      return name;
    };
    let verifyName: string;
    let passagesName: string;
    try {
      verifyName = mcpNameOf("verify");
      passagesName = mcpNameOf("passages");
    } catch (err) {
      return { content: [{ type: "text", text: `write_section refused: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
    }
    // The SDK import is lazy (and dynamic): the extension file loads without it, and only a write_section call pays for it.
    const { createAgentSession, SessionManager } = await loadPiSdk();
    const forward = (kind: string, mcpName: string, description: string, parameters: ToolDefinition["parameters"]): ToolDefinition => ({
      name: kind,
      label: kind === "verify" ? "Verify claim" : "Search passages",
      description,
      parameters,
      execute: async (_id, p, _s, _u, _c) => ({ content: [{ type: "text", text: textOfOutcome(await ctx.executeTool(mcpName, normalizeForwardPapers(p))) }], details: {} }),
    });
    const { session } = await createAgentSession({
      ...(ctx.model !== undefined && ctx.model !== null ? { model: ctx.model as never } : {}),
      cwd: ctx.cwd,
      sessionManager: SessionManager.inMemory(),
      tools: ["passages", "verify"],
      excludeTools: ["mcp__*", "write_section"],
      customTools: [
        forward("passages", passagesName, "Search the registered papers for passages about a query.", Type.Object({ query: Type.String(), papers: Type.Optional(Type.String()) })),
        forward("verify", verifyName, "Check one claim against the registered papers.", Type.Object({ claim: Type.String(), papers: Type.Optional(Type.String()) })),
      ],
    });
    try {
      const out = await runWriteSection(
        {
          runWriter: async (prompt: string) => {
            await session.prompt(prompt);
            const text = lastAssistantText(session);
            if (text === "") throw new Error("the writer sub-session returned no text");
            return text;
          },
          verifyDocument: async (text: string) => {
            const vctx: ToolContext = {
              root: ctx.cwd,
              fetch: ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a)) as ToolContext["fetch"],
              env: process.env as Record<string, string | undefined>,
              now: () => new Date(),
              queue: new WriteQueue(),
              download: createSafeDownloader(),
            };
            const result = await verifyClaimTool(vctx, { text } as VerifyArgs);
            const refused = (result.details as { refused?: { code?: string; message?: string } }).refused;
            if (refused !== undefined) throw new Error(`verify document mode refused (${refused.code}): ${refused.message ?? ""}`);
            return { units: (result.structuredContent as { units: UnitVerdict[] }).units };
          },
        },
        { goal: section.goal, papers: section.papers, ...(section.query !== undefined ? { query: section.query } : {}), ...(section.maxWords !== undefined ? { maxWords: section.maxWords } : {}) },
      );
      void toolCallId;
      void signal;
      void onUpdate;
      const unresolved = out.unresolved.length === 0 ? "Unresolved: none." : `Unresolved:\n${out.unresolved.map((u) => `- [${u.id}] ${u.status}: "${u.excerpt}"`).join("\n")}`;
      return { content: [{ type: "text", text: `${out.latex}\n\n---\n${out.summary}\n${unresolved}` }], details: {} };
    } finally {
      session.dispose();
    }
  },
};
