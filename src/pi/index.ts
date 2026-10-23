import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ToolContext } from "../core/tools/context.ts";
import { verifyClaimTool, type VerifyArgs } from "../core/tools/verify.ts";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, normalizeToolName } from "../core/tool-names.ts";
import { WriteQueue } from "../core/queue.ts";
import { createSafeDownloader } from "../core/source/download.ts";
import { coerceSectionArgs, createChildTally, runWriteSection, toSectionParams, type UnitVerdict, type VerifyPage } from "./write-section.ts";
import { composeSectionResultText, ForwardPassagesParams, ForwardVerifyParams, lastAssistantText, normalizeForwardPapers, verifyRefusalText, VERIFY_MALFORMED_TEXT, WriteSectionParams, type WriteSectionArgs } from "../agent/section-tool.ts";
/** The shared `write_section` definition (one identity for Pi and the browser); Pi's behavior is byte-identical. */
export {
  composeSectionResultText,
  coerceSectionArgs,
  ForwardPassagesParams,
  ForwardVerifyParams,
  lastAssistantText,
  normalizeForwardPapers,
  sectionCountsLine,
  toSectionParams,
  unresolvedBlock,
  verifyRefusalText,
  VERIFY_MALFORMED_TEXT,
  WriteSectionParams,
  WRITE_SECTION_DESCRIPTION,
  WRITE_SECTION_LABEL,
  WRITE_SECTION_NAME,
  type WriteSectionArgs,
} from "../agent/section-tool.ts";
import { AGENT_RULES } from "../core/agent-rules.ts";
import { BIN_PATH } from "../core/launch.ts";
import { BLOCK_PREFIX, type Notice, clearedIds, extractNotices, footerFor } from "../core/notices.ts";
import { destructiveToolOwnedCommand, toolOwnedViolation } from "../core/tool-owned.ts";
import { installCompletionGate, withinGateChild } from "./completion-gate.ts";
import { writingWorkflowSection } from "../agent/workflow.ts";

/** The bin shim of THIS package copy: `pi install` does not link bins onto PATH, so a bare `uktub-scholar` is ENOENT. */

export const SECTION_WRITER_RULE =
  "For multi-section documents, draft each prose section with `write_section` (pass `max_words` to stay within any length limit) and paste its returned LaTeX into the manuscript verbatim (rewriting invalidates verification; if trimming is needed, delete whole sentences rather than paraphrasing), then run `verify` on the full document.";

/** The document-writing section of the skill text (see `src/agent/workflow.ts`, runtime-neutral). */
export { writingWorkflowSection };

/** The section from a skill file on disk; null when the file cannot be read (the on-demand skill still exists). */
export function readWritingWorkflow(skillPath: string): string | null {
  try {
    return writingWorkflowSection(readFileSync(skillPath, "utf8"));
  } catch {
    return null;
  }
}

/** The shipped research skill, found from this module's URL: `src/pi` and `dist/pi` both sit two levels below the package root, as `bin/` does. */
export function bundledSkillPath(moduleUrl: string): string {
  return fileURLToPath(new URL("../../skills/uktub-research/SKILL.md", moduleUrl));
}

/** Always-on document workflow appended to every session's system prompt (2888 characters, measured from the current SKILL.md; client policy: its context cost is accepted). */
const WRITING_WORKFLOW = readWritingWorkflow(bundledSkillPath(import.meta.url));

export default function uktubScholarExtension(pi: ExtensionAPI): void {
  const sectionWriterEnabled = process.env.UKTUB_SECTION_WRITER !== "off";
  // Client policy (owner decision D1, 2026-10-19): the pre-completion gate is capped at 2 follow-ups per user prompt; UKTUB_COMPLETION_GATE=off disables it.
  // Installed first so its handlers never displace the extension's own (the last registered handler of an event is the one hosts keep in some fakes).
  if (process.env.UKTUB_COMPLETION_GATE !== "off") installCompletionGate(pi);
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
    const rules = [...(sectionWriterEnabled ? [...AGENT_RULES, SECTION_WRITER_RULE] : AGENT_RULES), ...(WRITING_WORKFLOW ? [WRITING_WORKFLOW] : [])];
    event.systemPromptOptions.promptGuidelines = [...have, ...rules.filter((rule) => !have.includes(rule))];
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
  if (sectionWriterEnabled) pi.registerTool?.(sectionWriterTool);
}

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

/**
 * Pi-only section writer (registered by default; set UKTUB_SECTION_WRITER=off to disable):
 * a sub-session on the same model writes the section only from the listed papers' passages
 * (tools restricted to the Uktub `passages` and `verify` forwards), then the
 * text is checked with `verify` document mode with one repair round.
 * It never writes files: the manuscript is the user's and the main agent assembles it.
 */
/** Test seams: the SDK loader and the one-page verify call (defaults: the real Pi SDK and the real verify tool). */
export interface SectionWriterSeams {
  loadSdk?: () => Promise<PiSdk>;
  verifyPage?: (text: string, offset: number) => Promise<VerifyPage>;
}

export const sectionWriterTool: ToolDefinition<typeof WriteSectionParams> = makeSectionWriterTool();

