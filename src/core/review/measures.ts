/**
 * The four deterministic scientific-slop measures of the manuscript review, reimplemented from the definitions in Appendix A of
 * Oh et al., "Science or Slop? Benchmarking and Mitigating Scientific Slop in AI-Generated Papers" (arXiv 2610.00531). The authors'
 * code carries no licence, so nothing is copied; where the paper leaves a rule open (the weaving cues, what counts as an exhibit,
 * the minimum counts) the choice here is ours and named below. Each measure is a share of flagged units (higher is worse) and every
 * flagged unit carries the file and line it sits on. These scores separate AI-written from human-written papers pairwise; they are
 * diagnostics with evidence, never a verdict on whether a manuscript is good.
 */
import { braceGroup, parsePaper, type Paper, type Pos, type SrcLine } from "./latex.ts";
import { CITE_CMD, envRanges, FLOAT_ENVS, mask, proseTokens, REF_CMD, sentenceRanges } from "./prose.ts";

export interface Unit { where: Pos; section: string; excerpt: string }
export interface Measure {
  id: "cross_section_refs" | "macro_redundancy" | "citation_isolation" | "evidence_gap";
  name: string;
  /** Share of units flagged (0 to 1), or null when the measure does not apply or has no units. */
  rate: number | null;
  flagged: number;
  total: number;
  /** The flagged units, in document order. */
  units: Unit[];
  /** Set when the score rests on too few units to trust (our minimum counts; the paper leaves them open). */
  weak?: string;
  note?: string;
}

const MIN_OBJECTS = 5;
const MIN_SENTENCES = 50;
const MIN_CITING = 8;
const EIGHT = 8;
const clip = (s: string, n = 110): string => (s.replace(/\s+/g, " ").trim().length > n ? `${s.replace(/\s+/g, " ").trim().slice(0, n - 1)}…` : s.replace(/\s+/g, " ").trim());
const titleOf = (p: Paper, i: number): string => (i >= 0 ? (p.sections[i]?.title ?? "") : "front matter");
const finish = (m: Omit<Measure, "rate">, rate: number | null = m.total > 0 ? m.flagged / m.total : null): Measure => ({ ...m, rate });

// ---------------------------------------------------------------------------------------------------------------- cross-section references

type Kind = "section" | "figure" | "table" | "algorithm" | "equation" | "theorem";
interface Obj { kind: Kind; key: string; /** Labels that point at this object: a section answers to every label inside it that no float or equation claims (subsection headings included). */ labels: Set<string>; number?: number; home: number; offset: number }
const THEOREMS = ["theorem", "lemma", "proposition", "corollary", "definition", "remark", "claim", "assumption", "conjecture", "proposition"];
const EQUATIONS = ["equation", "align", "gather", "multline", "eqnarray", "flalign"];
const FLOATS: Record<string, Kind> = { figure: "figure", table: "table", algorithm: "algorithm", algorithm2e: "algorithm", wrapfigure: "figure", wraptable: "table", sidewaysfigure: "figure", sidewaystable: "table" };
const kindOfEnv = (env: string): Kind | undefined => {
  const base = env.replace(/\*$/, "");
  if (FLOATS[base]) return FLOATS[base];
  if (EQUATIONS.includes(base)) return "equation";
  if (THEOREMS.includes(base)) return "theorem";
  return undefined;
};
const NAMED: Array<[RegExp, Kind]> = [
  [/(?:\bSections?|\bSecs?\.?|§)\s*~?\s*(\d+(?:\s*(?:,|and|&|to|--|–)\s*\d+)*)/gi, "section"],
];

