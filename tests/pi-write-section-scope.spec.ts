/**
 * W1: the write_section child is code-scoped to its assigned papers (Pi wiring).
 * Invented citekeys/DOIs/text throughout; the one real registry here holds
 * invented calibration sentences only.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createRegistry, registerPaper, resolveHandle } from "../src/core/registry.ts";
import { getSource, publishSource } from "../src/core/verify/store.ts";
import type { ChunkTextConfig } from "../src/core/chunk.ts";
import { makeSectionWriterTool } from "../src/pi/index.ts";
import type { SectionPaper } from "../src/agent/section-scope.ts";
import type { SourceTrace } from "../src/agent/source-trace.ts";

const NOW = () => new Date("2026-10-04T12:00:00Z");
const FIXED: ChunkTextConfig = { chunk_tokens: 8192, overlap_tokens: 0, chars_per_token: 2.8, boundary: "paragraph" };

const readyRow = (handle: string, citekey = handle, doi = `10.1000/${handle}`): SectionPaper => ({ handle, citekey, doi, state: "ready", detail: null });
const papersReadyOf = (rows: SectionPaper[]) => async (_root: string, _handles: readonly string[]): Promise<SectionPaper[]> => rows;

interface ExecCall { name: string; params: unknown }
interface Forward { name: string; execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }>; details: unknown; isError?: boolean }> }

const VERIFY_MCP = "mcp__uktub_scholar__verify";
const PASSAGES_MCP = "mcp__uktub_scholar__passages";
const REGISTRY_MCP = "mcp__uktub_scholar__registry";

/** Drive the tool with a fake child; captures the child options, prompts and parent tool calls. */
function harness(opts: {
  cwd: string;
  papersReady?: (root: string, handles: readonly string[]) => Promise<SectionPaper[]>;
  execImpl?: (name: string, params: unknown) => unknown;
  onTrace?: (trace: SourceTrace) => void;
}) {
  const loadSdkCalls = { n: 0 };
  const execCalls: ExecCall[] = [];
  const prompts: string[] = [];
  const captured: { tools: string[]; excludeTools: string[]; custom: Forward[] } = { tools: [], excludeTools: [], custom: [] };
  const messages: Array<Record<string, unknown>> = [];
  const listeners = new Set<(e: unknown) => void>();
  const session = {
    messages,
    subscribe: (l: (e: unknown) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    prompt: async (text: string) => {
      prompts.push(text);
      const message = { role: "assistant", content: [{ type: "text", text: "Cells age. \\cite{x}" }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
      messages.push(message);
      for (const l of [...listeners]) l({ type: "message_end", message });
    },
    abort: async () => {},
    dispose: () => {},
  };
  const tool = makeSectionWriterTool({
    loadSdk: async () =>
      ({
        createAgentSession: async (o: { tools: string[]; excludeTools?: string[]; customTools: Forward[] }) => {
          loadSdkCalls.n += 1;
          captured.tools = o.tools;
          captured.excludeTools = o.excludeTools ?? [];
          captured.custom = o.customTools;
          return { session };
        },
        SessionManager: { inMemory: () => ({}) },
      }) as never,
    verifyPage: async () =>
      ({ units: [{ id: "u1", excerpt: "x", status: "supported", suggested: [], pointers: [] }], summary: { total: 1, from: 0, units: 1 }, next: null }) as never,
    ...(opts.papersReady === undefined ? {} : { papersReady: opts.papersReady }),
    ...(opts.onTrace === undefined ? {} : { onTrace: opts.onTrace }),
  });
  const ctx = {
    cwd: opts.cwd,
    tools: [{ name: VERIFY_MCP }, { name: PASSAGES_MCP }, { name: REGISTRY_MCP }],
    executeTool: async (name: string, params: unknown) => {
      execCalls.push({ name, params });
      if (opts.execImpl !== undefined) return opts.execImpl(name, params);
      return { content: [{ type: "text", text: "" }] };
    },
  } as never;
  const run = (params: unknown) =>
    (tool.execute as unknown as (...a: unknown[]) => Promise<{ content: Array<{ text: string }>; details: unknown }>)("call-1", params, undefined, undefined, ctx);
  return { loadSdkCalls, execCalls, prompts, captured, run };
}

const textOf = (out: { content: Array<{ text: string }> }): string => out.content[0]!.text;
const forward = (h: ReturnType<typeof harness>, name: string): Forward => {
  const f = h.captured.custom.find((c) => c.name === name);
  assert.ok(f !== undefined, `child has a ${name} forward`);
  return f;
};

describe("write_section paper scoping (W1)", () => {
  it("1.10 twenty-one papers are refused before the child exists", async () => {
    const keys = Array.from({ length: 21 }, (_, i) => `key${String(i).padStart(2, "0")}`);
    const h = harness({ cwd: "/tmp/uktub-scope-21", papersReady: papersReadyOf(keys.map((k) => readyRow(k))) });
    const out = await h.run({ goal: "Summarize.", papers: keys.join(" ") });
    assert.match(textOf(out), /refused/);
    assert.match(textOf(out), /21/);
    assert.match(textOf(out), /20/);
    assert.equal(h.loadSdkCalls.n, 0, "no child session is created for an over-limit section");
  });

  it("1.16 the child gets the passages, registry and verify tools, and the prompt says so (D1)", async () => {
    const h = harness({ cwd: "/tmp/uktub-scope-tools", papersReady: papersReadyOf([readyRow("smith2024"), readyRow("jones2023")]) });
    await h.run({ goal: "Summarize aging.", papers: "smith2024 jones2023" });
    assert.deepEqual(h.captured.tools, ["passages", "registry", "verify"]);
    assert.ok(h.captured.excludeTools.includes("mcp__*"));
    assert.deepEqual(h.captured.custom.map((c) => c.name).sort(), ["passages", "registry", "verify"]);
  });

  it("1.15 the writer prompt lists citekeys when the parent passed a DOI", async () => {
    const h = harness({
      cwd: "/tmp/uktub-scope-doi",
      papersReady: papersReadyOf([{ handle: "10.1000/smith2024", citekey: "smith2024", doi: "10.1000/smith2024", state: "ready", detail: null }]),
    });
    await h.run({ goal: "Summarize aging.", papers: "10.1000/smith2024" });
    assert.ok(h.prompts.length >= 1);
    assert.match(h.prompts[0]!, /smith2024/);
    assert.doesNotMatch(h.prompts[0]!, /10\.1000/);
  });

  it("1.13 a passages forward without papers calls executeTool with the allowed list", async () => {
    const h = harness({ cwd: "/tmp/uktub-scope-fwd", papersReady: papersReadyOf([readyRow("smith2024"), readyRow("jones2023")]) });
    await h.run({ goal: "Summarize aging.", papers: "smith2024 jones2023" });
    const out = await forward(h, "passages").execute("c2", { query: "aging" }, undefined, undefined, {} as never);
    assert.equal(h.execCalls.length, 1);
    assert.equal(h.execCalls[0]!.name, PASSAGES_MCP);
    assert.deepEqual((h.execCalls[0]!.params as Record<string, unknown>).papers, ["smith2024", "jones2023"]);
    assert.equal(out.isError, undefined);
  });

  it("1.14 a verify forward with an out-of-scope key is refused without calling executeTool", async () => {
    const h = harness({ cwd: "/tmp/uktub-scope-oos", papersReady: papersReadyOf([readyRow("smith2024"), readyRow("jones2023")]) });
    await h.run({ goal: "Summarize aging.", papers: "smith2024 jones2023" });
    const out = await forward(h, "verify").execute("c3", { claim: "Cells age steadily over time in culture.", papers: "ghost9" }, undefined, undefined, {} as never);
    assert.equal(h.execCalls.length, 0, "no parent tool call for an out-of-scope forward");
    assert.equal(out.isError, true);
    assert.match(out.content[0]!.text, /ghost9/);
    assert.match(out.content[0]!.text, /smith2024.*jones2023/);
  });

  it("registry forward with omitted handles calls executeTool with the allowed list and action read", async () => {
    const h = harness({ cwd: "/tmp/uktub-scope-reg", papersReady: papersReadyOf([readyRow("smith2024"), readyRow("jones2023")]) });
    await h.run({ goal: "Summarize aging.", papers: "smith2024 jones2023" });
    const out = await forward(h, "registry").execute("c4", { action: "read" }, undefined, undefined, {} as never);
    assert.equal(h.execCalls.length, 1);
    assert.equal(h.execCalls[0]!.name, REGISTRY_MCP);
    assert.deepEqual(h.execCalls[0]!.params, { action: "read", handles: ["smith2024", "jones2023"] });
    assert.equal(out.isError, undefined);
  });
});

describe("write_section readiness gate (W1, real registry)", () => {
  let root: string;
  let db: DatabaseSync;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "uktub-scope-"));
    db = createRegistry(root);
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const addReady = (doi: string, author: string, year: number): string => {
    registerPaper(
      db,
      { doi, title: `Invented calibration study ${doi}`, authors: [author], year, bibtex: `@article{x, title={T}, author={${author}}, year={${year}}}`, bibtexSource: "crossref" },
      { now: NOW },
    );
    const invented = "Invented calibration sentence one about steady cultures. Invented calibration sentence two about lamp light.";
    publishSource(
      db,
      doi,
      { kind: "local-file", ref: `${doi.slice(-3)}.pdf`, license: null, digest: "0".repeat(64), extraction: "unpdf@1.8.1/pages-v1", text: invented, pageStarts: [0], sections: [] },
      FIXED,
      NOW(),
    );
    return resolveHandle(db, doi)!.citekey;
  };
  const addMetaOnly = (doi: string, author: string, year: number): string => {
    registerPaper(
      db,
      { doi, title: `Invented metadata-only study ${doi}`, authors: [author], year, bibtex: `@article{x, title={T}, author={${author}}, year={${year}}}`, bibtexSource: "crossref" },
      { now: NOW },
    );
    return resolveHandle(db, doi)!.citekey;
  };

  it("1.11 a metadata-only paper is refused by name before the child exists, and never acquired", async () => {
    const citeReady = addReady("10.1000/readyone", "Ready, Rita", 2023);
    const citeMeta = addMetaOnly("10.1000/metaonly", "Meta, Max", 2022);
    const h = harness({ cwd: root });
    const out = await h.run({ goal: "Summarize.", papers: `${citeReady} ${citeMeta}` });
    assert.match(textOf(out), /refused/);
    assert.match(textOf(out), new RegExp(citeMeta));
    assert.match(textOf(out), /metadata_only/);
    assert.match(textOf(out), /acquire/);
    assert.equal(h.loadSdkCalls.n, 0, "no child session is created while a paper has no full text");
    assert.equal(getSource(db, "10.1000/metaonly"), null, "the gate never acquires the missing source");
  });

  it("1.12 no registry at the cwd is a refusal, not a crash", async () => {
    const empty = mkdtempSync(join(tmpdir(), "uktub-scope-empty-"));
    try {
      const h = harness({ cwd: empty });
      const out = await h.run({ goal: "Summarize.", papers: "smith2024" });
      assert.match(textOf(out), /refused/);
      assert.equal(h.loadSdkCalls.n, 0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("write_section source trace (W3, Pi wiring)", () => {
  const FWD_PTR = "10.5555/calib1@cf7fcb9436071d8b#100-200";
  /** A real-shaped passages outcome whose text reads back verbatim. */
  const execImpl = () => ({
    content: [{ type: "text", text: "Invented forwarded passage line." }],
    result: {
      structuredContent: {
        structuredContent: {
          hits: [{
            rank: 1, doi: "10.5555/calib1", citekey: "smith2024", pointer: FWD_PTR,
            section: "Lamp Methods", page: 3, found: true,
            excerpt: "Invented forwarded passage line.", withheld: null,
          }],
        },
      },
    },
  });

  it("3.7 forwards record real-shaped outcomes via onTrace and return the same text as before", async () => {
    const holder: { current: SourceTrace | null } = { current: null };
    const h = harness({ cwd: "/tmp/uktub-trace", papersReady: papersReadyOf([readyRow("smith2024")]), execImpl, onTrace: (t) => { holder.current = t; } });
    await h.run({ goal: "Summarize aging.", papers: "smith2024" });
    const out = await forward(h, "passages").execute("c2", { query: "aging" }, undefined, undefined, {} as never);
    assert.equal(out.content[0]!.text, "Invented forwarded passage line.", "forward text is unchanged");
    assert.ok(holder.current !== null, "onTrace observed the trace");
    assert.deepEqual(holder.current.seen(), {
      spans: [{ doi: "10.5555/calib1", citekey: "smith2024", revision: "cf7fcb9436071d8b", start: 100, end: 200 }],
      headings: [{ citekey: "smith2024", heading: "Lamp Methods" }],
    });
  });

  it("3.8 an out-of-scope refusal records nothing, and an error outcome still returns text", async () => {
    const holder: { current: SourceTrace | null } = { current: null };
    const h = harness({ cwd: "/tmp/uktub-trace-refused", papersReady: papersReadyOf([readyRow("smith2024")]), execImpl, onTrace: (t) => { holder.current = t; } });
    await h.run({ goal: "Summarize aging.", papers: "smith2024" });
    const refused = await forward(h, "verify").execute("c3", { claim: "Invented claim about steady cultures.", papers: "ghost9" }, undefined, undefined, {} as never);
    assert.equal(refused.isError, true);
    assert.ok(holder.current !== null, "onTrace observed the trace");
    assert.deepEqual(holder.current.seen(), { spans: [], headings: [] }, "a refusal records nothing");
    const errHarness = harness({
      cwd: "/tmp/uktub-trace-error",
      papersReady: papersReadyOf([readyRow("smith2024")]),
      execImpl: () => ({ isError: true, content: [{ type: "text", text: "parent tool failed loudly" }] }),
      onTrace: (t) => { holder.current = t; },
    });
    await errHarness.run({ goal: "Summarize aging.", papers: "smith2024" });
    const out = await forward(errHarness, "passages").execute("c4", { query: "aging" }, undefined, undefined, {} as never);
    assert.equal(out.content[0]!.text, "parent tool failed loudly", "an error outcome does not break the forward");
    assert.deepEqual(holder.current!.seen(), { spans: [], headings: [] });
  });
});

describe("write_section annotated mode (W5.11, Pi wiring)", () => {
  const WRITER_TEXT = [
    "```latex",
    "Invented steady cultures divide \\cite{smith2024} at a constant rate. % c1",
    "Invented lamp light shifts the curve upward \\cite{jones2023} on its own. % c2",
    "---SOURCES---",
    "c1 | smith2024 | section=Growth conditions",
    "c2 | jones2023 | section=Appendix",
    "```",
  ].join("\n");

  interface PiSeamCall {
    scopeKeys: string[];
    markers: number[];
  }

  function annotatedPiHarness() {
    const prompts: string[] = [];
    const seamCalls: PiSeamCall[] = [];
    const execCalls: ExecCall[] = [];
    const holder: { trace: SourceTrace | null } = { trace: null };
    const captured: { custom: Forward[] } = { custom: [] };
    const messages: Array<Record<string, unknown>> = [];
    const listeners = new Set<(e: unknown) => void>();
    const session = {
      messages,
      subscribe: (l: (e: unknown) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      prompt: async (text: string) => {
        prompts.push(text);
        // The child opens c1's stated source before writing (a real forward).
        const passages = captured.custom.find((c) => c.name === "passages");
        if (passages !== undefined) await passages.execute("sim-1", { query: "growth conditions", papers: "smith2024" }, undefined, undefined, {} as never);
        const message = { role: "assistant", content: [{ type: "text", text: WRITER_TEXT }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
        messages.push(message);
        for (const l of [...listeners]) l({ type: "message_end", message });
      },
      abort: async () => {},
      dispose: () => {},
    };
    const tool = makeSectionWriterTool({
      loadSdk: async () =>
        ({
          createAgentSession: async (o: { customTools: Forward[] }) => {
            captured.custom = o.customTools;
            return { session };
          },
          SessionManager: { inMemory: () => ({}) },
        }) as never,
      verifyAnnotated: async (parsed, _offset, scope) => {
        seamCalls.push({ scopeKeys: [...scope.keys], markers: parsed.claims.map((c) => c.marker) });
        const units = parsed.claims.map((c) => ({
          id: c.unitId,
          excerpt: c.plain,
          status: "supported" as const,
          suggested: [],
          pointers: [],
          supportWhere: c.sources.map((s) => ({ citekey: s.citekey, at: "stated" as const })),
        }));
        return { units, summary: { total: units.length, from: 0, units: units.length }, next: null, work: { cells: 2, fresh: 2, cached: 0, calls: 1 } };
      },
      papersReady: papersReadyOf([readyRow("smith2024"), readyRow("jones2023")]),
      onTrace: (t) => { holder.trace = t; },
    });
    const ctx = {
      cwd: "/tmp/uktub-scope-annotated",
      tools: [{ name: VERIFY_MCP }, { name: PASSAGES_MCP }, { name: REGISTRY_MCP }],
      executeTool: async (name: string, params: unknown) => {
        execCalls.push({ name, params });
        return {
          content: [{ type: "text", text: "Invented forwarded passage line." }],
          result: {
            structuredContent: {
              structuredContent: {
                hits: [{
                  rank: 1, doi: "10.1000/smith2024", citekey: "smith2024", pointer: "10.1000/smith2024@aa11bb22#10-20",
                  section: "Growth conditions", page: 1, found: true,
                  excerpt: "Invented forwarded passage line.", withheld: null,
                }],
              },
            },
          },
        };
      },
    } as never;
    const run = (params: unknown) =>
      (tool.execute as unknown as (...a: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>)("call-1", params, undefined, undefined, ctx);
    return { prompts, seamCalls, execCalls, holder, run };
  }

  it("the child prompt carries the contract, the seam gets parsed claims with scope keys, and details carry the annotated summary", async () => {
    const h = annotatedPiHarness();
    let out: { content: Array<{ text: string }>; details: Record<string, unknown> };
    try {
      out = await h.run({ goal: "Summarize aging.", papers: "smith2024 jones2023" });
    } catch (err) {
      assert.fail(`the annotated seam was not used (legacy verifyDocument path): ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = out.content[0]!.text;
    assert.ok(h.prompts[0]!.includes("Put each factual sentence"), "the child prompt carries the annotated contract");
    assert.equal(h.seamCalls.length, 1);
    assert.deepEqual(h.seamCalls[0]!.scopeKeys, ["smith2024", "jones2023"], "the seam gets scope = keys");
    assert.deepEqual(h.seamCalls[0]!.markers, [1, 2], "the seam gets the parsed claims");
    assert.ok(text.includes("Claims:\nc1 supported: smith2024 stated\nc2 supported: jones2023 stated\n"), "the table names per-paper support");
    assert.ok(text.includes("Source notes: c2 jones2023 section=Appendix was never opened"), "the unopened source surfaces as unread");
    assert.doesNotMatch(text, /Annotation problems/, "no problems, no problems line");
    const annotated = out.details.annotated as { mode: string; firstDraft: unknown; claims: Array<{ marker: number; unread: string[] }>; problems: unknown; checkCalls: number; work: unknown };
    assert.equal(annotated.mode, "annotated");
    assert.deepEqual(annotated.firstDraft, { mode: "annotated", markers: 2, citedUnits: 2 });
    assert.equal(annotated.claims.length, 2);
    assert.deepEqual(annotated.claims[1]!.unread, ["jones2023"]);
    assert.deepEqual(annotated.problems, {});
    assert.equal(annotated.checkCalls, 1);
    assert.deepEqual(annotated.work, { cells: 2, fresh: 2, cached: 0, calls: 1 });
  });
});
