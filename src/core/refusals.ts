/**
 * Single refusal table (KTD6). Two classes:
 *  - refusal class: rendered to the model as `Refused: CODE — <message>. Next: <next>.`
 *  - warning class: attached to SUCCESSFUL outcomes (never rendered as refusals).
 * `code` and `next` are stable; `message` is free-form. Typed table keys
 * enforce completeness; tests cover non-empty hints and the rendered envelope.
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
  | "COMPILE_ENGINE_MISSING"
  | "COMPILE_NO_ENTRY"
  | "COMPILE_TIMEOUT"
  | "VERIFY_ENGINE_MISSING"
  | "CONFIG_INVALID"
  | "ARGUMENT_INVALID"
  | "CONTINUATION_INVALID"
  | "SOURCE_UNUSABLE";

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
    next: "check the identifier — DOIs look like 10.xxxx/suffix; write arXiv papers as arxiv:YYMM.NNNNN or their 10.48550/arxiv.YYMM.NNNNN form",
  },
  DOI_NOT_FOUND: {
    next: "verify the DOI resolves (doi.org), or re-run search_papers and register that result with paper_registry",
  },
  QUERY_REQUIRED: {
    next: "provide a search query — search_papers requires non-empty query text",
  },
  PATH_REFUSED: {
    next: "use a file inside the project directory; .registry and .git are protected system segments, and traversal, symlink escapes and non-files are refused",
  },
  SEARCH_UNAVAILABLE: {
    next: "retry later; no scholarly provider answered — check network connectivity or provider status",
  },
  BATCH_TOO_LARGE: {
    next: "split the batch into calls within the limit named in the message",
  },
  COMPILE_ENGINE_MISSING: {
    next: "install tectonic (tectonic-typesetting.github.io) or set UKTUB_TECTONIC_BIN to the binary path, then retry",
  },
  COMPILE_NO_ENTRY: {
    next: "create manuscript/main.tex or pass entry with the project-relative .tex file to compile",
  },
  COMPILE_TIMEOUT: {
    next: "simplify the document or raise the budget via UKTUB_COMPILE_TIMEOUT_S (seconds), then retry",
  },
  VERIFY_ENGINE_MISSING: {
    next: "start the verification engine (OpenRouter needs OPENROUTER_API_KEY; engine llama-cpp needs UKTUB_VERIFY_URL pointing at a local System One server) or switch verification.engine in config/chunking.yaml, then retry",
  },
  CONFIG_INVALID: {
    next: "fix the reported key in config/chunking.yaml (or the file named by UKTUB_CHUNK_CONFIG), then retry",
  },
  ARGUMENT_INVALID: {
    next: "fix the named argument and retry; the message lists what the action accepts",
  },
  CONTINUATION_INVALID: {
    next: "the continuation token does not match this request or the registry changed; repeat the request without a token",
  },
  SOURCE_UNUSABLE: {
    next: "attach a text-based PDF or GROBID TEI of this exact paper (image-only scans need OCR first), or retry once an open-access copy exists",
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
