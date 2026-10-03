/**
 * Deterministic paper chunker (KTD1): splits source text into chunks that fit
 * a decision-model token window, estimated offline via chars_per_token (no
 * runtime tokenizer — config names the factor). Pure: same text + same config
 * ⇒ byte-identical chunk sequence, stable indexes and content hashes, and
 * char offsets that always index the ORIGINAL text (no normalization).
 *
 * Boundaries: paragraph-aware by default (a chunk starts at a paragraph
 * break), greedy fill to the char target, hard split for oversized
 * paragraphs, ≤overlap carried into the next chunk (continuity, not context).
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

export function targetChars(cfg: ChunkTextConfig): number {
  return Math.floor(cfg.chunk_tokens * cfg.chars_per_token);
}

export function overlapChars(cfg: ChunkTextConfig): number {
  return Math.floor(cfg.overlap_tokens * cfg.chars_per_token);
}

function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Compose the stable chunk id: "{doi}#c{index}". */
export function chunkId(doi: string, index: number): string {
  return `${doi}#c${index}`;
}

export function chunkText(text: string, cfg: ChunkTextConfig): TextChunk[] {
  if (text.length === 0) return [];
  const target = targetChars(cfg);
  const overlap = overlapChars(cfg);

  let starts: number[];
  if (cfg.boundary === "paragraph") {
    starts = [0];
    const re = /\n[ \t]*\n+/g;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const b = m.index + m[0].length;
      if (b < text.length) starts.push(b);
    }
  } else {
    starts = [];
    for (let o = 0; o < text.length; o += target) starts.push(o);
  }

  const chunks: TextChunk[] = [];
  let index = 0;
  let start = 0;
  while (start < text.length) {
    let end: number;
    if (cfg.boundary === "hard") {
      end = Math.min(start + target, text.length);
    } else {
      // Greedy: extend through whole paragraphs while within target.
      end = start;
      for (const b of starts) {
        if (b <= start) continue;
        if (b - start <= target) end = b;
        else break;
      }
      if (end === start) end = Math.min(start + target, text.length);
      // A single paragraph longer than target is hard-split.
      if (end - start > target) end = start + target;
      else {
        // extend through the tail of the final paragraph if it still fits
        const nl = text.indexOf("\n", end);
        const paraEnd = nl === -1 ? text.length : nl + 1;
        if (paraEnd - start <= target) end = paraEnd;
      }
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
    // Next start: first paragraph boundary strictly after (end - overlap).
    let next = cfg.boundary === "hard" ? end : Math.max(end - overlap, start + 1);
    if (cfg.boundary === "paragraph") {
      const candidates = starts.filter((b) => b > end - overlap && b < end);
      if (candidates.length > 0) next = candidates[candidates.length - 1];
      else next = end;
      if (next <= start) next = end; // safety: always progress
    }
    start = next;
  }
  return chunks;
}
