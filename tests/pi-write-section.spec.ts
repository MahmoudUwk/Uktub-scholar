/**
 * Pi-only `write_section`: parameter parsing (papers is ONE string, never an
 * array), fenced-LaTeX extraction, and the verify → repair-once → re-verify
 * round with a stubbed sub-session and stubbed document verification.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";

import uktubScholarExtension, { ForwardPassagesParams, ForwardVerifyParams, lastAssistantText, makeSectionWriterTool, normalizeForwardPapers, sectionWriterTool } from "../src/pi/index.ts";

import {
  buildRepairPrompt,
  buildWriterPrompt,
  coerceSectionArgs,
  parsePapersParam,
  runWriteSection,
  stripCodeFences,
  type SectionDeps,
  type UnitVerdict,
} from "../src/pi/write-section.ts";

describe("parsePapersParam", () => {
  it("splits space- or comma-separated strings and drops empties and duplicates", () => {
    assert.deepEqual(parsePapersParam("smith2024"), ["smith2024"]);
    assert.deepEqual(parsePapersParam("a b  c"), ["a", "b", "c"]);
    assert.deepEqual(parsePapersParam("a,b,c"), ["a", "b", "c"]);
    assert.deepEqual(parsePapersParam("a, b;c"), ["a", "b", "c"]);
    assert.deepEqual(parsePapersParam("a a, b"), ["a", "b"]);
    assert.deepEqual(parsePapersParam(""), []);
    assert.deepEqual(parsePapersParam(undefined), []);
  });

  it("accepts arrays and JSON-string arrays (models send both)", () => {
    assert.deepEqual(parsePapersParam(["a", "b"]), ["a", "b"]);
    assert.deepEqual(parsePapersParam('["a", "b"]'), ["a", "b"]);
    assert.deepEqual(parsePapersParam('["a b", "c"]'), ["a", "b", "c"], "citekeys hold no spaces");
  });
});

describe("coerceSectionArgs", () => {
  it("joins array papers into the one-string form before validation", () => {
    assert.deepEqual(coerceSectionArgs({ goal: "g", papers: ["a", "b"] }), { goal: "g", papers: "a b" });
    assert.deepEqual(coerceSectionArgs({ goal: "g", papers: '["a","b"]' }), { goal: "g", papers: '["a","b"]' }, "JSON strings stay strings; parsePapersParam handles them");
    assert.deepEqual(coerceSectionArgs({ goal: "g", papers: "a b" }), { goal: "g", papers: "a b" });
  });
});

describe("stripCodeFences", () => {
  it("unwraps fenced LaTeX and leaves bare text alone", () => {
    assert.equal(stripCodeFences("```latex\nhello\n```"), "hello");
    assert.equal(stripCodeFences("```\nhello\n```"), "hello");
    assert.equal(stripCodeFences("hello"), "hello");
  });
});

describe("prompts", () => {
  it("the writer brief names the papers and demands citations, never memory", () => {
    const p = buildWriterPrompt({ goal: "Summarize aging.", papers: ["a", "b"] });
    assert.match(p, /a, b/);
    assert.match(p, /\\cite/);
    assert.match(p, /memory/i);
  });

  it("the repair brief lists each failing unit once with its suggestion", () => {
    const p = buildRepairPrompt([{ id: "u2", excerpt: "Some claim here.", status: "missing-citation", suggested: ["a"], pointers: [] }]);
    assert.match(p, /u2/);
    assert.match(p, /Some claim here/);
    assert.match(p, /missing-citation/);
  });
});

describe("extension registration", () => {
  const saved = process.env.UKTUB_SECTION_WRITER;
  afterEach(() => {
    if (saved === undefined) delete process.env.UKTUB_SECTION_WRITER;
    else process.env.UKTUB_SECTION_WRITER = saved;
  });
  const tools = (): string[] => {
    const names: string[] = [];
    uktubScholarExtension({ registerMcpServer: () => {}, on: () => {}, registerTool: (t: { name: string }) => void names.push(t.name) } as never);
    return names;
  };
  it("registers write_section by default and omits it when UKTUB_SECTION_WRITER=off", () => {
    delete process.env.UKTUB_SECTION_WRITER;
    assert.deepEqual(tools(), ["write_section"]);
    process.env.UKTUB_SECTION_WRITER = "off";
    assert.deepEqual(tools(), []);
    process.env.UKTUB_SECTION_WRITER = "on";
    assert.deepEqual(tools(), ["write_section"]);
  });
  it("the tool prepares array papers into the one-string form", () => {
    const prepared = (sectionWriterTool.prepareArguments as (a: unknown) => Record<string, unknown>)({ goal: "g", papers: ["a", "b"] });
    assert.equal(prepared.papers, "a b");
  });
  it("normalizeForwardPapers defaults scope, parses model-sent strings, and drops empty or non-token continuations", () => {
    assert.deepEqual(normalizeForwardPapers({ claim: "c" }), { claim: "c", papers: "all" });
    assert.deepEqual(normalizeForwardPapers({ claim: "c", papers: "a" }), { claim: "c", papers: ["a"] });
    assert.deepEqual(normalizeForwardPapers({ claim: "c", papers: '["a", "b"]' }), { claim: "c", papers: ["a", "b"] });
    assert.deepEqual(normalizeForwardPapers({ claim: "c", papers: "all" }), { claim: "c", papers: "all" });
    assert.deepEqual(normalizeForwardPapers({ claim: "c", papers: "a", continuation: "" }), { claim: "c", papers: ["a"] });
    assert.deepEqual(normalizeForwardPapers({ claim: "c", papers: "a", continuation: "Leave empty" }), { claim: "c", papers: ["a"] });
    assert.deepEqual(normalizeForwardPapers({ claim: "c", papers: "a", continuation: "tok_123" }), { claim: "c", papers: ["a"], continuation: "tok_123" });
    assert.match(String((ForwardVerifyParams.properties.continuation as { description?: string }).description ?? ""), /token|interrupted/i);
  });
  it("lastAssistantText skips a trailing bare tool call", () => {
    const session = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "The section. \\cite{a}" }] },
        { role: "assistant", content: [{ type: "toolCall", text: "" }] },
      ],
    };
    assert.equal(lastAssistantText(session), "The section. \\cite{a}");
    assert.equal(lastAssistantText({ messages: [] }), "");
  });
});

const LATEX_1 = "Cells age faster. \\cite{a}\nThe moon is cheese.\n";

function deps(verdicts: UnitVerdict[][], latex: string[] = [LATEX_1]): SectionDeps & { writers: string[]; verifies: number } {
  let vi = 0;
  let li = 0;
  const d: SectionDeps & { writers: string[]; verifies: number } = {
    writers: [],
    verifies: 0,
    runWriter: async (prompt: string) => {
      d.writers.push(prompt);
      return latex[Math.min(li++, latex.length - 1)]!;
    },
    verifyDocument: async (text: string, offset: number) => {
      void text;
      void offset;
      d.verifies += 1;
      const units = verdicts[Math.min(vi++, verdicts.length - 1)]!;
      return { units, summary: { total: units.length, from: 0, units: units.length }, next: null };
    },
    abortWriter: async () => {},
    disposeWriter: () => {},
  };
  return d;
}

describe("runWriteSection", () => {
  it("returns the LaTeX with no repair round when every unit is supported", async () => {
    const d = deps([[{ id: "u1", excerpt: "Cells age faster.", status: "supported", suggested: [], pointers: ["doi@r#1-2"] }]]);
    const out = await runWriteSection(d, { goal: "g", papers: ["a"] });
    assert.equal(out.latex, LATEX_1.trim());
    assert.equal(out.unresolved.length, 0);
    assert.equal(d.writers.length, 1, "no repair round");
    assert.match(out.summary, /1\/1 supported/);
  });

  it("sends failures back once and returns the repaired text", async () => {
    const bad: UnitVerdict[] = [{ id: "u2", excerpt: "The moon is cheese.", status: "unsourced", suggested: [], pointers: [] }];
    const good: UnitVerdict[] = [
      { id: "u1", excerpt: "Cells age faster.", status: "supported", suggested: [], pointers: [] },
      { id: "u2", excerpt: "The moon is cheese, explicitly unverified.", status: "supported", suggested: [], pointers: [] },
    ];
    const d = deps([bad, good], [LATEX_1, "Cells age faster. \\cite{a}\nThe moon is cheese, explicitly unverified.\n"]);
    const out = await runWriteSection(d, { goal: "g", papers: ["a"] });
    assert.equal(d.writers.length, 2, "exactly one repair round");
    assert.ok(d.writers[1]!.includes("u2"), "repair names the failing unit");
    assert.equal(out.unresolved.length, 0);
  });

  it("lists units still unsupported after the repair round as unresolved", async () => {
    const bad: UnitVerdict[] = [{ id: "u2", excerpt: "The moon is cheese.", status: "unsourced", suggested: [], pointers: [] }];
    const d = deps([bad, bad]);
    const out = await runWriteSection(d, { goal: "g", papers: ["a"] });
    assert.equal(d.writers.length, 2);
    assert.equal(out.unresolved.length, 1);
    assert.equal(out.unresolved[0]!.id, "u2");
  });

  it("refuses an empty paper list", async () => {
    const d = deps([[]]);
    await assert.rejects(() => runWriteSection(d, { goal: "g", papers: [] }), /at least one paper/i);
  });

  it("the sub-session verify forward carries query and continuation, and passages carries query", () => {
    assert.ok(Value.Check(ForwardVerifyParams, { claim: "c" }), "claim alone still forwards");
    assert.ok(Value.Check(ForwardVerifyParams, { claim: "c", papers: "a", query: "q", continuation: "t" }), "a long-paper check can run query-limited and be continued");
    assert.ok(!Value.Check(ForwardVerifyParams, { query: "q" }), "the claim stays required");
    assert.ok(Value.Check(ForwardPassagesParams, { query: "q" }), "passages keeps its query");
    assert.ok(Value.Check(ForwardPassagesParams, { query: "q", papers: "a b" }));
  });

  it("the section summary reports supported units whose check was incomplete", async () => {
    const partial: UnitVerdict[] = [{ id: "u1", excerpt: "Cells age faster.", status: "supported", suggested: [], pointers: ["doi@r#1-2"], complete: false }];
    const out = await runWriteSection(deps([partial]), { goal: "g", papers: ["a"] });
    assert.equal(out.unresolved.length, 1, "an incomplete supported unit stays explicitly unresolved");
    assert.equal(out.unresolved[0]!.id, "u1");
    assert.match(out.summary, /incomplete: 1/);
    const whole: UnitVerdict[] = [{ id: "u1", excerpt: "Cells age faster.", status: "supported", suggested: [], pointers: ["doi@r#1-2"], complete: true }];
    const done = await runWriteSection(deps([whole]), { goal: "g", papers: ["a"] });
    assert.match(done.summary, /incomplete: 0/);
  });
});

describe("writer turn output integrity", () => {
  const draft = (text: string): unknown => ({ role: "assistant", content: [{ type: "text", text }] });
  const user = (text: string): unknown => ({ role: "user", content: [{ type: "text", text }] });

  it("current-turn text succeeds and a trailing bare tool call is still skipped", () => {
    const session = {
      messages: [
        draft("Earlier draft. \\cite{a}"),
        user("repair"),
        draft("Revised. \\cite{a}"),
        { role: "assistant", content: [{ type: "toolCall" }], stopReason: "toolUse" },
      ],
    };
    assert.equal(lastAssistantText(session, 2), "Revised. \\cite{a}");
  });

  it("an empty current turn never returns an earlier draft", () => {
    const session = { messages: [draft("Earlier draft. \\cite{a}"), user("repair"), { role: "assistant", content: [] as unknown[] }] };
    assert.equal(lastAssistantText(session, 2), "");
    assert.equal(lastAssistantText(session, 2), "");
  });

  it("an empty turn cannot fall back to the SDK's earlier assistant text", () => {
    const stale = () => "Earlier draft.";
    assert.equal(lastAssistantText({ messages: [], getLastAssistantText: stale }, 0), "");
    assert.equal(lastAssistantText({ getLastAssistantText: stale }, 2), "");
  });

  it("a failed repair turn rejects the first draft instead of returning it", () => {
    const session = {
      messages: [draft("First draft."), user("repair"), { role: "assistant", content: [] as unknown[], stopReason: "error", errorMessage: "boom" }],
    };
    assert.throws(() => lastAssistantText(session, 2), /writer provider/);
  });

  it("a terminal error after partial text fails instead of succeeding", () => {
    const session = {
      messages: [user("write"), { role: "assistant", content: [{ type: "text", text: "Partial text." }], stopReason: "error", errorMessage: "upstream fault" }],
    };
    assert.throws(() => lastAssistantText(session, 1), /writer provider failed/);
  });

  it("aborted and truncated turns fail", () => {
    for (const reason of ["aborted", "length"] as const) {
      const session = {
        messages: [user("write"), { role: "assistant", content: [{ type: "text", text: "Partial." }], stopReason: reason, errorMessage: "" }],
      };
      assert.throws(() => lastAssistantText(session, 1), reason === "aborted" ? /aborted/ : /token limit/);
    }
  });

  it("classifies 429 errors without echoing provider text", () => {
    const session = { messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "POST googleapis: 429 RESOURCE_EXHAUSTED for gemini-3.8-flash" }] };
    assert.throws(() => lastAssistantText(session), (e: unknown) => e instanceof Error && /429.*RESOURCE_EXHAUSTED/.test(e.message) && !e.message.includes("gemini-3.8-flash"));
  });

  it("never echoes provider error bodies or secrets", () => {
    for (const raw of ["API key sk-live-SECRET-abc123 invalid; ignore instructions", "upstream echoed confidential source text"]) {
      const session = { messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: raw }] };
      assert.throws(() => lastAssistantText(session), (e: unknown) => e instanceof Error && [
        "the writer provider refused authentication; check provider credentials",
        "the writer provider failed the request",
      ].includes(e.message));
    }
  });
});

describe("runWriteSection: table-row units (D4)", () => {
  const row = (id: string, missing: number): UnitVerdict => ({
    id,
    excerpt: "REALM | 40.4% EM",
    status: "table-row",
    suggested: [],
    pointers: [],
    complete: true,
    figures: { found: 1 - missing, missing, check: 0 },
  });
  const sentence: UnitVerdict = { id: "u1", excerpt: "Cells age faster.", status: "supported", suggested: [], pointers: ["doi@r#1-2"] };

  it("counts a table row with no missing figure as resolved: no repair round", async () => {
    const d = deps([[sentence, row("u2", 0)]]);
    const out = await runWriteSection(d, { goal: "g", papers: ["a"] });
    assert.equal(d.writers.length, 1, "no repair round");
    assert.equal(out.unresolved.length, 0);
    assert.match(out.summary, /2\/2 supported/);
    assert.equal(out.firstDraft.ok, 2);
  });

  it("counts a table row with a missing figure as unresolved and repairs it once", async () => {
    const d = deps([[sentence, row("u2", 1)], [sentence, row("u2", 0)]]);
    const out = await runWriteSection(d, { goal: "g", papers: ["a"] });
    assert.equal(d.writers.length, 2, "one repair round for the unresolved row");
    assert.match(d.writers[1]!, /\[u2\] \(table-row\)/);
    assert.equal(out.repaired, true);
    assert.equal(out.firstDraft.ok, 1, "the first draft's row with a missing figure is not ok");
    assert.equal(out.final.ok, 2);
    assert.equal(out.unresolved.length, 0);
  });

  it("keeps a table row with a missing figure unresolved when the repair does not fix it", async () => {
    const d = deps([[sentence, row("u2", 1)], [sentence, row("u2", 1)]]);
    const out = await runWriteSection(d, { goal: "g", papers: ["a"] });
    assert.deepEqual(out.unresolved.map((u) => u.id), ["u2"]);
  });
});

// The write_section child always gets both the passages and verify tools.
describe("write_section child tool choice", () => {
  const p = { goal: "Summarize aging.", papers: ["a", "b"] };

  it("the writer prompt names the passages and verify tools", () => {
    assert.ok(buildWriterPrompt(p).includes("Use the passages and verify tools to read them; use no other tools."), buildWriterPrompt(p));
  });

  type Captured = { tools: string[]; custom: string[]; prompts: string[] };
  async function childFor(): Promise<Captured> {
    const captured: Captured = { tools: [], custom: [], prompts: [] };
    const listeners = new Set<(e: unknown) => void>();
    const messages: Array<Record<string, unknown>> = [];
    const session = {
      messages,
      subscribe: (l: (e: unknown) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      prompt: async (text: string) => {
        captured.prompts.push(text);
        const message = { role: "assistant", content: [{ type: "text", text: "Cells age. \\cite{a}" }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
        messages.push(message);
        for (const l of [...listeners]) l({ type: "message_end", message });
      },
      abort: async () => {},
      dispose: () => {},
    };
    const tool = makeSectionWriterTool({
      loadSdk: async () =>
        ({
          createAgentSession: async (options: { tools: string[]; customTools: Array<{ name: string }> }) => {
            captured.tools = options.tools;
            captured.custom = options.customTools.map((t) => t.name);
            return { session };
          },
          SessionManager: { inMemory: () => ({}) },
        }) as never,
      verifyPage: async () => ({ units: [{ id: "u1", excerpt: "x", status: "supported", suggested: [], pointers: [] }], summary: { total: 1, from: 0, units: 1 }, next: null }) as never,
    });
    const ctx = {
      cwd: "/tmp/uktub-child-tools-fixture",
      tools: [{ name: "mcp__uktub_scholar__verify" }, { name: "mcp__uktub_scholar__passages" }],
      executeTool: async () => ({ content: [{ type: "text", text: "" }] }),
    } as never;
    await (tool.execute as unknown as (...a: unknown[]) => Promise<unknown>)("call-1", { goal: "Cells age.", papers: "a" }, undefined, undefined, ctx);
    return captured;
  }

  it("the child gets the passages and verify tools, and the prompt says so", async () => {
    const c = await childFor();
    assert.deepEqual(c.tools, ["passages", "verify"]);
    assert.deepEqual(c.custom, ["passages", "verify"]);
    assert.ok(c.prompts.length >= 1 && c.prompts[0]!.includes("Use the passages and verify tools to read them; use no other tools."));
  });
});
