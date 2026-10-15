/**
 * Provider keys for the live harness: the shell first, then a gitignored `.env` in this repository. Only the named keys are ever read
 * and forwarded (CROSSREF_MAILTO is an address, not a credential); no other repository is consulted.
 */
export const KEY_NAMES = ["SEMANTIC_SCHOLAR_API_KEY", "OPENALEX_API_KEY", "CROSSREF_MAILTO"] as const;

/**
 * The owner's OpenCode Go key for grader sessions only. Never part of KEY_NAMES and never forwarded
 * to the assistant's sandbox: assistant specs use KEY_NAMES, grader specs add these names.
 */
export const GRADER_KEY_NAMES = ["OPENCODE_API_KEY"] as const;

/** Host key name for the hosted decision endpoint (d3-mini). Forwarded only when `--verify-engine hosted` is set, renamed to VERIFY_API_KEY_ENV. */
export const VERIFY_KEY_NAMES = ["VLLM_decision_API"] as const;
/** Sandbox-side name of the hosted verify key (what the product reads): the single definition in `src/core/verify/engines.ts`. */
import { VERIFY_API_KEY_ENV } from "../../src/core/verify/engines.ts";
export { VERIFY_API_KEY_ENV };

/** Rename the host verify key for the sandbox (`VLLM_decision_API` → `UKTUB_VERIFY_API_KEY`); empty in, empty out. */
export function verifySecrets(got: Record<string, string>): Record<string, string> {
  return got.VLLM_decision_API !== undefined && got.VLLM_decision_API !== "" ? { [VERIFY_API_KEY_ENV]: got.VLLM_decision_API } : {};
}

/** `NAME=value` and `export NAME=value` lines for the requested names; quotes are stripped, empty values and everything else ignored. */
export function parseDotenv(text: string, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (m === null || !names.includes(m[1]!)) continue;
    const value = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
    if (value !== "") out[m[1]!] = value;
  }
  return out;
}

/** The shell wins over the file, per name. `dotenvText` is null when there is no file. */
export function providerKeys(shell: Record<string, string | undefined>, dotenvText: string | null, names: readonly string[] = KEY_NAMES): Record<string, string> {
  const file = dotenvText === null ? {} : parseDotenv(dotenvText, names);
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = shell[name] || file[name];
    if (value) out[name] = value;
  }
  return out;
}
