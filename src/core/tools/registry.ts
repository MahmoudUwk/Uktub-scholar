/**
 * `paper_registry` (R1–R6): the one tool that manages the project's paper
 * collection — batch registration, batch removal, projected reads, local
 * source attachment and bibliography synchronisation — over the canonical
 * SQLite registry. Every action composes the existing transactional core
 * (`registerPaper`, `deregisterPapers`, `publishSource`, `syncBibliography`);
 * there is no parallel store and no generic patch interface.
 *
 * Response contract: the model reads ONLY the text content, so identities,
 * outcomes, requested fields and continuation tokens are rendered there; the
 * structured copy mirrors it. No response surface ever carries source text
 * (R5): attachment and read report readiness, revision and counts, nothing else.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Type, type Static } from "typebox";

import { loadChunkConfig, ConfigError } from "../config.ts";
import {
  RegistryError,
  countPapers,
  deregisterPapers,
  generationOf,
  openRegistry,
  registerPaper,
  resolveHandle,
  selectPapers,
  syncBibliography,
  type PaperDetail,
} from "../registry.ts";
import { InvalidDoiError, fetchPaperMetadata, normalizeDoiQuery, reasonOf } from "../scholarly.ts";
import { fetchWithRetry, plainText, retryOpts } from "../providers/http.ts";
import type { PaperRecord, ProviderConfig } from "../providers/types.ts";
import { REFUSALS, WARNINGS, type RefusalCode, type WarningCode } from "../refusals.ts";
import { MAX_SOURCE_BYTES, SourceError } from "../source/extract.ts";
import { prepareFromBytes } from "../source/prepare.ts";
import { isAcquiring, prepareSources, type SourceReport } from "../verify/acquire.ts";
import { getSource, publishSource, recordSourceFailure, type SourceRow } from "../verify/store.ts";
import { providerConfigOf, refusalResult, resolveProjectFile, type RenderedWarning, type ToolContext, type ToolResult } from "./context.ts";

export const REGISTRY_ACTIONS = ["register", "remove", "read", "attach_source", "sync_bibliography", "acquire"] as const;
export const READ_FIELDS = ["title", "year", "citable", "authors", "venue", "bibtex", "bibtexSource", "abstract", "source", "refreshedAt"] as const;
type ReadField = (typeof READ_FIELDS)[number];

/** Client policy: bounded tool payloads. 50 DOIs per registration call
 *  (provider courtesy, from the Feynman payload incident); removal and read
 *  follow the same unit. */
export const REGISTER_BATCH_MAX = 50;
export const REMOVE_BATCH_MAX = 50;
/** Client policy: each attachment parses a whole document (CPU-bound). */
export const ATTACH_BATCH_MAX = 10;
/** Client policy: one read page stays near 60 KB — 100 compact rows, or 25
 *  rows when an abstract or BibTeX entry rides along. */
export const READ_PAGE_DEFAULT = 50;
export const READ_PAGE_MAX_LIGHT = 100;
export const READ_PAGE_MAX_HEAVY = 25;
/** Client policy: per-record caps on provider-origin text in a read. */
export const ABSTRACT_MAX_CHARS = 1_500;
export const BIBTEX_MAX_CHARS = 2_000;

export const PaperRegistryParams = Type.Object({
  action: Type.Union(REGISTRY_ACTIONS.map((a) => Type.Literal(a)), {
    description: "register | remove | read | attach_source | sync_bibliography | acquire",
  }),
  identifiers: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: REGISTER_BATCH_MAX,
      description: `register: DOIs (10.xxxx/suffix, doi: or doi.org forms) or arxiv:YYMM.NNNNN; at most ${REGISTER_BATCH_MAX}`,
    }),
  ),
  handles: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: REMOVE_BATCH_MAX,
      description: `remove: DOIs or citekeys to delete (required, never "all"); read: restrict to these papers (omit for every paper); acquire: papers to fetch an open-access source for (omit for every paper without a source); at most ${REMOVE_BATCH_MAX}`,
    }),
  ),
  fields: Type.Optional(
    Type.Array(Type.String(), { description: `read: fields to return besides doi and citekey; default title, year, citable. Allowed: ${READ_FIELDS.join(", ")}` }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: `read: page size (default ${READ_PAGE_DEFAULT}; at most ${READ_PAGE_MAX_LIGHT}, or ${READ_PAGE_MAX_HEAVY} with abstract/bibtex)` })),
  cursor: Type.Optional(Type.String({ description: "read: continuation token from the previous page of the same request" })),
  attachments: Type.Optional(
    Type.Array(Type.Object({ handle: Type.String({ description: "DOI or citekey of a registered paper" }), path: Type.String({ description: "PDF or GROBID TEI file inside the project" }) }), {
      maxItems: ATTACH_BATCH_MAX,
      description: `attach_source: local files to prepare as these papers' sources; at most ${ATTACH_BATCH_MAX}`,
    }),
  ),
});
export type PaperRegistryArgs = Static<typeof PaperRegistryParams>;

