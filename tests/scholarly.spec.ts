/**
 * U3 provider-layer contract tests (plan: "U3. Provider layer: port + Feynman
 * hardening"). Every scenario runs against URL-routed fakes — no live network
 * exists at any layer.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SearchUnavailableError,
  fetchPaperMetadata,
  searchPapers,
  InvalidDoiError,
} from "../src/core/scholarly.ts";
import { mergeCandidates } from "../src/core/providers/merge.ts";
import type { FetchLike } from "../src/core/providers/types.ts";
import {
  SEARCH_CFG,
  cfg,
  candidate,
  createFakeFetch,
  createSearchFetch,
  crossrefWorkEnvelope,
  fakeWorks,
  requestedPageSize,
} from "./helpers/provider-fakes.ts";

const BIBTEX = "@article{test2024, title={Test}}";

describe("searchPapers — provider degradation (R4)", () => {
  it("succeeds when one provider 429s, attaching that provider's warning", async () => {
    const { fetchFn } = createSearchFetch({
      openalex: fakeWorks("oa", 3),
      crossref: "rate-limited",
      semanticScholar: fakeWorks("s2", 3),
    });
    const result = await searchPapers(fetchFn, SEARCH_CFG, { query: "microplastics" });
    assert.ok(result.candidates.length > 0);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.provider, "crossref");
    assert.equal(result.warnings[0]?.code, "PROVIDER_FAILED");
  });

  it("throws SearchUnavailableError with all warnings when every provider fails", async () => {
    const { fetchFn } = createSearchFetch({
      openalex: "down",
      crossref: "down",
      semanticScholar: "down",
    });
    await assert.rejects(
      searchPapers(fetchFn, SEARCH_CFG, { query: "microplastics" }),
      (err: unknown) => {
        assert.ok(err instanceof SearchUnavailableError);
        assert.equal(err.warnings.length, 3);
        assert.deepEqual(
          err.warnings.map((w) => w.provider),
          ["openalex", "crossref", "semantic-scholar"],
        );
        return true;
      },
    );
  });
});

describe("RRF merge — determinism", () => {
  it("merges fixed provider rankings into a stable order", () => {
    const openalex = [
      candidate({ title: "alpha", doi: "10.1000/a", provider: "openalex", citationCount: 5 }),
      candidate({ title: "beta", doi: "10.1000/b", provider: "openalex", citationCount: 5 }),
    ];
    const crossref = [
      candidate({ title: "beta", doi: "10.1000/b", provider: "crossref", citationCount: 5 }),
      candidate({ title: "alpha", doi: "10.1000/a", provider: "crossref", citationCount: 5 }),
    ];
    const merged = mergeCandidates([openalex, crossref]);
    // alpha: 1/61 + 1/62; beta: 1/61 + 1/62 — tie broken by citation count
    // (equal) then title ascending: alpha first.
    assert.deepEqual(merged.map((c) => c.title), ["alpha", "beta"]);
  });

  it("is invariant under permuted input list order", () => {
    const a = [
      candidate({ title: "alpha", doi: "10.1000/a", provider: "openalex" }),
      candidate({ title: "gamma", doi: "10.1000/g", provider: "openalex" }),
    ];
    const b = [
      candidate({ title: "beta", doi: "10.1000/b", provider: "crossref" }),
      candidate({ title: "alpha", doi: "10.1000/a", provider: "crossref" }),
    ];
    const c = [candidate({ title: "gamma", doi: "10.1000/g", provider: "semantic-scholar" })];
    const forward = mergeCandidates([a, b, c]);
    const permuted = mergeCandidates([c, a, b]);
    assert.deepEqual(forward.map((x) => x.dedupKey), permuted.map((x) => x.dedupKey));
  });
});

describe("Feynman adoptions (KTD3)", () => {
  it("candidates carry endpoint provenance", async () => {
    const { fetchFn } = createSearchFetch({
      openalex: fakeWorks("oa", 2),
      crossref: fakeWorks("cr", 2),
      semanticScholar: fakeWorks("s2", 2),
    });
    const result = await searchPapers(fetchFn, SEARCH_CFG, { query: "microplastics" });
    for (const c of result.candidates) {
      assert.equal(typeof c.endpoint, "string");
      assert.ok(c.endpoint.length > 0);
    }
    for (const c of result.candidates) {
      assert.ok(!("fullText" in c));
      assert.ok(!("openAccessArxivOnly" in c));
    }
  });

  it("a DOI-shaped query still searches pass-through and adds a hint", async () => {
    const { fetchFn, requests } = createSearchFetch({
      openalex: fakeWorks("oa", 1),
      crossref: fakeWorks("cr", 1),
      semanticScholar: fakeWorks("s2", 1),
    });
    const result = await searchPapers(fetchFn, SEARCH_CFG, { query: "10.1038/nature12373" });
    assert.ok(result.candidates.length > 0);
    assert.ok(typeof result.hint === "string" && result.hint.includes("10.1038/nature12373"));
    // Pass-through discipline: the query reaches every provider unchanged.
    for (const url of requests) {
      const params = new URL(url).searchParams;
      const q = params.get("search") ?? params.get("query.bibliographic") ?? params.get("query");
      assert.equal(q, "10.1038/nature12373");
    }
  });

  it("no hint for a non-DOI query", async () => {
    const { fetchFn } = createSearchFetch({
      openalex: fakeWorks("oa", 1),
      crossref: fakeWorks("cr", 1),
      semanticScholar: fakeWorks("s2", 1),
    });
    const result = await searchPapers(fetchFn, SEARCH_CFG, { query: "attention is all you need" });
    assert.equal(result.hint, null);
  });
});

describe("limit clamps (R19 — Feynman incident caps)", () => {
  it("clamps limit 0 to 1 and limit 500 to the max 20", async () => {
    const pools = { openalex: fakeWorks("oa", 40), crossref: fakeWorks("cr", 40), semanticScholar: fakeWorks("s2", 40) };
    const low = createSearchFetch(pools);
    const lowResult = await searchPapers(low.fetchFn, SEARCH_CFG, { query: "q", limit: 0 });
    assert.equal(lowResult.requested, 1);
    assert.equal(lowResult.returned, 1);

    const high = createSearchFetch(pools);
    const highResult = await searchPapers(high.fetchFn, SEARCH_CFG, { query: "q", limit: 500 });
    assert.equal(highResult.requested, 20);
    assert.ok(highResult.truncated);
  });

  it("defaults to 5 and asks each provider for 2× the limit", async () => {
    const { fetchFn, requests } = createSearchFetch({
      openalex: fakeWorks("oa", 20),
      crossref: fakeWorks("cr", 20),
      semanticScholar: fakeWorks("s2", 20),
    });
    const result = await searchPapers(fetchFn, SEARCH_CFG, { query: "q" });
    assert.equal(result.requested, 5);
    assert.equal(requestedPageSize(requests, SEARCH_CFG.openalexBaseUrl, "per-page"), 10);
    assert.equal(requestedPageSize(requests, SEARCH_CFG.crossrefBaseUrl, "rows"), 10);
    assert.equal(requestedPageSize(requests, SEARCH_CFG.semanticScholarBaseUrl, "limit"), 10);
  });
});

describe("fetchPaperMetadata — DOI forms", () => {
  const work = crossrefWorkEnvelope({ doi: "10.1038/nature12373", title: "Structure of a bacterial nanomachine" });

  function crossrefFetch(): { fetchFn: FetchLike; requests: { url: string; headers: Record<string, string> | undefined }[] } {
    const { fetchFn, requests } = createFakeFetch([
      { match: (u) => u.includes("/transform/application/x-bibtex"), body: BIBTEX },
      { match: (u) => u.includes("api.crossref.test/works/10.1038%2Fnature12373"), body: work },
    ]);
    return { fetchFn, requests };
  }

  it("accepts 10.x/y, doi:…, and https://doi.org/… as the same DOI", async () => {
    for (const form of ["10.1038/nature12373", "doi:10.1038/nature12373", "https://doi.org/10.1038/nature12373"]) {
      const { fetchFn } = crossrefFetch();
      const record = await fetchPaperMetadata(fetchFn, cfg(), { doi: form });
      assert.ok(record !== null, form);
      assert.equal(record.doi, "10.1038/nature12373");
      assert.equal(record.bibtex, BIBTEX);
      assert.equal(record.citable, true);
    }
  });

  it("rejects a bare arXiv id with InvalidDoiError", async () => {
    const { fetchFn } = crossrefFetch();
    await assert.rejects(fetchPaperMetadata(fetchFn, cfg(), { doi: "1234.5678" }), InvalidDoiError);
  });

  it("routes arxiv:1234.5678 through DataCite as 10.48550/arxiv.1234.5678", async () => {
    const { fetchFn, requests } = createFakeFetch([
      {
        match: (u) => u.startsWith("https://api.datacite.org/dois/"),
        body: JSON.stringify({
          data: {
            attributes: {
              doi: "10.48550/arxiv.1234.5678",
              titles: [{ title: "An arXiv paper" }],
              creators: [{ name: "A. Author" }],
              publicationYear: 2024,
              publisher: "arXiv",
            },
          },
        }),
      },
      { match: (u) => u.startsWith("https://data.crosscite.org/"), body: BIBTEX },
    ]);
    const record = await fetchPaperMetadata(fetchFn, cfg(), { doi: "arxiv:1234.5678" });
    assert.ok(record !== null);
    assert.equal(record.doi, "10.48550/arxiv.1234.5678");
    assert.equal(record.provider, "datacite");
    assert.ok(requests.some((r) => r.url.includes("10.48550/arxiv.1234.5678")));
    assert.equal(record.bibtex, BIBTEX);
    assert.equal(record.citable, true);
  });

  it("returns null (DOI_NOT_FOUND surface) when Crossref 404s a well-formed DOI", async () => {
    const { fetchFn } = createFakeFetch([
      { match: () => true, status: 404, body: "Resource not found." },
    ]);
    const record = await fetchPaperMetadata(fetchFn, cfg(), { doi: "10.9999/nowhere" });
    assert.equal(record, null);
  });

  it("keeps bibtex null and citable false when content negotiation yields nothing (R13)", async () => {
    const { fetchFn } = createFakeFetch([
      { match: (u) => u.includes("/transform/application/x-bibtex"), status: 404, body: "no bibtex" },
      { match: (u) => u.includes("/works/10.1038%2Fnature12373"), body: work },
    ]);
    const record = await fetchPaperMetadata(fetchFn, cfg(), { doi: "10.1038/nature12373" });
    assert.ok(record !== null);
    assert.equal(record.bibtex, null);
    assert.equal(record.citable, false);
  });
});
