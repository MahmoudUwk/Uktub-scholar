/**
 * Section-scoped paper gating for the `write_section` child (W1): the parent
 * assigns the papers and code limits the child's forwards to them.
 *
 * Runtime-neutral: no Node builtin, no SDK, no process reference, so the
 * browser can import it alongside `section-tool.ts`.
 */
import { parsePapersParam } from "../core/verify/papers-param.ts";
import { normalizeForwardPapers } from "./section-tool.ts";

/** Client policy: at most 20 full-text papers per section. */
export const MAX_SECTION_PAPERS = 20;

/** Readiness states of an assigned paper that is not usable yet. */
export type PaperNotReady = "not_registered" | "metadata_only" | "acquiring" | "unavailable" | "failed";

/** One assigned paper with its registry readiness. */
export interface SectionPaper {
  handle: string;
  citekey: string | null;
  doi: string | null;
  state: "ready" | PaperNotReady;
  detail: string | null;
}

/** The paper set a section child may read: canonical citekeys in the parent's order. */
export interface SectionScope {
  keys: readonly string[];
  /** An exact citekey or a DOI (case-insensitive) of an assigned paper, or null. */
  keyOf(handle: string): string | null;
}

/** Refusal text when a forward names a paper outside the assigned set. */
export const outOfScopeMessage = (handle: string, scope: SectionScope): string =>
  `paper ${JSON.stringify(handle)} is not assigned to this section; allowed: ${scope.keys.join(", ")}`;

/** Repair step per unreadiness state (tool output wording, not prompt text). */
const nextStepOf = (state: PaperNotReady): string => {
  switch (state) {
    case "not_registered": return "register it or drop it";
    case "metadata_only": return "`registry action=acquire` or `attach_source`, then retry, or drop it";
    case "acquiring": return "retry shortly or drop it";
    case "unavailable":
    case "failed": return "`attach_source` or drop it";
  }
};

/**
 * Gate the assigned papers: count unique papers by DOI (plus unresolved
 * handles), refuse over the limit, refuse listing every unready paper once
 * with its reason and next step, else return the scope of ready citekeys in
 * the parent's order.
 */
export function checkSectionPapers(
  handles: readonly string[],
  rows: readonly SectionPaper[],
): { ok: true; scope: SectionScope } | { ok: false; message: string } {
  const byHandle = new Map<string, SectionPaper>();
  for (const r of rows) if (!byHandle.has(r.handle)) byHandle.set(r.handle, r);
  // Unique papers: one DOI counts once even when named by citekey and DOI;
  // each unresolved handle counts on its own (it names no shared paper).
  const unique = new Map<string, SectionPaper>();
  for (const h of handles) {
    const row = byHandle.get(h) ?? { handle: h, citekey: null, doi: null, state: "not_registered" as const, detail: null };
    const key = row.doi !== null ? `doi:${row.doi.trim().toLowerCase()}` : row.citekey !== null ? `citekey:${row.citekey}` : `handle:${row.handle}`;
    if (!unique.has(key)) unique.set(key, row);
  }
  const papers = [...unique.values()];
  if (papers.length > MAX_SECTION_PAPERS) {
    return {
      ok: false,
      message: `write_section refused: ${papers.length} papers exceed the ${MAX_SECTION_PAPERS}-paper section limit (client policy); assign at most ${MAX_SECTION_PAPERS} papers or split the section`,
    };
  }
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of papers) {
    if (r.state === "ready") continue;
    const key = r.citekey ?? r.handle;
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = r.detail !== null && r.detail !== "" ? `${r.state} (${r.detail})` : r.state;
    lines.push(`- ${key}: ${reason}. Next: ${nextStepOf(r.state)}`);
  }
  if (lines.length > 0) {
    return {
      ok: false,
      message: `write_section refused: ${lines.length} of ${papers.length} assigned paper(s) have no usable full text:\n${lines.join("\n")}`,
    };
  }
  const entries = papers.map((r) => ({ citekey: r.citekey ?? r.handle, doi: r.doi }));
  const keys = entries.map((e) => e.citekey);
  const keyOf = (handle: string): string | null => {
    const t = handle.trim();
    const exact = entries.find((e) => e.citekey === t);
    if (exact !== undefined) return exact.citekey;
    const lower = t.toLowerCase();
    const folded = entries.find((e) => e.citekey.toLowerCase() === lower);
    if (folded !== undefined) return folded.citekey;
    return entries.find((e) => e.doi !== null && e.doi.trim().toLowerCase() === lower)?.citekey ?? null;
  };
  return { ok: true, scope: { keys, keyOf } };
}

/** Shape shared by the passages and verify papers forwards after normalization. */
interface PapersArgs {
  papers?: unknown;
  [key: string]: unknown;
}

/**
 * Scope a passages/verify forward's papers to the section: "all", missing or
 * unparseable papers become the full allowed list; every listed handle must
 * resolve through keyOf (a literal "all" inside a list refuses like any
 * unknown handle), mapped to its citekey and deduped. Never narrows silently.
 */
export function scopeForwardArgs(
  args: unknown,
  scope: SectionScope,
): { ok: true; args: unknown } | { ok: false; message: string } {
  const norm = normalizeForwardPapers(args) as PapersArgs;
  if (norm.papers === "all" || !Array.isArray(norm.papers) || norm.papers.length === 0) {
    return { ok: true, args: { ...norm, papers: [...scope.keys] } };
  }
  const mapped: string[] = [];
  for (const h of norm.papers) {
    if (typeof h !== "string") return { ok: false, message: outOfScopeMessage(String(h), scope) };
    const key = scope.keyOf(h);
    if (key === null) return { ok: false, message: outOfScopeMessage(h, scope) };
    if (!mapped.includes(key)) mapped.push(key);
  }
  return { ok: true, args: { ...norm, papers: mapped } };
}

/** The read action's own arguments (mirrors the registry tool's ACCEPTS for read). */
const REGISTRY_READ_ARGS: ReadonlySet<string> = new Set(["handles", "fields", "limit", "cursor"]);

/**
 * Scope the D1 registry forward: fixed to `action: "read"`, accepting only
 * handles, fields, limit and cursor. Handles omitted (or empty) become the
 * full allowed list; listed handles scope exactly like papers (keyOf; unknown
 * refuses the whole call); any other action or argument is refused.
 */
export function scopeRegistryArgs(
  args: unknown,
  scope: SectionScope,
): { ok: true; args: unknown } | { ok: false; message: string } {
  const raw = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  if (raw.action !== undefined && raw.action !== "read") {
    return { ok: false, message: `registry forward accepts only action "read", got ${JSON.stringify(raw.action)}` };
  }
  for (const key of Object.keys(raw)) {
    if (key === "action") continue;
    if (!REGISTRY_READ_ARGS.has(key)) {
      return { ok: false, message: `"${key}" does not apply to the registry read forward; it accepts only handles, fields, limit and cursor` };
    }
  }
  const parsed = raw.handles === undefined ? [] : parsePapersParam(raw.handles);
  if (parsed.length === 0) {
    return { ok: true, args: { ...raw, action: "read", handles: [...scope.keys] } };
  }
  const mapped: string[] = [];
  for (const h of parsed) {
    const key = scope.keyOf(h);
    if (key === null) return { ok: false, message: outOfScopeMessage(h, scope) };
    if (!mapped.includes(key)) mapped.push(key);
  }
  return { ok: true, args: { ...raw, action: "read", handles: mapped } };
}
