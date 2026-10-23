/**
 * Pi pre-completion gate (owner decision D1, 2026-10-19): when a turn that touched a document is about to settle, the deterministic
 * provenance audit runs once more; unlabelled non-verified prose earns one bounded follow-up inside the same run (at most 2 per user
 * prompt). Fake Pi: an event registry and a stubbed audit seam; no network, no Pi runtime.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import uktubScholarExtension from "../src/pi/index.ts";
import { installCompletionGate, withinGateChild } from "../src/pi/completion-gate.ts";
import type { ProvenanceOutcome } from "../src/core/provenance/run.ts";

type Handler = (event: never, ctx: { cwd: string }) => unknown;

function fakePi(): { on: (event: string, fn: Handler) => void; handlers: Map<string, Handler[]>; fire: (event: string, payload: Record<string, unknown>, ctx?: { cwd: string }) => unknown } {
  const handlers = new Map<string, Handler[]>();
  return {
    handlers,
    on: (event, fn) => void handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    fire: (event, payload, ctx = { cwd: "/project" }) => {
      let result: unknown;
      for (const h of handlers.get(event) ?? []) {
        const r = h({ type: event, ...payload } as never, ctx);
        if (r !== undefined) result = r;
      }
      return result;
    },
  };
}

const sentence = (line: number, plain = `Unverified statement at line ${line}.`) => ({
  unit: { id: `u${line}`, kind: "sentence", file: "main.tex", line, section: "", raw: plain, plain, cites: ["smith2024"] },
  status: "cited",
  ledger: null,
  unregistered: [],
  figures: [],
  labelledUnverified: false,
});

/** A passing or failing provenance outcome with the given unlabelled units (count defaults to the list length). */
const outcome = (units: ReturnType<typeof sentence>[], count = units.length): ProvenanceOutcome => ({
  ok: true,
  entry: "main.tex",
  digest: "d",
  // only the summary fields the gate reads are faked
  audit: { summary: { unlabelledUnverified: count, labelledUnverified: 0 }, units, items: [], extracted: [] } as never,
} as ProvenanceOutcome);

const compileEnd = (id = "c1") => ({ toolName: "mcp__uktub__compile", toolCallId: id, result: {}, isError: false });
const settle = (overrides: Record<string, unknown> = {}) => ({ outcome: "completed", entries: [], continue: false, context: {}, ...overrides });
const userPrompt = { messageType: "user", prompt: "Write the review.", systemPromptOptions: {} };

const EXPECTED_HEAD = "Before finishing: 3 statement(s) in main.tex are neither verified as written nor labelled unverified:";
const EXPECTED_TAIL = 'Resolve each: verify it, rewrite it from a passage of its cited paper, delete it, or mark it with the word "unverified". Then recompile and list what remains unverified in your final answer.';

function gateWith(audit: (root: string) => ProvenanceOutcome): { pi: ReturnType<typeof fakePi>; calls: { n: number } } {
  const pi = fakePi();
  const calls = { n: 0 };
  installCompletionGate(pi as never, { audit: (root: string) => { calls.n += 1; return audit(root); } });
  return { pi, calls };
}

describe("completion gate: follow-up after a document turn", () => {
  it("compile happened and 3 statements are unlabelled: exactly one follow-up with the 3 pointers", () => {
    const { pi } = gateWith(() => outcome([sentence(10, "Alpha rose 4%."), sentence(12, "Beta fell."), sentence(14, "Gamma holds.")]));
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_execution_end", compileEnd());
    const out = pi.fire("agent_before_settle", settle()) as { continue?: boolean; entries?: { type: string; customType?: string; content?: string }[] };
    assert.equal(out.continue, true, "the run continues once");
    assert.equal(out.entries?.length, 1);
    assert.equal(out.entries?.[0]?.type, "custom_message");
    assert.equal(out.entries?.[0]?.customType, "uktub-completion-gate");
    assert.equal(
      out.entries?.[0]?.content,
      [EXPECTED_HEAD, '- L10 "Alpha rose 4%."', '- L12 "Beta fell."', '- L14 "Gamma holds."', EXPECTED_TAIL].join("\n"),
    );
  });

  it("a .tex write or edit (not only compile) also triggers the check", () => {
    const { pi } = gateWith(() => outcome([sentence(3, "Delta.")]));
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_call", { toolName: "edit", toolCallId: "e1", input: { path: "sections/intro.tex" } });
    pi.fire("tool_execution_end", { toolName: "edit", toolCallId: "e1", result: {}, isError: false });
    assert.equal((pi.fire("agent_before_settle", settle()) as { continue?: boolean } | undefined)?.continue, true);
  });

  it("a failed write of a .tex file does not count as touching the document", () => {
    const { pi, calls } = gateWith(() => outcome([sentence(3)]));
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_call", { toolName: "write", toolCallId: "w1", input: { path: "main.tex" } });
    pi.fire("tool_execution_end", { toolName: "write", toolCallId: "w1", result: {}, isError: true });
    assert.equal(pi.fire("agent_before_settle", settle()), undefined);
    assert.equal(calls.n, 0);
  });
});

