/**
 * Programmatic checks of the claims an independent author wrote for claim-verification-v2 (benchmarks/datasets/claim-verification-v2/AUTHORING.md).
 * Pure. A claim that fails a check is dropped before any annotator or engine sees it; the problems are reported, never silently repaired.
 */
export type ClaimType = "reworded" | "numeric" | "perturbed" | "fabricated" | "contradiction" | "general";

export interface Authored {
  type: ClaimType;
  kind: string;
  claim: string;
  evidence: string | null;
  source_quote: string | null;
  changed: string | null;
  new_value: string | null;
}

export interface Problem {
  /** Index in the author's array; null for a problem of the whole set. */
  index: number | null;
  code: string;
  message: string;
}

export const COUNTS: Record<ClaimType, number> = { reworded: 4, numeric: 2, perturbed: 2, fabricated: 2, contradiction: 1, general: 1 };

const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/** Whitespace collapsed, and a word that a hyphen broke over two lines joined again. */
export function normalizeText(s: string): string {
  return s.replace(/-[ \t]*\r?\n[ \t]*/g, "").replace(/\s+/g, " ").trim();
}

const canon = (s: string): string => normalizeText(s).toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Is the quote in the text? Compared on letters and digits only, so line breaks, hyphenation, spacing and case cannot hide it. */
export function quoteInText(text: string, quote: string): boolean {
  const q = canon(quote);
  return q.length > 0 && canon(text).includes(q);
}

/** The first run of `n` consecutive words of the claim that the text also has, or null. */
export function copiedRun(claim: string, text: string, n: number): string | null {
  const t = words(normalizeText(text));
  const grams = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) grams.add(t.slice(i, i + n).join(" "));
  const c = words(claim);
  for (let i = 0; i + n <= c.length; i++) {
    const gram = c.slice(i, i + n).join(" ");
    if (grams.has(gram)) return gram;
  }
  return null;
}

/** The numbers in a text as digits only: no thousands commas, no percent sign, no unit. */
export function numbersIn(s: string): string[] {
  return (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => x.replace(/,/g, "").replace(/\.$/, ""));
}

/** The values a claim states: numbers standing on their own, not a digit that is part of a name, a version or a label ("top-1", "GPT4", "B2", "Wan2.2"). */
const valuesIn = (s: string): string[] => (s.match(/(?<![A-Za-z0-9.-])\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => x.replace(/,/g, "").replace(/\.$/, ""));

/** The kinds the protocol lists (AUTHORING.md); a general claim's kind is set to `general` when the dataset is assembled. */
const KINDS = ["method", "dataset", "finding", "limitation", "numeric"];

const NEEDS_QUOTE: ClaimType[] = ["reworded", "numeric", "contradiction"];
const NO_QUOTE: ClaimType[] = ["perturbed", "fabricated", "general"];
const QUOTE_WORDS = { min: 6, max: 80 } as const;
const CLAIM_WORDS = { min: 8, max: 60 } as const;
const isNumeric = (v: string): boolean => /^\d[\d,]*(\.\d+)?$/.test(v.trim());

export function checkAuthored(items: Authored[], paperText: string): Problem[] {
  const problems: Problem[] = [];
  const add = (index: number | null, code: string, message: string): void => void problems.push({ index, code, message });
  const paperNumbers = new Set(numbersIn(paperText));
  const counts: Record<string, number> = {};
  for (const x of items) counts[x.type] = (counts[x.type] ?? 0) + 1;
  const expected = Object.entries(COUNTS).map(([t, n]) => `${t} ${counts[t] ?? 0}/${n}`).join(", ");
  if (items.length !== 12 || Object.entries(COUNTS).some(([t, n]) => (counts[t] ?? 0) !== n)) add(null, "count", `the set must be 12 claims with ${expected}`);
  const seen = new Set<string>();
  for (const [i, x] of items.entries()) {
    const claim = typeof x.claim === "string" ? x.claim : "";
    const key = canon(claim);
    if (seen.has(key)) add(i, "duplicate", "the same claim twice");
    seen.add(key);
    const n = wordCount(claim);
    if (claim === "" || /[\r\n]/.test(claim.trim()) || n < CLAIM_WORDS.min || n > CLAIM_WORDS.max) add(i, "shape", `a claim is one line of ${CLAIM_WORDS.min} to ${CLAIM_WORDS.max} words (this one has ${n})`);
    if (x.type !== "general" && !KINDS.includes(x.kind)) add(i, "kind", `kind must be one of ${KINDS.join(", ")}`);
    if (/\b(this|the present|the)\s+(paper|study|article)\b|\bthe authors?\b/i.test(claim)) add(i, "standalone", "a claim must not point at 'the paper' or 'the authors'");
    const quoteOk = (q: string | null): boolean => q !== null && wordCount(q) >= QUOTE_WORDS.min && wordCount(q) <= QUOTE_WORDS.max && quoteInText(paperText, q);
    if (NEEDS_QUOTE.includes(x.type) && !quoteOk(x.evidence)) add(i, "quote", `evidence must be a verbatim quote of ${QUOTE_WORDS.min} to ${QUOTE_WORDS.max} words that is in the paper`);
    if (NO_QUOTE.includes(x.type) && x.evidence !== null) add(i, "fields", `a ${x.type} claim has no evidence quote`);
    if ((x.type === "fabricated" || x.type === "general") && x.source_quote !== null) add(i, "fields", `a ${x.type} claim has no source quote`);
    if (x.type === "reworded" || x.type === "numeric") {
      const run = copiedRun(claim, paperText, 8);
      if (run !== null) add(i, "copied", `copies 8 consecutive words of the paper: "${run}"`);
    }
    if (x.type === "numeric") {
      const mine = valuesIn(claim);
      const theirs = new Set(numbersIn(x.evidence ?? ""));
      // A context number (a model size, an epoch count) may come from elsewhere in the paper; the number the claim is about must be in its quote.
      if (mine.length === 0 || !mine.some((m) => theirs.has(m)) || mine.some((m) => !paperNumbers.has(m))) add(i, "number", "a numeric claim states a number that is in its own quote, and every number in it is in the paper");
    }
    if (x.type === "perturbed") {
      if (!quoteOk(x.source_quote)) add(i, "source", "source_quote must be a verbatim quote of the true fact that is in the paper");
      if (!x.changed || !x.new_value) add(i, "fields", "a perturbed claim says what it changed and the new value");
      else {
        const nv = x.new_value.trim();
        // A number is checked: the claim must say it and the paper must not. Any other change (a swapped direction or ordering) is described, not quoted.
        if (isNumeric(nv)) {
          if (!claim.toLowerCase().includes(nv.toLowerCase())) add(i, "new_value", "the claim must contain a numeric new value");
          else if (paperNumbers.has(numbersIn(nv)[0] as string)) add(i, "new_value", "a numeric new value must not appear anywhere in the paper");
        }
      }
    }
    if (x.type === "fabricated") {
      const present = valuesIn(claim).filter((m) => (m.length >= 2 || m.includes(".")) && paperNumbers.has(m));
      if (present.length > 0) add(i, "number_in_paper", `a fabricated claim must not use a number the paper has: ${present.join(", ")}`);
    }
  }
  return problems;
}
