/**
 * Single refusal table (KTD6). Two classes:
 *  - refusal class: rendered to the model as `Refused: CODE — <message>. Next: <next>.`
 *  - warning class: attached to SUCCESSFUL outcomes (never rendered as refusals).
 * `code` and `next` are stable and test-pinned (R7, R18); `message` is free-form.
 * Completeness is enforced by a static scan over `src/` (tests/refusals.spec.ts, U4).
 */

export type RefusalCode =
  | "REGISTRY_NOT_INITIALIZED"
  | "REGISTRY_CORRUPT"
  | "REGISTRY_SCHEMA_UNSUPPORTED"
  | "REGISTRY_BUSY"
  | "INVALID_DOI"
  | "DOI_NOT_FOUND"
  | "QUERY_REQUIRED"
  | "PATH_REFUSED"
  | "SEARCH_UNAVAILABLE"
  | "BATCH_TOO_LARGE"
  | "PI_EXTENSION_API_UNAVAILABLE";

export type WarningCode = "BIBTEX_UNAVAILABLE" | "DOI_TITLE_MISMATCH";

export interface RefusalEntry {
  /** Stable `next` hint shown to the model. Never changes per code. */
  next: string;
}

export const REFUSALS: Record<RefusalCode, RefusalEntry> = {
  REGISTRY_NOT_INITIALIZED: {
    next: "run `uktub-scholar init` in the project root, then retry",
  },
  REGISTRY_CORRUPT: {
    next: "the registry file is not a valid SQLite database; restore it from backup or delete it and run `uktub-scholar init` (papers are lost)",
  },
  REGISTRY_SCHEMA_UNSUPPORTED: {
    next: "the registry was created by a different schema version; upgrade the package or restore a matching registry",
  },
  REGISTRY_BUSY: {
    next: "another process holds the registry write lock; retry after it finishes",
  },
  INVALID_DOI: {
    next: "check the identifier — DOIs look like 10.xxxx/suffix; bare arXiv IDs are not DOIs, use their 10.48550/arxiv.XXXX.NNNNN form",
  },
  DOI_NOT_FOUND: {
    next: "verify the DOI resolves (doi.org) or re-run search_papers and register from the result's DOI",
  },
  QUERY_REQUIRED: {
    next: "provide a search query — search_papers requires non-empty query text",
  },
  PATH_REFUSED: {
    next: "operate inside the project directory; .registry and .git are protected system segments and path traversal is refused",
  },
  SEARCH_UNAVAILABLE: {
    next: "retry later; no scholarly provider answered — check network connectivity or provider status",
  },
  BATCH_TOO_LARGE: {
    next: "split the batch: at most 50 DOIs per register_papers call",
  },
  PI_EXTENSION_API_UNAVAILABLE: {
    next: "upgrade Pi to >= 1.0.0, which exposes pi.registerTool",
  },
};

export const WARNINGS: Record<WarningCode, RefusalEntry> = {
  BIBTEX_UNAVAILABLE: {
    next: "paper registered but will not appear in references.bib; retry registration later — a citable re-register upgrades the row without moving the citekey",
  },
  DOI_TITLE_MISMATCH: {
    next: "provider metadata disagrees on this DOI's title; verify you registered the intended paper",
  },
};

/** Rendered refusal shape: everything a host needs to fail a tool call (R7). */
export interface Refused {
  code: RefusalCode;
  /** Free-form what-happened text; only `code` and `next` are stable (KTD6). */
  message: string;
}

/**
 * The one refusal rendering (KTD6): `Refused: CODE — <message>. Next: <next>.`
 * The code and next text are byte-stable per code; the message is free-form.
 */
export function renderRefusal(refused: Refused): string {
  return `Refused: ${refused.code} — ${refused.message}. Next: ${REFUSALS[refused.code].next}.`;
};
