/**
 * `verify`: check ONE claim against all registered papers or an explicit
 * subset (or, rarely, direct passages) and return only supporting evidence
 * with exact source pointers, plus separately reported coverage. Retrieval,
 * source preparation and judgment are internal (see verify/workflow.ts); the
 * agent never loads papers, writes chunks, or reads scores as truth.
 *
 * The model reads ONLY the text content, so the headline, every coverage
 * dimension, each evidence record (pointer, excerpt or withholding reason)
 * and the continuation token are rendered there; the structured copy mirrors it.
 */

import { Type, type Static } from "typebox";

import { RegistryError, openRegistry } from "../registry.ts";
import { documentWorkflow, MAX_DOCUMENT_UNITS, type DocumentUnitResult, type DocumentUnitStatus } from "../verify/document.ts";
import { verifyWorkflow, type WorkflowHooks } from "../verify/workflow.ts";
import { busyRefusal, refusalResult, type ToolContext, type ToolResult } from "./context.ts";

/** Client policy: a claim is a sentence-scale proposition, not a document. */
export const MIN_CLAIM_CHARS = 8;
export const MAX_CLAIM_CHARS = 2_000;
/** Client policy: a locator is a short phrase; the FTS expression stays bounded. */
export const MAX_QUERY_CHARS = 500;
/** Client policy: explicit ID subsets stay within one tool payload. */
export const MAX_SCOPE_IDS = 100;
/** Client policy: direct passages are a rare path; text bounded by the engine window. */
export const MAX_DIRECT_PASSAGES = 8;
export const MAX_DIRECT_TEXT_CHARS = 4_000;
export { MAX_EVIDENCE_PER_PAGE, MAX_PAGE_EXCERPT_CHARS } from "../verify/workflow.ts";

export const VerifyClaimParams = Type.Object({
  claim: Type.String({ minLength: MIN_CLAIM_CHARS, maxLength: MAX_CLAIM_CHARS, description: "ONE proposition to find support for, stated as a sentence; it is passed to the verifier unchanged" }),
  papers: Type.Optional(
    Type.Union([Type.Literal("all"), Type.Array(Type.String(), { minItems: 1, maxItems: MAX_SCOPE_IDS })], {
      description: `Scope: "all" registered papers, or an explicit list of DOIs/citekeys (at most ${MAX_SCOPE_IDS}); an empty list is refused, never read as all`,
    }),
  ),
  query: Type.Optional(Type.String({ maxLength: MAX_QUERY_CHARS, description: "Optional locator words that only narrow WHICH passages are checked; the claim is unchanged and the search becomes query-limited, not exhaustive. An exhaustive check judges every passage of every selected paper and can take minutes for long papers; use a query when a focused check is enough" })),
  passages: Type.Optional(
    Type.Array(Type.Union([Type.Object({ source: Type.String({ description: "pointer from an earlier result (doi@revision#start-end)" }) }), Type.Object({ text: Type.String({ maxLength: MAX_DIRECT_TEXT_CHARS, description: "caller-supplied text; judged with no paper attribution" }) })]), {
      minItems: 1,
      maxItems: MAX_DIRECT_PASSAGES,
      description: `Rare direct path instead of papers: judge exactly these passages (at most ${MAX_DIRECT_PASSAGES})`,
    }),
  ),
  continuation: Type.Optional(Type.String({ description: "Token from the previous response of the SAME request: continues unfinished checking and/or the next page of evidence" })),
});
export type VerifyClaimArgs = Static<typeof VerifyClaimParams>;

/**
 * Document mode, exclusive with the claim modes: check the TEXT AS WRITTEN.
 * `document` names a project-relative .tex entry (includes expanded like
 * provenance); `text` is a LaTeX fragment. Units come from the product's own
 * extractor; each is verified verbatim (cited units against their own papers,
 * uncited units against all papers). At most MAX_DOCUMENT_UNITS units per
 * call (client policy). Exhaustive per unit at the configured bar (default
 * 0.99): fast with the hosted engine, slow with local Eos.
 */