const Nullable = <T extends ReturnType<typeof Type.String> | ReturnType<typeof Type.Boolean> | ReturnType<typeof Type.Integer>>(t: T) => Type.Union([t, Type.Null()]);

const OutcomeSchema = Type.Object({
  index: Type.Integer(),
  input: Type.String(),
  status: Type.String(),
  doi: Nullable(Type.String()),
  citekey: Nullable(Type.String()),
  citable: Nullable(Type.Boolean()),
  duplicateOf: Nullable(Type.Integer()),
  refusalCode: Nullable(Type.String()),
  refusalMessage: Nullable(Type.String()),
  refusalNext: Nullable(Type.String()),
  warnings: Type.Array(Type.String()),
  source: Type.Union([
    Type.Object({
      status: Type.String(),
      revision: Nullable(Type.String()),
      kind: Type.Optional(Nullable(Type.String())),
      failureDetail: Type.Optional(Nullable(Type.String())),
      reused: Type.Optional(Type.Boolean()),
      failureCode: Type.Optional(Nullable(Type.String())),
      characters: Type.Optional(Type.Integer()),
      pages: Type.Optional(Nullable(Type.Integer())),
      chunks: Type.Optional(Type.Integer()),
    }),
    Type.Null(),
  ]),
});

export const PaperRegistryOutput = Type.Object({
  action: Type.String(),
  outcomes: Type.Optional(Type.Array(OutcomeSchema)),
  warnings: Type.Optional(Type.Array(Type.Object({ code: Type.String(), message: Type.String(), next: Type.String() }))),
  records: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
  total: Type.Optional(Type.Integer()),
  nextCursor: Type.Optional(Nullable(Type.String())),
  unresolved: Type.Optional(Type.Array(Type.Object({ handle: Type.String(), reason: Type.String() }))),
  synced: Type.Optional(Type.Integer()),
});
/** Loose on purpose: the shape depends on the action; `PaperRegistryOutput` validates it. */
export type PaperRegistryStructured = Record<string, any>;
type Outcome = Static<typeof OutcomeSchema>;

const invalid = (message: string) => refusalResult({ code: "ARGUMENT_INVALID", message });

/** Which arguments each action accepts; anything else is refused, not ignored. */
const ACCEPTS: Record<(typeof REGISTRY_ACTIONS)[number], readonly (keyof PaperRegistryArgs)[]> = {
  register: ["identifiers"],
  remove: ["handles"],
  read: ["handles", "fields", "limit", "cursor"],
  attach_source: ["attachments"],
  sync_bibliography: [],
  acquire: ["handles"],
};

export async function paperRegistryTool(ctx: ToolContext, args: PaperRegistryArgs): Promise<ToolResult<PaperRegistryStructured>> {
  const action = args.action as string;
  if (!(REGISTRY_ACTIONS as readonly string[]).includes(action)) {
    return invalid(`unknown action ${JSON.stringify(action)}; use one of ${REGISTRY_ACTIONS.join(", ")}`);
  }
  const accepted = ACCEPTS[action as keyof typeof ACCEPTS];
  for (const key of Object.keys(args) as (keyof PaperRegistryArgs)[]) {
    if (key === "action" || args[key] === undefined) continue;
    if (!accepted.includes(key)) return invalid(`"${key}" does not apply to action ${action}; ${action} accepts ${accepted.length === 0 ? "no arguments" : accepted.join(", ")}`);
  }

  let db: DatabaseSync;
  try {
    db = openRegistry(ctx.root);
  } catch (err) {
    if (err instanceof RegistryError) return refusalResult({ code: err.code, message: err.message });
    throw err;
  }
  try {
    switch (action) {
      case "register":
        return await registerAction(ctx, db, args.identifiers);
      case "remove":
        return await removeAction(ctx, db, args.handles);
      case "read":
        return readAction(db, args);
      case "attach_source":
        return await attachAction(ctx, db, args.attachments);
      case "acquire":
        return await acquireAction(ctx, db, args.handles);
      default:
        return await syncAction(ctx, db);
    }
  } finally {
    db.close();
  }
}

