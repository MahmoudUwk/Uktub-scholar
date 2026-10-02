import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";

import uktubOaExtension from "../src/pi/extension.ts";
import { createRegistry } from "../src/core/registry.ts";
import { ListPapersOutput } from "../src/core/tools/list.ts";
import { RegisterPapersOutput } from "../src/core/tools/register.ts";
import { SearchPapersOutput } from "../src/core/tools/search.ts";

/**
 * Fake-Pi compat spec (pattern: UktubAI_Agentic tests/contract/pi-extension-compat.spec.ts).
 * The extension imports Pi types only (type-only import, erased at runtime), so the
 * harness never needs the real package at runtime.
 */

interface RegisteredDef {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  outputSchema?: unknown;
  execute?: (toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
}

function makeFakePi(withRegisterTool: boolean) {
  const tools: RegisteredDef[] = [];
  const fakePi = {
    // registerTool omitted entirely when absent — the guard must key on its existence.
    ...(withRegisterTool
      ? {
          registerTool(def: RegisteredDef) {
            tools.push(def);
          },
        }
      : {}),
    on() {},
  };
  return { fakePi, tools };
}

/** A minimal ExtensionToolContext stand-in: execute only reads `cwd`. */
function fakeToolCtx(cwd: string): unknown {
  return { cwd };
}

/** The result the adapter hands Pi: the core ToolResult mapped onto AgentToolResult. */
interface PiResult {
  content: { type: string; text: string }[];
  details: Record<string, unknown>;
  structuredContent?: unknown;
  isError?: boolean;
}

async function call(tools: RegisteredDef[], name: string, params: unknown, cwd: string): Promise<PiResult> {
  const def = tools.find((tool) => tool.name === name);
  assert.ok(def, `tool ${name} not registered`);
  assert.equal(typeof def.execute, "function");
  return (await def.execute!("call-1", params, undefined, undefined, fakeToolCtx(cwd))) as PiResult;
}

test("load guard: Pi without registerTool throws the typed refusal, not a TypeError", () => {
  const { fakePi } = makeFakePi(false);
  assert.throws(
    () => uktubOaExtension(fakePi as never),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /PI_EXTENSION_API_UNAVAILABLE/);
      assert.match(err.message, /upgrade Pi/);
      return true;
    },
  );
});

test("registration: exactly the three tools, exact names, TypeBox parameters and outputSchema", () => {
  const { fakePi, tools } = makeFakePi(true);
  uktubOaExtension(fakePi as never);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["search_papers", "register_papers", "list_papers"],
  );
  for (const tool of tools) {
    assert.equal(typeof tool.label, "string");
    assert.ok((tool.label ?? "").length > 0);
    // Descriptions carry the stable next-hints semantics (rendered refusal shape).
    assert.ok((tool.description ?? "").includes("Next:"), `${tool.name} description lacks a next hint`);
    assert.equal(typeof tool.parameters, "object");
    assert.ok(tool.parameters !== null);
    // outputSchema is the core tool's own declared schema (KTD6/KTD7).
    if (tool.name === "search_papers") assert.deepEqual(tool.outputSchema, SearchPapersOutput);
    if (tool.name === "register_papers") assert.deepEqual(tool.outputSchema, RegisterPapersOutput);
    if (tool.name === "list_papers") assert.deepEqual(tool.outputSchema, ListPapersOutput);
  }
});

test("refusal mapping: core refusal becomes isError:true content carrying code + next", async () => {
  const root = mkdtempSync(join(tmpdir(), "uktub-pi-refusal-"));
  try {
    const { fakePi, tools } = makeFakePi(true);
    uktubOaExtension(fakePi as never);
    const result = await call(tools, "register_papers", { dois: ["10.1234/abc"] }, root);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Refused: REGISTRY_NOT_INITIALIZED/);
    assert.match(result.content[0].text, /uktub-oa init/);
    assert.ok("refused" in result.details && result.details.refused !== null, "refusal details missing");
    assert.equal(result.structuredContent, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("success mapping: structuredContent passes through and validates against the declared outputSchema", async () => {
  const root = mkdtempSync(join(tmpdir(), "uktub-pi-success-"));
  try {
    const db = createRegistry(root);
    db.close();
    const { fakePi, tools } = makeFakePi(true);
    uktubOaExtension(fakePi as never);
    const result = await call(tools, "list_papers", {}, root);
    assert.notEqual(result.isError, true);
    assert.ok(result.structuredContent !== undefined && result.structuredContent !== null);
    assert.equal(Value.Check(ListPapersOutput, result.structuredContent), true);
    if (!("papers" in (result.structuredContent as Record<string, unknown>))) throw new Error("list result lacks papers");
    assert.deepEqual(result.structuredContent, { papers: [], truncated: false, remaining: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("root resolution: ctx.cwd is resolved once; later cwd changes are ignored (documented behavior)", async () => {
  const rootA = mkdtempSync(join(tmpdir(), "uktub-pi-roota-"));
  const rootB = mkdtempSync(join(tmpdir(), "uktub-pi-rootb-"));
  try {
    const db = createRegistry(rootA); // initialized ONLY in rootA
    db.close();
    const { fakePi, tools } = makeFakePi(true);
    uktubOaExtension(fakePi as never);
    const first = await call(tools, "list_papers", {}, rootA);
    assert.notEqual(first.isError, true);
    assert.ok(first.structuredContent !== undefined && first.structuredContent !== null);
    if (!("papers" in (first.structuredContent as Record<string, unknown>))) throw new Error("list result lacks papers");
    const firstPapers: unknown = (first.structuredContent as Record<string, unknown>).papers;
    // rootB has no registry — a fresh resolution would refuse here; the frozen
    // first root must win.
    const second = await call(tools, "list_papers", {}, rootB);
    assert.notEqual(second.isError, true);
    assert.ok(second.structuredContent !== undefined && second.structuredContent !== null);
    if (!("papers" in (second.structuredContent as Record<string, unknown>))) throw new Error("list result lacks papers");
    assert.deepEqual((second.structuredContent as Record<string, unknown>).papers, firstPapers);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});
