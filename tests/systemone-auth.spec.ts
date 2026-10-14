/**
 * System One HTTP engine auth (hosted d3-mini): the optional API key is sent
 * only to the configured HTTPS origin, the model id rides in the request body,
 * a 401 is a clear engine error, and the key never appears in an error.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EngineError, systemoneEndpointEngine } from "../src/core/verify/claim.ts";
import { createConfiguredEngine, resolveEngineIdentity } from "../src/core/verify/engines.ts";

const KEY = "test-key-abcdefgh1234";
const URL = "https://decision.vllm-sr.ai/v1/systemone";

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
const stub = (seen: Seen[], status = 200, payload: unknown = { answers: { c: { noul: 0.995 } } }) =>
  (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;

describe("systemoneEndpointEngine auth", () => {
  it("sends the key only as a Bearer header to the HTTPS endpoint, with the model field in the body", async () => {
    const seen: Seen[] = [];
    const engine = systemoneEndpointEngine({ url: URL, label: "llama-cpp", apiKey: KEY, model: "vllm-sr/d3-mini", fetchImpl: stub(seen) });
    assert.deepEqual(await engine.run([{ state: "passage", instructions: "claim" }]), [0.995]);
    assert.equal(seen[0]!.headers["authorization"], `Bearer ${KEY}`);
    assert.equal((seen[0]!.body as { model?: string }).model, "vllm-sr/d3-mini");
    assert.ok(!JSON.stringify(seen[0]!.body).includes(KEY), "the key is a header, never in the body");
  });

  it("sends no Authorization header without a key, and no model field without a model", async () => {
    const seen: Seen[] = [];
    const engine = systemoneEndpointEngine({ url: "http://127.0.0.1:8080/v1/systemone", label: "llama-cpp", fetchImpl: stub(seen) });
    await engine.run([{ state: "p", instructions: "c" }]);
    assert.equal(seen[0]!.headers["authorization"], undefined);
    assert.equal("model" in seen[0]!.body, false);
  });

  it("refuses to take a key for a non-HTTPS URL (no key over plaintext)", () => {
    assert.throws(
      () => systemoneEndpointEngine({ url: "http://127.0.0.1:8080/v1/systemone", label: "llama-cpp", apiKey: KEY }),
      (e) => e instanceof EngineError && !e.message.includes(KEY),
    );
  });

  it("a 401 is a clear engine error naming the key variable, never the key", async () => {
    const seen: Seen[] = [];
    const engine = systemoneEndpointEngine({ url: URL, label: "llama-cpp", apiKey: KEY, model: "vllm-sr/d3-mini", fetchImpl: stub(seen, 401, "unauthorized") });
    const err = await engine.run([{ state: "p", instructions: "c" }]).then(() => null, (e: Error) => e);
    assert.ok(err instanceof EngineError);
    assert.match(err.message, /401/);
    assert.match(err.message, /UKTUB_VERIFY_API_KEY/);
    assert.ok(!err.message.includes(KEY), "the error must not carry the key");
  });

  it("createConfiguredEngine wires UKTUB_VERIFY_API_KEY and UKTUB_VERIFY_MODEL from env", async () => {
    const seen: Seen[] = [];
    const realFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = stub(seen) as typeof fetch;
    try {
      const engine = createConfiguredEngine(
        { UKTUB_VERIFY_URL: "https://decision.vllm-sr.ai", UKTUB_VERIFY_API_KEY: KEY, UKTUB_VERIFY_MODEL: "vllm-sr/d3-mini" },
        "llama-cpp",
      );
      await engine.run([{ state: "p", instructions: "c" }]);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = realFetch;
    }
    assert.match(seen[0]!.url, /^https:\/\/decision\.vllm-sr\.ai\/v1\/systemone$/);
    assert.equal(seen[0]!.headers["authorization"], `Bearer ${KEY}`);
    assert.equal((seen[0]!.body as { model?: string }).model, "vllm-sr/d3-mini");
  });
});

describe("llama-cpp identity with a hosted model", () => {
  const models = (id: string | null, status = 200, seen?: { headers: Record<string, string> }[]) =>
    (async (_url: string, init?: RequestInit) => {
      seen?.push({ headers: ((init?.headers ?? {}) as Record<string, string>) ?? {} });
      return id === null ? new Response("nope", { status }) : new Response(JSON.stringify({ data: [{ id }] }), { status });
    }) as unknown as typeof fetch;

  it("the identity names the model id the server reports", async () => {
    const identity = await resolveEngineIdentity(
      { UKTUB_VERIFY_URL: "https://decision.vllm-sr.ai", UKTUB_VERIFY_MODEL: "vllm-sr/d3-mini" },
      "llama-cpp",
      { fetchImpl: models("vllm-sr/d3-mini") },
    );
    assert.deepEqual(identity, { model: "llama-cpp:vllm-sr/d3-mini", protocol: "systemone-noul-v1" });
  });

  it("without a models listing the configured model id stands in (the server echoes it per judgment); without either there is no identity", async () => {
    const fallback = await resolveEngineIdentity(
      { UKTUB_VERIFY_URL: "https://decision.vllm-sr.ai", UKTUB_VERIFY_MODEL: "vllm-sr/d3-mini" },
      "llama-cpp",
      { fetchImpl: models(null, 404) },
    );
    assert.deepEqual(fallback, { model: "llama-cpp:vllm-sr/d3-mini", protocol: "systemone-noul-v1" });
    assert.equal(
      await resolveEngineIdentity({ UKTUB_VERIFY_URL: "https://decision.vllm-sr.ai" }, "llama-cpp", { fetchImpl: models(null, 404) }),
      null,
    );
  });

  it("a response echo naming another model than the configured one refuses the judgments", async () => {
    const seen: Seen[] = [];
    const engine = systemoneEndpointEngine({
      url: URL,
      label: "llama-cpp",
      apiKey: KEY,
      model: "vllm-sr/d3-mini",
      fetchImpl: stub(seen, 200, { answers: { c: { noul: 0.99 } }, model: "vllm-sr/something-else" }),
    });
    const err = await engine.run([{ state: "p", instructions: "c" }]).then(() => null, (e: Error) => e);
    assert.ok(err instanceof EngineError);
    assert.match(err.message, /wrong identity/);
    assert.ok(!err.message.includes(KEY));
  });

  it("a matching echo (or none) passes", async () => {
    const seen: Seen[] = [];
    const engine = systemoneEndpointEngine({
      url: URL,
      label: "llama-cpp",
      apiKey: KEY,
      model: "vllm-sr/d3-mini",
      fetchImpl: stub(seen, 200, { answers: { c: { noul: 0.97 } }, model: "vllm-sr/d3-mini" }),
    });
    assert.deepEqual(await engine.run([{ state: "p", instructions: "c" }]), [0.97]);
  });

  it("the identity probe sends the key to the HTTPS origin, never to plain HTTP", async () => {
    const httpsSeen: { headers: Record<string, string> }[] = [];
    await resolveEngineIdentity(
      { UKTUB_VERIFY_URL: "https://decision.vllm-sr.ai", UKTUB_VERIFY_API_KEY: KEY },
      "llama-cpp",
      { fetchImpl: models("vllm-sr/d3-mini", 200, httpsSeen) },
    );
    assert.equal(httpsSeen[0]!.headers["authorization"], `Bearer ${KEY}`);
    const httpSeen: { headers: Record<string, string> }[] = [];
    await resolveEngineIdentity(
      { UKTUB_VERIFY_URL: "http://127.0.0.1:8080", UKTUB_VERIFY_API_KEY: KEY },
      "llama-cpp",
      { fetchImpl: models("m.gguf", 200, httpSeen) },
    );
    assert.equal(httpSeen[0]!.headers["authorization"], undefined);
  });
});
