/**
 * Self-improving harness controller (harness_skill; plan: docs/plans/2026-10-07-self-improving-harness-plan.md).
 *
 *   node scripts/live/evolve.ts init                         create the manifest, the log and the H0 snapshot
 *   node scripts/live/evolve.ts baseline <scenario/iter-NN>…  measure the unchanged harness from existing runs -> delta, S_best
 *   node scripts/live/evolve.ts propose --id c1 --component skill --hypothesis "…" --pattern "…" [--structural] …
 *   node scripts/live/evolve.ts screen <id>                   leakage + protected-surface screen of the shipped diff
 *   node scripts/live/evolve.ts evaluate <id> <scenario/iter-NN>…   score a candidate from runs made with it applied
 *   node scripts/live/evolve.ts promote <id> --checklist-ok   admit it as the incumbent (snapshot first)
 *   node scripts/live/evolve.ts reject <id> --reason "…" | rollback [--to H0] --yes | prune | status
 *   node scripts/live/evolve.ts audit <scenario/iter-NN>… --surface heldout|ood   release audit; prints aggregates only
 *
 * The harness under edit is the working tree of the files named in the manifest's `components`. The evaluator (scripts/live, the
 * simulator and the frozen scenarios), the safety code and the held-out/OOD data are `protected`: a candidate touching them is refused.
 * Rollback snapshots are plain file copies under experiments/harness/snapshots/ (this package never commits for the owner).
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, globSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { componentsOf, DEFAULT_POLICY, decide, editBudget, estimateNoise, leakageScreen, leakageTermsFrom, matchesAny, pickUnderexplored, pruneCandidates, runMetricsOf, summarize, type HistoryEntry, type RunMetric, type RunStats } from "./evolution.ts";

const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();
const repo = process.env.UKTUB_EVOLVE_ROOT !== undefined ? resolve(process.env.UKTUB_EVOLVE_ROOT) : resolve(import.meta.dirname, "../.."); // the override lets tests drive the controller in a temporary repo
const dir = join(repo, "experiments/harness");
const manifestPath = join(dir, "manifest.yaml");
const logPath = join(dir, "evolution-log.jsonl");

interface Manifest {
  version: number;
  baseline_id: string;
  incumbent_id: string;
  best_reliable_score: number | null;
  noise_tolerance_delta: number | null;
  noise_cost_rel: number | null;
  noise_provisional: boolean | null;
  baseline_note: string;
  bounded_horizon_rounds: number;
  edit_budget: { early_max: number; late_min: number };
  stall_window_rounds: number;
  prune_window_rounds: number;
  metrics: string[];
  policy: typeof DEFAULT_POLICY;
  components: Record<string, string[]>;
  protected: string[];
  surfaces: { evolve: string[]; heldout: string[]; ood: string[] };
  incumbent_stats: RunStats | null;
  reference: { heldout: RunStats | null; ood: RunStats | null };
}

const DEFAULT_MANIFEST: Manifest = {
  version: 1,
  baseline_id: "H0",
  incumbent_id: "H0",
  best_reliable_score: null,
  noise_tolerance_delta: null,
  noise_cost_rel: null,
  noise_provisional: null,
  baseline_note: "",
  bounded_horizon_rounds: 20,
  edit_budget: { early_max: 4, late_min: 1 },
  stall_window_rounds: 3,
  prune_window_rounds: 4,
  metrics: ["task_score", "first_pass_delivery", "end_to_end_success", "input_tokens", "output_tokens", "total_policy_tokens", "tool_calls", "steps", "wall_time", "cost", "budget_stops"],
  policy: DEFAULT_POLICY,
  // The harness is everything around the fixed model: the editable surface, by component.
  components: {
    prompt: ["src/core/agent-rules.ts", "src/core/refusals.ts"],
    skill: ["skills/**"],
    client_tool: ["src/mcp/server.ts", "src/core/tools/*.ts"],
    output_plumbing: ["src/core/notices.ts", "src/core/bibrender.ts"],
    context_mgmt: ["src/core/rag/**", "src/core/chunk.ts", "src/core/chunk-document.ts", "src/core/sections.ts"],
    control_flow: ["src/core/verify/workflow.ts", "src/core/source/prepare.ts", "src/core/compile/run.ts"],
    config: ["config/**", "src/core/config.ts"],
    memory: [],
    subagent: ["src/pi/writer/**", "src/pi/subagent/**"],
  },
  // Never self-editable: the evaluator and its frozen inputs, the held-out and OOD data, permissions and safety boundaries (model weights are not in the tree).
  protected: [
    "scripts/live/**", "experiments/simulator.md", "experiments/scenarios/**", "experiments/harness/manifest.yaml", "tests/evolution.spec.ts",
    "src/core/tool-owned.ts", "src/pi/index.ts", "src/core/source/download.ts", "src/core/safe-detail.ts",
  ],
  surfaces: { evolve: ["rf-llm-literature-review"], heldout: ["heldout-federated-medical-segmentation"], ood: ["ood-claim-check-genomics"] },
  incumbent_stats: null,
  reference: { heldout: null, ood: null },
};

const flags = (argv: string[]): { pos: string[]; opt: Record<string, string | true> } => {
  const pos: string[] = [];
  const opt: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opt[a.slice(2)] = next;
        i++;
      } else opt[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, opt };
};
const die = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};
const load = (): Manifest => (existsSync(manifestPath) ? (parse(readFileSync(manifestPath, "utf8")) as Manifest) : die("no manifest: run `evolve init` first"));
const save = (m: Manifest): void => writeFileSync(manifestPath, stringify(m));
const log = (rec: Record<string, unknown>): void => {
  mkdirSync(dir, { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...rec })}\n`);
};
const readLog = (): Array<Record<string, any>> => (existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** The editable surface: every file matched by a component glob and not protected. */
function surfaceFiles(m: Manifest, root = repo): string[] {
  const out = new Set<string>();
  for (const globs of Object.values(m.components)) for (const g of globs) for (const f of globSync(g, { cwd: root })) if (!matchesAny(f, m.protected)) out.add(f);
  return [...out].filter((f) => isFile(join(root, f)) && !f.includes("node_modules")).sort();
}
const snapDir = (id: string): string => join(dir, "snapshots", id);
function snapshot(m: Manifest, id: string): number {
  const files = surfaceFiles(m);
  for (const f of files) {
    mkdirSync(dirname(join(snapDir(id), f)), { recursive: true });
    copyFileSync(join(repo, f), join(snapDir(id), f));
  }
  return files.length;
}
/** Unified diff of the editable surface, incumbent snapshot -> working tree. */
function surfaceDiff(m: Manifest, incumbent: string): { diff: string; files: string[] } {
  const snap = snapDir(incumbent);
  const names = new Set([...surfaceFiles(m), ...(existsSync(snap) ? globSync("**/*", { cwd: snap }).filter((f) => isFile(join(snap, f)) && !matchesAny(f, m.protected)) : [])]);
  const files: string[] = [];
  let diff = "";
  for (const f of [...names].sort()) {
    const a = isFile(join(snap, f)) ? join(snap, f) : "/dev/null";
    const b = isFile(join(repo, f)) ? join(repo, f) : "/dev/null";
    if (a !== "/dev/null" && b !== "/dev/null" && readFileSync(a).equals(readFileSync(b))) continue;
    if (a === "/dev/null" && b === "/dev/null") continue;
    const r = spawnSync("diff", ["-u", "--label", `a/${f}`, "--label", `b/${f}`, a, b], { encoding: "utf8" });
    if (r.status === 1) {
      diff += r.stdout;
      files.push(f);
    }
  }
  return { diff, files };
}

