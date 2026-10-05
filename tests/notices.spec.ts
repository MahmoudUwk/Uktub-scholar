import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BLOCK_PREFIX, clearedIds, extractNotices, footerFor } from "../src/core/notices.ts";
import uktubScholarExtension from "../src/pi/index.ts";

const REFUSED = `Refused: VERIFY_ENGINE_MISSING — eos engine failed to load: {"error": "decision2 model failed to load: ModuleNotFoundError: No module named 'torch'"}. Next: tell the user the verification engine is not available and how to enable it: the default eos engine needs a Python environment.`;
const SEARCH = `5 candidates for "x" (truncated to the requested 5) — 1 provider warning\nwarning: semantic-scholar — PROVIDER_FAILED: semantic-scholar: HTTP 429 (GET failed); results exclude semantic-scholar\n1. 10.1/a — A (2024)`;
const INTERRUPTED = (checked: number, claim = "Federated tuning cuts cost") => `NO SUPPORT FOUND YET: checking was interrupted before all selected passages were judged (see work).\nNo support found means the verifier did not find a passage supporting the claim under the configured bar; it is not evidence that the claim is false.\nclaim: ${claim}\nengine: eos-onnx (x), support bar 0.99\nsources: 14 selected, 14 with a usable source\ncandidates: exhaustive — every usable passage (698) of 14 paper(s) selected for checking\nwork: ${checked} of 698 selected passage(s) judged (${checked} new, 0 reused); INTERRUPTED (budget): the per-call limit of 120 fresh judgments was reached; ${698 - checked} not checked\ncontinuation: "tok" — repeat the SAME request with continuation set to this token to get unchecked passages.`;
const COMPLETE = (claim = "Federated tuning cuts cost") => `NO SUPPORT FOUND across all 698 checked passage(s).\nclaim: ${claim}\ncandidates: exhaustive — every usable passage (698) of 14 paper(s) selected for checking\nwork: 698 of 698 selected passage(s) judged (120 new, 578 reused); complete`;
const QUERY_LIMITED = `SUPPORT FOUND: 1 supporting passage(s) in 1 paper(s) — coverage is INCOMPLETE (see below).\nclaim: RF fingerprinting is a downstream task\ncandidates: query-limited — only passages matching the locator were checked (3 of 30); a 3/3 matched of 30. No candidates is a statement about the search, not a finding about the papers.\nwork: 3 of 3 selected passage(s) judged (3 new, 0 reused); complete`;
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

describe("interrupted verification", () => {
  it("is a notice carrying how much was NOT checked, keyed to the claim", () => {
    const n = extractNotices("verify_claim", INTERRUPTED(120), false);
    assert.equal(n.length, 1);
    assert.match(n[0]?.line ?? "", /578 of 698/);
    assert.match(n[0]?.line ?? "", /not checked/i);
    assert.match(n[0]?.line ?? "", /Federated tuning/);
    assert.equal(n[0]?.id, extractNotices("verify_claim", INTERRUPTED(240), false)[0]?.id, "later pages replace the earlier notice for the same claim");
    assert.notEqual(n[0]?.id, extractNotices("verify_claim", INTERRUPTED(120, "Another claim"), false)[0]?.id);
  });

  it("a complete result for the same claim clears it; a different claim's does not", () => {
    const id = extractNotices("verify_claim", INTERRUPTED(120), false)[0]?.id;
    assert.deepEqual(clearedIds("verify_claim", COMPLETE()), [id]);
    assert.deepEqual(clearedIds("verify_claim", COMPLETE("Another claim")).includes(id as string), false);
  });

  it("a query-limited result is not a notice (that is how the search was asked), and neither is a complete one", () => {
    assert.deepEqual(extractNotices("verify_claim", QUERY_LIMITED, false), []);
    assert.deepEqual(extractNotices("verify_claim", COMPLETE(), false), []);
  });

  it("an answer that calls the check exhaustive without saying it stopped early gets the footer; an honest one does not", () => {
    const n = extractNotices("verify_claim", INTERRUPTED(360), false);
    assert.match(footerFor("An exhaustive check across all passages found no support.", n) ?? "", /not checked/i);
    assert.equal(footerFor("I checked 360 of 698 passages; checking was interrupted, so the rest are unchecked.", n), null);
    assert.equal(footerFor("Only part of the papers were checked (a budget stop).", n), null);
  });
});

