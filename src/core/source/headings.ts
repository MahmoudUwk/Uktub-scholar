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
/** A References/Bibliography section heading: units under it are excluded from judging. */
export const REFERENCES = /^(?:references|bibliography)$/i;
const APPENDIX = /^appendi(?:x|ces)\b/i;

/** After References only: an appendix opener with trailing content ("APPENDIX CONTENTS", "Supplementary Materials: ..."). */
const APPENDIX_PREFIX = /^(?:appendix|appendices|supplementary\s+materials?)\b/i;
/** After References only: boilerplate openers that are exactly the whole line. */
const APPENDIX_BOILERPLATE = /^(?:summary\s+of\s+the\s+appendix|ai\s+use\s+statement|tables|figures|checklists?|author\s+contributions?|impact\s+statements?)$/i;
/** A canonical appendix-family line ("Appendix A", "Supplementary Information") also ends the references span. */
const APPENDIX_CANONICAL = /^(?:appendix|appendices|supplementary)\b/i;
/** After References only: lettered appendix headings — "A.1 Title", "A1. Title", "S1.1. Title" (never "B. Title": that shape is author initials inside entries). */
const APPENDIX_LETTERED_NUM = /^([A-E])\.(\d+(?:\.\d+)*)\.?\s+(\S.*)$/;
const APPENDIX_LETTERED_DIGIT = /^([A-ES])(\d+(?:\.\d+)*)\.\s+(\S.*)$/;
/** After References only: supplement numbering with or without a trailing period — "S1 Title", "S1.1 Title". */
const APPENDIX_SUPPLEMENT_NUM = /^(S)(\d+(?:\.\d+)*)\.?\s+(\S.*)$/;
/** After References only: "A Title Words" (never a bare initial: that shape is entry text). */
const APPENDIX_LETTERED_PLAIN = /^([A-E])\s+([A-Z].*)$/;
/** A single-word lettered title only when it is itself a section word ("A Appendix", "A Limitations"). */
const APPENDIX_SINGLE_WORD = /^(?:appendix|appendices|limitations|references|bibliography|abstract|introduction|conclusion|acknowledg\w*)$/i;
/** Bibliography-entry tell on a candidate line: years, venues, publishers, ids. */
const ENTRY_SIG = /\(\d{4}[a-z]?\)|et al\.|arXiv|In Proceedings|Proceedings of|pp\.\s*\d|doi|https?:\/\/|Vol\.|volume\s+\d|pages?\s+\d|Press\b|Springer|University|thesis|Technical report|ISBN|editor|\b(19|20)\d{2}[;.:)]/;
/** A wrapped entry subtitle follows a colon ("Reviews:" / "(SyLECT):"); a true heading never does. */
const WRAPPED_SUBTITLE = /:\s*$/;

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
  let inAppendix = false; // past an appendix start the lettered appendix shapes stay available
  let prevLine = ""; // the previous trimmed line: a wrapped entry subtitle follows a colon
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end).trim();
    if (line.length > 0 && line.length <= MAX_HEADING_CHARS) {
      const mark = classify(line, seenRoman, afterReferences, inAppendix, prevLine);
      if (mark !== null) {
        marks.push({ start, heading: line, level: mark.level });
        if (mark.roman) seenRoman = true;
        if (REFERENCES.test(line)) {
          afterReferences = true;
          inAppendix = false;
        }
        if (APPENDIX.test(line) || mark.appendix) {
          afterReferences = false;
          inAppendix = true;
          seenRoman = true;
        }
      }
    }
    if (line.length > 0) prevLine = line;
    start = end + 1;
  }
  return marks;
}

function classify(line: string, seenRoman: boolean, afterReferences: boolean, inAppendix: boolean, prevLine: string): { level: number; roman: boolean; appendix: boolean } | null {
  if (CANONICAL.test(line)) return { level: 1, roman: false, appendix: APPENDIX_CANONICAL.test(line) };
  if (afterReferences) return classifyAppendix(line, prevLine);
  const num = classifyNumbered(line, seenRoman);
  if (num !== null || !inAppendix) return num;
  return classifyAppendix(line, prevLine);
}

function classifyNumbered(line: string, seenRoman: boolean): { level: number; roman: boolean; appendix: false } | null {
  const m = NUMBERED.exec(line);
  if (m === null) return null;
  const [, arabic, roman, letter, title] = m;
  // A numbered heading may carry a canonical name in any case ("1. introduction" is rare, "1. INTRODUCTION" is not).
  if (!titleOk(title)) return null;
  if (arabic !== undefined) {
    if (arabic.startsWith("0")) return null; // "0.11 USD/day": a number, never a section
    return { level: arabic.split(".").length, roman: false, appendix: false };
  }
  if (roman !== undefined) return { level: 1, roman: true, appendix: false };
  if (letter !== undefined && seenRoman) return { level: 2, roman: false, appendix: false };
  return null;
}

/**
 * Past a References/Bibliography heading the bibliography ends where the appendix begins.
 * Strict: every candidate carrying an entry tell (year, venue, id, trailing period) or
 * following a colon (a wrapped entry subtitle) is rejected — a missed heading only drops
 * appendix text, but a false positive would let bibliography entries be judged.
 */
function classifyAppendix(line: string, prevLine: string): { level: number; roman: boolean; appendix: boolean } | null {
  if (ENTRY_SIG.test(line) || /[.)]\s*$/.test(line)) return null;
  if (APPENDIX_PREFIX.test(line) || APPENDIX_BOILERPLATE.test(line)) return { level: 1, roman: false, appendix: true };
  const num = APPENDIX_LETTERED_NUM.exec(line) ?? APPENDIX_LETTERED_DIGIT.exec(line) ?? APPENDIX_SUPPLEMENT_NUM.exec(line);
  if (num !== null) {
    const [, , digits, title] = num;
    if (!titleOk(title)) return null;
    return { level: 1 + digits.split(".").length, roman: false, appendix: true };
  }
  const plain = APPENDIX_LETTERED_PLAIN.exec(line);
  if (plain !== null) {
    const [, , title] = plain;
    const words = title.split(/\s+/u);
    if (words.length > 12 || (words.length === 1 && !APPENDIX_SINGLE_WORD.test(title))) return null;
    if (!titleOk(title) || WRAPPED_SUBTITLE.test(prevLine)) return null;
    return { level: 1, roman: false, appendix: true };
  }
  return null;
}
