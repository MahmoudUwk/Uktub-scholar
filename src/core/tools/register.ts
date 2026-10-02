/**
 * `register_papers` tool (R5, R7, R8, R15): resolve each DOI to provider
 * metadata + provider BibTeX, write registry rows through the FIFO queue, and
 * report per-DOI outcomes in INPUT DOI order. Provider fetches run
 * concurrently outside the queue; each DOI's transactional section
 * (`registerPaper`, one `BEGIN IMMEDIATE` + bibliography render) runs inside
 * it, so overlapping calls never interleave their writes (KTD5).
 */

import { Type } from "typebox";

import { RegistryError, openRegistry, registerPaper } from "../registry.ts";
import type { RegisterOutcome } from "../registry.ts";
import { InvalidDoiError, fetchPaperMetadata, reasonOf } from "../scholarly.ts";
import { fetchWithRetry, retryOpts } from "../providers/http.ts";
import type { PaperRecord, ProviderConfig } from "../providers/types.ts";
import { WARNINGS } from "../refusals.ts";
import type { WarningCode } from "../refusals.ts";
import { providerConfigOf, refusalResult, type RenderedWarning, type ToolContext, type ToolResult } from "./context.ts";

/**
 * At most 50 DOIs per call — client policy (R19), Feynman-incident-informed
 * provider courtesy (the payload incident came from oversized tool results).
 */
const REGISTER_BATCH_MAX = 50;

/** Output schema (R8): outcomes in input order + whole-call warnings. */
export const RegisterPapersOutput = Type.Object({
  outcomes: Type.Array(
    Type.Object({
      doi: Type.String(),
      status: Type.Union([Type.Literal("registered"), Type.Literal("updated"), Type.Literal("refused")]),
      citekey: Type.Union([Type.String(), Type.Null()]),
      citable: Type.Union([Type.Boolean(), Type.Null()]),
      refusalCode: Type.Union([Type.String(), Type.Null()]),
      refusalMessage: Type.Union([Type.String(), Type.Null()]),
      warnings: Type.Array(Type.String()),
    }),
  ),
  warnings: Type.Array(
    Type.Object({ code: Type.String(), message: Type.String(), next: Type.String() }),
  ),
});

export interface RegisterPapersStructured {
  outcomes: {
    doi: string;
    status: "registered" | "updated" | "refused";
    citekey: string | null;
    citable: boolean | null;
    refusalCode: string | null;
    refusalMessage: string | null;
    warnings: string[];
  }[];
  warnings: RenderedWarning[];
}

/** One DOI's resolved record plus the title disagreement the cascade found. */
interface Resolved {
  doi: string;
  record: PaperRecord | null;
  failure: { code: Parameters<typeof refusalResult>[0]["code"]; message: string } | null;
  mismatch: string | null;
}

/**
 * Cross-provider title cross-check (KTD8): OpenAlex and Crossref must agree on
 * what this DOI names, or registration succeeds with `DOI_TITLE_MISMATCH`.
 * OpenAlex is fetched for the check only; its failure does not block
 * registration (the mismatch check degrades to "unchecked").
 */
async function crossCheckTitle(
  ctx: ToolContext,
  cfg: ProviderConfig,
  doi: string,
  crossrefTitle: string,
): Promise<string | null> {
  try {
    const url = `${cfg.openalexBaseUrl}/works/https://doi.org/${doi}` +
      (cfg.openalexApiKey ? `?api_key=${encodeURIComponent(cfg.openalexApiKey)}` : "");
    const response = await fetchWithRetry(ctx.fetch, url, retryOpts(cfg));
    if (response.status !== 200) return null;
    const body: unknown = JSON.parse(response.body);
    if (typeof body !== "object" || body === null) return null;
    const title = (body as Record<string, unknown>)["title"];
    if (typeof title !== "string" || title.length === 0 || crossrefTitle.length === 0) return null;
    const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
    return normalize(title) !== normalize(crossrefTitle) ? title : null;
  } catch {
    return null; // the check is best-effort; registration never depends on it
  }
}

/** Resolve one DOI (fetch phase — runs OUTSIDE the write queue). */
async function resolveDoi(ctx: ToolContext, cfg: ProviderConfig, rawDoi: string): Promise<Resolved> {
  try {
    const record = await fetchPaperMetadata(ctx.fetch, cfg, { doi: rawDoi });
    if (record === null) {
      return { doi: rawDoi, record: null, failure: { code: "DOI_NOT_FOUND", message: `no provider knows "${rawDoi}"` }, mismatch: null };
    }
    const mismatch = await crossCheckTitle(ctx, cfg, record.doi ?? rawDoi, record.title);
    return { doi: rawDoi, record, failure: null, mismatch };
  } catch (err) {
    if (err instanceof InvalidDoiError) {
      return {
        doi: rawDoi,
        record: null,
        failure: { code: "INVALID_DOI", message: `not a DOI: ${JSON.stringify(rawDoi)}` },
        mismatch: null,
      };
    }
    // Provider-layer failure (network down, unusable envelope): this DOI could
    // not be resolved; the rest of the batch still proceeds (R5 per-DOI rows).
    return { doi: rawDoi, record: null, failure: { code: "DOI_NOT_FOUND", message: `resolution failed for "${rawDoi}": ${reasonOf(err)}` }, mismatch: null };
  }
}

