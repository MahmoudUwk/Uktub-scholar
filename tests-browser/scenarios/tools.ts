/**
 * Shared tool-level fixtures and runners for the browser differential tests.
 *
 * Bundle-safe AND Node-safe: no `node:*` imports (only type-only core imports,
 * erased at build). The SAME builders feed (a) the Node run in `tools.spec.ts`
 * (temp directory, real `node:sqlite`/`node:fs`) and (b) the Chromium run
 * through `src/browser/host.ts` (routes cross postMessage as data).
 */
import type { FetchLike, ProviderConfig } from "../../src/core/providers/types.ts";
import type { DownloadLike } from "../../src/core/source/download.ts";

/** Fixed clock both sides inject, so timestamps compare exactly. */
export const FIXED_NOW_ISO = "2026-10-04T00:00:00Z";

/** Provider endpoints behind `.test` hosts: a request that escaped a fake fails closed. */
export const TEST_PROVIDER_CONFIG: ProviderConfig = {
  openalexBaseUrl: "https://api.openalex.test",
  crossrefBaseUrl: "https://api.crossref.test",
  semanticScholarBaseUrl: "https://api.semanticscholar.test",
};

/** One canned fetch route (serializable across postMessage). */
export interface CannedRoute {
  /** Substring matched against the request URL (first match wins). */
  match: string;
  status?: number;
  body: string;
  headers?: Record<string, string>;
  /** Optional simulated delay (ms) so in-flight cancellation can be tested deterministically. */
  delayMs?: number;
  /** With `delayMs`: keep waiting even after the caller aborts (a fetch that ignores its signal). */
  ignoreAbort?: boolean;
}

/** One canned download (serializable across postMessage). */
export interface CannedDownload {
  /** Substring matched against the request URL (first match wins). */
  match: string;
  bytesBase64: string;
  contentType?: string | null;
  finalUrl?: string;
}

/** `FetchLike` from serializable routes: first substring match wins, else throw. */
export function buildCannedFetch(routes: CannedRoute[]): FetchLike {
  return (async (url: string, init?: { signal?: AbortSignal }) => {
    init?.signal?.throwIfAborted();
    const route = routes.find((r) => url.includes(r.match));
    if (route === undefined) throw new Error(`NO_CANNED_ROUTE: ${url}`);
    if (route.delayMs !== undefined && route.delayMs > 0 && route.ignoreAbort === true) {
      await new Promise<void>((resolve) => setTimeout(resolve, route.delayMs));
    } else if (route.delayMs !== undefined && route.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, route.delayMs);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(init.signal!.reason ?? new DOMException("The operation was aborted.", "AbortError"));
          },
          { once: true },
        );
      });
    }
    init?.signal?.throwIfAborted();
    return new Response(route.body, { status: route.status ?? 200, headers: route.headers ?? {} });
  }) as FetchLike;
}

/** `DownloadLike` from serializable downloads: first substring match wins. */
export function buildCannedDownload(downloads: CannedDownload[]): DownloadLike {
  const decode = (b64: string): Uint8Array => {
    const g = globalThis as unknown as { Buffer?: { from(s: string, enc: string): Uint8Array } };
    const raw =
      g.Buffer !== undefined
        ? g.Buffer.from(b64, "base64")
        : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice();
  };
  return (async (raw: string) => {
    const hit = downloads.find((d) => raw.includes(d.match));
    if (hit === undefined) throw new Error(`NO_CANNED_DOWNLOAD: ${raw}`);
    return { finalUrl: hit.finalUrl ?? raw, contentType: hit.contentType ?? null, bytes: decode(hit.bytesBase64) };
  }) as DownloadLike;
}

// ── register fixtures (Crossref DOI cascade) ────────────────────────────────

export interface FakePaper {
  title: string;
  bibtex?: string | null;
  abstract?: string;
  year?: number;
}

function crossrefRecordBody(doi: string, p: FakePaper): string {
  return JSON.stringify({
    message: {
      DOI: doi,
      title: [p.title],
      author: [{ family: "Holder", given: "Ada" }],
      issued: { "date-parts": [[p.year ?? 2024]] },
      ...(p.abstract !== undefined ? { abstract: p.abstract } : {}),
    },
  });
}

