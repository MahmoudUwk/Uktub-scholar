/**
 * Self-improving harness controller (harness_skill; plan: docs/plans/2026-10-07-self-improving-harness-plan.md).
 *
 *   node scripts/live/evolve.ts init                         create the manifest, the log and the H0 snapshot
 *   node scripts/live/evolve.ts baseline <scenario/iter-NN>…  measure the unchanged harness from existing runs -> delta, S_best
 *   node scripts/live/evolve.ts rebaseline <scenario/iter-NN>…  explicit refresh after a protocol or protected-surface change (H0 preserved, old records historical)
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
import { appendFileSync, copyFileSync, existsSync, globSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { behaviorDelta, componentsOf, criticalCheckRegressions, DEFAULT_POLICY, decide, editBudget, estimateNoise, leakageScreen, leakageTermsFrom, matchesAny, pickUnderexplored, pruneCandidates, PROTOCOL_CHECK_IDS, runMetricsOf, summarize, type BehaviorStats, type HistoryEntry, type RunMetric, type RunStats } from "./evolution.ts";
import { fingerprintFiles, sha256File, sha256Text, stagingSurfaceHashes, validateRunSet, type RunEvidence } from "./provenance.ts";

const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();
const repo = process.env.UKTUB_EVOLVE_ROOT !== undefined ? resolve(process.env.UKTUB_EVOLVE_ROOT) : resolve(import.meta.dirname, "../.."); // the override lets tests drive the controller in a temporary repo
const dir = join(repo, "experiments/harness");
const manifestPath = join(dir, "manifest.yaml");
const logPath = join(dir, "evolution-log.jsonl");

interface Manifest {
  /** Controller protocol version. v3 binds runs by provenance and compares the protected surface independently; v2 records are historical, never silently re-read. */
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
  /** Fingerprint of the protected surface at the last init/promote/rebaseline (the manifest itself is controller state and excluded). */
  protected_hash: string | null;
  /** Stable hash of the scope definition (components + protected globs) at the last init/promote/rebaseline. */
  scope_hash: string | null;
  /** Comparison identity the baseline runs were measured with (model/window/policy/image/engine/keys must match to compare). */
  baseline_identity: BaselineIdentity | null;
  /** Prior epoch bests: rebaseline starts a new score scale but keeps the historical record; within an epoch the best is monotone. */
  best_history: Array<{ id: string; score: number }>;
  reference: { heldout: RunStats | null; ood: RunStats | null };
}

interface BaselineIdentity {
  model: unknown;
  providerKeysPassed: unknown;
  simulatedWindowTokens: unknown;
  image: unknown;
  engineDevice: unknown;
}