export const VerifyDocumentParams = Type.Object({
  document: Type.Optional(Type.String({ minLength: 1, description: "Project-relative .tex entry to check as written (its includes are expanded)" })),
  text: Type.Optional(Type.String({ minLength: 1, description: "LaTeX fragment to check as written" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "First unit to check; a result that names a next offset has more units to check" })),
});
export type VerifyDocumentArgs = Static<typeof VerifyDocumentParams>;

/** The tool accepts claim mode or document mode, never a mix. The server
 * declares one object schema (MCP tools carry a single `type: object`
 * input); exclusivity is enforced in code. */
export const VerifyParams = Type.Object({
  claim: Type.Optional(Type.String({ minLength: MIN_CLAIM_CHARS, maxLength: MAX_CLAIM_CHARS, description: "ONE proposition to find support for, stated as a sentence; it is passed to the verifier unchanged" })),
  papers: Type.Optional(
    Type.Union([Type.Literal("all"), Type.Array(Type.String(), { minItems: 1, maxItems: MAX_SCOPE_IDS })], {
      description: `Scope: "all" registered papers, or an explicit list of DOIs/citekeys (at most ${MAX_SCOPE_IDS}); an empty list is refused, never read as all`,
    }),
  ),
  query: Type.Optional(Type.String({ maxLength: MAX_QUERY_CHARS, description: "Optional locator words that only narrow WHICH passages are checked; the claim is unchanged and the search becomes query-limited, not exhaustive. An exhaustive check judges every passage of every selected paper and can take minutes for long papers; use a query when a focused check is enough" })),
  passages: Type.Optional(
    Type.Array(Type.Union([Type.Object({ source: Type.String({ description: "pointer from an earlier result (doi@revision#start-end)" }) }), Type.Object({ text: Type.String({ maxLength: MAX_DIRECT_TEXT_CHARS, description: "caller-supplied text; judged with no paper attribution" }) })]), {
      minItems: 1,
      maxItems: MAX_DIRECT_PASSAGES,
      description: `Rare direct path instead of papers: judge exactly these passages (at most ${MAX_DIRECT_PASSAGES})`,
    }),
  ),
  continuation: Type.Optional(Type.String({ description: "Token from the previous response of the SAME request: continues unfinished checking and/or the next page of evidence" })),
  document: Type.Optional(Type.String({ minLength: 1, description: "Document mode (exclusive with claim, papers, query, passages, continuation): project-relative .tex entry to check as written, its includes expanded" })),
  text: Type.Optional(Type.String({ minLength: 1, description: "Document mode (exclusive with claim, papers, query, passages, continuation): LaTeX fragment to check as written" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: `Document mode: first unit to check (pages of ${MAX_DOCUMENT_UNITS} units); the result names the next offset until the whole text is checked` })),
});
export type VerifyArgs = Static<typeof VerifyParams>;
export { MAX_DOCUMENT_UNITS };
export type { DocumentUnitResult, DocumentUnitStatus };

const Nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([t, Type.Null()]);

export const VerifyClaimOutput = Type.Object({
  claim: Type.String(),
  mode: Type.String(),
  result: Type.Object({ supportFound: Type.Boolean(), searched: Type.String(), complete: Type.Boolean(), limitations: Type.Array(Type.String()) }),
  engine: Type.Object({ name: Type.String(), model: Nullable(Type.String()), protocol: Type.String(), minConfidence: Type.Number(), cache: Type.Boolean() }),
  coverage: Type.Object({
    sources: Type.Object({ selected: Type.Integer(), ready: Type.Integer(), unavailable: Type.Array(Type.Record(Type.String(), Type.Unknown())), unresolved: Type.Array(Type.Record(Type.String(), Type.Unknown())), preprint: Type.Array(Type.String()) }),
    candidates: Type.Object({ total: Type.Integer(), perPaper: Type.Array(Type.Record(Type.String(), Type.Unknown())) }),
    work: Type.Record(Type.String(), Type.Unknown()),
    output: Type.Object({ available: Type.Integer(), returned: Type.Integer(), deliveredEarlier: Type.Integer(), withheld: Type.Integer(), staleDropped: Type.Integer() }),
  }),
  evidence: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  direct: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
  continuation: Nullable(Type.String()),
});
export type VerifyClaimStructured = Record<string, any>;
export type VerifyHooks = WorkflowHooks;

