/**
 * uktub-scholar CLI (U6, R17): the human owns init, removal, bibliography healing,
 * and listing; `register`, `attach` and `verify` call the very tool functions
 * the agent uses (structural parity), so no behavior can drift between the two
 * paths. Registry operations go through src/core/registry.ts.
 *
 * Arg parsing is by hand (zero dependencies). `console` is the CLI's user
 * interface — the one place in src/ allowed to touch it (the bin shim spawns
 * this file; `runCli` itself takes injected writers so tests import it
 * directly).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { RegistryError, createRegistry, deregisterPapers, findEnclosingProject, listPapers, openRegistry, syncBibliography } from "../core/registry.ts";
import { reviewManuscript } from "../core/review/run.ts";
import { compileDocument, describeOutcome, prodSpawn } from "../core/compile/run.ts";
import { installTectonic, managedTectonicPath, readTectonicLock } from "../core/compile/managed.ts";
import { installedEosOnnx, readEosOnnxLock } from "../core/verify/eos-onnx.ts";
import { type Run, installEosOnnx } from "../core/verify/eos-onnx-install.ts";
import { renderRefusal } from "../core/refusals.ts";
import { WriteQueue } from "../core/queue.ts";
import { createSafeDownloader } from "../core/source/download.ts";
import { paperRegistryTool, type PaperRegistryArgs } from "../core/tools/registry.ts";
import type { ToolContext, ToolResult } from "../core/tools/context.ts";
import { verifyClaimTool, type VerifyClaimArgs, type VerifyHooks } from "../core/tools/verify.ts";
import { searchPassagesTool, type SearchPassagesArgs } from "../core/tools/passages.ts";
import { managedCacheDir } from "../core/embed/config.ts";
import { BIN_PATH } from "../core/launch.ts";
import { RuntimeError, installRuntime, installedPaths, platformKey, readLock, type RuntimeLock } from "../core/embed/runtime.ts";
import { createMcpServer, validateTargetDir } from "../mcp/server.ts";
import { handshakeTraceEnabled, traceHandshake } from "../mcp/trace.ts";

/** Injected I/O: the bin passes console writers; tests capture arrays. */
export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Project root; defaults to process.cwd() — the bin passes nothing. */
  cwd?: string;
  /** Test seam: the clock (the review report is named by date). */
  now?: () => Date;
  /** Test seams; the bin passes none and the real network/env/engine are used. */
  fetch?: ToolContext["fetch"];
  download?: ToolContext["download"];
  env?: Record<string, string | undefined>;
  verifyHooks?: VerifyHooks;
  /** Test seams for `embed`: the pin, the download transport and the platform. */
  embedLock?: RuntimeLock;
  embedFetch?: typeof fetch;
  embedPlatform?: string;
  /** Test seam for `mcp`: custom transport instead of stdio. */
  mcpTransport?: Transport;
}

const USAGE = `usage: uktub-scholar <command>

commands:
  init                          create the registry and an empty refs/references.bib
  deregister <doi|citekey>...   remove papers (cascade + re-render); by DOI or citekey
  sync-bib                      re-render refs/references.bib from the registry
  list                          print registered papers in citekey order
  compile [entry.tex]           compile with tectonic (PDF in build/); entry defaults
                                to manuscript/main.tex, then main.tex, then a lone .tex
  review [entry.tex] [--out <report.md>]
                                deterministic manuscript review (four structural measures, no model):
                                full report with file:line evidence in reviews/<date>-slop.md
  register <id>...              register papers by DOI or arxiv:ID (same tool the agent uses)
  attach <doi|citekey> <file>   prepare a local PDF/TEI inside the project as a paper's source
  verify <claim> [--papers all|<doi|citekey>,...] [--query <words>] [--continuation <token>]
                                find supporting passages for ONE claim (default: all papers)
  search <query> [--papers all|<doi|citekey>,...] [--limit <n>]
                                find the passages that best match a topic or question (keyword,
                                plus semantic when an embedding server is available)
  embed status | embed install --yes
                                the managed embedding runtime: a pinned llama.cpp server and
                                EmbeddingGemma, downloaded once (sha256-verified) into a shared cache;
                                or run your own server and set UKTUB_EMBED_URL
  eos status | eos install --yes [--gpu]
                                the Eos claim-verification engine without PyTorch: a pinned ONNX export (about 700 MB)
                                plus a small Python environment (about 150 MB); select it with verification.engine: eos-onnx
  tectonic status | tectonic install --yes
                                the LaTeX engine for compile: a pinned, sha256-verified tectonic downloaded once
                                into the shared cache (skip it when tectonic is already on PATH)
  mcp [dir] [--dir <path>]      run the stdio MCP server (defaults to cwd)
  mcp install [--host <name>]   write host MCP configuration (claude, pi, agy, codex, cursor, opencode)`;

