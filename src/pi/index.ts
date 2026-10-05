import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_RULES } from "../core/agent-rules.ts";
import { type Notice, extractNotices, footerFor } from "../core/notices.ts";
import { toolOwnedViolation } from "../core/tool-owned.ts";

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
    if (!name.startsWith(TOOL_PREFIX)) return undefined;
    const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    for (const n of extractNotices(name.slice(TOOL_PREFIX.length), text, event.isError)) pending.set(`${n.key}|${n.line}`, n);
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
  // Agent read-only, human writable: block the ordinary edit/write route to the registry and the rendered bibliography.
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    const path = (event.input as { path?: unknown }).path;
    const reason = typeof path === "string" ? toolOwnedViolation(ctx.cwd, path) : null;
    return reason === null ? undefined : { block: true, reason };
  });
}