const refusedOutcome = (index: number, input: string, code: RefusalCode, message: string): Outcome => ({
  index,
  input,
  status: "refused",
  doi: null,
  citekey: null,
  citable: null,
  duplicateOf: null,
  refusalCode: code,
  refusalMessage: message,
  refusalNext: REFUSALS[code].next,
  warnings: [],
  source: null,
});

function outcomeLine(o: Outcome): string {
  const id = `${o.citekey ?? "-"} ${o.doi ?? ""}`.trim();
  switch (o.status) {
    case "refused":
      return `[${o.index}] refused ${o.refusalCode} — ${o.refusalMessage}. Next: ${o.refusalNext}`;
    case "duplicate":
      return `[${o.index}] duplicate of [${o.duplicateOf}] ${o.refusalCode ? `(${o.refusalCode})` : id}`;
    case "absent":
      return `[${o.index}] absent ${o.input} — no registered paper has this DOI or citekey`;
    case "attached": {
      const s = o.source;
      return `[${o.index}] attached ${id} — source ready, revision ${s?.revision}${s?.reused ? " (unchanged, reused)" : ""}, ${s?.characters ?? 0} characters, ${s?.pages ?? "no"} pages, ${s?.chunks ?? 0} passages`;
    }
    default:
      return `[${o.index}] ${o.status} ${id}${o.citable === false ? " [uncitable]" : ""}`;
  }
}

function summarize(action: string, outcomes: Outcome[]): string {
  const counts = new Map<string, number>();
  for (const o of outcomes) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
  return `${action}: ${outcomes.length} input(s) — ${[...counts].map(([k, v]) => `${v} ${k}`).join(", ")}`;
}

// ── register ───────────────────────────────────────────────────────────────

interface Resolved {
  record: PaperRecord | null;
  failure: { code: RefusalCode; message: string } | null;
  mismatch: string | null;
}

/** Cross-provider title cross-check: OpenAlex and Crossref must agree on what the DOI names. Best-effort. */
async function crossCheckTitle(ctx: ToolContext, cfg: ProviderConfig, doi: string, crossrefTitle: string): Promise<string | null> {
  try {
    const url = `${cfg.openalexBaseUrl}/works/${encodeURIComponent(`https://doi.org/${doi}`)}` + (cfg.openalexApiKey ? `?api_key=${encodeURIComponent(cfg.openalexApiKey)}` : "");
    const response = await fetchWithRetry(ctx.fetch, url, retryOpts(cfg));
    if (response.status !== 200) return null;
    const body: unknown = JSON.parse(response.body);
    if (typeof body !== "object" || body === null) return null;
    const raw = (body as Record<string, unknown>)["title"];
    const title = typeof raw === "string" ? plainText(raw) : null;
    if (title === null || title.length === 0 || crossrefTitle.length === 0) return null;
    const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
    return normalize(title) !== normalize(crossrefTitle) ? title : null;
  } catch {
    return null; // registration never depends on the check
  }
}

async function resolveCanonical(ctx: ToolContext, cfg: ProviderConfig, doi: string): Promise<Resolved> {
  try {
    const record = await fetchPaperMetadata(ctx.fetch, cfg, { doi });
    if (record === null) return { record: null, failure: { code: "DOI_NOT_FOUND", message: `no provider knows "${doi}"` }, mismatch: null };
    return { record, failure: null, mismatch: await crossCheckTitle(ctx, cfg, record.doi ?? doi, record.title) };
  } catch (err) {
    if (err instanceof InvalidDoiError) return { record: null, failure: { code: "INVALID_DOI", message: `not a DOI: ${JSON.stringify(doi)}` }, mismatch: null };
    return { record: null, failure: { code: "SEARCH_UNAVAILABLE", message: `resolution failed for "${doi}": ${reasonOf(err)}` }, mismatch: null };
  }
}

