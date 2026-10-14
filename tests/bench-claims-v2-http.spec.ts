/**
 * claim-verification-v2: scoring through a System One HTTP server (the author's own Kev server): the question the model is asked, the
 * engine that posts it, and the wait for a server to come up. A fake local server stands in for the model. Offline.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { criteriaQuestion, httpEngine, waitForServer } from "../scripts/bench-claims-v2-http.ts";

const CLAIM = "The model was trained for ten epochs.";

describe("the question asked of a System One server", () => {
  it("with the criteria wording is the same question the Decision 2.0, Decision 3.0 and Intern workers pose", () => {
    assert.deepEqual(criteriaQuestion(CLAIM, "criteria"), {
      type: "noul",
      instructions: `Claim under test: "${CLAIM}" Decide whether the state passage explicitly supports this claim. Answer true only if the passage itself states or directly entails the claim; answer false when the passage contradicts it or says nothing about it.`,
      criteria: { false: "The passage contradicts the claim or says nothing about it.", true: "The passage explicitly states or directly entails the claim." },
    });
  });
  it("with the native wording is the claim alone, as the product's own System One engine sends it", () => {
    assert.deepEqual(criteriaQuestion(CLAIM, "native"), { type: "noul", instructions: CLAIM });
  });
});

describe("the engine that posts it", () => {
  const seen: { url: string; body: Record<string, any> }[] = [];
  let respond: (n: number) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
  const server: Server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: raw === "" ? {} : JSON.parse(raw) });
      const r = respond(seen.length);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  const ready = new Promise<string>((ok) => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  after(() => server.close());

  it("posts one noul question per row to /v1/systemone and returns the probabilities in order", async () => {
    const url = await ready;
    seen.length = 0;
    respond = (n) => ({ status: 200, body: { answers: { c: { type: "noul", noul: n === 1 ? 0.25 : 0.75 } } } });
    const p = await httpEngine(url, "criteria").run([{ state: "passage one", instructions: CLAIM }, { state: "passage two", instructions: CLAIM }]);
    assert.deepEqual(p, [0.25, 0.75]);
    assert.equal(seen[0]!.url, "/v1/systemone");
    assert.equal(seen[0]!.body.state, "passage one");
    assert.deepEqual(seen[0]!.body.questions.c, criteriaQuestion(CLAIM, "criteria"));
  });
  it("fails the call, never reads a score, when the server answers an error or no probability", async () => {
    const url = await ready;
    respond = () => ({ status: 422, body: { error: "state over the limit" } });
    await assert.rejects(httpEngine(url, "criteria").run([{ state: "x", instructions: CLAIM }]), /422/);
    respond = () => ({ status: 200, body: { answers: {} } });
    await assert.rejects(httpEngine(url, "criteria").run([{ state: "x", instructions: CLAIM }]), /noul/);
  });
});

describe("waiting for a server to come up", () => {
  it("resolves once /v1/models answers, after a few refused polls", async () => {
    let hits = 0;
    const server = createServer((_req, res) => { hits += 1; res.writeHead(hits < 3 ? 503 : 200); res.end("{}"); });
    const url = await new Promise<string>((ok) => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
    try {
      await waitForServer(url, { timeoutMs: 5000, intervalMs: 20 });
      assert.ok(hits >= 3);
    } finally {
      server.close();
    }
  });
  it("gives up with a message that names the address when the server never answers", async () => {
    await assert.rejects(waitForServer("http://127.0.0.1:9", { timeoutMs: 200, intervalMs: 20 }), /127\.0\.0\.1:9/);
  });
});
