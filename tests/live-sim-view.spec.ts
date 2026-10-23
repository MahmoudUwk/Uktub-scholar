/**
 * The reviewer's channel. Measured in iterations 4, 6 and 7 of the workflow experiment: the simulated user saw the first 6,000
 * characters of the manuscript (49 to 66 percent of it; in iteration 7 only one of two tables, and none of the invented hardware
 * column), had no tools, and was asked to judge whether claims were grounded in papers it could not see. These tests pin an
 * observation channel that is exact, stated to the reviewer as it is, and complete enough to do the job it is given.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ARMS, activityDigest, armSpec, channelText, fullView, legacyView, parseSimulatorReply, type ViewPolicy } from "../scripts/live/sim-view.ts";

const POLICY: ViewPolicy = { legacyChars: 6000, fullManuscriptChars: 60000, evidenceTableChars: 8000 };

describe("arms", () => {
  it("A is the current system; B1 adds only the reviewer's visibility; B2 adds the in-loop provenance view for the assistant", () => {
    assert.deepEqual(ARMS, ["A", "B1", "B2", "sections", "no-gate"]);
    assert.deepEqual(armSpec("A"), { arm: "A", agentProvenance: false, reviewerView: "legacy" });
    assert.deepEqual(armSpec("B1"), { arm: "B1", agentProvenance: false, reviewerView: "full" });
    assert.deepEqual(armSpec("B2"), { arm: "B2", agentProvenance: true, reviewerView: "full" });
    assert.deepEqual(armSpec("sections"), { arm: "sections", agentProvenance: false, reviewerView: "full" });
    assert.deepEqual(armSpec("no-gate"), { arm: "no-gate", agentProvenance: true, reviewerView: "legacy" });
    assert.throws(() => armSpec("C"), /unknown arm/i);
  });
});

describe("channelText", () => {
  it("states exactly what the legacy channel holds and what it does not, including that sourcing cannot be verified", () => {
    const t = channelText(armSpec("A"), POLICY);
    assert.match(t, /first 6,000 characters/);
    assert.match(t, /do NOT receive/i);
    assert.match(t, /evidence\/claims\.json/);
    assert.match(t, /cannot verify/i);
    assert.ok(!/Provenance view/.test(t));
  });
  it("states the full channel: whole manuscript, the evidence table as the assistant's own claim, the activity digest, the provenance view", () => {
    for (const arm of ["B1", "B2", "sections"] as const) {
      const t = channelText(armSpec(arm), POLICY);
      assert.match(t, /FULL text of every \.tex file/);
      assert.match(t, /assistant's own account/i);
      assert.match(t, /activity digest/i);
      assert.match(t, /Provenance view/);
      assert.match(t, /not written by the assistant/i);
      assert.ok(!/first 6,000 characters/.test(t));
    }
    assert.equal(channelText(armSpec("B1"), POLICY), channelText(armSpec("B2"), POLICY), "the reviewer cannot tell B1 from B2");
  });
});

describe("activityDigest", () => {
  const call = (name: string, args: any = {}) => ({ name, args });
  it("counts tool calls and says how many manuscript edits came after the last evidence lookup", () => {
    const d = activityDigest([
      call("mcp__uktub__passages"), call("mcp__uktub__verify"), call("write", { path: "manuscript/main.tex" }),
      call("edit", { path: "manuscript/main.tex" }), call("mcp__uktub__compile"), call("bash", { command: "ls" }),
    ]);
    assert.match(d, /passages ×1/);
    assert.match(d, /verify ×1/);
    assert.match(d, /compile ×1/);
    assert.match(d, /Evidence lookups \(passages \+ verify\): 2\./);
    assert.match(d, /Manuscript edits: 2 \(2 after the last evidence lookup\)\./);
  });
  it("shows a revision with no lookup at all as 14 edits after zero lookups (iteration 7, turn 2)", () => {
    const d = activityDigest([...Array(14)].map(() => call("edit", { path: "manuscript/main.tex" })));
    assert.match(d, /Evidence lookups \(passages \+ verify\): 0\./);
    assert.match(d, /Manuscript edits: 14 \(14 after the last evidence lookup\)\./);
  });
  it("names registry actions and handles a reply with no tool calls", () => {
    assert.match(activityDigest([call("mcp__uktub__registry", { action: "register" })]), /registry:register ×1/);
    assert.equal(activityDigest([]), "No tool calls in this reply.");
  });
});

describe("views", () => {
  const files = ["manuscript/main.tex (9000 bytes)", "evidence/claims.json (500 bytes)"];
  const tex = [{ path: "manuscript/main.tex", text: "A".repeat(7000) }];
  it("the legacy view is the one the experiments used: 6,000 characters, and 'unchanged' when nothing changed", () => {
    const first = legacyView({ files, tex, lastBody: "", limit: 6000 });
    assert.match(first.text, /^\[Project folder view\]\nFiles:\n- manuscript\/main\.tex \(9000 bytes\)/);
    assert.match(first.text, /Manuscript text now:\n--- manuscript\/main\.tex ---\nA+$/);
    assert.equal(first.text.split("Manuscript text now:\n")[1]!.length, 6000);
    assert.match(legacyView({ files, tex, lastBody: first.body, limit: 6000 }).text, /\(manuscript unchanged since your last view\)/);
    assert.match(legacyView({ files: [], tex: [], lastBody: "", limit: 6000 }).text, /\(empty\)[\s\S]*\(no LaTeX manuscript yet\)/);
  });
  it("the full view carries the whole manuscript, the evidence table, the activity digest and the provenance view, in that order", () => {
    const v = fullView({ files, tex, evidenceTable: '[{"claim":"x"}]', activity: "Tool calls in this reply: edit ×1.", provenance: "# Provenance view\nOPEN ...", provenanceNote: "" }, POLICY);
    const order = ["[Project folder view]", "[Manuscript: full text]", "[Evidence table", "[What the assistant did in its last reply]", "[Provenance view"].map((h) => v.indexOf(h));
    assert.ok(order.every((n) => n >= 0) && [...order].sort((a, b) => a - b).join() === order.join(), `sections in order: ${order}`);
    assert.ok(v.includes("A".repeat(7000)), "no cut at 6,000");
    assert.match(v, /OPEN \.\.\./);
  });
  it("says what is missing instead of omitting it: no evidence table yet, provenance unavailable, manuscript over the budget", () => {
    const v = fullView({ files, tex: [{ path: "m.tex", text: "B".repeat(70000) }], evidenceTable: null, activity: "No tool calls in this reply.", provenance: null, provenanceNote: "no usable registry" }, POLICY);
    assert.match(v, /manuscript truncated at 60000 of 70014 characters/i, "the total counts the file header line as shown");
    assert.match(v, /evidence\/claims\.json is not present/);
    assert.match(v, /unavailable: no usable registry/);
  });
});

describe("parseSimulatorReply", () => {
  it("reads status, review, message and note", () => {
    const r = parseSimulatorReply("<status>continue</status>\n<review>\n- [row L76] A100 not in DoRA: push back\n</review>\n<message>Please fix Table 2.</message>\n<note>blind spot: none</note>");
    assert.deepEqual(r, { status: "continue", message: "Please fix Table 2.", review: "- [row L76] A100 not in DoRA: push back", note: "blind spot: none" });
  });
  it("tolerates a missing review and an invalid status", () => {
    const r = parseSimulatorReply("<status>maybe</status><message>hi</message>");
    assert.equal(r.status, "");
    assert.equal(r.review, "");
    assert.equal(r.message, "hi");
  });
});