/**
 * Crossref record + BibTeX-transform routes for each DOI. Transform routes
 * come FIRST: the transform URL extends the record URL, so first-match-wins
 * needs the longer match ahead of the shorter one.
 */
export function registerRoutes(papers: Record<string, FakePaper>): CannedRoute[] {
  const out: CannedRoute[] = [];
  for (const [doi, p] of Object.entries(papers)) {
    const enc = encodeURIComponent(doi);
    out.push({
      match: `/works/${enc}/transform/`,
      status: p.bibtex === undefined || p.bibtex === null ? 404 : 200,
      body: p.bibtex ?? "",
    });
  }
  for (const [doi, p] of Object.entries(papers)) {
    out.push({ match: `/works/${encodeURIComponent(doi)}`, status: 200, body: crossrefRecordBody(doi, p) });
  }
  return out;
}

/** DataCite record + BibTeX routes for an arXiv DOI (the 10.48550 prefix resolves through DataCite, not Crossref). */
export function dataciteRoutes(doi: string, p: FakePaper): CannedRoute[] {
  return [
    {
      match: `api.datacite.org/dois/${doi}`,
      body: JSON.stringify({
        data: {
          attributes: {
            doi,
            titles: [{ title: p.title }],
            creators: [{ name: "Holder, Ada" }],
            publicationYear: p.year ?? 2025,
            publisher: "arXiv",
          },
        },
      }),
    },
    { match: `data.crosscite.org/application/x-bibtex/${doi}`, body: p.bibtex ?? "" },
  ];
}

// ── search fixtures (three-provider fan-out) ────────────────────────────────

export interface FakeWork {
  title: string;
  doi: string;
}

/** Ranked pools: two works per provider, DOIs distinct per provider. */
export function searchRoutes(openalex: FakeWork[], crossref: FakeWork[], s2: FakeWork[]): CannedRoute[] {
  return [
    {
      match: "api.openalex.test",
      body: JSON.stringify({
        results: openalex.map((w, i) => ({
          id: `https://openalex.org/W${i + 1}`,
          doi: `https://doi.org/${w.doi}`,
          title: w.title,
          cited_by_count: null,
        })),
      }),
    },
    {
      match: "api.crossref.test",
      body: JSON.stringify({
        message: {
          items: crossref.map((w) => ({ DOI: w.doi, title: [w.title], "is-referenced-by-count": null })),
        },
      }),
    },
    {
      match: "api.semanticscholar.test",
      body: JSON.stringify({
        data: s2.map((w, i) => ({
          paperId: `S${i + 1}`,
          title: w.title,
          externalIds: { DOI: w.doi },
          citationCount: null,
        })),
      }),
    },
  ];
}

// ── TEI fixture (attach path that avoids the stubbed `unpdf` seam) ──────────

/** Tiny GROBID-style TEI whose opening carries the DOI and title (identity). */
export function teiFixture(doi: string, title: string): string {
  const para =
    `This paper ${doi} studies thermal Grids That Age Slowly in the field. ` +
    "The experiment records many independent measurements of the cell under sustained thermal cycling. ".repeat(6);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<TEI xmlns="http://www.tei-c.org/ns/1.0">\n` +
    `<teiHeader><fileDesc><titleStmt><title>${title}</title></titleStmt></fileDesc></teiHeader>\n` +
    `<text><body><div><head>Introduction</head>` +
    `<p>${para}</p><p>${para}</p>` +
    `</div></body></text>\n</TEI>\n`
  );
}

// ── normalization (paths, nothing else is volatile) ─────────────────────────

/**
 * Normalize one tool result for Node-vs-browser comparison: both roots become
 * `<root>`. Timestamps (fixed clock), revisions (sha256), cursors and pointers
 * are already deterministic; anything still volatile is a real difference.
 */
export function normalizeForCompare(root: string, value: unknown): unknown {
  const raw = JSON.stringify(value);
  const norm = raw.split(root).join("<root>");
  return JSON.parse(norm) as unknown;
}
