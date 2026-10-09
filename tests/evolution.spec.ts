/**
 * Self-improving harness: the pure rules of the promotion loop (harness_skill SKILL.md parts III-V). Offline; no providers.
 * Every rule below is one the skill states: non-compensatory floor, noise band, cost rent, leakage screening of the shipped diff,
 * annealed edit budget, underexplored-component exploration, pruning, protected surfaces, and blocked runs never silently dropped.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  componentsOf, decide, editBudget, estimateNoise, leakageScreen, leakageTermsFrom, pickUnderexplored, pruneCandidates, runMetricsOf, summarize,
  type Decision, type RunMetric, type RunStats,
} from "../scripts/live/evolution.ts";

const metrics = (over: Record<string, unknown> = {}) => ({
  scenario: "s", iteration: 1, outcome: "success", wallMs: 600000,
  agent: { toolCalls: 50, usage: { responses: 60, inputTokens: 300000, outputTokens: 40000, reasoningTokens: 10000, costUsd: 0.7 }, refusalsOrErrors: 0 },
  checks: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, ok: true, detail: "" })),
  ...over,
});
const run = (over: Partial<RunMetric> = {}): RunMetric => ({ scenario: "s", iteration: 1, success: true, blocked: false, checksPassed: 9, checksTotal: 9, score: 1, costUsd: 0.7, inputTokens: 300000, outputTokens: 40000, toolCalls: 50, steps: 60, wallMs: 600000, ...over });
const stats = (over: Partial<RunStats> = {}): RunStats => ({ runs: 3, blocked: 0, score: 1, successRate: 1, costUsd: 0.7, inputTokens: 300000, outputTokens: 40000, toolCalls: 50, wallMs: 600000, ...over });
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
    "+Prefer verify_claim with a query for focused claims.",
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
