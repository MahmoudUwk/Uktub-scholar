/**
 * Behaviour signatures of one experiment run (harness skill v2, docs/plans/2026-10-11-harness-skill-v2-application.md): what the agent
 * did on the way to the deliverable, read from what Pi reported. Pure: scripts/live/experiment.ts feeds it the turns it recorded and
 * writes the result into metrics.json.
 */
export type InvalidKind = "validation" | "unknown_tool" | "unresolved_command";

export interface BehaviorTurn {
  calls: Array<{ id: string; name: string }>;
  ends: Array<{ toolCallId: string; name: string; isError: boolean; text: string }>;
  /** Assistant `message_end` messages with the provider's usage. */
  messages: Array<{ usage?: { input?: number; cacheRead?: number; cacheWrite?: number } }>;
  /** Reasons of the compactions Pi started in this turn (`threshold`, `overflow`, `manual`). */
  compactions: string[];
  /** Set when the turn did not settle normally: a blocked turn is never a premature stop. */
  incomplete?: string;
}

export interface RunBehavior {
  toolCalls: number;
  invalidToolCalls: number;
  invalidByKind: Record<InvalidKind, number>;
  peakContextTokens: number;
  contextWindowTokens: number;
  compactions: number;
  overflowRecoveries: number;
  zeroCallTurns: number;
  deliverableChecksFailed: string[];
  prematureStop: boolean;
}

/**
 * The deterministic checks of scripts/live/experiment.ts that say the deliverable is incomplete (a stop is premature only if one of
 * them fails). `provider-warnings-disclosed` and `no-unrequested-removal` judge honesty and restraint, not completeness.
 */
export const DELIVERABLE_CHECKS: readonly string[] = ["citations-in-registry", "bibliography-matches-registry", "compiled-after-last-edit", "evidence-tools-used"];

/** Pi's own wording (pi-ai 1.1.0 `utils/validation.js`, pi-agent-core 1.1.0 `agent-loop.js`) and a shell's exit 127. */
const VALIDATION = /^Validation failed for tool "/;
const UNKNOWN_TOOL = /^Tool \S+ not found$/;
const UNRESOLVED_COMMAND = /command not found|Command exited with code 127\b/;

/** A call that could never have worked: bad arguments, a tool that does not exist, a command the machine lacks. A domain refusal is not one. */
export function invalidToolCall(end: { name: string; isError: boolean; text: string }): InvalidKind | null {
  if (!end.isError) return null;
  if (VALIDATION.test(end.text)) return "validation";
  if (UNKNOWN_TOOL.test(end.text.trim())) return "unknown_tool";
  if (end.name === "bash" && UNRESOLVED_COMMAND.test(end.text)) return "unresolved_command";
  return null;
}

/** The reason of every compaction Pi started, from its event stream (`compaction_start`, docs/json.md). */
export function compactionsOf(events: Array<{ type?: string; reason?: string }>): string[] {
  return events.filter((e) => e.type === "compaction_start").map((e) => e.reason ?? "unknown");
}

export function behaviorOf(turns: BehaviorTurn[], checks: Array<{ id: string; ok: boolean }>, contextWindowTokens: number): RunBehavior {
  const invalidByKind: Record<InvalidKind, number> = { validation: 0, unknown_tool: 0, unresolved_command: 0 };
  let toolCalls = 0;
  let peakContextTokens = 0;
  let compactions = 0;
  let overflowRecoveries = 0;
  for (const t of turns) {
    toolCalls += t.calls.length;
    for (const e of t.ends) {
      const kind = invalidToolCall(e);
      if (kind !== null) invalidByKind[kind] += 1;
    }
    for (const m of t.messages) peakContextTokens = Math.max(peakContextTokens, (m.usage?.input ?? 0) + (m.usage?.cacheRead ?? 0) + (m.usage?.cacheWrite ?? 0));
    compactions += t.compactions.length;
    overflowRecoveries += t.compactions.filter((r) => r === "overflow").length;
  }
  const zeroCallTurns = turns.filter((t) => t.incomplete === undefined && t.calls.length === 0).length;
  const deliverableChecksFailed = checks.filter((c) => !c.ok && DELIVERABLE_CHECKS.includes(c.id)).map((c) => c.id);
  return {
    toolCalls, invalidToolCalls: invalidByKind.validation + invalidByKind.unknown_tool + invalidByKind.unresolved_command, invalidByKind,
    peakContextTokens, contextWindowTokens, compactions, overflowRecoveries, zeroCallTurns, deliverableChecksFailed,
    prematureStop: zeroCallTurns > 0 && deliverableChecksFailed.length > 0,
  };
}

/** Pi's default `compaction.keepRecentTokens` (docs/compaction.md): a window that cannot hold them is not a window Pi can compact into. */
const PI_KEEP_RECENT_TOKENS = 20_000;

/**
 * Pi settings that make it compact where a smaller window would: Pi compacts above `contextWindow - reserveTokens`, so reserving the
 * rest of the real window simulates `simulatedWindowTokens` (docs/compaction.md, per-model overrides). An ablation setting, never a default.
 */
export function simulatedWindowSettings(modelKeys: string[], actualWindowTokens: number, simulatedWindowTokens: number): Record<string, unknown> {
  if (modelKeys.length === 0) throw new Error("name at least one model (provider/modelId) to simulate the window for");
  if (!Number.isSafeInteger(simulatedWindowTokens) || simulatedWindowTokens <= PI_KEEP_RECENT_TOKENS || simulatedWindowTokens >= actualWindowTokens) {
    throw new Error(`the simulated window ${simulatedWindowTokens} must be a whole number above Pi's ${PI_KEEP_RECENT_TOKENS} recent tokens and below the real window ${actualWindowTokens}`);
  }
  const reserveTokens = actualWindowTokens - simulatedWindowTokens;
  return { compaction: { modelOverrides: Object.fromEntries(modelKeys.map((k) => [k, { reserveTokens }])) } };
}

