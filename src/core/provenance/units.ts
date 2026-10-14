/**
 * Statements, table rows and captions of a manuscript body, each with its file and line, and the reader-visible word count.
 * Heuristics over LaTeX text, not a TeX engine (the same stance as `review/latex.ts`, whose expanded source and body cut this reads).
 */
import { braceGroup, type Paper } from "../review/latex.ts";

export interface Unit {
  id: string;
  kind: "sentence" | "row" | "caption";
  file: string;
  line: number;
  /** Title of the section the unit is in ("" before the first one). */
  section: string;
  /** The unit as written (TeX), without its comments. */
  raw: string;
  /** Plain text: no cite command, tie or escape, math reduced to its symbols; a table row joins its cells with " | ". */
  plain: string;
  /** Citation keys inside the unit (a row's keys apply to every cell of the row). */
  cites: string[];
}

const CITE = /\\(?:cite\w*|Cite\w*|parencite|textcite|autocite|nocite)\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]*)\}/g;
const TABLE_BEGIN = /\\begin\{(tabular\*?|tabularx|tabulary|longtable\*?)\}/g;
const HEADING = /\\(?:chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*(?=\{)/g;
const RULE = /^(?:\\(?:toprule|midrule|bottomrule|hline|endhead|endfoot|endfirsthead|endlastfoot)\b|\\cline\{[^}]*\}|\\cmidrule\s*(?:\([^)]*\))?\s*\{[^}]*\}|\\specialrule\{[^}]*\}\{[^}]*\}\{[^}]*\})/;
const ABBREVIATION = /(?:\b(?:e\.g|i\.e|et al|vs|fig|figs|eq|eqs|sec|tab|cf|approx|resp|etc|no|dr|mr|ms)|\b[A-Z])$/i;
const MATH_SYMBOLS: Array<[RegExp, string]> = [
  [/\\times\b/g, "×"], [/\\sim\b/g, "~"], [/\\to\b/g, "→"], [/\\rightarrow\b/g, "→"], [/\\approx\b/g, "≈"],
  [/\\leq?\b/g, "≤"], [/\\geq?\b/g, "≥"], [/\\pm\b/g, "±"], [/\\cdot\b/g, "·"],
];

function citesOf(text: string): string[] {
  const keys: string[] = [];
  for (const m of text.matchAll(CITE)) for (const k of (m[1] ?? "").split(",")) if (k.trim() !== "") keys.push(k.trim());
  return [...new Set(keys)];
}

function mathText(inner: string): string {
  let s = inner;
  for (const [re, to] of MATH_SYMBOLS) s = s.replace(re, to);
  return s.replace(/\\[a-zA-Z]+/g, " ").replace(/[{}^_]/g, "").replace(/\s+/g, " ").trim();
}