const runDir = (ref: string): string => join(repo, "experiments/runs", ref.includes("/") ? ref : die(`iteration ref must look like <scenario>/iter-NN, got ${ref}`));
function readRuns(refs: string[]): RunMetric[] {
  if (refs.length === 0) die("give at least one <scenario>/iter-NN");
  return refs.map((ref) => {
    const f = join(runDir(ref), "metrics.json");
    return existsSync(f) ? runMetricsOf(JSON.parse(readFileSync(f, "utf8"))) : die(`no metrics.json for ${ref}`);
  });
}
const fmt = (s: RunStats): string => `score ${s.score.toFixed(3)} · success ${(s.successRate * 100).toFixed(0)}% · cost $${s.costUsd.toFixed(2)} · tool calls ${s.toolCalls.toFixed(0)} · ${s.runs} run(s), ${s.blocked} blocked`;

function leakageTerms(m: Manifest): string[] {
  const read = (name: string) => ({ name, text: existsSync(join(repo, "experiments/scenarios", `${name}.md`)) ? readFileSync(join(repo, "experiments/scenarios", `${name}.md`), "utf8") : "" });
  const names = [...m.surfaces.evolve, ...m.surfaces.heldout, ...m.surfaces.ood];
  const checkIds = ["stop-signal", "all-turns-completed", "citations-in-registry", "bibliography-matches-registry", "compiled-after-last-edit", "pointers-issued-by-tools", "provider-warnings-disclosed", "evidence-tools-used", "no-unrequested-removal"];
  return [...leakageTermsFrom(names.map(read)), ...checkIds];
}