export function makeSectionWriterTool(seams: SectionWriterSeams = {}): ToolDefinition<typeof WriteSectionParams> {
  return {
  name: "write_section",
  label: "Write section from papers",
  description:
    "Write ONE manuscript section in LaTeX for `goal`, using only facts from passages of the listed papers. " +
    "`papers` is ONE string of citekeys separated by spaces or commas (or an array of citekeys). Every factual sentence ends with \\cite{key}; " +
    "anything the papers do not support is left out or marked explicitly unverified. The section is verified as written " +
    "with `verify` document mode and failures get one repair round. Returns the LaTeX, a summary, and the unresolved units. " +
    "It never writes files: paste the returned LaTeX into the manuscript verbatim (rewriting invalidates its verification) and resolve any listed unresolved units.",
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
    // Already cancelled: never create the child.
    signal?.throwIfAborted();
    const forward = (kind: string, mcpName: string, description: string, parameters: ToolDefinition["parameters"]): ToolDefinition => ({
      name: kind,
      label: kind === "verify" ? "Verify claim" : "Search passages",
      description,
      parameters,
      execute: async (_id, p, nestedSignal, _u, _c) => {
        // Both signals stay live: the parent's cancellation must never be
        // masked by the nested call's own signal.
        const combined =
          nestedSignal !== undefined && signal !== undefined
            ? AbortSignal.any([signal, nestedSignal])
            : (nestedSignal ?? signal);
        return {
          content: [
            {
              type: "text",
              text: textOfOutcome(
                await ctx.executeTool(mcpName, normalizeForwardPapers(p), combined !== undefined ? { signal: combined } : undefined),
              ),
            },
          ],
          details: {},
        };
      },
    });
    // Abort, settlement, and disposal are owned by runWriteSection (single
    // owner); this adapter only creates the session and passes the callbacks.
    {
      const startedMs = Date.now();
      const { createAgentSession, SessionManager } = await (seams.loadSdk ?? loadPiSdk)();
      // Abort after the SDK load but before creation: still nothing to clean up.
      signal?.throwIfAborted();
      const { session } = await createAgentSession({
        ...(ctx.model !== undefined && ctx.model !== null ? { model: ctx.model as never } : {}),
        cwd: ctx.cwd,
        sessionManager: SessionManager.inMemory(),
        tools: ["passages", "verify"],
        excludeTools: ["mcp__*", "write_section"],
        customTools: [
          forward("passages", passagesName, "Search the registered papers for passages about a query.", ForwardPassagesParams),
          forward("verify", verifyName, "Check one claim against the registered papers.", ForwardVerifyParams),
        ],
      });
      // Child-session totals come from its own events; released on every settle path below.
      const tally = createChildTally(startedMs);
      const detach = session.subscribe((event) => tally.record(event));
      // Abort, settlement, and disposal are owned by runWriteSection below:
      // an abort that raced creation arrives as an already-aborted signal,
      // so the owner aborts/settles/disposes the fresh session without prompting.
      let out;
      try {
        out = await runWriteSection(
        {
          runWriter: async (prompt: string) => {
            // Only this prompt's messages may supply section text: capture the
            // index first so a failed/empty turn can never return earlier text.
            const startIndex = session.messages.length;
            await withinGateChild(() => session.prompt(prompt));
            const text = lastAssistantText(session, startIndex);
            if (text === "") throw new Error("the writer sub-session returned no text");
            return text;
          },
          verifyDocument: seams.verifyPage ?? (async (text: string, offset: number) => {
            const vctx: ToolContext = {
              root: ctx.cwd,
              fetch: ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a)) as ToolContext["fetch"],
              env: process.env as Record<string, string | undefined>,
              now: () => new Date(),
              queue: new WriteQueue(),
              download: createSafeDownloader(),
              ...(signal !== undefined ? { signal } : {}),
            };
            const result = await verifyClaimTool(vctx, { text, offset } as VerifyArgs);
            const refused = (result.details as { refused?: { code?: string; message?: string } }).refused;
            if (refused !== undefined) throw new Error(verifyRefusalText(refused));
            const sc = result.structuredContent as { units: UnitVerdict[]; summary: { total: number; from: number; units: number }; next: number | null } | null | undefined;
            if (sc == null || !Array.isArray(sc.units) || typeof sc.summary?.total !== "number" || sc.next === undefined) {
              throw new Error(VERIFY_MALFORMED_TEXT);
            }
            return { units: sc.units, summary: sc.summary, next: sc.next };
          }),
          abortWriter: () => session.abort(),
          disposeWriter: () => session.dispose(),
        },
        { goal: section.goal, papers: section.papers, ...(section.query !== undefined ? { query: section.query } : {}), ...(section.maxWords !== undefined ? { maxWords: section.maxWords } : {}) },
        signal,
      );
      } finally {
        detach();
      }
      void toolCallId;
      void onUpdate;
      return {
        content: [{ type: "text", text: composeSectionResultText(out) }],
        details: { child: tally.stats(Date.now()), firstDraft: out.firstDraft, final: out.final, repaired: out.repaired, words: out.words },
      };
    }
  },
  };
}
