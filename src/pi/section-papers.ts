/**
 * Pi-only section paper readiness (W1): resolve each assigned handle against
 * the registry and report whether its full text is ready. Read-only: no
 * acquisition, no ToolContext, no fetch. A RegistryError propagates to the
 * caller, which maps it to a `write_section refused` refusal.
 */
import { isAcquiring } from "../core/verify/acquire.ts";
import { openRegistry, resolveHandle } from "../core/registry.ts";
import { getSource } from "../core/verify/store.ts";
import type { SectionPaper } from "../agent/section-scope.ts";

/** Resolve each handle: unknown → not_registered; ready iff the source status is ready (passages rule); an in-flight fetch → acquiring. */
export async function readSectionPapers(root: string, handles: readonly string[]): Promise<SectionPaper[]> {
  const db = openRegistry(root);
  try {
    return handles.map((handle): SectionPaper => {
      const row = resolveHandle(db, handle);
      if (row === null) return { handle, citekey: null, doi: null, state: "not_registered", detail: null };
      const src = getSource(db, row.doi);
      if (src?.status === "ready") return { handle, citekey: row.citekey, doi: row.doi, state: "ready", detail: null };
      if (isAcquiring(root, row.doi)) return { handle, citekey: row.citekey, doi: row.doi, state: "acquiring", detail: null };
      if (src === null) return { handle, citekey: row.citekey, doi: row.doi, state: "metadata_only", detail: null };
      return { handle, citekey: row.citekey, doi: row.doi, state: src.status, detail: src.failureCode ?? src.failureDetail ?? src.status };
    });
  } finally {
    db.close();
  }
}
