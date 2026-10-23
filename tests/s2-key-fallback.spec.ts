/**
 * Owner decision (2026-10-18): with a Semantic Scholar API key configured, a keyed request rejected (401/403) or rate-limited
 * (429, after the normal retry policy) is repeated ONCE without the key, in S2's public pool, before giving up. Without a key
 * nothing changes: no duplicate request. A 500 is an outage, never a key problem, so it is never repeated keyless.
 * Offline: the fake answers by whether the request carried `x-api-key`; no real network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { searchSemanticScholar } from "../src/core/providers/semantic-scholar.ts";
import { ProviderRequestError, type FetchLike, type ProviderConfig } from "../src/core/providers/types.ts";
import { acquireSource, type AcquireResult } from "../src/core/source/prepare.ts";
import { SourceError } from "../src/core/source/extract.ts";
import type { DownloadLike } from "../src/core/source/download.ts";
import { cfg } from "./helpers/provider-fakes.ts";
import { makePdf } from "./helpers/pdf.ts";

const KEY = "S2-OWNER-KEY";
const noSleep = async () => {};
const S2_BASE = "https://api.semanticscholar.test";
const TITLE = "Cycle Life of Lithium Cells Under Thermal Stress";
const JOURNAL_PAPER = { doi: "10.1109/ojcoms.2025.3600616", title: TITLE };
const goodPdf = makePdf([[TITLE, "Cells age faster at high temperature and capacity fades with every cycle."]]);

type Answer = { status: number; body: string };
type Seen = { url: string; keyed: boolean };

/** A fake web: `answer` decides by URL and key presence; an unrouted URL is a 404 (recorded, never a network call). */
function fakeWeb(answer: (url: string, keyed: boolean) => Answer | undefined): { fetchFn: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const keyed = init?.headers?.["x-api-key"] !== undefined;
    seen.push({ url, keyed });
    const a = answer(url, keyed) ?? { status: 404, body: "{}" };
    return new Response(a.body, { status: a.status });
  };
  return { fetchFn, seen };
}

const searchBody = JSON.stringify({ data: [{ paperId: "p1", title: TITLE, externalIds: { DOI: JOURNAL_PAPER.doi } }] });
const isSearch = (u: string) => u.startsWith(`${S2_BASE}/graph/v1/paper/search?`);
const isS2Lookup = (u: string) => u.startsWith(`${S2_BASE}/graph/v1/paper/DOI:`);
const isOpenAlex = (u: string) => u.startsWith("https://api.openalex.test/works/");
const isEuropePmc = (u: string) => u.startsWith("https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI");
const epmcNoRecord: Answer = { status: 200, body: JSON.stringify({ hitCount: 0, resultList: { result: [] } }) };
const openalexNoCopy: Answer = { status: 200, body: JSON.stringify({ id: "https://openalex.org/W1", doi: `https://doi.org/${JOURNAL_PAPER.doi}`, locations: [] }) };
const s2Record: Answer = {
  status: 200,
  body: JSON.stringify({ externalIds: { DOI: JOURNAL_PAPER.doi }, openAccessPdf: { url: "https://repo.example/s2.pdf", status: "GREEN", license: "CCBY" } }),
};

function fakeDownload(files: Record<string, Uint8Array>) {
  const calls: string[] = [];
  const download: DownloadLike = async (url) => {
    calls.push(url);
    const f = files[url];
    if (f === undefined) throw new SourceError("download_failed", "the host answered HTTP 404");
    return { finalUrl: url, contentType: null, bytes: f };
  };
  return { download, calls };
}

const searchCfg = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => cfg({ sleep: noSleep, ...overrides });
const keyedRequests = (seen: Seen[]) => seen.filter((s) => s.keyed).length;
const keylessRequests = (seen: Seen[]) => seen.filter((s) => !s.keyed).length;

