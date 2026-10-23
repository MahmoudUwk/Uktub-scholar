/**
 * W5.12: the Pi `write_section` tool checks an annotated draft with the real annotated checker by default
 * (no injected checker): a real registry of invented text, a fake child reply, and a fake engine behind the
 * default checkers. Stated sources are judged first; the claim table and the ledger record the result.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createRegistry, openRegistry, registerPaper } from "../src/core/registry.ts";
import { publishSource } from "../src/core/verify/store.ts";
import type { SectionMark } from "../src/core/sections.ts";
import type { VerifyHooks } from "../src/core/tools/verify.ts";
import { makeSectionWriterTool } from "../src/pi/index.ts";

const NOW = () => new Date("2026-10-04T12:00:00Z");
const DOI = "10.1111/w512";
const VERIFY_MCP = "mcp__uktub_scholar__verify";
const PASSAGES_MCP = "mcp__uktub_scholar__passages";
const REGISTRY_MCP = "mcp__uktub_scholar__registry";

let root: string;
let db: DatabaseSync;
let savedModelId: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-w512-"));
  db = createRegistry(root);
  savedModelId = process.env.UKTUB_VERIFY_MODEL_ID;
  process.env.UKTUB_VERIFY_MODEL_ID = "test-model";
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  if (savedModelId === undefined) delete process.env.UKTUB_VERIFY_MODEL_ID;
  else process.env.UKTUB_VERIFY_MODEL_ID = savedModelId;
});

const filler = (tag: string, n: number): string => `${tag} ` + "The experiment records many independent measurements of the cell. ".repeat(Math.ceil(n / 65)).slice(0, n);

function addPaper(): string {
  const sections: [string, string][] = [
    ["Background", filler("bg", 900)],
    ["Results", `${filler("re", 400)}\n\nAlphamark finding holds in the tested cells with scatter below twelve percent.\n\n${filler("re-b", 400)}`],
  ];
  const parts: string[] = [];
  const marks: SectionMark[] = [];
  let off = 0;
  sections.forEach(([heading, body], i) => {
    if (i > 0) {
      parts.push("\n\n");
      off += 2;
    }
    marks.push({ start: off, heading, level: 1 });
    const chunk = `${heading}\n\n${body}`;
    parts.push(chunk);
    off += chunk.length;
  });
  registerPaper(db, { doi: DOI, title: "Alpha Paper", authors: ["Holder, Ada"], year: 2024, bibtex: "@article{x512, title={T}, author={Holder, Ada}, year={2024}}", bibtexSource: "crossref" }, { now: NOW });
  const cfg = { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 2.8, boundary: "paragraph" as const };
  publishSource(db, DOI, { kind: "local-file", ref: "512.pdf", license: null, digest: "7".repeat(64), extraction: "t@1", text: parts.join(""), pageStarts: [0], sections: marks }, cfg, NOW());
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "chunking.yaml"),
    "chunking:\n  chunk_tokens: 256\n  overlap_tokens: 0\n  chars_per_token: 2.8\n  boundary: paragraph\nverification:\n  engine: llama-cpp\n  min_confidence: 0.99\n  workers: 2\n  max_judgments: 120\n",
  );
  return (db.prepare("SELECT citekey FROM papers WHERE doi = ?").get(DOI) as { citekey: string }).citekey;
}

function tool(reply: string, rows: { state: string; instructions: string }[][]) {
  const messages: Array<Record<string, unknown>> = [];
  const listeners = new Set<(e: unknown) => void>();
  const session = {
    messages,
    subscribe: (l: (e: unknown) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    prompt: async () => {
      const message = { role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
      messages.push(message);
      for (const l of [...listeners]) l({ type: "message_end", message });
    },
    abort: async () => {},
    dispose: () => {},
  };
  const verifyHooks: VerifyHooks = {
    fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    createEngine: () => ({
      run: async (batch) => {
        rows.push(batch.map((r) => ({ state: r.state, instructions: r.instructions })));
        return batch.map((r) => (r.state.includes("Alphamark finding holds") && r.instructions.toLowerCase().includes("alphamark") ? 0.999 : 0.05));
      },
    }),
  };
  return makeSectionWriterTool({
    loadSdk: async () => ({ createAgentSession: async () => ({ session }), SessionManager: { inMemory: () => ({}) } }) as never,
    verifyHooks,
  });
}

const ctxOf = () =>
  ({
    cwd: root,
    tools: [{ name: VERIFY_MCP }, { name: PASSAGES_MCP }, { name: REGISTRY_MCP }],
    executeTool: async () => ({ content: [{ type: "text", text: "" }] }),
  }) as never;

describe("W5.12 annotated write_section through the real checker", () => {
  it("checks the stated section first, reports the claim table, and records the ledger row", async () => {
    const key = addPaper();
    const reply = [
      "```latex",
      `The alphamark finding holds in the tested cells~\\cite{${key}}. % c1`,
      "---SOURCES---",
      `c1 | ${key} | section=Results`,
      "```",
    ].join("\n");
    const rows: { state: string; instructions: string }[][] = [];
    const t = tool(reply, rows);
    const out = (await (t.execute as unknown as (...a: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>)(
      "call-1",
      { goal: "Summarize the alphamark result.", papers: key },
      undefined,
      undefined,
      ctxOf(),
    ));
    const text = out.content[0]!.text;
    assert.match(text, /Claims:/, text);
    assert.match(text, new RegExp(`c1 supported: ${key} stated`), text);
    const annotated = out.details.annotated as { mode?: string } | undefined;
    assert.equal(annotated?.mode, "annotated");
    assert.doesNotMatch(text, /% c1|---SOURCES---/, "markers and the sources list never reach the parent");
    // Stated first: the first judged state is the Results section, never Background.
    assert.ok(rows.length > 0);
    assert.ok(rows[0]!.every((r) => r.state.startsWith("Results")), "round 1 judges only the stated section");
    const check = openRegistry(root);
    try {
      const n = (check.prepare("SELECT COUNT(*) AS n FROM claim_ledger WHERE doi = ?").get(DOI) as { n: number }).n;
      assert.ok(n > 0, "the supported claim is in the ledger");
    } finally {
      check.close();
    }
  });
});
