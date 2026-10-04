/**
 * Configured embedder (UKTUB_EMBED_*): which server, which model, which vector space. The identity that keys
 * stored vectors must follow the model actually used, not whatever a multi-model server lists first.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ConfigError } from "../src/core/config.ts";
import { embedderFromEnv } from "../src/core/embed/config.ts";
import { EmbedError } from "../src/core/embed/embedder.ts";

const server = (models: { id: string; meta?: Record<string, unknown> }[] | "down"): typeof fetch =>
  (async (url: string | URL | Request) => {
    const u = String(url);
    if (models === "down") throw new TypeError("fetch failed");
    if (u.endsWith("/v1/models")) return new Response(JSON.stringify({ data: models }));
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

const MODELS = [
  { id: "chat-a", meta: { n_embd: 4096, size: 1, ftype: "Q4" } },
  { id: "/models/embed-b.gguf", meta: { n_embd: 768, size: 333590816, ftype: "Q8_0" } },
];

describe("embedderFromEnv", () => {
  it("no URL means no embedder (keyword search by choice)", async () => {
    assert.equal(await embedderFromEnv({}, server(MODELS)), null);
    assert.equal(await embedderFromEnv({ UKTUB_EMBED_URL: "  " }, server(MODELS)), null);
  });

  it("the identity follows the DECLARED model's entry on a multi-model server, not the first one listed (review finding)", async () => {
    const e = await embedderFromEnv({ UKTUB_EMBED_URL: "http://127.0.0.1:1", UKTUB_EMBED_MODEL: "embed-b.gguf" }, server(MODELS));
    assert.ok(e !== null);
    assert.match(e.id, /768:333590816:Q8_0/, "the declared model's fingerprint");
    assert.ok(!e.id.includes("4096"), "not the chat model's fingerprint");
  });

  it("without a declared model the first entry is the served model; a declared model the server does not list has no fingerprint", async () => {
    const single = await embedderFromEnv({ UKTUB_EMBED_URL: "http://127.0.0.1:1" }, server([MODELS[1]]));
    assert.match(single!.id, /embed-b\.gguf~768:333590816:Q8_0/);
    const unlisted = await embedderFromEnv({ UKTUB_EMBED_URL: "http://127.0.0.1:1", UKTUB_EMBED_MODEL: "something-else" }, server(MODELS));
    assert.ok(!/\d{3,}:/.test(unlisted!.id), `identity ${unlisted!.id} carries no borrowed fingerprint`);
  });

  it("an unreachable server with a declared model is identified by the declaration; without one it cannot be identified", async () => {
    const declared = await embedderFromEnv({ UKTUB_EMBED_URL: "http://127.0.0.1:1", UKTUB_EMBED_MODEL: "m" }, server("down"));
    assert.match(declared!.id, /^m\|/);
    await assert.rejects(embedderFromEnv({ UKTUB_EMBED_URL: "http://127.0.0.1:1" }, server("down")), (e) => e instanceof EmbedError);
  });

  it("an unknown profile is a configuration error", async () => {
    await assert.rejects(embedderFromEnv({ UKTUB_EMBED_URL: "http://127.0.0.1:1", UKTUB_EMBED_PROFILE: "bogus" }, server(MODELS)), (e) => e instanceof ConfigError);
  });
});
