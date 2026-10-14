/**
 * The registry side of the provenance audit: every paper's captured text and the durable verify ledger. The ledger
 * (`claim_ledger`) is the package's own record of what `verify` released to the agent, so whether a manuscript
 * statement was verified never depends on a file the agent writes. Retention is the store's: ledger rows live as
 * long as their paper and revision and never expire by time. `bar` is the currently configured confidence bar
 * (client policy, the same bar `verify` judges under): only rows at or above it verify.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Ledger, LedgerHit, PaperInput } from "./audit.ts";
import { DEFAULT_MIN_CONFIDENCE } from "../verify/claim.ts";
import { claimHashOf, formatPointer } from "../verify/store.ts";

export function readProvenanceInputs(db: DatabaseSync, bar: number = DEFAULT_MIN_CONFIDENCE): { papers: PaperInput[]; ledger: Ledger } {
  const rows = db
    .prepare("SELECT p.doi AS doi, p.citekey AS citekey, p.title AS title, s.text AS text FROM papers p LEFT JOIN paper_sources s ON s.doi = p.doi AND s.status = 'ready' ORDER BY p.citekey")
    .all() as Array<{ doi: string; citekey: string; title: string; text: string | null }>;
  const papers: PaperInput[] = rows.map((r) => ({ doi: r.doi, citekey: r.citekey, title: r.title, text: r.text }));

  const rowsOf = db.prepare(
    `SELECT l.doi AS doi, l.revision AS revision, l.char_start AS char_start, l.char_end AS char_end, l.p_true AS p_true
     FROM claim_ledger l JOIN paper_sources s ON s.doi = l.doi AND s.status = 'ready' AND s.revision = l.revision
     WHERE l.claim_hash = ?`,
  );
  const ledger: Ledger = (variants) => {
    const pointers = new Set<string>();
    const dois = new Set<string>();
    for (const hash of new Set(variants.map(claimHashOf))) {
      for (const e of rowsOf.all(hash) as Array<{ doi: string; revision: string; char_start: number; char_end: number; p_true: number }>) {
        if (e.p_true < bar) continue;
        pointers.add(formatPointer(e.doi, e.revision, e.char_start, e.char_end));
        dois.add(e.doi);
      }
    }
    return pointers.size === 0 ? null : ({ pointers: [...pointers].sort(), dois: [...dois].sort() } satisfies LedgerHit);
  };
  return { papers, ledger };
}
