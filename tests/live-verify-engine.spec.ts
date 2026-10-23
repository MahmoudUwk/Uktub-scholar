/**
 * Harness verify-engine flag and assistant key forwarding: `pnpm experiment
 * <scenario> --verify-engine hosted` maps to the assistant sandbox env, the
 * host verify key is renamed for the sandbox, and an opencode-go assistant
 * gets OPENCODE_API_KEY. Pure mapping only; the runners own I/O.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assistantSecretsForProvider, mergeAssistantSecrets, usesHostedEngine, verifyEngineEnv } from "../scripts/live/env.ts";
import { parseDotenv, VERIFY_API_KEY_ENV, VERIFY_KEY_NAMES, verifySecrets } from "../scripts/live/keys.ts";

describe("parseDotenv with the mixed-case verify key", () => {
  it("reads VLLM_decision_API (names still filter everything else)", () => {
    assert.deepEqual(parseDotenv("VLLM_decision_API=vk-1\nOTHER=x", VERIFY_KEY_NAMES), { VLLM_decision_API: "vk-1" });
  });
});

describe("verifySecrets", () => {
  it("renames the host verify key for the sandbox; the shell wins; empty means no secret", () => {
    assert.deepEqual(verifySecrets({ VLLM_decision_API: "k-file" }), { [VERIFY_API_KEY_ENV]: "k-file" });
    assert.equal(VERIFY_API_KEY_ENV, "UKTUB_VERIFY_API_KEY");
    assert.deepEqual(verifySecrets({}), {});
  });

  it("reads only its own names", () => {
    assert.deepEqual([...VERIFY_KEY_NAMES], ["VLLM_decision_API"]);
  });
});

describe("verifyEngineUnits (W7 enabler)", () => {
  it("hosted-units names the hosted engine on the whole-section unit path (a harness arg, not a product knob)", () => {
    assert.deepEqual(verifyEngineEnv("hosted-units"), { UKTUB_VERIFY_ENGINE: "hosted", UKTUB_VERIFY_STRATEGY: "units" });
    assert.throws(() => verifyEngineEnv("units"), /eos\|hosted\|hosted-units/);
  });

  it("every hosted variant needs the hosted key forwarded; eos does not", () => {
    assert.equal(usesHostedEngine("hosted"), true);
    assert.equal(usesHostedEngine("hosted-units"), true);
    assert.equal(usesHostedEngine("eos"), false);
  });
});

describe("verifyEngineEnv", () => {
  it("eos is the default and sets nothing", () => {
    assert.deepEqual(verifyEngineEnv("eos"), {});
  });

  it("hosted selects the product's own hosted engine (d3-mini): the run uses exactly what a user gets", () => {
    assert.deepEqual(verifyEngineEnv("hosted"), { UKTUB_VERIFY_ENGINE: "hosted" });
  });

  it("rejects anything else (never a guess)", () => {
    assert.throws(() => verifyEngineEnv("mercury"), /--verify-engine must be eos\|hosted/);
  });
});

describe("assistantSecretsForProvider", () => {
  const lookup = (env: Record<string, string>) => (name: string): string | undefined => env[name];

  it("forwards OPENCODE_API_KEY to an opencode-go assistant sandbox, and nothing for Vertex", () => {
    assert.deepEqual(assistantSecretsForProvider("opencode-go", lookup({ OPENCODE_API_KEY: "ok-1" })), { OPENCODE_API_KEY: "ok-1" });
    assert.deepEqual(assistantSecretsForProvider("google-vertex", lookup({ OPENCODE_API_KEY: "ok-1" })), {});
  });

  it("a missing key for opencode-go is a clear error, never a silent keyless run", () => {
    assert.throws(() => assistantSecretsForProvider("opencode-go", lookup({})), /no OPENCODE_API_KEY/);
  });
});

describe("mergeAssistantSecrets", () => {
  it("assistant secrets ride with the sandbox secrets; an explicit per-session value wins", () => {
    const base = { SEMANTIC_SCHOLAR_API_KEY: "s2" };
    assert.deepEqual(mergeAssistantSecrets(base, { UKTUB_VERIFY_API_KEY: "vk" }), {
      SEMANTIC_SCHOLAR_API_KEY: "s2",
      UKTUB_VERIFY_API_KEY: "vk",
    });
    assert.deepEqual(mergeAssistantSecrets(base, {}), base);
  });
});