/** The same context the Pi adapter builds: real network, env and clock unless a test injects them. */
function toolContext(io: CliIo, root: string): ToolContext {
  return {
    root,
    fetch: io.fetch ?? ((...a) => globalThis.fetch(...a)),
    env: io.env ?? (process.env as Record<string, string | undefined>),
    now: () => new Date(),
    queue: new WriteQueue(),
    download: io.download ?? createSafeDownloader(),
  };
}

/** Print a tool result exactly as the agent reads it; a refusal goes to stderr, exit 1. */
function reportTool(result: ToolResult<unknown>, io: CliIo): number {
  const text = result.content.map((c) => c.text).join("\n");
  if (result.details["refused"] !== undefined) {
    io.err(`error: ${text}`);
    return 1;
  }
  // Per-item refusals are outcomes (a partly successful batch exits 0), but a call in which EVERY item was refused must not read as success.
  const outcomes = (result.structuredContent as { outcomes?: { status?: string }[] } | null)?.outcomes;
  if (Array.isArray(outcomes) && outcomes.length > 0 && outcomes.every((o) => o.status === "refused")) {
    io.err(`error: ${text}`);
    return 1;
  }
  io.out(text);
  return 0;
}

function parseVerifyArgs(args: string[]): VerifyClaimArgs | null {
  const claimParts: string[] = [];
  let papers: "all" | string[] = "all";
  let query: string | undefined;
  let continuation: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--papers" && args[i + 1] !== undefined) {
      const v = args[++i];
      papers = v === "all" ? "all" : v.split(",").filter((h) => h.length > 0);
    } else if (a === "--query" && args[i + 1] !== undefined) query = args[++i];
    else if (a === "--continuation" && args[i + 1] !== undefined) continuation = args[++i];
    else claimParts.push(a);
  }
  if (claimParts.length === 0) return null;
  return { claim: claimParts.join(" "), papers, ...(query !== undefined ? { query } : {}), ...(continuation !== undefined ? { continuation } : {}) } as VerifyClaimArgs;
}

function parseSearchArgs(args: string[]): SearchPassagesArgs | null {
  const words: string[] = [];
  let papers: "all" | string[] | undefined;
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--papers" && args[i + 1] !== undefined) {
      const v = args[++i];
      papers = v === "all" ? "all" : v.split(",").filter((h) => h.length > 0);
    } else if (a === "--limit" && args[i + 1] !== undefined) limit = Number(args[++i]);
    else words.push(a);
  }
  if (words.length === 0) return null;
  return { query: words.join(" "), ...(papers !== undefined ? { papers } : {}), ...(limit !== undefined ? { limit } : {}) } as SearchPassagesArgs;
}