describe("completion gate: silence when nothing to do", () => {
  it("compile happened but 0 statements are unlabelled: no follow-up", () => {
    const { pi } = gateWith(() => outcome([], 0));
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_execution_end", compileEnd());
    assert.equal(pi.fire("agent_before_settle", settle()), undefined);
  });

  it("no compile and no .tex write or edit: no follow-up, and the audit is not even called", () => {
    const { pi, calls } = gateWith(() => outcome([sentence(1), sentence(2), sentence(3)]));
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_execution_end", { toolName: "mcp__uktub__verify", toolCallId: "v1", result: {}, isError: false });
    pi.fire("tool_call", { toolName: "write", toolCallId: "w2", input: { path: "notes.md" } });
    pi.fire("tool_execution_end", { toolName: "write", toolCallId: "w2", result: {}, isError: false });
    assert.equal(pi.fire("agent_before_settle", settle()), undefined);
    assert.equal(calls.n, 0);
  });

  it("an aborted or errored run is not nagged, and the audit is not called", () => {
    const { pi, calls } = gateWith(() => outcome([sentence(1)]));
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_execution_end", compileEnd());
    assert.equal(pi.fire("agent_before_settle", settle({ outcome: "aborted" })), undefined);
    assert.equal(pi.fire("agent_before_settle", settle({ outcome: "error" })), undefined);
    assert.equal(calls.n, 0);
  });

  it("the audit fails (throws or reports an error): no follow-up and no exception escapes", () => {
    const thrown = gateWith(() => {
      throw new Error("registry locked");
    });
    thrown.pi.fire("before_agent_start", userPrompt);
    thrown.pi.fire("tool_execution_end", compileEnd());
    assert.doesNotThrow(() => thrown.pi.fire("agent_before_settle", settle()));
    assert.equal(thrown.pi.fire("agent_before_settle", settle()), undefined);

    const refused = gateWith(() => ({ ok: false, message: "no usable registry" }));
    refused.pi.fire("before_agent_start", userPrompt);
    refused.pi.fire("tool_execution_end", compileEnd());
    assert.equal(refused.pi.fire("agent_before_settle", settle()), undefined);
  });

  it("inside a write_section child session the gate never acts", async () => {
    const { pi, calls } = gateWith(() => outcome([sentence(1), sentence(2)]));
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_execution_end", compileEnd());
    const inChild = await withinGateChild(async () => pi.fire("agent_before_settle", settle()));
    assert.equal(inChild, undefined);
    assert.equal(calls.n, 0);
  });
});

