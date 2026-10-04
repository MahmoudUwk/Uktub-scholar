/**
 * Evidence-quality metrics for the experiment runner (docs/benchmarks): locate
 * a gold quote in an extracted text that may differ from the extractor the
 * quote was authored against, and summarize retrieval/support rates.
 *
 * `goldHitPrecision` is a LOWER bound on returned-evidence precision: a
 * returned passage that supports the claim somewhere other than the gold quote
 * counts as a miss here. Those extras go to independent review.
 */

export interface Span {
  start: number;
  end: number;
}
export interface LocatedGold extends Span {
  coverage: number;
}

interface Tok {
  t: string;
  s: number;
  e: number;
}
const tokenize = (text: string): Tok[] => [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ t: m[0].toLowerCase(), s: m.index!, e: m.index! + m[0].length }));

/** Share of quote tokens that must be matched, in order, for a location to count. */
const MIN_COVERAGE = 0.5;
/** Quote tokens a match may skip at once (a hyphenation split costs one or two). */
const MAX_SKIP = 2;
/** Text window, as a multiple of the quote length, searched from each start. */
const WINDOW_FACTOR = 1.6;

/**
 * Where `quote` sits in `text`, tolerant of whitespace, line-break and
 * hyphenation differences (the dataset quotes come from `pdftotext`, the
 * package text from `unpdf`). In-order token matching from each plausible start;
 * the best-covered (then earliest) region wins. Null below 50 % coverage.
 */
export function locateQuote(text: string, quote: string): LocatedGold | null {
  const q = tokenize(quote);
  const x = tokenize(text);
  if (q.length === 0 || x.length === 0) return null;
  const starters = new Set(q.slice(0, MAX_SKIP + 1).map((k) => k.t));
  let best: { coverage: number; first: number; last: number } | null = null;
  for (let w = 0; w < x.length; w++) {
    if (!starters.has(x[w].t)) continue;
    let p = q.findIndex((k, idx) => idx <= MAX_SKIP && k.t === x[w].t);
    let matched = 0;
    let first = -1;
    let last = -1;
    const limit = Math.min(x.length, w + Math.ceil(q.length * WINDOW_FACTOR));
    for (let i = w; i < limit && p < q.length; i++) {
      let hit = -1;
      for (let d = 0; d <= MAX_SKIP && p + d < q.length; d++) {
        if (q[p + d].t === x[i].t) {
          hit = p + d;
          break;
        }
      }
      if (hit === -1) continue;
      matched++;
      if (first === -1) first = i;
      last = i;
      p = hit + 1;
    }
    const coverage = matched / q.length;
    if (first !== -1 && (best === null || coverage > best.coverage)) best = { coverage, first, last };
  }
  if (best === null || best.coverage < MIN_COVERAGE) return null;
  return { start: x[best.first].s, end: x[best.last].e, coverage: best.coverage };
}

export const overlapChars = (a: Span, b: Span): number => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

export interface ClaimRun {
  label: "TRUE" | "FALSE";
  /** Where the gold quote sits in the captured text; null when it could not be located. */
  gold: Span | null;
  /** Chunk spans selected for judging. */
  candidates: Span[];
  /** Returned supporting spans (excerpt or pointer-only). */
  evidence: Span[];
  freshJudgments: number;
}

export interface EvidenceSummary {
  trueClaims: number;
  goldLocated: number;
  /** Located-gold claims whose gold lies in a selected candidate. */
  candidateRecall: number | null;
  /** Located-gold claims where returned evidence overlaps the gold. */
  supportRecall: number | null;
  /** Share of returned spans (located-gold claims) that overlap the gold. A lower bound. */
  goldHitPrecision: number | null;
  meanEvidencePerTrue: number | null;
  falseClaims: number;
  /** FALSE claims that received any supporting evidence. */
  falseSupportRate: number | null;
  verifierCalls: number;
}

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

export function summarize(runs: ClaimRun[]): EvidenceSummary {
  const trues = runs.filter((r) => r.label === "TRUE");
  const falses = runs.filter((r) => r.label === "FALSE");
  const located = trues.filter((r): r is ClaimRun & { gold: Span } => r.gold !== null);
  const anyOverlap = (spans: Span[], gold: Span): boolean => spans.some((s) => overlapChars(s, gold) > 0);
  const returned = located.reduce((n, r) => n + r.evidence.length, 0);
  const hits = located.reduce((n, r) => n + r.evidence.filter((e) => overlapChars(e, r.gold) > 0).length, 0);
  return {
    trueClaims: trues.length,
    goldLocated: located.length,
    candidateRecall: ratio(located.filter((r) => anyOverlap(r.candidates, r.gold)).length, located.length),
    supportRecall: ratio(located.filter((r) => anyOverlap(r.evidence, r.gold)).length, located.length),
    goldHitPrecision: ratio(hits, returned),
    meanEvidencePerTrue: ratio(trues.reduce((n, r) => n + r.evidence.length, 0), trues.length),
    falseClaims: falses.length,
    falseSupportRate: ratio(falses.filter((r) => r.evidence.length > 0).length, falses.length),
    verifierCalls: runs.reduce((n, r) => n + r.freshJudgments, 0),
  };
}