async function registerAction(ctx: ToolContext, db: DatabaseSync, identifiers: string[] | undefined): Promise<ToolResult<PaperRegistryStructured>> {
  if (identifiers === undefined || identifiers.length === 0) return invalid("register needs a non-empty `identifiers` list (DOIs or arxiv:YYMM.NNNNN)");
  if (identifiers.length > REGISTER_BATCH_MAX) {
    return refusalResult({ code: "BATCH_TOO_LARGE", message: `${identifiers.length} identifiers exceed the ${REGISTER_BATCH_MAX}-identifier batch cap (client policy)` });
  }
  const cfg = providerConfigOf(ctx);

  // Normalise aliases BEFORE any shared work: one canonical DOI = one resolve = one commit.
  const canonical = identifiers.map((raw) => (typeof raw === "string" ? normalizeDoiQuery(raw) : null));
  const firstIndex = new Map<string, number>();
  canonical.forEach((doi, i) => {
    if (doi !== null && !firstIndex.has(doi)) firstIndex.set(doi, i);
  });
  const resolves = new Map<string, Promise<Resolved>>();
  for (const doi of firstIndex.keys()) resolves.set(doi, resolveCanonical(ctx, cfg, doi));

  const results = new Map<string, Outcome & { rendered: RenderedWarning[] }>();
  let rawError: unknown = null;
  await Promise.all(
    [...firstIndex].map(async ([doi, index]) => {
      const one = await resolves.get(doi)!;
      try {
        const outcome = await ctx.queue.runExclusive((): Outcome & { rendered: RenderedWarning[] } => {
          if (one.failure !== null || one.record === null) {
            const code = (one.failure?.code ?? "DOI_NOT_FOUND") as RefusalCode;
            return { ...refusedOutcome(index, identifiers[index], code, one.failure?.message ?? `no provider knows "${doi}"`), doi, rendered: [] };
          }
          try {
            const reg = registerPaper(
              db,
              {
                doi: one.record.doi ?? doi,
                title: one.record.title,
                authors: one.record.authors,
                year: one.record.year,
                venue: one.record.venue,
                bibtex: one.record.bibtex,
                bibtexSource: one.record.citable ? one.record.provider : null,
                abstract: one.record.abstract,
                abstractSource: one.record.provider,
              },
              { now: ctx.now },
            );
            const rendered: RenderedWarning[] = reg.warnings.map((code) => ({
              code,
              message: `no provider-supplied BibTeX was available for ${reg.citekey}`,
              next: WARNINGS[code as WarningCode].next,
            }));
            if (one.mismatch !== null) {
              rendered.push({
                code: "DOI_TITLE_MISMATCH",
                message: `OpenAlex and Crossref disagree on the title of ${doi}: "${one.mismatch}" vs "${one.record.title}"`,
                next: WARNINGS.DOI_TITLE_MISMATCH.next,
              });
            }
            return {
              index, input: identifiers[index], status: reg.status, doi: reg.doi, citekey: reg.citekey, citable: reg.citable, duplicateOf: null,
              refusalCode: null, refusalMessage: null, refusalNext: null, warnings: rendered.map((w) => w.code), source: null, rendered,
            };
          } catch (err) {
            if (err instanceof RegistryError) return { ...refusedOutcome(index, identifiers[index], err.code, err.message), doi, rendered: [] };
            throw err;
          }
        });
        results.set(doi, outcome);
      } catch (err) {
        rawError ??= err; // drain the queue first; rethrow once every section finished
      }
    }),
  );
  if (rawError !== null) throw rawError;

  const warnings: RenderedWarning[] = [];
  const outcomes: Outcome[] = identifiers.map((input, index) => {
    const doi = canonical[index];
    if (doi === null) return refusedOutcome(index, input, "INVALID_DOI", `not a DOI or arXiv identifier: ${JSON.stringify(input)}`);
    const first = results.get(doi)!;
    if (firstIndex.get(doi) === index) {
      const { rendered, ...rest } = first;
      warnings.push(...rendered);
      return rest;
    }
    return { ...first, index, input, status: "duplicate", duplicateOf: firstIndex.get(doi)!, warnings: [], rendered: undefined } as Outcome;
  });
  // Typed source status of what was just registered, and the hook: acquisition starts in the background where the host supports it.
  const toAcquire: string[] = [];
  for (const o of outcomes) {
    if ((o.status !== "registered" && o.status !== "updated") || o.doi === null) continue;
    const src = getSource(db, o.doi);
    if (src?.status === "ready") o.source = { status: "ready", revision: src.revision, kind: src.kind };
    else if (ctx.afterRegister !== undefined) {
      o.source = { status: "acquiring", revision: null };
      toAcquire.push(o.doi);
    } else o.source = { status: src?.status ?? "metadata_only", revision: null };
  }
  if (toAcquire.length > 0) {
    try {
      ctx.afterRegister?.(toAcquire);
    } catch {
      // The hook only improves the next call; it can never fail a committed registration.
    }
  }
  const lines = [summarize("register", outcomes), ...outcomes.map(outcomeLine), ...warnings.map((w) => `warning ${w.code}: ${w.message}. Next: ${w.next}`)];
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { action: "register", outcomes, warnings }, details: { order: "input order" } };
}

