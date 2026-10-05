import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";

import { createMcpServer, TOOL_DEFINITIONS, validateTargetDir } from "../src/mcp/server.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRegistry, registerPaper } from "../src/core/registry.ts";
import { SearchPapersOutput } from "../src/core/tools/search.ts";
import { PaperRegistryOutput } from "../src/core/tools/registry.ts";
import { CompileDocumentOutput } from "../src/core/tools/compile.ts";
import { VerifyClaimOutput } from "../src/core/tools/verify.ts";
import { SearchPassagesOutput } from "../src/core/tools/passages.ts";
import { createSearchFetch, SEARCH_CFG } from "./helpers/provider-fakes.ts";
import { crossrefFake, FIXED_NOW, NO_FETCH } from "./helpers/registry-fakes.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-mcp-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function createClientServer(options: Parameters<typeof createMcpServer>[0] = {}) {
  const opts = typeof options === "string" ? { targetDir: options } : options;
  const server = createMcpServer({
    targetDir: root,
    now: FIXED_NOW,
    providerConfig: SEARCH_CFG,
    ...opts,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-mcp-client", version: "1.0.0" }, { capabilities: {} });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { server, client, clientTransport, serverTransport };
}

function textContent(result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[] };
  const content = r.content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

describe("MCP Server tools/list", () => {
  it("lists all 5 scholar tools with descriptions and TypeBox input schemas", async () => {
    const { client } = await createClientServer();
    const result = await client.listTools();

    const toolNames = result.tools.map((t) => t.name);
    assert.deepEqual(toolNames, [
      "search_papers",
      "paper_registry",
      "compile_document",
      "verify_claim",
      "search_passages",
    ]);

    for (const tool of result.tools) {
      assert.ok(tool.description && tool.description.length > 0, `${tool.name} missing description`);
      assert.equal(tool.inputSchema.type, "object", `${tool.name} inputSchema must be type: object`);
      assert.ok(typeof tool.inputSchema.properties === "object", `${tool.name} inputSchema must have properties`);
    }
  });
});

describe("MCP Server tools/call search_papers", () => {
  it("runs search and maps results to CallToolResult with content and structuredContent", async () => {
    const { fetchFn } = createSearchFetch({
      openalex: [{ doi: "10.1001/a", title: "Paper A", citations: 10 }],
      crossref: [],
      semanticScholar: [],
    });

    const { client } = await createClientServer({ fetch: fetchFn });
    const result = await client.callTool({
      name: "search_papers",
      arguments: { query: "neural networks", limit: 5 },
    });

    assert.equal(result.isError, undefined);
    assert.ok(Array.isArray(result.content));
    assert.ok(result.content.length > 0);
    assert.ok(textContent(result).includes("Paper A"));

    assert.ok(result.structuredContent !== undefined);
    assert.equal(Value.Check(SearchPapersOutput, result.structuredContent), true);
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.query, "neural networks");
  });

  it("maps query refusal to isError: true and text in content", async () => {
    const { client } = await createClientServer({ fetch: NO_FETCH });
    const result = await client.callTool({
      name: "search_papers",
      arguments: { query: "" },
    });

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.ok(Array.isArray(result.content));
    assert.match(textContent(result), /Refused: QUERY_REQUIRED/);
  });
});

describe("MCP Server tools/call paper_registry", () => {
  it("refuses with isError: true when registry is not initialized", async () => {
    const { client } = await createClientServer({ fetch: NO_FETCH });
    const result = await client.callTool({
      name: "paper_registry",
      arguments: { action: "register", identifiers: ["10.1234/uninit"] },
    });

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.match(textContent(result), /Refused: REGISTRY_NOT_INITIALIZED/);
  });

  it("handles register, read, remove, and sync_bibliography when registry is initialized", async () => {
    const db = createRegistry(root);
    db.close();

    const bibtex = "@article{key2024, title={Quantum Grid}, author={Holder, Ada}, year={2024}}";
    const { fetchFn } = crossrefFake({
      "10.1234/qgrid": { title: "Quantum Grid", bibtex, year: 2024 },
    });

    const { client } = await createClientServer({ fetch: fetchFn });

    // 1. register
    const regResult = await client.callTool({
      name: "paper_registry",
      arguments: { action: "register", identifiers: ["10.1234/qgrid"] },
    });

    assert.equal(regResult.isError, undefined);
    assert.ok(regResult.structuredContent !== undefined);
    assert.equal(Value.Check(PaperRegistryOutput, regResult.structuredContent), true);
    const regStructured = regResult.structuredContent as { outcomes: { doi: string; status: string; citekey: string }[] };
    assert.equal(regStructured.outcomes[0].status, "registered");
    const citekey = regStructured.outcomes[0].citekey;

    // 2. read
    const readResult = await client.callTool({
      name: "paper_registry",
      arguments: { action: "read" },
    });

    assert.equal(readResult.isError, undefined);
    const readStructured = readResult.structuredContent as { total: number; records: { citekey: string }[] };
    assert.equal(readStructured.total, 1);
    assert.equal(readStructured.records[0].citekey, citekey);

    // 3. sync_bibliography
    const syncResult = await client.callTool({
      name: "paper_registry",
      arguments: { action: "sync_bibliography" },
    });
    assert.equal(syncResult.isError, undefined);
    assert.ok(existsSync(join(root, "refs", "references.bib")));

    // 4. remove
    const removeResult = await client.callTool({
      name: "paper_registry",
      arguments: { action: "remove", handles: [citekey] },
    });
    assert.equal(removeResult.isError, undefined);
    const removeStructured = removeResult.structuredContent as { outcomes: { status: string }[] };
    assert.equal(removeStructured.outcomes[0].status, "removed");
  });
});

