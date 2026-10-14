/**
 * Provenance audit of a project: its manuscript (the entry and what it `\input`s) against its registry. Read-only, never throws:
 * a project without a registry, an unreadable manuscript or a registry this build does not support is a reason, not an error.
 */
import { readFileSync } from "node:fs";
import { sep } from "node:path";
import { resolveEntry } from "../compile/run.ts";
import { openRegistry } from "../registry.ts";
import { expandSource, parsePaper } from "../review/latex.ts";
import { resolveProjectFile } from "../tools/context.ts";
import { auditProvenance, type ProvenanceAudit } from "./audit.ts";
import { readProvenanceInputs } from "./read.ts";

/** Client policy: largest manuscript file read for the audit (the review command's limit). */
const MAX_FILE_BYTES = 4_000_000;

export interface ProvenanceInput { root: string; entry?: string; now: () => Date }
export type ProvenanceOutcome = { ok: true; entry: string; audit: ProvenanceAudit } | { ok: false; message: string };

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
    const db = (() => {
      try {
        return openRegistry(i.root);
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
      }
    })();
    if (db instanceof Error) return { ok: false, message: `no usable registry: ${db.message}` };
    try {
      const { papers, ledger } = readProvenanceInputs(db, i.now());
      const audit = auditProvenance({ paper: parsePaper(lines), tex: lines.map((l) => l.text).join("\n"), papers, ledger });
      return { ok: true, entry: entryRel, audit };
    } finally {
      db.close();
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
