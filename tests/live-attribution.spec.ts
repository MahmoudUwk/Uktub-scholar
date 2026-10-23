/**
 * Attribution of the live harness's measurements: which slow steps happened inside a write_section child, what the children spent,
 * and the finished write_section LaTeX of a run that did not complete. Synthetic event arrays only (no Pi, no Docker).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { childUsageOf, slowScopeOf, slowStepsOf, totalCostUsd, writeSectionDrafts } from "../scripts/live/behavior.ts";

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
