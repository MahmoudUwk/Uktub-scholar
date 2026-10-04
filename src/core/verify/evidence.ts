/**
 * Supporting passages and output containment (KTD7, R5, R10–R11).
 *
 * A stage-1 judgment says "this chunk (thousands of tokens) supports the
 * claim". The agent must receive a passage it can read and cite, so a
 * supported chunk is localized into excerpt-sized passages (each re-judged by
 * the engine), and what leaves the package is verbatim source text with its
 * exact span — never a clipped window, never a retrieval snippet.
 *
 * Containment keeps support from becoming a full-text export path: a passage
 * that is a large share of its source, an over-long span, or text beyond a
 * source's release budget is withheld. The pointer is always kept; only the
 * excerpt text is withheld, with its reason. This is a per-output guarantee
 * (the package never returns a source body), not protection against an agent
 * that can read the user's files directly.
 */

import { chunkText, type ChunkTextConfig } from "../chunk.ts";

/** Client policy (measured in docs/benchmarks): passage windows of ≈1,200
 *  characters (430 tokens × 2.8) — a paragraph or two, small enough to quote,
 *  large enough to keep a claim's qualifiers, units and table header together. */
export const PASSAGE_CFG: ChunkTextConfig = { chunk_tokens: 430, overlap_tokens: 60, chars_per_token: 2.8, boundary: "paragraph" };
/** Client policy: longest excerpt released (≈ one dense paragraph or two). */
export const EXCERPT_MAX_CHARS = 1_500;
/** Client policy: a passage this large a share of its source is a body export, not an excerpt. */
export const WHOLE_SOURCE_SHARE = 0.5;
/** Client policy: most of one source's text released across one verification. */
export const SOURCE_SHARE_MAX = 0.25;

/** Split a supported chunk into verbatim passages with absolute spans. A chunk
 *  already within the excerpt limit IS its passage (its judgment already stands). */
export function localizePassages(chunk: { start: number; text: string }): { start: number; end: number; text: string }[] {
  if (chunk.text.length <= EXCERPT_MAX_CHARS) return [{ start: chunk.start, end: chunk.start + chunk.text.length, text: chunk.text }];
  return chunkText(chunk.text, PASSAGE_CFG).map((c) => ({ start: chunk.start + c.char_start, end: chunk.start + c.char_end, text: c.text }));
}

export interface SupportedPassage {
  doi: string;
  citekey: string;
  revision: string;
  chunkId: string;
  start: number;
  end: number;
  page: number | null;
  /** Engine P(true) for this passage under the configured bar. */
  pTrue: number;
  text: string;
}

export type WithheldReason = "whole_source" | "source_share" | "excerpt_cap";

export interface ContainedEvidence extends Omit<SupportedPassage, "text"> {
  /** Verbatim source text, or null when withheld. */
  excerpt: string | null;
  withheld: WithheldReason | null;
}

/** What earlier pages of the same run already delivered, per paper. */
export type PriorDelivery = Map<string, { released: number; spans: { start: number; end: number }[] }>;

/**
 * Deduplicate overlapping support per paper (the strongest passage wins; every
 * kept passage was judged supported on its own), then decide which excerpts
 * may leave. Passages that overlap one already delivered on an earlier page are
 * dropped (it was delivered). Release goes in reading order until the source's
 * budget — INCLUDING text released on earlier pages — is spent, so a paged run
 * never releases more than one call would. Every supporting pointer is returned,
 * in reading order.
 */
export function containEvidence(passages: SupportedPassage[], sourceLength: (doi: string) => number, prior: PriorDelivery = new Map()): ContainedEvidence[] {
  const byDoi = new Map<string, SupportedPassage[]>();
  for (const p of passages) (byDoi.get(p.doi) ?? byDoi.set(p.doi, []).get(p.doi)!).push(p);
  const out: ContainedEvidence[] = [];
  for (const [doi, list] of byDoi) {
    const before = prior.get(doi) ?? { released: 0, spans: [] };
    const fresh = list.filter((p) => !before.spans.some((s) => p.start < s.end && s.start < p.end));
    const strongestFirst = [...fresh].sort((a, b) => b.pTrue - a.pTrue || a.start - b.start);
    const kept: SupportedPassage[] = [];
    for (const p of strongestFirst) if (!kept.some((k) => p.start < k.end && k.start < p.end)) kept.push(p);
    kept.sort((a, b) => a.start - b.start);

    const length = sourceLength(doi);
    let released = before.released;
    let shareExhausted = false;
    for (const p of kept) {
      const span = p.end - p.start;
      const { text, ...pointer } = p;
      let withheld: WithheldReason | null = null;
      if (span >= WHOLE_SOURCE_SHARE * length) withheld = "whole_source";
      else if (span > EXCERPT_MAX_CHARS) withheld = "excerpt_cap";
      else if (shareExhausted || released + span > SOURCE_SHARE_MAX * length) {
        withheld = "source_share";
        shareExhausted = true; // once the budget is spent, everything later in the source is withheld too
      }
      if (withheld === null) released += span;
      out.push({ ...pointer, excerpt: withheld === null ? text : null, withheld });
    }
  }
  return out.sort((a, b) => (a.citekey < b.citekey ? -1 : a.citekey > b.citekey ? 1 : a.start - b.start));
}
