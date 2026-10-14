/**
 * Pure decision logic of the self-improving harness loop (.agents/skills/harness_skill, docs/plans/2026-10-07-self-improving-harness-plan.md).
 * No I/O here: scripts/live/evolve.ts reads and writes the manifest, the log and the snapshots and calls these rules.
 * Policy numbers are labelled client policy (the skill gives the rules, not the numbers) and live in `DEFAULT_POLICY`.
 */
export type Component = "prompt" | "control_flow" | "config" | "output_plumbing" | "context_mgmt" | "client_tool" | "skill" | "memory" | "subagent";

/** One experiment iteration, reduced to what promotion needs. */
export interface RunMetric {
  scenario: string;
  iteration: number;
  success: boolean;
  /** Ended by provider capacity or a client deadline: reported separately, never silently dropped, never a product failure. */
  blocked: boolean;
  checksPassed: number;
  checksTotal: number;
  /** Non-compensatory checks passed / total (safety, provenance, citation validity, delivery). */
  criticalPassed: number;
  criticalTotal: number;
  /** Each required integrity check passed in this run; missing or duplicated checks are false. */
  criticalChecks: Record<string, boolean>;
  /** Deterministic checks passed / total (the verifier result). */
  score: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  steps: number;
  wallMs: number;
  behavior?: RunBehaviorSignals;
}

/** One run's behaviour signatures (null: the run did not record it). */
export interface RunBehaviorSignals {
  peakContextFraction: number | null;
  /** Pi compacted at least once (threshold, overflow or manual). */
  compacted: boolean | null;
  /** Pi recovered from at least one context overflow (a subset of compactions; a normal compaction is never an overflow). */
  overflowed: boolean | null;
  /** Invalid tool calls / all tool calls. */
  invalidToolCallRate: number | null;
  repeatedAction: boolean | null;
  prematureStop: boolean | null;
}

/** Means over the completed runs; a field is null when no completed run recorded it. */
export interface BehaviorStats {
  peakContextFraction: number | null;
  /** Share of runs where Pi compacted at all (diagnostic: a working host compaction, never a failure). */
  compactionRate: number | null;
  /** Share of runs where Pi recovered from a context overflow (diagnostic). */
  contextOverflowRate: number | null;
  invalidToolCallRate: number | null;
  repeatedActionRate: number | null;
  prematureStopRate: number | null;
}

export interface RunStats {
  /** Completed (not blocked) runs. */
  runs: number;
  blocked: number;
  score: number;
  successRate: number;
  /** Mean critical-check pass rate over completed runs; null when no completed run recorded critical checks. */
  criticalRate: number | null;
  /** Every completed run passed each named check; missing evidence is false. */
  criticalChecks: Record<string, boolean>;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  wallMs: number;
  behavior?: BehaviorStats;
}

export interface Noise {
  /** Natural score spread of the unchanged harness (max - min over repeated runs). */
  scoreDelta: number;
  /** Natural relative cost spread ((max - min) / mean). */
  costRel: number;
  n: number;
  provisional: boolean;
}

export interface Policy {
  /** Client policy: the most extra cost (relative) a measured score gain may carry. */
  maxCostIncreaseWithGain: number;
  /** Client policy: inside the noise band a candidate must cut cost by at least this much (and by more than the cost noise). */
  minCostReduction: number;
  /** Client policy: a structural bet inside the noise band may cost at most this much more. */
  maxStructuralCostIncrease: number;
  /** Client policy: fewer completed runs than this, or this share of attempts blocked, makes a verdict inconclusive. */
  minRuns: number;
  maxBlockedShare: number;
}

export const DEFAULT_POLICY: Policy = { maxCostIncreaseWithGain: 0.25, minCostReduction: 0.1, maxStructuralCostIncrease: 0.1, minRuns: 2, maxBlockedShare: 1 / 3 };

export interface Finding {
  term: string;
  line: string;
}

export interface Decision {
  admissible: boolean;
  status: "admissible" | "rejected" | "inconclusive";
  band: "gain" | "within" | "loss" | "n/a";
  dScore: number;
  dCost: number;
  reasons: string[];
}

export interface HistoryEntry {
  round: number;
  component: string;
  scoreDelta: number;
  costDelta: number;
  accepted: boolean;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : sum(xs) / xs.length);

/**
 * The concrete evaluator protocol check set of scripts/live/experiment.ts
 * (every real run carries exactly these ids; a missing check refuses, never
 * passes by omission). No per-check statistics: presence only.
 */
