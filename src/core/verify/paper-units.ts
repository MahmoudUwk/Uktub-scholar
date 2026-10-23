/**
 * Paper units: whole-section judging units for claim verification.
 *
 * A unit is a section (or a sentence-cut piece of an oversize section) from
 * `splitBySections(text, marks, { maxChars: cap, minChars: 0 })`. Units tile
 * the text; a unit whose section label is a References/Bibliography heading
 * carries `references: true` and is excluded from judging (disclosed).
 */
import { splitBySections, type SectionMark } from "../sections.ts";
import { REFERENCES } from "../source/headings.ts";
import { passageHashOf } from "./store.ts";

/** Client policy: a judging unit is at most this many chars (hosted max state 32,000 chars per GET /api/info). */
export const SECTION_UNIT_MAX_CHARS = 16_000;

export interface PaperUnit {
  /** Offset in the captured text where the unit begins. */
  start: number;
  /** Offset where the unit ends (exclusive). */
  end: number;
  /** Heading of the section the unit starts under ("" before the first heading). */
  section: string;
  /** The exact captured span. */
  text: string;
  /** sha256 of the span (the judgment cache key). */
  hash: string;
  /** True when the unit's section is a References/Bibliography section. */
  references: boolean;
}

/** Whole-section units over the text, each at most `cap` chars. */
export function paperUnits(text: string, marks: SectionMark[], cap: number = SECTION_UNIT_MAX_CHARS): PaperUnit[] {
  return splitBySections(text, marks, { maxChars: cap, minChars: 0 }).map((c) => {
    const slice = text.slice(c.start, c.end);
    return { start: c.start, end: c.end, section: c.section, text: slice, hash: passageHashOf(slice), references: REFERENCES.test(c.section) };
  });
}