// ── remove ─────────────────────────────────────────────────────────────────

async function removeAction(ctx: ToolContext, db: DatabaseSync, handles: string[] | undefined): Promise<ToolResult<PaperRegistryStructured>> {
  if (handles === undefined || handles.length === 0) return invalid("remove needs an explicit non-empty `handles` list of DOIs or citekeys; there is no remove-all");
  if (handles.length > REMOVE_BATCH_MAX) {
    return refusalResult({ code: "BATCH_TOO_LARGE", message: `${handles.length} handles exceed the ${REMOVE_BATCH_MAX}-handle batch cap (client policy)` });
  }
  const result = await ctx.queue.runExclusive(() => deregisterPapers(db, handles));
  const outcomes: Outcome[] = result.outcomes.map((o, index) => ({
    index, input: o.input, status: o.status, doi: o.doi, citekey: o.citekey, citable: null, duplicateOf: o.duplicateOf,
    refusalCode: o.status === "refused" ? "ARGUMENT_INVALID" : null,
    refusalMessage: o.status === "refused" ? "a blank handle names no paper" : null,
    refusalNext: o.status === "refused" ? REFUSALS.ARGUMENT_INVALID.next : null,
    warnings: [], source: null,
  }));
  return {
    content: [{ type: "text", text: [summarize("remove", outcomes), ...outcomes.map(outcomeLine), `${result.removed.length} paper(s) removed; refs/references.bib re-rendered`].join("\n") }],
    structuredContent: { action: "remove", outcomes },
    details: {},
  };
}

// ── acquire ─────────────────────────────────────────────────────────────────

/** Fetch an open-access source for registered papers (explicit form of what `verify_claim` does on demand and the registration hook does in the background). */
async function acquireAction(ctx: ToolContext, db: DatabaseSync, handles: string[] | undefined): Promise<ToolResult<PaperRegistryStructured>> {
  if (handles !== undefined && handles.length === 0) return invalid("`handles` is empty; omit it to acquire every paper that has no source");
  if (handles !== undefined && handles.length > REMOVE_BATCH_MAX) {
    return refusalResult({ code: "BATCH_TOO_LARGE", message: `${handles.length} handles exceed the ${REMOVE_BATCH_MAX}-handle batch cap (client policy)` });
  }
  let cfg;
  try {
    cfg = loadChunkConfig(ctx.root, { env: ctx.env });
  } catch (err) {
    if (err instanceof ConfigError) return refusalResult({ code: "CONFIG_INVALID", message: err.message });
    throw err;
  }
  type Target = { index: number; input: string; paper: { doi: string; citekey: string; title: string } | null };
  const targets: Target[] = [];
  if (handles === undefined) {
    selectPapers(db, { limit: 1_000_000 }).filter((p) => getSource(db, p.doi)?.status !== "ready").forEach((p, i) => targets.push({ index: i, input: p.doi, paper: { doi: p.doi, citekey: p.citekey, title: p.title } }));
  } else {
    handles.forEach((h, i) => {
      const row = resolveHandle(db, h);
      targets.push({ index: i, input: h, paper: row === null ? null : { doi: row.doi, citekey: row.citekey, title: row.title } });
    });
  }
  const report: SourceReport = [];
  const seen = new Set<string>();
  await prepareSources(ctx, db, targets.flatMap((t) => (t.paper !== null && !seen.has(t.paper.doi) && seen.add(t.paper.doi) ? [{ ...t.paper, citable: true }] : [])), cfg, report);
  const outcomes: Outcome[] = targets.map((t) => {
    const base = { index: t.index, input: t.input, doi: t.paper?.doi ?? null, citekey: t.paper?.citekey ?? null, citable: null, duplicateOf: null, refusalCode: null, refusalMessage: null, refusalNext: null, warnings: [] as string[] };
    if (t.paper === null) return { ...base, status: "absent", source: null };
    const src = getSource(db, t.paper.doi);
    const rep = report.find((r) => r.doi === t.paper!.doi);
    if (src?.status === "ready") return { ...base, status: "ready", source: { status: "ready", revision: src.revision, kind: src.kind } };
    const status = rep?.code === "deferred" ? "deferred" : (src?.status ?? rep?.status ?? "metadata_only");
    return { ...base, status, source: { status: src?.status ?? rep?.status ?? "metadata_only", revision: null, failureCode: rep?.code ?? src?.failureCode ?? null, failureDetail: rep?.detail ?? src?.failureDetail ?? null } };
  });
  const counts = new Map<string, number>();
  for (const o of outcomes) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
  const lines = [
    `acquire: ${outcomes.length} paper(s) — ${[...counts].map(([k, v]) => `${v} ${k}`).join(", ") || "nothing to do"}`,
    ...outcomes.map((o) => {
      const id = `${o.citekey ?? "-"} ${o.doi ?? ""}`.trim();
      if (o.status === "absent") return `[${o.index}] absent ${o.input} — no registered paper has this DOI or citekey`;
      if (o.status === "ready") return `[${o.index}] ready ${id} via ${o.source?.kind ?? "?"}`;
      return `[${o.index}] ${o.status} ${o.source?.failureCode ?? ""} ${id}${o.source?.failureDetail ? ` — ${o.source.failureDetail}` : ""}`.replace(/\s+/g, " ");
    }),
  ];
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { action: "acquire", outcomes }, details: { order: handles === undefined ? "papers without a source" : "input order" } };
}

