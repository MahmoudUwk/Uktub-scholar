/**
 * Figures in a statement (numbers with units, decimals, hardware names) and how they match a paper's text.
 *
 * Matching is by number first and unit second, because a paper's table often states the unit once in a column header ("GPU Memory
 * Cost (GB)" over 37.3) so the number-with-unit never occurs verbatim. A decimal found without its unit is specific enough to
 * accept; a round integer is not (80 occurs in any paper as a batch size), so it is reported as weaker evidence. Measured on the
 * papers of the workflow experiment (docs/handoff.md): unit-attached matching alone wrongly flags header-unit values, number-only
 * matching alone misses "32GB" and "80GB" invented for papers that contain a 32 and an 80 elsewhere.
 *
 * Magnitude tokens (number plus an attached k/K/M/B suffix: "8k" context lengths, "3B" parameters) are figures;
 * lowercase attached suffixes are accepted at extraction, and at matching only the same number with the same suffix
 * (case-insensitively) counts, never a bare expanded number.
 */
export interface Figure {
  /** As written, thousands separators removed ("24 GB", "37.3GB", "10000 times", "A100"). */
  token: string;
  kind: "number" | "hardware";
  /** The number without separators, or the hardware name. */
  value: string;
  /** Canonical unit: "%", "GB", "MB", "TB", "KB", "B", "M", "K", "×", "bit", or null. */
  unit: string | null;
  decimal: boolean;
}
export type FigureMatch = "exact" | "number-only" | "absent";

const HARDWARE = /\b(?:A100|A800|H100|H200|H800|V100|P100|A6000|RTX ?A?\d{4}[A-Za-z]{0,2}|TITAN ?X[pP]?|TPU ?v\d[a-z]?|GTX ?\d{3,4}|MI\d{3}X?)\b/gi;
const NUMBER = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?-?\s?(%|GB|GiB|MB|MiB|TB|KB|bits?|B|M|K|×|x|X|times|percent)(?![A-Za-z0-9])|([kmb])(?![A-Za-z0-9]))?/g;
const REFERENCE_WORD = /(?:table|section|sec\.|figure|fig\.|eq\.|equation|algorithm|appendix|listing|step|chapter|version|v)\s*$/i;

function canonicalUnit(u: string | undefined): string | null {
  if (u === undefined) return null;
  const l = u.toLowerCase();
  if (l === "%" || l === "percent") return "%";
  if (l === "gb" || l === "gib") return "GB";
  if (l === "mb" || l === "mib") return "MB";
  if (l === "tb") return "TB";
  if (l === "kb") return "KB";
  if (l === "×" || l === "x" || l === "times") return "×";
  if (l === "bit" || l === "bits") return "bit";
  if (l === "b") return "B";
  if (l === "m") return "M";
  if (l === "k") return "K";
  return null;
}

export function figuresOf(plain: string): Figure[] {
  const out: Array<{ at: number; f: Figure }> = [];
  for (const h of plain.matchAll(HARDWARE)) {
    out.push({ at: h.index ?? 0, f: { token: h[0].replace(/\s+/g, " "), kind: "hardware", value: h[0].replace(/\s+/g, " ").toUpperCase(), unit: null, decimal: false } });
  }
  for (const m of plain.matchAll(NUMBER)) {
    const at = m.index ?? 0;
    const int = (m[1] ?? "").replace(/,/g, "");
    const frac = m[2] ?? "";
    const unit = canonicalUnit(m[3] ?? m[4]);
    const decimal = frac !== "";
    const value = int + frac;
    if (REFERENCE_WORD.test(plain.slice(Math.max(0, at - 12), at))) continue;
    if (/^\d{4}\.\d{4,5}$/.test(value) || (/^10\.\d{4,9}$/.test(value) && plain[at + m[0].length] === "/")) continue; // arXiv id, DOI prefix
    if (!decimal && unit === null) continue; // a bare integer is a count, a rank, a year: not a figure
    if (!decimal && unit === "×" && Number(int) < 10) continue; // "3×" is too generic to audit
    if (!decimal && unit === "bit") continue; // "4-bit", "16-bit" describe a format
    if (out.some((o) => o.f.kind === "hardware" && at >= o.at - 1 && at < o.at + o.f.token.length)) continue;
    out.push({ at, f: { token: m[0].replace(/,/g, "").replace(/\s+/g, " ").trim(), kind: "number", value, unit, decimal } });
  }
  return out.sort((a, b) => a.at - b.at).map((o) => o.f);
}

/** A paper's text prepared for matching: non-breaking spaces and dashes folded, thousands separators removed. */
export function normalizePaperText(text: string): string {
  let s = text.replace(/[  ]/g, " ").replace(/[−–—]/g, "-");
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
  }
  return s;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const UNIT_ALTERNATIVES: Record<string, string> = {
  "%": "%|percent|per cent",
  GB: "GB|GiB",
  MB: "MB|MiB",
  TB: "TB",
  KB: "KB",
  B: "B|billion",
  M: "M|million",
  K: "K|thousand",
  "×": "×|x|X|times|-fold|fold",
  bit: "bits?",
};

/**
 * Magnitude suffixes (K/M/B: "8k" context lengths, "3B" parameters). A bare number
 * match says nothing (8 occurs in any paper as a batch size), so only the same
 * number with the same suffix, case-insensitively, counts as exact; otherwise the
 * figure is absent, never a weak number-only match. Written forms are never
 * expanded ("8k" does not match "8192").
 */
const MAGNITUDE_UNIT = new Set(["K", "M", "B"]);

export function matchFigure(f: Figure, paperNorm: string): FigureMatch {
  if (f.kind === "hardware") {
    // a name may wrap across a line in the captured text ("TITAN" / "Xp")
    return new RegExp(`\\b${esc(f.value).replace(/ /g, "[\\s-]*")}\\b`, "i").test(paperNorm) ? "exact" : "absent";
  }
  const number = new RegExp(`(?<![\\d.])${esc(f.value)}(?!\\d|\\.\\d)`);
  if (!number.test(paperNorm)) return "absent";
  if (f.unit === null) return "exact";
  const withUnit = new RegExp(`(?<![\\d.])${esc(f.value)}\\s?-?\\s?(?:${UNIT_ALTERNATIVES[f.unit] ?? esc(f.unit)})(?![A-Za-z0-9])`, "i");
  if (withUnit.test(paperNorm)) return "exact";
  return MAGNITUDE_UNIT.has(f.unit) ? "absent" : "number-only";
}