export function measureCrossSectionRefs(p: Paper): Measure {
  const body = p.text.slice(0, p.bodyEnd);
  const objs: Obj[] = [];
  for (const s of p.sections) {
    if (s.number === null) continue;
    objs.push({ kind: "section", key: s.title, labels: new Set(), number: s.number, home: s.index, offset: s.start });
  }
  const counters: Record<string, number> = { figure: 0, table: 0, algorithm: 0 };
  const stack: Array<{ env: string; kind?: Kind; number?: number }> = [];
  const re = /\\(begin|end)\s*\{([A-Za-z*0-9]+)\}|\\label\s*\{([^}]+)\}/g;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    if (m.index < p.bodyStart) continue;
    if (m[1] === "begin") {
      const kind = kindOfEnv(m[2]!);
      const outer = stack.some((e) => e.kind === kind && kind !== undefined && kind in counters);
      const number = kind && kind in counters && !outer ? ++counters[kind]! : undefined;
      stack.push({ env: m[2]!, kind, number });
    } else if (m[1] === "end") {
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.env === m[2]) { stack.length = i; break; }
    } else if (m[3] !== undefined) {
      const holder = [...stack].reverse().find((e) => e.kind !== undefined);
      const home = p.sectionAt(m.index);
      if (holder?.kind && home >= 0) objs.push({ kind: holder.kind, key: m[3], labels: new Set([m[3]]), number: holder.number, home, offset: m.index });
      else if (holder === undefined && home >= 0) objs.find((o) => o.kind === "section" && o.home === home)?.labels.add(m[3]);
    }
  }
  // Pointers: reference commands, then printed numbers ("Section 3", "Figure 2").
  const refs: Array<{ section: number; offset: number; label?: string; kind?: Kind; number?: number; roadmap?: boolean }> = [];
  for (const m of body.slice(0, p.bodyEnd).matchAll(REF_CMD)) {
    if (m.index! < p.bodyStart) continue;
    for (const key of m[1]!.split(",")) refs.push({ section: p.sectionAt(m.index!), offset: m.index!, label: key.trim() });
  }
  for (const m of body.matchAll(/\\hyperref\s*\[([^\]]+)\]/g)) refs.push({ section: p.sectionAt(m.index!), offset: m.index!, label: m[1]!.trim() });
  for (const [re2, kind] of NAMED) {
    for (const m of body.matchAll(re2)) {
      if (m.index! < p.bodyStart) continue;
      for (const n of m[1]!.match(/\d+/g) ?? []) refs.push({ section: p.sectionAt(m.index!), offset: m.index!, kind, number: Number(n) });
    }
  }
  // A roadmap in the first section ("Section 2 reviews…, Section 3 describes…") is the longest run of forward pointers to later sections;
  // it is not a trace of one section having read another, so it does not count (the paper records it apart).
  const sectionOf = (r: { label?: string; kind?: Kind; number?: number }): number | undefined =>
    objs.find((o) => o.kind === "section" && ((r.label !== undefined && o.labels.has(r.label)) || (r.kind === "section" && r.number === o.number)))?.home;
  const forward = refs.filter((r) => r.section === 0).map((r) => ({ r, to: sectionOf(r) })).filter((x): x is { r: typeof refs[number]; to: number } => x.to !== undefined && x.to > 0).sort((a, b) => a.r.offset - b.r.offset);
  let best: Array<typeof refs[number]> = [];
  let run: Array<typeof refs[number]> = [];
  let prev: { offset: number; to: number } | undefined;
  for (const x of forward) {
    run = prev !== undefined && x.r.offset - prev.offset <= 500 && x.to >= prev.to ? [...run, x.r] : [x.r];
    prev = { offset: x.r.offset, to: x.to };
    if (run.length > best.length) best = run;
  }
  if (best.length >= 2) for (const r of best) r.roadmap = true;
  const flagged = objs.filter((o) => !refs.some((r) => !r.roadmap && r.section !== o.home && ((r.label !== undefined && o.labels.has(r.label)) || (r.kind === o.kind && r.number !== undefined && r.number === o.number))));
  const units = flagged.map((o) => ({ where: p.where(o.offset), section: titleOf(p, o.home), excerpt: o.kind === "section" ? o.key : o.key }));
  return finish({
    id: "cross_section_refs", name: "Cross-section references", flagged: flagged.length, total: objs.length, units,
    ...(objs.length < MIN_OBJECTS ? { weak: `fewer than ${MIN_OBJECTS} objects (sections and labelled figures, tables, equations, algorithms, theorems)` } : {}),
    note: "Share of numbered sections and labelled objects that no other section points to (by reference command or printed number). The longest run of forward pointers to later sections in the first section (a roadmap) is not counted; the appendix holds no objects.",
  });
}

