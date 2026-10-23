/**
 * Pi-only `write_section` child-session observability: the child's usage,
 * turns, retries and tool calls are tallied from its own events, the first
 * draft and the final text are counted separately, and the event subscription
 * is released on every settle path. The child is a fake session (no model).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as pi from "../src/pi/index.ts";
import * as ws from "../src/pi/write-section.ts";
import type { UnitVerdict, VerifyPage } from "../src/pi/write-section.ts";

type Listener = (event: unknown) => void;
interface FakeChild {
  messages: Array<Record<string, unknown>>;
  listeners: Set<Listener>;
  subscribes: number;
  unsubscribes: number;
  aborts: number;
  disposes: number;
  prompts: number;
  releaseGate?: () => void;
  subscribe: (listener: Listener) => () => void;
  emit: (event: unknown) => void;
  reply: (text: string, usage?: Record<string, unknown>) => void;
  prompt: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
}

const usage = (input: number, output: number, cost: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  cost: { total: cost },
});

/** A fake child session: `respond` decides what each prompt does (replies, events, waits). */
function fakeChild(respond: (child: FakeChild, n: number) => Promise<void>): FakeChild {
  const child: FakeChild = {
    messages: [],
    listeners: new Set(),
    subscribes: 0,
    unsubscribes: 0,
    aborts: 0,
    disposes: 0,
    prompts: 0,
    subscribe(listener) {
      child.subscribes += 1;
      child.listeners.add(listener);
      return () => {
        child.unsubscribes += 1;
        child.listeners.delete(listener);
      };
    },
    emit(event) {
      for (const l of [...child.listeners]) l(event);
    },
    reply(text, u = usage(10, 5, 0)) {
      const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: u };
      child.messages.push(message);
      child.emit({ type: "message_end", message });
    },
    async prompt(_text) {
      child.prompts += 1;
      await respond(child, child.prompts);
    },
    async abort() {
      child.aborts += 1;
      child.releaseGate?.();
    },
    dispose() {
      child.disposes += 1;
    },
  };
  return child;
}

/** The tool shape the specs drive: execute(id, params, signal, onUpdate, ctx). */
type Tool = { execute: (id: string, params: never, signal: AbortSignal | undefined, onUpdate: undefined, ctx: never) => Promise<unknown> };

const unit = (id: string, status: UnitVerdict["status"]): UnitVerdict => ({ id, excerpt: `claim ${id}`, status, suggested: [], pointers: [] });
const page = (units: UnitVerdict[]): VerifyPage => ({ units, summary: { total: units.length, from: 0, units: units.length }, next: null });

/** The write_section tool wired to a fake child (the SDK loader and the verify page are the only seams). */
function toolWith(child: FakeChild, verifyPage: (text: string, offset: number) => Promise<VerifyPage>) {
  const factory = (pi as Record<string, unknown>).makeSectionWriterTool as
    | ((seams: { loadSdk: () => Promise<unknown>; verifyPage: (text: string, offset: number) => Promise<VerifyPage> }) => Tool)
    | undefined;
  assert.equal(typeof factory, "function", "makeSectionWriterTool seam exported from src/pi/index.ts");
  return factory!({
    loadSdk: async () => ({
      createAgentSession: async () => ({ session: child }),
      SessionManager: { inMemory: () => ({}) },
    }),
    verifyPage,
  });
}

const ctx = {
  cwd: "/tmp/uktub-observability-fixture",
  tools: [{ name: "mcp__uktub_scholar__verify" }, { name: "mcp__uktub_scholar__passages" }],
  executeTool: async () => ({ content: [{ type: "text", text: "" }] }),
} as never;

const run = (tool: Tool, signal?: AbortSignal) =>
  tool.execute("call-1", { goal: "Cells age.", papers: "a" } as never, signal, undefined, ctx);

const details = (out: unknown): Record<string, any> => (out as { details: Record<string, any> }).details;
const text = (out: unknown): string => ((out as { content: Array<{ text: string }> }).content[0]!.text);
const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === "AbortError";

