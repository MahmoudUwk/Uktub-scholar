/**
 * The registry side of the provenance audit: every paper's captured text and the verify ledger. The ledger is the package's own
 * record of what `verify` supported (`verify_runs` holds a hash of each claim, `claim_evidence` the supporting spans), so whether a
 * manuscript statement was verified never depends on a file the agent writes. Retention and staleness are the store's: runs live
 * 24 hours, and evidence whose source was replaced is not returned.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Ledger, LedgerHit, PaperInput } from "./audit.ts";
import { RUN_TTL_MS, claimHashOf, evidenceOfRun, formatPointer } from "../verify/store.ts";

export function readProvenanceInputs(db: DatabaseSync, now: Date): { papers: PaperInput[]; ledger: Ledger } {
  const rows = db
    .prepare("SELECT p.doi AS doi, p.citekey AS citekey, p.title AS title, s.text AS text FROM papers p LEFT JOIN paper_sources s ON s.doi = p.doi AND s.status = 'ready' ORDER BY p.citekey")
    .all() as Array<{ doi: string; citekey: string; title: string; text: string | null }>;
  const papers: PaperInput[] = rows.map((r) => ({ doi: r.doi, citekey: r.citekey, title: r.title, text: r.text }));

  const runsOf = db.prepare("SELECT run_id, created_at FROM verify_runs WHERE claim_hash = ?");
  const oldest = now.getTime() - RUN_TTL_MS;
  const ledger: Ledger = (variants) => {
    const pointers = new Set<string>();
    const dois = new Set<string>();
    for (const hash of new Set(variants.map(claimHashOf))) {
      for (const run of runsOf.all(hash) as Array<{ run_id: string; created_at: string }>) {
        if (Date.parse(run.created_at) < oldest) continue;
        for (const e of evidenceOfRun(db, run.run_id)) {
          if (e.pTrue < e.minConfidence) continue;
          pointers.add(formatPointer(e.doi, e.revision, e.start, e.end));
          dois.add(e.doi);
        }
      }
    }
    return pointers.size === 0 ? null : ({ pointers: [...pointers].sort(), dois: [...dois].sort() } satisfies LedgerHit);
  };
  return { papers, ledger };
}
