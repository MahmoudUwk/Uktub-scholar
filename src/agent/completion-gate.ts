/**
 * Pre-completion gate core (owner decision D1, 2026-10-19): runtime-neutral state and text. A host reports tool completions as
 * neutral events, asks whether a settle should audit, runs the provenance audit itself (Pi: `runProvenance` on disk; a browser: the
 * worker's provenance op), and hands the result back for the one bounded follow-up text. This module never runs the audit.
 *
 * Client policy: at most 2 follow-ups per user prompt, at most 10 pointers, 120-character excerpts.
 */
import type { ProvenanceAudit } from "../core/provenance/audit.ts";
import { unlabelledUnverifiedUnits, type UnitAudit } from "../core/provenance/audit.ts";
import { normalizeToolName } from "../core/tool-names.ts";

export const MAX_FOLLOW_UPS = 2;
export const MAX_POINTERS = 10;
export const EXCERPT_CHARS = 120;
/** The custom message type of a gate follow-up (not a user prompt: the counter resets only on user prompts). */
export const COMPLETION_GATE_TYPE = "uktub-completion-gate";

/** One completed tool call, as the gate needs it: `args` are the call's arguments (unknown: the gate checks what it reads). */
export interface NeutralToolEvent {
  toolName: string;
  args: unknown;
  isError: boolean;
}

/** The audit result the gate reads: structurally the provenance outcome (`ok: false` is a refusal, never a finding). */
export type GateAuditResult = { ok: true; entry: string; audit: ProvenanceAudit } | { ok: false; message?: string };

const excerpt = (plain: string): string => plain.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS);

/** The follow-up text: a count, at most 10 pointers, the overflow count, and the fixed instruction. */
export function followUpText(entry: string, count: number, units: UnitAudit[]): string {
  const shown = units.slice(0, MAX_POINTERS);
  const lines = [`Before finishing: ${count} statement(s) in ${entry} are neither verified as written nor labelled unverified:`];
  for (const u of shown) lines.push(`- L${u.unit.line} "${excerpt(u.unit.plain)}"`);
  if (units.length > shown.length) lines.push(`(and ${units.length - shown.length} more)`);
  lines.push('Resolve each: verify it, rewrite it from a passage of its cited paper, delete it, or mark it with the word "unverified". Then recompile and list what remains unverified in your final answer.');
  return lines.join("\n");
}

/** The registry block: the citation keys the audit found in no registry record (at most 10, then the overflow count). */
export function registryText(keys: string[], opener = "Before finishing:"): string {
  const shown = keys.slice(0, MAX_POINTERS);
  const more = keys.length > shown.length ? ` (and ${keys.length - shown.length} more)` : "";
  return [
    `${opener} these citation keys are not in the registry: ${shown.join(", ")}${more}`,
    'Register each paper that exists (registry register with its DOI or arXiv id), otherwise remove that \\cite and keep the statement only if it is marked with the word "unverified". Then recompile.',
  ].join("\n");
}

export interface CompletionGate {
  /** A user prompt starts a new budget (touch and follow-up count). Gate continuations never call this. */
  startUserPrompt(): void;
  /** Record one completed tool call: a compile, or a successful write/edit of a `.tex` path, touches the document. */
  toolEnded(event: NeutralToolEvent): void;
  /** Whether this settle should run the audit: the document was touched, the run completed, and the cap is not reached. */
  shouldAudit(outcome: string): boolean;
  /** The follow-up text for an audit result, or null when there is nothing to say; a returned text counts toward the cap. */
  followUp(result: GateAuditResult): string | null;
}

/** A `.tex` path, the same rule the Pi gate has always used. */
const isTexPath = (path: unknown): path is string => typeof path === "string" && /\.tex$/i.test(path);

export function createCompletionGate(): CompletionGate {
  let touched = false;
  let followUps = 0;
  return {
    startUserPrompt(): void {
      touched = false;
      followUps = 0;
    },
    toolEnded(event: NeutralToolEvent): void {
      if (normalizeToolName(event.toolName) === "compile") {
        touched = true;
        return;
      }
      const args = (typeof event.args === "object" && event.args !== null ? event.args : {}) as { path?: unknown };
      if ((event.toolName === "write" || event.toolName === "edit") && isTexPath(args.path) && event.isError !== true) touched = true;
    },
    shouldAudit(outcome: string): boolean {
      return touched && outcome === "completed" && followUps < MAX_FOLLOW_UPS;
    },
    followUp(result: GateAuditResult): string | null {
      if (!result.ok) return null;
      const units = unlabelledUnverifiedUnits(result.audit);
      const count = result.audit.summary.unlabelledUnverified;
      const keys = result.audit.summary.unregistered ?? [];
      const hasUnlabelled = count > 0 && units.length > 0;
      if (!hasUnlabelled && keys.length === 0) return null;
      const blocks: string[] = [];
      if (hasUnlabelled) blocks.push(followUpText(result.entry, count, units));
      if (keys.length > 0) blocks.push(registryText(keys, hasUnlabelled ? "Also," : "Before finishing:"));
      followUps += 1;
      return blocks.join("\n");
    },
  };
}
