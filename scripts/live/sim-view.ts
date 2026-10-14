/**
 * What the simulated user (the reviewer) sees, and how its replies are read. Pure functions, tested in tests/live-sim-view.spec.ts.
 *
 * The observation channel is part of the instrument. Measured in iterations 4, 6 and 7 of adapter-literature-workflow-v1: the
 * reviewer saw the first 6,000 characters of the manuscript (49 to 66 percent of it), had no tools, and was asked to judge whether
 * claims were grounded in papers it could not see, so it ended "success" on notes whose invented figures were beyond its cut.
 * An arm names a channel; the first message tells the reviewer exactly what that channel holds and lacks.
 */
export type Arm = "A" | "B1" | "B2";
export const ARMS: readonly Arm[] = ["A", "B1", "B2"];
export interface ArmSpec { arm: Arm; /** The assistant's compile result carries the provenance summary. */ agentProvenance: boolean; reviewerView: "legacy" | "full" }
export interface ViewPolicy { legacyChars: number; fullManuscriptChars: number; evidenceTableChars: number }

export function armSpec(arm: string): ArmSpec {
  switch (arm) {
    case "A": return { arm: "A", agentProvenance: false, reviewerView: "legacy" };
    case "B1": return { arm: "B1", agentProvenance: false, reviewerView: "full" };
    case "B2": return { arm: "B2", agentProvenance: true, reviewerView: "full" };
    default: throw new Error(`unknown arm "${arm}" (use ${ARMS.join(", ")})`);
  }
}

const num = (n: number): string => n.toLocaleString("en-US");

/** The paragraph appended to the reviewer's first message: its exact observation channel in this run. */
export function channelText(spec: ArmSpec, policy: ViewPolicy): string {
  if (spec.reviewerView === "legacy") {
    return [
      "OBSERVATION CHANNEL FOR THIS RUN (exact; never claim to have seen anything outside it).",
      "After each assistant reply you receive: (1) the assistant's reply text; (2) a list of the project's files with sizes; (3) the first " + num(policy.legacyChars) + " characters of the .tex manuscript, as written, when it changed since your last view.",
      "You do NOT receive: any manuscript text beyond those " + num(policy.legacyChars) + " characters (later sections and tables are usually cut off); the contents of any other file, including evidence/claims.json and the PDF; any record of what the assistant did to produce its reply; the text of any paper; or any signal of whether a citation or a figure is supported by the paper it names.",
      "Consequence: you cannot verify whether figures or claims are sourced. Judge what you can read (does it look cited, does the assistant say what it could not check, is the requested structure present), say in <review> which of the success criteria you could not assess, and do not describe unseen content.",
    ].join("\n");
  }
  return [
    "OBSERVATION CHANNEL FOR THIS RUN (exact; never claim to have seen anything outside it).",
    "After each assistant reply you receive: (1) the assistant's reply text; (2) a list of the project's files with sizes; (3) the FULL text of every .tex file (up to " + num(policy.fullManuscriptChars) + " characters; a cut is stated); (4) the full text of evidence/claims.json, which is the assistant's own account of what it verified: a claim made by the assistant, not proof; (5) an activity digest: counts of the assistant's tool calls in its last reply and how many manuscript edits followed its last evidence lookup (a count, not a judgment of quality); (6) the Provenance view: computed by the project's own tools from the paper registry (not written by the assistant), listing for each statement whether the verify ledger holds support for that exact wording, and for each figure (numbers with units, hardware names) whether the cited paper's text contains it.",
    "You do NOT receive: the PDF, the text of any paper, or the assistant's reasoning. The Provenance view never judges whether a paper supports a statement's meaning; it only says what the registry can establish.",
    "Consequence: you can check, item by item, what the assistant claims against what the project can establish, and you are expected to.",
  ].join("\n");
}

const bare = (n: string): string => n.replace(/^mcp__uktub__/, "");

