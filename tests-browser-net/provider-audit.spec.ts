/**
 * Provider request audit: real provider modules against canned responses
 * (every outgoing request recorded) + live no-key page requests in the exact
 * shapes the product sends. Run:
 * `node --import ./tests-browser-net/stubs/register.mjs --test tests-browser-net/provider-audit.spec.ts`
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { searchOpenAlex } from "../src/core/providers/openalex.ts";
import { searchCrossref } from "../src/core/providers/crossref.ts";
import { searchSemanticScholar } from "../src/core/providers/semantic-scholar.ts";
import { fetchArxivPaperByDoi } from "../src/core/providers/datacite.ts";
import { acquireSource } from "../src/core/source/prepare.ts";
import { createBrowserFetch } from "../src/browser/provider-fetch.ts";
import type { FetchLike, ProviderConfig } from "../src/core/providers/types.ts";
import { startHarness, type Harness } from "./servers.ts";

const here = dirname(fileURLToPath(import.meta.url));

export interface OutRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

export const outRequests: OutRequest[] = [];

const canned = (routes: Record<string, { status: number; body: string }>): FetchLike => {
  const calls = async (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => {
    const u = new URL(url);
    const key = `${u.origin}${u.pathname}`;
    outRequests.push({ url, method: init?.method ?? "GET", headers: { ...(init?.headers ?? {}) } });
    const route = routes[key];
    if (!route) throw new Error(`NO_CANNED ${key}`);
    return {
      status: route.status,
      headers: { get: (_name: string): string | null => null },
      text: async (): Promise<string> => route.body,
      body: { cancel: async (): Promise<void> => undefined },
    };
  };
  return calls;
};

const baseCfg: ProviderConfig = {
  openalexBaseUrl: "https://api.openalex.org",
  crossrefBaseUrl: "https://api.crossref.org",
  semanticScholarBaseUrl: "https://api.semanticscholar.org",
  sleep: async () => undefined,
};

const OA_WORK = {
  id: "https://openalex.org/W2741809807",
  doi: "https://doi.org/10.1038/nature14539",
  title: "Deep learning",
  publication_year: 2015,
  authorships: [{ author: { display_name: "Yann LeCun" } }],
  primary_location: { source: { display_name: "Nature" } },
  cited_by_count: 90000,
  abstract_inverted_index: { Deep: [0], learning: [1] },
  open_access: { is_oa: true },
  locations: [],
};

describe("provider request audit (canned)", () => {
  it("OpenAlex search sends a headerless GET; api_key rides the query when set", async () => {
    outRequests.length = 0;
    const url = (u: string): string => u;
    const body = JSON.stringify({ results: [OA_WORK] });
    const keyless = canned({ "https://api.openalex.org/works": { status: 200, body } });
    const found = await searchOpenAlex(keyless, baseCfg, "deep learning", {}, 5);
    assert.equal(found.length, 1);
    assert.equal(outRequests.length, 1);
    assert.deepEqual(outRequests[0]?.headers, {});
    assert.equal(new URL(outRequests[0]?.url as string).searchParams.get("select")?.split(",").length, 10);
    void url;
    outRequests.length = 0;
    const keyed = canned({ "https://api.openalex.org/works": { status: 200, body } });
    await searchOpenAlex(keyed, { ...baseCfg, openalexApiKey: "K" }, "deep learning", {}, 5);
    assert.equal(new URL(outRequests[0]?.url as string).searchParams.get("api_key"), "K");
    assert.deepEqual(outRequests[0]?.headers, {});
  });

  it("Crossref search sends a headerless GET; mailto rides the query when set", async () => {
    outRequests.length = 0;
    const body = JSON.stringify({
      message: {
        items: [
          {
            DOI: "10.1038/nature14539",
            title: ["Deep learning"],
            author: [{ given: "Yann", family: "LeCun" }],
            "container-title": ["Nature"],
            issued: { "date-parts": [[2015]] },
          },
        ],
      },
    });
    const fetch = canned({ "https://api.crossref.org/works": { status: 200, body } });
    const found = await searchCrossref(fetch, { ...baseCfg, crossrefMailto: "a@b.c" }, "deep learning", {}, 5);
    assert.equal(found.length, 1);
    assert.equal(outRequests.length, 1);
    assert.deepEqual(outRequests[0]?.headers, {});
    assert.equal(new URL(outRequests[0]?.url as string).searchParams.get("mailto"), "a@b.c");
  });

  it("Semantic Scholar search is headerless keyless; keyed sends x-api-key", async () => {
    outRequests.length = 0;
    const body = JSON.stringify({
      data: [{ paperId: "x", title: "Deep learning", externalIds: { DOI: "10.1038/nature14539" } }],
    });
    const fetch = canned({ "https://api.semanticscholar.org/graph/v1/paper/search": { status: 200, body } });
    await searchSemanticScholar(fetch, baseCfg, "deep learning", {}, 5);
    assert.deepEqual(outRequests[0]?.headers, {});
    outRequests.length = 0;
    await searchSemanticScholar(fetch, { ...baseCfg, semanticScholarApiKey: "K" }, "deep learning", {}, 5);
    assert.equal(outRequests[0]?.headers["x-api-key"], "K");
  });

  it("DataCite metadata + BibTeX are headerless GETs on fixed hosts", async () => {
    outRequests.length = 0;
    const fetch = canned({
      "https://api.datacite.org/dois/10.48550/arxiv.1706.03762": {
        status: 200,
        body: JSON.stringify({
          data: {
            attributes: {
              doi: "10.48550/arxiv.1706.03762",
              titles: [{ title: "Attention Is All You Need" }],
              creators: [{ name: "Vaswani, Ashish" }],
              publisher: "arXiv",
              publicationYear: 2017,
            },
          },
        }),
      },
      "https://data.crosscite.org/application/x-bibtex/10.48550/arxiv.1706.03762": { status: 200, body: "@misc{a}" },
    });
    const rec = await fetchArxivPaperByDoi(fetch, baseCfg, "10.48550/arxiv.1706.03762");
    assert.equal(rec?.title, "Attention Is All You Need");
    assert.equal(outRequests.length, 2);
    for (const r of outRequests) assert.deepEqual(r.headers, {});
  });

  it("acquireSource routes: OpenAlex lookup, Europe PMC search, PMC open-data, S2 lookup", async () => {
    outRequests.length = 0;
    const oaLookup = JSON.stringify({ doi: "https://doi.org/10.7717/peerj.4375", locations: [], open_access: { is_oa: false } });
    const epmc = JSON.stringify({
      resultList: { result: [{ doi: "10.7717/peerj.4375", pmcid: "PMC5815332", fullTextUrlList: { fullTextUrl: [] } }] },
    });
    const fetch = canned({
      "https://api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.7717%2Fpeerj.4375": { status: 200, body: oaLookup },
      "https://www.ebi.ac.uk/europepmc/webservices/rest/search": { status: 200, body: epmc },
      "https://pmc-oa-opendata.s3.amazonaws.com/": {
        status: 200,
        body: "<ListBucketResult><Prefix>PMC5815332.1/</Prefix></ListBucketResult>",
      },
      "https://pmc-oa-opendata.s3.amazonaws.com/PMC5815332.1/PMC5815332.1.json": {
        status: 200,
        body: JSON.stringify({ pmcid: "PMC5815332", doi: "10.7717/peerj.4375", pdf_url: "s3://pmc-oa-opendata/PMC5815332.1/x.pdf", license_code: "cc-by" }),
      },
      "https://api.semanticscholar.org/graph/v1/paper/DOI:10.7717/peerj.4375": {
        status: 200,
        body: JSON.stringify({ externalIds: { DOI: "10.7717/peerj.4375" }, openAccessPdf: null }),
      },
    });
    const download = async (): Promise<never> => {
      const { SourceError } = await import("../src/core/source/extract.ts");
      throw new SourceError("download_failed", "stub: no bytes");
    };
    const result = await acquireSource(
      { fetch, download, cfg: { ...baseCfg, semanticScholarApiKey: "K" } },
      { doi: "10.7717/peerj.4375", title: "t" },
    );
    assert.equal(result.ok, false);
    const urls = outRequests.map((r) => r.url.split("?")[0]);
    for (const want of [
      "https://api.openalex.org/works/https%3A%2F%2Fdoi.org%2F10.7717%2Fpeerj.4375",
      "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
      "https://pmc-oa-opendata.s3.amazonaws.com/",
      "https://pmc-oa-opendata.s3.amazonaws.com/PMC5815332.1/PMC5815332.1.json",
      "https://api.semanticscholar.org/graph/v1/paper/DOI:10.7717/peerj.4375",
    ]) {
      assert.ok(urls.includes(want), `missing ${want} in ${JSON.stringify(urls)}`);
    }
    const s2 = outRequests.find((r) => r.url.includes("semanticscholar"));
    assert.equal(s2?.headers["x-api-key"], "K");
    for (const r of outRequests.filter((x) => x !== s2)) assert.deepEqual(r.headers, {});
    writeFileSync(join(here, "request-log.json"), JSON.stringify(outRequests, null, 2));
  });

  it("createBrowserFetch drops x-api-key and passes simple GETs through", async () => {
    const seen: { url: string; headers?: Record<string, string> }[] = [];
    const inner: FetchLike = (async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, headers: init?.headers });
      return { status: 200, headers: { get: (): string | null => null }, text: async () => "{}" };
    }) as FetchLike;
    const wrapped = createBrowserFetch({ inner });
    await wrapped("https://api.semanticscholar.org/x", { headers: { "x-api-key": "K" } });
    assert.deepEqual(seen[0]?.headers, {});
    await wrapped("https://api.openalex.org/y", undefined);
    assert.equal(seen[1]?.url, "https://api.openalex.org/y");
  });
});

const SHELL = join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell");
const FULL = join(homedir(), ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome");
const executablePath = existsSync(SHELL) ? SHELL : FULL;

// Live: sends about 20 keyless requests to public providers, so it is opt-in (offline tests spend no provider quota).
const LIVE = process.env["UKTUB_LIVE_NET"] === "1";
describe("provider audit: live page requests (no key, exact product shapes)", { skip: LIVE ? false : "set UKTUB_LIVE_NET=1 to run (keyless requests to public providers)" }, () => {
  let harness: Harness;
  let browser: import("playwright-core").Browser;
  let page: import("playwright-core").Page;

  before(async () => {
    harness = await startHarness();
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
    page = await browser.newPage();
    await page.goto(`${harness.urlA}/test.html`);
    await page.waitForFunction(() => (globalThis as Record<string, unknown>).__mods !== undefined);
  });

  after(async () => {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await harness?.close();
  });

  it("reads every provider through the browser-safe variant", async () => {
    const out = (await page.evaluate(`(async () => {
      const { createBrowserFetch } = globalThis.__mods.providerFetch;
      const bf = createBrowserFetch();
      const gets = [
        ["openalex", "https://api.openalex.org/works/W2741809807?select=id,doi,title"],
        ["crossref", "https://api.crossref.org/works/10.1038%2Fnature14539"],
        ["s2", "https://api.semanticscholar.org/graph/v1/paper/search?query=attention%20is%20all%20you%20need&limit=1&fields=title,abstract,year"],
        ["epmc", "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:%2210.7717%2Fpeerj.4375%22&resultType=core&format=json&pageSize=1"],
        ["datacite", "https://api.datacite.org/dois/10.48550/arxiv.1706.03762"],
      ];
      const rows = [];
      const get = async (name, url) => {
        try {
          const r = await bf(url, {});
          const t = await r.text();
          rows.push({ name, status: r.status, bytes: t.length, head: t.slice(0, 80) });
        } catch (e) { rows.push({ name, error: String(e) }); }
      };
      for (const [name, url] of gets) {
        if (name === "s2") continue; // S2 last: the keyless pool 429s; one delayed retry below.
        await get(name, url);
      }
      // S2 keyless pool 429s as a matter of course (and 429s carry no ACAO,
      // so the page cannot even see the status): one delayed retry, then record.
      await get("s2", "https://api.semanticscholar.org/graph/v1/paper/search?query=attention%20is%20all%20you%20need&limit=1&fields=title,abstract,year");
      await new Promise((r) => setTimeout(r, 20000));
      await get("s2-retry", "https://api.semanticscholar.org/graph/v1/paper/search?query=attention%20is%20all%20you%20need&limit=1&fields=title,abstract,year");
      try {
        const r = await fetch("https://export.arxiv.org/api/query?id_list=1706.03762", { mode: "cors", credentials: "omit" });
        rows.push({ name: "arxiv-api", status: r.status, bytes: (await r.text()).length });
      } catch (e) { rows.push({ name: "arxiv-api", error: String(e) }); }
      // Fake-key preflight probe (no real credential): does S2 accept x-api-key from a page?
      try {
        const r = await fetch("https://api.semanticscholar.org/graph/v1/paper/DOI:10.1038/nature14539?fields=title", { headers: { "x-api-key": "test-invalid-key" }, mode: "cors", credentials: "omit" });
        rows.push({ name: "s2-fake-key", status: r.status, bytes: (await r.text()).length });
      } catch (e) { rows.push({ name: "s2-fake-key", error: String(e) }); }
      return JSON.stringify(rows);
    })()`)) as string;
    const rows = JSON.parse(out) as { name: string; status?: number; bytes?: number; error?: string; head?: string }[];
    writeFileSync(join(here, "live-log.json"), JSON.stringify(rows, null, 2));
    console.log("LIVE:" + out);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    for (const name of ["openalex", "crossref", "epmc", "datacite"]) {
      assert.equal(byName[name]?.status, 200, `${name}: ${JSON.stringify(byName[name])}`);
    }
    // S2 today: the shared keyless pool is exhausted (curl: HTTP/2 429 with NO
    // ACAO, so the page sees a TypeError, not the status). Readability of the
    // shape itself stands on the same-day matrix 200 (RESULTS.md); this locks
    // the pool-exhausted envelope instead of pretending.
    const s2rows = [byName["s2"], byName["s2-retry"]];
    assert.ok(
      s2rows.some((r) => r?.status === 200) || s2rows.every((r) => r?.error?.startsWith("TypeError")),
      `s2 unexpected shape: ${JSON.stringify(s2rows)}`,
    );
    assert.ok(byName["arxiv-api"]?.error !== undefined, "arXiv API should stay CORS-blocked");
  });
});
