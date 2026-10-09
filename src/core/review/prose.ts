/** Prose view of LaTeX for the review measures: masking, sentence boundaries and tokens. Heuristics over source text, not a TeX parser. */
import { braceGroup } from "./latex.ts";

export const CITE_CMD = /\\(?:cite[a-zA-Z]*|parencite|textcite|autocite|smartcite|footcite|nocite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^}]*)\}/g;
export const REF_CMD = /\\(?!href\b)[a-zA-Z]*[rR]ef\*?\s*\{([^}]*)\}/g; // \ref, \eqref, \cref, \autoref, \pageref and house macros such as \fref, \sref, \tref
export const FLOAT_ENVS = ["figure", "figure*", "table", "table*", "algorithm", "algorithm*", "algorithm2e", "wrapfigure", "wraptable", "sidewaysfigure", "sidewaystable"];
export const MATH_ENVS = ["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "eqnarray", "eqnarray*", "displaymath", "flalign", "flalign*"];

const MASK = "\u0001";
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Ranges `[start, end)` of `\begin{name}…\end{name}` for the given environment names (outermost only). */
export function envRanges(text: string, names: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = new RegExp(`\\\\begin\\s*\\{(${names.map(escapeRe).join("|")})\\}`, "g");
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const name = m[1]!;
    const open = new RegExp(`\\\\begin\\s*\\{${escapeRe(name)}\\}|\\\\end\\s*\\{${escapeRe(name)}\\}`, "g");
    open.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = text.length;
    for (let t = open.exec(text); t !== null; t = open.exec(text)) {
      depth += t[0].startsWith("\\begin") ? 1 : -1;
      if (depth === 0) { end = t.index + t[0].length; break; }
    }
    out.push([m.index, end]);
    re.lastIndex = end;
  }
  return out;
}

const INLINE_MATH = /\$\$[\s\S]*?\$\$|\$[^$\n]*?\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g;

/** Same-length copy of `text` with the given kinds of region blanked (newlines kept), so offsets stay valid. */
export function mask(text: string, opts: { floats?: boolean; math?: boolean; cites?: boolean; refs?: boolean }): string {
  const chars = text.split("");
  const blank = (a: number, b: number): void => { for (let i = a; i < b && i < chars.length; i++) if (chars[i] !== "\n") chars[i] = MASK; };
  if (opts.floats) for (const [a, b] of envRanges(text, FLOAT_ENVS)) blank(a, b);
  if (opts.math) {
    for (const [a, b] of envRanges(text, MATH_ENVS)) blank(a, b);
    const flat = text.replace(/\\\$/g, "  ");
    for (let m = INLINE_MATH.exec(flat); m !== null; m = INLINE_MATH.exec(flat)) blank(m.index, m.index + m[0].length);
  }
  if (opts.cites) for (const m of text.matchAll(CITE_CMD)) blank(m.index!, m.index! + m[0].length);
  if (opts.refs) for (const m of text.matchAll(REF_CMD)) blank(m.index!, m.index! + m[0].length);
  return chars.join("");
}

const ABBREV = /(?:\bet al|\be\.g|\bi\.e|\bFigs?|\bEqs?|\bSecs?|\bTabs?|\bvs|\bcf|\bapprox|\bresp|\bDr|\bMr|\bMs|\bNo|\bw\.r\.t|\betc)$/;

/** Sentence ranges `[start, end)` of `masked` (blanked regions never split a sentence), trimmed of surrounding whitespace. */
export function sentenceRanges(masked: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  const push = (a: number, b: number): void => {
    let s = a;
    let e = b;
    while (s < e && /\s/.test(masked[s]!)) s++;
    while (e > s && /\s/.test(masked[e - 1]!)) e--;
    if (e > s) out.push([s, e]);
  };
  const re = /[.!?]+["')\]]*(?=\s)|\n[ \t]*\n/g;
  for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
    const end = m.index + m[0].length;
    if (m[0].startsWith("\n")) { push(start, m.index); start = end; continue; }
    if (ABBREV.test(masked.slice(Math.max(0, m.index - 8), m.index))) continue;
    const next = /\S/.exec(masked.slice(end));
    const c = next ? masked[end + next.index]! : "";
    if (c !== "" && !/[A-Z0-9"'(\[\\\u0001]/.test(c)) continue;
    push(start, end);
    start = end;
  }
  push(start, masked.length);
  return out;
}

/** Lower-case word tokens of LaTeX prose; mathematics, citations and references become the sentinels math, cite and ref. */
export function proseTokens(raw: string): string[] {
  let t = raw.replace(/\\\$/g, " usd ");
  for (const [a, b] of envRanges(t, [...FLOAT_ENVS, ...MATH_ENVS]).reverse()) t = `${t.slice(0, a)} ${t.slice(b)}`;
  t = t.replace(INLINE_MATH, " math ").replace(CITE_CMD, " cite ").replace(REF_CMD, " ref ").replace(/\\label\s*\{[^}]*\}/g, " ");
  for (const cmd of ["footnote", "footnotetext", "url", "thanks"]) {
    for (let at = t.indexOf(`\\${cmd}`); at >= 0; at = t.indexOf(`\\${cmd}`)) {
      const g = braceGroup(t, at + cmd.length + 1);
      t = g ? `${t.slice(0, at)} ${t.slice(g.end)}` : `${t.slice(0, at)} ${t.slice(at + cmd.length + 1)}`;
    }
  }
  t = t.replace(/\\href\s*\{[^}]*\}/g, " ").replace(/\\(?:begin|end)\s*\{[^}]*\}/g, " ").replace(/\\[a-zA-Z@]+\*?/g, " ").replace(/\\./g, " ");
  return (t.match(/[A-Za-z0-9]+(?:'[a-z]+)?/g) ?? []).map((w) => w.toLowerCase());
}