describe("completion gate: cap and prompt boundaries", () => {
  it("at most two follow-ups per user prompt: the third agent stop in the same prompt gets none", () => {
    const { pi, calls } = gateWith(() => outcome([sentence(1), sentence(2)]));
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_execution_end", compileEnd());
    assert.equal((pi.fire("agent_before_settle", settle()) as { continue?: boolean } | undefined)?.continue, true);
    assert.equal((pi.fire("agent_before_settle", settle()) as { continue?: boolean } | undefined)?.continue, true);
    assert.equal(pi.fire("agent_before_settle", settle()), undefined);
    assert.equal(calls.n, 2, "the audit runs only for the follow-ups it can send");
  });

  it("a new user prompt resets the cap (and needs its own document touch)", () => {
    const { pi } = gateWith(() => outcome([sentence(1)]));
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_execution_end", compileEnd());
    pi.fire("agent_before_settle", settle());
    pi.fire("agent_before_settle", settle());
    assert.equal(pi.fire("agent_before_settle", settle()), undefined);

    pi.fire("before_agent_start", { ...userPrompt, prompt: "Now fix it." });
    assert.equal(pi.fire("agent_before_settle", settle()), undefined, "the new prompt has not touched the document yet");
    pi.fire("tool_execution_end", compileEnd("c2"));
    assert.equal((pi.fire("agent_before_settle", settle()) as { continue?: boolean } | undefined)?.continue, true, "the cap was reset");
  });

  it("a gate-triggered continuation (a custom run) does not reset the cap", () => {
    const { pi } = gateWith(() => outcome([sentence(1)]));
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_execution_end", compileEnd());
    pi.fire("agent_before_settle", settle());
    pi.fire("before_agent_start", { messageType: "custom", message: { customType: "uktub-completion-gate", content: "x" }, systemPromptOptions: {} });
    pi.fire("agent_before_settle", settle());
    assert.equal(pi.fire("agent_before_settle", settle()), undefined);
  });

  it("more than 10 unlabelled statements: 10 pointers then (and M more); the count is the audit's", () => {
    const units = Array.from({ length: 12 }, (_, i) => sentence(i + 1, `Claim ${i + 1}.`));
    const { pi } = gateWith(() => outcome(units));
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_execution_end", compileEnd());
    const content = (pi.fire("agent_before_settle", settle()) as { entries: { content: string }[] }).entries[0]!.content;
    const lines = content.split("\n");
    assert.equal(lines[0], "Before finishing: 12 statement(s) in main.tex are neither verified as written nor labelled unverified:");
    assert.deepEqual(lines.slice(1, 11), units.slice(0, 10).map((u) => `- L${u.unit.line} "${u.unit.plain}"`));
    assert.equal(lines[11], "(and 2 more)");
    assert.equal(lines[12], EXPECTED_TAIL);
    assert.equal(lines.length, 13);
  });

  it("excerpts are cut to 120 characters", () => {
    const long = "word ".repeat(60).trim();
    const { pi } = gateWith(() => outcome([sentence(7, long)]));
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_execution_end", compileEnd());
    const content = (pi.fire("agent_before_settle", settle()) as { entries: { content: string }[] }).entries[0]!.content;
    assert.equal(content.split("\n")[1], `- L7 "${long.slice(0, 120)}"`);
  });
});

