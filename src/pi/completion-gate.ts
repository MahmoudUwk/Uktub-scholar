/**
 * Pi pre-completion gate (owner decision D1, 2026-10-19): a turn that touched a document may not settle while it still holds prose
 * that is neither verified as written nor labelled "unverified". The deterministic provenance audit runs at the settle boundary
 * (`agent_before_settle`); a finding returns one bounded follow-up as a custom message with `continue: true`, so the follow-up is part
 * of the same run (one run for a host, not a settle and a second run).
 *
 * This file is the Pi adapter: the gate state and texts are runtime-neutral (`src/agent/completion-gate.ts`); this adapter maps Pi
 * events to neutral tool events, runs the audit on disk, and owns the write_section child depth.
 *
 * Scope: only the top-level session. A `write_section` child runs inside `withinGateChild`, where the gate never acts.
 */
import type { AgentBeforeSettleEvent, BoundaryResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runProvenance, type ProvenanceOutcome } from "../core/provenance/run.ts";
import { minConfidenceFromEnv } from "../core/verify/claim.ts";
import { COMPLETION_GATE_TYPE, createCompletionGate, followUpText, registryText } from "../agent/completion-gate.ts";

export { COMPLETION_GATE_TYPE, followUpText, registryText };

/** Depth of running write_section child sessions: the gate never acts while it is above zero. */
let childDepth = 0;

/** Run `run` as a write_section child: the completion gate stays silent for its whole duration. */
export async function withinGateChild<T>(run: () => Promise<T>): Promise<T> {
  childDepth += 1;
  try {
    return await run();
  } finally {
    childDepth -= 1;
  }
}

/** Test seam: the provenance audit of the project at `root` (default: the real audit, read-only and offline). */
export interface CompletionGateSeams {
  audit?: (root: string) => ProvenanceOutcome;
}

const defaultAudit = (root: string): ProvenanceOutcome => runProvenance({ root, now: () => new Date(), minConfidence: minConfidenceFromEnv(process.env) });

/** Register the gate on the top-level session's events. Handlers return nothing except the settle boundary's continuation. */
export function installCompletionGate(pi: ExtensionAPI, seams: CompletionGateSeams = {}): void {
  const audit = seams.audit ?? defaultAudit;
  const gate = createCompletionGate();
  // Built-in write/edit calls on .tex paths, by call id, with their arguments; they count as touching the document only once they succeed.
  const texWrites = new Map<string, { path: string }>();

  pi.on("before_agent_start", (event) => {
    // Only a user prompt starts a new budget; the gate's own continuation is a settle-boundary entry, not a new run.
    if (event.messageType === "user") gate.startUserPrompt();
    return undefined;
  });
  pi.on("tool_call", (event) => {
    const e = event as { toolName?: string; toolCallId?: string; input?: { path?: unknown } };
    if ((e.toolName === "write" || e.toolName === "edit") && typeof e.input?.path === "string" && /\.tex$/i.test(e.input.path) && e.toolCallId !== undefined) {
      texWrites.set(e.toolCallId, { path: e.input.path });
    }
    return undefined;
  });
  pi.on("tool_execution_end", (event) => {
    const e = event as { toolName?: string; toolCallId?: string; isError?: boolean };
    const recorded = e.toolCallId !== undefined ? texWrites.get(e.toolCallId) : undefined;
    if (e.toolCallId !== undefined) texWrites.delete(e.toolCallId);
    gate.toolEnded({ toolName: e.toolName ?? "", args: recorded, isError: e.isError === true });
    return undefined;
  });
  pi.on("agent_before_settle", (event: AgentBeforeSettleEvent, ctx: ExtensionContext): BoundaryResult | undefined => {
    if (childDepth > 0 || !gate.shouldAudit(event.outcome)) return undefined;
    let result: ProvenanceOutcome;
    try {
      result = audit(ctx.cwd);
    } catch {
      return undefined; // fail open: the Tier 1 gate still catches it
    }
    const text = gate.followUp(result);
    if (text === null) return undefined;
    return {
      continue: true,
      entries: [{ type: "custom_message", customType: COMPLETION_GATE_TYPE, content: text, display: true }],
    };
  });
}
