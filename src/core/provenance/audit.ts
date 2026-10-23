/**
 * Provenance audit: for a manuscript, which statements `verify` supported word for word, which only cite a paper, which cite
 * nothing, and for every figure whether the cited paper's text contains it. Deterministic, no model, no text leaves the registry:
 * the result carries the manuscript's own words, pointers, counts and reasons.
 *
 * It describes; it never blocks. The manuscript belongs to the user (docs/VISION.md), so the audit is a view, and its unit of
 * evidence is the package's own ledger of verify runs, not a file the agent writes.
 */
import type { Paper } from "../review/latex.ts";
import { figuresOf, matchFigure, normalizePaperText, type Figure } from "./figures.ts";
import { countBodyWords, documentCiteKeys, extractUnits, type Unit } from "./units.ts";

export interface PaperInput { citekey: string; doi: string; title: string; text: string | null }
export interface LedgerHit { pointers: string[]; dois: string[] }
/** Support the package's verify ledger holds for one of the candidate wordings of a statement, if any. */
export type Ledger = (variants: string[]) => LedgerHit | null;
export type FigureStatus = "ok" | "check" | "open" | "unsourced" | "uncited" | "unavailable" | "computed";
export interface FigureAudit { token: string; status: FigureStatus; detail: string; papers: string[] }
/** One non-empty normalized line of a project result file, with its `file:line` pointer. */
export interface ResultLine { file: string; line: number; text: string }
/** Label convention (D1, client policy): a statement is labelled unverified when its plain text contains the word "unverified". */
export const UNVERIFIED_LABEL = /\bunverified\b/i;
/** A prose statement or caption that is not verified as written: D1 lets it ship only when labelled unverified. */
export const isNonVerifiedProse = (u: UnitAudit): boolean => u.unit.kind !== "row" && u.status !== "verified";
/** The non-verified prose that is not labelled unverified (D1: these fail the deliverable checks). */
export const unlabelledUnverifiedUnits = (a: ProvenanceAudit): UnitAudit[] => a.units.filter((u) => isNonVerifiedProse(u) && !u.labelledUnverified);
/** A unit written as nothing but bibliography commands (`\bibliographystyle{plain}`, `\bibliography{refs}`). */
const BIBLIOGRAPHY_ONLY = /^\s*(?:\\(?:bibliographystyle|bibliography|addbibresource)\s*(?:\[[^\]]*\]\s*)?\{[^}]*\}\s*)+$/;
export interface UnitAudit { unit: Unit; status: "verified" | "cited" | "uncited"; ledger: LedgerHit | null; unregistered: string[]; figures: FigureAudit[]; labelledUnverified: boolean }
export interface OpenItem { severity: "open" | "check" | "info"; status: FigureStatus; papers: string[]; file: string; line: number; section: string; kind: Unit["kind"]; token: string; why: string; excerpt: string }
export interface ProvenanceSummary {
  words: number;
  /** Prose statements and captions (all of them), and table rows that cite a paper or state a figure. */
  audited: number;
  verified: number;
  cited: number;
  uncited: number;
  /** Prose statements and captions that are not verified and carry the unverified label (D1). */
  labelledUnverified: number;
  /** Prose statements and captions that are not verified and do not carry the unverified label (D1: these fail the gate). */
  unlabelledUnverified: number;
  figures: { ok: number; check: number; open: number; info: number; computed: number };
  /** Every cite key in the document that no registry record carries, including cites outside any unit. */
  unregistered: string[];
  /** Every cite key in the document, sorted (Tier 1 reads it; units alone miss a cite after the full stop). */
  citeKeys: string[];
}
/** `units` are the audited statements (they cite a paper or state a figure); `extracted` is every unit, for readers that must see all of them. */
export interface ProvenanceAudit { summary: ProvenanceSummary; units: UnitAudit[]; items: OpenItem[]; extracted: Unit[] }

/** Client policy: candidate wordings tried against the ledger for one statement (its clauses, with and without the final period). */
const MAX_VARIANTS = 24;
const MAX_CLAUSES = 5;

/** The wordings a statement may have been verified in: the whole, each run of its colon/semicolon clauses, with and without a period. */
export function claimVariants(plain: string): string[] {
  const whole = plain.replace(/\s+/g, " ").trim();
  if (whole === "") return [];
  const clauses = whole.split(/(?<=[:;])\s+/).slice(0, MAX_CLAUSES);
  const out = new Set<string>();
  for (let i = 0; i < clauses.length; i++) {
    for (let j = i; j < clauses.length; j++) {
      const v = clauses.slice(i, j + 1).join(" ");
      out.add(v);
      out.add(v.endsWith(".") ? v.slice(0, -1) : `${v}.`);
    }
  }
  return [...out].slice(0, MAX_VARIANTS);
}

const RANK: Record<FigureStatus, number> = { ok: 0, computed: 0, check: 1, unavailable: 1, uncited: 2, unsourced: 3, open: 3 };

/**
 * The computed-results search for a figure no registered paper is cited
 * for: the same matching rules as paper figures (a decimal or a number
 * found with its unit is strong; a round integer alone is weak), over the
 * project's result-file lines. A strong match is `computed` with the
 * `file:line` pointer; a weak-only match is `check`; no match keeps the
 * caller's uncited/unsourced audit.
 */
function auditComputed(f: Figure, lines: ResultLine[]): FigureAudit | null {
  let weak: ResultLine | null = null;
  for (const r of lines) {
    const m = matchFigure(f, r.text);
    if (m === "exact" || (m === "number-only" && f.decimal)) {
      return { token: f.token, status: "computed", detail: `"${f.token}" found in ${r.file}:${r.line}`, papers: [] };
    }
    if (m === "number-only" && weak === null) weak = r;
  }
  return weak === null
    ? null
    : { token: f.token, status: "check", detail: `the number ${f.value} occurs in ${weak.file}:${weak.line} but never with ${f.unit ?? "its unit"}`, papers: [] };
}

