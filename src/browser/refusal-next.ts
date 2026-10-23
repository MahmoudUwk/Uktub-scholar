/**
 * Browser host's per-code refusal `next` wording (Phase 9a).
 *
 * A message says what happened; `next` says what to do. The Node table in
 * `src/core/refusals.ts` names Node-only remedies (CLI install commands,
 * local-engine env names, server config paths) that do not exist in the
 * browser, so the browser host supplies its own `next` for exactly those
 * codes and renders refusals with it (the `details.refused` code/message
 * stay the core's). Codes absent here keep the Node table text.
 *
 * `NODE_ONLY_DENYLIST` is the client-policy list of remedy tokens that must
 * never reach the browser agent's refusal text — neither in a browser `next`
 * nor in a browser-reachable refusal message. `tests-browser/refusal-next.spec.ts`
 * enforces both, plus completeness (every Node `next` naming a token below
 * must have an override here).
 */

import type { RefusalCode } from "../core/refusals.ts";

/** Remedy tokens that name Node-only fixes (client policy denylist). */
export const NODE_ONLY_DENYLIST: readonly string[] = [
  "uktub-scholar", // the Node CLI (init / install commands)
  "UKTUB_EOS_PYTHON", // local-Eos interpreter env
  "UKTUB_TECTONIC_BIN", // local tectonic binary override
  "tectonic", // the local TeX engine (also matches Tectonic / tectonic-typesetting URLs)
  "chunking.yaml", // the Node server config file (also matches config/chunking.yaml)
  "UKTUB_CHUNK_CONFIG", // its env override
  "UKTUB_COMPILE_TIMEOUT_S", // the Node compile-budget env (browser budget comes from the agent surface)
  "UKTUB_VERIFY_URL", // the loopback System One server env
  // Client policy (measured CORS block, 2026-10-22, real Chromium): the
  // hosted verifier answers no ACAO, so no page can reach it — its origin
  // and name must never appear as a browser remedy.
  "decision.vllm-sr.ai", // the hosted verifier origin
  "hosted", // the hosted verification engine
];

export const BROWSER_REFUSAL_NEXT: Partial<Record<RefusalCode, string>> = {
  REGISTRY_NOT_INITIALIZED:
    "reopen the project from the project list (its registry is created when the project opens), then retry",
  REGISTRY_CORRUPT:
    "the registry file is not a valid SQLite database; delete the project from the project list and open it again to recreate it (papers are lost)",
  COMPILE_ENGINE_MISSING: "reload the page — the TeX engine failed to load — then retry",
  COMPILE_TIMEOUT: "simplify the document, then retry",
  VERIFY_ENGINE_MISSING:
    "choose the OpenRouter verification engine in Verification settings and add the user's key, then retry; do not improvise a verdict, passages still works",
  CONFIG_INVALID: "fix the reported setting in Verification settings, then retry",
};
