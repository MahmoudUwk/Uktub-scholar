/**
 * Node-free document-unit status: the verdict a `verify` document-mode unit
 * may carry. Kept here (no imports at all) so `src/agent/` typechecks under
 * a browser-only config; re-exported from its old homes
 * (`src/core/verify/document.ts`, `src/core/tools/verify.ts`) unchanged.
 */
export type DocumentUnitStatus = "supported" | "cited-unsupported" | "missing-citation" | "unsourced" | "unregistered" | "skipped" | "table-row";
