/**
 * Source extraction (KTD3–KTD5): acquired bytes → the one captured text that
 * evidence spans index. PDF text comes from `unpdf` (maintained pdf.js
 * wrapper, pure JS — no system binary); GROBID TEI (OpenAlex Content API)
 * from `fast-xml-parser`. Both are measured choices — see DECISIONS.
 *
 * Contract: unusable input never becomes text. Every failure is a
 * `SourceError` with a normalized code; raw parser exceptions never leave
 * this module. No OCR: an image-only PDF is `no_text_layer`.
 */

import { gunzipSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { extractText, getDocumentProxy } from "unpdf";

import { decodeHtmlEntities } from "../bibrender.ts";
import { MAX_SECTION_LABEL_CHARS, type SectionMark } from "../sections.ts";
import { detectHeadings } from "./headings.ts";

export type SourceFailureCode =
  | "malformed"
  | "truncated"
  | "no_text_layer"
  | "not_a_document"
  | "too_large"
  | "unsupported_xml"
  | "identity_mismatch"
  | "unsafe_destination"
  | "unsafe_redirect"
  | "download_failed"
  | "no_open_copy"
  | "no_credential"
  | "acquisition_disabled"
  | "deferred";

export class SourceError extends Error {
  readonly code: SourceFailureCode;
  constructor(code: SourceFailureCode, message: string) {
    super(message);
    this.name = "SourceError";
    this.code = code;
  }
}

export interface Extraction {
  /** Captured text; evidence spans are zero-based, end-exclusive UTF-16 offsets into it. */
  text: string;
  /** Start offset of each page when the extractor grounds pages; else null. */
  pageStarts: number[] | null;
  /** Extractor identity + version: the extraction half of the pointer revision. */
  extraction: string;
  /** Section marks (text offsets of heading lines) when structure was found; null = none known.
   *  Chunking consumes them; they are not part of the pointer revision (offsets index `text`). */
  sections: SectionMark[] | null;
}

/** Tied to the installed dependency by tests/source-extract.spec.ts. */
export const UNPDF_VERSION = "1.8.1";
export const FAST_XML_PARSER_VERSION = "5.11.2";
export const PDF_EXTRACTION_ID = `unpdf@${UNPDF_VERSION}/pages-v1`;
export const TEI_EXTRACTION_ID = `grobid-tei@fxp${FAST_XML_PARSER_VERSION}/body-v1`;

/** Client policy: largest acquired document (download and local file). Real
 *  open-access papers are a few MB; scanned books go beyond this. */
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
/** Client policy: page ceiling bounding parser work (long theses stay under it). */
export const MAX_PDF_PAGES = 1000;
/** Client policy: decoded TEI ceiling (a 56 KB gzip decoded to ~300 KB live). */
export const MAX_TEI_DECODED_BYTES = 32 * 1024 * 1024;
/** Client policy: below this many non-space characters a document is a scan
 *  with stray glyphs, not extractable text. */
export const MIN_USABLE_TEXT_CHARS = 50;

const PAGE_SEPARATOR = "\n\n";

function hasUsableText(text: string): boolean {
  return text.replace(/\s+/gu, "").length >= MIN_USABLE_TEXT_CHARS;
}

function indexOfBytes(bytes: Uint8Array, needle: string, from: number, to: number): number {
  const n = Buffer.from(needle, "latin1");
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).subarray(from, to).indexOf(n);
}