describe("write_section child observability: tally", () => {
  it("sums child turns, retries, tool calls and usage from its own events", async () => {
    const child = fakeChild(async (c) => {
      c.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "passages", args: {} });
      c.emit({ type: "tool_execution_start", toolCallId: "t2", toolName: "verify", args: {} });
      c.reply("Cells age faster. \\cite{a}", usage(100, 20, 0.01, 5, 2));
      c.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "overloaded" });
      c.reply("Cells age faster. \\cite{a}", usage(50, 10, 0.005));
    });
    const out = await run(toolWith(child, async () => page([unit("u1", "supported")])));
    const child2 = details(out).child;
    assert.equal(child2.turns, 2, "two assistant message ends are two turns");
    assert.equal(child2.retries, 1, "one auto-retry start");
    assert.equal(child2.toolCalls, 2, "two child tool executions");
    assert.equal(child2.usage.input, 150);
    assert.equal(child2.usage.output, 30);
    assert.equal(child2.usage.cacheRead, 5);
    assert.equal(child2.usage.cacheWrite, 2);
    assert.ok(Math.abs(child2.usage.costUsd - 0.015) < 1e-9, "cost is the sum of message totals");
    assert.ok(Number.isFinite(child2.wallMs) && child2.wallMs >= 0);
  });
});

describe("write_section child observability: first draft vs final", () => {
  it("reports the first draft's counts, the repaired final counts, and repaired=true", async () => {
    const child = fakeChild(async (c, n) => {
      if (n === 1) c.reply("Cells age faster. \\cite{a}\nThe moon is cheese.");
      else c.reply("Cells age faster. \\cite{a}\nThe moon is cheese, explicitly unverified.");
    });
    const verifyPage = async (t: string) =>
      t.includes("explicitly unverified")
        ? page([unit("u1", "supported"), unit("u2", "supported")])
        : page([unit("u1", "supported"), unit("u2", "unsourced")]);
    const out = await run(toolWith(child, verifyPage));
    const d = details(out);
    assert.deepEqual(d.firstDraft, { units: 2, ok: 1, incomplete: 0 });
    assert.deepEqual(d.final, { units: 2, ok: 2, incomplete: 0 });
    assert.equal(d.repaired, true);
    assert.equal(child.prompts, 2, "exactly one repair round");
    assert.match(text(out), /first draft 1\/2 supported; final 2\/2; 9 words/);
  });

  it("with no repair, first draft and final are the same and repaired=false", async () => {
    const child = fakeChild(async (c) => c.reply("Cells age faster. \\cite{a}"));
    const out = await run(toolWith(child, async () => page([unit("u1", "supported")])));
    const d = details(out);
    assert.deepEqual(d.firstDraft, { units: 1, ok: 1, incomplete: 0 });
    assert.deepEqual(d.final, { units: 1, ok: 1, incomplete: 0 });
    assert.equal(d.repaired, false);
    assert.equal(d.words, 3);
  });
});

describe("runWriteSection: section counts and words", () => {
  it("counts reader-visible words of the returned LaTeX, not citations or commands", async () => {
    const latex = "Cells age faster. \\cite{a}\nThe moon is cheese.";
    const d = {
      runWriter: async () => latex,
      verifyDocument: async () => page([unit("u1", "supported")]),
      abortWriter: async () => {},
      disposeWriter: () => {},
    };
    const out = (await ws.runWriteSection(d, { goal: "g", papers: ["a"] })) as unknown as Record<string, unknown>;
    assert.equal(out.words, 7, "Cells age faster. The moon is cheese.");
    assert.deepEqual(out.firstDraft, { units: 1, ok: 1, incomplete: 0 });
    assert.deepEqual(out.final, { units: 1, ok: 1, incomplete: 0 });
    assert.equal(out.repaired, false);
  });
});

describe("write_section child observability: subscription release", () => {
  it("unsubscribes exactly once on success", async () => {
    const child = fakeChild(async (c) => c.reply("Cells age faster. \\cite{a}"));
    await run(toolWith(child, async () => page([unit("u1", "supported")])));
    assert.equal(child.subscribes, 1);
    assert.equal(child.unsubscribes, 1, "released on success");
    assert.equal(child.listeners.size, 0);
    assert.equal(child.disposes, 1);
  });

  it("unsubscribes exactly once when the run is aborted mid-prompt", async () => {
    const child = fakeChild(async (c) => {
      await new Promise<void>((resolve) => {
        c.releaseGate = resolve;
      });
    });
    const controller = new AbortController();
    const p = run(toolWith(child, async () => page([unit("u1", "supported")])), controller.signal);
    while (child.prompts === 0) await new Promise((r) => setImmediate(r));
    controller.abort();
    await assert.rejects(p, isAbort);
    assert.equal(child.aborts, 1);
    assert.equal(child.unsubscribes, 1, "released on abort");
    assert.equal(child.listeners.size, 0);
  });

  it("unsubscribes exactly once when verification throws", async () => {
    const child = fakeChild(async (c) => c.reply("Cells age faster. \\cite{a}"));
    await assert.rejects(run(toolWith(child, async () => { throw new Error("verify broke"); })), /verify broke/);
    assert.equal(child.unsubscribes, 1, "released on throw");
    assert.equal(child.listeners.size, 0);
  });
});