/**
 * Register a batch. Above the 50-DOI cap the WHOLE call refuses
 * (`BATCH_TOO_LARGE` — the caller's client policy, R19); within it, per-DOI
 * failures refuse that DOI only and the good DOIs still commit.
 */
export async function registerPapersTool(
  ctx: ToolContext,
  args: { dois: string[] },
): Promise<ToolResult<RegisterPapersStructured>> {
  if (args.dois.length > REGISTER_BATCH_MAX) {
    return refusalResult({
      code: "BATCH_TOO_LARGE",
      message: `${args.dois.length} DOIs exceed the ${REGISTER_BATCH_MAX}-DOI batch cap (client policy)`,
    });
  }
  const cfg = providerConfigOf(ctx);

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
    // Fetch phase: concurrent, outside the queue — no registry state touched.
    // Duplicate DOIs in one batch share a single resolve (one network round
    // trip per distinct DOI) while outcomes still assemble in input order.
    // Null prototype: DOI strings become bare lookup keys, nothing more.
    const resolves: Record<string, Promise<Resolved>> = Object.create(null);
    const resolveOnce = (doi: string): Promise<Resolved> =>
      (resolves[doi] ??= resolveDoi(ctx, cfg, doi));
    const resolved = await Promise.all(args.dois.map(resolveOnce));

    // Write phase: each DOI's transactional section through the FIFO queue in
    // call-arrival order; `Promise.all` of the queued sections reassembles the
    // results in the SAME order the calls arrived (KTD5).
    const settled = await Promise.all(
      resolved.map(
        (one): Promise<RegisterPapersStructured["outcomes"][number] & { rendered: RenderedWarning[] }> =>
          ctx.queue.runExclusive(async () => {
            if (one.failure !== null || one.record === null) {
              return {
                doi: one.doi,
                status: "refused" as const,
                citekey: null,
                citable: null,
                refusalCode: one.failure?.code ?? "DOI_NOT_FOUND",
                refusalMessage: one.failure?.message ?? `no provider knows "${one.doi}"`,
                warnings: [] as string[],
                rendered: [] as RenderedWarning[],
              };
            }
            try {
              const outcome: RegisterOutcome = registerPaper(
                db,
                {
                  // The registry record carries a definite DOI (registry
                  // identity); search-normalized records may leave it null.
                  doi: one.record.doi ?? one.doi,
                  title: one.record.title,
                  authors: one.record.authors,
                  year: one.record.year,
                  venue: one.record.venue,
                  bibtex: one.record.bibtex,
                  bibtexSource: one.record.citable ? one.record.provider : null,
                },
                { now: ctx.now },
              );
              const rendered: RenderedWarning[] = outcome.warnings.map((code) => ({
                code,
                message: `no provider-supplied BibTeX was available for ${outcome.citekey}`,
                next: WARNINGS[code as WarningCode].next,
              }));
              if (one.mismatch !== null) {
                rendered.push({
                  code: "DOI_TITLE_MISMATCH",
                  message: `OpenAlex and Crossref disagree on the title of ${one.doi}: "${one.mismatch}" vs "${one.record.title}"`,
                  next: WARNINGS.DOI_TITLE_MISMATCH.next,
                });
              }
              return {
                doi: one.doi,
                status: outcome.status,
                citekey: outcome.citekey,
                citable: outcome.citable,
                refusalCode: null,
                refusalMessage: null,
                warnings: rendered.map((warning) => warning.code),
                rendered,
              };
            } catch (err) {
              if (err instanceof RegistryError) {
                return {
                  doi: one.doi,
                  status: "refused" as const,
                  citekey: null,
                  citable: null,
                  refusalCode: err.code,
                  refusalMessage: err.message,
                  warnings: [] as string[],
                  rendered: [] as RenderedWarning[],
                };
              }
              throw err;
            }
          }),
      ),
    );

    const warnings: RenderedWarning[] = [];
    const outcomes: RegisterPapersStructured["outcomes"] = settled.map(({ rendered, ...outcome }) => {
      warnings.push(...rendered);
      return outcome;
    });

    const registered = outcomes.filter((outcome) => outcome.status !== "refused");
    return {
      content: [
        {
          type: "text",
          text:
            `${registered.length} of ${outcomes.length} DOI(s) committed` +
            (warnings.length > 0 ? ` — ${warnings.length} warning(s)` : ""),
        },
      ],
      structuredContent: { outcomes, warnings },
      details: { citekeyOrder: "input DOI order (KTD6)" },
    };
  } finally {
    db.close();
  }
}
