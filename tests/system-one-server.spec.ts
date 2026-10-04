/**
 * Local System One endpoint (scripts/system-one-server.ts): lets any scorer —
 * e.g. a local Decision 2.0 worker — sit behind the package's existing
 * `llama-cpp` engine path. The protocol is exactly what the engine adapter
 * speaks: POST /v1/systemone → answers.c.noul, GET /v1/models → served id.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { serveSystemOne, type Scorer } from "../scripts/system-one-server.ts";
import { resolveEngineIdentity, createConfiguredEngine } from "../src/core/verify/engines.ts";

const seen: { state: string; instructions: string }[] = [];
const scorer: Scorer = {
  identity: async () => "decision2-eos@3594047d",
  score: async (row) => {
    seen.push(row);
    if (row.state.includes("TOO LONG")) return { p: null, refused: true, error: null };
    if (row.state.includes("BOOM")) return { p: null, refused: false, error: "worker died" };
    return { p: row.state.includes("support") ? 0.995 : 0.1, refused: false, error: null };
  },
};

let server: Server;
let base: string;
before(async () => {
  server = await serveSystemOne(scorer, 0, "127.0.0.1");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const post = (body: unknown) => fetch(`${base}/v1/systemone`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("system one server", () => {
  it("answers the noul question the engine adapter asks", async () => {
    const res = await post({ state: "this passage will support it", questions: { c: { type: "noul", instructions: "The claim." } } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { answers: { c: { noul: 0.995 } } });
    assert.deepEqual(seen.at(-1), { state: "this passage will support it", instructions: "The claim." });
  });

  it("reports the served model on /v1/models (the judgment identity)", async () => {
    const res = await fetch(`${base}/v1/models`);
    assert.deepEqual(await res.json(), { object: "list", data: [{ id: "decision2-eos@3594047d", object: "model" }] });
  });

  it("refuses over-limit inputs with HTTP 413, never as a low score", async () => {
    assert.equal((await post({ state: "TOO LONG", questions: { c: { type: "noul", instructions: "x" } } })).status, 413);
  });

  it("maps scorer failures to 500 and malformed requests to 400/404/405", async () => {
    assert.equal((await post({ state: "BOOM", questions: { c: { type: "noul", instructions: "x" } } })).status, 500);
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post({ state: "s", questions: { c: { type: "other", instructions: "x" } } })).status, 400);
    assert.equal((await post({ questions: {} })).status, 400);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/v1/systemone`)).status, 405);
  });

  it("works through the package's real llama-cpp engine adapter, identity probe included", async () => {
    const env = { UKTUB_VERIFY_URL: base };
    const identity = await resolveEngineIdentity(env, "llama-cpp");
    assert.equal(identity?.model, "llama-cpp:decision2-eos@3594047d");
    const engine = createConfiguredEngine(env, "llama-cpp");
    assert.deepEqual(await engine.run([{ state: "a passage that will support it", instructions: "claim" }, { state: "unrelated", instructions: "claim" }]), [0.995, 0.1]);
  });
});