// ── read ───────────────────────────────────────────────────────────────────

const digest = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** The workspace root of an open registry handle (the directory holding `.registry/`). */
const rootOf = (db: DatabaseSync): string => resolve(dirname(db.location() ?? ""), "..");

function sourceView(row: SourceRow | null, acquiring = false): Record<string, unknown> {
  if (row?.status === "ready") {
    return { status: "ready", kind: row.kind, ref: row.ref, revision: row.revision, license: row.license, extraction: row.extraction, preparedAt: row.preparedAt };
  }
  if (acquiring) return { status: "acquiring" };
  if (row === null) return { status: "metadata_only" };
  return { status: row.status, failureCode: row.failureCode, failureDetail: row.failureDetail, preparedAt: row.preparedAt };
}

function project(db: DatabaseSync, p: PaperDetail, fields: ReadField[]): Record<string, unknown> {
  const rec: Record<string, unknown> = { doi: p.doi, citekey: p.citekey };
  for (const f of fields) {
    switch (f) {
      case "title": rec.title = p.title; break;
      case "year": rec.year = p.year; break;
      case "citable": rec.citable = p.citable; break;
      case "authors": rec.authors = p.authors; break;
      case "venue": rec.venue = p.venue; break;
      case "bibtexSource": rec.bibtexSource = p.bibtexSource; break;
      case "refreshedAt": rec.refreshedAt = p.ingestedAt; break;
      case "bibtex":
        if (p.providerBibtex !== null && p.providerBibtex.length > BIBTEX_MAX_CHARS) {
          rec.bibtex = p.providerBibtex.slice(0, BIBTEX_MAX_CHARS);
          rec.bibtexTruncated = true;
        } else rec.bibtex = p.providerBibtex;
        break;
      case "abstract":
        rec.abstract =
          p.abstract === null
            ? { kind: "unavailable" }
            : { kind: "provider_abstract", provider: p.abstractSource, text: p.abstract.slice(0, ABSTRACT_MAX_CHARS), truncated: p.abstract.length > ABSTRACT_MAX_CHARS };
        break;
      case "source": rec.source = sourceView(getSource(db, p.doi), isAcquiring(rootOf(db), p.doi)); break;
    }
  }
  return rec;
}

