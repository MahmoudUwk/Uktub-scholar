/**
 * Provider keys for the live harness: the shell first, then a gitignored `.env` in this repository. Only the named keys are ever read
 * and forwarded (CROSSREF_MAILTO is an address, not a credential); no other repository is consulted.
 */
export const KEY_NAMES = ["SEMANTIC_SCHOLAR_API_KEY", "OPENALEX_API_KEY", "CROSSREF_MAILTO"] as const;

/** `NAME=value` and `export NAME=value` lines for the requested names; quotes are stripped, empty values and everything else ignored. */
export function parseDotenv(text: string, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
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