export const VerifyDocumentOutput = Type.Object({
  mode: Type.Literal("document"),
  source: Type.String(),
  summary: Type.Object({
    total: Type.Integer(),
    from: Type.Integer(),
    units: Type.Integer(),
    supported: Type.Integer(),
    missingCitation: Type.Integer(),
    citedUnsupported: Type.Integer(),
    unsourced: Type.Integer(),
    unregistered: Type.Integer(),
    incomplete: Type.Integer(),
  }),
  engine: Type.Object({ name: Type.String(), model: Nullable(Type.String()), protocol: Type.String(), minConfidence: Type.Number(), cache: Type.Boolean() }),
  units: Type.Array(
    Type.Object({
      id: Type.String(),
      kind: Type.String(),
      file: Type.String(),
      line: Type.Integer(),
      section: Type.String(),
      excerpt: Type.String(),
      status: Type.Union([Type.Literal("supported"), Type.Literal("cited-unsupported"), Type.Literal("missing-citation"), Type.Literal("unsourced"), Type.Literal("unregistered")]),
      cites: Type.Array(Type.String()),
      pointers: Type.Array(Type.String()),
      suggested: Type.Array(Type.String()),
      complete: Type.Boolean(),
    }),
  ),
  next: Type.Union([Type.Integer(), Type.Null()]),
});

/** Either tool output: claim mode or document mode. */
export const VerifyOutput = Type.Union([VerifyClaimOutput, VerifyDocumentOutput]);

const invalid = (message: string) => refusalResult({ code: "ARGUMENT_INVALID", message });

