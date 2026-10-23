/**
 * Provider response shape and abortable spacer waits.
 *
 * Shape: a 200 body whose documented results container is missing or not an
 * array is a broken call (thrown as ProviderRequestError), never a silent `[]`.
 * A documented empty response still resolves `[]`. Offline: fake fetch only.
 *
 * Spacer: `wait(signal)` rejects promptly with the abort reason, and an aborted
 * waiter neither consumes a spacing slot nor holds up the callers behind it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { searchOpenAlex } from "../src/core/providers/openalex.ts";
import { searchCrossref } from "../src/core/providers/crossref.ts";
import { createStartSpacer, searchSemanticScholar } from "../src/core/providers/semantic-scholar.ts";
import { ProviderRequestError } from "../src/core/providers/types.ts";
import { cfg } from "./helpers/provider-fakes.ts";
import { createFakeFetch } from "./helpers/provider-fakes.ts";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
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
const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";
const isProviderError = (provider: string) => (error: unknown) =>
  error instanceof ProviderRequestError && error.provider === provider;
const hangForever = (): Promise<void> => new Promise<void>(() => {});

describe("OpenAlex: a 200 body without a results array is a broken call", () => {
  it("an empty object body throws instead of returning no papers", async () => {
    const { fetchFn } = createFakeFetch([{ match: (u) => u.includes("/works"), body: "{}" }]);
    await assert.rejects(searchOpenAlex(fetchFn, cfg(), "cells"), isProviderError("openalex"));
  });

  it("a non-array results field throws", async () => {
    const { fetchFn } = createFakeFetch([{ match: (u) => u.includes("/works"), body: '{"results":"nope"}' }]);
    await assert.rejects(searchOpenAlex(fetchFn, cfg(), "cells"), isProviderError("openalex"));
  });

  it("a broken venue lookup throws instead of silently dropping the search", async () => {
    const { fetchFn } = createFakeFetch([{ match: (u) => u.includes("/sources"), body: "{}" }]);
    await assert.rejects(searchOpenAlex(fetchFn, cfg(), "cells", { venue: "Nature" }), isProviderError("openalex"));
  });

  it("a documented empty page (results: []) still resolves []", async () => {
    const body = JSON.stringify({ meta: { count: 0, per_page: 10 }, results: [] });
    const { fetchFn } = createFakeFetch([{ match: (u) => u.includes("/works"), body }]);
    assert.deepEqual(await searchOpenAlex(fetchFn, cfg(), "zzzz"), []);
  });
});

describe("Semantic Scholar and Crossref: no shape change (documented zero-result shape not conclusive)", () => {
  it("Semantic Scholar: a zero-hit body without data resolves [] (data is not required by its schema)", async () => {
    const body = JSON.stringify({ total: 0, offset: 0 });
    const { fetchFn } = createFakeFetch([{ match: (u) => u.includes("/paper/search"), body }]);
    assert.deepEqual(await searchSemanticScholar(fetchFn, cfg({ sleep: async () => {} }), "zzzz"), []);
  });

  it("Crossref: a documented empty work-list (items: []) resolves []", async () => {
    const body = JSON.stringify({ status: "ok", "message-type": "work-list", message: { "total-results": 0, items: [] } });
    const { fetchFn } = createFakeFetch([{ match: (u) => u.includes("/works"), body }]);
    assert.deepEqual(await searchCrossref(fetchFn, cfg(), "zzzz"), []);
  });
});

describe("createStartSpacer: abortable waits", () => {
  it("an abort during a spacing wait rejects promptly with the abort reason", async () => {
    let t = 0;
    const spacer = createStartSpacer({ minIntervalMs: 1000, now: () => t, sleep: () => hangForever() });
    await spacer.wait();
    const ac = new AbortController();
    const p = spacer.wait(ac.signal).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await delay(20);
    ac.abort();
    const r = await within(p, 100);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && isAbort(r.error), "rejects with the abort reason");
  });

  it("an aborted waiter does not hold up the caller queued behind it, nor move the slot", async () => {
    let t = 0;
    const sleeps: number[] = [];
    let hang = true;
    const spacer = createStartSpacer({
      minIntervalMs: 1000,
      now: () => t,
      sleep: (ms) => {
        sleeps.push(ms);
        if (hang) {
          hang = false;
          return hangForever();
        }
        t += ms;
        return Promise.resolve();
      },
    });
    await spacer.wait();
    const ac = new AbortController();
    const aborted = spacer.wait(ac.signal).catch((error: unknown) => error);
    const after = spacer.wait();
    await delay(20);
    ac.abort();
    assert.ok(isAbort(await within(aborted, 100)), "the aborted waiter rejected");
    await within(after, 100);
    assert.deepEqual(sleeps, [1000, 1000], "the next caller sleeps out the original slot, not a new one");
    assert.equal(t, 1000);
  });

  it("a waiter aborted while an earlier caller is still spacing does not let a later caller start early", async () => {
    let t = 0;
    const sleeps: number[] = [];
    let finishFirstSleep!: () => void;
    const spacer = createStartSpacer({
      minIntervalMs: 1000,
      now: () => t,
      sleep: (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 1) {
          return new Promise<void>((resolve) => {
            finishFirstSleep = () => {
              t += ms;
              resolve();
            };
          });
        }
        t += ms;
        return Promise.resolve();
      },
    });
    await spacer.wait();
    const first = spacer.wait();
    const ac = new AbortController();
    const aborted = spacer.wait(ac.signal).catch((error: unknown) => error);
    let laterStarted = false;
    const later = spacer.wait().then(() => {
      laterStarted = true;
    });
    await delay(20);
    ac.abort();
    assert.ok(isAbort(await within(aborted, 100)), "the aborted waiter rejected");
    await delay(20);
    assert.equal(laterStarted, false, "the later caller must not start while the earlier caller is still spacing");
    finishFirstSleep();
    await within(first, 100);
    await within(later, 100);
    assert.deepEqual(sleeps, [1000, 1000], "the later caller is spaced from the earlier caller's start");
    assert.equal(t, 2000);
  });

  it("an already-aborted signal rejects without sleeping or moving the slot", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const spacer = createStartSpacer({
      minIntervalMs: 1000,
      now: () => t,
      sleep: (ms) => {
        sleeps.push(ms);
        t += ms;
        return Promise.resolve();
      },
    });
    await spacer.wait();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(spacer.wait(ac.signal), isAbort);
    assert.deepEqual(sleeps, []);
    await spacer.wait();
    assert.deepEqual(sleeps, [1000], "the live caller still gets exactly one spacing interval");
  });

  it("non-aborted callers keep the spacing interval", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const spacer = createStartSpacer({
      minIntervalMs: 1000,
      now: () => t,
      sleep: (ms) => {
        sleeps.push(ms);
        t += ms;
        return Promise.resolve();
      },
    });
    await spacer.wait();
    await spacer.wait();
    await spacer.wait();
    assert.deepEqual(sleeps, [1000, 1000]);
    assert.equal(t, 2000);
  });
});

describe("searchSemanticScholar: the caller's signal reaches the spacer wait", () => {
  it("aborting a search that is waiting on the spacer rejects promptly", async () => {
    const { fetchFn } = createFakeFetch([{ match: (u) => u.includes("/paper/search"), body: '{"total":0,"data":[]}' }]);
    // A fresh sleep identity gives this test its own spacer; its first wait never sleeps.
    const config = cfg({ sleep: () => hangForever() });
    await searchSemanticScholar(fetchFn, config, "first");
    const ac = new AbortController();
    const p = searchSemanticScholar(fetchFn, { ...config, signal: ac.signal }, "second").then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await delay(20);
    ac.abort();
    const r = await within(p, 100);
    assert.ok(!r.ok && isAbort(r.error), "the search rejects with the abort reason");
  });
});
