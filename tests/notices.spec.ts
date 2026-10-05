import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractNotices, footerFor } from "../src/core/notices.ts";
import uktubScholarExtension from "../src/pi/index.ts";

const REFUSED = `Refused: VERIFY_ENGINE_MISSING — eos engine failed to load: {"error": "decision2 model failed to load: ModuleNotFoundError: No module named 'torch'"}. Next: tell the user the verification engine is not available and how to enable it: the default eos engine needs a Python environment.`;
const SEARCH = `5 candidates for "x" (truncated to the requested 5) — 1 provider warning\nwarning: semantic-scholar — PROVIDER_FAILED: semantic-scholar: HTTP 429 (GET failed); results exclude semantic-scholar\n1. 10.1/a — A (2024)`;
const COMPILE = `Compiled manuscript/main.tex with tectonic 0.15.0 → build/main.pdf (17235 bytes). 0 error(s), 2 warning(s).\n- warning: internal consistency problem when checking if main.bbl changed\n- warning: TeX rerun seems needed, but stopping at 6 passes`;

describe("extractNotices", () => {
  it("a refusal becomes one notice keyed by its code", () => {
    const n = extractNotices("verify_claim", REFUSED, true);
    assert.equal(n.length, 1);
    assert.equal(n[0]?.key, "VERIFY_ENGINE_MISSING");
    assert.match(n[0]?.line ?? "", /verify_claim was refused \(VERIFY_ENGINE_MISSING\)/);
    assert.ok((n[0]?.line.length ?? 0) < 400, "short enough for a footer");
  });

  it("a search warning is keyed by the provider that failed", () => {
    const n = extractNotices("search_papers", SEARCH, false);
    assert.deepEqual(n.map((x) => x.key), ["semantic-scholar"]);
    assert.match(n[0]?.line ?? "", /semantic-scholar.*HTTP 429/);
  });

  it("each compile warning is a notice", () => {
    const n = extractNotices("compile_document", COMPILE, false);
    assert.equal(n.length, 2);
    assert.match(n[0]?.line ?? "", /main\.bbl/);
  });

  it("a clean result has none", () => {
    assert.deepEqual(extractNotices("paper_registry", "4 papers selected (whole registry); showing 4", false), []);
    assert.deepEqual(extractNotices("compile_document", "Compiled manuscript/main.tex with tectonic 0.17.0 → build/main.pdf (1 bytes). 0 error(s), 0 warning(s).", false), []);
  });
});

describe("footerFor", () => {
  const notices = extractNotices("verify_claim", REFUSED, true).concat(extractNotices("search_papers", SEARCH, false));

  it("lists only what the answer does not already mention", () => {
    const f = footerFor("verify_claim failed with VERIFY_ENGINE_MISSING, so the claim is unverified.", notices);
    assert.ok(f !== null);
    assert.doesNotMatch(f, /VERIFY_ENGINE_MISSING/);
    assert.match(f, /semantic-scholar/);
  });

  it("is null when the answer covers everything", () => {
    assert.equal(footerFor("VERIFY_ENGINE_MISSING happened and semantic-scholar was rate limited.", notices), null);
  });

  it("matches case-insensitively and is null for no notices", () => {
    assert.equal(footerFor("the Semantic-Scholar provider answered 429; verify_claim_engine_missing", extractNotices("search_papers", SEARCH, false)), null);
    assert.equal(footerFor("anything", []), null);
  });

  it("states plainly that the notices come from the tools", () => {
    assert.match(footerFor("done", notices) ?? "", /not mentioned|tool/i);
  });
});

describe("the Pi extension appends unmentioned notices to the final answer only", () => {
  type H = (e: never, ctx?: never) => unknown;
  const wire = () => {
    const h: Record<string, H> = {};
    uktubScholarExtension({ registerMcpServer: () => {}, on: (ev: string, fn: H) => void (h[ev] = fn) } as never);
    return h;
  };
  const toolResult = (name: string, text: string, isError = false) => ({ toolName: name, content: [{ type: "text", text }], isError });
  const assistant = (text: string, withCall = false) => ({ role: "assistant", content: [{ type: "text", text }, ...(withCall ? [{ type: "toolCall", id: "1", name: "x", arguments: {} }] : [])], stopReason: withCall ? "toolUse" : "stop" });

  it("a refusal the model left out is appended to its final message", () => {
    const h = wire();
    h.agent_start?.({ type: "agent_start" } as never);
    h.tool_result?.(toolResult("mcp__uktub_scholar__verify_claim", REFUSED, true) as never);
    assert.equal(h.message_end?.({ message: assistant("working", true) } as never), undefined, "not appended to a message that still calls tools");
    const out = h.message_end?.({ message: assistant("The claim is supported.") } as never) as { message: { content: { type: string; text?: string }[] } };
    const texts = out.message.content.map((c) => c.text ?? "").join("\n");
    assert.match(texts, /The claim is supported\./, "original text kept");
    assert.match(texts, /VERIFY_ENGINE_MISSING/);
  });

  it("nothing is appended when the answer already mentions it, or after a clean run", () => {
    const h = wire();
    h.agent_start?.({ type: "agent_start" } as never);
    h.tool_result?.(toolResult("mcp__uktub_scholar__verify_claim", REFUSED, true) as never);
    assert.equal(h.message_end?.({ message: assistant("verify_claim was refused: VERIFY_ENGINE_MISSING.") } as never), undefined);
    h.agent_start?.({ type: "agent_start" } as never);
    assert.equal(h.message_end?.({ message: assistant("all good") } as never), undefined);
  });

  it("notices do not leak into the next run, and other tools' results are ignored", () => {
    const h = wire();
    h.agent_start?.({ type: "agent_start" } as never);
    h.tool_result?.(toolResult("bash", "Refused: NOT_OURS — x. Next: y", true) as never);
    assert.equal(h.message_end?.({ message: assistant("done") } as never), undefined);
    h.tool_result?.(toolResult("mcp__uktub_scholar__search_papers", SEARCH) as never);
    h.agent_start?.({ type: "agent_start" } as never);
    assert.equal(h.message_end?.({ message: assistant("done") } as never), undefined);
  });
});
