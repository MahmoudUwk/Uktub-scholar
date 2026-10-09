/**
 * The one chunking entry point. `boundary` decides the structure: "paragraph" and "hard" are the
 * fixed-window chunker (`chunkText`); "section" follows the document's own sections (heading marks
 * from extraction) — a section that fits the window stays whole, a larger one is split into
 * balanced sentence-aligned pieces, tiny sections merge into a neighbour while the result fits
 * (`splitBySections`). The same chunks serve passage search and claim verification, so a hit is
 * always a unit the decision engine can read whole.
 */
import { chunkText, targetChars, type ChunkTextConfig, type TextChunk } from "./chunk.ts";
import { splitBySections, type SectionMark } from "./sections.ts";

import { createHash } from "node:crypto";

export interface DocumentChunk extends TextChunk {
  /** Heading of the section the chunk starts in ("" before the first heading); null for fixed-window boundaries. */
  section: string | null;
}

/** Client policy: a section (or split piece) below this share of the window is "tiny" and merges into a neighbour that fits. */
export const SECTION_MIN_SHARE = 0.25;

export function chunkDocument(text: string, sections: SectionMark[] | null, cfg: ChunkTextConfig): DocumentChunk[] {
  if (cfg.boundary !== "section") return chunkText(text, cfg).map((c) => ({ ...c, section: null }));
  const maxChars = targetChars(cfg);
  const pieces = splitBySections(text, sections ?? [], { maxChars, minChars: Math.ceil(maxChars * SECTION_MIN_SHARE) });
  return pieces.map((p, index) => {
    const slice = text.slice(p.start, p.end);
    return {
      index,
      char_start: p.start,
      char_end: p.end,
      text: slice,
      content_hash: createHash("sha256").update(slice, "utf8").digest("hex"),
      est_tokens: Math.ceil(slice.length / cfg.chars_per_token),
      section: p.section,
    };
  });
}
