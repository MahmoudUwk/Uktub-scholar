/**
 * `search_passages`: exploratory retrieval over the registered papers for the writing agent. Hybrid
 * FTS5 + vector search (lexical alone when no embedder is configured or it fails) over the SAME chunks
 * claim verification judges, returned as bounded passages with exact `doi@revision#start-end`
 * pointers, section labels and pages. Output containment is the evidence rule: a passage that is half
 * its source or longer than the excerpt cap, and text past a source's per-call release budget, is
 * withheld with its reason — the pointer is always kept. Results are retrieval, not verification:
 * a cited claim still goes through `verify_claim`.
 */

import { Type, type Static } from "typebox";

import { ConfigError, loadChunkConfig } from "../config.ts";
import { embedderFromEnv } from "../embed/config.ts";
import { EmbedError, type Embedder } from "../embed/embedder.ts";
import { searchPassages } from "../rag/search.ts";
import { RegistryError, openRegistry } from "../registry.ts";
import { clipLabel } from "../sections.ts";
import { containEvidence, type SupportedPassage } from "../verify/evidence.ts";
import { locatorTokens } from "../verify/retrieve.ts";
import { resolveScope } from "../verify/scope.ts";
import { ensureChunks, formatPointer, getSource } from "../verify/store.ts";
import { busyRefusal, refusalResult, type ToolContext, type ToolResult } from "./context.ts";
import { MAX_QUERY_CHARS, MAX_SCOPE_IDS } from "./verify.ts";

/** Client policy: passages per call — a screenful the agent can read, under one tool payload. */
export const MAX_SEARCH_HITS = 10;
export const DEFAULT_SEARCH_HITS = 5;

export const SearchPassagesParams = Type.Object({
  query: Type.String({ minLength: 1, maxLength: MAX_QUERY_CHARS, description: "What to look for: a topic, question or phrase. Natural language is fine; this is retrieval, not verification" }),
  papers: Type.Optional(
    Type.Union([Type.Literal("all"), Type.Array(Type.String(), { minItems: 1, maxItems: MAX_SCOPE_IDS })], {
      description: `Scope: "all" registered papers (default), or a list of DOIs/citekeys (at most ${MAX_SCOPE_IDS}); an empty list is refused, never read as all`,
    }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_HITS, description: `Passages to return (default ${DEFAULT_SEARCH_HITS}, at most ${MAX_SEARCH_HITS})` })),
});
export type SearchPassagesArgs = Static<typeof SearchPassagesParams>;

const Nullable = <T extends ReturnType<typeof Type.String> | ReturnType<typeof Type.Integer>>(t: T) => Type.Union([t, Type.Null()]);

export const SearchPassagesOutput = Type.Object({
  query: Type.String(),
  mode: Type.Union([Type.Literal("hybrid"), Type.Literal("lexical")]),
  result: Type.Object({ found: Type.Boolean(), limitations: Type.Array(Type.String()) }),
  coverage: Type.Object({
    papers: Type.Object({
      selected: Type.Integer(),
      searchable: Type.Integer(),
      notSearchable: Type.Array(Type.Object({ doi: Type.String(), citekey: Type.String(), reason: Type.String() })),
      unresolved: Type.Array(Type.String()),
    }),
  }),
  hits: Type.Array(
    Type.Object({
      rank: Type.Integer(),
      doi: Type.String(),
      citekey: Type.String(),
      pointer: Type.String(),
      section: Nullable(Type.String()),
      page: Nullable(Type.Integer()),
      found: Type.Array(Type.String()),
      excerpt: Nullable(Type.String()),
      withheld: Nullable(Type.String()),
    }),
  ),
});
export type SearchPassagesStructured = Static<typeof SearchPassagesOutput>;

export interface PassagesHooks {
  /** Test seam: the embedder to use instead of building one from the environment. */
  createEmbedder?: () => Embedder | null;
}

const invalid = (message: string) => refusalResult({ code: "ARGUMENT_INVALID", message });