describe("completion gate: unregistered citation keys", () => {
  const REGISTER_LINE = 'Register each paper that exists (registry register with its DOI or arXiv id), otherwise remove that \\cite and keep the statement only if it is marked with the word "unverified". Then recompile.';
  const keysOutcome = (units: ReturnType<typeof sentence>[], count: number, unregistered: string[]): ProvenanceOutcome => ({
    ok: true,
    entry: "main.tex",
    digest: "d",
    audit: { summary: { unlabelledUnverified: count, labelledUnverified: 0, unregistered }, units, items: [], extracted: [] } as never,
  } as ProvenanceOutcome);
  const contentOf = (pi: ReturnType<typeof fakePi>): string | undefined =>
    (pi.fire("agent_before_settle", settle()) as { entries?: { content: string }[] } | undefined)?.entries?.[0]?.content;

  it("0 unlabelled statements and one unregistered key after a compile: exactly one follow-up naming the key", () => {
    const { pi, calls } = gateWith(() => keysOutcome([], 0, ["smith2025retrieval"]));
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_execution_end", compileEnd());
    const out = pi.fire("agent_before_settle", settle()) as { continue?: boolean; entries?: { customType?: string; content?: string }[] };
    assert.equal(out.continue, true);
    assert.equal(out.entries?.length, 1);
    assert.equal(out.entries?.[0]?.customType, "uktub-completion-gate");
    assert.equal(
      out.entries?.[0]?.content,
      ["Before finishing: these citation keys are not in the registry: smith2025retrieval", REGISTER_LINE].join("\n"),
    );
    assert.equal(calls.n, 1);
  });

  it("unlabelled units and unregistered keys together: one follow-up, the unlabelled block first", () => {
    const { pi } = gateWith(() => keysOutcome([sentence(10, "Alpha rose 4%."), sentence(12, "Beta fell."), sentence(14, "Gamma holds.")], 3, ["smith2025retrieval"]));
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_execution_end", compileEnd());
    const out = pi.fire("agent_before_settle", settle()) as { continue?: boolean; entries?: { content: string }[] };
    assert.equal(out.continue, true);
    assert.equal(out.entries?.length, 1);
    assert.equal(
      out.entries?.[0]?.content,
      [
        EXPECTED_HEAD,
        '- L10 "Alpha rose 4%."',
        '- L12 "Beta fell."',
        '- L14 "Gamma holds."',
        EXPECTED_TAIL,
        "Also, these citation keys are not in the registry: smith2025retrieval",
        REGISTER_LINE,
      ].join("\n"),
    );
  });

  it("more than 10 unregistered keys: 10 keys then (and M more)", () => {
    const keys = Array.from({ length: 12 }, (_, i) => `k${String(i + 1).padStart(2, "0")}`);
    const { pi } = gateWith(() => keysOutcome([], 0, keys));
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_execution_end", compileEnd());
    const lines = (contentOf(pi) ?? "").split("\n");
    assert.equal(lines[0], `Before finishing: these citation keys are not in the registry: ${keys.slice(0, 10).join(", ")} (and 2 more)`);
    assert.equal(lines[1], REGISTER_LINE);
    assert.equal(lines.length, 2);
  });

  it("unregistered keys but no document touched: no follow-up and the audit is not called", () => {
    const { pi, calls } = gateWith(() => keysOutcome([], 0, ["smith2025retrieval"]));
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_execution_end", { toolName: "mcp__uktub__verify", toolCallId: "v1", result: {}, isError: false });
    assert.equal(pi.fire("agent_before_settle", settle()), undefined);
    assert.equal(calls.n, 0);
  });

  it("the cap of two follow-ups per prompt spans both kinds of problem", () => {
    const seq = [keysOutcome([], 0, ["a1"]), outcome([sentence(5)]), keysOutcome([sentence(6)], 1, ["b2"])];
    let audited = 0;
    const { pi, calls } = gateWith(() => seq[Math.min(audited++, seq.length - 1)]!);
    pi.fire("before_agent_start", userPrompt);
    pi.fire("tool_execution_end", compileEnd());
    assert.equal((pi.fire("agent_before_settle", settle()) as { continue?: boolean } | undefined)?.continue, true);
    assert.equal((pi.fire("agent_before_settle", settle()) as { continue?: boolean } | undefined)?.continue, true);
    assert.equal(pi.fire("agent_before_settle", settle()), undefined);
    assert.equal(calls.n, 2);
  });
});

describe("completion gate: switch and wiring", () => {
  const withEnv = (value: string | undefined, run: () => void): void => {
    const before = process.env.UKTUB_COMPLETION_GATE;
    if (value === undefined) delete process.env.UKTUB_COMPLETION_GATE;
    else process.env.UKTUB_COMPLETION_GATE = value;
    try {
      run();
    } finally {
      if (before === undefined) delete process.env.UKTUB_COMPLETION_GATE;
      else process.env.UKTUB_COMPLETION_GATE = before;
    }
  };
  const extensionPi = () => {
    const pi = fakePi();
    const api = { registerMcpServer: () => {}, on: pi.on, registerTool: () => {} };
    return { pi, api };
  };

  it("UKTUB_COMPLETION_GATE=off: the extension registers no settle handler, so nothing is sent", () => {
    withEnv("off", () => {
      const { pi, api } = extensionPi();
      uktubScholarExtension(api as never);
      assert.equal(pi.handlers.get("agent_before_settle"), undefined);
    });
  });

  it("the default (unset) registers the gate on the settle boundary", () => {
    withEnv(undefined, () => {
      const { pi, api } = extensionPi();
      uktubScholarExtension(api as never);
      assert.equal(pi.handlers.get("agent_before_settle")?.length, 1);
    });
  });

  it("the gate's own prompt handler does not displace the extension's before_agent_start handler (the last registered one)", () => {
    withEnv(undefined, () => {
      const { api } = extensionPi();
      let last: ((event: { systemPromptOptions: { promptGuidelines?: string[] } }) => unknown) | undefined;
      uktubScholarExtension({ ...api, on: (event: string, fn: never) => void (event === "before_agent_start" && (last = fn)) } as never);
      const event = { systemPromptOptions: { promptGuidelines: [] as string[] } };
      last?.(event);
      assert.ok(event.systemPromptOptions.promptGuidelines.length > 0, "the extension's guidelines handler is the one that runs");
    });
  });
});