export const PROTOCOL_CHECK_IDS = [
  "stop-signal", "all-turns-completed", "citations-in-registry", "bibliography-matches-registry",
  "compiled-after-last-edit", "pointers-issued-by-tools", "provider-warnings-disclosed",
  "evidence-tools-used", "no-unrequested-removal",
] as const;

/**
 * Non-compensatory checks: safety, provenance, citation validity and delivery.
 * A candidate that regresses these is rejected no matter its average score or
 * cost; behaviour signatures (compactions, invalid calls, stops) stay
 * diagnostic and never veto on their own. Uses the check ids written by
 * scripts/live/experiment.ts.
 */
export const CRITICAL_CHECK_IDS = ["citations-in-registry", "bibliography-matches-registry", "compiled-after-last-edit", "pointers-issued-by-tools", "evidence-tools-used", "no-unrequested-removal"] as const;

/**
 * Checks that join the critical set only for scenarios declaring them (the
 * evidence-table pair is emitted only when the scenario has an
 * `## Evidence table` section). `no-unrequested-removal` is protocol,
 * carried by every real run, and unconditionally critical; only the
 * evidence-table pair stays conditional (review 2026-10-13 finding 1).
 */
export const EVIDENCE_TABLE_CHECK_IDS = ["evidence-table-present", "evidence-table-valid"] as const;
/**
 * Length and sourced-numeric checks: same conditional emission as the
 * evidence-table pair (independent-review finding: over-long notes and
 * table numerics the agent never saw in any tool result passed all 11
 * checks). Both are non-compensatory: `sourced-numerics` is provenance and
 * `length-within-request` is an explicit user constraint.
 */
export const LENGTH_SOURCED_CHECK_IDS = ["length-within-request", "sourced-numerics"] as const;
export const CONDITIONAL_CRITICAL_CHECK_IDS = [...EVIDENCE_TABLE_CHECK_IDS, ...LENGTH_SOURCED_CHECK_IDS] as const;

const declaresEvidenceTable = (ids: Iterable<string>): boolean => {
  const set = new Set(ids);
  return (EVIDENCE_TABLE_CHECK_IDS as readonly string[]).some((id) => set.has(id));
};

/** The critical set for runs declaring these check ids: base plus integrity when an evidence table is declared. */
export function criticalIdsFor(declaredIds: Iterable<string>): string[] {
  return [...CRITICAL_CHECK_IDS, ...((declaresEvidenceTable(declaredIds) ? CONDITIONAL_CRITICAL_CHECK_IDS : []) as readonly string[])];
}

/** Named checks that regressed against a reference; absent evidence fails closed. */
export function criticalCheckRegressions(candidate: RunStats, reference: RunStats): string[] {
  const declared = new Set([...Object.keys(reference.criticalChecks ?? {}), ...Object.keys(candidate.criticalChecks ?? {})]);
  return criticalIdsFor(declared).filter((id) => reference.criticalChecks?.[id] === true && candidate.criticalChecks?.[id] !== true);
}

/** Reduce a `metrics.json` written by scripts/live/experiment.ts. */
export function runMetricsOf(m: any): RunMetric {
  const checks: Array<{ id?: string; ok: boolean }> = Array.isArray(m.checks) ? m.checks : [];
  const passed = checks.filter((c) => c.ok === true).length;
  const required = criticalIdsFor(checks.map((c) => String(c.id ?? "")));
  const critical = checks.filter((c) => typeof c.id === "string" && (required as readonly string[]).includes(c.id));
  const criticalChecks = Object.fromEntries(required.map((id) => {
    const matching = checks.filter((c) => c.id === id);
    return [id, matching.length === 1 && matching[0]?.ok === true];
  }));
  const outcome = String(m.outcome ?? "");
  const usage = m.agent?.usage ?? {};
  return {
    scenario: String(m.scenario ?? ""),
    iteration: Number(m.iteration ?? 0),
    // End-to-end success is the experiment's own exit rule: the simulator reports success AND every deterministic check passes.
    success: outcome === "success" && checks.length > 0 && passed === checks.length,
    blocked: outcome.startsWith("blocked"),
    checksPassed: passed,
    checksTotal: checks.length,
    criticalPassed: critical.filter((c) => c.ok === true).length,
    criticalTotal: critical.length,
    criticalChecks,
    score: checks.length === 0 ? 0 : passed / checks.length,
    costUsd: Number(usage.costUsd ?? 0) + Number(m.simulator?.usage?.costUsd ?? 0),
    inputTokens: Number(usage.inputTokens ?? 0),
    outputTokens: Number(usage.outputTokens ?? 0),
    toolCalls: Number(m.agent?.toolCalls ?? 0),
    steps: Number(usage.responses ?? 0),
    wallMs: Number(m.wallMs ?? 0),
    behavior: behaviorSignalsOf(m),
  };
}

