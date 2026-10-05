import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_RULES } from "../core/agent-rules.ts";
import { BLOCK_PREFIX, type Notice, clearedIds, extractNotices, footerFor } from "../core/notices.ts";
import { destructiveToolOwnedCommand, toolOwnedViolation } from "../core/tool-owned.ts";

/** Pi names an MCP server's tools `mcp__<server>__<tool>`. */
const TOOL_PREFIX = "mcp__uktub_scholar__";
/** The bin shim of THIS package copy: `pi install` does not link bins onto PATH, so a bare `uktub-scholar` is ENOENT. */
const BIN = fileURLToPath(new URL("../../bin/uktub-scholar.js", import.meta.url));

export default function uktubScholarExtension(pi: ExtensionAPI): void {
  pi.registerMcpServer("uktub-scholar", {
    command: process.execPath,
    args: [BIN, "mcp"],
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
  pi.on("agent_start", () => void pending.clear());
  pi.on("tool_result", (event) => {
    const name = (event as { toolName?: string }).toolName ?? "";
    const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    if (!name.startsWith(TOOL_PREFIX) && !text.startsWith(BLOCK_PREFIX)) return undefined;
    const tool = name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
    for (const id of clearedIds(tool, text)) pending.delete(id);
    for (const n of extractNotices(tool, text, event.isError)) pending.set(n.id ?? `${n.key}|${n.line}`, n);
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
}
