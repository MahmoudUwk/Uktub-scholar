/**
 * Source preparation (KTD3): turn "a registered paper" into a captured,
 * identity-checked source, or a truthful readiness outcome.
 *
 * Acquisition follows the workspace's OpenAlex-only route and nothing else:
 *   1. supplied open-access `pdf_url` candidates from the OpenAlex work record;
 *   2. the Content API tier at the record's own `content_urls` (GROBID TEI,
 *      then PDF) — requires the user's OpenAlex key, which is sent only to the
 *      Content API origin.
 * URLs are never synthesized, landing pages are never scraped, and there is no
 * second route (Unpaywall is deprecated into OpenAlex).
 *
 * Outcomes: `unavailable` = no lawful readable source exists to try (or the
 * key needed for the only one is missing); `failed` = a source was tried and
 * could not be turned into usable text. Both carry a normalized code, never a
 * raw exception or a credentialed URL.
 */

import { createHash } from "node:crypto";

import { fetchWithRetry, retryOpts, asArray, asRecord, asString, parseJsonBody } from "../providers/http.ts";
import type { FetchLike, ProviderConfig } from "../providers/types.ts";
import { normalizeRegistryDoi } from "../doi.ts";
import { MAX_SOURCE_BYTES, SourceError, extractPdf, extractTei, matchesPaperIdentity, type SourceFailureCode } from "./extract.ts";
import type { DownloadLike } from "./download.ts";
import type { SectionMark } from "../sections.ts";

export type SourceKind = "openalex-pdf-url" | "openalex-content-tei" | "openalex-content-pdf" | "local-file";

export interface PreparedSource {
  kind: SourceKind;
  /** Nonsecret origin: URL without credentials, or a project-relative path. */
  ref: string;
  license: string | null;
  /** sha256 of the acquired bytes. */
  digest: string;
  extraction: string;
  text: string;
  pageStarts: number[] | null;
  /** Section marks from extraction; absent/null = none known. */
  sections?: SectionMark[] | null;
}

export type AcquireResult =
  | { ok: true; source: PreparedSource }
  | { ok: false; status: "unavailable" | "failed"; code: SourceFailureCode; detail: string };

/** Client policy: open-access locations tried per paper (repository copies are
 *  often duplicates; three bounds the work without hiding a good one). */
export const MAX_PDF_URL_CANDIDATES = 3;

const DEFAULT_CONTENT_ORIGIN = "https://content.openalex.org";

function sniff(bytes: Uint8Array): "pdf" | "tei" | null {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024));
  if (head.includes("%PDF-")) return "pdf";
  if (head[0] === 0x1f && head[1] === 0x8b) return "tei"; // gzip: only TEI ships that way
  return /^\s*(?:﻿)?<(?:\?xml|TEI)/.test(head.toString("utf8")) ? "tei" : null;
}

/** Bytes → captured source. Throws `SourceError` for anything unusable. */
export async function prepareFromBytes(args: {
  bytes: Uint8Array;
  kind: SourceKind;
  ref: string;
  license?: string | null;
  paper: { doi: string; title: string };
}): Promise<PreparedSource> {
  if (args.bytes.byteLength > MAX_SOURCE_BYTES) throw new SourceError("too_large", `document exceeds ${MAX_SOURCE_BYTES} bytes`);
  const format = sniff(args.bytes);
  if (format === null) throw new SourceError("not_a_document", "the body is neither a PDF nor TEI");
  const extracted = format === "pdf" ? await extractPdf(args.bytes) : extractTei(args.bytes);
  if (!matchesPaperIdentity(extracted.text, args.paper)) {
    throw new SourceError("identity_mismatch", "the document does not match the registered paper's title or DOI");
  }
  return {
    kind: args.kind,
    ref: args.ref,
    license: args.license ?? null,
    digest: createHash("sha256").update(args.bytes).digest("hex"),
    extraction: extracted.extraction,
    text: extracted.text,
    pageStarts: extracted.pageStarts,
    sections: extracted.sections,
  };
}

interface Attempt {
  kind: SourceKind;
  url: string;
  license: string | null;
  credentialed: boolean;
}

