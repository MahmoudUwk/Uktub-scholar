/**
 * LaTeX structure for the manuscript review: the document expanded in reading order (`\input` resolved, comments removed), with the
 * file and line of every character kept, the body cut where the appendix, acknowledgements or bibliography begin, and the numbered
 * sections located. Heuristics, not a TeX engine: macros that generate sections or labels are not seen.
 */
export interface SrcLine { file: string; line: number; text: string }
export interface Pos { file: string; line: number }
export interface Section {
  /** Position in `paper.sections`. */
  index: number;
  title: string;
  /** Unstarred sections carry a printed number; starred ones are containers only. */
  number: number | null;
  /** Offsets into `paper.text`: the heading starts at `start`, the section ends where the next one (or the body) ends. */
  start: number;
  /** Where the section's text begins (after the heading). */
  contentStart: number;
  end: number;
}
export interface Paper {
  text: string;
  where(offset: number): Pos;
  /** The body: from after `\begin{document}` to the first appendix, acknowledgements or bibliography. */
  bodyStart: number;
  bodyEnd: number;
  sections: Section[];
  /** Section index containing the offset; -1 before the first section (title, abstract). */
  sectionAt(offset: number): number;
}

const MAX_DEPTH = 8;

/** Remove an unescaped `%` comment from one line. */
export function stripComment(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\") { out += c + (s[i + 1] ?? ""); i++; continue; }
    if (c === "%") break;
    out += c;
  }
  return out;
}

export function linesFromString(text: string, file = "main.tex"): SrcLine[] {
  return text.split("\n").map((t, i) => ({ file, line: i + 1, text: stripComment(t) }));
}

const INPUT = /\\(?:input|include|subfile)\s*\{([^}]+)\}/;

/**
 * Expand `\input`, `\include` and `\subfile` the way the compile does (names relative to the entry's folder, `.tex` optional).
 * `read` returns a project file's text by project-relative path, or undefined when it is missing or not readable inside the project.
 */
export function expandSource(read: (rel: string) => string | undefined, entryRel: string): SrcLine[] {
  const dir = entryRel.includes("/") ? entryRel.slice(0, entryRel.lastIndexOf("/") + 1) : "";
  const walk = (rel: string, stack: string[]): SrcLine[] => {
    const text = read(rel);
    if (text === undefined) return [];
    const out: SrcLine[] = [];
    text.split("\n").forEach((raw, i) => {
      let rest = stripComment(raw);
      for (;;) {
        const m = INPUT.exec(rest);
        if (m === null || stack.length >= MAX_DEPTH) { out.push({ file: rel, line: i + 1, text: rest }); return; }
        const name = m[1]!.trim();
        const child = `${dir}${name}`.replace(/\/+/g, "/");
        const childRel = /\.[A-Za-z]+$/.test(name) ? child : `${child}.tex`;
        const before = rest.slice(0, m.index);
        if (before.trim() !== "") out.push({ file: rel, line: i + 1, text: before });
        if (!stack.includes(childRel)) out.push(...walk(childRel, [...stack, childRel]));
        rest = rest.slice(m.index + m[0].length);
        if (rest.trim() === "") return;
      }
    });
    return out;
  };
  return walk(entryRel, [entryRel]);
}

const BODY_END = [
  /\\appendix\b/,
  /\\begin\s*\{thebibliography\}/,
  /\\bibliography\s*\{/,
  /\\printbibliography\b/,
  /\\begin\s*\{(?:ack|acknowledg(?:e)?ments?)\*?\}/i,
  /\\(?:sub)*section\*?\s*\{\s*(?:acknowledg|references|bibliography)/i,
  /\\end\s*\{document\}/,
];

/** `{...}` group starting at the `{` at `open`, with nested braces; returns the inside and the offset after the closing brace. */
export function braceGroup(text: string, open: number): { inner: string; end: number } | undefined {
  if (text[open] !== "{") return undefined;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return { inner: text.slice(open + 1, i), end: i + 1 }; }
  }
  return undefined;
}

export function plainTitle(raw: string): string {
  return raw.replace(/\\[a-zA-Z@]+\*?/g, " ").replace(/[{}$~]/g, " ").replace(/\s+/g, " ").trim();
}

export function parsePaper(lines: SrcLine[]): Paper {
  const text = lines.map((l) => l.text).join("\n");
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) { starts.push(at); at += l.text.length + 1; }
  const where = (offset: number): Pos => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid; else hi = mid - 1;
    }
    const l = lines[lo] ?? { file: "main.tex", line: 1 };
    return { file: l.file, line: l.line };
  };
  const begin = /\\begin\s*\{document\}/.exec(text);
  const bodyStart = begin ? begin.index + begin[0].length : 0;
  let bodyEnd = text.length;
  for (const re of BODY_END) {
    const m = re.exec(text.slice(bodyStart));
    if (m !== null) bodyEnd = Math.min(bodyEnd, bodyStart + m.index);
  }
  const headings: Array<{ start: number; end: number; title: string; starred: boolean }> = [];
  const re = /\\section(\*?)\s*(?:\[[^\]]*\])?\s*(?=\{)/g;
  const body = text.slice(0, bodyEnd);
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    if (m.index < bodyStart) continue;
    const g = braceGroup(body, m.index + m[0].length);
    if (g === undefined) continue;
    headings.push({ start: m.index, end: g.end, title: plainTitle(g.inner), starred: m[1] === "*" });
  }
  let n = 0;
  const sections: Section[] = headings.map((h, i) => ({
    index: i,
    title: h.title,
    number: h.starred ? null : ++n,
    start: h.start,
    contentStart: h.end,
    end: headings[i + 1]?.start ?? bodyEnd,
  }));
  const sectionAt = (offset: number): number => {
    let found = -1;
    for (const s of sections) if (offset >= s.start && offset < s.end) found = s.index;
    return found;
  };
  return { text, where, bodyStart, bodyEnd, sections, sectionAt };
}
