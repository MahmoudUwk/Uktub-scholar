/**
 * Open-access acquisition routes beyond the OpenAlex `pdf_url` list (owner decision 2026-10-07: any lawful
 * open-access source a provider record names is allowed, with every transport guard kept):
 *   - an arXiv PDF derived from an arXiv DOI or an arXiv location in the OpenAlex record;
 *   - OpenAlex `open_access.oa_url`;
 *   - Semantic Scholar `openAccessPdf.url` and its `externalIds.ArXiv` preprint, asked only when the OpenAlex tier yields nothing.
 * Offline: provider answers and downloads are fakes. Found live (iter-12): three papers ended `no_open_copy` although an
 * arXiv copy existed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { acquireSource, type AcquireResult } from "../src/core/source/prepare.ts";
import { SourceError } from "../src/core/source/extract.ts";
import type { DownloadLike } from "../src/core/source/download.ts";
import { cfg, createFakeFetch } from "./helpers/provider-fakes.ts";
import { makePdf } from "./helpers/pdf.ts";

const TITLE = "Cycle Life of Lithium Cells Under Thermal Stress";
const ARXIV_PAPER = { doi: "10.48550/arxiv.2511.15162", title: TITLE };
const JOURNAL_PAPER = { doi: "10.1109/ojcoms.2025.3600616", title: TITLE };
const goodPdf = makePdf([[TITLE, "Cells age faster at high temperature and capacity fades with every cycle."]]);
const otherPdf = makePdf([["Federated learning for wireless foundation models. We propose a novel encoder architecture."]]);
const html = new TextEncoder().encode("<html><body>Please enable JavaScript</body></html>");
const KEY = "S2-SECRET-KEY";
const noSleep = async () => {};

type Work = Record<string, unknown>;
const openalex = (paper: { doi: string }, work: Work) => ({
  match: (u: string) => u.startsWith("https://api.openalex.test/works/"),
  body: JSON.stringify({ id: "https://openalex.org/W1", doi: `https://doi.org/${paper.doi}`, ...work }),
});
const s2Route = (body: unknown, status = 200) => ({
  match: (u: string) => u.startsWith("https://api.semanticscholar.test/graph/v1/paper/DOI:"),
  status,
  body: JSON.stringify(body),
});

function fakeDownload(files: Record<string, Uint8Array | SourceError>) {
  const calls: Array<{ url: string; credential: boolean }> = [];
  const download: DownloadLike = async (url, init) => {
    calls.push({ url, credential: init.credential !== undefined });
    const f = files[url];
    if (f === undefined) throw new SourceError("download_failed", "the host answered HTTP 404");
    if (f instanceof SourceError) throw f;
    return { finalUrl: url, contentType: null, bytes: f };
  };
  return { download, calls };
}

async function run(
  paper: { doi: string; title: string },
  routes: Array<{ match: (u: string) => boolean; status?: number; body: string }>,
  files: Record<string, Uint8Array | SourceError>,
  config: Record<string, unknown> = {},
) {
  const { fetchFn, requests } = createFakeFetch(routes);
  const dl = fakeDownload(files);
  // A no-op clock by default: the real spacings (arXiv 3 s, Semantic Scholar 1 s) are asserted in the one test that records them.
  const result = await acquireSource({ fetch: fetchFn, download: dl.download, cfg: cfg({ sleep: noSleep, ...config }) }, paper);
  return { result, calls: dl.calls, requests };
}
const ok = (r: AcquireResult) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as Extract<AcquireResult, { ok: true }>).source;
};
const failed = (r: AcquireResult) => {
  assert.equal(r.ok, false);
  return r as Extract<AcquireResult, { ok: false }>;
};
const s2Requests = (requests: Array<{ url: string }>) => requests.filter((q) => q.url.includes("semanticscholar"));

describe("arXiv routes (derived from identifiers a provider supplied, never invented)", () => {
  it("an arXiv DOI whose OpenAlex record has only a DOI landing page is fetched from arxiv.org/pdf/<id>", async () => {
    const { result, calls } = await run(
      ARXIV_PAPER,
      [openalex(ARXIV_PAPER, { locations: [{ is_oa: true, pdf_url: null, landing_page_url: "https://doi.org/10.48550/arxiv.2511.15162" }] })],
      { "https://arxiv.org/pdf/2511.15162": goodPdf },
    );
    const s = ok(result);
    assert.equal(s.kind, "arxiv-pdf");
    assert.equal(s.ref, "https://arxiv.org/pdf/2511.15162");
    assert.deepEqual(calls, [{ url: "https://arxiv.org/pdf/2511.15162", credential: false }]);
  });

  it("an arXiv DOI is fetched from arXiv even when OpenAlex does not know the work (live: the Transformer paper's DOI)", async () => {
    const { result, calls } = await run(
      ARXIV_PAPER,
      [{ match: (u) => u.startsWith("https://api.openalex.test/works/"), status: 404, body: "{}" }, s2Route({}, 404)],
      { "https://arxiv.org/pdf/2511.15162": goodPdf },
    );
    const s = ok(result);
    assert.equal(s.kind, "arxiv-pdf");
    assert.deepEqual(calls.map((c) => c.url), ["https://arxiv.org/pdf/2511.15162"]);
  });

  it("an open arXiv /abs location of a journal paper gives its PDF, labelled as a preprint of the work", async () => {
    const { result, calls } = await run(
      JOURNAL_PAPER,
      [openalex(JOURNAL_PAPER, { locations: [{ is_oa: true, pdf_url: null, landing_page_url: "http://arxiv.org/abs/2504.14100v2" }] })],
      { "https://arxiv.org/pdf/2504.14100v2": goodPdf },
    );
    assert.equal(ok(result).kind, "arxiv-preprint-pdf");
    assert.deepEqual(calls.map((c) => c.url), ["https://arxiv.org/pdf/2504.14100v2"]);
  });

  it("a closed location never yields an arXiv URL, and an unrelated DOI never does either", async () => {
    const { result, calls } = await run(
      JOURNAL_PAPER,
      [openalex(JOURNAL_PAPER, { locations: [{ is_oa: false, pdf_url: null, landing_page_url: "http://arxiv.org/abs/2504.14100" }] }), s2Route({}, 404)],
      {},
    );
    assert.equal(failed(result).code, "no_open_copy");
    assert.equal(calls.length, 0);
  });

  it("the same arXiv URL is tried once even when OpenAlex lists it as pdf_url and as a landing page", async () => {
    const { result, calls } = await run(
      ARXIV_PAPER,
      [openalex(ARXIV_PAPER, { best_oa_location: { is_oa: true, pdf_url: "https://arxiv.org/pdf/2511.15162", landing_page_url: "http://arxiv.org/abs/2511.15162" }, locations: [{ is_oa: true, pdf_url: null, landing_page_url: "https://doi.org/10.48550/arxiv.2511.15162" }] })],
      { "https://arxiv.org/pdf/2511.15162": goodPdf },
    );
    ok(result);
    assert.equal(calls.length, 1);
  });

  it("arXiv requests are spaced 3 s apart (arXiv's documented limit for programmatic access); other hosts are not delayed", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    const routes = [openalex(ARXIV_PAPER, { locations: [{ is_oa: true, pdf_url: "https://arxiv.org/pdf/2511.15162" }] })];
    await run(ARXIV_PAPER, routes, { "https://arxiv.org/pdf/2511.15162": goodPdf }, { sleep });
    assert.deepEqual(sleeps, [], "the first arXiv request waits for nothing");
    await run(ARXIV_PAPER, routes, { "https://arxiv.org/pdf/2511.15162": goodPdf }, { sleep });
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] > 2000 && sleeps[0] <= 3000, `second arXiv request waited ${sleeps[0]} ms`);
    const other = [openalex(JOURNAL_PAPER, { locations: [{ is_oa: true, pdf_url: "https://repo.example/a.pdf" }] })];
    const before = sleeps.length;
    await run(JOURNAL_PAPER, other, { "https://repo.example/a.pdf": goodPdf }, { sleep });
    assert.equal(sleeps.length, before);
  });
});

describe("OpenAlex open_access.oa_url", () => {
  it("is downloaded when the locations give no pdf_url, and is checked like any other candidate", async () => {
    const { result, calls } = await run(
      JOURNAL_PAPER,
      [openalex(JOURNAL_PAPER, { open_access: { is_oa: true, oa_url: "https://repo.example/paper.pdf" }, locations: [] })],
      { "https://repo.example/paper.pdf": goodPdf },
    );
    const s = ok(result);
    assert.equal(s.kind, "openalex-oa-url");
    assert.deepEqual(calls.map((c) => c.url), ["https://repo.example/paper.pdf"]);
  });

  it("a landing page that answers HTML falls through to the next tier; a DOI resolver link is never fetched as a PDF", async () => {
    const { result, calls } = await run(
      JOURNAL_PAPER,
      [
        openalex(JOURNAL_PAPER, { open_access: { is_oa: true, oa_url: "https://repo.example/landing" }, locations: [] }),
        s2Route({ externalIds: { DOI: JOURNAL_PAPER.doi, ArXiv: "2504.14100" } }),
      ],
      { "https://repo.example/landing": html, "https://arxiv.org/pdf/2504.14100": goodPdf },
    );
    assert.equal(ok(result).kind, "arxiv-preprint-pdf");
    assert.deepEqual(calls.map((c) => c.url), ["https://repo.example/landing", "https://arxiv.org/pdf/2504.14100"]);
    const doi = await run(JOURNAL_PAPER, [openalex(JOURNAL_PAPER, { open_access: { is_oa: true, oa_url: "https://doi.org/10.1109/ojcoms.2025.3600616" } }), s2Route({}, 404)], {});
    assert.equal(failed(doi.result).code, "no_open_copy");
    assert.equal(doi.calls.length, 0);
  });

  it("is ignored when OpenAlex says the work is not open access", async () => {
    const { result, calls } = await run(JOURNAL_PAPER, [openalex(JOURNAL_PAPER, { open_access: { is_oa: false, oa_url: "https://repo.example/paper.pdf" } }), s2Route({}, 404)], { "https://repo.example/paper.pdf": goodPdf });
    assert.equal(failed(result).code, "no_open_copy");
    assert.equal(calls.length, 0);
  });
});

describe("Semantic Scholar tier (asked only when the OpenAlex tier gives nothing usable)", () => {
  it("openAccessPdf.url is used, with its licence, and the API key goes to Semantic Scholar only", async () => {
    const { result, calls, requests } = await run(
      JOURNAL_PAPER,
      [openalex(JOURNAL_PAPER, { locations: [] }), s2Route({ externalIds: { DOI: JOURNAL_PAPER.doi }, openAccessPdf: { url: "https://repo.example/s2.pdf", status: "GREEN", license: "CCBY" } })],
      { "https://repo.example/s2.pdf": goodPdf },
      { semanticScholarApiKey: KEY },
    );
    const s = ok(result);
    assert.equal(s.kind, "s2-open-access-pdf");
    assert.equal(s.license, "CCBY");
    assert.deepEqual(calls, [{ url: "https://repo.example/s2.pdf", credential: false }]);
    const q = s2Requests(requests)[0] as { url: string; headers?: Record<string, string> };
    assert.match(q.url, /\/graph\/v1\/paper\/DOI:10\.1109\/ojcoms\.2025\.3600616\?fields=openAccessPdf,externalIds$/);
    assert.equal(q.headers?.["x-api-key"], KEY);
    assert.ok(!JSON.stringify(result).includes(KEY));
  });

  it("externalIds.ArXiv gives the preprint when the paper is paywalled and S2 has no PDF url (an empty string counts as none)", async () => {
    const { result, calls } = await run(
      JOURNAL_PAPER,
      [openalex(JOURNAL_PAPER, { open_access: { is_oa: false } }), s2Route({ externalIds: { DOI: JOURNAL_PAPER.doi, ArXiv: "2511.04015" }, openAccessPdf: { url: "", status: null, license: null } })],
      { "https://arxiv.org/pdf/2511.04015": goodPdf },
    );
    const s = ok(result);
    assert.equal(s.kind, "arxiv-preprint-pdf");
    assert.deepEqual(calls.map((c) => c.url), ["https://arxiv.org/pdf/2511.04015"]);
  });

  it("a wrong or non-document candidate falls through to the next S2 candidate; DOI resolver links are skipped", async () => {
    const { result, calls } = await run(
      JOURNAL_PAPER,
      [openalex(JOURNAL_PAPER, { locations: [] }), s2Route({ externalIds: { DOI: JOURNAL_PAPER.doi, ArXiv: "2504.14100" }, openAccessPdf: { url: "https://repo.example/wrong.pdf", license: null } })],
      { "https://repo.example/wrong.pdf": otherPdf, "https://arxiv.org/pdf/2504.14100": goodPdf },
    );
    assert.equal(ok(result).kind, "arxiv-preprint-pdf");
    assert.deepEqual(calls.map((c) => c.url), ["https://repo.example/wrong.pdf", "https://arxiv.org/pdf/2504.14100"]);
    const doi = await run(JOURNAL_PAPER, [openalex(JOURNAL_PAPER, { locations: [] }), s2Route({ externalIds: { DOI: JOURNAL_PAPER.doi }, openAccessPdf: { url: "https://doi.org/10.1109/ojcoms.2025.3600616" } })], {});
    assert.equal(failed(doi.result).code, "no_open_copy");
    assert.equal(doi.calls.length, 0);
  });

  it("is not asked at all when an OpenAlex candidate already produced the source (quota)", async () => {
    const { result, requests } = await run(
      JOURNAL_PAPER,
      [openalex(JOURNAL_PAPER, { locations: [{ is_oa: true, pdf_url: "https://repo.example/a.pdf" }] }), s2Route({})],
      { "https://repo.example/a.pdf": goodPdf },
    );
    ok(result);
    assert.equal(s2Requests(requests).length, 0);
  });

  it("is asked when the OpenAlex candidates all failed, and a rate limit or outage there never changes the outcome", async () => {
    const files = { "https://repo.example/a.pdf": otherPdf };
    const work = [openalex(JOURNAL_PAPER, { locations: [{ is_oa: true, pdf_url: "https://repo.example/a.pdf" }] })];
    const limited = await run(JOURNAL_PAPER, [...work, s2Route({}, 429)], files, { sleep: async () => {} });
    assert.equal(failed(limited.result).code, "identity_mismatch");
    assert.ok(s2Requests(limited.requests).length >= 1);
    const down = await run(JOURNAL_PAPER, [openalex(JOURNAL_PAPER, { locations: [] }), s2Route({}, 500)], {}, { sleep: async () => {} });
    assert.deepEqual(((f) => [f.status, f.code])(failed(down.result)), ["unavailable", "no_open_copy"]);
  });

  it("a Semantic Scholar answer for a different DOI is never used", async () => {
    const { result, calls } = await run(
      JOURNAL_PAPER,
      [openalex(JOURNAL_PAPER, { locations: [] }), s2Route({ externalIds: { DOI: "10.9999/other", ArXiv: "2504.14100" }, openAccessPdf: { url: "https://repo.example/s2.pdf" } })],
      { "https://repo.example/s2.pdf": goodPdf, "https://arxiv.org/pdf/2504.14100": goodPdf },
    );
    assert.equal(failed(result).code, "no_open_copy");
    assert.equal(calls.length, 0);
  });

  it("a malformed arXiv id is ignored rather than turned into a URL", async () => {
    const { result, calls } = await run(
      JOURNAL_PAPER,
      [openalex(JOURNAL_PAPER, { locations: [] }), s2Route({ externalIds: { DOI: JOURNAL_PAPER.doi, ArXiv: "../../etc/passwd?x=1" } })],
      {},
    );
    assert.equal(failed(result).code, "no_open_copy");
    assert.equal(calls.length, 0);
  });
});

const PMC = "https://pmc-oa-opendata.s3.amazonaws.com";
const epmcRoute = (body: unknown, status = 200) => ({
  match: (u: string) => u.startsWith("https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI"),
  status,
  body: JSON.stringify(body),
});
const epmcRecord = (doi: string, urls: Array<Record<string, string>> = [], pmcid: string | null = "PMC7759461") => ({
  hitCount: 1,
  resultList: { result: [{ doi, ...(pmcid !== null ? { pmcid } : {}), fullTextUrlList: { fullTextUrl: urls } }] },
});
const renderPdf = { availability: "Open access", availabilityCode: "OA", documentStyle: "pdf", site: "Europe_PMC", url: "https://europepmc.org/articles/PMC7759461?pdf=render" };
const pmcList = (...versions: number[]) => ({
  match: (u: string) => u.startsWith(`${PMC}/?list-type=2&prefix=PMC7759461.`),
  body: `<?xml version="1.0"?><ListBucketResult>${versions.map((v) => `<CommonPrefixes><Prefix>PMC7759461.${v}/</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`,
});
const pmcJson = (version: number, over: Record<string, unknown> = {}) => ({
  match: (u: string) => u === `${PMC}/PMC7759461.${version}/PMC7759461.${version}.json`,
  body: JSON.stringify({ pmcid: "PMC7759461", version, doi: "10.1109/OJCOMS.2025.3600616", is_pmc_openaccess: true, license_code: "CC BY", pdf_url: `s3://pmc-oa-opendata/PMC7759461.${version}/PMC7759461.${version}.pdf?md5=abc`, ...over }),
});
const noOpenAlex = (paper: { doi: string }) => openalex(paper, { locations: [], open_access: { is_oa: false } });
const epmcRequests = (requests: Array<{ url: string }>) => requests.filter((q) => q.url.includes("europepmc") || q.url.includes("pmc-oa-opendata"));

describe("Europe PMC / PubMed Central tier (keyless)", () => {
  it("fetches the newest PMC open-data PDF of the PMCID Europe PMC reports, with its licence; the bot-gated europepmc.org render link is never fetched", async () => {
    const { result, calls } = await run(
      JOURNAL_PAPER,
      [noOpenAlex(JOURNAL_PAPER), s2Route({}, 404), epmcRoute(epmcRecord(JOURNAL_PAPER.doi, [renderPdf])), pmcList(1, 2), pmcJson(2)],
      { [`${PMC}/PMC7759461.2/PMC7759461.2.pdf`]: goodPdf, "https://europepmc.org/articles/PMC7759461?pdf=render": goodPdf },
    );
    const s = ok(result);
    assert.equal(s.kind, "pmc-pdf");
    assert.equal(s.license, "CC BY");
    assert.deepEqual(calls.map((c) => c.url), [`${PMC}/PMC7759461.2/PMC7759461.2.pdf`]);
  });

  it("an open-access PDF listed on another host is used (kind epmc-pdf); restricted entries and doi.org links are not", async () => {
    const { result, calls } = await run(
      JOURNAL_PAPER,
      [
        noOpenAlex(JOURNAL_PAPER),
        s2Route({}, 404),
        epmcRoute(epmcRecord(JOURNAL_PAPER.doi, [
          { availability: "Subscription required", availabilityCode: "S", documentStyle: "pdf", site: "Publisher", url: "https://publisher.example/locked.pdf" },
          { availability: "Subscription required", availabilityCode: "S", documentStyle: "doi", site: "DOI", url: "https://doi.org/10.1109/ojcoms.2025.3600616" },
          { availability: "Open access", availabilityCode: "OA", documentStyle: "pdf", site: "Repository", url: "https://repo.example/open.pdf" },
        ], null)),
      ],
      { "https://repo.example/open.pdf": goodPdf, "https://publisher.example/locked.pdf": goodPdf },
    );
    assert.equal(ok(result).kind, "epmc-pdf");
    assert.deepEqual(calls.map((c) => c.url), ["https://repo.example/open.pdf"]);
  });

  it("bucket data for another DOI, a pdf_url outside the version's folder, or no bucket entry yields nothing", async () => {
    const wrongDoi = await run(JOURNAL_PAPER, [noOpenAlex(JOURNAL_PAPER), s2Route({}, 404), epmcRoute(epmcRecord(JOURNAL_PAPER.doi)), pmcList(1), pmcJson(1, { doi: "10.9999/other" })], {});
    assert.equal(failed(wrongDoi.result).code, "no_open_copy");
    assert.equal(wrongDoi.calls.length, 0);
    for (const pdf_url of ["s3://other-bucket/PMC7759461.1/PMC7759461.1.pdf", "s3://pmc-oa-opendata/PMC7759461.1/../x.pdf", "s3://pmc-oa-opendata/PMC1111111.1/PMC1111111.1.pdf", "https://evil.example/a.pdf"]) {
      const bad = await run(JOURNAL_PAPER, [noOpenAlex(JOURNAL_PAPER), s2Route({}, 404), epmcRoute(epmcRecord(JOURNAL_PAPER.doi)), pmcList(1), pmcJson(1, { pdf_url })], {});
      assert.equal(bad.calls.length, 0, pdf_url);
    }
    const none = await run(JOURNAL_PAPER, [noOpenAlex(JOURNAL_PAPER), s2Route({}, 404), epmcRoute(epmcRecord(JOURNAL_PAPER.doi)), pmcList()], {});
    assert.equal(failed(none.result).code, "no_open_copy");
  });

  it("an answer for a different DOI, an empty hit list or a provider error yields nothing and never changes the outcome", async () => {
    const other = await run(JOURNAL_PAPER, [noOpenAlex(JOURNAL_PAPER), s2Route({}, 404), epmcRoute(epmcRecord("10.9999/other", [renderPdf]))], {});
    assert.equal(failed(other.result).code, "no_open_copy");
    assert.equal(other.calls.length, 0);
    const empty = await run(JOURNAL_PAPER, [noOpenAlex(JOURNAL_PAPER), s2Route({}, 404), epmcRoute({ hitCount: 0, resultList: { result: [] } })], {});
    assert.equal(failed(empty.result).code, "no_open_copy");
    const down = await run(JOURNAL_PAPER, [noOpenAlex(JOURNAL_PAPER), s2Route({}, 404), epmcRoute({}, 500)], {});
    assert.deepEqual(((f) => [f.status, f.code])(failed(down.result)), ["unavailable", "no_open_copy"]);
  });

  it("is asked only when the OpenAlex tier gave no source, and before the Semantic Scholar preprint", async () => {
    const first = await run(JOURNAL_PAPER, [openalex(JOURNAL_PAPER, { locations: [{ is_oa: true, pdf_url: "https://repo.example/a.pdf" }] }), epmcRoute(epmcRecord(JOURNAL_PAPER.doi))], { "https://repo.example/a.pdf": goodPdf });
    ok(first.result);
    assert.equal(epmcRequests(first.requests).length, 0);
    const both = await run(
      JOURNAL_PAPER,
      [noOpenAlex(JOURNAL_PAPER), epmcRoute(epmcRecord(JOURNAL_PAPER.doi)), pmcList(1), pmcJson(1), s2Route({ externalIds: { DOI: JOURNAL_PAPER.doi, ArXiv: "2504.14100" } })],
      { [`${PMC}/PMC7759461.1/PMC7759461.1.pdf`]: goodPdf, "https://arxiv.org/pdf/2504.14100": goodPdf },
    );
    assert.equal(ok(both.result).kind, "pmc-pdf", "the published or author-manuscript copy wins over a preprint");
    assert.equal(s2Requests(both.requests).length, 0, "Semantic Scholar is not asked once PubMed Central gave the source");
  });
});

describe("arXiv cooldown (arXiv treats ignored 403s as abuse)", () => {
  const routes = [openalex(ARXIV_PAPER, { locations: [{ is_oa: true, pdf_url: "https://arxiv.org/pdf/2511.15162" }] }), s2Route({}, 404)];
  const arxivUrl = "https://arxiv.org/pdf/2511.15162";

  it("after an HTTP 429 or 403 from arXiv, arXiv candidates are skipped for a while, other hosts are not", async () => {
    const sleep = async () => {}; // a private clock: this test gets its own cooldown state
    const refused = await run(ARXIV_PAPER, routes, { [arxivUrl]: new SourceError("download_failed", "the host answered HTTP 429") }, { sleep });
    assert.equal(failed(refused.result).code, "download_failed");
    assert.equal(refused.calls.length, 1);
    const during = await run(ARXIV_PAPER, routes, { [arxivUrl]: goodPdf }, { sleep });
    assert.equal(failed(during.result).code, "download_failed");
    assert.equal(during.calls.length, 0, "no request reaches arXiv during the cooldown");
    const other = await run(
      ARXIV_PAPER,
      [openalex(ARXIV_PAPER, { locations: [{ is_oa: true, pdf_url: "https://repo.example/a.pdf" }, { is_oa: true, pdf_url: arxivUrl }] })],
      { "https://repo.example/a.pdf": goodPdf, [arxivUrl]: goodPdf },
      { sleep },
    );
    assert.deepEqual(other.calls.map((c) => c.url), ["https://repo.example/a.pdf"]);
  });

  it("a plain 404 from arXiv does not start a cooldown", async () => {
    const sleep = async () => {};
    await run(ARXIV_PAPER, routes, { [arxivUrl]: new SourceError("download_failed", "the host answered HTTP 404") }, { sleep });
    const next = await run(ARXIV_PAPER, routes, { [arxivUrl]: goodPdf }, { sleep });
    ok(next.result);
    assert.equal(next.calls.length, 1);
  });
});
