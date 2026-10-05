/**
 * The package as a consumer receives it: compiled JavaScript under `node_modules/` (Node refuses to type-strip files there), data files
 * beside the code that reads them, and the bin starting without a TypeScript flag. Offline: the build runs here and dependencies are
 * symlinked from this checkout's node_modules.
 */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let site: string; // a fake consumer project
let pkg: string; // site/node_modules/uktub-scholar
let bin: string;

before(() => {
  site = mkdtempSync(join(tmpdir(), "uktub-pkg-"));
  pkg = join(site, "node_modules", "uktub-scholar");
  mkdirSync(pkg, { recursive: true });
  for (const f of ["package.json", "bin", "scripts", "skills"]) cpSync(join(ROOT, f), join(pkg, f), { recursive: true });
  // the build the publish step runs
  execFileSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", join(ROOT, "tsconfig.build.json"), "--outDir", join(pkg, "dist")], { cwd: ROOT });
  execFileSync(process.execPath, [join(ROOT, "scripts", "build-assets.mjs"), join(ROOT, "src"), join(pkg, "dist")], { cwd: ROOT });
  // dependencies: link this checkout's top-level packages (pnpm keeps them as symlinks into its store)
  const nm = join(ROOT, "node_modules");
  for (const e of readdirSync(nm)) {
    if (e.startsWith(".")) continue;
    const from = join(nm, e);
    if (e.startsWith("@")) {
      mkdirSync(join(site, "node_modules", e), { recursive: true });
      for (const inner of readdirSync(from)) symlinkSync(realpathSync(join(from, inner)), join(site, "node_modules", e, inner));
    } else if (lstatSync(from).isSymbolicLink() || lstatSync(from).isDirectory()) symlinkSync(realpathSync(from), join(site, "node_modules", e));
  }
  bin = join(pkg, "bin", "uktub-scholar.js");
});
after(() => rmSync(site, { recursive: true, force: true }));

const run = (args: string[], cwd = site, env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", env });

describe("an installed copy (compiled, under node_modules)", () => {
  it("ships no TypeScript to execute: dist exists and mirrors the source layout", () => {
    for (const f of ["cli/main.js", "mcp/server.js", "pi/index.js", "core/schema.sql", "core/embed/models.lock.json", "core/compile/tectonic.lock.json", "core/verify/eos-onnx.lock.json"]) assert.ok(existsSync(join(pkg, "dist", f)), f);
  });

  it("the bin runs without a TypeScript flag and answers usage", () => {
    const r = run([]);
    assert.match(r.stdout + r.stderr, /usage: uktub-scholar/);
    assert.doesNotMatch(r.stderr, /TYPE_STRIPPING|ERR_/);
  });

  it("reads its lock files (embed status, tectonic status)", () => {
    const env = { ...process.env, UKTUB_CACHE_DIR: join(site, "cache") };
    assert.match(run(["embed", "status"], site, env).stdout, /llama\.cpp/);
    assert.match(run(["tectonic", "status"], site, env).stdout, /tectonic \d+\.\d+\.\d+/);
  });

  it("creates a registry (the SQL schema travels with the code) and lists it", () => {
    const proj = join(site, "proj");
    mkdirSync(proj);
    const init = run(["init"], proj);
    assert.equal(init.status, 0, init.stderr);
    assert.ok(existsSync(join(proj, ".registry", "registry.db")));
    assert.equal(run(["list"], proj).status, 0);
  });

  it("serves MCP over stdio with the package version and the five tools", async () => {
    const proj = join(site, "mcpproj");
    mkdirSync(proj);
    const t = new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], cwd: proj });
    const c = new Client({ name: "pkg-test", version: "0" });
    await c.connect(t);
    try {
      const names = (await c.listTools()).tools.map((x) => x.name).sort();
      assert.deepEqual(names, ["compile_document", "paper_registry", "search_papers", "search_passages", "verify_claim"]);
      const pkgVersion = (JSON.parse((await import("node:fs")).readFileSync(join(pkg, "package.json"), "utf8")) as { version: string }).version;
      assert.equal(c.getServerVersion()?.version, pkgVersion);
      assert.match(c.getInstructions() ?? "", /verbatim/);
    } finally {
      await c.close();
    }
  });

  it("the Pi extension's command points at a bin that exists in the installed layout", async () => {
    const mod = (await import(join(pkg, "dist", "pi", "index.js"))) as { default: (pi: unknown) => void };
    let cfg: { command: string; args: string[] } | undefined;
    mod.default({ registerMcpServer: (_n: string, c: never) => (cfg = c), on: () => () => {} });
    assert.equal(cfg?.args[0], bin);
    assert.ok(existsSync(cfg?.args[0] ?? ""));
    assert.equal(dirname(dirname(cfg?.args[0] ?? "")), pkg);
  });
});

