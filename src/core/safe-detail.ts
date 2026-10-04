/**
 * Failure text that reaches the agent. A hosted or local server may put part of the request into
 * its error body, so a detail that quotes any submitted passage is withheld (R5, R10): only the
 * fact of the failure remains. Shared by every client that sends passage text to a server.
 */

/** Client policy: an error that quotes this many consecutive characters of a
 *  submitted passage is treated as an echo of source text. */
const ECHO_WINDOW = 24;
/** Client policy: engine error detail shown to the agent is bounded. */
const MAX_DETAIL_CHARS = 300;

export function agentSafeDetail(err: unknown, submitted: string[]): string {
  const raw = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
  for (let i = 0; i + ECHO_WINDOW <= raw.length; i++) {
    const window = raw.slice(i, i + ECHO_WINDOW);
    if (submitted.some((t) => t.includes(window))) return "the engine rejected the request (details withheld: the error quoted passage text)";
  }
  return raw.slice(0, MAX_DETAIL_CHARS);
}

