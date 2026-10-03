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

-- ── v2 additions: chunks + claim verdict cache + traceability pointers ──────
-- Every column names its consumer (AGENTS.md). Additive migration v1→v2 runs
-- this whole file (CREATE IF NOT EXISTS) inside one transaction in
-- registry.ts; user_version below is the migration's final statement.

CREATE TABLE IF NOT EXISTS chunks (
  -- Owner paper; deregister cascades (paper removal removes its chunks).
  doi          TEXT    NOT NULL REFERENCES papers(doi) ON DELETE CASCADE,
  -- Emission order (0-based); positional half of the chunk reference.
  chunk_index  INTEGER NOT NULL,
  -- Stable display id '{doi}#c{index}' (trace CLI, doc pointers).
  chunk_id     TEXT    NOT NULL UNIQUE,
  -- Authoritative evidence offsets into the ORIGINAL extracted text.
  char_start   INTEGER NOT NULL,
  char_end     INTEGER NOT NULL,
  -- Advisory engine-window budget (chars_per_token estimate).
  est_tokens   INTEGER NOT NULL,
  -- Content address: verdict-cache join + structural invalidation.
  content_hash TEXT    NOT NULL,
  -- The chunk text itself; ClaimPair.chunk input.
  text         TEXT    NOT NULL,
  PRIMARY KEY (doi, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);

-- Content-addressed verdict cache. Keyed by claim+chunk content, model, and
-- the decision bar in force. Pure compute cache: nothing else reads it.
CREATE TABLE IF NOT EXISTS claim_verdicts (
  claim_hash     TEXT NOT NULL,  -- sha256 of whitespace-normalized claim
  chunk_hash     TEXT NOT NULL,  -- = chunks.content_hash at decision time
  model          TEXT NOT NULL,  -- stable engine+weights id
  min_confidence REAL NOT NULL,  -- decision bar in force (part of the key)
  verdict        TEXT NOT NULL CHECK (verdict IN ('supported','refuted','unverified')),
  confidence     REAL NOT NULL,  -- raw engine probability
  evidence_quote TEXT,           -- trace display; dataset/bench fills when present
  decided_at     TEXT NOT NULL,  -- metadata only (ISO), never logic
  PRIMARY KEY (claim_hash, chunk_hash, model, min_confidence)
);

-- Traceability pointers: one row per (document, claim, supporting chunk).
-- Written for supported chunks (negatives live only in the cache); fields
-- snapshot the verdict so trace never depends on cache rows.
CREATE TABLE IF NOT EXISTS claim_pointers (
  doc_id       TEXT    NOT NULL,  -- generated document id (manuscript path stem)
  claim_text   TEXT    NOT NULL,  -- exact claim as reviewed (trace display)
  claim_hash   TEXT    NOT NULL,  -- dedupe half of the key
  doi          TEXT    NOT NULL REFERENCES papers(doi) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL,  -- positional reference
  char_start   INTEGER NOT NULL,  -- snapshot copied from chunks at write time
  char_end     INTEGER NOT NULL,
  verdict      TEXT    NOT NULL,
  confidence   REAL    NOT NULL,
  model        TEXT    NOT NULL,
  min_confidence REAL  NOT NULL,
  created_at   TEXT    NOT NULL,
  PRIMARY KEY (doc_id, claim_hash, doi, chunk_index),
  FOREIGN KEY (doi, chunk_index) REFERENCES chunks(doi, chunk_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pointers_doc ON claim_pointers(doc_id);

PRAGMA user_version = 2;
