-- The uktub-scholar registry: one self-contained SQLite file at
-- `.registry/registry.db` beside the LaTeX project (R9). Journal mode stays
-- DELETE (set at open in registry.ts): one file is the whole registry, and
-- backup = copy one file (KTD2).
--
-- Minimal v0 schema (KTD4, R10): a single table; every column has a named v0
-- consumer. Everything the product schema carried without one — source_digest,
-- acquisition_*, verification_*, citation_count, abstract, and the
-- chunks/fts_chunks/claims/paper_summaries/workflow tables — is dropped.
--
-- `doi` is the PRIMARY KEY: v0 registration is DOI-only (KTD8), DOIs are
-- case-insensitive, and the canonical lowercase form is what makes the
-- uniqueness meaningful.

CREATE TABLE IF NOT EXISTS papers (
  -- Identity + dedupe (R5); the \cite source of truth.
  doi TEXT PRIMARY KEY,
  -- \cite target (R11), pinned once at first registration, never recomputed;
  -- list_papers order (R6).
  citekey TEXT NOT NULL UNIQUE,
  -- list_papers display; registration title-match warning (KTD8).
  title TEXT NOT NULL,
  -- Citekey generation (R11); list_papers display.
  authors_json TEXT NOT NULL,
  -- Citekey generation; list_papers display.
  year INTEGER,
  -- list_papers display.
  venue TEXT,
  -- references.bib entry body; NULL (or a head the render cannot re-key)
  -- means uncitable (R13). BibTeX is never synthesized or repaired.
  provider_bibtex TEXT,
  -- Provenance of the BibTeX pair, displayed as "via crossref"/"via datacite";
  -- stored only alongside citable BibTeX.
  bibtex_source TEXT,
  -- Eligibility marker in every tool result (R12, R13): 1 only when the row
  -- holds re-keyable provider BibTeX. Only improves (MAX rule, KTD8).
  citable INTEGER NOT NULL DEFAULT 0,
  -- The only clock value in the registry (KTD6): last-write time, injected.
  ingested_at TEXT NOT NULL
);

PRAGMA user_version = 1;