function recordText(rec: Record<string, unknown>, fields: ReadField[]): string {
  const head = fields.includes("title") || fields.includes("year") || fields.includes("citable")
    ? `${rec.citekey} | ${rec.doi}${"title" in rec ? ` | ${rec.title}` : ""}${"year" in rec ? ` (${rec.year ?? "n.d."})` : ""}${rec.citable === false ? "  [uncitable]" : ""}`
    : `${rec.citekey} | ${rec.doi}`;
  const lines = [head];
  if ("authors" in rec) lines.push(`    authors: ${(rec.authors as string[]).join("; ") || "(none)"}`);
  if ("venue" in rec) lines.push(`    venue: ${rec.venue ?? "(none)"}`);
  if ("bibtexSource" in rec) lines.push(`    bibtex via: ${rec.bibtexSource ?? "(none — uncitable)"}`);
  if ("refreshedAt" in rec) lines.push(`    metadata refreshed: ${rec.refreshedAt}`);
  if ("abstract" in rec) {
    const a = rec.abstract as { kind: string; provider?: string; text?: string; truncated?: boolean };
    lines.push(a.kind === "unavailable" ? "    abstract: unavailable (no provider abstract stored)" : `    abstract (${a.provider}${a.truncated ? ", truncated" : ""}): ${a.text}`);
  }
  if ("source" in rec) {
    const s = rec.source as Record<string, unknown>;
    lines.push(
      s.status === "ready"
        ? `    source: ready via ${s.kind} (${s.ref}) revision ${s.revision}`
        : s.status === "metadata_only"
          ? "    source: metadata_only"
          : `    source: ${s.status} — ${s.failureCode}: ${s.failureDetail}`,
    );
  }
  if ("bibtex" in rec) lines.push(`    bibtex${rec.bibtexTruncated ? " (truncated)" : ""}: ${rec.bibtex ?? "(none)"}`);
  return lines.join("\n");
}

function readAction(db: DatabaseSync, args: PaperRegistryArgs): ToolResult<PaperRegistryStructured> {
  let fields: ReadField[] = ["title", "year", "citable"];
  if (args.fields !== undefined) {
    const unknown = args.fields.filter((f) => !(READ_FIELDS as readonly string[]).includes(f));
    if (unknown.length > 0) return invalid(`unsupported field(s) ${unknown.map((f) => JSON.stringify(f)).join(", ")}; allowed: ${READ_FIELDS.join(", ")}`);
    fields = [...new Set(args.fields)] as ReadField[];
  }
  const heavy = fields.includes("abstract") || fields.includes("bibtex");
  const pageMax = heavy ? READ_PAGE_MAX_HEAVY : READ_PAGE_MAX_LIGHT;
  const pageSize = Math.min(args.limit ?? READ_PAGE_DEFAULT, pageMax);

  // Selection: every paper, or exactly the resolved handles — never a fallback to all.
  let selected: string[] | undefined;
  const unresolved: { handle: string; reason: string }[] = [];
  if (args.handles !== undefined) {
    if (args.handles.length === 0) return invalid("`handles` is empty; omit it to read every paper");
    const set = new Set<string>();
    for (const h of args.handles) {
      const row = typeof h === "string" ? resolveHandle(db, h) : null;
      if (row === null) {
        if (!unresolved.some((u) => u.handle === h)) unresolved.push({ handle: h, reason: "not_registered" });
      } else set.add(row.doi);
    }
    selected = [...set].sort();
  }
  const selectionKey = selected === undefined ? "all" : selected.join(",");
  const generation = generationOf(db);
  const token = { v: 1, s: digest(selectionKey), f: digest([...fields].sort().join(",")), g: generation };

  let after: string | undefined;
  if (args.cursor !== undefined) {
    let parsed: { v?: number; s?: string; f?: string; g?: number; a?: string };
    try {
      parsed = JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8")) as typeof parsed;
    } catch {
      return refusalResult({ code: "CONTINUATION_INVALID", message: "the cursor is not a token this tool issued" });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return refusalResult({ code: "CONTINUATION_INVALID", message: "the cursor is not a token this tool issued" });
    if (parsed.v !== token.v || typeof parsed.a !== "string") return refusalResult({ code: "CONTINUATION_INVALID", message: "the cursor is not a token this tool issued" });
    if (parsed.s !== token.s || parsed.f !== token.f) return refusalResult({ code: "CONTINUATION_INVALID", message: "the cursor was issued for a different selection or field list" });
    if (parsed.g !== token.g) return refusalResult({ code: "CONTINUATION_INVALID", message: "the registry changed since the cursor was issued" });
    after = parsed.a;
  }

  const total = selected === undefined ? countPapers(db) : selected.length;
  const probe = selectPapers(db, { dois: selected, afterCitekey: after, limit: pageSize + 1 });
  const page = probe.slice(0, pageSize);
  const more = probe.length > pageSize;
  const records = page.map((p) => project(db, p, fields));
  const nextCursor = more ? Buffer.from(JSON.stringify({ ...token, a: page[page.length - 1].citekey })).toString("base64url") : null;

  const header =
    total === 0 && unresolved.length === 0
      ? "registry is empty — register papers with paper_registry action register"
      : `${total} paper${total === 1 ? "" : "s"} selected${selected === undefined ? " (whole registry)" : ""}; showing ${records.length}` +
        (more ? `; more remain — repeat the same request with cursor "${nextCursor}"` : "");
  const lines = [header, ...records.map((r) => recordText(r, fields))];
  if (unresolved.length > 0) lines.push(`unresolved handles (not registered): ${unresolved.map((u) => u.handle).join(", ")}`);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { action: "read", records, total, nextCursor, unresolved },
    details: { order: "citekey ASC", pageLimit: pageSize },
  };
}

