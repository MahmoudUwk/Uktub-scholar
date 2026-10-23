/**
 * Phase 8b pin: Pi's `write_section` tool definition and seamed result text,
 * captured before the move of the runtime-neutral pieces into `src/agent/`.
 * The refactor must keep every byte here identical.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { makeSectionWriterTool, sectionWriterTool } from "../src/pi/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("write_section Pi pin (Phase 8b refactor guard)", () => {
  it("tool definition (name, label, description, parameters JSON) is unchanged", () => {
    const pinned = JSON.parse(readFileSync(`${ROOT}tests/fixtures/write-section-tool-pin.json`, "utf8")) as Record<string, unknown>;
    assert.equal(sectionWriterTool.name, pinned.name);
    assert.equal(sectionWriterTool.label, pinned.label);
    assert.equal(sectionWriterTool.description, pinned.description);
    assert.deepEqual(JSON.parse(JSON.stringify(sectionWriterTool.parameters)), pinned.parameters);
  });

  it("seamed run result text is unchanged (LaTeX + --- + summary + counts + unresolved)", async () => {
    const messages: unknown[] = [];
    const listeners = new Set<(e: unknown) => void>();
    const session = {
      messages,
      subscribe: (l: (e: unknown) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      prompt: async (_text: string) => {
        const message = {
          role: "assistant",
          content: [{ type: "text", text: "Cells age faster. \\cite{a}" }],
          stopReason: "stop",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        };
        messages.push(message);
        for (const l of [...listeners]) l({ type: "message_end", message });
      },
      abort: async () => {},
      dispose: () => {},
    };
    const tool = makeSectionWriterTool({
      loadSdk: async () =>
        ({
          createAgentSession: async () => ({ session }),
          SessionManager: { inMemory: () => ({}) },
        }) as never,
      verifyPage: async () =>
        ({
          units: [{ id: "u1", excerpt: "Cells age faster.", status: "supported", suggested: [], pointers: ["doi@r#1-2"] }],
          summary: { total: 1, from: 0, units: 1 },
          next: null,
        }) as never,
      papersReady: async (_root: string, handles: readonly string[]) =>
        handles.map((h) => ({ handle: h, citekey: h, doi: null, state: "ready" as const, detail: null })),
    });
    const ctx = {
      cwd: "/tmp/uktub-pin",
      tools: [{ name: "mcp__uktub_scholar__verify" }, { name: "mcp__uktub_scholar__passages" }, { name: "mcp__uktub_scholar__registry" }],
      executeTool: async () => ({ content: [{ type: "text", text: "" }] }),
    } as never;
    const out = (await (tool.execute as unknown as (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>)(
      "call-1",
      { goal: "Say how cells age.", papers: "a" },
      undefined,
      undefined,
      ctx,
    ));
    assert.equal(
      out.content[0]!.text,
      "Cells age faster. \\cite{a}\n\n---\n1/1 supported (incomplete: 0), no repair needed.\nfirst draft 1/1 supported; final 1/1; 3 words\nUnresolved: none.",
    );
    assert.deepEqual(out.details.firstDraft, { units: 1, ok: 1, incomplete: 0 });
    assert.deepEqual(out.details.final, { units: 1, ok: 1, incomplete: 0 });
    assert.equal(out.details.repaired, false);
    assert.equal(out.details.words, 3);
  });
});
