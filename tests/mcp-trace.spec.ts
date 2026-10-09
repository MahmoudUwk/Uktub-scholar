/**
 * The handshake trace: what a host asked for and what the server answered, observable without a debugger. Consumer: the per-host live
 * measurement (which MCP revision and client each coding agent negotiates) and anyone debugging a host. Off unless asked for.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../src/mcp/server.ts";
import { handshakeTraceEnabled, traceHandshake } from "../src/mcp/trace.ts";

async function connectTraced(client: Client): Promise<string[]> {
  const lines: string[] = [];
  const server = createMcpServer({ targetDir: process.cwd() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  traceHandshake(serverTransport, (line) => lines.push(line));
  await client.connect(clientTransport);
  await client.close();
  return lines;
}

describe("MCP handshake trace", () => {
  it("reports the client, its requested revision and the negotiated revision", async () => {
    const lines = await connectTraced(new Client({ name: "trace-test-host", version: "9.8.7" }, { capabilities: {} }));
    assert.equal(lines.length, 1);
    const line = lines[0] as string;
    assert.match(line, /^uktub-scholar: handshake /);
    assert.match(line, /client=trace-test-host 9\.8\.7/);
    assert.ok(line.includes(`requested=${LATEST_PROTOCOL_VERSION}`), line);
    assert.ok(line.includes(`negotiated=${LATEST_PROTOCOL_VERSION}`), line);
  });

  it("shows a downgrade: a revision the server does not know is answered with the server's latest", async () => {
    const client = new Client({ name: "future-host", version: "1.0.0" }, { capabilities: {} });
    // A host from the future asks for a revision this SDK has never heard of; the SDK client then refuses the server's answer, which is
    // exactly the case the trace has to make visible on the server side.
    const lines: string[] = [];
    const server = createMcpServer({ targetDir: process.cwd() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    traceHandshake(serverTransport, (line) => lines.push(line));
    await clientTransport.start();
    const answered = new Promise<void>((done) => {
      clientTransport.onmessage = () => done();
    });
    await clientTransport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "future-host", version: "1.0.0" } } });
    await answered;
    void client;
    assert.equal(lines.length, 1);
    assert.ok((lines[0] as string).includes("requested=2099-01-01"), lines[0]);
    assert.ok((lines[0] as string).includes(`negotiated=${LATEST_PROTOCOL_VERSION}`), lines[0]);
  });

  it("stays silent for everything but the initialize exchange", async () => {
    const lines: string[] = [];
    const server = createMcpServer({ targetDir: process.cwd() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    traceHandshake(serverTransport, (line) => lines.push(line));
    const client = new Client({ name: "quiet-host", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    const before = lines.length;
    await client.listTools();
    await client.listTools();
    await client.close();
    assert.equal(lines.length, before);
  });

  it("is off unless UKTUB_MCP_TRACE asks for it", () => {
    assert.equal(handshakeTraceEnabled({}), false);
    assert.equal(handshakeTraceEnabled({ UKTUB_MCP_TRACE: "" }), false);
    assert.equal(handshakeTraceEnabled({ UKTUB_MCP_TRACE: "0" }), false);
    assert.equal(handshakeTraceEnabled({ UKTUB_MCP_TRACE: "1" }), true);
  });
});