/** Counts of the assistant's tool calls in one reply, and how many manuscript edits came after its last evidence lookup. */
export function activityDigest(calls: Array<{ name: string; args: any }>): string {
  if (calls.length === 0) return "No tool calls in this reply.";
  const counts = new Map<string, number>();
  const label = (c: { name: string; args: any }): string => (bare(c.name) === "registry" && c.args?.action ? `registry:${c.args.action}` : bare(c.name));
  for (const c of calls) counts.set(label(c), (counts.get(label(c)) ?? 0) + 1);
  const isLookup = (c: { name: string }): boolean => ["passages", "verify"].includes(bare(c.name));
  const isManuscriptEdit = (c: { name: string; args: any }): boolean => ["write", "edit"].includes(c.name) && /\.tex$/.test(String(c.args?.path ?? c.args?.file_path ?? ""));
  const lookups = calls.filter(isLookup).length;
  const lastLookup = calls.reduce((at, c, i) => (isLookup(c) ? i : at), -1);
  const edits = calls.filter(isManuscriptEdit);
  const after = calls.filter((c, i) => i > lastLookup && isManuscriptEdit(c)).length;
  return [
    `Tool calls in this reply: ${[...counts.entries()].map(([k, n]) => `${k} ×${n}`).join("; ")}.`,
    `Evidence lookups (passages + verify): ${lookups}.`,
    `Manuscript edits: ${edits.length} (${after} after the last evidence lookup).`,
  ].join("\n");
}

/** The view the experiments used until now, byte for byte; `body` is what "unchanged since your last view" compares. */
export function legacyView(i: { files: string[]; tex: Array<{ path: string; text: string }>; lastBody: string; limit: number }): { text: string; body: string } {
  const body = i.tex.map((f) => `--- ${f.path} ---\n${f.text}`).join("\n").slice(0, i.limit);
  const changed = body !== i.lastBody;
  const text = `[Project folder view]\nFiles:\n${i.files.length ? i.files.map((f) => `- ${f}`).join("\n") : "(empty)"}\n${i.tex.length ? (changed ? `\nManuscript text now:\n${body}` : "\n(manuscript unchanged since your last view)") : "\n(no LaTeX manuscript yet)"}`;
  return { text, body };
}

export interface ViewInput {
  files: string[];
  tex: Array<{ path: string; text: string }>;
  evidenceTable: string | null;
  activity: string;
  provenance: string | null;
  /** Why the provenance view is missing (shown when `provenance` is null). */
  provenanceNote: string;
}

/** The complete channel of arms B1 and B2: nothing cut silently, every absence stated. */
export function fullView(i: ViewInput, policy: ViewPolicy): string {
  const all = i.tex.map((f) => `--- ${f.path} ---\n${f.text}`).join("\n");
  const cut = all.length > policy.fullManuscriptChars;
  const manuscript = i.tex.length === 0 ? "(no LaTeX manuscript yet)" : cut ? `${all.slice(0, policy.fullManuscriptChars)}\n[manuscript truncated at ${policy.fullManuscriptChars} of ${all.length} characters]` : all;
  const table = i.evidenceTable === null ? "evidence/claims.json is not present" : i.evidenceTable.length > policy.evidenceTableChars ? `${i.evidenceTable.slice(0, policy.evidenceTableChars)}\n[truncated at ${policy.evidenceTableChars} of ${i.evidenceTable.length} characters]` : i.evidenceTable;
  return [
    "[Project folder view]",
    "Files:",
    i.files.length ? i.files.map((f) => `- ${f}`).join("\n") : "(empty)",
    "",
    "[Manuscript: full text]",
    manuscript,
    "",
    "[Evidence table evidence/claims.json: the assistant's own account of what it verified]",
    table,
    "",
    "[What the assistant did in its last reply]",
    i.activity,
    "",
    "[Provenance view: computed by the project's tools from the registry, not written by the assistant]",
    i.provenance ?? `unavailable: ${i.provenanceNote}`,
  ].join("\n");
}

export interface SimReply { status: "continue" | "success" | "give_up" | ""; message: string; review: string; note: string }

export function parseSimulatorReply(raw: string): SimReply {
  const tag = (t: string): string => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i").exec(raw)?.[1]?.trim() ?? "";
  const status = tag("status").toLowerCase();
  return { status: status === "continue" || status === "success" || status === "give_up" ? status : "", message: tag("message"), review: tag("review"), note: tag("note") };
}