describe("Semantic Scholar search: keyed rejection falls back to one keyless request", () => {
  it("keyed 429 on every attempt, keyless 200: the keyless paper is returned; exactly one keyless request, the last one", async () => {
    const { fetchFn, seen } = fakeWeb((url, keyed) => (isSearch(url) ? (keyed ? { status: 429, body: "limited" } : { status: 200, body: searchBody }) : undefined));
    const papers = await searchSemanticScholar(fetchFn, searchCfg({ semanticScholarApiKey: KEY }), "cells", {}, 5);
    assert.equal(papers.length, 1);
    assert.equal(papers[0]?.title, TITLE);
    assert.equal(keylessRequests(seen), 1, "exactly one keyless request");
    assert.equal(seen.at(-1)?.keyed, false, "the fallback is the last request and carries no key");
    assert.equal(keyedRequests(seen), 3, "the keyed request keeps the normal retry policy (one attempt plus two retries)");
  });

  it("keyed 401 then keyless 200: the paper is returned after one keyed and one keyless request", async () => {
    const { fetchFn, seen } = fakeWeb((url, keyed) => (isSearch(url) ? (keyed ? { status: 401, body: "bad key" } : { status: 200, body: searchBody }) : undefined));
    const papers = await searchSemanticScholar(fetchFn, searchCfg({ semanticScholarApiKey: KEY }), "cells", {}, 5);
    assert.equal(papers.length, 1);
    assert.deepEqual(seen.map((s) => s.keyed), [true, false]);
  });

  it("keyed 403 then keyless 200: the paper is returned after one keyed and one keyless request", async () => {
    const { fetchFn, seen } = fakeWeb((url, keyed) => (isSearch(url) ? (keyed ? { status: 403, body: "forbidden" } : { status: 200, body: searchBody }) : undefined));
    const papers = await searchSemanticScholar(fetchFn, searchCfg({ semanticScholarApiKey: KEY }), "cells", {}, 5);
    assert.equal(papers.length, 1);
    assert.deepEqual(seen.map((s) => s.keyed), [true, false]);
  });

  it("no key configured and 429 on every attempt: only the normal retry attempts, no keyless duplicate, the provider error", async () => {
    const { fetchFn, seen } = fakeWeb((url) => (isSearch(url) ? { status: 429, body: "limited" } : undefined));
    await assert.rejects(searchSemanticScholar(fetchFn, searchCfg(), "cells", {}, 5), ProviderRequestError);
    assert.equal(seen.length, 3, "one attempt plus two retries, nothing more");
    assert.equal(keylessRequests(seen), 3, "no key is ever sent, so every request is the public pool's own");
    assert.equal(keyedRequests(seen), 0);
  });

  it("keyed 500 on every attempt: an outage, never repeated keyless", async () => {
    const { fetchFn, seen } = fakeWeb((url) => (isSearch(url) ? { status: 500, body: "down" } : undefined));
    await assert.rejects(searchSemanticScholar(fetchFn, searchCfg({ semanticScholarApiKey: KEY }), "cells", {}, 5), ProviderRequestError);
    assert.equal(keylessRequests(seen), 0, "a 500 must not trigger the keyless fallback");
    assert.equal(keyedRequests(seen), 3);
  });
});

describe("Semantic Scholar acquisition: keyed rejection falls back to one keyless lookup", () => {
  async function acquire(answer: (url: string, keyed: boolean) => Answer | undefined, files: Record<string, Uint8Array>, config: Partial<ProviderConfig> = {}) {
    const web = fakeWeb((url, keyed) => {
      if (isOpenAlex(url)) return openalexNoCopy;
      if (isEuropePmc(url)) return epmcNoRecord;
      return answer(url, keyed);
    });
    const dl = fakeDownload(files);
    const result: AcquireResult = await acquireSource({ fetch: web.fetchFn, download: dl.download, cfg: cfg({ sleep: noSleep, ...config }) }, JOURNAL_PAPER);
    return { result, seen: web.seen, downloads: dl.calls };
  }

  it("keyed 403, keyless 200 with openAccessPdf: that PDF is fetched and the source comes from it", async () => {
    const { result, seen, downloads } = await acquire(
      (url, keyed) => (isS2Lookup(url) ? (keyed ? { status: 403, body: "forbidden" } : s2Record) : undefined),
      { "https://repo.example/s2.pdf": goodPdf },
      { semanticScholarApiKey: KEY },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.source.kind, "s2-open-access-pdf");
    assert.equal(result.source.license, "CCBY");
    assert.deepEqual(downloads, ["https://repo.example/s2.pdf"]);
    assert.deepEqual(seen.filter((s) => isS2Lookup(s.url)).map((s) => s.keyed), [true, false]);
    assert.ok(!JSON.stringify(result).includes(KEY), "the key never appears in the outcome");
  });

  it("keyed 429 and keyless 429: an outage, failed/download_failed, and no download", async () => {
    const { result, downloads } = await acquire(
      (url) => (isS2Lookup(url) ? { status: 429, body: "limited" } : undefined),
      {},
      { semanticScholarApiKey: KEY },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual([result.status, result.code], ["failed", "download_failed"]);
    assert.equal(downloads.length, 0);
  });
});
