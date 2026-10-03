/**
 * Citekey minting (R11): first-author family name + year + first significant
 * title word, disambiguated with base-26 suffixes. Ported verbatim from the
 * product's pi-registry.js. A citekey is pinned at the row's FIRST
 * registration and never recomputed or re-keyed — these functions only mint
 * fresh keys; registry.ts owns the pinning.
 */
import type { DatabaseSync } from "node:sqlite";

/** Small static stopword lookup for the title part. */
const TITLE_STOPWORDS: Record<string, true> = {
  a: true,
  an: true,
  the: true,
  on: true,
  in: true,
  of: true,
  and: true,
  for: true,
  to: true,
  with: true,
  towards: true,
};

/**
 * The base citekey for a paper: `vaswani2017attention` shape.
 *
 * The author part is the first author's family name ("Family, Given" and
 * "Given Family" both resolve to the family name); diacritics are stripped
 * (NFD) and everything outside ASCII letters/digits is dropped, falling back
 * to "unknown". The year part is the year, or "nodate". The title part is the
 * first significant word (stopwords dropped), truncated to 15 characters,
 * falling back to "paper".
 */
export function generateCitekey(authors: string[], year: number | null, title: string): string {
  let authPart = "unknown";
  if (Array.isArray(authors) && authors.length > 0 && typeof authors[0] === "string") {
    const raw = authors[0].trim();
    authPart = raw.includes(",") ? raw.split(",")[0]!.trim() : raw.split(/\s+/).at(-1)!;
  }
  authPart =
    authPart
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "") || "unknown";

  const yearPart = typeof year === "number" && year > 0 ? String(year) : "nodate";

  let titlePart = "paper";
  if (typeof title === "string" && title.trim().length > 0) {
    const words = title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 0);
    const firstWord = words.find((w) => !(w in TITLE_STOPWORDS));
    if (firstWord) {
      titlePart = firstWord.slice(0, 15);
    }
  }

  return `${authPart}${yearPart}${titlePart}`;
}

/**
 * `base`, then `base` + a, b, …, z, aa, ab, … — the first key no row holds.
 * Called inside the write transaction (BEGIN IMMEDIATE), so the taken-key
 * probe and the insert are atomic under the write lock: no two writers,
 * in-process or cross-process, can mint the same suffix.
 */
export function firstFreeCitekey(db: DatabaseSync, base: string): string {
  const taken = db.prepare("SELECT 1 FROM papers WHERE citekey = ?");
  for (let n = 0; ; n += 1) {
    let suffix = "";
    for (let rest = n; rest > 0; rest = Math.floor((rest - 1) / 26)) {
      suffix = String.fromCharCode(97 + ((rest - 1) % 26)) + suffix;
    }
    if (taken.get(base + suffix) === undefined) return base + suffix;
  }
}