function auditFigure(f: Figure, unit: Unit, registered: PaperInput[], texts: Map<string, string>, cited: boolean, results: ResultLine[]): FigureAudit {
  if (registered.length === 0) {
    const computed = auditComputed(f, results);
    if (computed !== null) return computed;
    return unit.kind === "row"
      ? { token: f.token, status: "unsourced", detail: `"${f.token}" is in a table row that cites no registered paper`, papers: [] }
      : cited
        ? { token: f.token, status: "unsourced", detail: `"${f.token}" is in a statement whose citations are not registered`, papers: [] }
        : { token: f.token, status: "uncited", detail: `"${f.token}" is in a statement that cites no paper`, papers: [] };
  }
  const withText = registered.filter((p) => texts.has(p.citekey));
  if (withText.length === 0) {
    return { token: f.token, status: "unavailable", detail: `"${f.token}" is unchecked: the text of ${registered.map((p) => p.citekey).join(", ")} is not available`, papers: registered.map((p) => p.citekey) };
  }
  let best: FigureAudit | null = null;
  for (const p of withText) {
    const m = matchFigure(f, texts.get(p.citekey)!);
    const audit: FigureAudit =
      m === "exact" || (m === "number-only" && f.decimal)
        ? { token: f.token, status: "ok", detail: m === "exact" ? `found in ${p.citekey}` : `number found in ${p.citekey} (its unit is probably in a table header)`, papers: [p.citekey] }
        : m === "number-only"
          ? { token: f.token, status: "check", detail: `the number ${f.value} occurs in ${p.citekey} but never with ${f.unit ?? "its unit"}`, papers: [p.citekey] }
          : { token: f.token, status: "open", detail: `"${f.token}" does not occur in ${withText.map((q) => q.citekey).join(", ")}`, papers: withText.map((q) => q.citekey) };
    if (best === null || RANK[audit.status] < RANK[best.status]) best = audit;
  }
  return best!;
}

export function auditProvenance(input: { paper: Paper; tex: string; papers: PaperInput[]; ledger: Ledger; results?: ResultLine[] }): ProvenanceAudit {
  const byKey = new Map(input.papers.map((p) => [p.citekey, p]));
  const texts = new Map<string, string>();
  for (const p of input.papers) if (p.text !== null && p.text !== "") texts.set(p.citekey, normalizePaperText(p.text));
  const units: UnitAudit[] = [];
  const unregisteredAll = new Set<string>();
  const extracted = extractUnits(input.paper);
  for (const unit of extracted) {
    const figures = figuresOf(unit.plain);
    // Prose (sentences and captions) is always audited, so uncited prose reaches the D1 gate; a table row is audited only when it cites or states a figure.
    if (unit.kind === "row" && unit.cites.length === 0 && figures.length === 0) continue;
    // A unit that is only bibliography commands states nothing; the frozen segmenter keeps it, the audit does not count it.
    if (BIBLIOGRAPHY_ONLY.test(unit.raw)) continue;
    const registered = unit.cites.flatMap((k) => (byKey.has(k) ? [byKey.get(k)!] : []));
    const unregistered = unit.cites.filter((k) => !byKey.has(k));
    for (const k of unregistered) unregisteredAll.add(k);
    let hit: LedgerHit | null = null;
    if (unit.kind !== "row") {
      const found = input.ledger(claimVariants(unit.plain));
      if (found !== null && registered.some((p) => found.dois.includes(p.doi))) hit = found;
    }
    units.push({
      unit,
      status: hit !== null ? "verified" : registered.length > 0 ? "cited" : "uncited",
      ledger: hit,
      unregistered,
      figures: figures.map((f) => auditFigure(f, unit, registered, texts, unit.cites.length > 0, input.results ?? [])),
      labelledUnverified: UNVERIFIED_LABEL.test(unit.plain),
    });
  }
  const items: OpenItem[] = [];
  const citeKeys = documentCiteKeys(input.paper);
  for (const k of citeKeys) if (!byKey.has(k)) unregisteredAll.add(k);
  const summary: ProvenanceSummary = { words: countBodyWords(input.tex), audited: units.length, verified: 0, cited: 0, uncited: 0, labelledUnverified: 0, unlabelledUnverified: 0, figures: { ok: 0, check: 0, open: 0, info: 0, computed: 0 }, unregistered: [...unregisteredAll].sort(), citeKeys };
  for (const u of units) {
    if (u.status === "verified") summary.verified++;
    else if (u.status === "cited") summary.cited++;
    else summary.uncited++;
    if (isNonVerifiedProse(u)) {
      if (u.labelledUnverified) summary.labelledUnverified++;
      else summary.unlabelledUnverified++;
    }
    for (const f of u.figures) {
      // `computed` is evidence, not an open item: counted, never listed.
      if (f.status === "computed") { summary.figures.computed++; continue; }
      const severity: OpenItem["severity"] | null = f.status === "open" || f.status === "unsourced" ? "open" : f.status === "check" || f.status === "unavailable" ? "check" : f.status === "uncited" ? "info" : null;
      if (severity === null) { summary.figures.ok++; continue; }
      summary.figures[severity]++;
      items.push({ severity, status: f.status, papers: f.papers, file: u.unit.file, line: u.unit.line, section: u.unit.section, kind: u.unit.kind, token: f.token, why: f.detail, excerpt: u.unit.plain.length > 120 ? `${u.unit.plain.slice(0, 117)}...` : u.unit.plain });
    }
  }
  const order = { open: 0, check: 1, info: 2 } as const;
  items.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
  return { summary, units, items, extracted };
}