describe("registry changes are an audit trail", () => {
  const REGISTER = "register: 3 input(s) — 2 registered, 1 duplicate\n[0] registered chen2024role 10.1109/mwc.005.2300481\n[1] updated wang2025federated 10.1109/twc.2025.3531128 [uncitable]\n[2] duplicate of [0] chen2024role 10.1109/mwc.005.2300481";
  const REMOVE = "remove: 1 input(s) — 1 removed\n[0] removed love2014moderated 10.1186/s13059-014-0550-8";
  const ATTACH = "attach_source: 1 input(s) — 1 attached\n[0] attached aboulfotouh2025multimodal 10.48550/arxiv.2511.15162 — source ready, revision 9f3e, 29970 characters, 6 pages, 30 passages";

  it("registered, updated, removed and attached outcomes are notices; duplicates, absences and reads are not", () => {
    const keys = (tool: string, text: string) => extractNotices(tool, text, false).map((n) => n.key);
    assert.deepEqual(keys("paper_registry", REGISTER), ["chen2024role", "wang2025federated"]);
    assert.deepEqual(keys("paper_registry", REMOVE), ["love2014moderated"]);
    assert.deepEqual(keys("paper_registry", ATTACH), ["aboulfotouh2025multimodal"]);
    assert.deepEqual(keys("paper_registry", "4 papers selected (whole registry); showing 4\nchen2024role | 10.1/x | A (2024)"), []);
    assert.deepEqual(keys("paper_registry", "[0] absent foo — no registered paper has this DOI or citekey"), []);
  });

  it("the line says what changed", () => {
    const n = extractNotices("paper_registry", REGISTER, false);
    assert.match(n[0]?.line ?? "", /registered chen2024role/);
    assert.match(n[1]?.line ?? "", /updated wang2025federated/);
  });

  it("an answer naming the citekey or the DOI covers it; one that says nothing about it gets listed", () => {
    const n = extractNotices("paper_registry", REGISTER, false);
    assert.equal(footerFor("I added chen2024role and updated wang2025federated.", n), null);
    assert.equal(footerFor("Added 10.1109/mwc.005.2300481, refreshed 10.1109/twc.2025.3531128.", n), null);
    const f = footerFor("Done, the paragraph is written.", n) ?? "";
    assert.match(f, /registered chen2024role/);
    assert.match(f, /updated wang2025federated/);
  });

  it("other tools never produce registry-change notices", () => {
    assert.deepEqual(extractNotices("search_papers", REGISTER, false), []);
  });
});

describe("any failed result is a notice, not only a typed refusal", () => {
  it("a host timeout or an execution error is reported with its text", () => {
    const t = extractNotices("verify_claim", "MCP request timed out after 60000ms", true);
    assert.equal(t.length, 1);
    assert.match(t[0]?.line ?? "", /verify_claim failed: MCP request timed out/);
    assert.equal(extractNotices("compile_document", "Error executing tool compile_document: boom", true).length, 1);
  });

  it("is covered by an answer that says it failed or timed out, and not by one that says nothing", () => {
    const n = extractNotices("verify_claim", "MCP request timed out after 60000ms", true);
    assert.equal(footerFor("The verification timed out, so nothing was checked.", n), null);
    assert.equal(footerFor("The call failed.", n), null);
    assert.match(footerFor("An exhaustive check of all 14 papers was performed.", n) ?? "", /verify_claim failed/);
  });

  it("a typed refusal is still one notice, not two", () => {
    assert.equal(extractNotices("verify_claim", REFUSED, true).length, 1);
  });

  it("a successful result with no warnings has none", () => {
    assert.deepEqual(extractNotices("paper_registry", "4 papers selected", false), []);
  });
});

describe("a guard block is a notice", () => {
  const BLOCKED = `${BLOCK_PREFIX} This command would delete or overwrite the project's \`.registry/\`. The user declined it. Do not work around this.`;

  it("any tool's blocked result becomes a notice, with the reason", () => {
    const n = extractNotices("bash", BLOCKED, true);
    assert.equal(n.length, 1);
    assert.match(n[0]?.line ?? "", /bash was blocked/);
    assert.match(n[0]?.line ?? "", /declined/);
  });

  it("the answer saying the command was not run covers it; one that does not gets the footer", () => {
    const n = extractNotices("bash", BLOCKED, true);
    assert.equal(footerFor("I did not run it: you declined the confirmation.", n), null);
    assert.equal(footerFor("The command was blocked, so your registry is intact.", n), null);
    assert.match(footerFor("Done! Anything else?", n) ?? "", /bash was blocked/);
  });

  it("the extension watches blocked results of tools that are not uktub's", () => {
    type H = (e: never, ctx?: never) => unknown;
    const h: Record<string, H> = {};
    uktubScholarExtension({ registerMcpServer: () => {}, on: (ev: string, fn: H) => void (h[ev] = fn) } as never);
    h.agent_start?.({ type: "agent_start" } as never);
    h.tool_result?.({ toolName: "bash", content: [{ type: "text", text: BLOCKED }], isError: true } as never);
    const out = h.message_end?.({ message: { role: "assistant", content: [{ type: "text", text: "All done." }], stopReason: "stop" } } as never) as { message: { content: { text?: string }[] } } | undefined;
    assert.match(out?.message.content.map((c) => c.text ?? "").join("\n") ?? "", /bash was blocked/);
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

  it("an interruption the agent finished by following the continuation leaves no footer; an unfinished one does", () => {
    const h = wire();
    h.agent_start?.({ type: "agent_start" } as never);
    h.tool_result?.(toolResult("mcp__uktub_scholar__verify_claim", INTERRUPTED(120)) as never);
    h.tool_result?.(toolResult("mcp__uktub_scholar__verify_claim", COMPLETE()) as never);
    assert.equal(h.message_end?.({ message: assistant("Checked everything: no support.") } as never), undefined);
    h.agent_start?.({ type: "agent_start" } as never);
    h.tool_result?.(toolResult("mcp__uktub_scholar__verify_claim", INTERRUPTED(120)) as never);
    h.tool_result?.(toolResult("mcp__uktub_scholar__verify_claim", INTERRUPTED(240)) as never);
    const out = h.message_end?.({ message: assistant("An exhaustive check found no support.") } as never) as { message: { content: { text?: string }[] } };
    const texts = out.message.content.map((c) => c.text ?? "").join("\n");
    assert.match(texts, /458 of 698/, "the latest page's counts, once");
    assert.doesNotMatch(texts, /578 of 698/);
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
