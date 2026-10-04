/**
 * Deterministic paper chunker (KTD1): splits source text into chunks that fit
 * a decision-model token window, estimated offline via chars_per_token (no
 * runtime tokenizer — config names the factor). Pure: same text + same config
 * ⇒ byte-identical chunk sequence, stable indexes and content hashes, and
 * char offsets that always index the ORIGINAL text (no normalization).
 *
 * Boundaries: paragraph-aware by default (a chunk starts at a paragraph
 * break), greedy fill to the char target, oversized paragraphs cut at a
 * sentence end (else a word boundary) so an excerpt never splits a number
 * from its unit, ≤overlap carried across paragraph boundaries (continuity,
 * not context). `hard` is a literal fixed-width split (surrogate-safe).
 */

import { createHash } from "node:crypto";

export interface ChunkTextConfig {
  chunk_tokens: number;
  overlap_tokens: number;
  chars_per_token: number;
  boundary: "paragraph" | "hard";
}

export interface TextChunk {
  index: number;
  char_start: number;
  char_end: number;
  text: string;
  content_hash: string;
  est_tokens: number;
}

/** At least one character: a degenerate configuration must never produce an empty window (an endless loop). */
export function targetChars(cfg: ChunkTextConfig): number {
  return Math.max(1, Math.floor(cfg.chunk_tokens * cfg.chars_per_token));
}

export function overlapChars(cfg: ChunkTextConfig): number {
  return Math.floor(cfg.overlap_tokens * cfg.chars_per_token);
}

function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Share of a window searched backwards for a sentence end before settling for a word boundary. */
const SNAP_WINDOW_SHARE = 0.5;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/**
 * Where to cut a window that must end inside running text (KTD7: an excerpt
 * must not split a number from its unit or a qualifier from its claim). In
 * preference order: just after a sentence end (`. `, `? `, `! `) in the last
 * half of the window; just after any whitespace; the raw limit. Never inside
 * a surrogate pair. Returns an index in (start, hardEnd].
 */
function cutPoint(text: string, start: number, hardEnd: number): number {
  if (hardEnd >= text.length) return text.length;
  const lo = start + Math.floor((hardEnd - start) * SNAP_WINDOW_SHARE);
  const isSpace = (i: number): boolean => /\s/.test(text[i]);
  const afterSpaces = (i: number): number => {
    let j = i;
    while (j < hardEnd && isSpace(j)) j++;
    return j;
  };
  for (let i = hardEnd - 1; i > lo; i--) {
    // i is a candidate whitespace position preceded by a sentence terminator
    if (!isSpace(i) || isSpace(i - 1)) continue;
    let k = i - 1;
    while (k > start && /["')\]]/.test(text[k])) k--; // closing quote/paren after the terminator
    if (/[.!?]/.test(text[k])) return afterSpaces(i);
  }
  for (let i = hardEnd - 1; i > start; i--) if (isSpace(i) && !isSpace(i - 1)) return afterSpaces(i);
  return isHighSurrogate(text.charCodeAt(hardEnd - 1)) && hardEnd - 1 > start ? hardEnd - 1 : hardEnd;
}

export function chunkText(text: string, cfg: ChunkTextConfig): TextChunk[] {
  if (text.length === 0) return [];
  const target = targetChars(cfg);
  const overlap = overlapChars(cfg);

  // Paragraph starts; the end of the text closes the last paragraph.
  const starts: number[] = [0];
  if (cfg.boundary === "paragraph") {
    const re = /\n[ \t]*\n+/g;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const b = m.index + m[0].length;
      if (b < text.length) starts.push(b);
    }
  }
  const boundaries = [...starts.slice(1), text.length];

  const chunks: TextChunk[] = [];
  let index = 0;
  let start = 0;
  while (start < text.length) {
    let end: number;
    if (cfg.boundary === "hard") {
      end = Math.min(start + target, text.length);
      if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && end - 1 > start) end--;
    } else {
      // Greedy: extend through whole paragraphs while they fit the window.
      end = start;
      for (const b of boundaries) {
        if (b <= start) continue;
        if (b - start <= target) end = b;
        else break;
      }
      // A paragraph longer than the window is cut at a sentence/word boundary.
      if (end === start) end = cutPoint(text, start, Math.min(start + target, text.length));
    }
    const slice = text.slice(start, end);
    chunks.push({
      index,
      char_start: start,
      char_end: end,
      text: slice,
      content_hash: hash(slice),
      est_tokens: Math.ceil(slice.length / cfg.chars_per_token),
    });
    index++;
    if (end >= text.length) break;
    // Next start: the last paragraph boundary inside the overlap budget, else the cut itself.
    let next = end;
    if (cfg.boundary === "paragraph") {
      const candidates = starts.filter((b) => b > end - overlap && b < end);
      if (candidates.length > 0) next = candidates[candidates.length - 1];
      if (next <= start) next = end; // always progress
    }
    start = next;
  }
  return chunks;
}
