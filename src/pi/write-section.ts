/**
 * Pi-only `write_section`: a section-writer subagent that writes each section
 * only from the listed papers' passages, then gets auto-verified. Host-side
 * logic (pure, tested); `src/pi/index.ts` registers the tool and wires the
 * real sub-session and the real document-mode check.
 *
 * The tool never writes files: the manuscript belongs to the user and the
 * main agent assembles it.
 */
import type { DocumentUnitStatus } from "../core/tools/verify.ts";

export interface WriteSectionParams {
  goal: string;
  /** ONE string of citekeys separated by spaces or commas (never an array: some models send arrays as JSON strings). */
  papers: string[];
  query?: string;
  maxWords?: number;
}

export interface UnitVerdict {
  id: string;
  excerpt: string;
  status: DocumentUnitStatus;
  suggested: string[];
  pointers: string[];
}

export interface SectionDeps {
  /** Run the writer sub-session once (initial brief or repair brief); returns the section LaTeX. */
  runWriter: (prompt: string) => Promise<string>;
  /** Check the returned text with `verify` document mode. */
  verifyDocument: (text: string) => Promise<{ units: UnitVerdict[] }>;
}

export interface SectionResult {
  latex: string;
  summary: string;
  unresolved: UnitVerdict[];
}

/** Split a papers value on spaces, commas or semicolons; accept arrays and JSON-string arrays too. */
export function parsePapersParam(input: unknown): string[] {
  let items: unknown = input;
  if (typeof items === "string") {
    const t = items.trim();
    if (t.startsWith("[") && t.endsWith("]")) {
      try {
        items = JSON.parse(t) as unknown;
      } catch {
        items = t;
      }
    }
  }
  const list = Array.isArray(items) ? items : typeof items === "string" ? items.split(/[\s,;]+/) : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    for (const k of item.split(/[\s,;]+/)) {
      const key = k.trim();
      if (key !== "" && !out.includes(key)) out.push(key);
    }
  }
  return out;
}

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
export function toSectionParams(raw: Record<string, unknown>): WriteSectionParams {
  const goal = typeof raw.goal === "string" ? raw.goal.trim() : "";
  if (goal === "") throw new Error("write_section needs a goal");
  const papers = parsePapersParam(raw.papers);
  if (papers.length === 0) throw new Error("write_section needs at least one paper: one string of citekeys separated by spaces or commas");
  const params: WriteSectionParams = { goal, papers };
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

/** Unwrap a fenced code block; bare text passes through. */
export function stripCodeFences(text: string): string {
  const m = /```(?:latex|tex)?\s*\n([\s\S]*?)```/.exec(text);
  return (m?.[1] ?? text).trim();
}

export function buildWriterPrompt(p: WriteSectionParams): string {
  return [
    "Write only the section body in LaTeX for this goal:",
    p.goal,
    "",
    `You may use only facts from passages of these registered papers: ${p.papers.join(", ")}.`,
    "Use the passages and verify tools to read them; use no other tools.",
    "End every factual sentence with \\cite{<key>} of the paper that states it.",
    "Write no fact from memory. If the papers do not support something, leave it out or write it as explicitly unverified.",
    p.query !== undefined ? `Focus on: ${p.query}.` : "",
    p.maxWords !== undefined ? `At most ${p.maxWords} words.` : "",
    "Return only the LaTeX section body, no explanation.",
  ].filter((l) => l !== "").join("\n");
}

export function buildRepairPrompt(failures: UnitVerdict[]): string {
  const lines = failures.map((f) => `- [${f.id}] (${f.status}) "${f.excerpt}"${f.suggested.length > 0 ? ` — support found in: ${f.suggested.join(", ")}` : ""}`);
  return [
    "The section you wrote was checked as written against the registered papers. These units are NOT supported; rewrite each one from a passage of its cited paper, add the missing citation, or delete it:",
    ...lines,
    "Return only the full revised LaTeX section body, no explanation.",
  ].join("\n");
}

/** Write the section, verify it as written, repair failures once, re-verify, and report what is still unresolved. */
export async function runWriteSection(deps: SectionDeps, params: WriteSectionParams): Promise<SectionResult> {
  if (params.papers.length === 0) throw new Error("write_section needs at least one paper");
  const first = stripCodeFences(await deps.runWriter(buildWriterPrompt(params)));
  const checkText = async (text: string): Promise<{ text: string; failed: UnitVerdict[]; units: UnitVerdict[] }> => {
    const { units } = await deps.verifyDocument(text);
    return { text, units, failed: units.filter((u) => u.status !== "supported") };
  };
  const firstCheck = await checkText(first);
  let current = firstCheck;
  let repaired = false;
  if (firstCheck.failed.length > 0) {
    repaired = true;
    const second = stripCodeFences(await deps.runWriter(buildRepairPrompt(firstCheck.failed)));
    current = await checkText(second);
  }
  const n = current.units.length;
  const ok = current.units.filter((u) => u.status === "supported").length;
  const summary = [
    repaired ? `${ok}/${n} supported after one repair round.` : `${ok}/${n} supported, no repair needed.`,
    ...current.units.filter((u) => u.status !== "supported").map((u) => `[${u.id}] ${u.status}: "${u.excerpt}"${u.suggested.length > 0 ? ` (suggests ${u.suggested.join(", ")})` : ""}`),
  ].join("\n");
  return { latex: current.text, summary, unresolved: current.failed };
}
