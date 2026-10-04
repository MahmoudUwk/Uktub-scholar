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

import { RegistryError, createRegistry, deregisterPapers, findEnclosingProject, listPapers, openRegistry, syncBibliography } from "../core/registry.ts";
import { compileDocument, describeOutcome, prodSpawn } from "../core/compile/run.ts";
import { renderRefusal } from "../core/refusals.ts";
import { WriteQueue } from "../core/queue.ts";
import { createSafeDownloader } from "../core/source/download.ts";
import { paperRegistryTool, type PaperRegistryArgs } from "../core/tools/registry.ts";
import type { ToolContext, ToolResult } from "../core/tools/context.ts";
import { verifyClaimTool, type VerifyClaimArgs, type VerifyHooks } from "../core/tools/verify.ts";

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
                                find supporting passages for ONE claim (default: all papers)`;

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
