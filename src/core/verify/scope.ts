/**
 * Resolve the papers a tool call is scoped to: "all" registered papers, or an explicit list of
 * DOIs/citekeys. Unknown handles are reported, never guessed; an explicit list never widens to "all".
 */
import { resolveHandle, selectPapers, type DatabaseSync } from "../registry.ts";
import { parsePapersParam } from "./papers-param.ts";
export { parsePapersParam };

export interface ScopePaper {
  doi: string;
  citekey: string;
  title: string;
  citable: boolean;
}

/**
 * Normalize a tool's `papers` argument ("all", string of handles, JSON-string array, or string[]) to `"all" | string[]`.
 * Returns `null` when empty or malformed so an empty scope is never read as `"all"`.
 */
export function normalizePapersScope(input: unknown): "all" | string[] | null {
  if (typeof input === "string") {
    const t = input.trim();
    if (t === "all") return "all";
    if (t.startsWith("[")) {
      if (!t.endsWith("]")) return null;
      try {
        const parsed = JSON.parse(t) as unknown;
        if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) return null;
        const list = parsePapersParam(parsed);
        return list.length > 0 ? list : null;
      } catch {
        return null;
      }
    }
    const list = parsePapersParam(t);
    return list.length > 0 ? list : null;
  }
  if (Array.isArray(input)) {
    if (input.some((x) => typeof x !== "string")) return null;
    const list = parsePapersParam(input);
    return list.length > 0 ? list : null;
  }
  return null;
}

export function resolveScope(db: DatabaseSync, papers: "all" | string[] | undefined): { selected: ScopePaper[]; unresolved: { handle: string; reason: string }[] } {
  const unresolved: { handle: string; reason: string }[] = [];
  if (papers === "all") {
    return { selected: selectPapers(db, { limit: 1_000_000 }).map((p) => ({ doi: p.doi, citekey: p.citekey, title: p.title, citable: p.citable })), unresolved };
  }
  const dois = new Set<string>();
  const seenHandles = new Set<string>();
  for (const h of papers ?? []) {
    if (seenHandles.has(h)) continue;
    seenHandles.add(h);
    const row = resolveHandle(db, h);
    if (row === null) unresolved.push({ handle: h, reason: "not_registered" });
    else dois.add(row.doi);
  }
  const details = new Map(selectPapers(db, { dois: [...dois], limit: Math.max(1, dois.size) }).map((p) => [p.doi, { doi: p.doi, citekey: p.citekey, title: p.title, citable: p.citable }]));
  return { selected: [...details.values()].sort((a, b) => (a.citekey < b.citekey ? -1 : 1)), unresolved };
}