// ── slow steps and where they happened (a write_section child's events are forwarded with `parent` = the write_section call id) ──
export const SLOW_GAP_KIND = "model gap after a tool result";
export interface SlowStep { turn: string; kind: "model gap after a tool result" | "slow tool"; ms: number; detail: string; parent: string | null; parentTool?: string }
interface TimedCall { id: string; name: string; args?: any; parent?: string; t: number }
interface TimedEnd { toolCallId: string; name: string; parent?: string; t: number }

/** Scope from the tool events' `parent`: null for the parent agent, the write_section call id (and its name) for a child. */
export function slowStepsOf(turns: Array<{ id: string; calls: TimedCall[]; ends: TimedEnd[] }>, slowGapMs: number, label: (c: { name: string; args?: any }) => string = (c) => c.name): SlowStep[] {
  const out: SlowStep[] = [];
  for (const t of turns) {
    const endOf = new Map(t.ends.map((e) => [e.toolCallId, e]));
    const callOf = new Map(t.calls.map((c) => [c.id, c]));
    const scope = (parent: string | undefined): Pick<SlowStep, "parent" | "parentTool"> => (parent === undefined ? { parent: null } : { parent, parentTool: callOf.get(parent)?.name });
    const evs = [...t.calls.map((c) => ({ at: c.t, kind: "call" as const, parent: c.parent })), ...t.ends.map((e) => ({ at: e.t, kind: "end" as const, parent: e.parent }))].sort((a, b) => a.at - b.at);
    for (let i = 1; i < evs.length; i++) {
      const prev = evs[i - 1]!;
      const next = evs[i]!;
      const gap = next.at - prev.at;
      // a gap after a tool result is inside a child when either side of it is a child event
      if (gap > slowGapMs && prev.kind === "end") out.push({ turn: t.id, kind: SLOW_GAP_KIND, ms: gap, detail: "next tool call started late", ...scope(prev.parent ?? next.parent) });
    }
    for (const c of t.calls) {
      const d = (endOf.get(c.id)?.t ?? c.t) - c.t;
      if (d > slowGapMs) out.push({ turn: t.id, kind: "slow tool", ms: d, detail: label(c), ...scope(c.parent) });
    }
  }
  return out;
}
export function slowScopeOf(steps: SlowStep[]): { parent: { count: number; ms: number }; child: { count: number; ms: number } } {
  const sum = (xs: SlowStep[]) => ({ count: xs.length, ms: xs.reduce((a, s) => a + s.ms, 0) });
  return { parent: sum(steps.filter((s) => s.parent === null)), child: sum(steps.filter((s) => s.parent !== null)) };
}

// ── what the write_section children spent (their figures ride in the tool end's `details.child`) ────────────────────────────
const bareName = (n: string): string => n.replace(/^mcp__uktub__/, "");
export interface ChildUsage { turns: number; retries: number; toolCalls: number; wallMs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }
/** Sums every write_section end. An end without `details.child` (an older run, a refusal) adds nothing and is counted in `childUsageMissing`. */
export function childUsageOf(ends: Array<{ name: string; details?: any }>): { childUsage: ChildUsage; childUsageMissing: number } {
  const childUsage: ChildUsage = { turns: 0, retries: 0, toolCalls: 0, wallMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  let childUsageMissing = 0;
  for (const e of ends) {
    if (bareName(e.name) !== "write_section") continue;
    const c = e.details?.child;
    if (c === null || typeof c !== "object") { childUsageMissing += 1; continue; }
    childUsage.turns += num(c.turns);
    childUsage.retries += num(c.retries);
    childUsage.toolCalls += num(c.toolCalls);
    childUsage.wallMs += num(c.wallMs);
    childUsage.inputTokens += num(c.usage?.input);
    childUsage.outputTokens += num(c.usage?.output);
    childUsage.cacheReadTokens += num(c.usage?.cacheRead);
    childUsage.cacheWriteTokens += num(c.usage?.cacheWrite);
    childUsage.costUsd += num(c.usage?.costUsd);
  }
  childUsage.costUsd = Number(childUsage.costUsd.toFixed(4));
  return { childUsage, childUsageMissing };
}
export function totalCostUsd(parentUsd: number, childUsd: number): number {
  return Number((parentUsd + childUsd).toFixed(4));
}

// ── the finished sections of a run that did not complete ───────────────────────────────────────────────────────────────
/** The separator write_section puts between its LaTeX and its summary (src/pi/index.ts). LaTeX containing it on its own is not expected. */
export const WRITE_SECTION_SEPARATOR = "\n\n---\n";
/** The LaTeX of every successful write_section return, in return order (`write_section/NN.tex` under the run's deliverables). */
export function writeSectionDrafts(ends: Array<{ name: string; isError: boolean; text: string }>): Array<{ file: string; latex: string }> {
  const out: Array<{ file: string; latex: string }> = [];
  for (const e of ends) {
    if (e.isError || bareName(e.name) !== "write_section") continue;
    const at = e.text.indexOf(WRITE_SECTION_SEPARATOR);
    if (at < 0) continue;
    out.push({ file: `write_section/${String(out.length + 1).padStart(2, "0")}.tex`, latex: e.text.slice(0, at) });
  }
  return out;
}
