/**
 * Configured verification-engine registry (KTD6): maps
 * `verification.engine` from config/chunking.yaml to a ClaimEngine, with
 * `mercury-decide:free` (OpenRouter System One) as the default and a local
 * llama.cpp System One endpoint as the offline path. Every knob is a named
 * env; the engine itself never reads ambient state.
 */

import {
  bevEngine,
  juliaEngine,
  k2Engine,
  layaEngine,
  lummaEngine,
  openrouterDecisionsEngine,
  systemoneEndpointEngine,
  type ClaimEngine,
} from "./claim.ts";

/** Default hosted decision model: free tier, measured best in class
 * (docs/benchmarks/openrouter-decision-models-2026-10-03.md). */
export const DEFAULT_OPENROUTER_MODEL = "inception/mercury-decide:free";
/** Local llama.cpp System One endpoint (`llama-server` default port). */
export const DEFAULT_LLAMA_CPP_URL = "http://127.0.0.1:8080";

export const VERIFICATION_ENGINES = [
  "openrouter",
  "llama-cpp",
  "k2",
  "bev",
  "lumma",
  "julia",
  "laya",
] as const;

export type VerificationEngineName = (typeof VERIFICATION_ENGINES)[number];

/** The model identity recorded with cached verdicts (cache key consumer). */
export function verificationModelLabel(env: Record<string, string | undefined>, engine: string): string {
  switch (engine) {
    case "openrouter":
      return `openrouter:${env.UKTUB_OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL}`;
    case "llama-cpp":
      return `llama-cpp:${env.UKTUB_VERIFY_URL ?? DEFAULT_LLAMA_CPP_URL}`;
    case "k2":
      return "k2:IFM/K2-Type-0.9B";
    case "bev":
      return "bev:avbiswas/bev-decider-0.4B";
    case "lumma":
      return "lumma:FrontiersMind/lumma-fev-0.6b";
    case "julia":
      return `julia:${env.UKTUB_JULIA_MODEL ?? "SupersonicLabs/Julia-1"}`;
    case "laya":
      return "laya:convaiinnovations/laya-multilingual";
    default:
      throw new Error(`unknown verification engine: ${engine}`);
  }
}

/** Build the engine named by config. Unknown names throw (typed refusal at
 * the tool boundary maps this to VERIFY_ENGINE_MISSING). */
export function createConfiguredEngine(env: Record<string, string | undefined>, engine: string): ClaimEngine {
  switch (engine) {
    case "openrouter":
      return openrouterDecisionsEngine({ env, model: env.UKTUB_OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL });
    case "llama-cpp":
      return systemoneEndpointEngine({
        env,
        url: (env.UKTUB_VERIFY_URL ?? DEFAULT_LLAMA_CPP_URL).replace(/\/+$/, "") + "/v1/systemone",
        label: "llama-cpp",
      });
    case "k2":
      return k2Engine({ env });
    case "bev":
      return bevEngine({ env });
    case "lumma":
      return lummaEngine({ env });
    case "julia":
      return juliaEngine({ env });
    case "laya":
      return layaEngine({ env });
    default:
      throw new Error(
        `unknown verification.engine "${engine}" (known: ${VERIFICATION_ENGINES.join(", ")})`,
      );
  }
}
