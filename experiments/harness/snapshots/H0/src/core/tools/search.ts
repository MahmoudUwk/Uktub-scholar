/**
 * `search_papers` tool (R4, R7, R8): search all providers, degrade on
 * per-provider failure, refuse only when every provider failed. Ordering is
 * RRF order as `searchPapers` produced it (KTD6); a DOI-shaped query runs the
 * search anyway and surfaces the register hint in `details` (plan U4).
 */

import { Type, type Static } from "typebox";

import { SearchUnavailableError, searchPapers } from "../scholarly.ts";
import type { ProviderWarning } from "../scholarly.ts";
import { providerConfigOf, refusalResult, type ToolContext, type ToolResult } from "./context.ts";

export const SearchPapersParams = Type.Object({
  query: Type.String({ description: "Free-text scholarly query; DOI-shaped strings are allowed and hinted" }),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, description: "Max candidates to return (default 5, cap 20)" }),
  ),
});
export type SearchPapersArgs = Static<typeof SearchPapersParams>;

/** Output schema (R8): deterministic shape the adapter declares to the host. */
export const SearchPapersOutput = Type.Object({
  query: Type.String(),
  candidates: Type.Array(
    Type.Object({
      title: Type.String(),
      doi: Type.Union([Type.String(), Type.Null()]),
      authors: Type.Array(Type.String()),
      venue: Type.Union([Type.String(), Type.Null()]),
      year: Type.Union([Type.Number(), Type.Null()]),
      citationCount: Type.Union([Type.Number(), Type.Null()]),
      endpoint: Type.String(),
    }),
  ),
  warnings: Type.Array(
    Type.Object({ provider: Type.String(), code: Type.String(), message: Type.String() }),
  ),
  requested: Type.Number(),
  returned: Type.Number(),
  truncated: Type.Boolean(),
});

export interface SearchPapersStructured {
  query: string;
  candidates: {
    title: string;
    doi: string | null;
    authors: string[];
    venue: string | null;
    year: number | null;
    citationCount: number | null;
    endpoint: string;
  }[];
  warnings: ProviderWarning[];
  requested: number;
  returned: number;
  truncated: boolean;
}

/**
 * Run the search. Refuses `SEARCH_UNAVAILABLE` only when all providers failed;
 * a DOI-shaped query still searches and carries the hint in `details`.
 */
export async function searchPapersTool(
  ctx: ToolContext,
  args: SearchPapersArgs,
): Promise<ToolResult<SearchPapersStructured>> {
  if (typeof args.query !== "string" || args.query.trim().length === 0) {
    return refusalResult({ code: "QUERY_REQUIRED", message: "search_papers needs a non-empty query" });
  }
  try {
    const result = await searchPapers(ctx.fetch, providerConfigOf(ctx), {
      query: args.query,
      limit: args.limit,
    });
    const structured: SearchPapersStructured = {
      query: args.query.trim(),
      candidates: result.candidates.map((candidate) => ({
        title: candidate.title,
        doi: candidate.doi,
        authors: candidate.authors,
        venue: candidate.venue,
        year: candidate.year,
        citationCount: candidate.citationCount,
        endpoint: candidate.endpoint,
      })),
      warnings: result.warnings,
      requested: result.requested,
      returned: result.returned,
      truncated: result.truncated,
    };
    return {
      content: [
        {
          type: "text",
          text:
            `${structured.returned} candidate${structured.returned === 1 ? "" : "s"} for "${structured.query}"` +
            (structured.truncated ? ` (truncated to the requested ${structured.requested})` : "") +
            (structured.warnings.length > 0
              ? ` — ${structured.warnings.length} provider warning${structured.warnings.length === 1 ? "" : "s"}`
              : "") +
            // Name them: a bare count lets the model claim every provider answered.
            structured.warnings
              .map((warning) => `\nwarning: ${warning.provider} — ${warning.code}: ${warning.message}; results exclude ${warning.provider}`)
              .join("") +
            // A DOI-shaped query: say so where the model reads it, or it keeps treating the identifier as a topic.
            (result.hint !== null ? `\nhint: ${result.hint}` : "") +
            // The model reads ONLY this text (structuredContent is for
            // codemode callers): each candidate must appear here or the model
            // cannot select and register it. One deterministic line each.
            (structured.candidates.length > 0
              ? "\n" +
                structured.candidates
                  .map(
                    (candidate, index) =>
                      `${index + 1}. ${candidate.doi ?? "no DOI"} — ${candidate.title}` +
                      ` (${candidate.year ?? "n.d."}${candidate.venue ? `, ${candidate.venue}` : ""})`,
                  )
                  .join("\n")
              : ""),
        },
      ],
      structuredContent: structured,
      details: {
        // Feynman adoption (KTD3): a DOI-shaped query is not an error and not
        // re-routed — paper_registry is the precise instrument for it.
        hint: result.hint,
      },
    };
  } catch (err) {
    if (err instanceof SearchUnavailableError) {
      return refusalResult({
        code: "SEARCH_UNAVAILABLE",
        message:
          `no scholarly provider answered the query "${args.query.trim()}"` +
          (err.warnings.length > 0
            ? ` (${err.warnings.map((warning) => `${warning.provider}: ${warning.message}`).join("; ")})`
            : ""),
      });
    }
    throw err;
  }
}
