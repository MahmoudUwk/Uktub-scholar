/**
 * The installer writes MCP_SERVER_NAME ("uktub"); the acceptance case must read
 * that key, not the legacy one. Runs the real installer into a temp dir and
 * evaluates the same extraction the case performs.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { runCli } from "../src/cli/main.ts";
import { installedMcpServerCommand } from "../scripts/live/cases.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-installer-key-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const io = () => {
  const lines = { out: [] as string[], err: [] as string[] };
  return {
    cwd: root,
    lines,
    env: { UKTUB_CACHE_DIR: join(root, ".cache") },
    out: (line: string): void => {
      lines.out.push(line);
    },
    err: (line: string): void => {
      lines.err.push(line);
    },
  };
};

describe("installer case reads the installer's actual server key", () => {
  it("extracts a spawnable command from what `mcp install --host pi` wrote, keeping other servers, idempotently", async () => {
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x", args: [] } }, keep: 1 }));
    assert.equal(await runCli(["mcp", "install", "--host", "pi"], io()), 0);
    const first = readFileSync(join(root, ".mcp.json"), "utf8");
    assert.equal(await runCli(["mcp", "install", "--host", "pi"], io()), 0);
    assert.equal(readFileSync(join(root, ".mcp.json"), "utf8"), first, "a second install must be byte-identical");
    const content = JSON.parse(first) as { mcpServers: Record<string, unknown>; keep: unknown };
    assert.deepEqual(content.mcpServers.other, { command: "x", args: [] });
    assert.equal(content.keep, 1);
    const [command, ...args] = installedMcpServerCommand(first);
    assert.equal(command, "node");
    assert.ok(isAbsolute(args[0] ?? "") && existsSync(args[0] ?? ""), `server args must name this package's bin, got ${JSON.stringify(args)}`);
    assert.deepEqual(args.slice(1), ["mcp"]);
  });

  it("reads a legacy uktub-scholar entry after the installer migrates it", async () => {
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { "uktub-scholar": { command: "node", args: ["old-entry"] } } }));
    assert.equal(await runCli(["mcp", "install", "--host", "pi"], io()), 0);
    const content = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    assert.ok(!("uktub-scholar" in content.mcpServers), "the installer migrates the legacy key, so the case must not read it");
    const [command, ...args] = installedMcpServerCommand(readFileSync(join(root, ".mcp.json"), "utf8"));
    assert.equal(command, "node");
    assert.deepEqual(args.slice(1), ["mcp"]);
  });

  it("fails closed when the installer key is absent", () => {
    assert.throws(() => installedMcpServerCommand(JSON.stringify({ mcpServers: {} })), /uktub/);
  });
});