const DEFAULT_MANIFEST: Manifest = {
  version: 3,
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
  metrics: ["task_score", "first_pass_delivery", "end_to_end_success", "input_tokens", "output_tokens", "total_policy_tokens", "tool_calls", "steps", "wall_time", "cost", "budget_stops", "context_overflow_rate", "premature_stop_rate", "repeated_action_rate", "invalid_tool_call_rate"],
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
  protected_hash: null,
  scope_hash: null,
  baseline_identity: null,
  best_history: [],
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

/** The protected surface as files: compared independently of the editable diff (which excludes these by construction). The manifest itself is controller state, not drift. */
function protectedInputs(m: Manifest, root = repo): string[] {
  const out = new Set<string>();
  for (const g of m.protected) {
    if (g === "experiments/harness/manifest.yaml") continue;
    for (const f of globSync(g, { cwd: root })) if (isFile(join(root, f)) && !f.includes("node_modules")) out.add(f);
  }
  return [...out].sort();
}
const protectedHashOf = (_m: Manifest): string => stagingSurfaceHashes(repo).protectedHash;
/** Fingerprint of the current editable surface: binds propose, evaluate and promote to the same bytes (same globs the staging manifest uses). */
const surfaceHashOf = (_m: Manifest): string => stagingSurfaceHashes(repo).surfaceHash;
/** Stable hash of the scope definition (component + protected globs) the hashes above were computed from. */
const scopeHashOf = (): string => stagingSurfaceHashes(repo).scopeHash;
/** Fingerprint of a snapshot's bytes (reads from the snapshot dir, not the working tree). */
function snapshotHash(id: string): string | null {
  const snap = snapDir(id);
  if (!existsSync(snap)) return null;
  try {
    const files = globSync("**/*", { cwd: snap }).filter((f) => isFile(join(snap, f))).sort();
    return fingerprintFiles(snap, files);
  } catch {
    return null;
  }
}

/** Old protocol records stay historical: promotion decisions never silently re-read them under the new checks. */
function requireProtocol(m: Manifest): void {
  if ((m.version ?? 2) < 3) die(`manifest protocol v${m.version ?? 2} is historical (the H0 snapshot is preserved, never rewritten): run \`evolve rebaseline <scenario>/iter-NN …\` with current compatible runs to establish an explicit new baseline under protocol v3`);
}

const runDir = (ref: string): string => join(repo, "experiments/runs", ref.includes("/") ? ref : die(`iteration ref must look like <scenario>/iter-NN, got ${ref}`));
function readRunsChecked(m: Manifest, refs: string[], op: string, auditSurface?: "heldout" | "ood"): { runs: RunMetric[]; evidence: RunEvidence[] } {
  if (refs.length === 0) die("give at least one <scenario>/iter-NN");
  const evidence: RunEvidence[] = refs.map((ref) => {
    const d = runDir(ref);
    const metricsFile = join(d, "metrics.json");
    if (!existsSync(metricsFile)) die(`no metrics.json for ${ref}`);
    const metricsRaw = readFileSync(metricsFile, "utf8");
    const metrics = JSON.parse(metricsRaw);
    const manifestFile = [join(d, "evidence/manifest.json"), join(d, "manifest.json")].find((f) => existsSync(f));
    const manifest = manifestFile === undefined ? null : JSON.parse(readFileSync(manifestFile, "utf8"));
    const seg = ref.split("/");
    return { ref, scenario: seg[0] as string, iteration: Number(seg[1]?.replace("iter-", "")), metrics, metricsRaw, manifest };
  });
  const problems = validateRunSet(evidence, { evolve: m.surfaces.evolve, heldout: m.surfaces.heldout, ood: m.surfaces.ood, ...(auditSurface === undefined ? {} : { auditSurface }), repo }, op);
  if (problems.length > 0) die(problems.join("\n"));
  return { runs: evidence.map((e) => runMetricsOf(e.metrics)), evidence };
}
/** The one package identity an evaluated set was measured with (validated identical across the set). */
const runIdentity = (evidence: RunEvidence[]): { commit: unknown; workingTreeDiffSha256: unknown; packageHash: unknown } => ({
  commit: evidence[0]?.manifest?.commit,
  workingTreeDiffSha256: evidence[0]?.manifest?.workingTreeDiffSha256,
  packageHash: evidence[0]?.manifest?.packageHash,
});
/** The comparison identity a set was measured with: model/window/policy/image/engine/keys must match the baseline to compare. The git diff is excluded: a candidate naturally differs. */
const comparisonIdentity = (evidence: RunEvidence[]): BaselineIdentity => {
  const m = (evidence[0]?.manifest ?? {}) as Record<string, unknown>;
  return {
    model: m["model"] ?? null,
    providerKeysPassed: m["providerKeysPassed"] ?? null,
    simulatedWindowTokens: (m["policy"] as Record<string, unknown> | undefined)?.["simulatedWindowTokens"] ?? null,
    image: m["image"] ?? null,
    engineDevice: m["engineDevice"] ?? null,
  };
};
const identityProblems = (label: string, got: BaselineIdentity, want: BaselineIdentity | null): string[] => {
  if (want === null) return [`${label}: no baseline comparison identity is recorded; run \`evolve baseline\` first`];
  const out: string[] = [];
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  if (!same(got.model, want.model)) out.push(`${label}: model profile ${JSON.stringify(got.model)} does not match the baseline ${JSON.stringify(want.model)} (different actual profiles are incomparable: partition, do not compare)`);
  if (!same(got.providerKeysPassed, want.providerKeysPassed)) out.push(`${label}: key profile ${JSON.stringify(got.providerKeysPassed)} does not match the baseline ${JSON.stringify(want.providerKeysPassed)}`);
  if (!same(got.simulatedWindowTokens, want.simulatedWindowTokens)) out.push(`${label}: window policy ${JSON.stringify(got.simulatedWindowTokens)} does not match the baseline ${JSON.stringify(want.simulatedWindowTokens)}`);
  if (!same(got.image, want.image)) out.push(`${label}: sandbox image ${JSON.stringify(got.image)} does not match the baseline ${JSON.stringify(want.image)}`);
  if (!same(got.engineDevice, want.engineDevice)) out.push(`${label}: engine config ${JSON.stringify(got.engineDevice)} does not match the baseline ${JSON.stringify(want.engineDevice)}`);
  return out;
};
const pct = (x: number | null, digits: number): string => (x === null ? "n/a" : `${(x * 100).toFixed(digits)} %`);
const points = (x: number | null, digits: number): string => (x === null ? "n/a" : `${x >= 0 ? "+" : "-"}${Math.abs(x * 100).toFixed(digits)} points`);
/** The behaviour signatures of harness skill v2; absent when no completed run recorded behaviour. Compactions and overflows are separate: a working host compaction is diagnostic, never a failure. */
const fmtBehavior = (b: BehaviorStats | undefined): string | null =>
  b === undefined ? null : `behavior: peak context ${pct(b.peakContextFraction, 1)} of the window · compactions ${pct(b.compactionRate, 0)} · context overflow ${pct(b.contextOverflowRate, 0)} · invalid tool calls ${pct(b.invalidToolCallRate, 1)} · repeated actions ${pct(b.repeatedActionRate, 0)} · premature stops ${pct(b.prematureStopRate, 0)}`;
const fmtBehaviorDelta = (d: BehaviorStats | null): string | null =>
  d === null ? null : `behavior vs incumbent: peak context ${points(d.peakContextFraction, 1)} · compactions ${points(d.compactionRate, 0)} · context overflow ${points(d.contextOverflowRate, 0)} · invalid tool calls ${points(d.invalidToolCallRate, 1)} · repeated actions ${points(d.repeatedActionRate, 0)} · premature stops ${points(d.prematureStopRate, 0)}`;
const lines = (...xs: Array<string | null>): string => xs.filter((x): x is string => x !== null).join("\n");
const fmt = (s: RunStats): string => `score ${s.score.toFixed(3)} · success ${(s.successRate * 100).toFixed(0)}% · cost $${s.costUsd.toFixed(2)} · tool calls ${s.toolCalls.toFixed(0)} · ${s.runs} run(s), ${s.blocked} blocked`;

function leakageTerms(m: Manifest): string[] {
  const read = (name: string) => ({ name, text: existsSync(join(repo, "experiments/scenarios", `${name}.md`)) ? readFileSync(join(repo, "experiments/scenarios", `${name}.md`), "utf8") : "" });
  const names = [...m.surfaces.evolve, ...m.surfaces.heldout, ...m.surfaces.ood];
  const checkIds = [...PROTOCOL_CHECK_IDS];
  return [...leakageTermsFrom(names.map(read)), ...checkIds];
}

const { pos, opt } = flags(process.argv.slice(3));
const cmd = process.argv[2];

if (cmd === "init") {
  if (existsSync(manifestPath)) die("already initialized (the baseline H0 is immutable)");
  mkdirSync(dir, { recursive: true });
  const fresh: Manifest = { ...DEFAULT_MANIFEST, protected_hash: protectedHashOf(DEFAULT_MANIFEST), scope_hash: scopeHashOf() };
  save(fresh);
  const n = snapshot(fresh, "H0");
  log({ event: "init", id: "H0", files: n, protected: protectedInputs(fresh).length, protected_hash: fresh.protected_hash, scope_hash: fresh.scope_hash, surfaceHash: surfaceHashOf(fresh) });
  console.log(`initialized: manifest, log, and the H0 snapshot of ${n} editable files`);
} else if (cmd === "baseline") {
  const m = load();
  requireProtocol(m);
  const prot = protectedHashOf(m);
  if ((m.protected_hash ?? null) !== null && prot !== m.protected_hash) die(`the protected surface changed since ${m.incumbent_id} (evaluator/scenario/safety edits are owner maintenance, never a self-proposed candidate): run \`evolve rebaseline …\` to establish an explicit new baseline under the current bytes`);
  const scope = scopeHashOf();
  if ((m.scope_hash ?? null) !== null && scope !== m.scope_hash) die(`the scope definition changed since ${m.incumbent_id} (components/protected globs are owner maintenance): run \`evolve rebaseline …\` to establish an explicit new baseline`);
  const { runs, evidence } = readRunsChecked(m, pos, "baseline");
  const now = surfaceHashOf(m);
  for (const e of evidence) {
    if (e.manifest?.surfaceHash !== now) die(`baseline refused: ${e.ref} was measured with surface ${String(e.manifest?.surfaceHash ?? "missing").slice(0, 12)} but the current tree is ${now.slice(0, 12)} (baseline measures the current bytes; re-run with the current tree)`);
  }
  const noise = estimateNoise(runs);
  const stats = summarize(runs);
  if (stats.criticalRate === null) die("baseline refused: the runs carry no critical checks (missing checks never pass by omission; re-run with the current harness)");
  m.noise_tolerance_delta = noise.scoreDelta;
  m.noise_cost_rel = noise.costRel;
  m.noise_provisional = noise.provisional;
  m.best_reliable_score = stats.score;
  m.incumbent_stats = stats;
  m.baseline_identity = comparisonIdentity(evidence);
  m.baseline_note = String(opt.note ?? `measured from ${pos.join(", ")}`);
  save(m);
  log({ event: "baseline", snapshot: m.baseline_id, runs: pos, identity: runIdentity(evidence), comparison: m.baseline_identity, surfaceHash: now, noise, stats, note: m.baseline_note });
  console.log(lines(`baseline ${m.baseline_id}: ${fmt(stats)}`, `noise: score delta ${noise.scoreDelta.toFixed(3)}, cost spread ${(noise.costRel * 100).toFixed(0)} %${noise.provisional ? " (PROVISIONAL: fewer than 3 completed runs)" : ""}`, fmtBehavior(stats.behavior)));
} else if (cmd === "rebaseline") {
  // Explicit refresh when the protocol or the protected bytes changed: the H0 snapshot is preserved, old results stay
  // historical in the log, and the current tree gets an immutable new baseline snapshot. Never rewrites history, never re-labels old runs.
  const m = load();
  const from = m.version ?? 2;
  const { runs, evidence } = readRunsChecked(m, pos, "rebaseline");
  const now = surfaceHashOf(m);
  for (const e of evidence) {
    if (e.manifest?.surfaceHash !== now) die(`rebaseline refused: ${e.ref} was measured with surface ${String(e.manifest?.surfaceHash ?? "missing").slice(0, 12)} but the current tree is ${now.slice(0, 12)} (rebaseline measures the current bytes; re-run with the current tree)`);
  }
  const noise = estimateNoise(runs);
  const stats = summarize(runs);
  if (stats.criticalRate === null) die("rebaseline refused: the runs carry no critical checks (missing checks never pass by omission; re-run with the current harness)");
  const priorBest = m.best_reliable_score;
  if (priorBest !== null) m.best_history = [...(m.best_history ?? []), { id: m.baseline_id, score: priorBest }];
  const n = readLog().filter((r) => r.event === "rebaselined").length + 1;
  const newId = `B${n}`;
  const files = snapshot(m, newId);
  m.version = 3;
  m.baseline_id = newId;
  m.incumbent_id = newId;
  m.protected_hash = protectedHashOf(m);
  m.scope_hash = scopeHashOf();
  m.noise_tolerance_delta = noise.scoreDelta;
  m.noise_cost_rel = noise.costRel;
  m.noise_provisional = noise.provisional;
  m.best_reliable_score = stats.score;
  m.incumbent_stats = stats;
  m.baseline_identity = comparisonIdentity(evidence);
  m.baseline_note = `rebaselined from protocol v${from} on the current tree from ${pos.join(", ")} (earlier protocol records are historical)`;
  save(m);
  log({ event: "rebaselined", snapshot: newId, fromProtocol: from, priorBest, files, runs: pos, identity: runIdentity(evidence), comparison: m.baseline_identity, surfaceHash: now, noise, stats, note: m.baseline_note });
  console.log(lines(`rebaselined (protocol v${from} -> v3) as ${newId} (${files} files): ${fmt(stats)}`, `noise: score delta ${noise.scoreDelta.toFixed(3)}, cost spread ${(noise.costRel * 100).toFixed(0)} %${noise.provisional ? " (PROVISIONAL: fewer than 3 completed runs)" : ""}`, fmtBehavior(stats.behavior)));
} else if (cmd === "propose") {
  const m = load();
  requireProtocol(m);
  const id = String(opt.id ?? die("--id required"));
  if (readLog().some((r) => r.id === id && r.event === "candidate")) die(`candidate ${id} already exists`);
  const declared = String(opt.component ?? die("--component required (comma-separated)")).split(",");
  for (const f of ["hypothesis", "pattern"]) if (typeof opt[f] !== "string") die(`--${f} required`);
  const round = Math.max(0, ...readLog().filter((r) => r.event === "candidate").map((r) => Number(r.round))) + 1;
  // The protected surface is compared independently: the editable diff excludes it by construction, so drift here
  // would otherwise be invisible to every later check.
  const protHash = protectedHashOf(m);
  const protCount = protectedInputs(m).length;
  const protDrift = (m.protected_hash ?? null) !== null && protHash !== m.protected_hash;
  const scopeNow = scopeHashOf();
  const scopeDrift = (m.scope_hash ?? null) !== null && scopeNow !== m.scope_hash;
  const { diff, files } = surfaceDiff(m, m.incumbent_id);
  if (files.length === 0 && !protDrift && !scopeDrift) die("no change on the editable surface relative to the incumbent");
  if (files.length === 0) die(`REFUSED: the protected surface drifted since ${m.incumbent_id} (${protCount} protected files); restore it — protected bytes are never part of a candidate`);
  const attr = componentsOf(files, m.components, m.protected);
  const problems: string[] = [];
  if (protDrift) problems.push(`the protected surface drifted since ${m.incumbent_id} (${protCount} protected files now); protected drift is refused at propose, evaluate and promote`);
  if (scopeDrift) problems.push(`the scope definition drifted since ${m.incumbent_id}; scope changes are owner maintenance, never a self-proposed candidate`);
  const budget = editBudget(round, m.bounded_horizon_rounds, m.edit_budget);
  if (attr.unmapped.length > 0) problems.push(`files in no component: ${attr.unmapped.join(", ")}`);
  const actual = Object.keys(attr.byComponent);
  for (const c of actual) if (!declared.includes(c)) problems.push(`the diff changes component ${c}, which the candidate did not declare`);
  if (actual.length > budget) problems.push(`${actual.length} components changed; the annealed budget for round ${round} is ${budget}`);
  const history: HistoryEntry[] = readLog().filter((r) => r.event === "evaluated").map((r) => ({ round: r.round, component: r.component, scoreDelta: r.dScore, costDelta: r.dCost, accepted: r.admissible }));
  const hint = pickUnderexplored(history, Object.keys(m.components), m.stall_window_rounds, m.noise_tolerance_delta ?? 0);
  mkdirSync(join(dir, "candidates"), { recursive: true });
  writeFileSync(join(dir, "candidates", `${id}.diff`), diff);
  const fileHashes: Record<string, string> = {};
  for (const f of files) fileHashes[f] = sha256File(join(repo, f)) ?? "missing";
  log({ event: "candidate", id, round, component: declared.join(","), hypothesis: opt.hypothesis, failure_pattern_targeted: opt.pattern, expected_benefit: opt.benefit ?? null, expected_cost_change: opt["cost-change"] ?? null, risks: opt.risks ?? null, structural: opt.structural === true, files, fileHashes, protected: attr.protected, protectedHash: protHash, protectedDrift: protDrift, scopeHash: scopeNow, scopeDrift, surfaceHash: surfaceHashOf(m), diffSha: sha256Text(diff), problems });
  console.log(`candidate ${id} (round ${round}, budget ${budget}): ${files.length} file(s) in ${actual.join(", ")}`);
  if (attr.protected.length > 0) console.log(`REFUSED: protected surface edited: ${attr.protected.join(", ")}`);
  if (protDrift) console.log(`REFUSED: protected surface drifted since ${m.incumbent_id} (compared independently of the editable diff); restore it before proposing`);
  for (const p of problems) console.log(`problem: ${p}`);
  if (hint !== null) console.log(`stalled for ${m.stall_window_rounds} rounds: reserve a candidate for the untouched component "${hint}"`);
} else if (cmd === "screen") {
  const m = load();
  const id = pos[0] ?? die("candidate id required");
  const file = join(dir, "candidates", `${id}.diff`);
  if (!existsSync(file)) die(`no diff for ${id}`);
  const findings = leakageScreen(readFileSync(file, "utf8"), leakageTerms(m));
  const cand = readLog().find((r) => r.event === "candidate" && r.id === id);
  const protDrift = (m.protected_hash ?? null) !== null && protectedHashOf(m) !== m.protected_hash;
  log({ event: "screened", id, findings, protected: cand?.protected ?? [], protectedDrift: protDrift });
  console.log(findings.length === 0 ? `${id}: no evolve-set, held-out or evaluator specifics in the added lines` : findings.map((f) => `LEAK ${JSON.stringify(f.term)} in ${f.line.slice(0, 120)}`).join("\n"));
  if (protDrift) console.log(`REFUSED: protected surface drifted since ${m.incumbent_id}; restore it before evaluating`);
  process.exitCode = findings.length > 0 || (cand?.protected ?? []).length > 0 || protDrift ? 1 : 0;
} else if (cmd === "evaluate") {
  const m = load();
  requireProtocol(m);
  const id = pos[0] ?? die("candidate id required");
  const { runs, evidence } = readRunsChecked(m, pos.slice(1), "evaluate");
  const cand = readLog().find((r) => r.event === "candidate" && r.id === id) ?? die(`unknown candidate ${id}`);
  if (m.best_reliable_score === null || m.noise_tolerance_delta === null || m.incumbent_stats === null) die("run `evolve baseline` first (S_best and the noise delta are required)");
  const stats = summarize(runs);
  const screened = readLog().filter((r) => r.event === "screened" && r.id === id).at(-1);
  if (screened === undefined) die(`screen ${id} before evaluating it (leakage is screened before expensive evaluation)`);
  // Bind the evaluated bytes: the runs must have been measured with the proposed surface, and the tree must still be it.
  const surfaceNow = surfaceHashOf(m);
  const protNow = protectedHashOf(m);
  const scopeCurrent = scopeHashOf();
  if (typeof cand.surfaceHash === "string") {
    for (const e of evidence) {
      if (e.manifest?.surfaceHash !== cand.surfaceHash) die(`${id}: ${e.ref} was measured with surface ${String(e.manifest?.surfaceHash ?? "missing").slice(0, 12)} but the proposal is ${String(cand.surfaceHash).slice(0, 12)} (old results from any earlier surface cannot pass; re-run with the proposed bytes)`);
    }
    if (surfaceNow !== cand.surfaceHash) die(`${id}: the working tree drifted since propose; re-propose from the current tree (evaluations must measure the proposed bytes)`);
  }
  if (typeof cand.protectedHash === "string" && protNow !== cand.protectedHash) die(`${id}: REFUSED: the protected surface drifted after propose; restore it and re-propose`);
  if (typeof cand.scopeHash === "string" && scopeCurrent !== cand.scopeHash) die(`${id}: REFUSED: the scope definition drifted after propose; restore it and re-propose`);
  const compat = identityProblems(id, comparisonIdentity(evidence), m.baseline_identity);
  if (compat.length > 0) die(compat.join("\n"));
  const d = decide({ candidate: stats, incumbent: m.incumbent_stats, sBest: m.best_reliable_score, noise: { scoreDelta: m.noise_tolerance_delta, costRel: m.noise_cost_rel ?? 0 }, leakage: screened.findings, guardsOk: (cand.protected as string[]).length === 0 && (cand.problems as string[]).length === 0 && cand.protectedDrift !== true && cand.scopeDrift !== true, structural: cand.structural === true, policy: m.policy });
  const behavior_delta = behaviorDelta(stats.behavior, m.incumbent_stats.behavior);
  log({ event: "evaluated", id, round: cand.round, component: cand.component, runs: pos.slice(1), identity: runIdentity(evidence), comparison: comparisonIdentity(evidence), surfaceHash: surfaceNow, protectedHash: protNow, stats, behavior_delta, ...d });
  console.log(lines(`${id}: ${fmt(stats)}`, `vs incumbent: dScore ${d.dScore.toFixed(3)}, dCost ${(d.dCost * 100).toFixed(0)} % -> ${d.status.toUpperCase()} (${d.band})`, `- ${d.reasons.join("\n- ")}`, fmtBehavior(stats.behavior), fmtBehaviorDelta(behavior_delta)));
} else if (cmd === "promote") {
  const m = load();
  requireProtocol(m);
  const id = pos[0] ?? die("candidate id required");
  if (opt["checklist-ok"] !== true) die("read .agents/skills/harness_skill/promotion-checklist.md, confirm every item, and pass --checklist-ok");
  const ev = readLog().filter((r) => r.event === "evaluated" && r.id === id).at(-1) ?? die(`${id} has not been evaluated`);
  if (ev.admissible !== true) die(`${id} is not admissible: ${(ev.reasons as string[]).join("; ")}`);
  // Promote exactly the evaluated bytes: any drift of the working tree or the protected surface since evaluation refuses.
  const surfaceNow = surfaceHashOf(m);
  const protNow = protectedHashOf(m);
  if (typeof ev.surfaceHash === "string" && surfaceNow !== ev.surfaceHash) die(`${id}: the working tree drifted after evaluation; re-evaluate the current tree before promoting (promotion cannot select unevaluated bytes)`);
  if (typeof ev.protectedHash === "string" && protNow !== ev.protectedHash) die(`${id}: REFUSED: the protected surface drifted after evaluation; restore it and re-evaluate`);
  const next = `H${readLog().filter((r) => r.event === "promoted").length + 1}`;
  const n = snapshot(m, next);
  const stats = ev.stats as RunStats;
  log({ event: "promoted", id, snapshot: next, from: m.incumbent_id, files: n, surfaceHash: surfaceNow, protectedHash: protNow, scopeHash: scopeHashOf(), identity: ev.identity ?? null, comparison: ev.comparison ?? null, stats });
  m.incumbent_id = next;
  m.incumbent_stats = stats;
  m.protected_hash = protNow;
  m.scope_hash = scopeHashOf();
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
  const incumbentSnap = snapDir(m.incumbent_id);
  const snapFiles = new Set(globSync("**/*", { cwd: snap }).filter((f) => !matchesAny(f, m.protected) && isFile(join(snap, f))));
  const incumbentFiles = new Map<string, string | null>();
  if (existsSync(incumbentSnap)) {
    for (const f of globSync("**/*", { cwd: incumbentSnap }).filter((f) => !matchesAny(f, m.protected) && isFile(join(incumbentSnap, f)))) {
      incumbentFiles.set(f, sha256File(join(incumbentSnap, f)));
    }
  }
  const curFiles = new Set(surfaceFiles(m));
  // Candidate-owned bytes the history recorded (exact hashes at propose time). Only a file whose current bytes
  // exactly match a recorded candidate hash may be deleted; a dirtied file is ambiguous and refuses before any mutation.
  const knownHashes = new Map<string, Set<string>>();
  for (const r of readLog()) {
    const hashes = r.fileHashes as unknown;
    if (hashes !== null && typeof hashes === "object" && !Array.isArray(hashes)) {
      for (const [f, h] of Object.entries(hashes as Record<string, unknown>)) {
        if (typeof f === "string" && typeof h === "string") {
          const set = knownHashes.get(f) ?? new Set<string>();
          set.add(h);
          knownHashes.set(f, set);
        }
      }
    }
    const listed = r.files as unknown;
    if (Array.isArray(listed)) for (const f of listed) if (typeof f === "string" && !knownHashes.has(f)) knownHashes.set(f, new Set<string>());
  }
  // Preflight every changed/deleted path BEFORE any mutation: no partial rollback on conflict.
  // A tracked file the snapshot will overwrite is allowed when it is already
  // the target bytes, when it is a known candidate edit being discarded, or
  // when it is clean (matches the current incumbent); anything else is an
  // unrecorded user change and refuses.
  const conflicts: string[] = [];
  const knownFor = (f: string): Set<string> => knownHashes.get(f) ?? new Set<string>();
  for (const f of [...snapFiles].sort()) {
    const parent = dirname(join(repo, f));
    if (existsSync(parent) && !statSync(parent).isDirectory()) conflicts.push(`rollback refused: ${parent} blocks restoring ${f}; resolve it by hand`);
  }
  for (const f of [...snapFiles].sort()) {
    if (!isFile(join(repo, f))) continue;
    const cur = sha256File(join(repo, f));
    const want = sha256File(join(snap, f));
    if (cur === want) continue;
    const incumbentHash = incumbentFiles.get(f) ?? null;
    if (knownFor(f).has(cur as string) || cur === incumbentHash) continue;
    conflicts.push(`rollback refused: ${f} has unrecorded changes (matches neither the ${to} snapshot, a recorded candidate edit, nor the current ${m.incumbent_id} snapshot); resolve it by hand`);
  }
  const toRemove: string[] = [];
  const preserved: string[] = [];
  for (const f of [...curFiles].sort()) {
    if (snapFiles.has(f)) continue;
    const cur = isFile(join(repo, f)) ? sha256File(join(repo, f)) : null;
    const recorded = knownHashes.get(f);
    if (recorded !== undefined && recorded.size > 0 && cur !== null && recorded.has(cur)) {
      toRemove.push(f);
    } else if (recorded !== undefined && recorded.size > 0) {
      conflicts.push(`rollback refused: ${f} was added by a candidate but has since changed; resolve it by hand (dirty candidate additions survive)`);
      preserved.push(f);
    } else {
      preserved.push(f);
    }
  }
  if (conflicts.length > 0) die(conflicts.join("\n"));
  let restored = 0;
  for (const f of [...snapFiles].sort()) {
    const dest = join(repo, f);
    mkdirSync(dirname(dest), { recursive: true }); // restores files whose directories a candidate deleted
    copyFileSync(join(snap, f), dest);
    restored++;
  }
  for (const f of toRemove) rmSync(join(repo, f));
  // The incumbent follows the restored bytes by exact snapshot id; the historical best never moves down to excuse the retreat.
  const rec = [...readLog()].reverse().find((r) => (r.event === "promoted" && r.snapshot === to) || (r.event === "rebaselined" && r.snapshot === to) || (r.event === "baseline" && r.snapshot === to) || (r.event === "init" && r.id === to));
  m.incumbent_id = to;
  if (rec?.stats !== undefined) m.incumbent_stats = rec.stats as RunStats;
  save(m);
  log({ event: "rollback", to, restored, removed: toRemove, preserved, stats: m.incumbent_stats ?? null });
  console.log(`restored ${restored} file(s) from ${to}, removed ${toRemove.length} candidate-owned addition(s), preserved ${preserved.length} unrelated file(s). Rebuild before running anything.`);
} else if (cmd === "prune") {
  const m = load();
  const history: HistoryEntry[] = readLog().filter((r) => r.event === "evaluated").map((r) => ({ round: r.round, component: r.component, scoreDelta: r.dScore, costDelta: r.dCost, accepted: r.admissible }));
  const c = pruneCandidates(history, m.prune_window_rounds, m.noise_tolerance_delta ?? 0);
  console.log(c.length === 0 ? "no component has been exercised for the whole window without a positive contribution" : `prune candidates (no positive contribution over ${m.prune_window_rounds} evaluated edits): ${c.join(", ")}`);
} else if (cmd === "audit") {
  const m = load();
  const surface = (opt.surface === "heldout" || opt.surface === "ood" ? opt.surface : die("--surface heldout|ood")) as "heldout" | "ood";
  const { runs, evidence } = readRunsChecked(m, pos, "audit", surface);
  for (const e of evidence) {
    if (typeof e.manifest?.surfaceHash !== "string" || e.manifest.surfaceHash.length === 0) die(`audit refused: ${e.ref} carries no surface identity (historical run; re-run with the current harness)`);
  }
  const incumbentSnap = snapshotHash(m.incumbent_id);
  if (incumbentSnap !== null) {
    for (const e of evidence) {
      if (e.manifest?.surfaceHash !== incumbentSnap) die(`audit refused: ${e.ref} was not measured with the incumbent ${m.incumbent_id} bytes (audits measure the incumbent; re-run with the current tree)`);
    }
  }
  const compat = identityProblems("audit", comparisonIdentity(evidence), m.baseline_identity);
  if (compat.length > 0) die(compat.join("\n"));
  const stats = summarize(runs);
  if (stats.criticalRate === null) die("audit refused: the runs carry no critical checks (missing checks never pass by omission; re-run with the current harness)");
  const ref = m.reference[surface];
  log({ event: "audit", surface, incumbent: m.incumbent_id, comparison: comparisonIdentity(evidence), surfaceHash: evidence[0]?.manifest?.surfaceHash ?? null, stats });
  if (ref === null) {
    m.reference[surface] = stats;
    save(m);
    console.log(`${surface} reference recorded for ${m.incumbent_id}: ${fmt(stats)}`);
  } else {
    // Aggregates only: the audit result must not become evolve data. Critical and end-to-end success are
    // non-compensatory here too: a critical or success regression is a regression whatever the average says.
    const criticalRegress = criticalCheckRegressions(stats, ref).length > 0;
    const successRegress = stats.successRate < ref.successRate;
    const regress = criticalRegress || successRegress || stats.score < ref.score - (m.noise_tolerance_delta ?? 0) || (ref.costUsd > 0 && (stats.costUsd - ref.costUsd) / ref.costUsd > m.policy.maxCostIncreaseWithGain);
    if (criticalRegress) console.log("critical: one or more required checks regressed against the reference");
    if (successRegress) console.log(`end-to-end success regressed from ${(ref.successRate * 100).toFixed(0)} % to ${(stats.successRate * 100).toFixed(0)} %`);
    console.log(`${surface} audit of ${m.incumbent_id}: ${regress ? "REGRESSION against the reference" : "transfer ok"} (${fmt(stats)})`);
    process.exitCode = regress ? 1 : 0;
  }
} else if (cmd === "status") {
  const m = load();
  const log_ = readLog();
  console.log(`incumbent ${m.incumbent_id} (baseline ${m.baseline_id}); S_best ${m.best_reliable_score ?? "—"}; noise delta ${m.noise_tolerance_delta ?? "—"} (cost spread ${m.noise_cost_rel === null ? "—" : `${(m.noise_cost_rel * 100).toFixed(0)} %`})${m.noise_provisional ? " PROVISIONAL" : ""}`);
  if (m.incumbent_stats) console.log(lines(`incumbent stats: ${fmt(m.incumbent_stats)}`, fmtBehavior(m.incumbent_stats.behavior)));
  console.log(`candidates: ${log_.filter((r) => r.event === "candidate").length}, evaluated: ${log_.filter((r) => r.event === "evaluated").length}, promoted: ${log_.filter((r) => r.event === "promoted").length}, rejected: ${log_.filter((r) => r.event === "rejected").length}`);
  console.log(`audit references: held-out ${m.reference.heldout ? "recorded" : "none"}, OOD ${m.reference.ood ? "recorded" : "none"}`);
  console.log(`editable surface: ${surfaceFiles(m).length} files; protected globs: ${m.protected.length}; relative to repo: ${relative(process.cwd(), repo) || "."}`);
} else {
  die("usage: evolve.ts init | baseline | propose | screen | evaluate | promote | reject | rollback | prune | audit | status (see the file header)");
}
