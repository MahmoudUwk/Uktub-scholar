/**
 * Heading detection for extracted PDF text. unpdf keeps the page's hard-wrapped lines, so a
 * heading is a short standalone line that is a canonical section name or carries a section
 * number. Strict by design: the splitter tiles the text whatever the marks are, so a wrong
 * mark can only mislabel or shift a boundary, never break a pointer — but labels travel with
 * evidence, so false positives (titles, units, table rows, reference entries) are tested.
 *
 * TEI sources do not use this: GROBID already marks `<head>` elements exactly.
 */
import type { SectionMark } from "../sections.ts";

/** Client policy: a heading line is at most this long (trimmed); longer lines are prose. */
const MAX_HEADING_CHARS = 80;
/** Client policy: and at most this many words. */
const MAX_HEADING_WORDS = 12;

const CANONICAL =
  /^(?:abstract|introduction|background|related works?|preliminaries|(?:materials? and )?methods?|methodology|experiments?|experimental (?:setup|results)|evaluation|results?(?: and discussion)?|discussion|conclusions?(?: and future work)?|future work|limitations|acknowledge?ments?|references|bibliography|appendi(?:x|ces)(?: [a-z0-9]{1,3})?|supplementary (?:material|information))$/i;
const REFERENCES = /^(?:references|bibliography)$/i;
const APPENDIX = /^appendi(?:x|ces)\b/i;

/** group 1 arabic (1, 2.1, 2.1.3), 2 roman (needs "."), 3 capital letter (needs "."), 4 the title part. */
const NUMBERED = /^(?:(\d{1,2}(?:\.\d{1,2}){0,3})\.?|([IVX]{1,6})\.|([A-Z])\.)\s+(\S.*)$/u;

/** A heading never ends on one of these: the line was cut mid-sentence by a page wrap. */
const TRAILING_FUNCTION_WORD = /\b(?:the|of|and|in|to|a|an|for|with|on|by|from|at|or|is|are|that|as|via)$/i;
/** "10 MHz", "2.4 GHz": a number followed by a unit is a quantity, not a section. */
const UNIT = /^(?:[kMGT]?Hz|dB[a-z]*|[kMGT]?[Ss]ps|[kMGT]?bps|ms|km|cm|mm|kg|%)(?![\p{L}\p{N}])/u;
/** Pseudocode, equations and math-italic letters: algorithm listings are numbered line by line. */
const MATH = /[←→⇒=×∑∫≤≥±<>{}|∈∀∃∧∨]|[\u{1D400}-\u{1D7FF}]/u;
/** Figure panel marker "(b)". */
const PANEL = /\([a-h]\)/;
const NUMERIC_TOKEN = /^[\d.,:%]+$/;
/** Author-list tell: ", J." / ", J.-P." after a name. */
const INITIALS_AFTER_COMMA = /,\s*[A-Z]\.(?:-[A-Z]\.)?(?:\s|,|$)/;

function titleOk(title: string): boolean {
  if (!/^(?:\p{Lu}|\d+\p{L})/u.test(title)) return false;
  if (/[.,;:]$/.test(title) || title.includes(";") || INITIALS_AFTER_COMMA.test(title) || /\(\d{4}\)/.test(title)) return false;
  if (/-$/.test(title) || TRAILING_FUNCTION_WORD.test(title) || MATH.test(title) || PANEL.test(title) || UNIT.test(title)) return false;
  const words = title.split(/\s+/u);
  const numeric = words.filter((w) => NUMERIC_TOKEN.test(w)).length;
  if (numeric >= 2 || (numeric >= 1 && words.length <= 2)) return false; // table rows, dates
  return words.length <= MAX_HEADING_WORDS;
}

export function detectHeadings(text: string): SectionMark[] {
  const marks: SectionMark[] = [];
  let seenRoman = false; // lettered "A. Dataset" subsections only follow a roman-numbered section or an appendix
  let afterReferences = false; // reference-list entries look numbered; past References only canonical names count
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end).trim();
    if (line.length > 0 && line.length <= MAX_HEADING_CHARS) {
      const mark = classify(line, seenRoman, afterReferences);
      if (mark !== null) {
        marks.push({ start, heading: line, level: mark.level });
        if (mark.roman) seenRoman = true;
        if (REFERENCES.test(line)) afterReferences = true;
        if (APPENDIX.test(line)) {
          afterReferences = false;
          seenRoman = true;
        }
      }
    }
    start = end + 1;
  }
  return marks;
}

function classify(line: string, seenRoman: boolean, afterReferences: boolean): { level: number; roman: boolean } | null {
  if (CANONICAL.test(line)) return { level: 1, roman: false };
  if (afterReferences) return null;
  const m = NUMBERED.exec(line);
  if (m === null) return null;
  const [, arabic, roman, letter, title] = m;
  // A numbered heading may carry a canonical name in any case ("1. introduction" is rare, "1. INTRODUCTION" is not).
  if (!titleOk(title)) return null;
  if (arabic !== undefined) {
    if (arabic.startsWith("0")) return null; // "0.11 USD/day": a number, never a section
    return { level: arabic.split(".").length, roman: false };
  }
  if (roman !== undefined) return { level: 1, roman: true };
  if (letter !== undefined && seenRoman) return { level: 2, roman: false };
  return null;
}
