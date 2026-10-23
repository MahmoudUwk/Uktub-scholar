/**
 * Provenance audit of a project: its manuscript (the entry and what it `\input`s) against its registry. Read-only, never throws:
 * a project without a registry, an unreadable manuscript or a registry this build does not support is a reason, not an error.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sep } from "node:path";
import { resolveEntry } from "../compile/run.ts";
import { loadChunkConfig, DEFAULTS } from "../config.ts";
import { openRegistry } from "../registry.ts";
import { expandSource, parsePaper } from "../review/latex.ts";
import { resolveProjectFile } from "../tools/context.ts";
import { DEFAULT_MIN_CONFIDENCE } from "../verify/claim.ts";
import { auditProvenance, type ProvenanceAudit } from "./audit.ts";
import { readProvenanceInputs } from "./read.ts";
import { collectResultLines } from "./results.ts";

/** Client policy: largest manuscript file read for the audit (the review command's limit). */
const MAX_FILE_BYTES = 4_000_000;

export interface ProvenanceInput {
  root: string;
  entry?: string;
  now: () => Date;
  /** The confidence bar `verified` is read under; defaults to the verify default (client policy). */
  minConfidence?: number;
  /** Injected environment for config resolution (a named chunk config); absent: the default path. */
  env?: Record<string, string | undefined>;
}
export type ProvenanceOutcome = { ok: true; entry: string; digest: string; audit: ProvenanceAudit } | { ok: false; message: string };

export function runProvenance(i: ProvenanceInput): ProvenanceOutcome {
  try {
    const entry = resolveEntry(i.root, i.entry);
    if (!entry.ok) return { ok: false, message: entry.message };
    const entryRel = entry.rel.split(sep).join("/");
    const lines = expandSource((rel) => {
      const f = resolveProjectFile(i.root, rel, MAX_FILE_BYTES);
      return f.ok ? readFileSync(f.abs, "utf8") : undefined;
    }, entryRel);
    if (lines.length === 0) return { ok: false, message: `${entryRel} could not be read inside the project` };
    const expanded = lines.map((l) => l.text).join("\n");
    const digest = createHash("sha256").update(expanded, "utf8").digest("hex");
    const db = (() => {
      try {
        return openRegistry(i.root);
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
      }
    })();
    if (db instanceof Error) return { ok: false, message: `no usable registry: ${db.message}` };
    try {
      const { papers, ledger } = readProvenanceInputs(db, i.minConfidence ?? DEFAULT_MIN_CONFIDENCE);
      // The computed-results search: figures no registered paper is cited for are looked up in the project's
      // result files. An unreadable or invalid config keeps the default glob — the audit stays read-only and total.
      let resultsGlob = DEFAULTS.provenance.results_glob;
      try {
        resultsGlob = loadChunkConfig(i.root, { env: i.env ?? {} }).provenance.results_glob;
      } catch {
        // keep the default
      }
      const audit = auditProvenance({ paper: parsePaper(lines), tex: expanded, papers, ledger, results: collectResultLines(i.root, resultsGlob) });
      return { ok: true, entry: entryRel, digest, audit };
    } finally {
      db.close();
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
