/**
 * `list_papers` tool (R6, R8): the registry's state in citekey ASC order, with
 * an explicit truncation marker and remaining count at the cap (R19).
 */

import { Type } from "typebox";

import { RegistryError, countPapers, listPapers, openRegistry } from "../registry.ts";
import { refusalResult, type ToolContext, type ToolResult } from "./context.ts";

/**
 * Largest one list call returns. Client policy (R19): keep tool payloads
 * bounded like the search cap; the registry is the display source of truth
 * and the count of what was withheld travels with the truncation marker.
 */
export const LIST_PAPERS_CAP = 200;

/** Output schema (R8). */
export const ListPapersOutput = Type.Object({
  papers: Type.Array(
    Type.Object({
      citekey: Type.String(),
      doi: Type.String(),
      title: Type.String(),
      authors: Type.Array(Type.String()),
      year: Type.Union([Type.Number(), Type.Null()]),
      venue: Type.Union([Type.String(), Type.Null()]),
      citable: Type.Boolean(),
      bibtexSource: Type.Union([Type.String(), Type.Null()]),
      ingestedAt: Type.String(),
    }),
  ),
  truncated: Type.Boolean(),
  remaining: Type.Number(),
});

export interface ListPapersStructured {
  papers: {
    citekey: string;
    doi: string;
    title: string;
    authors: string[];
    year: number | null;
    venue: string | null;
    citable: boolean;
    bibtexSource: string | null;
    ingestedAt: string;
  }[];
  truncated: boolean;
  remaining: number;
}

/** List the registry in citekey order; over the cap, `truncated: true` + remaining. */
export function listPapersTool(ctx: ToolContext, args: { limit?: number } = {}): ToolResult<ListPapersStructured> {
  let db;
  try {
    db = openRegistry(ctx.root);
  } catch (err) {
    if (err instanceof RegistryError) {
      return refusalResult({ code: err.code, message: err.message });
    }
    throw err;
  }
  try {
    // The cap applies on top of the caller's limit (both client policy, R19).
    const cap = typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit >= 1
      ? Math.min(Math.trunc(args.limit), LIST_PAPERS_CAP)
      : LIST_PAPERS_CAP;
    // Cap+1 probe: one row past the cap detects truncation; COUNT(*) gives
    // the remaining marker without materializing the whole registry.
    const probed = listPapers(db, cap + 1);
    const truncated = probed.length > cap;
    const papers = (truncated ? probed.slice(0, cap) : probed).map((row) => ({
      citekey: row.citekey,
      doi: row.doi,
      title: row.title,
      authors: row.authors,
      year: row.year,
      venue: row.venue,
      citable: row.citable,
      bibtexSource: row.bibtexSource,
      ingestedAt: row.ingestedAt,
    }));
    const remaining = truncated ? countPapers(db) - cap : 0;
    const structured: ListPapersStructured = { papers, truncated: remaining > 0, remaining };
    return {
      content: [
        {
          type: "text",
          text:
            `${papers.length} paper${papers.length === 1 ? "" : "s"} in the registry` +
            (structured.truncated ? ` — ${remaining} more beyond the cap of ${cap}` : ""),
        },
      ],
      structuredContent: structured,
      details: { order: "citekey ASC (R6)", cap: cap },
    };
  } finally {
    db.close();
  }
}
