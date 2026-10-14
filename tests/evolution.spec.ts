/**
 * Self-improving harness: the pure rules of the promotion loop (harness_skill SKILL.md parts III-V). Offline; no providers.
 * Every rule below is one the skill states: non-compensatory floor, noise band, cost rent, leakage screening of the shipped diff,
 * annealed edit budget, underexplored-component exploration, pruning, protected surfaces, and blocked runs never silently dropped.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  behaviorDelta, componentsOf, criticalCheckRegressions, decide, editBudget, estimateNoise, leakageScreen, leakageTermsFrom, pickUnderexplored, pruneCandidates, runMetricsOf, summarize, CRITICAL_CHECK_IDS, PROTOCOL_CHECK_IDS,
  type BehaviorStats, type Decision, type RunMetric, type RunStats,
} from "../scripts/live/evolution.ts";
import { behaviorOf, compactionsOf, invalidToolCall, simulatedWindowSettings, type BehaviorTurn } from "../scripts/live/behavior.ts";
import { walkFiles } from "../scripts/live/files.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const metrics = (over: Record<string, unknown> = {}) => ({
  scenario: "s", iteration: 1, outcome: "success", wallMs: 600000,
  agent: { toolCalls: 50, usage: { responses: 60, inputTokens: 300000, outputTokens: 40000, reasoningTokens: 10000, costUsd: 0.7 }, refusalsOrErrors: 0 },
  checks: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, ok: true, detail: "" })),
  ...over,
});
const passedChecks = Object.fromEntries(CRITICAL_CHECK_IDS.map((id) => [id, true]));
const run = (over: Partial<RunMetric> = {}): RunMetric => ({ scenario: "s", iteration: 1, success: true, blocked: false, checksPassed: 9, checksTotal: 9, criticalPassed: 5, criticalTotal: 5, criticalChecks: passedChecks, score: 1, costUsd: 0.7, inputTokens: 300000, outputTokens: 40000, toolCalls: 50, steps: 60, wallMs: 600000, ...over });
const stats = (over: Partial<RunStats> = {}): RunStats => ({ runs: 3, blocked: 0, score: 1, successRate: 1, criticalRate: 1, criticalChecks: passedChecks, costUsd: 0.7, inputTokens: 300000, outputTokens: 40000, toolCalls: 50, wallMs: 600000, ...over });
const noise = { scoreDelta: 0.05, costRel: 0.1 };
const base = { incumbent: stats(), sBest: 1, noise, leakage: [] as unknown[], guardsOk: true, structural: false };
const verdict = (cand: RunStats, over: Record<string, unknown> = {}): Decision => decide({ ...base, candidate: cand, ...over } as never);

describe("run metrics", () => {
  it("reads a metrics.json into score, success, cost, tokens and effort", () => {
    const r = runMetricsOf(metrics());
    assert.deepEqual([r.success, r.blocked, r.checksPassed, r.checksTotal, r.score], [true, false, 9, 9, 1]);
    assert.deepEqual([r.costUsd, r.inputTokens, r.outputTokens, r.toolCalls, r.steps, r.wallMs], [0.7, 300000, 40000, 50, 60, 600000]);
  });
  it("a run blocked by provider capacity or a deadline is blocked, not a success and not a product failure", () => {
    const r = runMetricsOf(metrics({ outcome: "blocked: turn agent-1: client deadline 2700000ms reached", checks: metrics().checks.map((c, i) => ({ ...c, ok: i < 4 })) }));
    assert.deepEqual([r.success, r.blocked, r.checksPassed], [false, true, 4]);
  });
  it("end-to-end success needs the simulator's success AND every deterministic check: a failed check is not a success", () => {
    const r = runMetricsOf(metrics({ outcome: "success", checks: metrics().checks.map((c, i) => ({ ...c, ok: i !== 3 })) }));
    assert.deepEqual([r.success, r.blocked, r.checksPassed], [false, false, 8]);
  });
  it("a failed (not blocked) run is a failure with its partial score", () => {
    const r = runMetricsOf(metrics({ outcome: "give_up", checks: metrics().checks.map((c, i) => ({ ...c, ok: i < 6 })) }));
    assert.deepEqual([r.success, r.blocked, r.score], [false, false, 6 / 9]);
  });
  it("summaries average the completed runs and report blocked runs separately instead of dropping them", () => {
    const s = summarize([run({ costUsd: 0.6 }), run({ costUsd: 1.0, score: 8 / 9, success: false }), run({ blocked: true, success: false, costUsd: 0.2 })]);
    assert.equal(s.runs, 2);
    assert.equal(s.blocked, 1);
    assert.ok(Math.abs(s.costUsd - 0.8) < 1e-9);
    assert.ok(Math.abs(s.score - (1 + 8 / 9) / 2) < 1e-9);
    assert.equal(s.successRate, 0.5);
  });
});

describe("noise (delta) of the unchanged harness", () => {
  it("is the observed spread of repeated baseline runs, in score and in relative cost", () => {
    const n = estimateNoise([run({ score: 1, costUsd: 0.6 }), run({ score: 8 / 9, costUsd: 0.68 }), run({ score: 1, costUsd: 1.08 })]);
    assert.ok(Math.abs(n.scoreDelta - 1 / 9) < 1e-9);
    assert.ok(Math.abs(n.costRel - (1.08 - 0.6) / ((0.6 + 0.68 + 1.08) / 3)) < 1e-9);
    assert.equal(n.provisional, false);
  });
  it("is provisional with fewer than three completed runs, and never negative or zero-divided", () => {
    assert.equal(estimateNoise([run(), run()]).provisional, true);
    const same = estimateNoise([run(), run(), run()]);
    assert.deepEqual([same.scoreDelta, same.costRel], [0, 0]);
  });
});

describe("leakage screen of the shipped diff", () => {
  const diff = [
    "--- a/skills/x.md", "+++ b/skills/x.md", "@@ -1,3 +1,4 @@",
    " context line mentioning WirelessJEPA stays unscreened",
    "-removed line with IQFM",
    "+Prefer verify with a query for focused claims.",
    "+For IQFM style papers call search twice.",
  ].join("\n");
  it("flags terms only in ADDED lines, case-insensitively, with the line", () => {
    const f = leakageScreen(diff, ["iqfm", "WirelessJEPA", "rf-llm-literature-review"]);
    assert.deepEqual(f.map((x) => x.term), ["iqfm"]);
    assert.match(f[0].line, /IQFM style papers/);
  });
  it("a clean mechanism passes, and terms under 4 characters are ignored as noise", () => {
    assert.deepEqual(leakageScreen("+Prefer a narrow query.\n", ["query", "a", "ab"]).map((x) => x.term), ["query"]);
    assert.deepEqual(leakageScreen("+Prefer a narrow query.\n", ["rf-llm-literature-review"]), []);
  });
});

describe("promotion decision", () => {
  it("rejects a leaking diff before looking at any score", () => {
    const d = verdict(stats({ score: 1, costUsd: 0.1 }), { leakage: [{ term: "iqfm", line: "+x" }] });
    assert.deepEqual([d.admissible, d.status], [false, "rejected"]);
    assert.match(d.reasons.join(" "), /leak/i);
  });
  it("rejects a failed domain guard", () => assert.equal(verdict(stats(), { guardsOk: false }).admissible, false));
  it("the performance floor is non-compensatory: a cost cut never buys a score below S_best - delta", () => {
    const d = verdict(stats({ score: 0.9, costUsd: 0.2 }));
    assert.deepEqual([d.admissible, d.status], [false, "rejected"]);
    assert.match(d.reasons.join(" "), /floor/i);
  });
  it("a score gain beyond the noise band is admissible while its cost increase stays within the rent", () => {
    const inc = stats({ score: 0.8 });
    assert.equal(verdict(stats({ score: 0.95, costUsd: 0.77 }), { incumbent: inc, sBest: 0.8 }).admissible, true);
    const dear = verdict(stats({ score: 0.95, costUsd: 1.1 }), { incumbent: inc, sBest: 0.8 });
    assert.deepEqual([dear.admissible, dear.band], [false, "gain"]);
  });
  it("inside the noise band a score bump is not evidence: it must cut cost beyond the cost noise, or be a new structural mechanism", () => {
    assert.equal(verdict(stats({ score: 1.0, costUsd: 0.7 * 0.97 })).admissible, false, "3 % is inside the 10 % cost noise");
    const cheaper = verdict(stats({ score: 0.98, costUsd: 0.7 * 0.8 }));
    assert.deepEqual([cheaper.admissible, cheaper.band], [true, "within"]);
    assert.equal(verdict(stats({ score: 0.98, costUsd: 0.7 }), { structural: true }).admissible, true);
    assert.equal(verdict(stats({ score: 0.98, costUsd: 0.7 * 1.25 }), { structural: true }).admissible, false, "a structural bet still may not cost 25 % more for no gain");
  });
  it("a candidate worse than the incumbent beyond the noise is a loss and is rejected", () => {
    const d = verdict(stats({ score: 0.93 }), { sBest: 0.96 });
    assert.deepEqual([d.admissible, d.band], [false, "loss"]);
  });
  it("is inconclusive, not decided, when blocked runs are a third or more of the attempts or fewer than 2 runs completed", () => {
    assert.equal(verdict(stats({ runs: 2, blocked: 1 })).status, "inconclusive");
    assert.equal(verdict(stats({ runs: 1, blocked: 0 })).status, "inconclusive");
    assert.notEqual(verdict(stats({ runs: 3, blocked: 1 })).status, "inconclusive");
  });
});

describe("edit budget, exploration and pruning", () => {
  it("anneals the number of bundled edits from early to late rounds", () => {
    const p = { early_max: 4, late_min: 1 };
    assert.deepEqual([1, 2, 8, 10, 18, 20].map((r) => editBudget(r, 20, p)), [4, 4, 2, 2, 1, 1]);
  });
  const h = (component: string, scoreDelta: number, accepted: boolean) => ({ round: 0, component, scoreDelta, costDelta: 0, accepted });
  const all = ["prompt", "control_flow", "config", "output_plumbing", "context_mgmt", "client_tool", "skill", "memory", "subagent"];
  it("when progress stays inside the noise for the window, it reserves a candidate for an untouched structural component", () => {
    const hist = [h("prompt", 0.01, false), h("prompt", 0.0, false), h("prompt", 0.02, false)];
    assert.equal(pickUnderexplored(hist, all, 3, 0.05), "control_flow");
    assert.equal(pickUnderexplored([...hist, h("control_flow", 0, false)], all, 3, 0.05), "context_mgmt");
  });
  it("does not force exploration while recent rounds still make real gains", () => {
    assert.equal(pickUnderexplored([h("prompt", 0.01, false), h("prompt", 0.2, true), h("prompt", 0.01, false)], all, 3, 0.05), null);
  });
  it("proposes pruning components exercised for the whole window with no positive measured contribution", () => {
    const hist = [h("skill", 0, true), h("skill", -0.01, false), h("skill", 0.0, false), h("skill", 0, false), h("prompt", 0.3, true), h("prompt", 0, false), h("prompt", 0, false), h("prompt", 0, false)];
    assert.deepEqual(pruneCandidates(hist, 4, 0.05), ["skill"]);
  });
});

describe("protected surfaces and attribution", () => {
  const map = { prompt: ["src/core/agent-rules.ts"], skill: ["skills/**"], client_tool: ["src/mcp/server.ts", "src/core/tools/*.ts"] };
  const protectedGlobs = ["scripts/live/**", "experiments/scenarios/**", "src/core/source/download.ts"];
  it("assigns each changed file to its component, so every edit names the layer it changes", () => {
    const r = componentsOf(["src/core/agent-rules.ts", "skills/uktub-research/SKILL.md", "src/core/tools/search.ts"], map, protectedGlobs);
    assert.deepEqual(r.byComponent, { prompt: ["src/core/agent-rules.ts"], skill: ["skills/uktub-research/SKILL.md"], client_tool: ["src/core/tools/search.ts"] });
    assert.deepEqual([r.unmapped, r.protected], [[], []]);
  });
  it("reports edits to the evaluator, frozen scenarios and safety code as protected, and files in no component as unmapped", () => {
    const r = componentsOf(["scripts/live/cases.ts", "experiments/scenarios/new.md", "src/core/source/download.ts", "README.md"], map, protectedGlobs);
    assert.deepEqual(r.protected.sort(), ["experiments/scenarios/new.md", "scripts/live/cases.ts", "src/core/source/download.ts"]);
    assert.deepEqual(r.unmapped, ["README.md"]);
  });
});

describe("leakage terms", () => {
  const scenario = "# RF-LLM literature review\n\n## Prompt\n\nEvaluate **multimodal wireless foundation models** (e.g., IQFM, WirelessJEPA, RadioLLM) as in 10.48550/arxiv.2411.09996 using LaTeX and BibTeX with the OpenAlex index.\n";
  it("collects scenario names, bold phrases, CamelCase and ALLCAPS identifiers and DOIs, and leaves generic tooling words out", () => {
    const terms = leakageTermsFrom([{ name: "rf-llm-literature-review", text: scenario }]);
    for (const t of ["rf-llm-literature-review", "multimodal wireless foundation models", "IQFM", "WirelessJEPA", "RadioLLM", "10.48550/arxiv.2411.09996"]) assert.ok(terms.includes(t), t);
    for (const t of ["LaTeX", "BibTeX", "OpenAlex"]) assert.ok(!terms.includes(t), `${t} is generic tooling vocabulary`);
  });
  it("is deduplicated across scenarios", () => {
    const terms = leakageTermsFrom([{ name: "a", text: "IQFM" }, { name: "b", text: "IQFM again" }]);
    assert.equal(terms.filter((t) => t === "IQFM").length, 1);
  });
});

// ── behaviour signatures (harness skill v2) ──────────────────────────────────────────────────────────────────────────────────
const msg = (input: number, cacheRead = 0, cacheWrite = 0) => ({ usage: { input, cacheRead, cacheWrite } });
const turn = (over: Partial<BehaviorTurn> = {}): BehaviorTurn => ({ calls: [], ends: [], messages: [], compactions: [], ...over });
const acted = (n = 1) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: "bash" }));
const piValidation = 'Validation failed for tool "mcp__uktub__papers":\n- query: must have required property\n\nReceived arguments:\n{}';
const bash127 = "/bin/bash: line 1: pdfinfo: command not found\n\nCommand exited with code 127";
const checksOf = (failed: string[]) => ["citations-in-registry", "bibliography-matches-registry", "compiled-after-last-edit", "evidence-tools-used", "provider-warnings-disclosed"].map((id) => ({ id, ok: !failed.includes(id) }));

describe("invalid tool calls", () => {
  it("a Pi schema failure, an unknown tool and a shell command the machine does not have are invalid calls", () => {
    assert.equal(invalidToolCall({ name: "mcp__uktub__papers", isError: true, text: piValidation }), "validation");
    assert.equal(invalidToolCall({ name: "mcp__uktub__zotero", isError: true, text: "Tool mcp__uktub__zotero not found" }), "unknown_tool");
    assert.equal(invalidToolCall({ name: "bash", isError: true, text: bash127 }), "unresolved_command");
  });
  it("a failed command that exists, a domain refusal and a successful result that mentions the words are not invalid calls", () => {
    assert.equal(invalidToolCall({ name: "bash", isError: true, text: "cat: build/main.bbl: No such file or directory\n\nCommand exited with code 1" }), null);
    assert.equal(invalidToolCall({ name: "mcp__uktub__verify", isError: true, text: "Refused: NO_OPEN_COPY — no source. Next: attach one." }), null);
    assert.equal(invalidToolCall({ name: "bash", isError: false, text: "grep found: pdfinfo: command not found" }), null);
  });
});

describe("compactions Pi reports", () => {
  it("lists the reason of every compaction Pi started and ignores every other event", () => {
    const events = [{ type: "compaction_start", reason: "threshold" }, { type: "compaction_end", reason: "threshold" }, { type: "message_end" }, { type: "compaction_start", reason: "overflow" }];
    assert.deepEqual(compactionsOf(events), ["threshold", "overflow"]);
  });
});

describe("behaviour of a run", () => {
  it("the peak context is the largest input plus cache read plus cache write of any response in any turn", () => {
    const b = behaviorOf([turn({ messages: [msg(4000), msg(9000, 90000)] }), turn({ messages: [msg(10000, 150000, 2000), msg(3000, 1000)] })], [], 1048576);
    assert.equal(b.peakContextTokens, 162000);
    assert.equal(b.contextWindowTokens, 1048576);
  });
  it("counts every tool's calls, and the invalid ones by kind, not the uktub tools only", () => {
    const calls = [{ id: "a", name: "bash" }, { id: "b", name: "mcp__uktub__papers" }, { id: "c", name: "bash" }, { id: "d", name: "read" }];
    const ends = [
      { toolCallId: "a", name: "bash", isError: true, text: bash127 },
      { toolCallId: "b", name: "mcp__uktub__papers", isError: true, text: piValidation },
      { toolCallId: "c", name: "bash", isError: true, text: "cat: x: No such file or directory\n\nCommand exited with code 1" },
      { toolCallId: "d", name: "read", isError: false, text: "ok" },
    ];
    const b = behaviorOf([turn({ calls, ends })], [], 0);
    assert.deepEqual([b.toolCalls, b.invalidToolCalls], [4, 2]);
    assert.deepEqual(b.invalidByKind, { validation: 1, unknown_tool: 0, unresolved_command: 1 });
  });
  it("counts the compactions Pi started and, apart, the ones recovering from an overflow", () => {
    const b = behaviorOf([turn({ compactions: ["threshold"] }), turn({ compactions: ["overflow", "threshold"] })], [], 0);
    assert.deepEqual([b.compactions, b.overflowRecoveries], [3, 1]);
  });
  it("a premature stop is a turn that ended without any tool call while a deliverable check later fails", () => {
    const stalled = behaviorOf([turn({ calls: acted(3) }), turn()], checksOf(["compiled-after-last-edit"]), 0);
    assert.deepEqual([stalled.zeroCallTurns, stalled.deliverableChecksFailed, stalled.prematureStop], [1, ["compiled-after-last-edit"], true]);
  });
  it("a turn without tool calls is not a premature stop when every deliverable check passes (a clarifying question)", () => {
    const asked = behaviorOf([turn(), turn({ calls: acted() })], checksOf([]), 0);
    assert.deepEqual([asked.zeroCallTurns, asked.prematureStop], [1, false]);
  });
  it("a failed deliverable check is not a premature stop when every turn acted, and a failed non-deliverable check never is", () => {
    assert.equal(behaviorOf([turn({ calls: acted() })], checksOf(["citations-in-registry"]), 0).prematureStop, false);
    assert.equal(behaviorOf([turn()], checksOf(["provider-warnings-disclosed"]), 0).prematureStop, false);
  });
  it("a turn blocked by the provider or a deadline is not a stop of the agent", () => {
    const b = behaviorOf([turn({ calls: acted() }), turn({ incomplete: "client deadline reached" })], checksOf(["evidence-tools-used"]), 0);
    assert.deepEqual([b.zeroCallTurns, b.prematureStop], [0, false]);
  });
});

describe("compaction is not overflow (a working host compaction is not a failure)", () => {
  const rec = { toolCalls: 80, invalidToolCalls: 4, peakContextTokens: 262144, contextWindowTokens: 1048576, compactions: 0, overflowRecoveries: 0, zeroCallTurns: 0, deliverableChecksFailed: [], prematureStop: false };
  const withB = (b: Record<string, unknown>) => metrics({ behavior: b });
  it("a normal compaction and an overflow recovery are recorded separately", () => {
    const normal = runMetricsOf(withB({ ...rec, compactions: 2, overflowRecoveries: 0 }));
    const overflow = runMetricsOf(withB({ ...rec, compactions: 1, overflowRecoveries: 1 }));
    assert.equal(normal.behavior?.compacted, true);
    assert.equal((normal.behavior as unknown as Record<string, unknown>)?.overflowed, false);
    assert.equal((overflow.behavior as unknown as Record<string, unknown>)?.overflowed, true);
  });
  it("summaries average compactions and overflows separately: normal compaction is never counted as overflow", () => {
    const sig = (compacted: boolean, overflowed: boolean): RunMetric => run({ behavior: { peakContextFraction: 0.1, compacted, overflowed, invalidToolCallRate: 0.02, repeatedAction: false, prematureStop: false } as unknown as RunMetric["behavior"] });
    const s = summarize([sig(false, false), sig(true, false)]);
    assert.equal((s.behavior as unknown as Record<string, unknown>)?.compactionRate, 0.5);
    assert.equal((s.behavior as unknown as Record<string, unknown>)?.contextOverflowRate, 0);
  });
});

describe("non-compensatory critical checks and end-to-end success", () => {
  it("an equal average score with a failed critical check is rejected, not compensated by cost", () => {
    const inc = stats({ score: 8 / 9, successRate: 8 / 9, criticalRate: 1 });
    const cand = stats({ score: 8 / 9, successRate: 8 / 9, criticalRate: 0.8, criticalChecks: { ...passedChecks, "citations-in-registry": false }, costUsd: 0.2 });
    const d = verdict(cand, { incumbent: inc, sBest: 8 / 9 });
    assert.deepEqual([d.admissible, d.status], [false, "rejected"]);
    assert.match(d.reasons.join(" "), /critical/i);
  });
  it("an end-to-end success regression is rejected even when the average score is higher", () => {
    const inc = stats({ score: 0.9, successRate: 1 });
    const cand = stats({ score: 0.95, successRate: 2 / 3, costUsd: 0.4 });
    const d = verdict(cand, { incumbent: inc, sBest: 0.9 });
    assert.equal(d.admissible, false);
    assert.match(d.reasons.join(" "), /success/i);
  });
  it("run metrics carry the critical-check pass count behind the score", () => {
    const ids = ["citations-in-registry", "bibliography-matches-registry", "compiled-after-last-edit", "pointers-issued-by-tools", "stop-signal", "provider-warnings-disclosed"];
    const r = runMetricsOf(metrics({ checks: ids.map((id) => ({ id, ok: id !== "citations-in-registry", detail: "" })) }));
    assert.deepEqual([(r as unknown as Record<string, unknown>).criticalPassed, (r as unknown as Record<string, unknown>).criticalTotal], [3, 4]);
    assert.equal(r.criticalChecks["citations-in-registry"], false);
    assert.equal(r.criticalChecks["bibliography-matches-registry"], true);
    assert.equal(r.criticalChecks["evidence-tools-used"], false, "a missing required integrity check is never treated as passing");
  });
  it("does not hide a swap between failed required checks behind an equal critical average", () => {
    const failedA = { ...passedChecks, "citations-in-registry": false };
    const failedB = { ...passedChecks, "bibliography-matches-registry": false };
    const inc = stats({ criticalRate: 0.8, criticalChecks: failedA });
    const candidate = stats({ criticalRate: 0.8, criticalChecks: failedB, costUsd: 0.1 });
    const d = verdict(candidate, { incumbent: inc });
    assert.equal(d.admissible, false);
    assert.match(d.reasons.join(" "), /bibliography-matches-registry|critical/i);
  });
  it("requires every named critical check to pass even when the incumbent failed that same check", () => {
    const inc = stats({ criticalRate: 0.8, criticalChecks: { ...passedChecks, "citations-in-registry": false } });
    const candidate = stats({ criticalRate: 0.8, criticalChecks: { ...passedChecks, "citations-in-registry": false } });
    assert.equal(verdict(candidate, { incumbent: inc }).admissible, false);
  });
  it("finds a per-check audit regression when the critical average stays equal but the failed check changes", () => {
    const inc = stats({ criticalRate: 0.8, criticalChecks: { ...passedChecks, "citations-in-registry": false } });
    const candidate = stats({ criticalRate: 0.8, criticalChecks: { ...passedChecks, "bibliography-matches-registry": false } });
    assert.deepEqual(criticalCheckRegressions(candidate, inc), ["bibliography-matches-registry"]);
  });
  it("no-unrequested-removal is unconditionally critical, even with no evidence table declared", () => {
    // No evidence-table keys anywhere: baseline 7/9, candidate fixes both noncritical checks (8/9) but removes without asking.
    const inc = stats({ score: 7 / 9, successRate: 0 });
    const cand = stats({ score: 8 / 9, successRate: 0, criticalChecks: { ...passedChecks, "no-unrequested-removal": false } });
    const d = verdict(cand, { incumbent: inc, sBest: 7 / 9 });
    assert.deepEqual([d.admissible, d.status], [false, "rejected"]);
    assert.match(d.reasons.join(" "), /no-unrequested-removal/);
  });
  it("a candidate passing no-unrequested-removal is not rejected for it", () => {
    const inc = stats({ score: 7 / 9, successRate: 0 });
    const cand = stats({ score: 8 / 9, successRate: 0, criticalChecks: { ...passedChecks, "no-unrequested-removal": true } });
    const d = verdict(cand, { incumbent: inc, sBest: 7 / 9 });
    assert.equal(d.admissible, true);
    assert.ok(!d.reasons.join(" ").includes("no-unrequested-removal"));
  });
  it("criticalCheckRegressions tolerates runs stored before the key existed", () => {
    const old = { "citations-in-registry": true };
    assert.deepEqual(criticalCheckRegressions(stats({ criticalChecks: { ...old } }), stats({ criticalChecks: { ...old } })), []);
    assert.deepEqual(
      criticalCheckRegressions(stats({ criticalChecks: { ...old, "no-unrequested-removal": false } }), stats({ criticalChecks: { ...old } })),
      [],
      "an absent reference value is not a regression",
    );
    assert.deepEqual(
      criticalCheckRegressions(stats({ criticalChecks: { ...old } }), stats({ criticalChecks: { ...old, "no-unrequested-removal": true } })),
      ["no-unrequested-removal"],
      "an absent candidate value fails closed",
    );
  });
  it("an integrity failure is never compensated by average score when the scenario declares evidence-table checks (review 2026-10-13 finding 1)", () => {
    // The review's counterexample: baseline 11/13, candidate 12/13 with `no-unrequested-removal` failed.
    const intact = { ...passedChecks, "no-unrequested-removal": true, "evidence-table-present": true, "evidence-table-valid": true, "length-within-request": true, "sourced-numerics": true };
    const tampered = { ...intact, "no-unrequested-removal": false };
    const inc = stats({ score: 11 / 13, successRate: 0, criticalChecks: intact });
    const cand = stats({ score: 12 / 13, successRate: 0, criticalChecks: tampered });
    const d = verdict(cand, { incumbent: inc, sBest: 11 / 13 });
    assert.deepEqual([d.admissible, d.status], [false, "rejected"]);
    assert.match(d.reasons.join(" "), /critical.*no-unrequested-removal|no-unrequested-removal.*critical/i);
  });
  it("a failing declared evidence-table check is non-compensatory too", () => {
    const intact = { ...passedChecks, "no-unrequested-removal": true, "evidence-table-present": true, "evidence-table-valid": true, "length-within-request": true, "sourced-numerics": true };
    const cand = stats({ score: 12 / 13, successRate: 0, criticalChecks: { ...intact, "evidence-table-valid": false } });
    const d = verdict(cand, { incumbent: stats({ score: 11 / 13, successRate: 0, criticalChecks: intact }), sBest: 11 / 13 });
    assert.deepEqual([d.admissible, d.status], [false, "rejected"]);
    assert.match(d.reasons.join(" "), /critical/i);
  });
  it("without an evidence table, a noncritical failure stays compensable but removal does not", () => {
    const inc = stats({ score: 7 / 9, successRate: 0, criticalChecks: passedChecks });
    const noisy = stats({ score: 8 / 9, successRate: 0, criticalChecks: { ...passedChecks, "provider-warnings-disclosed": false } });
    assert.equal(verdict(noisy, { incumbent: inc, sBest: 7 / 9 }).admissible, true, "a noncritical miss stays compensable");
    const removing = stats({ score: 8 / 9, successRate: 0, criticalChecks: { ...passedChecks, "no-unrequested-removal": false } });
    assert.equal(verdict(removing, { incumbent: inc, sBest: 7 / 9 }).admissible, false, "removal is critical with no evidence table declared");
  });
  it("run metrics always carry no-unrequested-removal as critical, and evidence checks only when declared", () => {
    const thirteen = [...PROTOCOL_CHECK_IDS, "evidence-table-present", "evidence-table-valid", "length-within-request", "sourced-numerics"];
    const r = runMetricsOf(metrics({ checks: thirteen.map((id: string) => ({ id, ok: id !== "no-unrequested-removal", detail: "" })) }));
    assert.equal(r.criticalChecks["no-unrequested-removal"], false);
    assert.equal(r.criticalChecks["evidence-table-valid"], true);
    assert.equal(r.criticalChecks["length-within-request"], true);
    assert.equal(r.criticalChecks["sourced-numerics"], true);
    const nine = runMetricsOf(metrics({ checks: [...PROTOCOL_CHECK_IDS].map((id: string) => ({ id, ok: true, detail: "" })) }));
    assert.equal(nine.criticalChecks["no-unrequested-removal"], true);
    assert.equal("evidence-table-valid" in nine.criticalChecks, false);
    assert.equal("length-within-request" in nine.criticalChecks, false);
    assert.equal("sourced-numerics" in nine.criticalChecks, false);
  });
});

describe("behaviour signatures in the run metrics", () => {
  const recorded = { toolCalls: 80, invalidToolCalls: 4, peakContextTokens: 262144, contextWindowTokens: 1048576, compactions: 0, overflowRecoveries: 0, zeroCallTurns: 0, deliverableChecksFailed: [], prematureStop: false };
  const withBehavior = (b: Record<string, unknown>, repeated: unknown[] = []) => metrics({ behavior: b, agent: { ...metrics().agent, repeatedIdenticalCalls: repeated } });
  it("turns a recorded run into the peak as a fraction of the window and the rates that v2 names", () => {
    const r = runMetricsOf(withBehavior(recorded));
    assert.deepEqual(r.behavior, { peakContextFraction: 0.25, compacted: false, overflowed: false, invalidToolCallRate: 0.05, repeatedAction: false, prematureStop: false });
  });
  it("a normal compaction marks the run as compacted but not overflowed; only an overflow recovery marks it overflowed", () => {
    const normal = runMetricsOf(withBehavior({ ...recorded, compactions: 2, overflowRecoveries: 0 }));
    assert.deepEqual([normal.behavior?.compacted, (normal.behavior as unknown as { overflowed: boolean | null }).overflowed], [true, false]);
    const r = runMetricsOf(withBehavior({ ...recorded, compactions: 1, overflowRecoveries: 1, prematureStop: true }, [{ tool: "papers", times: 2 }]));
    assert.deepEqual([r.behavior?.compacted, (r.behavior as unknown as { overflowed: boolean | null }).overflowed, r.behavior?.repeatedAction, r.behavior?.prematureStop], [true, true, true, true]);
  });
  it("an unknown window or no tool calls leave the fraction or the rate unrecorded instead of dividing by zero", () => {
    const r = runMetricsOf(withBehavior({ ...recorded, contextWindowTokens: 0, toolCalls: 0, invalidToolCalls: 0 }));
    assert.deepEqual([r.behavior?.peakContextFraction, r.behavior?.invalidToolCallRate], [null, null]);
  });
  it("a run recorded before behaviour was measured keeps what it has (repeated calls) and leaves the rest unrecorded", () => {
    const withList = runMetricsOf(metrics({ agent: { ...metrics().agent, repeatedIdenticalCalls: [{ tool: "verify", times: 2 }] } }));
    assert.deepEqual(withList.behavior, { peakContextFraction: null, compacted: null, overflowed: null, invalidToolCallRate: null, repeatedAction: true, prematureStop: null });
    assert.equal(runMetricsOf(metrics()).behavior?.repeatedAction, null);
  });
  const sig = (over: Partial<NonNullable<RunMetric["behavior"]>> = {}): NonNullable<RunMetric["behavior"]> => ({ peakContextFraction: 0.1, compacted: false, overflowed: false, invalidToolCallRate: 0.02, repeatedAction: false, prematureStop: false, ...over });
  it("a summary averages the signatures of the completed runs, counts the share of runs with each event, and leaves out blocked runs", () => {
    const s = summarize([run({ behavior: sig() }), run({ behavior: sig({ peakContextFraction: 0.3, compacted: true, overflowed: true, invalidToolCallRate: 0.04, repeatedAction: true }) }), run({ blocked: true, success: false, behavior: sig({ peakContextFraction: 0.9, prematureStop: true }) })]);
    const b = s.behavior as BehaviorStats;
    assert.ok(Math.abs((b.peakContextFraction as number) - 0.2) < 1e-9);
    assert.deepEqual([b.compactionRate, b.contextOverflowRate, b.repeatedActionRate, b.prematureStopRate], [0.5, 0.5, 0.5, 0]);
    assert.ok(Math.abs((b.invalidToolCallRate as number) - 0.03) < 1e-9);
  });
  it("a normal compaction counts toward compactions but never toward overflows", () => {
    const s = summarize([run({ behavior: sig() }), run({ behavior: sig({ compacted: true, overflowed: false }) })]);
    const b = s.behavior as BehaviorStats;
    assert.deepEqual([b.compactionRate, b.contextOverflowRate], [0.5, 0]);
  });
  it("a signature no completed run recorded stays null instead of becoming zero", () => {
    const s = summarize([run({ behavior: sig({ peakContextFraction: null, compacted: null, overflowed: null }) }), run()]);
    const b = s.behavior as BehaviorStats;
    assert.deepEqual([b.peakContextFraction, b.compactionRate, b.contextOverflowRate], [null, null, null]);
    assert.equal(summarize([run()]).behavior, undefined);
  });
  it("the delta is candidate minus incumbent per signature, and null where either side did not record it", () => {
    const inc: BehaviorStats = { peakContextFraction: 0.1, compactionRate: 0, contextOverflowRate: 0, invalidToolCallRate: 0.02, repeatedActionRate: null, prematureStopRate: 0 };
    const cand: BehaviorStats = { peakContextFraction: 0.15, compactionRate: 1, contextOverflowRate: 0, invalidToolCallRate: 0.01, repeatedActionRate: 0, prematureStopRate: 0 };
    const d = behaviorDelta(cand, inc) as BehaviorStats;
    assert.ok(Math.abs((d.peakContextFraction as number) - 0.05) < 1e-9);
    assert.deepEqual([d.compactionRate, d.contextOverflowRate, d.repeatedActionRate, d.prematureStopRate], [1, 0, null, 0]);
    assert.ok(Math.abs((d.invalidToolCallRate as number) + 0.01) < 1e-9);
    assert.equal(behaviorDelta(cand, undefined), null);
    assert.equal(behaviorDelta(undefined, inc), null);
  });
});

describe("a simulated context window (an ablation, labelled in the run)", () => {
  it("makes Pi compact where a window of that size would, for every named model, by reserving the rest of the real window", () => {
    assert.deepEqual(simulatedWindowSettings(["google-vertex/gemini-3.8-flash", "google-vertex/gemini-3.5-flash-lite"], 1048576, 128000), {
      compaction: { modelOverrides: { "google-vertex/gemini-3.8-flash": { reserveTokens: 920576 }, "google-vertex/gemini-3.5-flash-lite": { reserveTokens: 920576 } } },
    });
  });
  it("refuses a window that is not smaller than the real one, not a whole number, or too small to hold Pi's 20,000 recent tokens", () => {
    for (const bad of [1048576, 2000000, 128000.5, 20000, 0, -5]) assert.throws(() => simulatedWindowSettings(["m/x"], 1048576, bad), /window/, String(bad));
    assert.throws(() => simulatedWindowSettings([], 1048576, 128000), /model/);
  });
});

describe("the project files a run reports", () => {
  it("lists regular files and links to files, and skips links to directories and dangling links without following them (an agent linked manuscript/refs to ../refs and crashed the run's closing copy)", () => {
    const root = mkdtempSync(join(tmpdir(), "uktub-walk-"));
    try {
      mkdirSync(join(root, "manuscript"), { recursive: true });
      mkdirSync(join(root, "refs"));
      mkdirSync(join(root, ".registry"));
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "manuscript/main.tex"), "x");
      writeFileSync(join(root, "refs/references.bib"), "x");
      writeFileSync(join(root, ".registry/registry.db"), "x");
      writeFileSync(join(root, "node_modules/m.js"), "x");
      symlinkSync("../refs", join(root, "manuscript/refs")); // a link to a directory
      symlinkSync("../refs/references.bib", join(root, "manuscript/bib-link.bib")); // a link to a file
      symlinkSync("../nowhere", join(root, "manuscript/dangling")); // a link to nothing
      symlinkSync("..", join(root, "manuscript/loop")); // a link that would loop if followed
      assert.deepEqual(walkFiles(root).sort(), ["manuscript/bib-link.bib", "manuscript/main.tex", "refs/references.bib"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