// ---------------------------------------------------------------------------------------------------------------- macro redundancy

interface Block { title: string; start: number; end: number }

function proseBlocks(p: Paper): Block[] {
  const blocks: Block[] = [];
  const abs = /\\begin\s*\{abstract\}([\s\S]*?)\\end\s*\{abstract\}/.exec(p.text);
  if (abs && abs.index < p.bodyEnd) blocks.push({ title: "Abstract", start: abs.index + abs[0].indexOf("}") + 1, end: abs.index + abs[0].length });
  for (const s of p.sections) blocks.push({ title: s.title, start: s.contentStart, end: s.end });
  return blocks;
}

export function measureMacroRedundancy(p: Paper): Measure {
  const blocks = proseBlocks(p);
  const firstSeen = new Map<string, number>();
  let eligible = 0;
  const units: Unit[] = [];
  blocks.forEach((b, ordinal) => {
    const raw = p.text.slice(b.start, b.end);
    const masked = mask(raw, { floats: true, math: true });
    for (const [a, z] of sentenceRanges(masked)) {
      if (masked.slice(a, z).replace(/\u0001/g, "").trim() === "") continue;
      const tokens = proseTokens(raw.slice(a, z));
      if (tokens.length < EIGHT) continue;
      eligible++;
      const grams: string[] = [];
      for (let i = 0; i + EIGHT <= tokens.length; i++) grams.push(tokens.slice(i, i + EIGHT).join(" "));
      const covered = new Set<number>();
      grams.forEach((g, i) => {
        const first = firstSeen.get(g);
        if (first !== undefined && first !== ordinal) for (let k = i; k < i + EIGHT; k++) covered.add(k);
      });
      for (const g of grams) if (!firstSeen.has(g)) firstSeen.set(g, ordinal);
      if (covered.size / tokens.length >= 0.5) units.push({ where: p.where(b.start + a), section: b.title, excerpt: clip(raw.slice(a, z)) });
    }
  });
  return finish({
    id: "macro_redundancy", name: "Macro redundancy", flagged: units.length, total: eligible, units,
    ...(eligible < MIN_SENTENCES ? { weak: `fewer than ${MIN_SENTENCES} sentences of at least ${EIGHT} tokens` } : {}),
    note: `Share of sentences (at least ${EIGHT} tokens) with half or more of their tokens inside 8-grams an earlier section already used; the abstract counts as the first section.`,
  });
}

// ---------------------------------------------------------------------------------------------------------------- citation isolation

