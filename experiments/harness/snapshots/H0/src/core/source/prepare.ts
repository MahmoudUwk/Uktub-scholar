/**
 * Source preparation (KTD3): turn "a registered paper" into a captured,
 * identity-checked source, or a truthful readiness outcome.
 *
 * Acquisition (owner decision 2026-10-07: any lawful open-access source a provider record names; every transport guard kept):
 *   1. from the OpenAlex work record: open-access `pdf_url` candidates, then an arXiv PDF built from an arXiv identifier the
 *      record or the paper's own DOI carries, then `open_access.oa_url`;
 *   2. the Content API tier at the record's own `content_urls` (GROBID TEI,
 *      then PDF) — requires the user's OpenAlex key, which is sent only to the
 *      Content API origin;
 *   3. only if nothing above produced a source: the PubMed Central open-data copy of the PMCID Europe PMC reports for the DOI (keyless), and
 *      open-access PDF links Europe PMC lists on other hosts,
 *      then Semantic Scholar's `openAccessPdf.url`, then the arXiv preprint named by its
 *      `externalIds.ArXiv` (the preprint can differ from the published version, so it has its own kind).
 * Every candidate is fetched through the guarded downloader and must be a PDF or TEI whose text matches the paper; DOI resolver
 * links and landing pages are never scraped, and there is no Unpaywall route (deprecated into OpenAlex).
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
import { semanticScholarSpacer } from "../providers/semantic-scholar.ts";
import { arxivCoolingDown, arxivIdFromDoi, arxivIdFromUrl, arxivPdfUrl, arxivSpacer, isArxivHost, noteArxivRefusal, noteArxivSuccess, isArxivId, isDoiResolver, sameArxivWork } from "./arxiv.ts";
import { MAX_SOURCE_BYTES, SourceError, extractPdf, extractTei, matchesPaperIdentity, type SourceFailureCode } from "./extract.ts";
import type { DownloadLike } from "./download.ts";
import type { SectionMark } from "../sections.ts";

/** `arxiv-pdf` is the arXiv copy of the registered arXiv DOI itself; `arxiv-preprint-pdf` is an arXiv copy of the same work under another DOI
 *  (the preprint can differ from the published version). */
export type SourceKind =
  | "openalex-pdf-url"
  | "openalex-oa-url"
  | "openalex-content-tei"
  | "openalex-content-pdf"
  | "s2-open-access-pdf"
  | "epmc-pdf"
  | "pmc-pdf"
  | "arxiv-pdf"
  | "arxiv-preprint-pdf"
  | "local-file";

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

type Deps = { fetch: FetchLike; download: DownloadLike; cfg: ProviderConfig; signal?: AbortSignal };
type Failure = { kind: SourceKind; code: SourceFailureCode };
type TierResult = { source: PreparedSource } | { failures: Failure[] };

/** Client policy: arXiv-derived and oa_url candidates tried per paper from the OpenAlex record (pdf_url keeps MAX_PDF_URL_CANDIDATES). */
const MAX_DERIVED_CANDIDATES = 2;

/** Fetch candidates in order; the first that yields a document matching the paper wins. */
async function tryAttempts(deps: Deps, paper: { doi: string; title: string }, attempts: Attempt[], contentOrigin: string, key: string): Promise<TierResult> {
  const failures: Failure[] = [];
  for (const a of attempts) {
    deps.signal?.throwIfAborted();
    const arxiv = isArxivHost(a.url);
    if (arxiv && arxivCoolingDown(deps.cfg.sleep)) {
      failures.push({ kind: a.kind, code: "download_failed" });
      continue;
    }
    try {
      if (arxiv) await arxivSpacer(deps.cfg.sleep).wait();
      const got = await deps.download(a.url, {
        maxBytes: MAX_SOURCE_BYTES,
        signal: deps.signal,
        ...(a.credentialed ? { credential: { origin: contentOrigin, param: "api_key", value: key } } : {}),
      });
      if (arxiv) noteArxivSuccess(deps.cfg.sleep);
      return { source: await prepareFromBytes({ bytes: got.bytes, kind: a.kind, ref: got.finalUrl, license: a.license, paper }) };
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      if (arxiv && err instanceof Error && /HTTP (?:429|403)\b/.test(err.message)) noteArxivRefusal(deps.cfg.sleep);
      failures.push({ kind: a.kind, code: err instanceof SourceError ? err.code : "download_failed" });
    }
  }
  return { failures };
}

