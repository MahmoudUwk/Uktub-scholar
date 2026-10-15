/**
 * Pi-only `write_section`: parameter parsing (papers is ONE string, never an
 * array), fenced-LaTeX extraction, and the verify → repair-once → re-verify
 * round with a stubbed sub-session and stubbed document verification.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import uktubScholarExtension, { lastAssistantText, normalizeForwardPapers, sectionWriterTool } from "../src/pi/index.ts";

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
  it("registers write_section only when UKTUB_SECTION_WRITER=on", () => {
    delete process.env.UKTUB_SECTION_WRITER;
    assert.deepEqual(tools(), []);
    process.env.UKTUB_SECTION_WRITER = "on";
    assert.deepEqual(tools(), ["write_section"]);
  });
  it("the tool prepares array papers into the one-string form", () => {
    const prepared = (sectionWriterTool.prepareArguments as (a: unknown) => Record<string, unknown>)({ goal: "g", papers: ["a", "b"] });
    assert.equal(prepared.papers, "a b");
  });
  it("normalizeForwardPapers defaults scope and parses model-sent strings", () => {
    assert.deepEqual(normalizeForwardPapers({ claim: "c" }), { claim: "c", papers: "all" });
    assert.deepEqual(normalizeForwardPapers({ claim: "c", papers: "a" }), { claim: "c", papers: ["a"] });
    assert.deepEqual(normalizeForwardPapers({ claim: "c", papers: '["a", "b"]' }), { claim: "c", papers: ["a", "b"] });
    assert.deepEqual(normalizeForwardPapers({ claim: "c", papers: "all" }), { claim: "c", papers: "all" });
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
    verifyDocument: async (text: string) => {
      void text;
      d.verifies += 1;
      return { units: verdicts[Math.min(vi++, verdicts.length - 1)]! };
    },
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
});
