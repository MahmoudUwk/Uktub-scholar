/**
 * The `noul` question a claim becomes on a System One endpoint. ONE
 * implementation shared by the product engines (`claim.ts`) and the
 * claim-verification-v2 benchmark client (`scripts/bench-claims-v2-http.ts`),
 * so the two can never diverge again: the benchmarked Decision 2.0 criteria
 * wording. `native` (the claim alone) stays only as the benchmark's
 * ablation wording; the product never sends it.
 */

/** Wording of the `noul` question for a claim. */
export type SystemOneWording = "criteria" | "native";

/** The `noul` question for a claim: the shared Decision 2.0 wording with its yes and no criteria, or the claim alone. */
export function criteriaQuestion(claim: string, wording: SystemOneWording): Record<string, unknown> {
  if (wording === "native") return { type: "noul", instructions: claim };
  return {
    type: "noul",
    instructions:
      `Claim under test: "${claim}" Decide whether the state passage explicitly supports this claim. ` +
      "Answer true only if the passage itself states or directly entails the claim; answer false when the passage contradicts it or says nothing about it.",
    criteria: {
      false: "The passage contradicts the claim or says nothing about it.",
      true: "The passage explicitly states or directly entails the claim.",
    },
  };
}
