/**
 * Shared `write_section` definition (Phase 8b): the one tool identity, the
 * parameter and forward schemas, argument coercion/validation, the result
 * text composition and the writer-turn text extraction both hosts use. Pi
 * re-exports all of it from `src/pi/` (behavior byte-identical); the browser
 * imports it from here through a Vite alias (no copy).
 *
 * Runtime-neutral: no SDK, no Node builtin, no process reference. The only
 * imports are `typebox`, the neutral section-writer types, and the Node-free
 * `parsePapersParam`.
 */
import { Type, type Static } from "typebox";

import { parsePapersParam } from "../core/verify/papers-param.ts";
import type {
  AnnotatedClaimLine,
  SectionResult,
  UnitVerdict,
  WriteSectionParams as SectionParams,
} from "./section-writer.ts";

/** Tool identity both hosts register. */
export const WRITE_SECTION_NAME = "write_section";
export const WRITE_SECTION_LABEL = "Write section from papers";
export const WRITE_SECTION_DESCRIPTION =
  "Write ONE manuscript section in LaTeX for `goal`, using only facts from passages of the listed papers. " +
  "`papers` is ONE string of citekeys separated by spaces or commas (or an array of citekeys). Every factual sentence ends with \\cite{key}; " +
  "anything the papers do not support is left out or marked explicitly unverified. The section is verified as written " +
  "with `verify` document mode and failures get one repair round. Returns the LaTeX, a summary, and the unresolved units. " +
  "It never writes files: paste the returned LaTeX into the manuscript verbatim (rewriting invalidates its verification) and resolve any listed unresolved units.";

/** Params schema of the section writer (papers is ONE string: never an array). */
export const WriteSectionParams = Type.Object({
  goal: Type.String({ description: "What this section must say" }),
  papers: Type.String({ description: "ONE string of citekeys separated by spaces or commas (never an array)" }),
  query: Type.Optional(Type.String({ description: "Focus: which passages of the papers to build the section from" })),
  max_words: Type.Optional(Type.Number({ description: "Longest the section may be, in words" })),
});
export type WriteSectionArgs = Static<typeof WriteSectionParams>;

/** The sub-session `passages` forward: exploratory retrieval over the registered papers. */
export const ForwardPassagesParams = Type.Object({
  query: Type.String({ description: "Keywords or question to find verbatim passages in the papers" }),
  papers: Type.Optional(Type.String({ description: "Citekeys separated by spaces or commas, or 'all'" })),
});

/** The sub-session `verify` forward: a one-claim check that can run query-limited and be continued. */
export const ForwardVerifyParams = Type.Object({
  claim: Type.String({ description: "One plain-text factual claim (5-500 chars, no LaTeX commands) to check against the papers" }),
  papers: Type.Optional(Type.String({ description: "Citekey(s) separated by spaces or commas, or 'all'" })),
  query: Type.Optional(Type.String({ description: "Optional keywords to rank candidate passages first" })),
  continuation: Type.Optional(Type.String({ description: "OMIT on first call. Only pass the exact `vfy1:...` token returned by an incomplete prior verify call." })),
});