const { pos, opt } = flags(process.argv.slice(3));
const cmd = process.argv[2];

if (cmd === "init") {
  if (existsSync(manifestPath)) die("already initialized (the baseline H0 is immutable)");
  mkdirSync(dir, { recursive: true });
  save(DEFAULT_MANIFEST);
  const n = snapshot(DEFAULT_MANIFEST, "H0");
  log({ event: "init", id: "H0", files: n });
  console.log(`initialized: manifest, log, and the H0 snapshot of ${n} editable files`);
} else if (cmd === "baseline") {
  const m = load();
  const runs = readRuns(pos);
  const noise = estimateNoise(runs);
  const stats = summarize(runs);
  m.noise_tolerance_delta = noise.scoreDelta;
  m.noise_cost_rel = noise.costRel;
  m.noise_provisional = noise.provisional;
  m.best_reliable_score = stats.score;
  m.incumbent_stats = stats;
  m.baseline_note = String(opt.note ?? `measured from ${pos.join(", ")}`);
  save(m);
  log({ event: "baseline", runs: pos, noise, stats, note: m.baseline_note });
  console.log(`baseline H0: ${fmt(stats)}\nnoise: score delta ${noise.scoreDelta.toFixed(3)}, cost spread ${(noise.costRel * 100).toFixed(0)} %${noise.provisional ? " (PROVISIONAL: fewer than 3 completed runs)" : ""}`);
} else if (cmd === "propose") {
  const m = load();
  const id = String(opt.id ?? die("--id required"));
  if (readLog().some((r) => r.id === id && r.event === "candidate")) die(`candidate ${id} already exists`);
  const declared = String(opt.component ?? die("--component required (comma-separated)")).split(",");
  for (const f of ["hypothesis", "pattern"]) if (typeof opt[f] !== "string") die(`--${f} required`);
  const round = Math.max(0, ...readLog().filter((r) => r.event === "candidate").map((r) => Number(r.round))) + 1;
  const { diff, files } = surfaceDiff(m, m.incumbent_id);
  if (files.length === 0) die("no change on the editable surface relative to the incumbent");
  const attr = componentsOf(files, m.components, m.protected);
  const problems: string[] = [];
  const budget = editBudget(round, m.bounded_horizon_rounds, m.edit_budget);
  if (attr.unmapped.length > 0) problems.push(`files in no component: ${attr.unmapped.join(", ")}`);
  const actual = Object.keys(attr.byComponent);
  for (const c of actual) if (!declared.includes(c)) problems.push(`the diff changes component ${c}, which the candidate did not declare`);
  if (actual.length > budget) problems.push(`${actual.length} components changed; the annealed budget for round ${round} is ${budget}`);
  const history: HistoryEntry[] = readLog().filter((r) => r.event === "evaluated").map((r) => ({ round: r.round, component: r.component, scoreDelta: r.dScore, costDelta: r.dCost, accepted: r.admissible }));
  const hint = pickUnderexplored(history, Object.keys(m.components), m.stall_window_rounds, m.noise_tolerance_delta ?? 0);
  mkdirSync(join(dir, "candidates"), { recursive: true });
  writeFileSync(join(dir, "candidates", `${id}.diff`), diff);
  log({ event: "candidate", id, round, component: declared.join(","), hypothesis: opt.hypothesis, failure_pattern_targeted: opt.pattern, expected_benefit: opt.benefit ?? null, expected_cost_change: opt["cost-change"] ?? null, risks: opt.risks ?? null, structural: opt.structural === true, files, protected: attr.protected, problems });
  console.log(`candidate ${id} (round ${round}, budget ${budget}): ${files.length} file(s) in ${actual.join(", ")}`);
  if (attr.protected.length > 0) console.log(`REFUSED: protected surface edited: ${attr.protected.join(", ")}`);
  for (const p of problems) console.log(`problem: ${p}`);
  if (hint !== null) console.log(`stalled for ${m.stall_window_rounds} rounds: reserve a candidate for the untouched component "${hint}"`);
} else if (cmd === "screen") {
  const m = load();
  const id = pos[0] ?? die("candidate id required");
  const file = join(dir, "candidates", `${id}.diff`);
  if (!existsSync(file)) die(`no diff for ${id}`);
  const findings = leakageScreen(readFileSync(file, "utf8"), leakageTerms(m));
  const cand = readLog().find((r) => r.event === "candidate" && r.id === id);
  log({ event: "screened", id, findings, protected: cand?.protected ?? [] });
  console.log(findings.length === 0 ? `${id}: no evolve-set, held-out or evaluator specifics in the added lines` : findings.map((f) => `LEAK ${JSON.stringify(f.term)} in ${f.line.slice(0, 120)}`).join("\n"));
  process.exitCode = findings.length > 0 || (cand?.protected ?? []).length > 0 ? 1 : 0;
} else if (cmd === "evaluate") {
  const m = load();
  const id = pos[0] ?? die("candidate id required");
  const cand = readLog().find((r) => r.event === "candidate" && r.id === id) ?? die(`unknown candidate ${id}`);
  if (m.best_reliable_score === null || m.noise_tolerance_delta === null || m.incumbent_stats === null) die("run `evolve baseline` first (S_best and the noise delta are required)");
  const runs = readRuns(pos.slice(1));
  const stats = summarize(runs);
  const screened = readLog().filter((r) => r.event === "screened" && r.id === id).at(-1);
  if (screened === undefined) die(`screen ${id} before evaluating it (leakage is screened before expensive evaluation)`);
  const d = decide({ candidate: stats, incumbent: m.incumbent_stats, sBest: m.best_reliable_score, noise: { scoreDelta: m.noise_tolerance_delta, costRel: m.noise_cost_rel ?? 0 }, leakage: screened.findings, guardsOk: (cand.protected as string[]).length === 0 && (cand.problems as string[]).length === 0, structural: cand.structural === true, policy: m.policy });
  log({ event: "evaluated", id, round: cand.round, component: cand.component, runs: pos.slice(1), stats, ...d });
  console.log(`${id}: ${fmt(stats)}\nvs incumbent: dScore ${d.dScore.toFixed(3)}, dCost ${(d.dCost * 100).toFixed(0)} % -> ${d.status.toUpperCase()} (${d.band})\n- ${d.reasons.join("\n- ")}`);
} else if (cmd === "promote") {
  const m = load();
  const id = pos[0] ?? die("candidate id required");
  if (opt["checklist-ok"] !== true) die("read .agents/skills/harness_skill/promotion-checklist.md, confirm every item, and pass --checklist-ok");
  const ev = readLog().filter((r) => r.event === "evaluated" && r.id === id).at(-1) ?? die(`${id} has not been evaluated`);
  if (ev.admissible !== true) die(`${id} is not admissible: ${(ev.reasons as string[]).join("; ")}`);
  const next = `H${readLog().filter((r) => r.event === "promoted").length + 1}`;
  const n = snapshot(m, next);
  const stats = ev.stats as RunStats;
  log({ event: "promoted", id, snapshot: next, from: m.incumbent_id, files: n, stats });
  m.incumbent_id = next;
  m.incumbent_stats = stats;
  m.best_reliable_score = Math.max(m.best_reliable_score ?? 0, stats.score); // monotone: the floor never moves down to excuse a regression
  save(m);
  console.log(`promoted ${id} as incumbent ${next} (${n} files snapshotted); S_best ${m.best_reliable_score?.toFixed(3)}`);
} else if (cmd === "reject") {
  log({ event: "rejected", id: pos[0] ?? die("candidate id required"), reason: opt.reason ?? "" });
  console.log("rejected; the failed edit stays in the history");
} else if (cmd === "rollback") {
  const m = load();
  const to = String(opt.to ?? m.incumbent_id);
  if (opt.yes !== true) die(`would restore the editable surface from snapshot ${to}; pass --yes`);
  const snap = snapDir(to);
  if (!existsSync(snap)) die(`no snapshot ${to}`);
  const files = globSync("**/*", { cwd: snap }).filter((f) => !matchesAny(f, m.protected) && isFile(join(snap, f)));
  for (const f of files) copyFileSync(join(snap, f), join(repo, f));
  log({ event: "rollback", to, files: files.length });
  console.log(`restored ${files.length} file(s) from ${to}. Rebuild before running anything.`);
} else if (cmd === "prune") {
  const m = load();
  const history: HistoryEntry[] = readLog().filter((r) => r.event === "evaluated").map((r) => ({ round: r.round, component: r.component, scoreDelta: r.dScore, costDelta: r.dCost, accepted: r.admissible }));
  const c = pruneCandidates(history, m.prune_window_rounds, m.noise_tolerance_delta ?? 0);
  console.log(c.length === 0 ? "no component has been exercised for the whole window without a positive contribution" : `prune candidates (no positive contribution over ${m.prune_window_rounds} evaluated edits): ${c.join(", ")}`);
} else if (cmd === "audit") {
  const m = load();
  const surface = (opt.surface === "heldout" || opt.surface === "ood" ? opt.surface : die("--surface heldout|ood")) as "heldout" | "ood";
  const runs = readRuns(pos);
  const allowed = new Set(m.surfaces[surface]);
  for (const r of runs) if (!allowed.has(r.scenario)) die(`${r.scenario} is not a ${surface} scenario in the manifest`);
  const stats = summarize(runs);
  const ref = m.reference[surface];
  log({ event: "audit", surface, incumbent: m.incumbent_id, stats });
  if (ref === null) {
    m.reference[surface] = stats;
    save(m);
    console.log(`${surface} reference recorded for ${m.incumbent_id}: ${fmt(stats)}`);
  } else {
    // Aggregates only: the audit result must not become evolve data.
    const regress = stats.score < ref.score - (m.noise_tolerance_delta ?? 0) || (ref.costUsd > 0 && (stats.costUsd - ref.costUsd) / ref.costUsd > m.policy.maxCostIncreaseWithGain);
    console.log(`${surface} audit of ${m.incumbent_id}: ${regress ? "REGRESSION against the reference" : "transfer ok"} (${fmt(stats)})`);
    process.exitCode = regress ? 1 : 0;
  }
} else if (cmd === "status") {
  const m = load();
  const log_ = readLog();
  console.log(`incumbent ${m.incumbent_id} (baseline ${m.baseline_id}); S_best ${m.best_reliable_score ?? "—"}; noise delta ${m.noise_tolerance_delta ?? "—"} (cost spread ${m.noise_cost_rel === null ? "—" : `${(m.noise_cost_rel * 100).toFixed(0)} %`})${m.noise_provisional ? " PROVISIONAL" : ""}`);
  if (m.incumbent_stats) console.log(`incumbent stats: ${fmt(m.incumbent_stats)}`);
  console.log(`candidates: ${log_.filter((r) => r.event === "candidate").length}, evaluated: ${log_.filter((r) => r.event === "evaluated").length}, promoted: ${log_.filter((r) => r.event === "promoted").length}, rejected: ${log_.filter((r) => r.event === "rejected").length}`);
  console.log(`audit references: held-out ${m.reference.heldout ? "recorded" : "none"}, OOD ${m.reference.ood ? "recorded" : "none"}`);
  console.log(`editable surface: ${surfaceFiles(m).length} files; protected globs: ${m.protected.length}; relative to repo: ${relative(process.cwd(), repo) || "."}`);
} else {
  die("usage: evolve.ts init | baseline | propose | screen | evaluate | promote | reject | rollback | prune | audit | status (see the file header)");
}