/** Candidates Semantic Scholar names for this DOI. A lookup that fails, is rate limited or answers for another work yields none. */
async function semanticScholarAttempts(deps: Deps, paper: { doi: string }, seen: Set<string>): Promise<Attempt[]> {
  const { cfg } = deps;
  const key = cfg.semanticScholarApiKey?.trim() ?? "";
  const url = `${cfg.semanticScholarBaseUrl}/graph/v1/paper/DOI:${paper.doi.split("/").map(encodeURIComponent).join("/")}?fields=openAccessPdf,externalIds`;
  let record: Record<string, unknown> | null;
  try {
    await semanticScholarSpacer(cfg).wait();
    const res = await fetchWithRetry(deps.fetch, url, { ...retryOpts(cfg), ...(key ? { headers: { "x-api-key": key } } : {}) });
    if (res.status !== 200) return [];
    record = asRecord(parseJsonBody(res.body, "semantic-scholar"));
  } catch {
    return [];
  }
  const ids = asRecord(record?.["externalIds"]);
  const recordDoi = normalizeRegistryDoi(asString(ids?.["DOI"]) ?? "");
  if (record === null || (recordDoi !== null && recordDoi !== paper.doi)) return [];
  const attempts: Attempt[] = [];
  const pdf = asRecord(record["openAccessPdf"]);
  const pdfUrl = asString(pdf?.["url"]);
  if (pdfUrl !== null && pdfUrl !== "" && !isDoiResolver(pdfUrl) && !seen.has(pdfUrl)) {
    seen.add(pdfUrl);
    attempts.push({ kind: "s2-open-access-pdf", url: pdfUrl, license: asString(pdf?.["license"]), credentialed: false });
  }
  const arxiv = asString(ids?.["ArXiv"]);
  if (arxiv !== null && isArxivId(arxiv) && !seen.has(arxivPdfUrl(arxiv))) {
    seen.add(arxivPdfUrl(arxiv));
    const own = arxivIdFromDoi(paper.doi);
    attempts.push({ kind: own !== null && sameArxivWork(own, arxiv) ? "arxiv-pdf" : "arxiv-preprint-pdf", url: arxivPdfUrl(arxiv), license: null, credentialed: false });
  }
  return attempts;
}

const PMC_OPEN_DATA = "https://pmc-oa-opendata.s3.amazonaws.com";
const EUROPE_PMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";

/** The PubMed Central open-access copy of `pmcid` from the AWS open-data bucket (built for programmatic access, no bot challenge):
 *  list the versions, read the newest version's JSON, require the same DOI, and turn its `s3://` pdf_url into the bucket's HTTPS URL. */
