/**
 * Effective model identity (KTD8): a judgment may be reused only under an
 * identity that names the model actually answering. A URL is not an identity;
 * where the endpoint cannot say what it serves, reuse is disabled (null).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveEngineIdentity } from "../src/core/verify/engines.ts";

const models = (id: string | null, status = 200) =>
  (async () => (id === null ? new Response("nope", { status }) : new Response(JSON.stringify({ data: [{ id }] }), { status }))) as unknown as typeof fetch;

describe("resolveEngineIdentity", () => {
  it("hosted OpenRouter: the model slug is the identity", async () => {
    assert.deepEqual(await resolveEngineIdentity({ UKTUB_OPENROUTER_MODEL: "inception/mercury-decide:free" }, "openrouter"), { model: "openrouter:inception/mercury-decide:free", protocol: "systemone-noul-v1" });
    assert.match((await resolveEngineIdentity({}, "openrouter"))!.model, /^openrouter:/, "default model is named too");
  });

  it("llama.cpp: asks the server what it serves, so replacing the model behind one URL changes the identity", async () => {
    const env = { UKTUB_VERIFY_URL: "http://127.0.0.1:8080" };
    const a = await resolveEngineIdentity(env, "llama-cpp", { fetchImpl: models("julia-q4.gguf") });
    const b = await resolveEngineIdentity(env, "llama-cpp", { fetchImpl: models("other-model.gguf") });
    assert.equal(a!.model, "llama-cpp:julia-q4.gguf");
    assert.notEqual(a!.model, b!.model);
    assert.ok(!a!.model.includes("8080"), "the URL is not the identity");
  });

  it("an endpoint that cannot report its model has no identity (reuse disabled), unless the user declares one", async () => {
    const env = { UKTUB_VERIFY_URL: "http://127.0.0.1:8080" };
    assert.equal(await resolveEngineIdentity(env, "llama-cpp", { fetchImpl: models(null, 404) }), null);
    assert.equal(await resolveEngineIdentity(env, "llama-cpp", { fetchImpl: (async () => { throw new Error("down"); }) as typeof fetch }), null);
    assert.equal(await resolveEngineIdentity({}, "k2", { fetchImpl: models(null, 404) }), null);
    assert.equal((await resolveEngineIdentity({ UKTUB_VERIFY_MODEL_ID: "my-weights-v3" }, "k2", { fetchImpl: models(null, 404) }))!.model, "declared:my-weights-v3");
  });

  it("local Python engines: the configured model reference, fingerprinted when it is a path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uktub-weights-"));
    try {
      const weights = join(dir, "model.safetensors");
      writeFileSync(weights, "v1");
      utimesSync(weights, 1_700_000_000, 1_700_000_000);
      const a = await resolveEngineIdentity({ UKTUB_JULIA_MODEL: weights }, "julia");
      writeFileSync(weights, "version-two");
      utimesSync(weights, 1_800_000_000, 1_800_000_000);
      const b = await resolveEngineIdentity({ UKTUB_JULIA_MODEL: weights }, "julia");
      assert.ok(a!.model.startsWith("julia:") && a!.model !== b!.model, "replacing weights at the same path changes the identity");
      assert.equal((await resolveEngineIdentity({}, "julia"))!.model, "julia:SupersonicLabs/Julia-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("eos: the pinned checkpoint revision is the identity; a different revision or replaced local weights is a different model", async () => {
    const a = await resolveEngineIdentity({}, "eos");
    assert.deepEqual(a, { model: "eos:vllm-sr/Decision-2.0-Eos-0.8B@3594047d69f4", protocol: "decision2-noul-v1" });
    const b = await resolveEngineIdentity({ UKTUB_EOS_REVISION: "f".repeat(40) }, "eos");
    assert.notEqual(a!.model, b!.model);
    const dir = mkdtempSync(join(tmpdir(), "uktub-eos-"));
    try {
      writeFileSync(join(dir, "model.safetensors"), "v1");
      utimesSync(join(dir, "model.safetensors"), 1_700_000_000, 1_700_000_000);
      const c = await resolveEngineIdentity({ UKTUB_EOS_MODEL: dir }, "eos");
      writeFileSync(join(dir, "model.safetensors"), "version-two");
      utimesSync(join(dir, "model.safetensors"), 1_800_000_000, 1_800_000_000);
      const d = await resolveEngineIdentity({ UKTUB_EOS_MODEL: dir }, "eos");
      assert.notEqual(c!.model, d!.model, "replacing weights in place changes the identity");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an unknown engine name", async () => {
    await assert.rejects(resolveEngineIdentity({}, "mystery"), /unknown verification engine/);
  });
});

describe("resident engines are shared per process", () => {
  it("the same configuration reuses one worker (no model reload per call); another configuration gets its own", async () => {
    const { createConfiguredEngine } = await import("../src/core/verify/engines.ts");
    const a = createConfiguredEngine({}, "eos");
    assert.equal(createConfiguredEngine({}, "eos"), a);
    assert.notEqual(createConfiguredEngine({ UKTUB_EOS_REVISION: "other" }, "eos"), a);
    assert.notEqual(createConfiguredEngine({}, "k2"), createConfiguredEngine({}, "k2"), "stateless HTTP engines are cheap and not cached");
  });
});
