/**
 * Attribution of the live harness's measurements: which slow steps happened inside a write_section child, what the children spent,
 * and the finished write_section LaTeX of a run that did not complete. Synthetic event arrays only (no Pi, no Docker).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { annotatedUsageOf, childUsageOf, passagesAfterLastSection, slowScopeOf, slowStepsOf, totalCostUsd, writeSectionDrafts } from "../scripts/live/behavior.ts";

const GAP = "model gap after a tool result";

describe("slow steps: scope of each gap and slow tool", () => {
  // Timeline (ms): p1 0→1000; w1 (write_section) starts 200000; child c1 200500→200600; child c2 300000→300100; w1 ends 600000; p2 600100→600200.
  const turn = {
    id: "agent-1",
    calls: [
      { id: "p1", name: "passages", args: {}, t: 0 },
      { id: "w1", name: "write_section", args: {}, t: 200_000 },
      { id: "c1", name: "passages", args: {}, parent: "w1", t: 200_500 },
      { id: "c2", name: "verify", args: {}, parent: "w1", t: 300_000 },
      { id: "p2", name: "bash", args: {}, t: 600_100 },
    ],
    ends: [
      { toolCallId: "p1", name: "passages", t: 1_000 },
      { toolCallId: "c1", name: "passages", parent: "w1", t: 200_600 },
      { toolCallId: "c2", name: "verify", parent: "w1", t: 300_100 },
      { toolCallId: "w1", name: "write_section", t: 600_000 },
      { toolCallId: "p2", name: "bash", t: 600_200 },
    ],
  };

  it("tags gaps between child tool events as child (with the write_section id) and parent gaps as parent", () => {
    const steps = slowStepsOf([turn], 60_000);
    assert.deepEqual(steps, [
      { turn: "agent-1", kind: GAP, ms: 199_000, detail: "next tool call started late", parent: null },
      { turn: "agent-1", kind: GAP, ms: 99_400, detail: "next tool call started late", parent: "w1", parentTool: "write_section" },
      { turn: "agent-1", kind: GAP, ms: 299_900, detail: "next tool call started late", parent: "w1", parentTool: "write_section" },
      { turn: "agent-1", kind: "slow tool", ms: 400_000, detail: "write_section", parent: null },
    ]);
  });

  it("summarises the slow steps by scope: parent and child counts and milliseconds", () => {
    const scope = slowScopeOf(slowStepsOf([turn], 60_000));
    assert.deepEqual(scope, { parent: { count: 2, ms: 599_000 }, child: { count: 2, ms: 399_300 } });
  });
});

describe("child usage of write_section ends", () => {
  const child = (usage: Record<string, number>, figures: Record<string, number> = {}) => ({
    child: { turns: 3, retries: 0, toolCalls: 0, wallMs: 0, ...figures, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, ...usage } },
  });

  it("sums the child usage over every write_section end and counts the ends without details.child", () => {
    const ends = [
      { name: "write_section", details: child({ input: 100, output: 20, cacheRead: 5, cacheWrite: 2, costUsd: 0.01 }, { turns: 3, retries: 1, toolCalls: 12, wallMs: 1000 }) },
      { name: "write_section", details: child({ input: 50, output: 10, costUsd: 0.005 }, { turns: 2, retries: 0, toolCalls: 4, wallMs: 500 }) },
      { name: "write_section", details: {} }, // a refusal or an older run: no child figures
      { name: "passages", details: child({ input: 999 }) }, // not a write_section end: never summed
    ];
    const r = childUsageOf(ends);
    assert.deepEqual(r.childUsage, { turns: 5, retries: 1, toolCalls: 16, wallMs: 1500, inputTokens: 150, outputTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 2, costUsd: 0.015 });
    assert.equal(r.childUsageMissing, 1);
  });

  it("reports the parent and child cost together as one total", () => {
    assert.equal(totalCostUsd(0.2444, 0.015), 0.2594);
  });
});

describe("drafts of a run that did not complete", () => {
  it("returns the LaTeX of every successful write_section end, in return order, before the summary separator", () => {
    const drafts = writeSectionDrafts([
      { name: "write_section", isError: false, text: "\\section{A}\nFirst.\n\n---\nsummary one" },
      { name: "passages", isError: false, text: "\\section{Not a draft}\n\n---\nnot a write" },
      { name: "write_section", isError: true, text: "This operation was aborted" },
      { name: "write_section", isError: false, text: "\\section{B}\nSecond.\n\n---\nsummary two\nunresolved: none" },
      { name: "write_section", isError: false, text: "no separator here" },
    ]);
    assert.deepEqual(drafts, [
      { file: "write_section/01.tex", latex: "\\section{A}\nFirst." },
      { file: "write_section/02.tex", latex: "\\section{B}\nSecond." },
    ]);
  });
});

describe("passagesAfterLastSection (W6.2)", () => {
  const call = (name: string, parent?: string): { name: string; parent?: string } => ({ name, ...(parent === undefined ? {} : { parent }) });
  const end = (name: string, isError = false, parent?: string): { name: string; isError: boolean; parent?: string } => ({ name, isError, ...(parent === undefined ? {} : { parent }) });
  const turn = (calls: Array<{ name: string; parent?: string }>, ends: Array<{ name: string; isError: boolean; parent?: string }>): { calls: Array<{ name: string; parent?: string }>; ends: Array<{ name: string; isError: boolean; parent?: string }> } => ({ calls, ends });

  it("is null when no write_section ever succeeded", () => {
    assert.equal(
      passagesAfterLastSection([turn([call("passages")], [end("passages")]), turn([call("write_section")], [end("write_section", true)])]),
      null,
      "passages alone and a failed section leave no section",
    );
  });

  it("is 0 when nothing follows the last section, and counts only later parent passages", () => {
    const turns = [
      turn([call("passages")], [end("passages")]),
      turn([call("write_section")], [end("write_section")]),
      turn([call("bash")], [end("bash")]),
    ];
    assert.equal(passagesAfterLastSection(turns), 0, "no parent passages after the section");
    assert.equal(
      passagesAfterLastSection([
        ...turns,
        turn([call("passages"), call("passages", "w9"), call("mcp__uktub__passages")], [end("write_section", true), end("passages")]),
      ]),
      2,
      "a failed section end is not a section; child calls and earlier calls are ignored",
    );
  });

  it("the last successful section wins", () => {
    const turns = [
      turn([call("write_section")], [end("mcp__uktub__write_section")]),
      turn([call("passages")], [end("passages")]),
      turn([call("write_section")], [end("write_section")]),
      turn([call("passages")], [end("passages")]),
    ];
    assert.equal(passagesAfterLastSection(turns), 1, "passages between sections belong to the earlier one");
  });
});

describe("annotatedUsageOf (W5.13)", () => {
  it("is all zeros when no end carries annotated detail", () => {
    assert.deepEqual(annotatedUsageOf([{ name: "write_section", details: {} }, { name: "passages", details: {} }]), {
      sections: 0,
      markerCompliance: 0,
      claims: 0,
      statusShares: {},
      multiSourceShare: 0,
      unreadRate: 0,
      work: { cells: 0, fresh: 0, cached: 0, calls: 0 },
    });
  });

  it("sums sections, compliance, label shares, multi-source use, unread rate and work", () => {
    const ends = [
      {
        name: "write_section",
        details: {
          annotated: {
            mode: "annotated",
            claims: [
              { marker: 1, status: "supported", sources: ["a"], at: ["stated"], unread: [] },
              { marker: 2, status: "cited-unsupported", sources: ["b"], at: ["unsupported"], unread: ["b"] },
            ],
            work: { cells: 10, fresh: 8, cached: 2, calls: 3 },
          },
        },
      },
      { name: "write_section", details: { annotated: { mode: "fallback", claims: [], work: { cells: 0, fresh: 0, cached: 0, calls: 0 } } } },
      { name: "write_section", details: {} },
      { name: "passages", details: {} },
    ];
    assert.deepEqual(annotatedUsageOf(ends), {
      sections: 2,
      markerCompliance: 0.5,
      claims: 2,
      statusShares: { supported: 0.5, "cited-unsupported": 0.5 },
      multiSourceShare: 0,
      unreadRate: 0.5,
      work: { cells: 10, fresh: 8, cached: 2, calls: 3 },
    });
  });
});
