/**
 * Grader key separation (brief decided 2): OPENCODE_API_KEY is never a provider key forwarded to the
 * assistant's sandbox; it travels only to grader sessions and is redacted exactly like provider keys.
 * The values below are made up.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { GRADER_KEY_NAMES, KEY_NAMES, providerKeys } from "../scripts/live/keys.ts";
import { redact, registerSecrets, resetSecrets } from "../scripts/live/redact.ts";

const GRADER = "oc-test-0123456789abcdefghijklmnopqrstuv";
beforeEach(() => {
  resetSecrets();
});

describe("grader key separation", () => {
  it("GRADER_KEY_NAMES holds only OPENCODE_API_KEY, outside KEY_NAMES", () => {
    assert.deepEqual([...GRADER_KEY_NAMES], ["OPENCODE_API_KEY"]);
    assert.ok(!([...KEY_NAMES] as string[]).includes("OPENCODE_API_KEY"));
  });

  it("the provider-key read never picks up the grader key from the same file", () => {
    const dotenv = `OPENALEX_API_KEY=oa-123\nOPENCODE_API_KEY=${GRADER}\n`;
    assert.deepEqual(providerKeys({}, dotenv), { OPENALEX_API_KEY: "oa-123" });
    assert.deepEqual(providerKeys({}, dotenv, GRADER_KEY_NAMES), { OPENCODE_API_KEY: GRADER });
    assert.deepEqual(providerKeys({ OPENCODE_API_KEY: GRADER }, null), {}, "shell alone, provider names only");
    assert.deepEqual(providerKeys({ OPENCODE_API_KEY: GRADER }, null, GRADER_KEY_NAMES), { OPENCODE_API_KEY: GRADER });
  });

  it("the grader key is redacted exactly like a provider key", () => {
    registerSecrets({ OPENCODE_API_KEY: GRADER });
    const out = redact(`env: {"OPENCODE_API_KEY":"${GRADER}"} and again ${GRADER}`);
    assert.ok(!out.includes(GRADER));
    assert.equal((out.match(/\[REDACTED:OPENCODE_API_KEY\]/g) ?? []).length, 2);
  });
});
