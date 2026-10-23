/** The `hosted` verification engine: d3-mini behind the hosted System One endpoint, one key away (now the default; local Eos stays selectable). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createConfiguredEngine, HOSTED_KEY_URL, resolveEngineIdentity, VERIFICATION_ENGINES } from "../src/core/verify/engines.ts";

describe("hosted verification engine", () => {
  it("is a named engine, now the default; local Eos stays selectable", () => {
    assert.ok((VERIFICATION_ENGINES as readonly string[]).includes("hosted"));
    assert.equal(VERIFICATION_ENGINES[0], "eos", "engine order is unchanged");
  });

  it("without a key, refuses with the one-click link to get a free key, and never a silent switch to another engine", () => {
    assert.equal(HOSTED_KEY_URL, "https://decision.vllm-sr.ai/");
    assert.throws(() => createConfiguredEngine({}, "hosted"), (err: Error) => err.message.includes(HOSTED_KEY_URL) && err.message.includes("UKTUB_VERIFY_API_KEY"));
  });

  it("asks the hosted endpoint for d3-mini with the key, and names that model in the judgment identity", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const id = await resolveEngineIdentity({ UKTUB_VERIFY_API_KEY: "k-test" }, "hosted", { fetchImpl });
    assert.deepEqual(id, { model: "hosted:vllm-sr/d3-mini", protocol: "systemone-noul-criteria-v1" });
    assert.equal(seen[0]?.url, "https://decision.vllm-sr.ai/v1/models");
    assert.equal(seen[0]?.auth, "Bearer k-test");
  });
});