/** A run recorded before behaviour was measured keeps what its metrics.json already carried (repeated identical calls); the rest is unrecorded. */
function behaviorSignalsOf(m: any): RunBehaviorSignals {
  const b = m.behavior;
  const repeated = m.agent?.repeatedIdenticalCalls;
  return {
    peakContextFraction: b !== undefined && Number(b.contextWindowTokens) > 0 ? Number(b.peakContextTokens) / Number(b.contextWindowTokens) : null,
    compacted: b !== undefined ? Number(b.compactions) > 0 : null,
    overflowed: b !== undefined && b.overflowRecoveries !== undefined ? Number(b.overflowRecoveries) > 0 : null,
    invalidToolCallRate: b !== undefined && Number(b.toolCalls) > 0 ? Number(b.invalidToolCalls) / Number(b.toolCalls) : null,
    repeatedAction: Array.isArray(repeated) ? repeated.length > 0 : null,
    prematureStop: b !== undefined ? b.prematureStop === true : null,
  };
}

/** Means over the completed runs; blocked runs are counted and reported, not averaged and not hidden. */
const meanOrNull = (xs: Array<number | null>): number | null => {
  const known = xs.filter((x): x is number => x !== null);
  return known.length === 0 ? null : mean(known);
};
const flag = (b: boolean | null | undefined): number | null => (b === null || b === undefined ? null : b ? 1 : 0);

export function summarize(runs: RunMetric[]): RunStats {
  const done = runs.filter((r) => !r.blocked);
  const signals = done.flatMap((r) => (r.behavior === undefined ? [] : [r.behavior]));
  const criticalRates = done.filter((r) => r.criticalTotal > 0).map((r) => r.criticalPassed / r.criticalTotal);
  const declared = new Set(done.flatMap((r) => Object.keys(r.criticalChecks ?? {})));
  const criticalChecks = Object.fromEntries(criticalIdsFor(declared).map((id) => [id, done.length > 0 && done.every((r) => r.criticalChecks?.[id] === true)]));
  return {
    runs: done.length,
    blocked: runs.length - done.length,
    score: mean(done.map((r) => r.score)),
    successRate: mean(done.map((r) => (r.success ? 1 : 0))),
    criticalRate: criticalRates.length === 0 ? null : mean(criticalRates),
    criticalChecks,
    costUsd: mean(done.map((r) => r.costUsd)),
    inputTokens: mean(done.map((r) => r.inputTokens)),
    outputTokens: mean(done.map((r) => r.outputTokens)),
    toolCalls: mean(done.map((r) => r.toolCalls)),
    wallMs: mean(done.map((r) => r.wallMs)),
    ...(signals.length === 0 ? {} : {
      behavior: {
        peakContextFraction: meanOrNull(signals.map((s) => s.peakContextFraction)),
        compactionRate: meanOrNull(signals.map((s) => flag(s.compacted))),
        contextOverflowRate: meanOrNull(signals.map((s) => flag(s.overflowed ?? null))),
        invalidToolCallRate: meanOrNull(signals.map((s) => s.invalidToolCallRate)),
        repeatedActionRate: meanOrNull(signals.map((s) => flag(s.repeatedAction))),
        prematureStopRate: meanOrNull(signals.map((s) => flag(s.prematureStop))),
      },
    }),
  };
}

/** Candidate minus incumbent, per signature; null where either side did not record it. */
export function behaviorDelta(candidate: BehaviorStats | undefined, incumbent: BehaviorStats | undefined): BehaviorStats | null {
  if (candidate === undefined || incumbent === undefined) return null;
  const diff = (c: number | null, i: number | null): number | null => (c === null || i === null ? null : c - i);
  return {
    peakContextFraction: diff(candidate.peakContextFraction, incumbent.peakContextFraction),
    compactionRate: diff(candidate.compactionRate, incumbent.compactionRate),
    contextOverflowRate: diff(candidate.contextOverflowRate, incumbent.contextOverflowRate),
    invalidToolCallRate: diff(candidate.invalidToolCallRate, incumbent.invalidToolCallRate),
    repeatedActionRate: diff(candidate.repeatedActionRate, incumbent.repeatedActionRate),
    prematureStopRate: diff(candidate.prematureStopRate, incumbent.prematureStopRate),
  };
}

