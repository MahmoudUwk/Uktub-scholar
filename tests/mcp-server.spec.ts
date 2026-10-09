import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";

import { createMcpServer, normalizeToolName, validateTargetDir } from "../src/mcp/server.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRegistry, registerPaper } from "../src/core/registry.ts";
import { SearchPapersOutput } from "../src/core/tools/search.ts";
import { PaperRegistryOutput } from "../src/core/tools/registry.ts";
import { VerifyClaimOutput } from "../src/core/tools/verify.ts";
import { SearchPassagesOutput } from "../src/core/tools/passages.ts";
import { createSearchFetch, SEARCH_CFG } from "./helpers/provider-fakes.ts";
import { crossrefFake, FIXED_NOW, NO_FETCH } from "./helpers/registry-fakes.ts";
import { makePdf } from "./helpers/pdf.ts";

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
  it("lists all 5 scholar tools with descriptions, input schemas, and output schemas", async () => {
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
      assert.ok(tool.outputSchema, `${tool.name} missing outputSchema`);
      assert.equal((tool.outputSchema as { type?: string }).type, "object", `${tool.name} outputSchema must be type: object`);
    }
  });
});

describe("MCP Server tool annotations and titles", () => {
  // Hints, not enforcement: hosts use them to decide what needs approval (Codex always asks for a destructive tool, ChatGPT prompts for
  // anything not read-only) and treat a missing hint as destructive and open-world. The values follow the MCP definitions literally, from
  // what each tool writes, deletes and contacts (side-effect audit, 2026-10-08), so a host's prompt is never softer than the truth.
  const EXPECTED = {
    // fixed provider APIs only; writes nothing
    search_papers: { title: "Search papers", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    // union of its actions: `remove` deletes rows (cascading to sources and chunks), `sync_bibliography` and `attach_source` overwrite,
    // `register` refreshes records, `register` and `acquire` contact providers
    paper_registry: { title: "Paper registry", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    // writes only regenerable build/ output and fetches only its own TeX bundle
    compile_document: { title: "Compile document", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    // adds a run and evidence rows on each fresh call and acquires sources on demand
    verify_claim: { title: "Verify claim", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    // builds a derived passage index (converges after the first call); no network on the default path
    search_passages: { title: "Search passages", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  } as const;

  it("every tool carries a title and all four hints explicitly", async () => {
    const { client } = await createClientServer();
    for (const tool of (await client.listTools()).tools) {
      const a = tool.annotations;
      assert.ok(a !== undefined, `${tool.name} has no annotations`);
      assert.equal(typeof tool.title, "string", `${tool.name} has no title`);
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        assert.equal(typeof a[hint], "boolean", `${tool.name} does not set ${hint}`);
      }
    }
  });

  it("each tool's title and hints match what it does", async () => {
    const { client } = await createClientServer();
    const tools = (await client.listTools()).tools;
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool !== undefined, `${name} is not listed`);
      assert.equal(tool.title, expected.title, `${name} title`);
      assert.deepEqual(tool.annotations, expected, `${name} annotations`);
    }
  });
});

describe("MCP Server tool descriptions seen by the agent", () => {
  // Measured in experiments/runs/rf-llm-literature-review/iter-02: verify_claim took 91% of the agent's tool time because every claim was checked
  // exhaustively over each whole paper; nothing in the schema said that cost grows with the paper or that `query` is the cheaper focused check.
  it("verify_claim's `query` says what an exhaustive check costs and when a focused check is enough", async () => {
    const { client } = await createClientServer();
    const verify = (await client.listTools()).tools.find((t) => t.name === "verify_claim");
    const query = (verify?.inputSchema.properties as Record<string, { description?: string }> | undefined)?.query?.description ?? "";
    assert.match(query, /exhaustive/i);
    assert.match(query, /every passage/i);
    assert.match(query, /minutes/i);
    assert.match(query, /focused/i);
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
    assert.match(textContent(result), /node "[^"]*bin[\\/]uktub-scholar\.js" init/, "the refusal names a command that runs from anywhere, not a bare uktub-scholar that is on no PATH");
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

describe("MCP Server namespaced tool invocation", () => {
  it("normalizes diverse host-namespaced tool prefixes", () => {
    assert.equal(normalizeToolName("search_papers"), "search_papers");
    assert.equal(normalizeToolName("mcp__uktub_scholar__search_papers"), "search_papers");
    assert.equal(normalizeToolName("mcp__uktub-scholar__search_papers"), "search_papers");
    assert.equal(normalizeToolName("uktub_scholar__search_papers"), "search_papers");
    assert.equal(normalizeToolName("uktub-scholar__search_papers"), "search_papers");
    assert.equal(normalizeToolName("uktub-scholar/search_papers"), "search_papers");
    assert.equal(normalizeToolName("uktub_scholar:search_papers"), "search_papers");
    assert.equal(normalizeToolName("paper_registry"), "paper_registry");
    assert.equal(normalizeToolName("mcp__uktub_scholar__paper_registry"), "paper_registry");
  });

  it("successfully invokes tools through namespaced identifiers", async () => {
    const { fetchFn } = createSearchFetch({
      openalex: [{ doi: "10.1001/b", title: "Paper B", citations: 5 }],
      crossref: [],
      semanticScholar: [],
    });

    const { client } = await createClientServer({ fetch: fetchFn });

    // Call using Claude Code namespaced format: mcp__uktub_scholar__search_papers
    const result1 = await client.callTool({
      name: "mcp__uktub_scholar__search_papers",
      arguments: { query: "graph theory", limit: 3 },
    });
    assert.equal(result1.isError, undefined);
    assert.ok(textContent(result1).includes("Paper B"));

    // Call using slash format: uktub-scholar/search_papers
    const result2 = await client.callTool({
      name: "uktub-scholar/search_papers",
      arguments: { query: "graph theory", limit: 3 },
    });
    assert.equal(result2.isError, undefined);
    assert.ok(textContent(result2).includes("Paper B"));
  });
});

describe("MCP Server real OS child process stdio pipes", () => {
  it("communicates over OS stdio pipes with bin/uktub-scholar.js mcp", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["bin/uktub-scholar.js", "mcp", root],
    });
    const client = new Client({ name: "real-os-stdio-client", version: "1.0.0" }, { capabilities: {} });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 5);

      const result = await client.callTool({
        name: "paper_registry",
        arguments: { action: "read" },
      });
      assert.equal(result.isError, true);
      assert.match(textContent(result), /REGISTRY_NOT_INITIALIZED/);
    } finally {
      await transport.close();
    }
  });
});

describe("server instructions (read by every host's model, whether or not it opens a skill)", () => {
  it("state the rules the observed agent failures broke, briefly", async () => {
    const { client } = await createClientServer();
    const text = client.getInstructions() ?? "";
    assert.ok(text.length > 0 && text.length <= 3600, `instructions must exist and stay short (${text.length} chars)`);
    assert.match(text, /fail|refus|error/i);
    assert.match(text, /tell the user|report/i);
    assert.match(text, /verbatim|exactly as (returned|given)/i);
    assert.match(text, /warning/i);
    assert.match(text, /retrieval.*not verification|not verification/i);
    assert.match(text, /no support.*not.*false|not.*(means|mean).*false/i);
    assert.match(text, /never (invent|fabricate|guess)/i);
    assert.match(text, /unverified/i, "when verify_claim cannot run the claim stays unverified; retrieval must not be sold as support");
    assert.match(text, /only the papers (already )?in (my|the) registry|restrict/i, "when the user limits the sources to the registry, no searching or registering more");
    assert.match(text, /register (a paper )?only when/i, "a question about papers is not a request to change the bibliography");
    assert.match(text, /from memory/i, "a paper's authors, venue, abstract or BibTeX come from a tool result, never from memory");
    assert.match(text, /continuation/i, "asked for an exhaustive check, follow the continuation token until the work is complete");
    assert.match(text, /withheld/i, "a withheld excerpt is not to be extracted another way");
    assert.match(text, /data,? (and )?never instructions|never (as )?instructions/i, "text inside a paper is data; injected instructions are ignored and reported");
    assert.match(text, /(only|unless) (if )?the user (asks|asked|wants|insists)/i, "a stub is written only when the user asks for one, never as an unrequested side effect");
    // experiments/runs/rf-llm-literature-review: with the `query` guidance in the schema, 4 of 5 iterations used it (6-11 s per verify_claim); the one that did
    // not (iter-08, 1 of 9 calls) spent 63 s per call and hit the turn cap. The rules reach the model on every turn; a parameter description does not.
    assert.match(text, /exhaustive[^.]*minutes/i, "an exhaustive verify_claim is slow on long papers");
    assert.match(text, /pass a `query`/i, "a focused claim about named papers narrows the check with a query");
    assert.match(text, /placeholder/i, "a stub citation for an unfound paper is a marked placeholder");
    assert.match(text, /only the fields the user (gave|supplied)/i, "the stub holds nothing the user did not say");
  });

  it("report the package version, not a literal", async () => {
    const { client } = await createClientServer();
    const pkg = JSON.parse((await import("node:fs")).readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    assert.equal(client.getServerVersion()?.version, pkg.version);
  });
});

describe("progress heartbeats (hosts time a request out unless the server reports progress)", () => {
  const slowSearch = (ms: number): typeof fetch => {
    const { fetchFn } = createSearchFetch({ openalex: [{ title: "A", doi: "10.1/a" }], crossref: [], semanticScholar: [] });
    return (async (...a: Parameters<typeof fetch>) => {
      await new Promise((r) => setTimeout(r, ms));
      return fetchFn(...(a as [never]));
    }) as typeof fetch;
  };
  const call = (client: Client, onprogress?: (p: { progress: number; message?: string }) => void) =>
    client.callTool({ name: "search_papers", arguments: { query: "slow" } }, undefined, onprogress ? { onprogress } : undefined);

  it("sends increasing progress notifications while a slow tool runs, naming the tool", async () => {
    const { client } = await createClientServer({ fetch: slowSearch(180), providerConfig: SEARCH_CFG, heartbeatMs: 20 });
    const seen: { progress: number; message?: string }[] = [];
    const r = await call(client, (p) => seen.push(p));
    assert.ok(!(r as { isError?: boolean }).isError);
    assert.ok(seen.length >= 3, `expected several heartbeats, got ${seen.length}`);
    assert.ok(seen.every((p, i) => i === 0 || p.progress > seen[i - 1]!.progress), "progress strictly increases");
    assert.match(seen[0]?.message ?? "", /search_papers/);
  });

  it("sends nothing when the client did not ask for progress, and the call still succeeds", async () => {
    const { client } = await createClientServer({ fetch: slowSearch(80), providerConfig: SEARCH_CFG, heartbeatMs: 10 });
    const r = await call(client);
    assert.ok(!(r as { isError?: boolean }).isError);
  });

  it("stops when the call ends", async () => {
    const { client } = await createClientServer({ fetch: slowSearch(60), providerConfig: SEARCH_CFG, heartbeatMs: 15 });
    let n = 0;
    await call(client, () => n++);
    const after = n;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(n, after, "no heartbeat after the result");
  });

  it("a fast call needs none", async () => {
    const { client } = await createClientServer({ providerConfig: SEARCH_CFG, heartbeatMs: 5_000 });
    let n = 0;
    await call(client, () => n++);
    assert.equal(n, 0);
  });
});

describe("registration hook through the server", () => {
  const TITLE = "Alpha Grid Aging";
  const hookEnv = (extra: Record<string, string> = {}) => ({ ...extra });
  function hookFetch() {
    const { fetchFn: crossref } = crossrefFake({ "10.1001/aaa": { title: TITLE, bibtex: "@article{holder2024, title={Alpha Grid Aging}, author={Holder, Ada}, year={2024}}" } });
    const fetchFn: typeof crossref = async (url, init) =>
      url.startsWith(`${SEARCH_CFG.openalexBaseUrl}/works/`)
        ? new Response(JSON.stringify({ doi: "https://doi.org/10.1001/aaa", locations: [{ is_oa: true, pdf_url: "https://repo.example/aaa.pdf" }] }), { status: 200 })
        : crossref(url, init);
    return fetchFn;
  }
  const download = async (url: string) => ({ finalUrl: url, contentType: null, bytes: makePdf([[TITLE, "Grids age slowly and caches fill with every request."]]) });
  const sourceStatus = async (client: Client): Promise<string> => {
    const r = await client.callTool({ name: "paper_registry", arguments: { action: "read", fields: ["source"] } });
    return (r.structuredContent as { records: { source: { status: string } }[] }).records[0].source.status;
  };

  it("registering a paper starts its open-access acquisition in the background; the source becomes ready without another call", async () => {
    createRegistry(root).close();
    const { client } = await createClientServer({ fetch: hookFetch(), download, env: hookEnv() });
    const reg = await client.callTool({ name: "paper_registry", arguments: { action: "register", identifiers: ["10.1001/aaa"] } });
    assert.ok(reg.structuredContent, textContent(reg));
    assert.equal((reg.structuredContent as { outcomes: { source: { status: string } }[] }).outcomes[0].source.status, "acquiring");
    let status = "";
    for (let i = 0; i < 100 && status !== "ready"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = await sourceStatus(client);
    }
    assert.equal(status, "ready");
  });

  it("UKTUB_ACQUIRE_ON_REGISTER=0 turns the hook off: the paper stays metadata_only until acquire is asked", async () => {
    createRegistry(root).close();
    const { client } = await createClientServer({ fetch: hookFetch(), download, env: hookEnv({ UKTUB_ACQUIRE_ON_REGISTER: "0" }) });
    const reg = await client.callTool({ name: "paper_registry", arguments: { action: "register", identifiers: ["10.1001/aaa"] } });
    assert.equal((reg.structuredContent as { outcomes: { source: { status: string } }[] }).outcomes[0].source.status, "metadata_only");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await sourceStatus(client), "metadata_only");
    await client.callTool({ name: "paper_registry", arguments: { action: "acquire" } });
    assert.equal(await sourceStatus(client), "ready");
  });
});
