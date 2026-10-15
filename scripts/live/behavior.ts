/**
 * Behaviour signatures of one experiment run (harness skill v2, docs/plans/2026-10-11-harness-skill-v2-application.md): what the agent
 * did on the way to the deliverable, read from what Pi reported. Pure: scripts/live/experiment.ts feeds it the turns it recorded and
 * writes the result into metrics.json; scripts/live/evolution.ts holds the check ids runs are validated against.
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