export async function extractPdf(bytes: Uint8Array): Promise<Extraction> {
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw new SourceError("too_large", `document exceeds ${MAX_SOURCE_BYTES} bytes`);
  if (indexOfBytes(bytes, "%PDF-", 0, Math.min(bytes.byteLength, 1024)) === -1) {
    throw new SourceError("not_a_document", "the body is not a PDF document");
  }
  // A complete PDF ends with %%EOF; its absence means the download was cut.
  if (indexOfBytes(bytes, "%%EOF", Math.max(0, bytes.byteLength - 4096), bytes.byteLength) === -1) {
    throw new SourceError("truncated", "the PDF has no end-of-file marker");
  }
  let pages: string[];
  try {
    // unpdf bundles the serverless (eval-free) pdf.js build.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    try {
      if (pdf.numPages > MAX_PDF_PAGES) throw new SourceError("too_large", `document has more than ${MAX_PDF_PAGES} pages`);
      pages = (await extractText(pdf, { mergePages: false })).text.map((t) => t.replace(/\r\n?/g, "\n").replace(/\0/g, ""));
    } finally {
      await pdf.loadingTask.destroy();
    }
  } catch (err) {
    if (err instanceof SourceError) throw err;
    throw new SourceError("malformed", "the PDF could not be parsed");
  }
  const pageStarts: number[] = [];
  let text = "";
  pages.forEach((p, i) => {
    if (i > 0) text += PAGE_SEPARATOR;
    pageStarts.push(text.length);
    text += p;
  });
  if (!hasUsableText(text)) throw new SourceError("no_text_layer", "the PDF has no extractable text layer (scanned/image-only; no OCR)");
  const sections = detectHeadings(text);
  return { text, pageStarts, extraction: PDF_EXTRACTION_ID, sections: sections.length > 0 ? sections : null };
}

// ── TEI ─────────────────────────────────────────────────────────────────────

type XNode = Record<string, unknown>;

/** preserveOrder trees: each node is `{ tag: XNode[] }` or `{ "#text": string }`. */
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: true,
  processEntities: false, // entities decoded once below; nothing is ever resolved
  trimValues: false,
  parseTagValue: false,
});

function textOf(nodes: XNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (typeof n["#text"] === "string") out += n["#text"];
    else for (const [tag, kids] of Object.entries(n)) if (tag !== ":@" && Array.isArray(kids)) out += textOf(kids as XNode[]);
  }
  return out;
}

const clean = (s: string): string => decodeHtmlEntities(s).replace(/\s+/gu, " ").trim();

function find(nodes: XNode[], tag: string, found: XNode[][] = []): XNode[][] {
  for (const n of nodes) {
    for (const [t, kids] of Object.entries(n)) {
      if (t === ":@" || !Array.isArray(kids)) continue;
      if (t === tag) found.push(kids as XNode[]);
      else find(kids as XNode[], tag, found);
    }
  }
  return found;
}

interface Block {
  text: string;
  head: boolean;
}

/** Ordered heads/paragraphs under `nodes` (figures and tables are skipped). */
function blocks(nodes: XNode[], out: Block[]): void {
  for (const n of nodes) {
    for (const [t, kids] of Object.entries(n)) {
      if (t === ":@" || !Array.isArray(kids)) continue;
      if (t === "head" || t === "p") {
        const s = clean(textOf(kids as XNode[]));
        // a "head" longer than any heading is a mis-parsed paragraph: keep its text, not a section mark
        if (s.length > 0) out.push({ text: s, head: t === "head" && s.length <= MAX_SECTION_LABEL_CHARS });
      } else if (t !== "figure" && t !== "note") blocks(kids as XNode[], out);
    }
  }
}

