/**
 * DOI normalization and arXiv forms, inlined from the product's
 * `@uktubai/shared` (packages/shared/src/doi.ts + hash.ts) so the package
 * ships with zero runtime dependencies (KTD3). Contract restated verbatim.
 */
import { createHash } from "node:crypto";

/** sha256 hex of a UTF-8 string or binary bytes. */
export function hashHex(data: string | Uint8Array): string {
  if (typeof data === "string") {
    return createHash("sha256").update(data, "utf8").digest("hex");
  }
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Canonical registry form for storage and lookup. DOIs are case-insensitive
 * and structurally `10.<registrant>/<suffix>`; callers frequently hold
 * `doi:`-prefixed, URL-wrapped or mis-cased strings. Strips the common
 * prefixes, lowercases, and validates the structural invariant. Anything that
 * does not conform — including a bare arXiv id — is not a DOI: `null`, never
 * a guess.
 */
export function normalizeRegistryDoi(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const candidate = raw
    .trim()
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .trim()
    .toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(candidate) ? candidate : null;
}

/** A modern arXiv identifier (`YYMM.NNNN[N]`, optional `vN`), per
 *  https://info.arxiv.org/help/arxiv_identifier.html. */
export const ARXIV_ID_PATTERN = String.raw`\d{4}\.\d{4,5}(?:v\d+)?`;

/** DataCite mints every arXiv DOI under this prefix; DOIs are lowercased on
 *  normalization, so a prefix test on a normalized DOI is exact. */
const ARXIV_DOI_PREFIX = "10.48550/arxiv.";

/** Whether a normalized DOI is an arXiv DOI. */
export function isArxivDoi(doi: string): boolean {
  return doi.startsWith(ARXIV_DOI_PREFIX);
}

/** arXiv mints a DataCite DOI for every paper — `10.48550/arxiv.<id>`,
 *  version dropped. An identifier that is not exactly an arXiv id (optionally
 *  `arXiv:`-prefixed) returns `null`. */
export function arxivDoi(raw: string): string | null {
  const match = new RegExp(String.raw`^(?:arxiv:\s*)?(${ARXIV_ID_PATTERN})$`, "i").exec(raw.trim());
  return match ? `${ARXIV_DOI_PREFIX}${match[1]!.replace(/v\d+$/i, "").toLowerCase()}` : null;
}