export async function verifyClaimTool(ctx: ToolContext, args: VerifyArgs, hooks: VerifyHooks = {}): Promise<ToolResult<VerifyClaimStructured>> {
  const doc = (args as VerifyDocumentArgs).document;
  const text = (args as VerifyDocumentArgs).text;
  const docMode = doc !== undefined || text !== undefined;
  if (docMode) {
    if (doc !== undefined && text !== undefined) return invalid("give either `document` or `text`, not both");
    if (doc !== undefined && typeof doc !== "string") return invalid("document must be a project-relative .tex path");
    if (text !== undefined && typeof text !== "string") return invalid("text must be a LaTeX fragment");
    const claim = (args as VerifyClaimArgs).claim;
    const extra = ["papers", "query", "passages", "continuation"].filter((k) => (args as Record<string, unknown>)[k] !== undefined);
    if (claim !== undefined || extra.length > 0) return invalid("document mode takes only `document` or `text` (and `offset`): it is exclusive with the claim modes");
    const offset = (args as VerifyDocumentArgs).offset;
    let db;
    try {
      db = openRegistry(ctx.root);
    } catch (err) {
      if (err instanceof RegistryError) return refusalResult({ code: err.code, message: err.message });
      throw err;
    }
    try {
      const out = await documentWorkflow(ctx, db, { ...(doc !== undefined ? { document: doc } : {}), ...(text !== undefined ? { text } : {}), ...(offset !== undefined ? { offset } : {}) }, hooks);
      if (out.kind === "refused") return refusalResult({ code: out.code, message: out.message });
      return { content: [{ type: "text", text: renderDocument(out.result) }], structuredContent: out.result, details: { mode: out.result.mode } };
    } catch (err) {
      const busy = busyRefusal(err);
      if (busy !== null) return busy;
      throw err;
    } finally {
      db.close();
    }
  }
  const claimArgs = args as VerifyClaimArgs;
  if (typeof claimArgs.claim !== "string" || claimArgs.claim.length < MIN_CLAIM_CHARS || claimArgs.claim.length > MAX_CLAIM_CHARS) {
    return invalid(`claim must be one proposition of ${MIN_CLAIM_CHARS}–${MAX_CLAIM_CHARS} characters`);
  }
  const direct = claimArgs.passages !== undefined;
  if (direct === (claimArgs.papers !== undefined)) {
    return invalid(direct ? "give either `papers` or `passages`, not both" : 'give a scope: `papers` ("all" or a list of DOIs/citekeys), or `passages` for the direct path');
  }
  if (claimArgs.query !== undefined && claimArgs.query.length > MAX_QUERY_CHARS) return invalid(`query is longer than ${MAX_QUERY_CHARS} characters`);
  if (direct) {
    if (claimArgs.query !== undefined || claimArgs.continuation !== undefined) return invalid("`query` and `continuation` do not apply to direct passages");
    if (!Array.isArray(claimArgs.passages) || claimArgs.passages.length === 0 || claimArgs.passages.length > MAX_DIRECT_PASSAGES) return invalid(`passages needs 1–${MAX_DIRECT_PASSAGES} items`);
    for (const p of claimArgs.passages as unknown[]) {
      const keys = typeof p === "object" && p !== null ? Object.keys(p) : [];
      const o = p as Record<string, unknown>;
      const ok = keys.length === 1 && ((keys[0] === "source" && typeof o.source === "string") || (keys[0] === "text" && typeof o.text === "string" && o.text.trim().length >= MIN_CLAIM_CHARS && o.text.length <= MAX_DIRECT_TEXT_CHARS));
      if (!ok) return invalid(`each passage is exactly one of {source: pointer} or {text: ${MIN_CLAIM_CHARS}–${MAX_DIRECT_TEXT_CHARS} characters}; text cannot claim a paper`);
    }
  } else if (claimArgs.papers !== "all") {
    if (!Array.isArray(claimArgs.papers) || claimArgs.papers.length === 0 || claimArgs.papers.some((h) => typeof h !== "string")) {
      return invalid('papers must be "all" or a non-empty list of DOIs/citekeys; an empty list is never read as all');
    }
    if (claimArgs.papers.length > MAX_SCOPE_IDS) return refusalResult({ code: "BATCH_TOO_LARGE", message: `${claimArgs.papers.length} papers exceed the ${MAX_SCOPE_IDS}-paper scope cap (client policy); use "all" or split` });
  }

  let db;
  try {
    db = openRegistry(ctx.root);
  } catch (err) {
    if (err instanceof RegistryError) return refusalResult({ code: err.code, message: err.message });
    throw err;
  }
  try {
    const out = await verifyWorkflow(ctx, db, claimArgs, hooks);
    if (out.kind === "refused") return refusalResult({ code: out.code, message: out.message });
    return { content: [{ type: "text", text: render(out.result) }], structuredContent: out.result, details: { mode: out.result.mode } };
  } catch (err) {
    const busy = busyRefusal(err);
    if (busy !== null) return busy;
    throw err;
  } finally {
    db.close();
  }
}

// ── rendering ───────────────────────────────────────────────────────────────