export async function searchPassagesTool(ctx: ToolContext, args: SearchPassagesArgs, hooks: PassagesHooks = {}): Promise<ToolResult<SearchPassagesStructured>> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query.length === 0 || query.length > MAX_QUERY_CHARS) return invalid(`query must be 1–${MAX_QUERY_CHARS} characters`);
  if (locatorTokens(query).length === 0) return invalid("the query has no searchable words; use words or numbers");
  if (args.papers !== undefined && args.papers !== "all") {
    if (!Array.isArray(args.papers) || args.papers.length === 0 || args.papers.some((h) => typeof h !== "string")) {
      return invalid('papers must be "all" or a non-empty list of DOIs/citekeys; an empty list is never read as all');
    }
    if (args.papers.length > MAX_SCOPE_IDS) return refusalResult({ code: "BATCH_TOO_LARGE", message: `${args.papers.length} papers exceed the ${MAX_SCOPE_IDS}-paper scope cap (client policy); use "all" or split` });
  }
  const limit = args.limit ?? DEFAULT_SEARCH_HITS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_HITS) return invalid(`limit must be an integer from 1 to ${MAX_SEARCH_HITS}`);

  let cfg;
  try {
    cfg = loadChunkConfig(ctx.root, { env: ctx.env });
  } catch (err) {
    if (err instanceof ConfigError) return refusalResult({ code: "CONFIG_INVALID", message: err.message });
    throw err;
  }
  // Embedder configuration is validated before any work: a typo must be refused, never silently ignored.
  const limitations: string[] = [];
  let embedder: Embedder | null = null;
  try {
    embedder = hooks.createEmbedder !== undefined ? hooks.createEmbedder() : await embedderFromEnv(ctx.env, ctx.fetch, ctx.signal);
  } catch (err) {
    if (err instanceof ConfigError) return refusalResult({ code: "CONFIG_INVALID", message: err.message });
    if (!(err instanceof EmbedError)) throw err;
    limitations.push(`vector search unavailable (${err.message}); lexical results only`);
  }

  let db;
  try {
    db = openRegistry(ctx.root);
  } catch (err) {
    if (err instanceof RegistryError) return refusalResult({ code: err.code, message: err.message });
    throw err;
  }
  try {
    const { selected, unresolved } = resolveScope(db, args.papers ?? "all");
    const searchable: string[] = [];
    const notSearchable: { doi: string; citekey: string; reason: string }[] = [];
    for (const p of selected) {
      const src = getSource(db, p.doi);
      if (src === null || src.status !== "ready") {
        notSearchable.push({ doi: p.doi, citekey: p.citekey, reason: src === null ? "metadata_only" : (src.failureCode ?? src.status) });
        continue;
      }
      await ctx.queue.runExclusive(() => ensureChunks(db, p.doi, cfg.chunking));
      searchable.push(p.doi);
    }

    const found = searchable.length === 0 ? null : await searchPassages(db, { query, dois: searchable, limit, embedder, now: ctx.now(), signal: ctx.signal });
    // Overlapping chunks (fixed-window policies carry overlap) add nothing beyond the better-ranked one: drop them here, so
    // containment never has to guess and every returned pointer is distinct text.
    const hits: NonNullable<typeof found>["hits"] = [];
    for (const h of found?.hits ?? []) if (!hits.some((k) => k.doi === h.doi && h.start < k.end && k.start < h.end)) hits.push(h);
    const length = new Map(selected.map((p) => [p.doi, getSource(db, p.doi)?.textLength ?? 0]));
    // Containment decides in rank order (rank-derived strength), output keeps rank order.
    const passages: SupportedPassage[] = hits.map((h, i) => ({
      doi: h.doi, citekey: h.citekey, revision: h.revision, chunkId: "", start: h.start, end: h.end, page: h.page, pTrue: (hits.length - i) / (hits.length + 1), text: h.text,
    }));
    const contained = new Map(containEvidence(passages, (doi) => length.get(doi) ?? 0, new Map(), "strength").map((c) => [`${c.doi}#${c.start}-${c.end}`, c]));
    const structured: SearchPassagesStructured = {
      query,
      mode: found?.mode ?? "lexical",
      result: { found: hits.length > 0, limitations: [...limitations, ...(found?.limitations ?? [])] },
      coverage: { papers: { selected: selected.length, searchable: searchable.length, notSearchable, unresolved: unresolved.map((u) => u.handle) } },
      hits: hits.map((h, i) => {
        const c = contained.get(`${h.doi}#${h.start}-${h.end}`);
        return {
          rank: i + 1,
          doi: h.doi,
          citekey: h.citekey,
          pointer: formatPointer(h.doi, h.revision, h.start, h.end),
          section: h.section === null || h.section === "" ? null : clipLabel(h.section),
          page: h.page,
          found: h.found,
          excerpt: c!.excerpt,
          withheld: c!.withheld,
        };
      }),
    };
    return { content: [{ type: "text", text: render(structured) }], structuredContent: structured, details: { mode: structured.mode } };
  } catch (err) {
    const busy = busyRefusal(err);
    if (busy !== null) return busy;
    throw err;
  } finally {
    db.close();
  }
}

function render(s: SearchPassagesStructured): string {
  const p = s.coverage.papers;
  const lines: string[] = [];
  if (p.selected === 0) lines.push(p.unresolved.length > 0 ? "NO PASSAGES: none of the named papers is registered." : "NO PASSAGES: there are no registered papers to search. Register papers with paper_registry first.");
  else if (p.searchable === 0) lines.push("NO PASSAGES: no selected paper has a usable source (no searchable text yet). Attach or acquire sources first.");
  else if (s.hits.length === 0) lines.push(`NO PASSAGES matched in ${p.searchable} paper(s) (${s.mode} search). Try different words; no match is not evidence that a paper is silent on the topic.`);
  else lines.push(`${s.hits.length} PASSAGE(S) from ${new Set(s.hits.map((h) => h.doi)).size} paper(s) for "${s.query}" (${s.mode} search, best first). These are retrieval results, not verification: check a claim with verify_claim before citing it.`);
  for (const l of s.result.limitations) lines.push(`limitation: ${l}`);
  for (const n of p.notSearchable) lines.push(`not searchable: ${n.citekey} (${n.doi}) — ${n.reason}`);
  for (const u of p.unresolved) lines.push(`not registered: ${u}`);
  for (const h of s.hits) {
    lines.push("");
    lines.push(`${h.rank}. ${h.citekey} (${h.doi})${h.section !== null ? ` — ${h.section}` : ""}${h.page !== null ? `, p. ${h.page}` : ""}`);
    lines.push(`   pointer: ${h.pointer}`);
    lines.push(h.excerpt !== null ? `   excerpt: ${JSON.stringify(h.excerpt)}` : `   excerpt withheld (${h.withheld}): quote nothing from this passage; the pointer still identifies it`);
  }
  return lines.join("\n");
}
