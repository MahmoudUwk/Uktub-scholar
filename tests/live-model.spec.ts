/**
 * Models as harness settings (brief decided 1): Pi `provider/id` strings parsed from CLI flags,
 * replacing the hard-coded MODEL for session setup. The live-acceptance fallback is untouched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatModel, MODEL, parseModelSetting } from "../scripts/live/agent.ts";

describe("parseModelSetting", () => {
  it("parses provider/id", () => {
    assert.deepEqual(parseModelSetting("google-vertex/gemini-3.8-flash"), {
      provider: "google-vertex",
      id: "gemini-3.8-flash",
    });
    assert.deepEqual(parseModelSetting("opencode-go/muse-spark-1.3-contributor"), {
      provider: "opencode-go",
      id: "muse-spark-1.3-contributor",
    });
  });

  it("round-trips through formatModel, and the default is the acceptance model", () => {
    assert.equal(formatModel(parseModelSetting("opencode-go/muse-spark-1.3-contributor")), "opencode-go/muse-spark-1.3-contributor");
    assert.equal(formatModel(MODEL), "google-vertex/gemini-3.8-flash");
  });

  it("rejects anything without provider and id", () => {
    for (const bad of ["", "gemini-3.8-flash", "/gemini-3.8-flash", "google-vertex/", "/"]) {
      assert.throws(() => parseModelSetting(bad), /provider\/id/, JSON.stringify(bad));
    }
  });
});