/** TeX text to the plain wording a reader sees (and a claim would be phrased in). */
export function toPlain(raw: string): string {
  let s = raw;
  s = s.replace(/~?\s*\\(?:cite\w*|Cite\w*|parencite|textcite|autocite|nocite)\*?\s*(?:\[[^\]]*\]\s*)*\{[^}]*\}/g, "");
  s = s.replace(/~/g, " ");
  s = s.replace(/\\(?:label|ref|eqref|pageref|autoref|cref|Cref)\s*\{[^}]*\}/g, "");
  s = s.replace(/\$\$[\s\S]*?\$\$/g, " ").replace(/\\\[[\s\S]*?\\\]/g, " ");
  s = s.replace(/\$((?:[^$\\]|\\.)*)\$/g, (_m, inner: string) => mathText(inner));
  for (let i = 0; i < 4; i++) s = s.replace(/\\[a-zA-Z]+\*?(?:\s*\[[^\]]*\])*\s*\{([^{}]*)\}/g, "$1");
  s = s.replace(/\\([%&#$_{}])/g, "$1");
  s = s.replace(/\\[,;:! ]/g, " ").replace(/\\\\/g, " ");
  s = s.replace(/\\[a-zA-Z]+\*?/g, " ");
  s = s.replace(/[{}]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s.replace(/\s+([.,;:!?)\]])/g, "$1");
}

function hasWords(plain: string): boolean {
  return /\p{L}/u.test(plain);
}

export function extractUnits(paper: Paper): Unit[] {
  const body = paper.text.slice(0, paper.bodyEnd);
  const lo = paper.bodyStart;
  const m = body.split("");
  const mask = (a: number, b: number): void => {
    for (let i = a; i < b && i < m.length; i++) if (m[i] !== "\n") m[i] = " ";
  };
  const out: Array<Omit<Unit, "id">> = [];
  const push = (kind: Unit["kind"], offset: number, raw: string, plain: string, cites: string[]): void => {
    const pos = paper.where(offset);
    const sec = paper.sections[paper.sectionAt(offset)];
    out.push({ kind, file: pos.file, line: pos.line, section: sec?.title ?? "", raw: raw.trim(), plain, cites });
  };
  const at: number[] = []; // offsets keep the reading order across kinds
  const order: Array<{ offset: number; unit: Omit<Unit, "id"> }> = [];
  const emit = (kind: Unit["kind"], offset: number, raw: string, plain: string, cites: string[]): void => {
    const before = out.length;
    push(kind, offset, raw, plain, cites);
    order.push({ offset, unit: out[before]! });
    at.push(offset);
  };

  // 1. tables: one unit per row, then masked out of the prose
  TABLE_BEGIN.lastIndex = lo;
  for (let b = TABLE_BEGIN.exec(body); b !== null; b = TABLE_BEGIN.exec(body)) {
    const env = b[1]!;
    const endTag = `\\end{${env}}`;
    const endAt = body.indexOf(endTag, b.index);
    if (endAt < 0) continue;
    let p = b.index + b[0].length;
    for (let args = 0; args < (/^(?:tabularx|tabulary|tabular\*)$/.test(env) ? 2 : 1); args++) {
      while (/\s/.test(body[p] ?? "")) p++;
      if (body[p] === "[") p = body.indexOf("]", p) + 1;
      while (/\s/.test(body[p] ?? "")) p++;
      const g = braceGroup(body, p);
      if (g === undefined) break;
      p = g.end;
    }
    const inner = body.slice(p, endAt);
    let rowStart = 0;
    const sep = /\\\\(?:\s*\[[^\]]*\])?/g;
    const cuts: Array<[number, number]> = [];
    for (let s = sep.exec(inner); s !== null; s = sep.exec(inner)) {
      cuts.push([rowStart, s.index]);
      rowStart = s.index + s[0].length;
    }
    cuts.push([rowStart, inner.length]);
    for (const [a, z] of cuts) {
      let q = a;
      for (;;) {
        while (q < z && /\s/.test(inner[q]!)) q++;
        const rule = RULE.exec(inner.slice(q, z));
        if (rule === null) break;
        q += rule[0].length;
      }
      const raw = inner.slice(q, z);
      if (raw.trim() === "") continue;
      const cells = raw.split(/(?<!\\)&/).map((c) => toPlain(c));
      const plain = cells.join(" | ").replace(/(?: \| )+$/, "");
      if (!hasWords(plain) && !/\d/.test(plain)) continue;
      emit("row", p + q, raw, plain, citesOf(raw));
    }
    mask(b.index, endAt + endTag.length);
  }

  // 2. captions
  const cap = /\\caption(?:of)?\*?\s*(?:\[[^\]]*\])?\s*(?=\{)/g;
  cap.lastIndex = lo;
  for (let c = cap.exec(m.join("")); c !== null; c = cap.exec(m.join(""))) {
    const g = braceGroup(m.join(""), c.index + c[0].length);
    if (g === undefined) continue;
    const plain = toPlain(g.inner);
    if (hasWords(plain)) emit("caption", c.index + c[0].length + 1, g.inner, plain, citesOf(g.inner));
    mask(c.index, g.end);
  }

  // 3. headings and displays are not statements
  const heading = new RegExp(HEADING.source, "g");
  heading.lastIndex = lo;
  const masked0 = m.join("");
  for (let h = heading.exec(masked0); h !== null; h = heading.exec(masked0)) {
    const g = braceGroup(masked0, h.index + h[0].length);
    if (g !== undefined) mask(h.index, g.end);
  }
  const display = /\\begin\{(equation\*?|align\*?|displaymath|eqnarray\*?)\}[\s\S]*?\\end\{\1\}|\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/g;
  const masked1 = m.join("");
  for (let d = display.exec(masked1); d !== null; d = display.exec(masked1)) if (d.index >= lo) mask(d.index, d.index + d[0].length);

  // 4. prose: sentences outside braces and math, split at terminal punctuation, blank lines and \item
  const s = m.join("");
  let start = lo;
  let depth = 0;
  let inMath = false;
  const flush = (end: number): void => {
    const raw = s.slice(start, end);
    const plain = toPlain(raw.replace(/\\(?:begin|end)\s*\{[^}]*\}(?:\[[^\]]*\])?/g, " ").replace(/\\item\b/g, " "));
    if (hasWords(plain) && plain.length > 3) {
      const first = start + (raw.length - raw.trimStart().length);
      emit("sentence", first, raw, plain, citesOf(raw));
    }
    start = end;
  };
  for (let i = lo; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\") {
      if (/^\\item\b/.test(s.slice(i, i + 6)) && depth === 0) { flush(i); }
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (c === "$") inMath = !inMath;
    else if (depth === 0 && !inMath) {
      if (c === "\n" && /^\n[ \t]*\n/.test(s.slice(i, i + 40))) { flush(i); continue; }
      if ((c === "." || c === "?" || c === "!") && /^[ \t]*(?:\n[ \t]*)?(?:$|[A-Z0-9\\$"“'(\[])/.test(s.slice(i + 1, i + 8)) && (i + 1 >= s.length || /\s/.test(s[i + 1]!))) {
        if (c === "." && ABBREVIATION.test(s.slice(Math.max(lo, i - 8), i))) continue;
        flush(i + 1);
      }
    }
  }
  flush(s.length);

  return order
    .sort((a, b) => a.offset - b.offset)
    .map((o, i) => ({ id: `u${i + 1}`, ...o.unit }));
}

// ── words ───────────────────────────────────────────────────────────────────

const stripTexComments = (tex: string): string =>
  tex
    .split("\n")
    .map((line) => {
      let cut = -1;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "%" && (i === 0 || line[i - 1] !== "\\")) { cut = i; break; }
      }
      return cut < 0 ? line : line.slice(0, cut);
    })
    .join("\n");