/** delta: how much the UNCHANGED harness varies run to run. A measurement, never a threshold to tune until candidates pass. */
export function estimateNoise(baseline: RunMetric[]): Noise {
  const done = baseline.filter((r) => !r.blocked);
  const scores = done.map((r) => r.score);
  const costs = done.map((r) => r.costUsd);
  const spread = (xs: number[]): number => (xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs));
  const mc = mean(costs);
  return { scoreDelta: spread(scores), costRel: mc > 0 ? spread(costs) / mc : 0, n: done.length, provisional: done.length < 3 };
}

/** Screen the SHIPPED diff (added lines only), not the proposer's rationale. Terms under 4 characters are noise and ignored. */
export function leakageScreen(diff: string, terms: string[]): Finding[] {
  const findings: Finding[] = [];
  const usable = terms.filter((t) => t.length >= 4);
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const lower = line.toLowerCase();
    for (const term of usable) if (lower.includes(term.toLowerCase())) findings.push({ term, line });
  }
  return findings;
}

const GENERIC_TERMS = new Set(["latex", "bibtex", "openalex", "crossref", "semantic", "scholar", "arxiv", "github", "tectonic", "markdown"]);

/** Terms that would make a shipped diff specific to a scenario: its name, bold phrases, CamelCase and ALLCAPS identifiers and DOIs. */
export function leakageTermsFrom(scenarios: Array<{ name: string; text: string }>): string[] {
  const terms = new Set<string>();
  for (const { name, text } of scenarios) {
    terms.add(name);
    for (const m of text.matchAll(/\*\*([^*]{4,80})\*\*/g)) terms.add((m[1] as string).trim());
    for (const m of text.matchAll(/\b10\.\d{4,9}\/[^\s),;]+/g)) terms.add((m[0] as string).replace(/[.]+$/, ""));
    for (const m of text.matchAll(/\b(?:[A-Z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z]{4,}[a-z0-9]*)\b/g)) if (!GENERIC_TERMS.has((m[0] as string).toLowerCase())) terms.add(m[0] as string);
  }
  return [...terms];
}

export interface DecideInput {
  candidate: RunStats;
  incumbent: RunStats;
  sBest: number;
  noise: Pick<Noise, "scoreDelta" | "costRel">;
  leakage: Finding[] | unknown[];
  guardsOk: boolean;
  /** The candidate introduces a genuinely new structural mechanism worth testing. */
  structural: boolean;
  policy?: Policy;
}

/** The promotion gates of the skill: leakage, domain guards, non-compensatory floor, noise band, cost rent. */
export function decide(i: DecideInput): Decision {
  const p = i.policy ?? DEFAULT_POLICY;
  const reasons: string[] = [];
  const dScore = i.candidate.score - i.incumbent.score;
  const dCost = i.incumbent.costUsd > 0 ? (i.candidate.costUsd - i.incumbent.costUsd) / i.incumbent.costUsd : 0;
  const out = (status: Decision["status"], band: Decision["band"]): Decision => ({ admissible: status === "admissible", status, band, dScore, dCost, reasons });
  if (i.leakage.length > 0) {
    reasons.push(`leakage: the shipped diff contains ${i.leakage.length} evolve-set specific term(s)`);
    return out("rejected", "n/a");
  }
  if (!i.guardsOk) {
    reasons.push("a domain guard failed (safety, integrity or protected surface)");
    return out("rejected", "n/a");
  }
  const attempts = i.candidate.runs + i.candidate.blocked;
  if (i.candidate.runs < p.minRuns || (attempts > 0 && i.candidate.blocked / attempts >= p.maxBlockedShare)) {
    reasons.push(`inconclusive: ${i.candidate.runs} completed run(s), ${i.candidate.blocked} blocked; rerun until enough runs complete`);
    return out("inconclusive", "n/a");
  }
  const failedCritical = criticalIdsFor(new Set([...Object.keys(i.candidate.criticalChecks ?? {}), ...Object.keys(i.incumbent.criticalChecks ?? {})])).filter((id) => i.candidate.criticalChecks?.[id] !== true);
  if (failedCritical.length > 0) {
    reasons.push(`critical: required check(s) did not pass in every candidate run: ${failedCritical.join(", ")}; missing checks fail closed and no critical failure is compensated by average score or cost`);
    return out("rejected", "n/a");
  }
  if (i.candidate.successRate < i.incumbent.successRate) {
    reasons.push(`end-to-end success regressed from ${(i.incumbent.successRate * 100).toFixed(0)} % to ${(i.candidate.successRate * 100).toFixed(0)} %; a success regression is never compensated by average score or cost`);
    return out("rejected", "loss");
  }
  const floor = i.sBest - i.noise.scoreDelta;
  if (i.candidate.score < floor) {
    reasons.push(`floor: score ${i.candidate.score.toFixed(3)} is below S_best - delta = ${floor.toFixed(3)}; a cost reduction never compensates`);
    return out("rejected", "loss");
  }
  if (dScore < -i.noise.scoreDelta) {
    reasons.push(`worse than the incumbent beyond the noise band (${dScore.toFixed(3)} < -${i.noise.scoreDelta.toFixed(3)})`);
    return out("rejected", "loss");
  }
  if (dScore > i.noise.scoreDelta) {
    if (dCost <= p.maxCostIncreaseWithGain) {
      reasons.push(`gain beyond the noise band (+${dScore.toFixed(3)}) at ${(dCost * 100).toFixed(0)} % cost change`);
      return out("admissible", "gain");
    }
    reasons.push(`gain (+${dScore.toFixed(3)}) does not pay for a ${(dCost * 100).toFixed(0)} % cost increase (limit ${(p.maxCostIncreaseWithGain * 100).toFixed(0)} %)`);
    return out("rejected", "gain");
  }
  const needed = Math.max(p.minCostReduction, i.noise.costRel);
  if (dCost <= -needed) {
    reasons.push(`within the noise band; cost down ${(-dCost * 100).toFixed(0)} % (beyond the ${(needed * 100).toFixed(0)} % needed)`);
    return out("admissible", "within");
  }
  if (i.structural && dCost <= p.maxStructuralCostIncrease) {
    reasons.push(`within the noise band; a new structural mechanism at ${(dCost * 100).toFixed(0)} % cost change`);
    return out("admissible", "within");
  }
  reasons.push(`within the noise band with cost change ${(dCost * 100).toFixed(0)} %: a noisy score difference is not evidence, and the cost did not fall by ${(needed * 100).toFixed(0)} %${i.structural ? ` nor stay under +${(p.maxStructuralCostIncrease * 100).toFixed(0)} % for a structural bet` : ""}`);
  return out("rejected", "within");
}