async function pmcOpenDataAttempt(deps: Deps, paper: { doi: string }, pmcid: string): Promise<Attempt | null> {
  const base = deps.cfg.pmcOpenDataBaseUrl ?? PMC_OPEN_DATA;
  try {
    const list = await fetchWithRetry(deps.fetch, `${base}/?list-type=2&prefix=${encodeURIComponent(`${pmcid}.`)}&delimiter=/`, retryOpts(deps.cfg));
    if (list.status !== 200) return null;
    const versions = [...list.body.matchAll(/<Prefix>(PMC\d+)\.(\d+)\/<\/Prefix>/g)].filter((m) => m[1] === pmcid).map((m) => Number(m[2]));
    if (versions.length === 0) return null;
    const version = Math.max(...versions);
    const meta = await fetchWithRetry(deps.fetch, `${base}/${pmcid}.${version}/${pmcid}.${version}.json`, retryOpts(deps.cfg));
    if (meta.status !== 200) return null;
    const rec = asRecord(JSON.parse(meta.body) as unknown);
    if (rec === null || asString(rec["pmcid"]) !== pmcid || normalizeRegistryDoi(asString(rec["doi"]) ?? "") !== paper.doi) return null;
    const m = /^s3:\/\/pmc-oa-opendata\/([^?#]+)/.exec(asString(rec["pdf_url"]) ?? "");
    const key = m?.[1] ?? "";
    if (!new RegExp(`^${pmcid}\\.${version}/[A-Za-z0-9._-]+\\.pdf$`).test(key)) return null;
    return { kind: "pmc-pdf", url: `${base}/${key}`, license: asString(rec["license_code"]), credentialed: false };
  } catch {
    return null;
  }
}

/** What Europe PMC knows about this DOI: the PubMed Central open-data copy of its PMCID, then open-access PDF links on other hosts.
 *  europepmc.org's own `?pdf=render` links answer scripted clients with a bot challenge and are never fetched. */
async function europePmcAttempts(deps: Deps, paper: { doi: string }, seen: Set<string>): Promise<Attempt[]> {
  const { cfg } = deps;
  const url = `${cfg.europePmcBaseUrl ?? EUROPE_PMC}/search?query=${encodeURIComponent(`DOI:"${paper.doi}"`)}&resultType=core&format=json&pageSize=1`;
  let records: unknown[];
  try {
    const res = await fetchWithRetry(deps.fetch, url, retryOpts(cfg));
    if (res.status !== 200) return [];
    records = asArray(asRecord(asRecord(JSON.parse(res.body) as unknown)?.["resultList"])?.["result"]);
  } catch {
    return [];
  }
  const attempts: Attempt[] = [];
  for (const raw of records) {
    const rec = asRecord(raw);
    if (rec === null || normalizeRegistryDoi(asString(rec["doi"]) ?? "") !== paper.doi) continue;
    const pmcid = asString(rec["pmcid"]);
    if (pmcid !== null && /^PMC\d+$/.test(pmcid)) {
      const pmc = await pmcOpenDataAttempt(deps, paper, pmcid);
      if (pmc !== null && !seen.has(pmc.url)) {
        seen.add(pmc.url);
        attempts.push(pmc);
      }
    }
    for (const entry of asArray(asRecord(rec["fullTextUrlList"])?.["fullTextUrl"])) {
      const e = asRecord(entry);
      const href = asString(e?.["url"]);
      if (e === null || href === null || e["documentStyle"] !== "pdf" || !["OA", "F"].includes(String(e["availabilityCode"])) || isDoiResolver(href) || seen.has(href)) continue;
      let host = "";
      try {
        host = new URL(href).hostname.toLowerCase();
      } catch {
        continue;
      }
      if (host === "europepmc.org" || host === "www.europepmc.org") continue;
      seen.add(href);
      if (attempts.length < MAX_DERIVED_CANDIDATES) attempts.push({ kind: "epmc-pdf", url: href, license: null, credentialed: false });
    }
  }
  return attempts;
}

export async function acquireSource(deps: Deps, paper: { doi: string; title: string }): Promise<AcquireResult> {
  const { cfg } = deps;
  const key = cfg.openalexApiKey?.trim() ?? "";
  const lookup =
    `${cfg.openalexBaseUrl}/works/${encodeURIComponent(`https://doi.org/${paper.doi}`)}` + (key ? `?api_key=${encodeURIComponent(key)}` : "");
  // OpenAlex not answering usefully does not end the search: Semantic Scholar may still know an open copy.
  let work: Record<string, unknown> | null = null;
  let unusable: AcquireResult | null = null;
  try {
    const res = await fetchWithRetry(deps.fetch, lookup, retryOpts(cfg));
    if (res.status === 404) unusable = { ok: false, status: "unavailable", code: "no_open_copy", detail: "OpenAlex does not know this work" };
    else if (res.status !== 200) unusable = { ok: false, status: "failed", code: "download_failed", detail: `OpenAlex lookup answered HTTP ${res.status}` };
    else {
      work = asRecord(parseJsonBody(res.body, "openalex"));
      if (work === null) unusable = { ok: false, status: "failed", code: "download_failed", detail: "OpenAlex returned an unusable record" };
    }
  } catch {
    unusable = { ok: false, status: "failed", code: "download_failed", detail: "OpenAlex lookup failed" };
  }
  if (work !== null) {
    const recordDoi = normalizeRegistryDoi(asString(work["doi"]) ?? "");
    if (recordDoi !== null && recordDoi !== paper.doi) {
      return { ok: false, status: "failed", code: "identity_mismatch", detail: "OpenAlex resolved this DOI to a different work" };
    }
  }

  const attempts: Attempt[] = [];
  const seen = new Set<string>();
  const origin = cfg.openalexContentOrigin ?? DEFAULT_CONTENT_ORIGIN;
  let contentOffered = false;
  if (work !== null) {
    const locations = [asRecord(work["best_oa_location"]), ...asArray(work["locations"]).map(asRecord)];
    for (const loc of locations) {
      const url = asString(loc?.["pdf_url"]);
      if (loc === null || url === null || loc["is_oa"] !== true || seen.has(url)) continue;
      seen.add(url);
      if (attempts.length < MAX_PDF_URL_CANDIDATES) attempts.push({ kind: "openalex-pdf-url", url, license: asString(loc["license"]), credentialed: false });
    }

    // arXiv: the PDF of an arXiv identifier the paper's own DOI or an open location names. A record that lists only the landing page
    // (OpenAlex often does for arXiv) has no pdf_url, yet the arXiv PDF URL follows from the identifier.
    const ownArxiv = arxivIdFromDoi(paper.doi);
    const arxivIds: string[] = ownArxiv !== null ? [ownArxiv] : [];
    for (const loc of locations) {
      if (loc?.["is_oa"] !== true) continue;
      const id = arxivIdFromUrl(asString(loc["landing_page_url"]) ?? "") ?? arxivIdFromUrl(asString(loc["pdf_url"]) ?? "");
      if (id !== null) arxivIds.push(id);
    }
    let derived = 0;
    for (const id of arxivIds) {
      const url = arxivPdfUrl(id);
      if (seen.has(url) || derived >= MAX_DERIVED_CANDIDATES) continue;
      seen.add(url);
      derived++;
      attempts.push({ kind: ownArxiv !== null && sameArxivWork(ownArxiv, id) ? "arxiv-pdf" : "arxiv-preprint-pdf", url, license: null, credentialed: false });
    }

    // `oa_url` may be a PDF or a landing page: it is fetched like any candidate and must pass the document check. A DOI link is
    // a redirector to the publisher's page (often bot-gated), so it is not tried.
    const access = asRecord(work["open_access"]);
    const oaUrl = asString(access?.["oa_url"]);
    if (access?.["is_oa"] === true && oaUrl !== null && !isDoiResolver(oaUrl) && !seen.has(oaUrl)) {
      seen.add(oaUrl);
      attempts.push({ kind: "openalex-oa-url", url: oaUrl, license: null, credentialed: false });
    }

    // Content API tier: only the record's own content_urls, only on the Content
    // API origin, only with the user's key.
    const hasContent = asRecord(work["has_content"]);
    const contentUrls = asRecord(work["content_urls"]);
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
  }

  const failures: Failure[] = [];
  const first = await tryAttempts(deps, paper, attempts, origin, key);
  if ("source" in first) return { ok: true, source: first.source };
  failures.push(...first.failures);

  // Last resorts, asked only now so a run that already has its source spends no quota: Europe PMC (a published or author-manuscript copy)
  // before Semantic Scholar (which may only know a preprint).
  const epmc = await tryAttempts(deps, paper, await europePmcAttempts(deps, paper, seen), origin, key);
  if ("source" in epmc) return { ok: true, source: epmc.source };
  failures.push(...epmc.failures);
  const s2 = await semanticScholarAttempts(deps, paper, seen);
  const second = await tryAttempts(deps, paper, s2, origin, key);
  if ("source" in second) return { ok: true, source: second.source };
  failures.push(...second.failures);

  if (failures.length > 0) {
    return { ok: false, status: "failed", code: failures[0].code, detail: failures.map((f) => `${f.kind}: ${f.code}`).join("; ") };
  }
  if (unusable !== null) return unusable;
  return contentOffered
    ? { ok: false, status: "unavailable", code: "no_credential", detail: "only the OpenAlex Content API offers this paper; set OPENALEX_API_KEY" }
    : { ok: false, status: "unavailable", code: "no_open_copy", detail: "no direct PDF link, arXiv copy or Content API copy was found for this paper in OpenAlex (or in Semantic Scholar, when it answered); landing pages are not scraped. Attach a PDF with paper_registry attach_source, or set OPENALEX_API_KEY if the Content API holds it" };
}
