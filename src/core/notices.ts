/**
 * A deterministic honesty layer for host adapters. Models drop tool failures and warnings from their answers (seen in real sessions:
 * a refused verify_claim, a failed search provider, compile warnings, none mentioned). An adapter collects the notices a run's tool
 * results carried and, if the final answer does not mention one, appends it. Independent of how well the model follows rules.
 */
export interface Notice {
  /** What the answer must mention to count as having said it: a refusal code, a provider name, or the start of a warning. */
  key: string;
  line: string;
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The notices in one uktub tool result: a refusal, `warning: <provider> — CODE: …` lines (search), `- warning: …` lines (compile). */
export function extractNotices(tool: string, text: string, isError: boolean): Notice[] {
  const out: Notice[] = [];
  const refusal = /^Refused: ([A-Z][A-Z0-9_]*) — (.*?)(?:\. Next:|$)/ms.exec(text);
  if (refusal !== null && (isError || text.startsWith("Refused:"))) {
    out.push({ key: refusal[1] ?? "", line: `${tool} was refused (${refusal[1]}): ${clip(refusal[2] ?? "", 220)}` });
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
  const missing = notices.filter((n) => !have.includes(n.key.toLowerCase()));
  if (missing.length === 0) return null;
  return `\n\n⚠ Tool notices not mentioned above (added by uktub-scholar):\n${missing.map((n) => `- ${n.line}`).join("\n")}`;
}