/** Remove a command and all its `[...]` options and balanced `{...}` arguments. */
function dropCommandArgs(text: string, names: string[]): string {
  const re = new RegExp(`\\\\(?:${names.join("|")})\\*?`, "g");
  let out = "";
  let last = 0;
  for (let mm = re.exec(text); mm !== null; mm = re.exec(text)) {
    out += text.slice(last, mm.index);
    let i = mm.index + mm[0].length;
    for (;;) {
      const rest = text.slice(i);
      const opt = /^\s*\[[^\]]*\]/.exec(rest);
      if (opt !== null) { i += opt[0].length; continue; }
      const open = /^\s*\{/.exec(rest);
      if (open === null) break;
      i += open[0].length;
      let d = 1;
      while (i < text.length && d > 0) {
        if (text[i] === "{") d += 1;
        else if (text[i] === "}") d -= 1;
        i += 1;
      }
    }
    out += " ";
    last = i;
  }
  return out + text.slice(last);
}

function bodyRange(entryTex: string): string {
  const begin = entryTex.indexOf("\\begin{document}");
  const from = begin < 0 ? entryTex : entryTex.slice(begin + "\\begin{document}".length);
  const bib = /\\bibliography\{|\\printbibliography\b/.exec(from);
  if (bib !== null) return from.slice(0, bib.index);
  const end = from.indexOf("\\end{document}");
  return end < 0 ? from : from.slice(0, end);
}

function reduceToWords(s: string): string {
  let t = dropCommandArgs(s, ["begin", "end"]);
  t = t.replace(/\$\$[\s\S]*?\$\$/g, " ");
  t = t.replace(/\$(?:[^$\\]|\\.)*?\$/g, " ");
  t = t.replace(/\\\[[\s\S]*?\\\]/g, " ");
  t = t.replace(/\\\([\s\S]*?\\\)/g, " ");
  t = t.replace(/\\begin\{equation\*?\}[\s\S]*?\\end\{equation\*?\}/g, " ");
  t = t.replace(/\\(?:input|include)\s*\{[^{}]*\}/g, " ");
  t = t.replace(/\\(?:cite\w*|Cite\w*|nocite)\s*(?:\[[^\]]*\]\s*)*\{[^{}]*\}/g, " ");
  t = t.replace(/\\(?:label|ref|eqref|pageref)\s*\{[^{}]*\}/g, " ");
  t = t.replace(/\\includegraphics\s*(?:\[[^\]]*\]\s*)*\{[^{}]*\}/g, " ");
  t = t.replace(/\\[a-zA-Z]+\*?(?:\s*\[[^\]]*\])*\s*\{([^{}]*)\}/g, "$1");
  t = t.replace(/\\\\/g, " ");
  t = t.replace(/\\[a-zA-Z]+\*?/g, " ");
  t = t.replace(/[{}]/g, " ");
  t = t.replace(/\\([%&#$_{}])/g, "$1");
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Words a reader sees in the body: comments stripped, math and citations removed, table cells and captions counted; the title block
 * and bibliography are outside. This is the definition the live harness's length check uses (parity is tested), so the number the
 * agent is shown is the number it is judged on.
 */
export function countBodyWords(entryTex: string): number {
  const text = reduceToWords(stripTexComments(bodyRange(entryTex)));
  if (text === "") return 0;
  return text.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
