/**
 * System One question wording: the product's System One engines and the
 * claim-verification-v2 benchmark ask the same `noul` question — the Decision
 * 2.0 criteria wording — so benchmark numbers describe the product path.
 * A change here must bump the protocol identity (a new way of posing rows
 * must never reuse old scores).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { criteriaQuestion } from "../src/core/verify/wording.ts";
import { openrouterDecisionsEngine, systemoneEndpointEngine } from "../src/core/verify/claim.ts";
import { SYSTEMONE_PROTOCOL } from "../src/core/verify/engines.ts";
import { httpEngine } from "../scripts/bench-claims-v2-http.ts";

const stub = (seen: { body: Record<string, unknown> }[]) =>
  (async (_url: string, init?: RequestInit) => {
    seen.push({ body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ answers: { c: { noul: 0.5 } }, model: "vllm-sr/d3-mini" }), { status: 200 });
  }) as unknown as typeof fetch;

describe("system one criteria wording", () => {
  it("the shared question carries the criteria wording with true/false criteria", () => {
    assert.deepEqual(criteriaQuestion("the sky is green", "criteria"), {
      type: "noul",
      instructions: `Claim under test: "the sky is green" Decide whether the state passage explicitly supports this claim. Answer true only if the passage itself states or directly entails the claim; answer false when the passage contradicts it or says nothing about it.`,
      criteria: {
        false: "The passage contradicts the claim or says nothing about it.",
        true: "The passage explicitly states or directly entails the claim.",
      },
    });
  });

  it("the product endpoint engine posts the criteria question, not the bare claim", async () => {
    const seen: { body: Record<string, unknown> }[] = [];
    const engine = systemoneEndpointEngine({
      url: "https://decision.vllm-sr.ai/v1/systemone",
      label: "hosted",
      apiKey: "k-test",
      model: "vllm-sr/d3-mini",
      fetchImpl: stub(seen),
    });
    await engine.run([{ state: "passage", instructions: "the sky is green" }]);
    const questions = (seen[0]!.body as { questions: Record<string, unknown> }).questions;
    assert.deepEqual(questions, { c: criteriaQuestion("the sky is green", "criteria") });
  });

  it("the openrouter engine posts the criteria question, not the bare claim", async () => {
    const seen: { body: Record<string, unknown> }[] = [];
    const engine = openrouterDecisionsEngine({ env: { OPENROUTER_API_KEY: "k-test" }, fetchImpl: stub(seen), model: "m" });
    await engine.run([{ state: "passage", instructions: "the sky is green" }]);
    const questions = (seen[0]!.body as { questions: Record<string, unknown> }).questions;
    assert.deepEqual(questions, { c: criteriaQuestion("the sky is green", "criteria") });
  });

  it("bench client and product engine build identical question objects", async () => {
    const benchSeen: { body: Record<string, unknown> }[] = [];
    const productSeen: { body: Record<string, unknown> }[] = [];
    const bench = httpEngine("https://decision.vllm-sr.ai", "criteria", stub(benchSeen), { model: "vllm-sr/d3-mini", headers: { authorization: "Bearer k" } });
    const product = systemoneEndpointEngine({
      url: "https://decision.vllm-sr.ai/v1/systemone",
      label: "hosted",
      apiKey: "k",
      model: "vllm-sr/d3-mini",
      fetchImpl: stub(productSeen),
    });
    await bench.run([{ state: "passage", instructions: "the sky is green" }]);
    await product.run([{ state: "passage", instructions: "the sky is green" }]);
    assert.deepEqual(
      (productSeen[0]!.body as { questions: unknown }).questions,
      (benchSeen[0]!.body as { questions: unknown }).questions,
    );
  });

  it("the protocol identity names the criteria wording", () => {
    assert.equal(SYSTEMONE_PROTOCOL, "systemone-noul-criteria-v1");
  });
});
