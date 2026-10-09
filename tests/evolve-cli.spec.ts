/**
 * The self-improving harness controller end to end in a TEMPORARY repo (UKTUB_EVOLVE_ROOT): init, baseline from recorded runs, a candidate
 * that leaks, a clean candidate, evaluation, promotion with a rollback snapshot, rollback, protected-surface refusal. No providers.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
const iteration = (scenario: string, n: number, over: { score?: number; cost?: number; outcome?: string } = {}) => {
  const ok = Math.round((over.score ?? 1) * 9);
  put(`experiments/runs/${scenario}/iter-${String(n).padStart(2, "0")}/metrics.json`, JSON.stringify({
    scenario, iteration: n, outcome: over.outcome ?? "success", wallMs: 600000,
    agent: { toolCalls: 50, usage: { responses: 60, inputTokens: 300000, outputTokens: 40000, costUsd: over.cost ?? 0.7 } },
    checks: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, ok: i < ok })),
  }));
};
const readLog = () => readFileSync(join(root, "experiments/harness/evolution-log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

before(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-evolve-"));
  put("src/core/agent-rules.ts", 'export const RULES = ["Check a claim with verify_claim."];\n');
  put("skills/uktub-research/SKILL.md", "# Skill\nUse a narrow query.\n");
  put("scripts/live/cases.ts", "// the evaluator\n");
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
    const b = evolve("baseline", "alpha-scenario/iter-01", "alpha-scenario/iter-02", "alpha-scenario/iter-03");
    assert.equal(b.code, 0, b.out);
    assert.match(b.out, /score 1\.000/);
    assert.match(b.out, /cost spread 29 %/);
    assert.doesNotMatch(b.out, /PROVISIONAL/);
  });

  it("refuses an empty candidate, a candidate on the evaluator, and an undeclared component", () => {
    assert.match(evolve("propose", "--id", "c0", "--component", "prompt", "--hypothesis", "h", "--pattern", "p").out, /no change on the editable surface/);
    put("scripts/live/cases.ts", "// the evaluator, edited\n");
    put("src/core/agent-rules.ts", 'export const RULES = ["Check a claim with verify_claim.", "Prefer a narrow query."];\n');
    const r = evolve("propose", "--id", "c1", "--component", "skill", "--hypothesis", "narrow queries cut cost", "--pattern", "wasted exhaustive checks");
    assert.match(r.out, /problem: the diff changes component prompt, which the candidate did not declare/);
    put("scripts/live/cases.ts", "// the evaluator\n");
  });

  it("screens the shipped diff: a scenario-specific term in an added line is a leak and blocks evaluation", () => {
    put("src/core/agent-rules.ts", 'export const RULES = ["Check a claim with verify_claim.", "For ZebraNetX style papers search twice."];\n');
    assert.equal(evolve("propose", "--id", "leaky", "--component", "prompt", "--hypothesis", "h", "--pattern", "p").code, 0);
    const s = evolve("screen", "leaky");
    assert.equal(s.code, 1);
    assert.match(s.out, /LEAK "ZebraNetX"/);
    assert.match(evolve("evaluate", "leaky", "alpha-scenario/iter-04", "alpha-scenario/iter-05").out, /REJECTED/);
    evolve("reject", "leaky", "--reason", "leaks");
  });

  it("a clean candidate that cuts cost beyond the noise is admissible; promotion needs the checklist and snapshots the new incumbent", () => {
    put("src/core/agent-rules.ts", 'export const RULES = ["Check a claim with verify_claim.", "Prefer a narrow query for focused claims."];\n');
    const p = evolve("propose", "--id", "narrow", "--component", "prompt", "--hypothesis", "a narrow query avoids exhaustive checks", "--pattern", "wasted verification time");
    assert.equal(p.code, 0, p.out);
    assert.equal(evolve("screen", "narrow").code, 0);
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
    put("src/core/agent-rules.ts", "broken\n");
    assert.equal(evolve("rollback", "--to", "H0").code, 2);
    assert.equal(evolve("rollback", "--to", "H0", "--yes").code, 0);
    assert.equal(readFileSync(join(root, "src/core/agent-rules.ts"), "utf8"), 'export const RULES = ["Check a claim with verify_claim."];\n');
  });

  it("audits record a reference first and then print aggregates only; a scenario outside the surface is refused", () => {
    assert.equal(evolve("audit", "alpha-scenario/iter-04", "--surface", "heldout").code, 2);
    const first = evolve("audit", "held-scenario/iter-01", "--surface", "heldout");
    assert.match(first.out, /reference recorded/);
    const again = evolve("audit", "held-scenario/iter-01", "--surface", "heldout");
    assert.match(again.out, /transfer ok/);
    assert.doesNotMatch(again.out, /c0|check/i, "no per-check details leak from the held-out surface");
  });
});