/** The sub-session `registry` forward (D1): metadata reads over the assigned papers only, fixed to `action: "read"`. */
export const ForwardRegistryParams = Type.Object({
  action: Type.Optional(Type.Literal("read", { description: "Fixed: the child may only read paper metadata" })),
  handles: Type.Optional(Type.Array(Type.String(), { description: "Restrict to these assigned papers (omit for every assigned paper)" })),
  fields: Type.Optional(Type.Array(Type.String(), { description: "Read fields besides doi and citekey" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Read page size" })),
  cursor: Type.Optional(Type.String({ description: "Continuation token from the previous page of the same request" })),
});

/** Compatibility shim for models that send `papers` as an array or a JSON string of one: join to the one-string form. */
export function coerceSectionArgs(raw: unknown): Record<string, unknown> {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (o.papers !== undefined && typeof o.papers !== "string") {
    const keys = parsePapersParam(o.papers);
    return { ...o, papers: keys.join(" ") };
  }
  return { ...o };
}

/** Coerce `max_words` (models send numbers as strings) and validate the whole params object. */
export function toSectionParams(raw: Record<string, unknown>): SectionParams {
  const goal = typeof raw.goal === "string" ? raw.goal.trim() : "";
  if (goal === "") throw new Error("write_section needs a goal");
  const papers = parsePapersParam(raw.papers);
  if (papers.length === 0) throw new Error("write_section needs at least one paper: one string of citekeys separated by spaces or commas");
  const params: SectionParams = { goal, papers };
  if (raw.query !== undefined) {
    if (typeof raw.query !== "string" || raw.query.trim() === "") throw new Error("query must be a non-empty string");
    params.query = raw.query;
  }
  if (raw.max_words !== undefined) {
    const n = typeof raw.max_words === "number" ? raw.max_words : Number(raw.max_words);
    if (!Number.isInteger(n) || n <= 0) throw new Error("max_words must be a positive integer");
    params.maxWords = n;
  }
  return params;
}

/** Normalize a sub-session papers value to the MCP form ("all" or a list): models omit it or send JSON strings. */
export const normalizeForwardPapers = (args: unknown): unknown => {
  const raw = (typeof args === "object" && args !== null ? { ...(args as Record<string, unknown>) } : {}) as Record<string, unknown>;
  if ("continuation" in raw && (typeof raw.continuation !== "string" || raw.continuation.trim() === "" || /\s/.test(raw.continuation.trim()))) {
    delete raw.continuation;
  }
  if (raw.papers === undefined) return { ...raw, papers: "all" };
  if (raw.papers === "all") return raw;
  const keys = parsePapersParam(raw.papers);
  return { ...raw, papers: keys.length > 0 ? keys : "all" };
};

/** Tool-output lines for the unresolved units (not model prompting): a supported unit listed here is explicitly verification-incomplete. */
export function unresolvedBlock(units: UnitVerdict[]): string {
  if (units.length === 0) return "Unresolved: none.";
  return `Unresolved:\n${units
    .map((u) =>
      u.status === "supported"
        ? `- [${u.id}] supported (verification incomplete): "${u.excerpt}"`
        : `- [${u.id}] ${u.status}: "${u.excerpt}"`,
    )
    .join("\n")}`;
}

/** The counts line both hosts append after the summary. */
export function sectionCountsLine(out: SectionResult): string {
  return `first draft ${out.firstDraft.ok}/${out.firstDraft.units} supported; final ${out.final.ok}/${out.final.units}; ${out.words} words`;
}

/** Result text composition both hosts return: LaTeX + `---` + summary + counts line + `unresolvedBlock`, plus the claim table in annotated mode. */
export function composeSectionResultText(out: SectionResult): string {
  const base = `${out.latex}\n\n---\n${out.summary}\n${sectionCountsLine(out)}\n${unresolvedBlock(out.unresolved)}`;
  const table = annotatedTable(out);
  return table === null ? base : `${base}\n${table}`;
}

/** The per-claim table of an annotated check (W5.9): per-paper support, unread-source notes, annotation problems. Null unless annotated. */
export function annotatedTable(out: SectionResult): string | null {
  const a = out.annotated;
  if (a?.mode !== "annotated") return null;
  const claimLine = (c: AnnotatedClaimLine): string => {
    const parts = c.sources.map((k, i) => (c.at[i] === "unsupported" ? `not supported by ${k}` : `${k} ${c.at[i]}`));
    return `c${c.marker} ${c.status}: ${parts.join("; ")}`;
  };
  const lines = ["Claims:", ...a.claims.map(claimLine)];
  if (a.unread.length > 0) lines.push(`Source notes: ${a.unread.map((u) => u.hint).join(" ")}`);
  if (a.problems.length > 0) {
    const problems = a.problems.map((p) => [p.code, p.marker === null ? null : `c${p.marker}`, p.citekey ?? null].filter((x) => x !== null).join(" "));
    lines.push(`Annotation problems: ${problems.join("; ")}`);
  }
  return lines.join("\n");
}

/** Refusal of a `verify` document-mode page, mapped exactly the same on both hosts (never success, never silent). */
export function verifyRefusalText(refused: { code?: unknown; message?: unknown }): string {
  return `verify document mode refused (${String(refused.code)}): ${refused.message ?? ""}`;
}

/** Malformed `verify` document-mode output, mapped exactly the same on both hosts. */
export const VERIFY_MALFORMED_TEXT = "verify document mode returned malformed output: refusing a partial set as complete";

/** Return text from this prompt only; failed or truncated responses cannot reuse an earlier draft. */
export function lastAssistantText(session: unknown, startIndex = 0): string {
  const messages = (session as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return "";
  let latest = true;
  for (let i = messages.length - 1; i >= Math.max(0, startIndex); i--) {
    const m = messages[i] as { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown };
    if (m?.role !== "assistant") continue;
    if (latest) {
      latest = false;
      if (m.stopReason === "error" || m.stopReason === "aborted" || m.stopReason === "length") {
        throw new Error(classifyWriterFailure(m.stopReason, m.errorMessage));
      }
    }
    if (!Array.isArray(m.content)) continue;
    const text = m.content
      .filter((b: { type?: unknown; text?: unknown }) => b?.type === "text" && typeof b.text === "string")
      .map((b: { text: string }) => b.text).join("").trim();
    if (text !== "") return text;
  }
  // getLastAssistantText() has no prompt boundary and could return an earlier draft.
  return "";
}

/** Static categories only: provider error bodies may contain source text or credentials. */
function classifyWriterFailure(stopReason: unknown, errorMessage: unknown): string {
  if (stopReason === "aborted") return "the writer sub-session was aborted before returning text";
  if (stopReason === "length") return "the writer sub-session hit the token limit before returning a complete section";
  const detail = typeof errorMessage === "string" ? errorMessage : "";
  if (/\b429\b|RESOURCE_EXHAUSTED|rate[ _-]?limit|too many requests|quota[ _]?exceeded/i.test(detail)) {
    return "the writer provider rate-limited the request (HTTP 429 / RESOURCE_EXHAUSTED); retry the section later";
  }
  if (/\b(401|403)\b|unauthorized|forbidden|api[ _]?key|credential|permission denied/i.test(detail)) {
    return "the writer provider refused authentication; check provider credentials";
  }
  return "the writer provider failed the request";
}