/** Annealed number of independently attributable edits allowed in one candidate. */
export function editBudget(round: number, horizon: number, p: { early_max: number; late_min: number }): number {
  if (round <= horizon / 3) return p.early_max;
  if (round <= (2 * horizon) / 3) return Math.max(p.late_min, Math.round(p.early_max / 2));
  return p.late_min;
}

const EXPLORE_ORDER: Component[] = ["control_flow", "context_mgmt", "client_tool", "skill", "memory", "subagent", "output_plumbing", "config", "prompt"];

/** When the last `window` rounds made no gain beyond the noise, name a component class never edited yet (structure before more prompt text). */
export function pickUnderexplored(history: HistoryEntry[], components: string[], window: number, delta: number): string | null {
  if (history.length < window) return null;
  if (history.slice(-window).some((h) => h.scoreDelta > delta)) return null;
  const touched = new Set(history.map((h) => h.component));
  return EXPLORE_ORDER.find((c) => components.includes(c) && !touched.has(c)) ?? null;
}

/** Components exercised for the whole rolling window with no positive measured contribution: candidates for removal or simplification. */
export function pruneCandidates(history: HistoryEntry[], window: number, delta: number): string[] {
  const byComponent = new Map<string, HistoryEntry[]>();
  for (const h of history) byComponent.set(h.component, [...(byComponent.get(h.component) ?? []), h]);
  const out: string[] = [];
  for (const [component, entries] of byComponent) {
    const recent = entries.slice(-window);
    if (recent.length >= window && !recent.some((h) => h.scoreDelta > delta)) out.push(component);
  }
  return out;
}

const globRe = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
export const matchesAny = (file: string, globs: string[]): boolean => globs.some((g) => globRe(g).test(file));

/** Attribute changed files to components. Protected files (evaluator, frozen scenarios, safety code) are reported, never attributed. */
export function componentsOf(files: string[], map: Record<string, string[]>, protectedGlobs: string[]): { byComponent: Record<string, string[]>; unmapped: string[]; protected: string[] } {
  const byComponent: Record<string, string[]> = {};
  const unmapped: string[] = [];
  const prot: string[] = [];
  for (const file of files) {
    if (matchesAny(file, protectedGlobs)) {
      prot.push(file);
      continue;
    }
    const component = Object.keys(map).find((c) => matchesAny(file, map[c] ?? []));
    if (component === undefined) unmapped.push(file);
    else (byComponent[component] ??= []).push(file);
  }
  return { byComponent, unmapped, protected: prot };
}
