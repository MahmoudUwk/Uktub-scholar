/**
 * Phase 0: hosted (and llama-cpp) identity over a multi-model listing.
 * Fixture mirrors live GET https://decision.vllm-sr.ai/v1/models (2026-10-23).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HOSTED_MODEL, resolveEngineIdentity } from "../src/core/verify/engines.ts";

const LISTING = ["vllm-sr/d3-turbo", "vllm-sr/d3", "vllm-sr/d3-flash", "vllm-sr/d3-mini", "vllm-sr/d3-nano", "vllm-sr/d3-lite", "vllm-sr/d3-edge"];

const listing = (ids: string[], status = 200) =>
  (async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status })) as unknown as typeof fetch;

const failing = (async () => {
  throw new Error("down");
}) as unknown as typeof fetch;

describe("phase 0: multi-model identity", () => {
  it("a hosted: the configured d3-mini is the identity when listed non-first", async () => {
    const id = await resolveEngineIdentity({ UKTUB_VERIFY_API_KEY: "k" }, "hosted", { fetchImpl: listing(LISTING) });
    assert.deepEqual(id, { model: `hosted:${HOSTED_MODEL}`, protocol: "systemone-noul-criteria-v2" });
    assert.equal(id!.model, "hosted:vllm-sr/d3-mini");
  });

  it("b hosted: a listing without the model is no identity", async () => {
    assert.equal(await resolveEngineIdentity({ UKTUB_VERIFY_API_KEY: "k" }, "hosted", { fetchImpl: listing(["vllm-sr/d3-turbo"]) }), null);
  });

  it("c llama-cpp with a configured model uses it when listed", async () => {
    const id = await resolveEngineIdentity(
      { UKTUB_VERIFY_URL: "https://decision.vllm-sr.ai", UKTUB_VERIFY_MODEL: "vllm-sr/d3-mini" },
      "llama-cpp",
      { fetchImpl: listing(["vllm-sr/d3-turbo", "vllm-sr/d3-mini"]) },
    );
    assert.deepEqual(id, { model: "llama-cpp:vllm-sr/d3-mini", protocol: "systemone-noul-criteria-v2" });
  });

  it("d llama-cpp with a configured model absent from the listing is no identity", async () => {
    assert.equal(
      await resolveEngineIdentity(
        { UKTUB_VERIFY_URL: "https://decision.vllm-sr.ai", UKTUB_VERIFY_MODEL: "vllm-sr/d3-mini" },
        "llama-cpp",
        { fetchImpl: listing(["vllm-sr/d3-turbo"]) },
      ),
      null,
    );
  });

  it("e pin: hosted without a listing (404 or throw) keeps the d3-mini stand-in", async () => {
    for (const fetchImpl of [(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch, failing]) {
      assert.deepEqual(await resolveEngineIdentity({ UKTUB_VERIFY_API_KEY: "k" }, "hosted", { fetchImpl }), {
        model: "hosted:vllm-sr/d3-mini",
        protocol: "systemone-noul-criteria-v2",
      });
    }
  });

  it("f pin: llama-cpp without a configured model keeps listing[0]", async () => {
    assert.deepEqual(
      await resolveEngineIdentity({ UKTUB_VERIFY_URL: "http://127.0.0.1:8080" }, "llama-cpp", { fetchImpl: listing(["m.gguf", "other.gguf"]) }),
      { model: "llama-cpp:m.gguf", protocol: "systemone-noul-criteria-v2" },
    );
  });
});
