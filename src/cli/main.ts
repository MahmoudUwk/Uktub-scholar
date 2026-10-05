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
import { dirname, join } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { RegistryError, createRegistry, deregisterPapers, findEnclosingProject, listPapers, openRegistry, syncBibliography } from "../core/registry.ts";
import { compileDocument, describeOutcome, prodSpawn } from "../core/compile/run.ts";
import { renderRefusal } from "../core/refusals.ts";
import { WriteQueue } from "../core/queue.ts";
import { createSafeDownloader } from "../core/source/download.ts";
import { paperRegistryTool, type PaperRegistryArgs } from "../core/tools/registry.ts";
import type { ToolContext, ToolResult } from "../core/tools/context.ts";
import { verifyClaimTool, type VerifyClaimArgs, type VerifyHooks } from "../core/tools/verify.ts";
import { searchPassagesTool, type SearchPassagesArgs } from "../core/tools/passages.ts";
import { managedCacheDir } from "../core/embed/config.ts";
import { RuntimeError, installRuntime, installedPaths, platformKey, readLock, type RuntimeLock } from "../core/embed/runtime.ts";
import { createMcpServer, validateTargetDir } from "../mcp/server.ts";

/** Injected I/O: the bin passes console writers; tests capture arrays. */
export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Project root; defaults to process.cwd() — the bin passes nothing. */
  cwd?: string;
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

const ALLOWED_MCP_HOSTS = ["claude", "pi", "agy", "codex", "cursor", "opencode"] as const;
type McpHost = (typeof ALLOWED_MCP_HOSTS)[number];

function readJsonFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function mcpInstallCommand(args: string[], io: CliIo): Promise<number> {
  const root = io.cwd ?? process.cwd();
  let host: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--host" && i + 1 < args.length) {
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
      const data = readJsonFile(target);
      const mcpServers = (typeof data.mcpServers === "object" && data.mcpServers !== null && !Array.isArray(data.mcpServers))
        ? (data.mcpServers as Record<string, unknown>)
        : {};
      mcpServers["uktub-scholar"] = {
        command: "uktub-scholar",
        args: ["mcp"],
      };
      data.mcpServers = mcpServers;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(data, null, 2) + "\n", "utf8");
      io.out(`Wrote MCP server configuration for ${host} to .mcp.json`);
      return 0;
    }
    case "agy": {
      const target = join(root, ".agents", "mcp_config.json");
      const data = readJsonFile(target);
      const mcpServers = (typeof data.mcpServers === "object" && data.mcpServers !== null && !Array.isArray(data.mcpServers))
        ? (data.mcpServers as Record<string, unknown>)
        : {};
      mcpServers["uktub-scholar"] = {
        command: "uktub-scholar",
        args: ["mcp"],
      };
      data.mcpServers = mcpServers;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(data, null, 2) + "\n", "utf8");
      io.out(`Wrote MCP server configuration for agy to .agents/mcp_config.json`);
      return 0;
    }
    case "cursor": {
      const target = join(root, ".cursor", "mcp.json");
      const data = readJsonFile(target);
      const mcpServers = (typeof data.mcpServers === "object" && data.mcpServers !== null && !Array.isArray(data.mcpServers))
        ? (data.mcpServers as Record<string, unknown>)
        : {};
      mcpServers["uktub-scholar"] = {
        command: "uktub-scholar",
        args: ["mcp"],
      };
      data.mcpServers = mcpServers;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(data, null, 2) + "\n", "utf8");
      io.out(`Wrote MCP server configuration for cursor to .cursor/mcp.json`);
      return 0;
    }
    case "opencode": {
      const target = join(root, "opencode.json");
      const data = readJsonFile(target);
      const mcp = (typeof data.mcp === "object" && data.mcp !== null && !Array.isArray(data.mcp))
        ? (data.mcp as Record<string, unknown>)
        : {};
      mcp["uktub-scholar"] = {
        type: "local",
        command: ["uktub-scholar", "mcp"],
      };
      data.mcp = mcp;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(data, null, 2) + "\n", "utf8");
      io.out(`Wrote MCP server configuration for opencode to opencode.json`);
      return 0;
    }
    case "codex": {
      const target = join(root, ".codex", "config.toml");
      const snippet = `[mcp_servers.uktub-scholar]\ncommand = "uktub-scholar"\nargs = ["mcp"]\n`;
      let existing = "";
      if (existsSync(target)) {
        existing = readFileSync(target, "utf8");
      }
      if (!existing.includes("[mcp_servers.uktub-scholar]")) {
        const content = existing.length > 0 ? (existing.endsWith("\n") ? existing : existing + "\n") + "\n" + snippet : snippet;
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
      }
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
    if (a === "--dir" && i + 1 < args.length) {
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

  const effectiveDir = targetDir ?? io.cwd ?? process.cwd();
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
  return 0;
}

/** One CLI run: returns the process exit code (0 success, 1 refusal/error).
 * Async because `compile` spawns the engine; callers await. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const out = io.out;
  const err = io.err;
  const root = io.cwd ?? process.cwd();
  const [command, ...args] = argv;

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
      case "compile": {
        const [entry] = args;
        const outcome = await compileDocument(
          {
            root,
            env: process.env as Record<string, string | undefined>,
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
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runCli(process.argv.slice(2), { out: console.log, err: console.error }).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(`uktub-scholar: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
