/**
 * Resolve the papers a tool call is scoped to: "all" registered papers, or an explicit list of
 * DOIs/citekeys. Unknown handles are reported, never guessed; an explicit list never widens to "all".
 */
import type { DatabaseSync } from "node:sqlite";

import { resolveHandle, selectPapers } from "../registry.ts";

export interface ScopePaper {
  doi: string;
  citekey: string;
  title: string;
  citable: boolean;
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
