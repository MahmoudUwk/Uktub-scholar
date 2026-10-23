import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TOOL_DEFINITIONS } from "../src/core/tools/definitions.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

describe("tool definitions: single shared source", () => {
  it("MCP tools/list output matches TOOL_DEFINITIONS field for field", async () => {
    const root = mkdtempSync(join(tmpdir(), "uktub-defs-test-"));
    const server = createMcpServer({ targetDir: root });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.listTools();
    const expected = TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      annotations: tool.annotations,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    }));
    assert.deepEqual(
      result.tools.map((t) => ({
        name: t.name,
        title: (t as { title?: unknown }).title,
        description: t.description,
        annotations: t.annotations,
        inputSchema: t.inputSchema,
        outputSchema: (t as { outputSchema?: unknown }).outputSchema,
      })),
      JSON.parse(JSON.stringify(expected)),
    );
    await client.close();
    await server.close();
  });

  it("tools/list output is byte-identical to the pre-move capture", async () => {
    const root = mkdtempSync(join(tmpdir(), "uktub-defs-test-"));
    const server = createMcpServer({ targetDir: root });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.listTools();
    const pinned = JSON.parse(
      readFileSync(new URL("./fixtures/mcp-tools-list.json", import.meta.url), "utf8"),
    );
    assert.deepEqual(JSON.parse(JSON.stringify(result.tools)), pinned);
    await client.close();
    await server.close();
  });
});
