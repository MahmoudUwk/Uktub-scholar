/**
 * Shared 429 backoff for the HTTP verification engines (hosted System One and
 * OpenRouter decisions): Retry-After / rate-limit reset headers are honored
 * when present, else bounded exponential backoff; other 4xx are never
 * retried; giving up is a clear engine error naming 429 and the wait, never
 * the key. Offline: stub fetch, injected sleep (no real waiting).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EngineError,
  fetchWith429Retry,
  openrouterDecisionsEngine,
  RateLimitedError,
  systemoneEndpointEngine,
} from "../src/core/verify/claim.ts";

const URL = "https://decision.vllm-sr.ai/v1/systemone";
const KEY = "k-secret-test-key";

/** Stub fetch answering the queued statuses; records calls. Sleeps resolve instantly and record the wait. */
function harness(queue: { status: number; headers?: Record<string, string>; body?: unknown }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls.push({ url: String(_url), init });
    const next = queue.shift() ?? { status: 200 };
    const body = next.body ?? { answers: { c: { noul: 0.5 } }, model: "vllm-sr/d3-mini" };
    return new Response(JSON.stringify(body), { status: next.status, headers: next.headers });
  }) as unknown as typeof fetch;
  const sleepImpl = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };
  return { calls, sleeps, fetchImpl, sleepImpl };
}

describe("shared 429 backoff", () => {
  it("hosted: two 429s then success returns the judgment", async () => {
    const h = harness([{ status: 429 }, { status: 429 }, { status: 200 }]);
    const e = systemoneEndpointEngine({ url: URL, label: "hosted", apiKey: KEY, model: "vllm-sr/d3-mini", fetchImpl: h.fetchImpl, sleepImpl: h.sleepImpl });
    assert.deepEqual(await e.run([{ state: "s", instructions: "c" }]), [0.5]);
    assert.equal(h.calls.length, 3);
    assert.equal(h.sleeps.length, 2);
  });

  it("hosted: Retry-After seconds are honored", async () => {
    const h = harness([{ status: 429, headers: { "retry-after": "2" } }, { status: 200 }]);
    const e = systemoneEndpointEngine({ url: URL, label: "hosted", fetchImpl: h.fetchImpl, sleepImpl: h.sleepImpl });
    assert.deepEqual(await e.run([{ state: "s", instructions: "c" }]), [0.5]);
    assert.deepEqual(h.sleeps, [2250]);
  });

  it("hosted: persistent 429s give up with a clear engine error naming 429 and the wait, never the key", async () => {
    const h = harness(Array.from({ length: 10 }, () => ({ status: 429 })));
    const e = systemoneEndpointEngine({ url: URL, label: "hosted", fetchImpl: h.fetchImpl, sleepImpl: h.sleepImpl });
    const err = await e.run([{ state: "s", instructions: "c" }]).then(() => null, (e: Error) => e);
    assert.ok(err instanceof EngineError, `got ${err}`);
    assert.match(err.message, /429/);
    assert.match(err.message, /wait/i);
    assert.ok(!err.message.includes(KEY), "the key is never in the error");
    assert.equal(h.calls.length, 4, "one attempt plus three retries");
  });

  it("hosted: other 4xx are never retried", async () => {
    for (const status of [400, 401]) {
      const h = harness([{ status }, { status: 200 }]);
      const e = systemoneEndpointEngine({ url: URL, label: "hosted", fetchImpl: h.fetchImpl, sleepImpl: h.sleepImpl });
      const err = await e.run([{ state: "s", instructions: "c" }]).then(() => null, (e: Error) => e);
      assert.ok(err instanceof EngineError, `status ${status}: got ${err}`);
      assert.equal(h.calls.length, 1, `status ${status} is not retried`);
      assert.equal(h.sleeps.length, 0);
      assert.ok(!err.message.includes(KEY), "the key is never in the error");
    }
  });

  it("openrouter: a 429 then success returns the score (shared helper, second consumer)", async () => {
    const calls: unknown[] = [];
    const sleeps: number[] = [];
    const resetAt = Date.now();
    const fetchImpl = (async (_url: string, _init?: RequestInit) => {
      calls.push(1);
      if (calls.length === 1) return new Response("limited", { status: 429, headers: { "x-ratelimit-reset": String(resetAt) } });
      return new Response(JSON.stringify({ answers: { c: { noul: 0.7 } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const e = openrouterDecisionsEngine({
      env: { OPENROUTER_API_KEY: KEY },
      fetchImpl,
      model: "m",
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    assert.deepEqual(await e.run([{ state: "s", instructions: "c" }]), [0.7]);
    assert.equal(calls.length, 2);
    assert.equal(sleeps.length, 1);
  });

  it("openrouter: a reset far in the future fails fast with the switch-model advice", async () => {
    const fetchImpl = (async () =>
      new Response("limited", { status: 429, headers: { "x-ratelimit-reset": String(Date.now() + 3_600_000), "x-ratelimit-limit": "20" } })) as unknown as typeof fetch;
    const e = openrouterDecisionsEngine({ env: { OPENROUTER_API_KEY: KEY }, fetchImpl, model: "m", sleepImpl: async () => {} });
    const err = await e.run([{ state: "s", instructions: "c" }]).then(() => null, (e: Error) => e);
    assert.ok(err instanceof EngineError, `got ${err}`);
    assert.match(err.message, /429/);
    assert.match(err.message, /switch model/);
    assert.ok(!err.message.includes(KEY), "the key is never in the error");
  });

  it("fetchWith429Retry: the total-wait bound stops immediate-429 loops", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const send = async (): Promise<Response> => {
      calls++;
      return new Response("limited", { status: 429, headers: { "retry-after": "0" } });
    };
    const err = await fetchWith429Retry(send, { label: "probe", maxTotalWaitMs: 500, sleepImpl: async (ms) => { sleeps.push(ms); } }).then(
      () => null,
      (e: Error) => e,
    );
    assert.ok(err instanceof RateLimitedError, `got ${err}`);
    assert.match(err.message, /429/);
    assert.ok(sleeps.reduce((a, b) => a + b, 0) <= 500, `waited ${sleeps.reduce((a, b) => a + b, 0)}`);
    assert.ok(calls >= 2, "retried at least once before the bound");
  });

  it("fetchWith429Retry: non-429 responses pass through untouched", async () => {
    const send = async (): Promise<Response> => new Response("bad", { status: 400 });
    const res = await fetchWith429Retry(send, { label: "probe", sleepImpl: async () => {} });
    assert.equal(res.status, 400);
  });
});
