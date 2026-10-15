/**
 * Evaluator check ids shared by the measurement harness: the concrete
 * protocol check set of scripts/live/experiment.ts (every real run carries
 * exactly these ids; a missing check refuses, never passes by omission) and
 * the conditional checks that join the critical set for scenarios declaring
 * them. No per-check statistics here: presence only. The self-improving loop
 * that used to consume these ids (`pnpm evolve`) was removed 2026-10-15; the
 * simulator path (`--user scripted|simulator`) and the visibility arms
 * (A/B1/B2) are untouched.
 */

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
