/**
 * A deterministic honesty layer for host adapters. Models drop tool failures and warnings from their answers (seen in real sessions:
 * a refused verify_claim, a failed search provider, compile warnings, none mentioned). An adapter collects the notices a run's tool
 * results carried and, if the final answer does not mention one, appends it. Independent of how well the model follows rules.
 */
/** Every guard block message starts with this, so the notices layer can see blocks of any tool (bash, edit, write). */
export const BLOCK_PREFIX = "Blocked by uktub-scholar:";

export interface Notice {
  /** Identity for replacing/clearing within a run (default: key + line). */
  id?: string;
  /** Extra words that also count as the answer having said it. */
  anyOf?: readonly string[];
  /** What the answer must mention to count as having said it: a refusal code, a provider name, or the start of a warning. */
  key: string;
  line: string;
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const claimOf = (text: string): string => /^claim: (.*)$/m.exec(text)?.[1]?.trim() ?? "";

/** Ids of earlier notices this result settles: a verification whose work now reads `; complete` clears its run's interruption (by explicit run id, else by claim for an exhaustive result). */
export function clearedIds(tool: string, text: string, verificationRunId?: string): string[] {
  if (tool !== "verify_claim" || !/^work: \d+ of \d+ selected passage\(s\) judged .*; complete$/m.test(text)) return [];
  if (verificationRunId !== undefined) return [`interrupted|${verificationRunId}`];
  return /^candidates: exhaustive/m.test(text) ? [`interrupted|${claimOf(text)}`] : [];
}

/** The notices in one uktub tool result: a refusal, `warning: <provider> — CODE: …` lines (search), `- warning: …` lines (compile). */
export function extractNotices(tool: string, text: string, isError: boolean, verificationRunId?: string): Notice[] {
  const out: Notice[] = [];
  if (text.startsWith(BLOCK_PREFIX)) {
    const reason = text.slice(BLOCK_PREFIX.length);
    out.push({
      id: `blocked|${tool}|${reason.slice(0, 60)}`,
      key: "blocked",
      anyOf: ["not run", "did not run", "didn't run", "declin", "cancel", "refus", "prevent", "protected", "not allowed", "cannot", "can't", "unable", "wasn't", "was not", "won't", "will not"],
      line: `${tool} was blocked: ${clip(reason, 200)}`,
    });
    return out;
  }
  const refusal = /^Refused: ([A-Z][A-Z0-9_]*) — (.*?)(?:\. Next:|$)/ms.exec(text);
  if (refusal !== null && (isError || text.startsWith("Refused:"))) {
    out.push({ key: refusal[1] ?? "", line: `${tool} was refused (${refusal[1]}): ${clip(refusal[2] ?? "", 220)}` });
  }
  const stopped = /^work: (\d+) of (\d+) selected passage\(s\) judged .*?; INTERRUPTED \(([^)]*)\):/m.exec(text);
  if (stopped !== null) {
    const claim = claimOf(text);
    const notChecked = Number(stopped[2]) - Number(stopped[1]);
    out.push({
      id: `interrupted|${verificationRunId ?? claim}`,
      key: "interrupted",
      anyOf: ["incomplete", "not checked", "unchecked", "partial", "stopped", "remaining", "budget", "not finish", "not complete"],
      line: `${tool} stopped early (${stopped[3]}): ${notChecked} of ${stopped[2]} selected passages were NOT checked for the claim "${clip(claim, 80)}"; the result is incomplete (a continuation token is available)`,
    });
  }
  if (isError && out.length === 0) {
    // not a typed refusal: a host timeout, "Error executing tool …", an unknown tool
    out.push({
      id: `failed|${tool}|${text.slice(0, 60)}`,
      key: "failed",
      anyOf: ["fail", "error", "timed out", "timeout", "time out", "could not", "couldn't", "unable", "did not complete", "didn't complete", "not complete"],
      line: `${tool} failed: ${clip(text, 200)}`,
    });
  }
  if (tool === "paper_registry") {
    // an audit trail of what changed the bibliography, so a silent change cannot stay silent
    for (const m of text.matchAll(/^\[\d+\] (registered|updated|removed|attached) (\S+) (\S+)/gm)) {
      out.push({ id: `changed|${m[1]}|${m[2]}`, key: m[2] ?? "", anyOf: [m[3] ?? ""], line: `paper_registry ${m[1]} ${m[2]} (${m[3]})` });
    }
    for (const m of text.matchAll(/^\[(\d+)\] refused ([A-Z][A-Z0-9_]*) — (.*?)(?:\. Next:|$)/gm)) {
      out.push({ id: `refused|${m[1]}|${m[2]}|${m[3]}`, key: m[2] ?? "", line: `paper_registry item [${m[1]}] was refused (${m[2]}): ${clip(m[3] ?? "", 200)}` });
    }
    for (const m of text.matchAll(/^warning ([A-Z][A-Z0-9_]*): (.*?)(?:\. Next:|$)/gm)) {
      out.push({ id: `warning|${m[1]}|${m[2]}`, key: m[1] ?? "", line: `paper_registry warning (${m[1]}): ${clip(m[2] ?? "", 200)}` });
    }
  }
  for (const m of text.matchAll(/^warning: (\S+) — ([A-Z_]+): (.*)$/gm)) {
    out.push({ key: m[1] ?? "", line: `${tool}: provider ${m[1]} did not answer (${m[2]}: ${clip(m[3] ?? "", 160)})` });
  }
  for (const m of text.matchAll(/^- warning: (.*)$/gm)) {
    const msg = m[1] ?? "";
    out.push({ key: msg.slice(0, 30), line: `${tool} warning: ${clip(msg, 200)}` });
  }
  return out;
}

/** The footer for the notices an answer does not mention (case-insensitive on each notice's key), or null when it covers them all. */
export function footerFor(answer: string, notices: readonly Notice[]): string | null {
  const have = answer.toLowerCase();
  const missing = notices.filter((n) => ![n.key, ...(n.anyOf ?? [])].some((w) => have.includes(w.toLowerCase())));
  if (missing.length === 0) return null;
  return `\n\n⚠ Tool notices not mentioned above (added by uktub-scholar):\n${missing.map((n) => `- ${n.line}`).join("\n")}`;
}
