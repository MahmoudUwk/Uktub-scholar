/**
 * Claim verification spec: verdict mapping at the owner's confidence bar,
 * batch-over-resident-engine, and the refusal shape — all offline with a fake
 * engine. The Julia-1 engine adapter is exercised live only when the model is
 * installed (env-gated at the bottom; measured REJECTED for scientific
 * verdicts — see docs/DECISIONS.md).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MIN_CONFIDENCE,
  EngineError,
  juliaEngine,
  mapVerdict,
  minConfidenceFromEnv,
  verifyClaim,
  verifyClaims,
  type ClaimEngine,
} from "../src/core/verify/claim.ts";

/** Deterministic fake: P(true) from the claim text (0.995 = entailed). */
function fakeEngine(pTrue: number): ClaimEngine {
  return { run: async (rows) => rows.map(() => pTrue) };
}

describe("verdict mapping", () => {
  it("owner bar: supported only at or above 0.99; refuted at or below 0.01; else unverified", () => {
    assert.deepEqual(mapVerdict(0.995, DEFAULT_MIN_CONFIDENCE), { verdict: "supported", confidence: 0.995 });
    assert.deepEqual(mapVerdict(0.004, DEFAULT_MIN_CONFIDENCE), { verdict: "refuted", confidence: 0.996 });
    assert.deepEqual(mapVerdict(0.53, DEFAULT_MIN_CONFIDENCE), { verdict: "unverified", confidence: 0.53 });
  });

  it("threshold env: valid override wins; junk or out-of-range falls back to 0.99", () => {
    assert.equal(minConfidenceFromEnv({ UKTUB_VERIFY_MIN_CONFIDENCE: "0.9" }), 0.9);
    assert.equal(minConfidenceFromEnv({ UKTUB_VERIFY_MIN_CONFIDENCE: "0.2" }), DEFAULT_MIN_CONFIDENCE);
    assert.equal(minConfidenceFromEnv({ UKTUB_VERIFY_MIN_CONFIDENCE: "abc" }), DEFAULT_MIN_CONFIDENCE);
    assert.equal(minConfidenceFromEnv({}), DEFAULT_MIN_CONFIDENCE);
  });
});

describe("verifyClaim / verifyClaims", () => {
  it("single claim: one engine row in, one mapped verdict out", async () => {
    const seen: unknown[] = [];
    const engine: ClaimEngine = {
      run: async (rows) => {
        seen.push(...rows);
        return rows.map(() => 0.999);
      },
    };
    const v = await verifyClaim(engine, { chunk: "The tower is in Paris.", claim: "The tower is in Paris." }, 0.99);
    assert.deepEqual(v, { verdict: "supported", confidence: 0.999 });
    assert.deepEqual(seen, [{ state: "The tower is in Paris.", instructions: "The tower is in Paris." }]);
  });

  it("batch: N pairs cross ONE engine call (resident process, model loads once)", async () => {
    let calls = 0;
    const engine: ClaimEngine = {
      run: async (rows) => {
        calls++;
        return rows.map((_, i) => 0.001 + i / 100);
      },
    };
    const verdicts = await verifyClaims(
      engine,
      [
        { chunk: "a", claim: "a" },
        { chunk: "b", claim: "b" },
        { chunk: "c", claim: "c" },
      ],
      0.99,
    );
    assert.equal(calls, 1);
    assert.deepEqual(verdicts.map((v) => v.verdict), ["refuted", "unverified", "unverified"]);
  });

  it("empty batch: no engine call", async () => {
    let calls = 0;
    const engine: ClaimEngine = { run: async (r) => { calls++; return r.map(() => 0.5); } };
    assert.deepEqual(await verifyClaims(engine, [], 0.99), []);
    assert.equal(calls, 0);
  });

  it("engine failure surfaces as EngineError for the refusal mapping", async () => {
    const engine: ClaimEngine = { run: async () => { throw new EngineError("engine not startable"); } };
    await assert.rejects(verifyClaim(engine, { chunk: "c", claim: "k" }, 0.99), EngineError);
  });
});

describe("julia engine adapter (real model, env-gated)", () => {
  const python = process.env.UKTUB_JULIA_PYTHON ?? "";
  const hasEngine = python !== "";
  it("answers rows through the resident process", { skip: !hasEngine }, async () => {
    const engine = juliaEngine({ env: { ...process.env, UKTUB_JULIA_MODEL: process.env.UKTUB_JULIA_MODEL ?? "SupersonicLabs/Julia-1" }, pythonBin: python });
    const p = await engine.run([
      { state: "The Eiffel Tower is located in Paris, France.", instructions: "The Eiffel Tower is located in Paris." },
    ]);
    assert.equal(p.length, 1);
    assert.ok(p[0] >= 0 && p[0] <= 1);
  });
});