// ── attach_source ──────────────────────────────────────────────────────────

async function attachAction(ctx: ToolContext, db: DatabaseSync, attachments: PaperRegistryArgs["attachments"]): Promise<ToolResult<PaperRegistryStructured>> {
  if (attachments === undefined || attachments.length === 0) return invalid("attach_source needs a non-empty `attachments` list of {handle, path}");
  if (attachments.length > ATTACH_BATCH_MAX) {
    return refusalResult({ code: "BATCH_TOO_LARGE", message: `${attachments.length} attachments exceed the ${ATTACH_BATCH_MAX}-file batch cap (client policy)` });
  }
  let chunkCfg;
  try {
    chunkCfg = loadChunkConfig(ctx.root, { env: ctx.env }).chunking;
  } catch (err) {
    if (err instanceof ConfigError) return refusalResult({ code: "CONFIG_INVALID", message: err.message });
    throw err;
  }
  const outcomes: Outcome[] = [];
  for (const [index, a] of attachments.entries()) {
    const input = `${a.handle} <- ${a.path}`;
    const paper = resolveHandle(db, a.handle);
    if (paper === null) {
      outcomes.push(refusedOutcome(index, input, "DOI_NOT_FOUND", `no registered paper has the DOI or citekey ${JSON.stringify(a.handle)}`));
      continue;
    }
    const file = resolveProjectFile(ctx.root, a.path, MAX_SOURCE_BYTES);
    if (!file.ok) {
      outcomes.push({ ...refusedOutcome(index, input, "PATH_REFUSED", file.message), doi: paper.doi, citekey: paper.citekey });
      continue;
    }
    try {
      const prepared = await prepareFromBytes({ bytes: new Uint8Array(readFileSync(file.abs)), kind: "local-file", ref: file.rel, paper });
      const published = await ctx.queue.runExclusive(() => publishSource(db, paper.doi, prepared, chunkCfg, ctx.now()));
      if (published === null) {
        outcomes.push(refusedOutcome(index, input, "DOI_NOT_FOUND", `${paper.doi} was removed while its source was prepared`));
        continue;
      }
      outcomes.push({
        index, input, status: "attached", doi: paper.doi, citekey: paper.citekey, citable: null, duplicateOf: null,
        refusalCode: null, refusalMessage: null, refusalNext: null, warnings: [],
        source: { status: "ready", revision: published.revision, reused: published.reused, characters: prepared.text.length, pages: prepared.pageStarts?.length ?? null, chunks: published.chunkCount },
      });
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      await ctx.queue.runExclusive(() => recordSourceFailure(db, paper.doi, "failed", err.code, err.message, ctx.now(), "local-file"));
      outcomes.push({ ...refusedOutcome(index, input, "SOURCE_UNUSABLE", `${err.code}: ${err.message}`), doi: paper.doi, citekey: paper.citekey, source: { status: "failed", revision: null, failureCode: err.code } });
    }
  }
  return { content: [{ type: "text", text: [summarize("attach_source", outcomes), ...outcomes.map(outcomeLine)].join("\n") }], structuredContent: { action: "attach_source", outcomes }, details: {} };
}

// ── sync_bibliography ──────────────────────────────────────────────────────

async function syncAction(ctx: ToolContext, db: DatabaseSync): Promise<ToolResult<PaperRegistryStructured>> {
  const { syncedCount } = await ctx.queue.runExclusive(() => syncBibliography(db));
  return {
    content: [{ type: "text", text: `sync_bibliography: rendered ${syncedCount} citable entr${syncedCount === 1 ? "y" : "ies"} to refs/references.bib from the registry (human edits to the file are not imported)` }],
    structuredContent: { action: "sync_bibliography", synced: syncedCount },
    details: {},
  };
}