describe("MCP Server tools/call compile_document", () => {
  it("returns compilation outcome or missing engine refusal with structured content or error", async () => {
    const { client } = await createClientServer();
    const result = await client.callTool({
      name: "compile_document",
      arguments: {},
    });

    // Either tectonic is installed or missing; either way it returns valid result
    assert.ok(Array.isArray(result.content));
    assert.ok(result.content.length > 0);
  });
});

describe("MCP Server tools/call verify_claim", () => {
  it("refuses out-of-range claims and empty scopes", async () => {
    const { client } = await createClientServer();

    // Short claim (< 8 characters)
    const shortClaim = await client.callTool({
      name: "verify_claim",
      arguments: { claim: "Short", papers: "all" },
    });
    assert.equal(shortClaim.isError, true);
    assert.match(textContent(shortClaim), /Refused: ARGUMENT_INVALID/);

    // Empty explicit paper list
    const emptyPapers = await client.callTool({
      name: "verify_claim",
      arguments: { claim: "Long enough claim sentence for verification.", papers: [] },
    });
    assert.equal(emptyPapers.isError, true);
    assert.match(textContent(emptyPapers), /Refused: ARGUMENT_INVALID/);
    assert.match(textContent(emptyPapers), /papers must be "all" or a non-empty list/);
  });

  it("handles valid claim against empty registry with no support found", async () => {
    const db = createRegistry(root);
    db.close();

    const { client } = await createClientServer();
    const result = await client.callTool({
      name: "verify_claim",
      arguments: { claim: "High temperatures degrade protein stability.", papers: "all" },
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.structuredContent !== undefined);
    assert.equal(Value.Check(VerifyClaimOutput, result.structuredContent), true);
    const structured = result.structuredContent as { result: { supportFound: boolean } };
    assert.equal(structured.result.supportFound, false);
  });
});

describe("MCP Server tools/call search_passages", () => {
  it("searches passages over empty registry and returns valid output schema", async () => {
    const db = createRegistry(root);
    db.close();

    const { client } = await createClientServer();
    const result = await client.callTool({
      name: "search_passages",
      arguments: { query: "thermodynamic entropy" },
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.structuredContent !== undefined);
    assert.equal(Value.Check(SearchPassagesOutput, result.structuredContent), true);
    const structured = result.structuredContent as { result: { found: boolean }; hits: unknown[] };
    assert.equal(structured.result.found, false);
    assert.equal(structured.hits.length, 0);
  });
});

describe("MCP Server unknown tool handling", () => {
  it("returns isError: true when an unregistered tool is requested", async () => {
    const { client } = await createClientServer();
    const result = await client.callTool({
      name: "nonexistent_tool",
      arguments: {},
    });

    assert.equal(result.isError, true);
    assert.match(textContent(result), /Unknown tool: nonexistent_tool/);
  });
});

describe("MCP Server context confinement (R16)", () => {
  it("refuses tool execution if targetDir escapes via traversal or protected segments", async () => {
    const badDir = `${root}/../escaped-dir`;
    const { client } = await createClientServer({ targetDir: badDir });

    const result = await client.callTool({
      name: "search_passages",
      arguments: { query: "test" },
    });

    assert.equal(result.isError, true);
    assert.match(textContent(result), /Refused: PATH_REFUSED/);
  });

  it("validateTargetDir helper validates directory without creating a server", () => {
    const badDir = `${root}/../escaped`;
    const checkBad = validateTargetDir(badDir);
    assert.equal(checkBad.ok, false);
    if (!checkBad.ok) {
      assert.equal(checkBad.code, "PATH_REFUSED");
    }

    const checkGood = validateTargetDir(root);
    assert.equal(checkGood.ok, true);
  });
});

describe("MCP Server cancellation signal", () => {
  it("forwards cancellation signal to tools", async () => {
    const db = createRegistry(root);
    registerPaper(db, { doi: "10.1234/abc", title: "Needs A Source", authors: [] });
    db.close();

    const { client } = await createClientServer();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      client.callTool(
        {
          name: "verify_claim",
          arguments: { claim: "Cells age faster at high temperature.", papers: "all" },
        },
        undefined,
        { signal: controller.signal },
      ),
      (e: unknown) => (e as { name?: string }).name === "AbortError",
    );
  });
});