function renderDocument(s: Record<string, any>): string {
  const summary = s.summary as { total: number; from: number; units: number; supported: number; missingCitation: number; citedUnsupported: number; unsourced: number; unregistered: number; incomplete: number };
  const units = s.units as DocumentUnitResult[];
  const lines: string[] = [
    `DOCUMENT: units ${summary.from + 1}–${summary.from + summary.units} of ${summary.total} checked as written (${s.source}) — ${summary.supported} supported, ${summary.missingCitation} missing-citation, ${summary.citedUnsupported} cited-unsupported, ${summary.unsourced} unsourced, ${summary.unregistered} unregistered${summary.incomplete > 0 ? `, ${summary.incomplete} incomplete` : ""}.`,
  ];
  for (const u of units) {
    const where = u.file === "fragment.tex" ? "text" : `${u.file}:${u.line}`;
    const extra = u.status === "supported" ? ` [${u.pointers.join(", ")}]` : u.status === "missing-citation" ? ` — cite ${(u.suggested as string[]).join(", ") || "a registered paper"} [${u.pointers.join(", ")}]` : "";
    lines.push(`[${u.id}] ${where} (${u.kind}) "${u.excerpt}" — ${u.status}${extra}${u.complete ? "" : " (incomplete check)"}`);
  }
  if (s.next !== null) lines.push(`NOT DONE: ${summary.total - summary.from - summary.units} unit(s) not checked yet; call verify again with the same text and offset ${s.next}.`);
  lines.push("No support found means the verifier did not find a passage supporting the unit under the configured bar; it is not evidence that the unit is false.");
  return lines.join("\n");
}

