/**
 * Adopted verification strategy (A/B 2026-10-15): how the registry
 * workflow picks the passages it judges. The `hosted` engine judges the
 * top-10 chunks per claim by the product's own lexical retrieval (the
 * FTS5/BM25 ranking `passages` uses; with no embedder configured `passages`
 * is lexical, so identical) and says so in coverage
 * (`searched: "candidate_limited"`, never "exhaustive"). Every other engine
 * runs exhaustive. `UKTUB_VERIFY_STRATEGY=exhaustive|top10` overrides the
 * hosted default (consumers: benchmark/study runs).
 */

import type { Candidate } from "./retrieve.ts";

/** Env override for the candidate strategy (labelled client policy, hosted only). */
export const VERIFY_STRATEGY_ENV = "UKTUB_VERIFY_STRATEGY";

export type VerifyStrategy = "exhaustive" | "top10";

/** Client policy: retrieval candidates judged per claim under the limited strategy. */
export const TOP_K = 10;

/** Parse the switch. Non-hosted engines always run exhaustive: the switch is hosted-only. */
export function verifySwitchFromEnv(env: Record<string, string | undefined>, engineName: string): VerifyStrategy {
  if (engineName !== "hosted") return "exhaustive";
  return (env[VERIFY_STRATEGY_ENV] ?? "").trim() === "exhaustive" ? "exhaustive" : "top10";
}

/** Narrow `all` (the exhaustive candidates) to the strategy's top-K units. */
export function topCandidates(all: Candidate[], rankedChunkIds: string[], k: number = TOP_K): Candidate[] {
  const byId = new Map(all.map((c) => [c.chunkId, c]));
  const units: Candidate[] = [];
  for (const id of rankedChunkIds.slice(0, Math.max(0, k))) {
    const c = byId.get(id);
    if (c !== undefined) units.push(c);
  }
  return units;
}