const megabytes = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`;

async function embedCommand(args: string[], io: CliIo): Promise<number> {
  const sub = args[0];
  if (sub !== "status" && sub !== "install") {
    io.err(`error: unknown embed command; use embed status or embed install --yes\n${USAGE}`);
    return 1;
  }
  const lock = io.embedLock ?? readLock();
  const env = io.env ?? (process.env as Record<string, string | undefined>);
  const cacheDir = managedCacheDir(env);
  const platform = io.embedPlatform ?? platformKey();
  const asset = lock.runtime.assets[platform];
  const em = lock.embedding;
  const installed = installedPaths(lock, cacheDir, platform) !== null;

  if (sub === "status") {
    io.out(`Managed embedding runtime`);
    io.out(`  cache:    ${cacheDir}`);
    io.out(asset === undefined ? `  platform: ${platform} — no build pinned; run your own embedding server and set UKTUB_EMBED_URL` : `  platform: ${platform} — ${lock.runtime.name} ${lock.runtime.version} (${lock.runtime.license}), ${megabytes(asset.size)}`);
    io.out(`  model:    ${em.id} (${em.license} terms: ${em.terms}), ${megabytes(em.size)}`);
    io.out(installed ? `  state:    installed` : `  state:    not installed${asset === undefined ? "" : " — run: uktub-scholar embed install --yes"}`);
    return 0;
  }

  if (asset === undefined) {
    io.err(`error: no ${lock.runtime.name} ${lock.runtime.version} build is pinned for ${platform}; run your own embedding server and set UKTUB_EMBED_URL instead`);
    return 1;
  }
  if (!args.includes("--yes")) {
    io.err(`embed install will download, verify (sha256 pinned in models.lock.json) and unpack into ${cacheDir}:`);
    io.err(`  ${lock.runtime.name} ${lock.runtime.version} (llama-server, ${lock.runtime.license}): ${megabytes(asset.size)} from ${asset.url}`);
    io.err(`  embedding model ${em.id}: ${megabytes(em.size)} from ${em.url}`);
    io.err(`The model is provided under the ${em.license} terms of use (${em.terms}); installing it means you accept them.`);
    io.err(`Re-run with --yes to download.`);
    return 1;
  }
  try {
    const r = await installRuntime({ lock, cacheDir, platform, fetch: io.embedFetch ?? ((...a) => globalThis.fetch(...a)) });
    io.out(r.downloaded.length === 0 ? `Already installed in ${cacheDir}; nothing to download.` : `Installed (${r.downloaded.join(" and ")} downloaded and verified) in ${cacheDir}.`);
    io.out(`Searches now use it automatically (or set UKTUB_EMBED_URL to use your own server).`);
    return 0;
  } catch (caught) {
    if (caught instanceof RuntimeError) {
      io.err(`error: ${caught.code}: ${caught.message}`);
      return 1;
    }
    throw caught;
  }
}

/** Run a command for the installers: no shell, captured output, optional stdin, a hard timeout (a pip install can take minutes). */
const prodRun: Run = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: { ...process.env, ...opts?.env } as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20 * 60_000); // client policy: a first pip install on a slow link
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts?.input ?? "");
  });

async function eosCommand(args: string[], io: CliIo): Promise<number> {
  const sub = args[0];
  if (sub !== "status" && sub !== "install") {
    io.err(`error: unknown eos command; use eos status or eos install --yes [--gpu]\n${USAGE}`);
    return 1;
  }
  const lock = readEosOnnxLock();
  const env = io.env ?? (process.env as Record<string, string | undefined>);
  const cacheDir = managedCacheDir(env);
  const installed = installedEosOnnx(lock, cacheDir);
  const weights = lock.model.files.find((f) => f.path === lock.model.weights);
  const total = lock.model.files.reduce((n, f) => n + f.size, 0);

  if (sub === "status") {
    io.out(`Managed Eos claim-verification engine (ONNX Runtime, no PyTorch)`);
    io.out(`  cache:    ${cacheDir}`);
    io.out(`  model:    Decision-2.0-Eos-0.8B ${lock.model.variant} export (${lock.model.id}@${lock.model.revision.slice(0, 12)}, ${lock.model.license}), ${megabytes(total)}`);
    io.out(installed !== null ? `  state:    installed at ${installed.modelDir}` : `  state:    not installed — run: uktub-scholar eos install --yes   (add --gpu for onnxruntime-gpu)`);
    io.out(`  use:      set verification.engine: eos-onnx in config/chunking.yaml (or UKTUB_VERIFY_ENGINE=eos-onnx)`);
    return 0;
  }

  if (!args.includes("--yes")) {
    io.err(`eos install will download, verify (sha256 pinned in eos-onnx.lock.json) and set up in ${cacheDir}:`);
    io.err(`  ${lock.model.id} @ ${lock.model.revision.slice(0, 12)}, ${lock.model.variant} (${lock.model.license}): ${megabytes(total)} from huggingface.co`);
    io.err(`  a Python environment with ${(args.includes("--gpu") ? lock.python.gpu : lock.python.cpu).join(", ")} (wheels only, from PyPI)`);
    io.err(`Re-run with --yes to download.`);
    return 1;
  }
  try {
    const gpu = args.includes("--gpu");
    const r = await installEosOnnx({ lock, cacheDir, fetch: io.embedFetch ?? ((...a) => globalThis.fetch(...a)), run: prodRun, systemPython: env.UKTUB_EOS_ONNX_BOOTSTRAP_PYTHON ?? "python3", gpu });
    io.out(r.downloaded ? `Installed (downloaded, verified and self-checked: the worker started on the pinned weights${gpu ? ", GPU build" : ""}).` : `Already installed; nothing to download.`);
    io.out(`Select it with verification.engine: eos-onnx (config/chunking.yaml) or UKTUB_VERIFY_ENGINE=eos-onnx. The pinned weights digest: ${weights?.sha256.slice(0, 16)}…`);
    return 0;
  } catch (caught) {
    if (caught instanceof RuntimeError) {
      io.err(`error: ${caught.code}: ${caught.message}`);
      return 1;
    }
    throw caught;
  }
}

async function tectonicCommand(args: string[], io: CliIo): Promise<number> {
  const sub = args[0];
  if (sub !== "status" && sub !== "install") {
    io.err(`error: unknown tectonic command; use tectonic status or tectonic install --yes\n${USAGE}`);
    return 1;
  }
  const lock = readTectonicLock();
  const env = io.env ?? (process.env as Record<string, string | undefined>);
  const cacheDir = managedCacheDir(env);
  const platform = io.embedPlatform ?? platformKey();
  const asset = lock.tool.assets[platform];
  const installed = managedTectonicPath(lock, cacheDir, platform);

  if (sub === "status") {
    io.out(`Managed LaTeX engine`);
    io.out(`  cache:    ${cacheDir}`);
    io.out(asset === undefined ? `  platform: ${platform} — no build pinned; install tectonic yourself (PATH or UKTUB_TECTONIC_BIN)` : `  platform: ${platform} — tectonic ${lock.tool.version} (${lock.tool.license}), ${megabytes(asset.size)}`);
    io.out(installed !== null ? `  state:    installed at ${installed}` : `  state:    not installed${asset === undefined ? "" : " — run: uktub-scholar tectonic install --yes"}`);
    io.out(`  note:     tectonic fetches its TeX support bundle from the network on the first compile (about 1 minute, then cached by tectonic)`);
    return 0;
  }

  if (asset === undefined) {
    io.err(`error: no tectonic ${lock.tool.version} build is pinned for ${platform}; install tectonic yourself and put it on PATH or set UKTUB_TECTONIC_BIN`);
    return 1;
  }
  if (!args.includes("--yes")) {
    io.err(`tectonic install will download, verify (sha256 pinned in tectonic.lock.json) and unpack into ${cacheDir}:`);
    io.err(`  tectonic ${lock.tool.version} (${lock.tool.license}): ${megabytes(asset.size)} from ${asset.url}`);
    io.err(`Re-run with --yes to download.`);
    return 1;
  }
  try {
    const r = await installTectonic({
      lock,
      cacheDir,
      platform,
      fetch: io.embedFetch ?? ((...a) => globalThis.fetch(...a)),
      probe: async (binary) => {
        const { stdout, stderr } = await promisify(execFile)(binary, ["--version"], { timeout: 20_000 });
        return `${stdout}${stderr}`;
      },
    });
    io.out(r.downloaded ? `Installed tectonic ${lock.tool.version} (downloaded, verified and self-checked) at ${r.path}.` : `Already installed at ${r.path}; nothing to download.`);
    io.out(`compile_document now finds it automatically when no tectonic is on PATH.`);
    return 0;
  } catch (caught) {
    if (caught instanceof RuntimeError) {
      io.err(`error: ${caught.code}: ${caught.message}`);
      return 1;
    }
    throw caught;
  }
}

/**
 * How a host launches this package's MCP server: `node` plus the absolute bin of THIS copy. A bare `uktub-scholar` is on no PATH for a
 * source checkout or a project-local install (`pnpm exec` is not PATH), so every generated config would fail with ENOENT.
 */
const SERVER_LAUNCH = { command: "node", args: [BIN_PATH, "mcp"] } as const;

const ALLOWED_MCP_HOSTS = ["claude", "pi", "agy", "codex", "cursor", "opencode"] as const;
type McpHost = (typeof ALLOWED_MCP_HOSTS)[number];

function readJsonFile(filePath: string): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (!existsSync(filePath)) return { ok: true, data: {} };
  try {
    const raw = readFileSync(filePath, "utf8");
    if (raw.trim().length === 0) return { ok: true, data: {} }; // a touched, empty file is not a corrupt one
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: `${filePath} does not contain a JSON object` };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return { ok: false, error: `failed to parse ${filePath}: ${message}` };
  }
}

/** The host's server table: absent means start one; present but not an object is the user's data, so refuse rather than replace it. */
function serverTable(data: Record<string, unknown>, key: string, filePath: string): { ok: true; table: Record<string, unknown> } | { ok: false; error: string } {
  if (!(key in data)) return { ok: true, table: {} };
  const v = data[key];
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, error: `${filePath}: "${key}" is not an object; fix or remove it, then retry (it was left untouched)` };
  return { ok: true, table: v as Record<string, unknown> };
}

async function mcpInstallCommand(args: string[], io: CliIo): Promise<number> {
  const root = io.cwd ?? process.cwd();
  let host: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--host") {
      if (i + 1 >= args.length) {
        io.err(`error: option "--host" requires an argument\nusage: uktub-scholar mcp install [--host <claude|pi|agy|codex|cursor|opencode>]`);
        return 1;
      }
      host = args[++i];
    } else if (a.startsWith("--host=")) {
      host = a.slice("--host=".length);
    } else {
      io.err(`error: unknown option "${a}"\nusage: uktub-scholar mcp install [--host <claude|pi|agy|codex|cursor|opencode>]`);
      return 1;
    }
  }

  if (!host) {
    host = "claude";
  }

  if (!ALLOWED_MCP_HOSTS.includes(host as McpHost)) {
    io.err(`error: unknown host "${host}" — allowed hosts: ${ALLOWED_MCP_HOSTS.join(", ")}`);
    return 1;
  }

  switch (host) {
    case "claude":
    case "pi": {
      const target = join(root, ".mcp.json");
      const readResult = readJsonFile(target);
      if (!readResult.ok) {
        io.err(`error: ${readResult.error}`);
        return 1;
      }
      const data = readResult.data;
      const table = serverTable(data, "mcpServers", target);
      if (!table.ok) {
        io.err(`error: ${table.error}`);
        return 1;
      }
      const mcpServers = table.table;
      mcpServers["uktub-scholar"] = { command: SERVER_LAUNCH.command, args: [...SERVER_LAUNCH.args] };
      data.mcpServers = mcpServers;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(data, null, 2) + "\n", "utf8");
      io.out(`Wrote MCP server configuration for ${host} to .mcp.json`);
      return 0;
    }
    case "agy": {
      const target = join(root, ".agents", "mcp_config.json");
      const readResult = readJsonFile(target);
      if (!readResult.ok) {
        io.err(`error: ${readResult.error}`);
        return 1;
      }
      const data = readResult.data;
      const table = serverTable(data, "mcpServers", target);
      if (!table.ok) {
        io.err(`error: ${table.error}`);
        return 1;
      }
      const mcpServers = table.table;
      mcpServers["uktub-scholar"] = { command: SERVER_LAUNCH.command, args: [...SERVER_LAUNCH.args] };
      data.mcpServers = mcpServers;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(data, null, 2) + "\n", "utf8");
      io.out(`Wrote MCP server configuration for agy to .agents/mcp_config.json`);
      return 0;
    }
    case "cursor": {
      const target = join(root, ".cursor", "mcp.json");
      const readResult = readJsonFile(target);
      if (!readResult.ok) {
        io.err(`error: ${readResult.error}`);
        return 1;
      }
      const data = readResult.data;
      const table = serverTable(data, "mcpServers", target);
      if (!table.ok) {
        io.err(`error: ${table.error}`);
        return 1;
      }
      const mcpServers = table.table;
      mcpServers["uktub-scholar"] = { command: SERVER_LAUNCH.command, args: [...SERVER_LAUNCH.args] };
      data.mcpServers = mcpServers;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(data, null, 2) + "\n", "utf8");
      io.out(`Wrote MCP server configuration for cursor to .cursor/mcp.json`);
      return 0;
    }
    case "opencode": {
      const target = join(root, "opencode.json");
      const readResult = readJsonFile(target);
      if (!readResult.ok) {
        io.err(`error: ${readResult.error}`);
        return 1;
      }
      const data = readResult.data;
      const table = serverTable(data, "mcp", target);
      if (!table.ok) {
        io.err(`error: ${table.error}`);
        return 1;
      }
      const mcp = table.table;
      mcp["uktub-scholar"] = { type: "local", command: [SERVER_LAUNCH.command, ...SERVER_LAUNCH.args] };
      data.mcp = mcp;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(data, null, 2) + "\n", "utf8");
      io.out(`Wrote MCP server configuration for opencode to opencode.json`);
      return 0;
    }
    case "codex": {
      const target = join(root, ".codex", "config.toml");
      const snippet = `[mcp_servers.uktub-scholar]\ncommand = ${JSON.stringify(SERVER_LAUNCH.command)}\nargs = [${SERVER_LAUNCH.args.map((a) => JSON.stringify(a)).join(", ")}]\n`;
      let existing = "";
      if (existsSync(target)) {
        existing = readFileSync(target, "utf8");
      }
      if (/^\s*\[mcp_servers\.(?:uktub-scholar|"uktub-scholar")\]/m.test(existing)) {
        io.out(`MCP server configuration for codex is already in .codex/config.toml; left unchanged.`);
        return 0;
      }
      const content = existing.length > 0 ? (existing.endsWith("\n") ? existing : existing + "\n") + "\n" + snippet : snippet;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
      io.out(`Wrote MCP server configuration for codex to .codex/config.toml:\n\n${snippet}`);
      return 0;
    }
    default:
      return 1;
  }
}

async function mcpCommand(args: string[], io: CliIo): Promise<number> {
  if (args[0] === "install") {
    return await mcpInstallCommand(args.slice(1), io);
  }

  let targetDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dir") {
      if (i + 1 >= args.length) {
        io.err(`error: option "--dir" requires an argument\nusage: uktub-scholar mcp [dir] [--dir <path>]`);
        return 1;
      }
      targetDir = args[++i];
    } else if (a.startsWith("--dir=")) {
      targetDir = a.slice("--dir=".length);
    } else if (!a.startsWith("-")) {
      targetDir = a;
    } else {
      io.err(`error: unknown option "${a}"\nusage: uktub-scholar mcp [dir] [--dir <path>]`);
      return 1;
    }
  }

  const baseDir = io.cwd ?? process.cwd();
  let effectiveDir: string;
  if (targetDir !== undefined) {
    if (targetDir.split(/[\\/]/).includes("..")) {
      effectiveDir = targetDir;
    } else {
      effectiveDir = isAbsolute(targetDir) ? targetDir : resolve(baseDir, targetDir);
    }
  } else {
    effectiveDir = baseDir;
  }

  const confinement = validateTargetDir(effectiveDir);
  if (!confinement.ok) {
    io.err(`error: ${renderRefusal({ code: confinement.code, message: confinement.message })}`);
    return 1;
  }

  const server = createMcpServer({
    targetDir: effectiveDir,
    fetch: io.fetch,
    env: io.env,
    download: io.download,
  });

  const transport = io.mcpTransport ?? new StdioServerTransport();
  await server.connect(transport);
  // Installed in the same tick as connect(), before any stdin callback can deliver the first message. stderr: stdout is the protocol.
  if (handshakeTraceEnabled(io.env ?? process.env)) traceHandshake(transport, io.err);
  return 0;
}

/** One CLI run: returns the process exit code (0 success, 1 refusal/error).
 * Async because `compile` spawns the engine; callers await. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const out = io.out;
  const err = io.err;
  const root = io.cwd ?? process.cwd();
  const [command, ...args] = argv;

  // Help: `help`, or --help/-h anywhere except in the free-text commands (a claim or a query may contain the word).
  if (command === "help" || (command !== "verify" && command !== "search" && argv.some((a) => a === "--help" || a === "-h"))) {
    out(USAGE);
    return 0;
  }

  try {
    switch (command) {
      case "init": {
        const enclosing = findEnclosingProject(root);
        if (enclosing) {
          err(
            `error: ${enclosing} already contains a uktub-scholar registry — nested projects are not supported\nrun commands from that project root instead`,
          );
          return 1;
        }
        const db = createRegistry(root);
        db.close();
        out(`Initialized registry at ${root}/.registry/registry.db (refs/references.bib rendered).`);
        return 0;
      }
      case "deregister": {
        if (args.length === 0) {
          err(`error: deregister needs at least one DOI or citekey\n${USAGE}`);
          return 1;
        }
        const db = openRegistry(root);
        try {
          const result = deregisterPapers(db, args);
          for (const removed of result.removed) {
            out(`removed ${removed.citekey} (${removed.doi}) — ${removed.title}`);
          }
          for (const missing of result.missing) {
            // A missing identifier is an outcome, not a refusal: the registry
            // is unchanged and the command itself succeeded (R7 boundary).
            out(`missing ${missing} — no paper matches this DOI or citekey`);
          }
          return 0;
        } finally {
          db.close();
        }
      }
      case "sync-bib": {
        const db = openRegistry(root);
        try {
          const { syncedCount } = syncBibliography(db);
          out(`Rendered ${syncedCount} entr${syncedCount === 1 ? "y" : "ies"} to refs/references.bib.`);
        } finally {
          db.close();
        }
        return 0;
      }
      case "help":
      case "--help":
      case "-h":
        out(USAGE);
        return 0;
      case "list": {
        const db = openRegistry(root);
        try {
          const rows = listPapers(db);
          if (rows.length === 0) {
            out("No papers in the registry. Register with `uktub-scholar register <id>` or an agent's paper_registry tool.");
            return 0;
          }
          out(["citekey", "year", "title", "venue", "citable", "via"].join("\t"));
          for (const row of rows) {
            out(
              [
                row.citekey,
                row.year ?? "-",
                row.title,
                row.venue ?? "-",
                row.citable ? "yes" : "no",
                row.bibtexSource ? `via ${row.bibtexSource}` : "-",
              ].join("\t"),
            );
          }
        } finally {
          db.close();
        }
        return 0;
      }
      case "review": {
        let entry: string | undefined;
        let outPath: string | undefined;
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--out") { outPath = args[++i]; if (outPath === undefined) { err(`error: --out needs a path\n${USAGE}`); return 1; } }
          else if (entry === undefined && !String(args[i]).startsWith("--")) entry = args[i];
          else { err(`error: unexpected argument ${args[i]}\n${USAGE}`); return 1; }
        }
        const outcome = reviewManuscript({ root, entry, out: outPath, now: io.now ?? (() => new Date()) });
        if (!outcome.ok) { err(`error: ${outcome.message}`); return 1; }
        for (const l of outcome.summary) out(l);
        return 0;
      }
      case "compile": {
        const [entry] = args;
        const outcome = await compileDocument(
          {
            root,
            env: io.env ?? (process.env as Record<string, string | undefined>),
            spawn: prodSpawn,
          },
          entry,
        );
        if (outcome.kind === "refusal") {
          err(`error: ${renderRefusal({ code: outcome.code, message: outcome.message })}`);
          return 1;
        }
        out(describeOutcome(outcome));
        return outcome.kind === "compiled" ? 0 : 1;
      }
      case "register": {
        if (args.length === 0) {
          err(`error: register needs at least one DOI or arxiv:ID\n${USAGE}`);
          return 1;
        }
        return reportTool(await paperRegistryTool(toolContext(io, root), { action: "register", identifiers: args } as PaperRegistryArgs), io);
      }
      case "attach": {
        const [handle, file] = args;
        if (!handle || !file || args.length !== 2) {
          err(`error: attach needs a DOI or citekey and one file\n${USAGE}`);
          return 1;
        }
        return reportTool(await paperRegistryTool(toolContext(io, root), { action: "attach_source", attachments: [{ handle, path: file }] } as PaperRegistryArgs), io);
      }
      case "verify": {
        const parsed = parseVerifyArgs(args);
        if (parsed === null) {
          err(`error: verify needs a claim\n${USAGE}`);
          return 1;
        }
        return reportTool(await verifyClaimTool(toolContext(io, root), parsed, io.verifyHooks), io);
      }
      case "search": {
        const parsed = parseSearchArgs(args);
        if (parsed === null) {
          err(`error: search needs a query\n${USAGE}`);
          return 1;
        }
        return reportTool(await searchPassagesTool(toolContext(io, root), parsed), io);
      }
      case "embed":
        return await embedCommand(args, io);
      case "eos":
        return await eosCommand(args, io);
      case "tectonic":
        return await tectonicCommand(args, io);
      case "mcp":
        return await mcpCommand(args, io);
      default:
        err(command === undefined ? USAGE : `error: unknown command "${command}"\n${USAGE}`);
        return 1;
    }
  } catch (caught) {
    if (caught instanceof RegistryError) {
      // The same refusal rendering the agent tools use (R7 parity).
      err(`error: ${renderRefusal({ code: caught.code, message: caught.message })}`);
    } else {
      err(`error: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
    return 1;
  }
}

/* eslint-disable no-console -- console is the CLI's user interface. */
/** The process entry: run the CLI on the real console and set the exit code. Used by the bin shim and by direct execution. */
export async function main(argv: string[]): Promise<void> {
  try {
    process.exitCode = await runCli(argv, { out: console.log, err: console.error });
  } catch (e: unknown) {
    console.error(`uktub-scholar: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main(process.argv.slice(2));
}
