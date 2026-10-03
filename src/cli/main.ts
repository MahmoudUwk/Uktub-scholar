/**
 * uktub-scholar CLI (U6, R17): the human owns init, removal, bibliography healing,
 * and listing. Every registry operation goes through src/core/registry.ts —
 * the CLI is a second caller of the exact functions the agent tools use
 * (structural parity), so no behavior can drift between the two paths.
 *
 * Arg parsing is by hand (zero dependencies). `console` is the CLI's user
 * interface — the one place in src/ allowed to touch it (the bin shim spawns
 * this file; `runCli` itself takes injected writers so tests import it
 * directly).
 */

import { RegistryError, createRegistry, deregisterPapers, findEnclosingProject, listPapers, openRegistry, syncBibliography } from "../core/registry.ts";
import { compileDocument, describeOutcome, prodSpawn } from "../core/compile/run.ts";
import { renderRefusal } from "../core/refusals.ts";

/** Injected I/O: the bin passes console writers; tests capture arrays. */
export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Project root; defaults to process.cwd() — the bin passes nothing. */
  cwd?: string;
}

const USAGE = `usage: uktub-scholar <command>

commands:
  init                          create the registry and an empty refs/references.bib
  deregister <doi|citekey>...   remove papers (cascade + re-render); by DOI or citekey
  sync-bib                      re-render refs/references.bib from the registry
  list                          print registered papers in citekey order
  compile [entry.tex]           compile with tectonic (PDF in build/); entry defaults
                                to manuscript/main.tex, then main.tex, then a lone .tex
  verify <doi> <claim>...       verify claims against a paper's chunks with the
                                configured engine (default mercury via OpenRouter)
  trace <doc-id>                show verified claims of a document → paper → chunk refs`;

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
            out("No papers in the registry. Register with an agent's register_papers tool.");
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
      case "verify": {
        const [doi, ...claims] = args;
        if (!doi || claims.length === 0) {
          err(`error: verify needs a DOI and at least one claim\n${USAGE}`);
          return 1;
        }
        const { runVerifyClaims } = await import("../core/tools/verify.ts");
        try {
          const structured = await runVerifyClaims(
            { root, env: process.env as Record<string, string | undefined> },
            { doi, claims },
          );
          for (const r of structured.results) {
            out(`${r.verdict.toUpperCase()} (p=${r.confidence.toFixed(3)}, chunk ${r.bestChunkIndex ?? "-"}): ${r.claim}`);
          }
          out(`engine: ${structured.model}`);
          return 0;
        } catch (e) {
          err(`error: ${(e as Error).message}`);
          return 1;
        }
      }
      case "trace": {
        const [docId] = args;
        if (!docId) {
          err(`error: trace needs a document id\n${USAGE}`);
          return 1;
        }
        const db = openRegistry(root);
        try {
          const { traceDocument } = await import("../core/verify/store.ts");
          const rows = traceDocument(db, docId);
          if (rows.length === 0) {
            out(`No verified claims recorded for document "${docId}".`);
            return 0;
          }
          for (const r of rows) {
            out(
              [
                r.claim_text,
                `  → ${r.verdict} (${r.confidence.toFixed(3)} via ${r.model} @ ${r.min_confidence})`,
                `  → ${r.citekey} — ${r.title}`,
                `  → ${r.chunk_id} chars ${r.char_start}–${r.char_end}${r.evidence_quote ? `\n  → "${r.evidence_quote}"` : ""}`,
              ].join("\n"),
            );
          }
          return 0;
        } finally {
          db.close();
        }
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