function render(s: Record<string, any>): string {
  const r = s.result;
  const cov = s.coverage;
  const lines: string[] = [];
  const papersWithEvidence = new Set((s.evidence as { doi?: string }[]).map((e) => e.doi).filter(Boolean)).size;

  if (s.mode === "direct") {
    lines.push(r.supportFound ? `SUPPORT FOUND in ${s.evidence.length} of ${cov.candidates.total} supplied passage(s).` : `NO SUPPORT FOUND in the ${cov.candidates.total} supplied passage(s).`);
  } else if (cov.sources.selected === 0 && cov.sources.unresolved.length === 0) {
    lines.push("NO SUPPORT FOUND: there are no registered papers to check. Register papers with registry first.");
  } else if (cov.sources.ready === 0) {
    lines.push("NO SUPPORT FOUND: no usable source for any selected paper, so nothing was checked.");
  } else if (r.supportFound) {
    const where = papersWithEvidence > 0 ? `in ${papersWithEvidence} paper(s)` : "in this run";
    lines.push(`SUPPORT FOUND: ${cov.output.available} supporting passage(s) ${where}${r.complete ? "." : " — coverage is INCOMPLETE (see below)."}`);
  } else if (r.limitations.includes("interrupted")) {
    lines.push("NO SUPPORT FOUND YET: checking was interrupted before all selected passages were judged (see work).");
  } else {
    lines.push(`NO SUPPORT FOUND${r.searched === "query_limited" ? " in the query-limited search" : ` across all ${cov.candidates.total} checked passage(s)`}.`);
  }
  if (!r.supportFound) lines.push("No support found means the verifier did not find a passage supporting the claim under the configured bar; it is not evidence that the claim is false.");
  lines.push(`claim: ${s.claim}`);
  if (s.mode !== "direct") lines.push(`engine: ${s.engine.name} (${s.engine.model ?? "identity unknown — judgments not reused"}), support bar ${s.engine.minConfidence}`);

  // coverage — four separate dimensions
  if (s.mode !== "direct") {
    const unavailable = cov.sources.unavailable as { doi: string; citekey: string; status: string; code: string | null; detail: string | null }[];
    lines.push(`sources: ${cov.sources.selected} selected, ${cov.sources.ready} with a usable source` + (unavailable.length > 0 ? `; without one: ${unavailable.map((u) => `${u.citekey} ${u.doi} (${u.status}${u.code ? `: ${u.code}` : ""}${u.detail ? ` — ${u.detail}` : ""})`).join("; ")}` : ""));
    if (cov.sources.preprint.length > 0) lines.push(`preprint: ${cov.sources.preprint.join(", ")} — read from an arXiv preprint of the work, which may differ from the published version; do not present its text as the published paper's`);
    if (cov.sources.unresolved.length > 0) lines.push(`unresolved handles (not registered, not checked): ${cov.sources.unresolved.map((u: { handle: string }) => u.handle).join(", ")}`);
    if (r.searched === "query_limited") {
      const per = cov.candidates.perPaper as { citekey: string; chunks: number; matched: number; selected: number }[];
      lines.push(`candidates: query-limited — only passages matching the locator were checked (${cov.candidates.total} of ${per.reduce((n, p) => n + p.chunks, 0)}); ${per.map((p) => `${p.citekey} ${p.selected}/${p.matched} matched of ${p.chunks}`).join("; ") || "no paper had a usable source"}. No candidates is a statement about the search, not a finding about the papers.`);
    } else if (cov.sources.ready > 0) {
      lines.push(`candidates: exhaustive — every usable passage (${cov.candidates.total}) of ${cov.sources.ready} paper(s) selected for checking`);
    }
    const w = cov.work;
    lines.push(
      `work: ${w.checked} of ${w.checked + w.unchecked} selected passage(s) judged (${w.fresh} new, ${w.cached} reused)` +
        (w.localizationFresh > 0 ? `, ${w.localizationFresh} localization check(s)` : "") +
        (w.interruption ? `; INTERRUPTED (${w.interruption.reason}): ${w.interruption.detail}; ${w.unchecked} not checked` : "; complete"),
    );
  }
  lines.push(
    `output: ${cov.output.returned} supporting record(s) shown now` +
      (cov.output.deliveredEarlier > 0 ? `; ${cov.output.deliveredEarlier} delivered on earlier pages` : "") +
      (cov.output.available > cov.output.returned + cov.output.deliveredEarlier ? `; ${cov.output.available - cov.output.returned - cov.output.deliveredEarlier} more waiting` : "") +
      (cov.output.withheld > 0 ? `; excerpt text withheld for ${cov.output.withheld} (pointers kept)` : ""));
  if (cov.output.staleDropped > 0) lines.push(`warning: a source changed during checking; ${cov.output.staleDropped} supporting passage(s) were discarded rather than pointed at text they were not judged on`);

  // evidence
  (s.evidence as Record<string, any>[]).forEach((e, i) => {
    if (e.attested === false) {
      lines.push(`[${i + 1}] caller-supplied passage #${e.index} — supports the claim (score ${Number(e.judgment.score).toFixed(3)}); no authenticated paper provenance`, `    excerpt: "${e.excerpt}"`);
      return;
    }
    lines.push(
      `[${i + 1}] ${e.citekey} — ${e.title} (${e.doi})${e.citable ? "" : " [uncitable]"}${e.page ? `, page ${e.page}` : ""}`,
      `    pointer: ${e.pointer}   (characters ${e.span.start}–${e.span.end}${e.localized ? "" : "; support found at passage scale, not localized further"})`,
      `    judged by ${e.judgment.model}: engine score ${Number(e.judgment.score).toFixed(3)} at bar ${e.judgment.minConfidence} (engine output, not a probability of truth)`,
      e.excerpt === null ? `    excerpt withheld (${e.withheld}) — the pointer identifies the exact supporting span` : `    excerpt: "${e.excerpt}"`,
    );
  });
  if (s.direct) for (const d of s.direct as { index: number; kind: string; status: string }[]) if (d.status !== "judged") lines.push(`direct #${d.index} (${d.kind}): ${d.status} — not judged`);

  if (s.continuation) {
    const more = [cov.work.unchecked > 0 ? "unchecked passages" : null, cov.output.available > cov.output.returned ? "more evidence records" : null].filter(Boolean).join(" and ");
    lines.push(`continuation: "${s.continuation}" — repeat the SAME request with continuation set to this token to get ${more || "the rest"}.`);
  }
  return lines.join("\n");
}