export async function acquireSource(
  deps: { fetch: FetchLike; download: DownloadLike; cfg: ProviderConfig; signal?: AbortSignal },
  paper: { doi: string; title: string },
): Promise<AcquireResult> {
  const { cfg } = deps;
  const key = cfg.openalexApiKey?.trim() ?? "";
  const lookup =
    `${cfg.openalexBaseUrl}/works/${encodeURIComponent(`https://doi.org/${paper.doi}`)}` + (key ? `?api_key=${encodeURIComponent(key)}` : "");
  let work: Record<string, unknown> | null;
  try {
    const res = await fetchWithRetry(deps.fetch, lookup, retryOpts(cfg));
    if (res.status === 404) return { ok: false, status: "unavailable", code: "no_open_copy", detail: "OpenAlex does not know this work" };
    if (res.status !== 200) return { ok: false, status: "failed", code: "download_failed", detail: `OpenAlex lookup answered HTTP ${res.status}` };
    work = asRecord(parseJsonBody(res.body, "openalex"));
  } catch {
    return { ok: false, status: "failed", code: "download_failed", detail: "OpenAlex lookup failed" };
  }
  if (work === null) return { ok: false, status: "failed", code: "download_failed", detail: "OpenAlex returned an unusable record" };
  const recordDoi = normalizeRegistryDoi(asString(work["doi"]) ?? "");
  if (recordDoi !== null && recordDoi !== paper.doi) {
    return { ok: false, status: "failed", code: "identity_mismatch", detail: "OpenAlex resolved this DOI to a different work" };
  }

  const attempts: Attempt[] = [];
  const seen = new Set<string>();
  const locations = [asRecord(work["best_oa_location"]), ...asArray(work["locations"]).map(asRecord)];
  for (const loc of locations) {
    const url = asString(loc?.["pdf_url"]);
    if (loc === null || url === null || loc["is_oa"] !== true || seen.has(url)) continue;
    seen.add(url);
    if (attempts.length < MAX_PDF_URL_CANDIDATES) attempts.push({ kind: "openalex-pdf-url", url, license: asString(loc["license"]), credentialed: false });
  }

  // Content API tier: only the record's own content_urls, only on the Content
  // API origin, only with the user's key.
  const origin = cfg.openalexContentOrigin ?? DEFAULT_CONTENT_ORIGIN;
  const hasContent = asRecord(work["has_content"]);
  const contentUrls = asRecord(work["content_urls"]);
  let contentOffered = false;
  for (const [field, kind] of [["grobid_xml", "openalex-content-tei"], ["pdf", "openalex-content-pdf"]] as const) {
    const url = asString(contentUrls?.[field]);
    if (hasContent?.[field] !== true || url === null) continue;
    let onOrigin = false;
    try {
      onOrigin = new URL(url).origin === origin;
    } catch {
      onOrigin = false;
    }
    if (!onOrigin) continue;
    contentOffered = true;
    if (key) attempts.push({ kind, url, license: null, credentialed: true });
  }

  if (attempts.length === 0) {
    return contentOffered
      ? { ok: false, status: "unavailable", code: "no_credential", detail: "only the OpenAlex Content API offers this paper; set OPENALEX_API_KEY" }
      : { ok: false, status: "unavailable", code: "no_open_copy", detail: "OpenAlex lists no direct PDF link and no Content API copy for this paper (landing pages are not scraped); attach a PDF with paper_registry attach_source, or set OPENALEX_API_KEY if the Content API holds it" };
  }

  const failures: { kind: SourceKind; code: SourceFailureCode }[] = [];
  for (const a of attempts) {
    deps.signal?.throwIfAborted();
    try {
      const got = await deps.download(a.url, {
        maxBytes: MAX_SOURCE_BYTES,
        signal: deps.signal,
        ...(a.credentialed ? { credential: { origin, param: "api_key", value: key } } : {}),
      });
      const source = await prepareFromBytes({ bytes: got.bytes, kind: a.kind, ref: got.finalUrl, license: a.license, paper });
      return { ok: true, source };
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      failures.push({ kind: a.kind, code: err instanceof SourceError ? err.code : "download_failed" });
    }
  }
  return {
    ok: false,
    status: "failed",
    code: failures[0].code,
    detail: failures.map((f) => `${f.kind}: ${f.code}`).join("; "),
  };
}
