/**
 * Section-aware splitter: one chunking for retrieval and claim verification.
 *
 * Input: the captured text and the headings found in it. Output: chunks that
 * TILE the text (no gap, no overlap), each no longer than `maxChars`, each
 * labelled with the heading it starts under.
 *
 *  - a section that fits stays whole (its heading and body travel together);
 *  - a larger section is cut at sentence boundaries into balanced pieces, the
 *    first piece always keeping the heading line AND some body text;
 *  - a tiny whole section merges into a neighbour only when the result still
 *    fits (split pieces are never merged);
 *  - nothing here can break provenance: structure only moves boundaries and
 *    labels, so a wrong heading costs a worse chunk, never a wrong offset.
 *
 * Pure and deterministic. Sizes are characters (the caller converts tokens).
 */

import { cutPoint } from "./chunk.ts";

export interface SectionMark {
  /** Offset in the captured text where the heading line begins. */
  start: number;
  heading: string;
  /** 1 = top level. */
  level: number;
}

export interface SectionChunk {
  start: number;
  end: number;
  /** Heading of the (first) section this chunk covers; "" before the first heading. */
  section: string;
  /** Number of sections merged into this chunk (≥ 1). */
  sections: number;
  /** Piece index when one oversize section was split (0-based), and how many pieces. */
  part: number;
  parts: number;
}

export interface SplitOptions {
  maxChars: number;
  minChars: number;
}

interface Section {
  start: number;
  end: number;
  heading: string;
}

/** Marks that can be used: whole-number offsets inside the text, sorted, one per offset. */
function normalise(text: string, marks: SectionMark[]): SectionMark[] {
  const usable = marks.filter((m) => Number.isInteger(m.start) && m.start >= 0 && m.start < text.length);
  usable.sort((a, b) => a.start - b.start); // stable: for equal offsets the first given wins below
  const out: SectionMark[] = [];
  for (const m of usable) if (out.length === 0 || out[out.length - 1].start !== m.start) out.push(m);
  return out;
}

function toSections(text: string, marks: SectionMark[]): Section[] {
  const out: Section[] = [];
  if (marks.length === 0 || marks[0].start > 0) out.push({ start: 0, end: marks.length === 0 ? text.length : marks[0].start, heading: "" });
  marks.forEach((m, i) => out.push({ start: m.start, end: i + 1 < marks.length ? marks[i + 1].start : text.length, heading: m.heading }));
  return out;
}

/** First offset after the heading line that is past at least one body character (cuts must land beyond it). */
function bodyStart(text: string, section: Section): number {
  if (section.heading === "") return section.start;
  let nl = text.indexOf("\n", section.start);
  if (nl === -1 || nl >= section.end) return section.end;
  let i = nl + 1;
  while (i < section.end && /\s/.test(text[i])) i++;
  return Math.min(section.end, i + 1);
}

const isSpace = (text: string, i: number): boolean => /\s/.test(text[i]);

/**
 * The best cut in [lo, hi] (inclusive, text offsets): the sentence end nearest `prefer`, else the word
 * boundary nearest `prefer`, else `prefer` itself (never inside a surrogate pair). A cut is the offset
 * where the next piece begins, so a "boundary" is the first non-space after a space run.
 */
function nearestBoundary(text: string, lo: number, hi: number, prefer: number): number {
  let bestSentence = -1;
  let bestWord = -1;
  const dist = (x: number): number => Math.abs(x - prefer);
  for (let i = Math.max(lo, 1); i <= Math.min(hi, text.length); i++) {
    if (i >= text.length || isSpace(text, i) || !isSpace(text, i - 1)) continue; // i = first char after whitespace
    let k = i - 1;
    while (k > 0 && isSpace(text, k)) k--;
    const word = i;
    if (bestWord === -1 || dist(word) < dist(bestWord)) bestWord = word;
    let q = k;
    while (q > 0 && /["')\]]/.test(text[q])) q--;
    if (/[.!?]/.test(text[q]) && (bestSentence === -1 || dist(word) < dist(bestSentence))) bestSentence = word;
  }
  let cut = bestSentence !== -1 ? bestSentence : bestWord !== -1 ? bestWord : Math.min(Math.max(prefer, lo), hi);
  const c = text.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff && cut - 1 >= lo) cut--; // never between the halves of a surrogate pair
  return Math.min(Math.max(cut, lo), hi);
}

/** Cut one oversize section into pieces ≤ max, balanced, the first keeping heading + some body. */
function splitSection(text: string, section: Section, max: number, min: number): [number, number][] {
  const pieces: [number, number][] = [];
  let s = section.start;
  let guard = bodyStart(text, section);
  while (section.end - s > max) {
    const remaining = section.end - s;
    let cut: number;
    if (remaining <= 2 * max) {
      // Final split into two pieces: both within [min, max] whenever possible, sentence-aligned, near the middle.
      let lo = Math.max(1, min, remaining - max, guard - s);
      let hi = Math.min(max, remaining - min);
      if (lo > hi) {
        lo = Math.max(1, remaining - max);
        hi = Math.min(max, remaining - 1);
      }
      cut = nearestBoundary(text, s + lo, s + Math.max(lo, hi), s + Math.ceil(remaining / 2));
    } else {
      // Far from the end: fill to the cap, cutting at the last sentence end in the window.
      const hardEnd = s + max;
      if (guard >= hardEnd) cut = hardEnd;
      else {
        // Prefer the last sentence end, but never leave a piece below `min` (e.g. one short sentence before an unbroken run).
        const lo = Math.max(1, min, guard - s);
        const wanted = Math.min(hardEnd, Math.max(guard, cutPoint(text, Math.max(s, Math.min(guard, hardEnd - 1)), hardEnd)));
        cut = wanted - s >= lo ? wanted : nearestBoundary(text, s + lo, hardEnd, hardEnd);
      }
    }
    if (cut <= s) cut = Math.min(section.end, s + 1);
    pieces.push([s, cut]);
    s = cut;
    guard = s;
  }
  pieces.push([s, section.end]);
  return pieces;
}

export function splitBySections(text: string, marks: SectionMark[], opts: SplitOptions): SectionChunk[] {
  if (text.length === 0) return [];
  const max = Math.max(1, Math.floor(opts.maxChars));
  const min = Math.max(0, Math.min(Math.floor(opts.minChars), Math.floor(max / 2)));
  const sections = toSections(text, normalise(text, marks));

  const units: SectionChunk[] = [];
  for (const sec of sections) {
    if (sec.end <= sec.start) continue;
    if (sec.end - sec.start <= max) {
      units.push({ start: sec.start, end: sec.end, section: sec.heading, sections: 1, part: 0, parts: 1 });
      continue;
    }
    const pieces = splitSection(text, sec, max, min);
    pieces.forEach(([a, b], i) => units.push({ start: a, end: b, section: sec.heading, sections: 1, part: i, parts: pieces.length }));
  }

  // Merge tiny whole sections into a neighbour while the result fits.
  const out: SectionChunk[] = [];
  for (const u of units) {
    const cur = out[out.length - 1];
    const tiny = cur !== undefined && (cur.end - cur.start < min || u.end - u.start < min);
    if (cur !== undefined && cur.parts === 1 && u.parts === 1 && tiny && u.end - cur.start <= max) {
      cur.end = u.end;
      cur.sections += u.sections;
    } else out.push({ ...u });
  }
  return out;
}
