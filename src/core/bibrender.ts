/**
 * Bibliography rendering (R12, R18): `refs/references.bib` is a deterministic
 * image of the citable registry rows — equal rows give byte-identical output,
 * in citekey order (citekey is UNIQUE, so the order is total).
 *
 * Provider BibTeX is never synthesized or repaired (R13). The only rewrites
 * are the product's live-run normalizers, ported verbatim
 * (UktubAI_Agentic/deploy/sandbox-image/pi-registry.js, 2026-09-29 run):
 * re-keying the entry head to the pinned citekey, bare full month names to
 * standard BibTeX month macros, HTML entity decoding, and LaTeX-safe `&`
 * escaping with url/doi/eprint exempt.
 */

/** The whole file's first line: the registry owns the file, agents cite, never edit. */
export const BIBLIOGRAPHY_HEADER =
  "% Generated from .registry/registry.db — do not edit; register papers instead.\n";

/** The whole file for a registry with no citable papers. */
export const EMPTY_BIBLIOGRAPHY =
  "% Generated from .registry/registry.db — no citable papers registered yet.\n";

/** `@type{key` up to the key's terminator (`,` or `}`): what makes provider
 *  BibTeX re-keyable, and so citable. */
const BIBTEX_ENTRY_HEAD = /^(\s*@\w+\s*\{)\s*[^,}\s]*\s*(?=[,}])/;

/** Whether the bibliography can re-key this BibTeX — the citability test (R13). */
export function isRekeyableBibtex(bibtex: string): boolean {
  return BIBTEX_ENTRY_HEAD.test(bibtex);
}

/** The provider's entry with its key swapped for the pinned citekey — only
 *  the key token after `@type{` changes (`@type{key,` or a field-less
 *  `@type{key}`); every field stays verbatim. */
export function withCitekey(bibtex: string, citekey: string): string {
  return bibtex.replace(BIBTEX_ENTRY_HEAD, `$1${citekey}`);
}

/** Standard BibTeX styles predefine only the three-letter month macros
 *  (`jan` … `dec`; string names are case-insensitive). Crossref's BibTeX writes
 *  `month=June` / `month=July` — full names, unbraced — which bibtex reports as
 *  an undefined string and renders with no month. `sept` is the common
 *  four-letter abbreviation. */
const BIBTEX_MONTH_MACROS: Record<string, string> = {
  january: "jan",
  february: "feb",
  march: "mar",
  april: "apr",
  june: "jun",
  july: "jul",
  august: "aug",
  september: "sep",
  sept: "sep",
  october: "oct",
  november: "nov",
  december: "dec",
};

/** Rewrite a bare full month name in a `month = <name>` field to its standard
 *  macro; meaning-preserving (same month), and a braced, numeric or macro value
 *  is left exactly as the provider wrote it. */
function withStandardMonth(bibtex: string): string {
  return bibtex.replace(/(?<=[,{\s])(month\s*=\s*)([A-Za-z]{4,})(?=\s*[,}])/g, (match, field: string, name: string) => {
    const macro = BIBTEX_MONTH_MACROS[name.toLowerCase()];
    return macro === undefined ? match : `${field}${macro}`;
  });
}

/** HTML entities Crossref's BibTeX carries (`journal={Environmental Science &amp;amp; Technology}`,
 *  seen double-escaped in the 2026-09-29 live run): the five XML names plus numeric references. An
 *  unknown named entity is not guessed at. Decoded at most twice, enough for the observed double escape.
 *  Single owner for the package: providers/plainText reuse it (bounds-checked, unlike a naive
 *  fromCodePoint decode which throws on out-of-range numeric refs). */
export function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  const decodeOnce = (input: string): string =>
    input.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g, (match, dec?: string, hex?: string, name?: string) => {
      if (name !== undefined) return named[name]!;
      const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16);
      return code >= 1 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
    });
  const once = decodeOnce(text);
  return once === text ? text : decodeOnce(once);
}

/** Provider BibTeX made LaTeX-safe: entities decoded, and a bare `&` (an alignment tab in TeX) written
 *  as `\&`. `url`, `doi` and `eprint` values are data, so they are decoded but never escaped. */
function withLatexSafeText(bibtex: string): string {
  return bibtex
    .split(/((?:url|doi|eprint)\s*=\s*\{[^{}]*\})/i)
    .map((part, index) => {
      const decoded = decodeHtmlEntities(part);
      return index % 2 === 1 ? decoded : decoded.replace(/(?<!\\)&/g, "\\&");
    })
    .join("");
}

/** One citable row as the renderer consumes it. */
export interface CitableEntry {
  citekey: string;
  bibtex: string;
}

/**
 * Render the whole `references.bib` content from the citable rows: each
 * entry's provider BibTeX is trimmed, month-normalized, made LaTeX-safe and
 * re-keyed under the row's pinned citekey. Equal rows give byte-identical
 * output; the caller owns the atomic write.
 */
export function renderBibliography(entries: CitableEntry[]): string {
  const rendered = entries.map((entry) =>
    withCitekey(withLatexSafeText(withStandardMonth(entry.bibtex.trim())), entry.citekey),
  );
  return rendered.length > 0
    ? `${BIBLIOGRAPHY_HEADER}\n${rendered.join("\n\n")}\n`
    : EMPTY_BIBLIOGRAPHY;
}
