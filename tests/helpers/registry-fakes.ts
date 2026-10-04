/**
 * Shared fixtures for registry/verify tool specs: a Crossref/DataCite fake
 * that resolves DOIs with their own BibTeX, and a ToolContext builder. No
 * network; the fake counts the requests it served.
 */
import { WriteQueue } from "../../src/core/queue.ts";
import type { ToolContext } from "../../src/core/tools/context.ts";
import type { FetchLike } from "../../src/core/providers/types.ts";
import { SEARCH_CFG, createFakeFetch, crossrefWorkEnvelope } from "./provider-fakes.ts";

export const FIXED_NOW = (): Date => new Date("2026-10-04T00:00:00Z");
export const NO_FETCH: FetchLike = async () => {
  throw new Error("no fetch expected");
};

export const bib = (key: string, title: string, year = 2024): string => `@article{${key}, title={${title}}, author={Holder, Ada}, year={${year}}}`;

export interface FakePaper {
  title: string;
  bibtex?: string | null;
  abstract?: string;
  year?: number;
  status?: number;
}

/** Crossref fake for publisher DOIs (record + BibTeX transform). `requests` lists every URL served. */
export function crossrefFake(papers: Record<string, FakePaper>): { fetchFn: FetchLike; requests: string[] } {
  const inner = createFakeFetch(
    Object.entries(papers).flatMap(([doi, p]) => [
      {
        match: (url: string) => decodeURIComponent(url).includes(`/works/${doi}`) && !url.includes("/transform/"),
        status: p.status ?? 200,
        body: crossrefWorkEnvelope({ doi, title: p.title, authors: [{ family: "Holder", given: "Ada" }], year: p.year ?? 2024, ...(p.abstract !== undefined ? { abstract: p.abstract } : {}) }),
      },
      {
        match: (url: string) => decodeURIComponent(url).includes(`/works/${doi}/transform/`),
        status: p.bibtex === undefined || p.bibtex === null ? 404 : 200,
        body: p.bibtex ?? "",
      },
    ]),
  );
  const requests: string[] = [];
  const fetchFn: FetchLike = (url, init) => {
    requests.push(url);
    return inner.fetchFn(url, init);
  };
  return { fetchFn, requests };
}

export function makeCtx(root: string, fetchFn: FetchLike, extra: Partial<ToolContext> = {}): ToolContext {
  return { root, fetch: fetchFn, env: {}, now: FIXED_NOW, queue: new WriteQueue(), providerConfig: SEARCH_CFG, ...extra };
}