const RELATED = /introduction|related|background|prior|literature|previous work/i;
const NAMED_WORK = /\b[A-Z][A-Za-z-]+(?:\s+et\s+al\.?|\s+(?:and|&)\s+[A-Z][A-Za-z-]+|\s*\(\d{4}\))/g;
/** A second work is named outside a citation command when a name is not just the label of the work cited right after it ("Smith et al. \\cite{x}"). */
function namesSecondWork(sentence: string): boolean {
  const names = [...sentence.matchAll(NAMED_WORK)];
  const loose = names.filter((m) => !/^\s*[(,]?\s*\\cite/.test(sentence.slice(m.index! + m[0].length, m.index! + m[0].length + 24)));
  return loose.length > 0 || new Set(names.map((m) => m[0].toLowerCase())).size >= 2;
}

export function measureCitationIsolation(p: Paper): Measure {
  const units: Unit[] = [];
  let citing = 0;
  for (const s of p.sections) {
    if (!RELATED.test(s.title)) continue;
    const raw = p.text.slice(s.contentStart, s.end);
    const masked = mask(raw, { floats: true, math: true });
    for (const [a, z] of sentenceRanges(masked)) {
      const sentence = raw.slice(a, z);
      const keys = new Set<string>();
      for (const m of sentence.matchAll(CITE_CMD)) for (const k of m[1]!.split(",")) if (k.trim() !== "") keys.add(k.trim());
      if (keys.size === 0) continue;
      citing++;
      const weaves = keys.size >= 2 || namesSecondWork(sentence);
      if (!weaves) units.push({ where: p.where(s.contentStart + a), section: s.title, excerpt: clip(sentence) });
    }
  }
  return finish({
    id: "citation_isolation", name: "Citation isolation", flagged: units.length, total: citing, units,
    ...(citing < MIN_CITING ? { weak: `fewer than ${MIN_CITING} citing sentences in the introduction and related work` } : {}),
    note: "Share of citing sentences of the introduction and related work that cite a single work and name no second one: the work is cited, not related to another. A cue word between two works is not needed, because two works already weave; the paper's cue list is not published, and adding cue words made agreement with its scores worse.",
  });
}

// ---------------------------------------------------------------------------------------------------------------- evidence gap

const EXHIBIT_ENVS = ["lstlisting", "verbatim", "Verbatim", "minted", "tcolorbox", "mdframed", "tcblisting", "promptbox"];
const EXHIBIT_CAPTION = /\b(?:examples?|case stud(?:y|ies)|qualitative|failure (?:cases?|modes?)|samples? (?:inputs?|outputs?|generations?)|transcripts?)\b/i;

function resultTables(p: Paper): Array<{ offset: number }> {
  const found: Array<{ offset: number }> = [];
  for (const [a, z] of envRanges(p.text.slice(0, p.bodyEnd), ["tabular", "tabular*", "tabularx", "longtable"])) {
    if (a < p.bodyStart) continue;
    const rows = p.text.slice(a, z).split(/\\\\/).map((r) => r.split("&"));
    const numeric = (cell: string): boolean => /^[\s$+\-−]*\d+(?:[.,]\d+)?\s*(?:\\pm\s*\d+(?:\.\d+)?|\\%|%)?[\s$]*$/.test(cell.replace(/\\(?:textbf|textit|underline|mathbf|bf)\s*\{([^}]*)\}/g, "$1").replace(/[{}]/g, ""));
    const dataRows = rows.filter((r) => r.some(numeric));
    const cells = dataRows.reduce((n, r) => n + r.filter(numeric).length, 0);
    if (dataRows.length >= 2 && cells >= 4) found.push({ offset: a });
  }
  return found;
}

function hasExhibit(p: Paper): boolean {
  if (envRanges(p.text, EXHIBIT_ENVS).length > 0 || /\\lstinputlisting\b/.test(p.text)) return true;
  for (let at = p.text.indexOf("\\caption"); at >= 0; at = p.text.indexOf("\\caption", at + 1)) {
    const g = braceGroup(p.text, p.text.indexOf("{", at));
    // "announcing": the caption opens with the word, not a passing "for example" in a method figure's description
    if (g && EXHIBIT_CAPTION.test(g.inner.replace(/\\[a-zA-Z]+\*?\s*\{?/g, " ").trim().slice(0, 60))) return true;
  }
  for (const [a, z] of envRanges(p.text, ["quote", "quotation"])) {
    const words = (p.text.slice(a, z).match(/[A-Za-z']+/g) ?? []).length;
    if (words >= 40 && !RELATED.test(titleOf(p, p.sectionAt(a)))) return true;
  }
  return false;
}

export function measureEvidenceGap(p: Paper): Measure {
  const tables = resultTables(p);
  if (tables.length === 0) {
    return finish({ id: "evidence_gap", name: "Evidence gap", flagged: 0, total: 0, units: [], note: "Not applicable: the body has no result table with two data rows and four numeric cells." });
  }
  const gap = !hasExhibit(p);
  const first = tables[0]!;
  return finish({
    id: "evidence_gap", name: "Evidence gap", flagged: gap ? 1 : 0, total: 1,
    units: gap ? [{ where: p.where(first.offset), section: titleOf(p, p.sectionAt(first.offset)), excerpt: "result table with no example, case, failure display, listing or long quotation anywhere in the paper (appendix included)" }] : [],
    note: "Paper-level: a result table in the body and no exhibit (a listing or boxed input/output, a caption announcing an example, case or failure, or a long quotation outside related work) anywhere, appendix included.",
  });
}

export function reviewPaper(p: Paper): Measure[] {
  return [measureCrossSectionRefs(p), measureMacroRedundancy(p), measureCitationIsolation(p), measureEvidenceGap(p)];
}

export function reviewLines(lines: SrcLine[]): Measure[] {
  return reviewPaper(parsePaper(lines));
}

export { FLOAT_ENVS };
