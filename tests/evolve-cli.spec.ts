/**
 * The self-improving harness controller end to end in a TEMPORARY repo (UKTUB_EVOLVE_ROOT): init, baseline from recorded runs, a candidate
 * that leaks, a clean candidate, evaluation, promotion with a rollback snapshot, rollback, protected-surface refusal. No providers.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PROTOCOL_CHECK_IDS } from "../scripts/live/evolution.ts";
import { fingerprintFiles, stagingSurfaceHashes } from "../scripts/live/provenance.ts";

const cli = resolve(import.meta.dirname, "../scripts/live/evolve.ts");
let root: string;
const put = (f: string, text: string) => {
  mkdirSync(dirname(join(root, f)), { recursive: true });
  writeFileSync(join(root, f), text);
};
const evolve = (...args: string[]) => {
  const r = spawnSync("node", [cli, ...args], { cwd: root, env: { ...process.env, UKTUB_EVOLVE_ROOT: root }, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const REAL_CHECKS = [...PROTOCOL_CHECK_IDS];
const iteration = (scenario: string, n: number, over: { score?: number; cost?: number; outcome?: string; surfaceHash?: string; behavior?: { peak: number; invalid: number; tools: number; compactions?: number } } = {}) => {
  const ok = Math.round((over.score ?? 1) * REAL_CHECKS.length);
  const b = over.behavior;
  const tag = `iter-${String(n).padStart(2, "0")}`;
  // One critical check fails when the score is imperfect: the fixtures stay realistic (critical checks present, never omitted).
  const criticalIds = new Set(["citations-in-registry", "bibliography-matches-registry", "compiled-after-last-edit", "pointers-issued-by-tools", "evidence-tools-used"]);
  const metricsText = JSON.stringify({
    scenario, iteration: n, outcome: over.outcome ?? "success", wallMs: 600000,
    simulatedWindowTokens: null,
    agent: { toolCalls: 50, usage: { responses: 60, inputTokens: 300000, outputTokens: 40000, costUsd: over.cost ?? 0.7 }, ...(b ? { repeatedIdenticalCalls: [] } : {}) },
    checks: REAL_CHECKS.map((id, i) => ({ id, ok: i < ok && !(over.score !== undefined && (over.score ?? 1) < 1 && criticalIds.has(id) && i === 0), detail: "" })),
    ...(b ? { behavior: { toolCalls: b.tools, invalidToolCalls: b.invalid, peakContextTokens: b.peak, contextWindowTokens: 1048576, compactions: b.compactions ?? 0, overflowRecoveries: 0, zeroCallTurns: 0, deliverableChecksFailed: [], prematureStop: false } } : {}),
  });
  put(`experiments/runs/${scenario}/${tag}/metrics.json`, metricsText);
  // The run manifest the live harness writes beside its metrics (env.manifest + experiment fields), stamped with the
  // current tree's surface identity so the controller can bind runs to bytes.
  const surf = stagingSurfaceHashes(root);
  const shaOf = (f: string) => createHash("sha256").update(readFileSync(join(root, f), "utf8")).digest("hex");
  mkdirSync(join(root, `experiments/runs/${scenario}/${tag}/evidence`), { recursive: true });
  put(`experiments/runs/${scenario}/${tag}/evidence/manifest.json`, JSON.stringify({
    scenario, iteration: n,
    model: "google-vertex/gemini-3.8-flash (both agents; Vertex client, ADC; no fallback)",
    modelProfile: { agent: ["google-vertex/gemini-3.8-flash"], simulator: ["google-vertex/gemini-3.8-flash"] },
    metricsSha256: createHash("sha256").update(metricsText, "utf8").digest("hex"),
    commit: "test-commit", workingTreeDiffSha256: "ab".repeat(32), packageHash: "test-package",
    surfaceHash: over.surfaceHash ?? surf.surfaceHash, protectedHash: surf.protectedHash,
    image: "test-image", engineDevice: "test-engine",
    providerKeysPassed: [],
    scenarioSha256: shaOf(`experiments/scenarios/${scenario}.md`),
    simulatorSha256: shaOf("experiments/simulator.md"),
    experimentSha256: shaOf("scripts/live/experiment.ts"),
    agentDriverSha256: shaOf("scripts/live/agent.ts"),
    policy: { simulatedWindowTokens: null },
  }));
};
const incumbentId = (): string => /incumbent_id: (\S+)/.exec(readFileSync(join(root, "experiments/harness/manifest.yaml"), "utf8"))?.[1] as string;
const incumbentSurfaceHash = (): string => {
  const snapshot = join(root, "experiments/harness/snapshots", incumbentId());
  const files = globSync("**/*", { cwd: snapshot }).filter((f) => statSync(join(snapshot, f)).isFile());
  return fingerprintFiles(snapshot, files);
};
const tweakManifest = (scenario: string, n: number, f: (m: Record<string, unknown>) => Record<string, unknown>): void => {
  const p = join(root, "experiments/runs", scenario, `iter-${String(n).padStart(2, "0")}`, "evidence", "manifest.json");
  writeFileSync(p, JSON.stringify(f(JSON.parse(readFileSync(p, "utf8")))));
};
const readLog = () => readFileSync(join(root, "experiments/harness/evolution-log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

before(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-evolve-"));
  put("src/core/agent-rules.ts", 'export const RULES = ["Check a claim with verify."];\n');
  put("skills/uktub-research/SKILL.md", "# Skill\nUse a narrow query.\n");
  put("scripts/live/cases.ts", "// the evaluator\n");
  put("scripts/live/experiment.ts", "// the experiment driver\n");
  put("scripts/live/agent.ts", "// the agent driver\n");
  put("experiments/simulator.md", "# Simulator\n");
  put("experiments/scenarios/alpha-scenario.md", "# Alpha\n\n## Prompt\n\nReview **quantum zebra networks** such as ZebraNetX and QuantumHerd.\n");
  put("experiments/scenarios/held-scenario.md", "# Held\n\n## Prompt\n\nReview **glacier melt models**.\n");
  put("experiments/scenarios/ood-scenario.md", "# OOD\n\n## Prompt\n\nCheck **three claims**.\n");
  for (const n of [1, 2, 3]) iteration("alpha-scenario", n, { cost: [0.6, 0.7, 0.8][n - 1] });
  for (const n of [4, 5, 6]) iteration("alpha-scenario", n, { cost: 0.4 });
  iteration("alpha-scenario", 7, { cost: 0.4, outcome: "blocked: turn agent-1: client deadline reached" });
  iteration("held-scenario", 1);
  // scenario names and the surfaces are part of the manifest; init writes the default, so patch it to the temp names below
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("evolve controller", () => {
  it("init snapshots H0; baseline records S_best and the noise delta from recorded runs", () => {
    assert.equal(evolve("init").code, 0);
    assert.equal(evolve("init").code, 2, "H0 is immutable: a second init is refused");
    const m = readFileSync(join(root, "experiments/harness/manifest.yaml"), "utf8")
      .replace(/evolve:\n {4}- rf-llm-literature-review/, "evolve:\n    - alpha-scenario")
      .replace(/heldout:\n {4}- [\w-]+/, "heldout:\n    - held-scenario")
      .replace(/ood:\n {4}- [\w-]+/, "ood:\n    - ood-scenario");
    writeFileSync(join(root, "experiments/harness/manifest.yaml"), m);
    const refreshed = evolve("rebaseline", "alpha-scenario/iter-01", "alpha-scenario/iter-02", "alpha-scenario/iter-03");
    assert.equal(refreshed.code, 0, refreshed.out);
    const b = evolve("baseline", "alpha-scenario/iter-01", "alpha-scenario/iter-02", "alpha-scenario/iter-03");
    assert.equal(b.code, 0, b.out);
    assert.match(b.out, /score 1\.000/);
    assert.match(b.out, /cost spread 29 %/);
    assert.doesNotMatch(b.out, /PROVISIONAL/);
  });

  it("refuses an empty candidate, a candidate on the evaluator, and an undeclared component", () => {
    assert.match(evolve("propose", "--id", "c0", "--component", "prompt", "--hypothesis", "h", "--pattern", "p").out, /no change on the editable surface/);
    put("scripts/live/cases.ts", "// the evaluator, edited\n");
    put("src/core/agent-rules.ts", 'export const RULES = ["Check a claim with verify.", "Prefer a narrow query."];\n');
    const r = evolve("propose", "--id", "c1", "--component", "skill", "--hypothesis", "narrow queries cut cost", "--pattern", "wasted exhaustive checks");
    assert.match(r.out, /problem: the diff changes component prompt, which the candidate did not declare/);
    put("scripts/live/cases.ts", "// the evaluator\n");
  });

  it("screens the shipped diff: a scenario-specific term in an added line is a leak and blocks evaluation", () => {
    put("src/core/agent-rules.ts", 'export const RULES = ["Check a claim with verify.", "For ZebraNetX style papers search twice."];\n');
    assert.equal(evolve("propose", "--id", "leaky", "--component", "prompt", "--hypothesis", "h", "--pattern", "p").code, 0);
    for (const n of [4, 5]) iteration("alpha-scenario", n, { cost: 0.4 });
    const s = evolve("screen", "leaky");
    assert.equal(s.code, 1);
    assert.match(s.out, /LEAK "ZebraNetX"/);
    assert.match(evolve("evaluate", "leaky", "alpha-scenario/iter-04", "alpha-scenario/iter-05").out, /REJECTED/);
    evolve("reject", "leaky", "--reason", "leaks");
  });

  it("a clean candidate that cuts cost beyond the noise is admissible; promotion needs the checklist and snapshots the new incumbent", () => {
    put("src/core/agent-rules.ts", 'export const RULES = ["Check a claim with verify.", "Prefer a narrow query for focused claims."];\n');
    const p = evolve("propose", "--id", "narrow", "--component", "prompt", "--hypothesis", "a narrow query avoids exhaustive checks", "--pattern", "wasted verification time");
    assert.equal(p.code, 0, p.out);
    assert.equal(evolve("screen", "narrow").code, 0);
    for (const n of [4, 5, 6]) iteration("alpha-scenario", n, { cost: 0.4 });
    iteration("alpha-scenario", 7, { cost: 0.4, outcome: "blocked: turn agent-1: client deadline reached" });
    assert.match(evolve("evaluate", "narrow", "alpha-scenario/iter-07").out, /INCONCLUSIVE/, "one blocked run is not evidence");
    const e = evolve("evaluate", "narrow", "alpha-scenario/iter-04", "alpha-scenario/iter-05", "alpha-scenario/iter-06", "alpha-scenario/iter-07");
    assert.match(e.out, /ADMISSIBLE \(within\)/, e.out);
    assert.match(evolve("promote", "narrow").out, /checklist/i);
    const pr = evolve("promote", "narrow", "--checklist-ok");
    assert.equal(pr.code, 0, pr.out);
    assert.match(pr.out, /incumbent H1/);
    assert.equal(readFileSync(join(root, "experiments/harness/snapshots/H1/src/core/agent-rules.ts"), "utf8").includes("narrow query"), true);
    assert.ok(readLog().some((r) => r.event === "rejected" && r.id === "leaky"), "the rejected edit stays in the history");
  });

  it("rollback restores the surface from a snapshot, and refuses without --yes", () => {
    assert.equal(evolve("rollback", "--to", "H0").code, 2);
    put("src/core/agent-rules.ts", "broken\n");
    const refused = evolve("rollback", "--to", "H0", "--yes");
    assert.notEqual(refused.code, 0, refused.out);
    assert.match(refused.out, /unrecorded changes|refused/i);
    assert.equal(readFileSync(join(root, "src/core/agent-rules.ts"), "utf8"), "broken\n", "rollback refusal preserves unrecorded bytes");
    put("src/core/agent-rules.ts", readFileSync(join(root, "experiments/harness/snapshots/H1/src/core/agent-rules.ts"), "utf8"));
    assert.equal(evolve("rollback", "--to", "H0", "--yes").code, 0);
    assert.equal(readFileSync(join(root, "src/core/agent-rules.ts"), "utf8"), 'export const RULES = ["Check a claim with verify."];\n');
  });

  it("audits record a reference first and then print aggregates only; a scenario outside the surface is refused", () => {
    assert.equal(evolve("audit", "alpha-scenario/iter-04", "--surface", "heldout").code, 2);
    const first = evolve("audit", "held-scenario/iter-01", "--surface", "heldout");
    assert.match(first.out, /reference recorded/);
    const again = evolve("audit", "held-scenario/iter-01", "--surface", "heldout");
    assert.match(again.out, /transfer ok/);
    assert.doesNotMatch(again.out, /c0|check/i, "no per-check details leak from the held-out surface");
  });

  it("prints and logs behaviour signatures: a baseline records them, and a candidate's log carries them with the delta against the incumbent", () => {
    for (const n of [8, 9, 10]) iteration("alpha-scenario", n, { behavior: { peak: 104858, invalid: 2, tools: 80 } });
    for (const n of [11, 12, 13]) iteration("alpha-scenario", n, { behavior: { peak: 157286, invalid: 4, tools: 80, compactions: 1 } });
    const b = evolve("baseline", "alpha-scenario/iter-08", "alpha-scenario/iter-09", "alpha-scenario/iter-10");
    assert.equal(b.code, 0, b.out);
    assert.match(b.out, /behavior: peak context 10\.0 % of the window · compactions 0 % · context overflow 0 % · invalid tool calls 2\.5 % · repeated actions 0 % · premature stops 0 %/);
    assert.ok(Math.abs(readLog().filter((r) => r.event === "baseline").at(-1).stats.behavior.peakContextFraction - 0.1) < 1e-5);
    put("src/core/agent-rules.ts", 'export const RULES = ["Check a claim with verify.", "Name the paper you checked."];\n');
    assert.equal(evolve("propose", "--id", "named", "--component", "prompt", "--hypothesis", "naming the paper makes the answer checkable", "--pattern", "unattributed answers").code, 0);
    assert.equal(evolve("screen", "named").code, 0);
    for (const n of [11, 12, 13]) iteration("alpha-scenario", n, { behavior: { peak: 157286, invalid: 4, tools: 80, compactions: 1 } });
    const e = evolve("evaluate", "named", "alpha-scenario/iter-11", "alpha-scenario/iter-12", "alpha-scenario/iter-13");
    assert.match(e.out, /behavior: peak context 15\.0 %/);
    assert.match(e.out, /behavior vs incumbent: peak context \+5\.0 points · compactions \+100 points · context overflow \+0 points · invalid tool calls \+2\.5 points/);
    const ev = readLog().filter((r) => r.event === "evaluated" && r.id === "named").at(-1);
    assert.equal(ev.stats.behavior.compactionRate, 1);
    assert.equal(ev.stats.behavior.contextOverflowRate, 0);
    assert.ok(Math.abs(ev.behavior_delta.peakContextFraction - 0.05) < 1e-6);
    assert.equal(ev.behavior_delta.compactionRate, 1);
    assert.equal(ev.behavior_delta.contextOverflowRate, 0);
  });

  it("a candidate evaluated against an incumbent that recorded no behaviour logs its own behaviour and no delta", () => {
    const m = readFileSync(join(root, "experiments/harness/manifest.yaml"), "utf8");
    writeFileSync(join(root, "experiments/harness/manifest.yaml"), m.replace(/ {2}behavior:[\s\S]*?(?=\n\w|\n$)/, ""));
    const e = evolve("evaluate", "named", "alpha-scenario/iter-11", "alpha-scenario/iter-12", "alpha-scenario/iter-13");
    assert.doesNotMatch(e.out, /behavior vs incumbent/);
    assert.equal(readLog().filter((r) => r.event === "evaluated" && r.id === "named").at(-1).behavior_delta, null);
  });

  it("refuses duplicate run refs, held-out runs in development commands, and mismatched run manifests", () => {
    assert.equal(evolve("propose", "--id", "runcheck", "--component", "prompt", "--hypothesis", "h", "--pattern", "p").code, 0);
    assert.equal(evolve("screen", "runcheck").code, 0);
    assert.match(evolve("evaluate", "runcheck", "alpha-scenario/iter-11", "alpha-scenario/iter-11").out, /duplicate/i);
    assert.match(evolve("baseline", "held-scenario/iter-01").out, /held-out/i);
    assert.match(evolve("evaluate", "runcheck", "held-scenario/iter-01").out, /held-out/i);
    iteration("alpha-scenario", 20, { cost: 0.4 });
    iteration("alpha-scenario", 21, { cost: 0.4 });
    iteration("alpha-scenario", 22, { cost: 0.4 });
    tweakManifest("alpha-scenario", 20, (m) => ({ ...m, model: "some-other-model" }));
    assert.match(evolve("evaluate", "runcheck", "alpha-scenario/iter-20").out, /model/i);
    tweakManifest("alpha-scenario", 21, (m) => ({ ...m, experimentSha256: "tampered-evaluator" }));
    assert.match(evolve("evaluate", "runcheck", "alpha-scenario/iter-21", "alpha-scenario/iter-22").out, /evaluator/i);
    tweakManifest("alpha-scenario", 22, (m) => ({ ...m, policy: { simulatedWindowTokens: 128000 } }));
    assert.match(evolve("evaluate", "runcheck", "alpha-scenario/iter-22").out, /window/i);
  });

  it("a protected edit beside a candidate edit is refused, and protected drift after evaluation blocks promotion", () => {
    put("scripts/live/cases.ts", "// the evaluator, edited alongside\n");
    put("src/core/agent-rules.ts", 'export const RULES = ["Check a claim with verify.", "Drift case."];\n');
    const p = evolve("propose", "--id", "driftcase", "--component", "prompt", "--hypothesis", "h", "--pattern", "p");
    assert.match(p.out, /REFUSED.*protected/i);
    put("scripts/live/cases.ts", "// the evaluator\n");
    assert.equal(evolve("propose", "--id", "driftclean", "--component", "prompt", "--hypothesis", "naming helps", "--pattern", "vague answers").code, 0);
    assert.equal(evolve("screen", "driftclean").code, 0);
    for (const n of [4, 5, 6]) iteration("alpha-scenario", n, { cost: 0.4 });
    const e = evolve("evaluate", "driftclean", "alpha-scenario/iter-04", "alpha-scenario/iter-05", "alpha-scenario/iter-06");
    assert.match(e.out, /ADMISSIBLE/, e.out);
    put("scripts/live/cases.ts", "// the evaluator, drifted after evaluation\n");
    assert.match(evolve("promote", "driftclean", "--checklist-ok").out, /protected/i);
    put("scripts/live/cases.ts", "// the evaluator\n");
    assert.equal(evolve("promote", "driftclean", "--checklist-ok").code, 0);
  });

  it("rollback restores deleted files and missing dirs, removes only candidate-owned additions, preserves unrelated work, and keeps the best score", () => {
    const manifestOf = () => {
      const lines = readFileSync(join(root, "experiments/harness/manifest.yaml"), "utf8");
      const incumbent = /incumbent_id: (\S+)/.exec(lines)?.[1] as string;
      const best = Number(/best_reliable_score: ([\d.]+)/.exec(lines)?.[1]);
      return { incumbent, best };
    };
    put("skills/uktub-research/extra.md", "# Extra candidate file\n");
    assert.equal(evolve("propose", "--id", "rollbackcase", "--component", "skill", "--hypothesis", "extra helps", "--pattern", "missing detail").code, 0);
    put("src/core/tools/unrelated-tool.ts", "// unrelated dirty work, never proposed\n");
    rmSync(join(root, "skills/uktub-research"), { recursive: true, force: true });
    put("skills/uktub-research/extra.md", "# Extra candidate file\n");
    const before = manifestOf();
    const r = evolve("rollback", "--to", "H0", "--yes");
    assert.equal(r.code, 0, r.out);
    assert.equal(existsSync(join(root, "skills/uktub-research/extra.md")), false, "candidate-owned addition is removed");
    assert.equal(readFileSync(join(root, "skills/uktub-research/SKILL.md"), "utf8"), "# Skill\nUse a narrow query.\n", "deleted snapshot files are restored with their dirs");
    assert.equal(readFileSync(join(root, "src/core/tools/unrelated-tool.ts"), "utf8"), "// unrelated dirty work, never proposed\n", "unrelated dirty files are preserved");
    const after = manifestOf();
    assert.equal(after.incumbent, "H0");
    assert.equal(after.best, before.best, "the monotone best score is retained, never lowered by a rollback");
  });

  it("a legacy protocol manifest requires explicit rebaseline; the H0 snapshot stays intact", () => {
    for (const n of [4, 5, 6]) iteration("alpha-scenario", n, { cost: 0.4 });
    const mp = join(root, "experiments/harness/manifest.yaml");
    const cur = readFileSync(mp, "utf8");
    assert.match(cur, /version: 3/);
    writeFileSync(mp, cur.replace(/version: 3/, "version: 2").replace(/ {2}protected_hash: .*/, "  protected_hash: null"));
    assert.match(evolve("baseline", "alpha-scenario/iter-04", "alpha-scenario/iter-05").out, /rebaseline/i);
    const r = evolve("rebaseline", "alpha-scenario/iter-04", "alpha-scenario/iter-05", "alpha-scenario/iter-06");
    assert.equal(r.code, 0, r.out);
    assert.equal(existsSync(join(root, "experiments/harness/snapshots/H0/src/core/agent-rules.ts")), true, "H0 is historical and never rewritten");
    assert.ok(readLog().some((e) => e.event === "rebaselined"), "the refresh is recorded in the history");
  });

  it("rebaseline snapshots an immutable new baseline so an unchanged propose reports no editable changes", () => {
    const lines = readFileSync(join(root, "experiments/harness/manifest.yaml"), "utf8");
    const baseline = /baseline_id: (\S+)/.exec(lines)?.[1] as string;
    assert.notEqual(baseline, "H0", "rebaseline moves the baseline id off H0");
    assert.equal(existsSync(join(root, `experiments/harness/snapshots/${baseline}/src/core/agent-rules.ts`)), true, "the new baseline snapshot exists");
    assert.equal(existsSync(join(root, "experiments/harness/snapshots/H0/src/core/agent-rules.ts")), true, "H0 is preserved");
    assert.match(evolve("propose", "--id", "unchanged", "--component", "prompt", "--hypothesis", "h", "--pattern", "p").out, /no change on the editable surface/);
  });

  it("evaluate refuses runs measured with an earlier surface, not the proposed bytes", () => {
    for (const n of [30, 31]) iteration("alpha-scenario", n, { cost: 0.4 });
    put("src/core/agent-rules.ts", `${readFileSync(join(root, "src/core/agent-rules.ts"), "utf8")}export const BIND = 1;\n`);
    assert.equal(evolve("propose", "--id", "bindcase", "--component", "prompt", "--hypothesis", "binding", "--pattern", "stale runs").code, 0);
    assert.equal(evolve("screen", "bindcase").code, 0);
    assert.match(evolve("evaluate", "bindcase", "alpha-scenario/iter-30", "alpha-scenario/iter-31").out, /earlier surface|cannot pass/);
    evolve("reject", "bindcase", "--reason", "stale runs refused");
    assert.equal(evolve("rollback", "--to", readBaseline(), "--yes").code, 0);
  });

  it("evaluate refuses a different model profile from the baseline, not a substring match", () => {
    put("src/core/agent-rules.ts", `${readFileSync(join(root, "src/core/agent-rules.ts"), "utf8")}export const PROF = 1;\n`);
    assert.equal(evolve("propose", "--id", "profcase", "--component", "prompt", "--hypothesis", "profile", "--pattern", "model soup").code, 0);
    assert.equal(evolve("screen", "profcase").code, 0);
    for (const n of [32, 33]) iteration("alpha-scenario", n, { cost: 0.4 });
    const p32 = join(root, "experiments/runs/alpha-scenario/iter-32/metrics.json");
    const metrics32 = JSON.parse(readFileSync(p32, "utf8"));
    metrics32.fallbackTurns = { uktub: ["agent-2"], simulator: [] };
    const raw32 = JSON.stringify(metrics32);
    writeFileSync(p32, raw32);
    tweakManifest("alpha-scenario", 32, (m) => ({
      ...m,
      metricsSha256: createHash("sha256").update(raw32, "utf8").digest("hex"),
      modelProfile: { agent: ["google-vertex/gemini-3.8-flash", "google-vertex/gemini-3.5-flash-lite"], simulator: ["google-vertex/gemini-3.8-flash"] },
    }));
    assert.match(evolve("evaluate", "profcase", "alpha-scenario/iter-32", "alpha-scenario/iter-33").out, /model profile|does not match the baseline/);
    evolve("reject", "profcase", "--reason", "profile mismatch refused");
    assert.equal(evolve("rollback", "--to", readBaseline(), "--yes").code, 0);
  });

  it("rollback refuses a dirtied candidate addition before mutating and leaves it surviving", () => {
    put("skills/uktub-research/dirty-extra.md", "# Dirty candidate file v1\n");
    assert.equal(evolve("propose", "--id", "dirtycase", "--component", "skill", "--hypothesis", "extra", "--pattern", "missing").code, 0);
    put("skills/uktub-research/dirty-extra.md", "# Dirty candidate file v2 (user edit)\n");
    const sentinel = readFileSync(join(root, "src/core/agent-rules.ts"), "utf8");
    const r = evolve("rollback", "--to", readBaseline(), "--yes");
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /refused/i);
    assert.equal(readFileSync(join(root, "skills/uktub-research/dirty-extra.md"), "utf8"), "# Dirty candidate file v2 (user edit)\n", "the dirtied addition survives");
    assert.equal(readFileSync(join(root, "src/core/agent-rules.ts"), "utf8"), sentinel, "no partial modifications before the conflict");
    rmSync(join(root, "skills/uktub-research/dirty-extra.md"));
    evolve("reject", "dirtycase", "--reason", "test cleanup");
  });

  it("an audit with a failed critical check is a regression, not compensated by the average", () => {
    iteration("held-scenario", 2, { surfaceHash: incumbentSurfaceHash() });
    const p = join(root, "experiments/runs/held-scenario/iter-02/metrics.json");
    const metrics = JSON.parse(readFileSync(p, "utf8"));
    metrics.checks = metrics.checks.map((c: { id: string; ok: boolean }) => (c.id === "citations-in-registry" ? { ...c, ok: false } : c));
    const raw = JSON.stringify(metrics);
    writeFileSync(p, raw);
    tweakManifest("held-scenario", 2, (m) => ({ ...m, metricsSha256: createHash("sha256").update(raw, "utf8").digest("hex") }));
    const again = evolve("audit", "held-scenario/iter-02", "--surface", "heldout");
    assert.equal(again.code, 1, again.out);
    assert.match(again.out, /REGRESSION/);
    assert.match(again.out, /critical/i);
  });
});

const readBaseline = (): string => {
  const lines = readFileSync(join(root, "experiments/harness/manifest.yaml"), "utf8");
  return /baseline_id: (\S+)/.exec(lines)?.[1] as string;
};
