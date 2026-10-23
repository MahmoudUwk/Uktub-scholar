/**
 * Cancellation through the provider layer: a caller's abort reaches the in-flight request and the retry backoff, settles promptly,
 * is never retried or reported as a provider failure, and a cancelled owner of a shared acquisition does not fail its waiters.
 * Offline: every provider and download is a fake that hangs until its signal aborts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { fetchWithRetry } from "../src/core/providers/http.ts";
import type { FetchLike } from "../src/core/providers/types.ts";
import { searchPapersTool } from "../src/core/tools/search.ts";
import { acquireSource } from "../src/core/source/prepare.ts";
import type { DownloadLike } from "../src/core/source/download.ts";
import { prepareSources } from "../src/core/verify/acquire.ts";
import { DEFAULTS } from "../src/core/config.ts";
import { createRegistry } from "../src/core/registry.ts";
import { getSource } from "../src/core/verify/store.ts";
import { cfg } from "./helpers/provider-fakes.ts";
import { bib, crossrefFake, makeCtx } from "./helpers/registry-fakes.ts";
import { paperRegistryTool, type PaperRegistryArgs } from "../src/core/tools/registry.ts";
import { makePdf } from "./helpers/pdf.ts";

const noSleep = async () => {};
const URL_ANY = "https://provider.test/works";
const PAPER = { doi: "10.1234/cells", title: "Cycle Life of Lithium Cells Under Thermal Stress" };
const PDF = makePdf([[PAPER.title, "Cells age faster at high temperature and capacity fades with every cycle."]]);

type Outcome = { ok: true } | { ok: false; error: unknown };
/** Settles a promise into a value, so a rejection is inspected rather than thrown. */
const outcome = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
/** Fails the test (instead of hanging it) when `p` is still pending after `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, limit]);
  } finally {
    clearTimeout(timer);
  }
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

/** A fetch that never answers; it rejects only when the signal it was given aborts. */
function hangsUntilAborted(seen: AbortSignal[]): FetchLike {
  return (_url, init) => {
    const signal = init?.signal;
    if (signal !== undefined) seen.push(signal);
    return new Promise<never>((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-cancel-"));
  db = createRegistry(root);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("fetchWithRetry honours a caller signal", () => {
  it("a caller abort reaches the in-flight attempt and rejects promptly with the abort reason", async () => {
    const seen: AbortSignal[] = [];
    const ac = new AbortController();
    const p = outcome(fetchWithRetry(hangsUntilAborted(seen), URL_ANY, { timeoutMs: 2000, sleep: noSleep, signal: ac.signal }));
    await delay(20);
    ac.abort();
    const r = await within(p, 100);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && isAbort(r.error), "rejects with the abort reason");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.aborted, true, "the attempt's own request was cancelled");
  });

  it("an abort during the retry backoff settles promptly and makes no further attempt", async () => {
    let requests = 0;
    const busy: FetchLike = async () => {
      requests++;
      return new Response("busy", { status: 503 }) as unknown as Awaited<ReturnType<FetchLike>>;
    };
    const ac = new AbortController();
    // Default (real, abortable) backoff: 500 ms or more before the second attempt.
    const p = outcome(fetchWithRetry(busy, URL_ANY, { timeoutMs: 2000, signal: ac.signal }));
    await delay(30);
    ac.abort();
    const r = await within(p, 100);
    assert.ok(!r.ok && isAbort(r.error), "the backoff wait rejects with the abort reason");
    assert.equal(requests, 1, "no retry after the caller aborted");
  });

  it("an already-aborted signal makes no request", async () => {
    let requests = 0;
    const ok: FetchLike = async () => {
      requests++;
      return new Response("ok", { status: 200 }) as unknown as Awaited<ReturnType<FetchLike>>;
    };
    const ac = new AbortController();
    ac.abort();
    const r = await within(outcome(fetchWithRetry(ok, URL_ANY, { sleep: noSleep, signal: ac.signal })), 100);
    assert.ok(!r.ok && isAbort(r.error));
    assert.equal(requests, 0);
  });
});

describe("papers tool honours the call's context signal", () => {
  it("aborting the call cancels every provider request and is not reported as provider failures", async () => {
    const seen: AbortSignal[] = [];
    const ac = new AbortController();
    const ctx = makeCtx(root, hangsUntilAborted(seen), {
      signal: ac.signal,
      providerConfig: cfg({ sleep: noSleep, timeoutMs: 2000 }),
    });
    const p = outcome(searchPapersTool(ctx, { query: "microplastics" }));
    await delay(20);
    ac.abort();
    const r = await within(p, 100);
    assert.ok(!r.ok && isAbort(r.error), "the call rejects with the abort, not a SEARCH_UNAVAILABLE refusal");
    assert.equal(seen.length, 3, "all three providers were asked");
    assert.ok(seen.every((s) => s.aborted), "every provider request was cancelled");
  });
});

describe("acquireSource honours a caller signal", () => {
  it("an aborted caller stops the lookup and rejects instead of falling through to other copies", async () => {
    const seen: AbortSignal[] = [];
    const downloads: string[] = [];
    const download: DownloadLike = async (url) => {
      downloads.push(url);
      throw new Error("no download expected");
    };
    const ac = new AbortController();
    const p = outcome(
      acquireSource(
        { fetch: hangsUntilAborted(seen), download, cfg: cfg({ sleep: noSleep, timeoutMs: 2000 }), signal: ac.signal },
        PAPER,
      ),
    );
    await delay(20);
    ac.abort();
    const r = await within(p, 100);
    assert.ok(!r.ok && isAbort(r.error), "rejects with the abort reason");
    assert.deepEqual(downloads, []);
  });
});

describe("prepareSources: shared acquisition and a cancelled owner", () => {
  /** A download that hangs on its first call (the owner's) and serves the PDF on every later call. */
  function gatedDownload(): { download: DownloadLike; firstStarted: Promise<void>; calls: () => number } {
    let calls = 0;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => (markStarted = resolve));
    const download: DownloadLike = (url, init) => {
      calls++;
      if (calls === 1) {
        markStarted();
        return new Promise<never>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        });
      }
      return Promise.resolve({ finalUrl: url, contentType: null, bytes: PDF });
    };
    return { download, firstStarted, calls: () => calls };
  }

  /** OpenAlex answers the lookup with an open PDF link; the download is the gate above. */
  const openalexFetch: FetchLike = async (url) => {
    if (!url.includes("/works/")) return new Response("{}", { status: 404 });
    return new Response(
      JSON.stringify({ doi: `https://doi.org/${PAPER.doi}`, locations: [{ is_oa: true, pdf_url: "https://repo.test/a.pdf" }] }),
      { status: 200 },
    );
  };
  const paper = { doi: PAPER.doi, citekey: "cells2024", title: PAPER.title, citable: true };
  /** A source is only published for a registered paper: register it as the acquisition hook tests do. */
  async function registerPaper(): Promise<void> {
    const { fetchFn } = crossrefFake({ [PAPER.doi]: { title: PAPER.title, bibtex: bib("cells2024", PAPER.title) } });
    const r = await paperRegistryTool(makeCtx(root, fetchFn), { action: "register", identifiers: [PAPER.doi] } as unknown as PaperRegistryArgs);
    assert.equal(r.structuredContent?.outcomes[0]?.status, "registered");
  }

  it("a waiter takes over when the owner is cancelled: it still gets the source, and the owner rejects with its own abort", async () => {
    await registerPaper();
    const gate = gatedDownload();
    const ownerAc = new AbortController();
    const owner = makeCtx(root, openalexFetch, { download: gate.download, signal: ownerAc.signal, providerConfig: cfg({ sleep: noSleep }) });
    const waiter = makeCtx(root, openalexFetch, { download: gate.download, providerConfig: cfg({ sleep: noSleep }) });

    const ownerRun = outcome(prepareSources(owner, db, [paper], DEFAULTS, []));
    await gate.firstStarted;
    const waiterRun = outcome(prepareSources(waiter, db, [paper], DEFAULTS, []));
    await delay(10);
    ownerAc.abort();

    const ownerResult = await within(ownerRun, 100);
    assert.ok(!ownerResult.ok && isAbort(ownerResult.error), "the cancelled owner rejects with its abort");
    const waiterResult = await within(waiterRun, 2000);
    assert.equal(waiterResult.ok, true, "the uncancelled waiter completes");
    assert.equal(getSource(db, PAPER.doi)?.status, "ready");
    assert.equal(gate.calls(), 2, "one takeover acquisition, not one per waiter poll");
  });

  it("a waiter that is itself cancelled rejects with its own abort while the owner keeps running", async () => {
    await registerPaper();
    const gate = gatedDownload();
    const ownerAc = new AbortController();
    const waiterAc = new AbortController();
    const owner = makeCtx(root, openalexFetch, { download: gate.download, signal: ownerAc.signal, providerConfig: cfg({ sleep: noSleep }) });
    const waiter = makeCtx(root, openalexFetch, { download: gate.download, signal: waiterAc.signal, providerConfig: cfg({ sleep: noSleep }) });

    const ownerRun = outcome(prepareSources(owner, db, [paper], DEFAULTS, []));
    await gate.firstStarted;
    const waiterRun = outcome(prepareSources(waiter, db, [paper], DEFAULTS, []));
    await delay(10);
    waiterAc.abort();
    const waiterResult = await within(waiterRun, 100);
    assert.ok(!waiterResult.ok && isAbort(waiterResult.error), "the waiter rejects with its own abort");
    assert.equal(gate.calls(), 1, "the owner's acquisition was not started again or cancelled by the waiter");
    ownerAc.abort();
    await within(ownerRun, 100);
  });
});