export function extractTei(bytes: Uint8Array): Extraction {
  let raw: Buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (raw.byteLength > MAX_SOURCE_BYTES) throw new SourceError("too_large", `document exceeds ${MAX_SOURCE_BYTES} bytes`);
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      raw = gunzipSync(raw, { maxOutputLength: MAX_TEI_DECODED_BYTES });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ERR_BUFFER_TOO_LARGE") throw new SourceError("too_large", "decoded TEI exceeds the size limit");
      throw new SourceError("malformed", "the TEI gzip stream is damaged");
    }
  }
  if (raw.byteLength > MAX_TEI_DECODED_BYTES) throw new SourceError("too_large", "decoded TEI exceeds the size limit");
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new SourceError("malformed", "the TEI is not valid UTF-8");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new SourceError("unsupported_xml", "DOCTYPE and entity declarations are refused");
  if (!/<TEI[\s>]/.test(xml)) throw new SourceError("not_a_document", "the body is not a TEI document");

  let tree: XNode[];
  try {
    tree = parser.parse(xml) as XNode[];
  } catch {
    throw new SourceError("malformed", "the TEI could not be parsed");
  }
  const front: Block[] = []; // title + abstract: never section marks
  const header = find(tree, "teiHeader")[0] ?? [];
  const title = find(find(header, "titleStmt")[0] ?? [], "title")[0];
  if (title) {
    const t = clean(textOf(title));
    if (t.length > 0) front.push({ text: t, head: false });
  }
  const abstract = find(header, "abstract")[0];
  if (abstract) blocks(abstract, front);
  const bodyBlocks: Block[] = [];
  const body = find(tree, "body")[0];
  if (body) blocks(body, bodyBlocks);
  // A header-only TEI (title + abstract) is not a readable paper: the body must carry the text.
  if (!hasUsableText(bodyBlocks.map((b) => b.text).join(""))) throw new SourceError("no_text_layer", "the TEI body holds no text");
  let text = "";
  const sections: SectionMark[] = [];
  [...front.map((b) => ({ ...b, head: false })), ...bodyBlocks].forEach((b, i) => {
    if (i > 0) text += "\n\n";
    if (b.head) sections.push({ start: text.length, heading: b.text, level: 1 });
    text += b.text;
  });
  return { text, pageStarts: null, extraction: TEI_EXTRACTION_ID, sections: sections.length > 0 ? sections : null };
}

// ── identity ────────────────────────────────────────────────────────────────

const tokensOf = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Client policy: share of title tokens that must appear IN ORDER as a near-contiguous
 *  phrase in the document's opening. Unordered word overlap is not identity: a related
 *  paper by the same authors shares most title words (found by the CLI smoke). */
const TITLE_COVERAGE = 0.85;
/** Client policy: "opening" is roughly the first page. Identity evidence (title, DOI,
 *  arXiv stamp) counts only there: a reference list names OTHER papers' identifiers. */
const OPENING_CHARS = 6_000;
/** Text tokens a match may skip between two title tokens (line breaks, stray marks, a symbol). */
const MAX_GAP = 3;

/** Best in-order, near-contiguous coverage of `want` inside `have` (0..1). */
function phraseCoverage(want: string[], have: string[]): number {
  let best = 0;
  for (let w = 0; w < have.length; w++) {
    let p = want.indexOf(have[w]);
    if (p === -1 || p > 2) continue; // a match must begin at one of the title's first words
    let matched = 0;
    let gap = 0;
    for (let i = w; i < have.length && p < want.length; i++) {
      if (have[i] === want[p]) {
        matched++;
        p++;
        gap = 0;
      } else if (p + 1 < want.length && have[i] === want[p + 1]) {
        matched++; // a title word dropped from the text
        p += 2;
        gap = 0;
      } else if (++gap > MAX_GAP) break;
    }
    best = Math.max(best, matched / want.length);
    if (best === 1) break;
  }
  return best;
}

/**
 * Does the extracted text belong to this registered paper? Attested, in the
 * opening only, by the DOI, by the arXiv identifier stamp for an arXiv DOI, or
 * by the title appearing as an ordered phrase. Without usable title
 * words only the DOI (or arXiv stamp) counts — a source that cannot be tied to
 * the paper is not evidence for it.
 */
export function matchesPaperIdentity(text: string, paper: { doi: string; title: string }): boolean {
  const opening = text.slice(0, OPENING_CHARS);
  if (opening.toLowerCase().includes(paper.doi.toLowerCase())) return true;
  const arxiv = /^10\.48550\/arxiv\.(\d{4}\.\d{4,5})$/i.exec(paper.doi);
  if (arxiv !== null && new RegExp(`arxiv:\\s*${arxiv[1].replace(".", "\\.")}(?:v\\d+)?`, "i").test(opening)) return true;
  const want = tokensOf(paper.title);
  if (want.length < 2) return false;
  // Undo line-end hyphenation ("Lith- ium") — for this check only; stored text is untouched.
  return phraseCoverage(want, tokensOf(opening.replace(/(\p{L})-\s+(\p{L})/gu, "$1$2"))) >= TITLE_COVERAGE;
}
