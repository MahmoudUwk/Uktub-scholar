/**
 * Source preparation (KTD3, R7, R11, R15): lawful OpenAlex acquisition tiers
 * and local-file preparation turn bytes into a captured, identity-checked
 * source — or a truthful readiness outcome. Offline: OpenAlex answers and
 * downloads are fakes; no network, no quota.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { acquireSource, prepareFromBytes, type AcquireResult } from "../src/core/source/prepare.ts";
import { SourceError, PDF_EXTRACTION_ID, TEI_EXTRACTION_ID } from "../src/core/source/extract.ts";
import type { DownloadLike } from "../src/core/source/download.ts";
import { cfg, createFakeFetch } from "./helpers/provider-fakes.ts";
import { makePdf, makeTei } from "./helpers/pdf.ts";

const PAPER = { doi: "10.1234/cells", title: "Cycle Life of Lithium Cells Under Thermal Stress" };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const goodPdf = makePdf([[PAPER.title, "Cells age faster at high temperature and capacity fades with every cycle."]]);
const otherPdf = makePdf([["Federated learning for wireless foundation models. We propose a novel encoder architecture."]]);
const goodTei = new TextEncoder().encode(
  makeTei({ title: PAPER.title, doi: PAPER.doi, sections: [{ head: "Introduction", paragraphs: ["Cells age faster at high temperature and capacity fades with every cycle."] }] }),
);

const KEY = "SECRET-KEY";
const CONTENT = "https://content.openalex.test";
const conf = (extra: Record<string, unknown> = {}) => cfg({ openalexContentOrigin: CONTENT, ...extra });

type Loc = { is_oa?: boolean; pdf_url?: string | null; license?: string | null };
function openalexRoute(work: { locations?: Loc[]; best?: Loc | null; has_content?: { pdf?: boolean; grobid_xml?: boolean }; content_urls?: { pdf?: string; grobid_xml?: string } } | 404 | 500) {
  return {
    match: (u: string) => u.startsWith("https://api.openalex.test/works/"),
    status: work === 404 ? 404 : work === 500 ? 500 : 200,
    body: typeof work === "number" ? "{}" : JSON.stringify({ id: "https://openalex.org/W1", doi: `https://doi.org/${PAPER.doi}`, locations: work.locations ?? [], best_oa_location: work.best ?? null, has_content: work.has_content ?? { pdf: false, grobid_xml: false }, content_urls: work.content_urls ?? {} }),
  };
}

interface DlCall { url: string; credential: boolean }
function fakeDownload(files: Record<string, Uint8Array | SourceError>): { download: DownloadLike; calls: DlCall[] } {
  const calls: DlCall[] = [];
  return {
    calls,
    download: async (url, init) => {
      calls.push({ url, credential: init.credential !== undefined });
      const f = files[url];
      if (f === undefined) throw new SourceError("download_failed", "the host answered HTTP 404");
      if (f instanceof SourceError) throw f;
      return { finalUrl: url, contentType: null, bytes: f };
    },
  };
}

async function run(work: Parameters<typeof openalexRoute>[0], files: Record<string, Uint8Array | SourceError>, opts: { key?: string } = {}) {
  const { fetchFn } = createFakeFetch([openalexRoute(work)]);
  const dl = fakeDownload(files);
  const result = await acquireSource({ fetch: fetchFn, download: dl.download, cfg: conf(opts.key ? { openalexApiKey: opts.key } : {}) }, PAPER);
  return { result, calls: dl.calls };
}
const failed = (r: AcquireResult) => {
  assert.equal(r.ok, false);
  return r as Extract<AcquireResult, { ok: false }>;
};

describe("prepareFromBytes", () => {
  it("captures a PDF with digest, extraction identity and pages, and ties it to the paper", async () => {
    const s = await prepareFromBytes({ bytes: goodPdf, kind: "local-file", ref: "papers/cells.pdf", paper: PAPER });
    assert.equal(s.digest, sha(goodPdf));
    assert.equal(s.extraction, PDF_EXTRACTION_ID);
    assert.ok(s.text.includes("Cells age faster"));
    assert.ok(s.pageStarts !== null);
    assert.equal(s.ref, "papers/cells.pdf");
  });

  it("captures TEI (plain or gzip) with its own extraction identity", async () => {
    for (const bytes of [goodTei, new Uint8Array(gzipSync(goodTei))]) {
      const s = await prepareFromBytes({ bytes, kind: "openalex-content-tei", ref: "https://content.openalex.test/works/W1.grobid-xml", paper: PAPER });
      assert.equal(s.extraction, TEI_EXTRACTION_ID);
      assert.equal(s.digest, sha(bytes));
    }
  });

  it("refuses a source that is not this paper (identity_mismatch)", async () => {
    await assert.rejects(prepareFromBytes({ bytes: otherPdf, kind: "local-file", ref: "x.pdf", paper: PAPER }), (e) => e instanceof SourceError && e.code === "identity_mismatch");
  });

  it("refuses HTML pages, image-only PDFs and truncated PDFs with their own codes", async () => {
    const cases: [Uint8Array, string][] = [
      [new TextEncoder().encode("<html>Sign in to read</html>"), "not_a_document"],
      [makePdf([[]]), "no_text_layer"],
      [goodPdf.slice(0, Math.floor(goodPdf.length / 2)), "truncated"],
    ];
    for (const [bytes, code] of cases) {
      await assert.rejects(prepareFromBytes({ bytes, kind: "local-file", ref: "x", paper: PAPER }), (e) => e instanceof SourceError && e.code === code, code);
    }
  });
});

describe("acquireSource", () => {
  it("tier 1: uses a supplied open-access pdf_url, without any credential", async () => {
    const { result, calls } = await run({ best: { is_oa: true, pdf_url: "https://repo.example/cells.pdf", license: "cc-by" } }, { "https://repo.example/cells.pdf": goodPdf }, { key: KEY });
    assert.equal(result.ok, true);
    const s = (result as Extract<AcquireResult, { ok: true }>).source;
    assert.equal(s.kind, "openalex-pdf-url");
    assert.equal(s.ref, "https://repo.example/cells.pdf");
    assert.equal(s.license, "cc-by");
    assert.deepEqual(calls, [{ url: "https://repo.example/cells.pdf", credential: false }]);
  });

  it("skips closed locations and tries the next open candidate after a bad one", async () => {
    const { result, calls } = await run(
      { locations: [{ is_oa: false, pdf_url: "https://closed.example/a.pdf" }, { is_oa: true, pdf_url: "https://repo.example/bad.pdf" }, { is_oa: true, pdf_url: "https://repo.example/good.pdf" }] },
      { "https://repo.example/bad.pdf": otherPdf, "https://repo.example/good.pdf": goodPdf },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((c) => c.url), ["https://repo.example/bad.pdf", "https://repo.example/good.pdf"]);
  });

  it("tier 2: falls back to the Content API TEI at the record's own content_urls, credential scoped", async () => {
    const tei = `${CONTENT}/works/W1.grobid-xml`;
    const { result, calls } = await run({ has_content: { grobid_xml: true, pdf: true }, content_urls: { grobid_xml: tei, pdf: `${CONTENT}/works/W1.pdf` } }, { [tei]: new Uint8Array(gzipSync(goodTei)) }, { key: KEY });
    assert.equal(result.ok, true);
    assert.equal((result as Extract<AcquireResult, { ok: true }>).source.kind, "openalex-content-tei");
    assert.deepEqual(calls, [{ url: tei, credential: true }]);
  });

  it("tier 2: uses the Content API PDF when TEI is absent or unusable", async () => {
    const pdf = `${CONTENT}/works/W1.pdf`;
    const { result } = await run({ has_content: { pdf: true }, content_urls: { pdf } }, { [pdf]: goodPdf }, { key: KEY });
    assert.equal((result as Extract<AcquireResult, { ok: true }>).source.kind, "openalex-content-pdf");
  });

  it("never synthesizes content URLs and never sends the key to a foreign origin", async () => {
    const foreign = "https://evil.example/works/W1.pdf";
    const { result, calls } = await run({ has_content: { pdf: true }, content_urls: { pdf: foreign } }, { [foreign]: goodPdf }, { key: KEY });
    assert.equal(failed(result).status, "unavailable");
    assert.equal(calls.length, 0, "a content URL off the Content API origin is not fetched");
    const none = await run({ has_content: { pdf: true } }, {}, { key: KEY });
    assert.equal(none.calls.length, 0, "has_content without a content_urls entry is not guessed");
  });

  it("reports unavailable/no_credential when only the Content API could serve it and no key is set", async () => {
    const pdf = `${CONTENT}/works/W1.pdf`;
    const { result, calls } = await run({ has_content: { pdf: true }, content_urls: { pdf } }, { [pdf]: goodPdf });
    const f = failed(result);
    assert.deepEqual([f.status, f.code], ["unavailable", "no_credential"]);
    assert.equal(calls.length, 0);
  });

  it("says what is missing: open-access locations without a direct PDF link are not described as 'no open copy' (live OpenAlex finding)", async () => {
    const { result } = await run({ best: { is_oa: true, pdf_url: null }, locations: [{ is_oa: true, pdf_url: null, license: "cc-by" }] }, {});
    const f = failed(result);
    assert.equal(f.code, "no_open_copy");
    assert.match(f.detail, /no direct PDF link/i);
    assert.match(f.detail, /attach/i, "the detail names the way forward");
  });

  it("reports unavailable/no_open_copy when the work has no open copy at all, and for an unknown work", async () => {
    assert.deepEqual(((r) => [r.status, r.code])(failed((await run({ locations: [{ is_oa: false, pdf_url: "https://x.example/a.pdf" }] }, {})).result)), ["unavailable", "no_open_copy"]);
    assert.deepEqual(((r) => [r.status, r.code])(failed((await run(404, {})).result)), ["unavailable", "no_open_copy"]);
  });

  it("reports failed with the normalized reason when candidates exist but none yields a usable source", async () => {
    const { result } = await run({ best: { is_oa: true, pdf_url: "https://repo.example/other.pdf" } }, { "https://repo.example/other.pdf": otherPdf });
    const f = failed(result);
    assert.deepEqual([f.status, f.code], ["failed", "identity_mismatch"]);
    const down = await run({ best: { is_oa: true, pdf_url: "https://repo.example/a.pdf" } }, { "https://repo.example/a.pdf": new SourceError("unsafe_destination", "the host resolves to a non-public address") });
    assert.equal(failed(down.result).code, "unsafe_destination");
  });

  it("a provider outage is failed/download_failed, not unavailable", async () => {
    assert.deepEqual(((r) => [r.status, r.code])(failed((await run(500, {})).result)), ["failed", "download_failed"]);
  });

  it("failure details carry no secrets or raw URLs with credentials", async () => {
    const tei = `${CONTENT}/works/W1.grobid-xml`;
    const { result } = await run({ has_content: { grobid_xml: true }, content_urls: { grobid_xml: tei } }, { [tei]: new SourceError("download_failed", "the request failed") }, { key: KEY });
    assert.ok(!JSON.stringify(result).includes(KEY));
  });

  it("an OpenAlex record for a different DOI is never accepted as this paper's source", async () => {
    const { fetchFn } = createFakeFetch([{ match: (u) => u.startsWith("https://api.openalex.test/works/"), body: JSON.stringify({ doi: "https://doi.org/10.9999/other", locations: [{ is_oa: true, pdf_url: "https://repo.example/cells.pdf" }] }) }]);
    const dl = fakeDownload({ "https://repo.example/cells.pdf": goodPdf });
    const r = await acquireSource({ fetch: fetchFn, download: dl.download, cfg: conf() }, PAPER);
    assert.equal(failed(r).code, "identity_mismatch");
    assert.equal(dl.calls.length, 0);
  });
});
