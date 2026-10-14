-- The uktub-scholar registry: one self-contained SQLite file at
-- `.registry/registry.db` beside the LaTeX project. Journal mode stays
-- DELETE (set at open in registry.ts): one file is the whole registry, and
-- backup = copy one file.
--
-- `doi` is the PRIMARY KEY: DOIs are case-insensitive, and the canonical
-- lowercase form is what makes the uniqueness meaningful.
--
-- Version 5 (current). Migration from v1–v4 is explicit in registry.ts; this
-- file is the whole current schema and is idempotent (IF NOT EXISTS).
-- Every column names its consumer.

CREATE TABLE IF NOT EXISTS papers (
  -- Identity + dedupe; the \cite source of truth.
  doi TEXT PRIMARY KEY,
  -- \cite target, pinned once at first registration, never recomputed;
  -- paper_registry read order.
  citekey TEXT NOT NULL UNIQUE,
  -- paper_registry read (default projection); title-match warning.
  title TEXT NOT NULL,
  -- Citekey generation; paper_registry read (authors).
  authors_json TEXT NOT NULL,
  -- Citekey generation; paper_registry read (default projection).
  year INTEGER,
  -- paper_registry read (venue).
  venue TEXT,
  -- references.bib entry body; NULL (or a head the render cannot re-key)
  -- means uncitable. BibTeX is never synthesized or repaired.
  provider_bibtex TEXT,
  -- Provenance of the BibTeX pair; stored only alongside citable BibTeX.
  bibtex_source TEXT,
  -- Eligibility marker in every tool result: 1 only when the row holds
  -- re-keyable provider BibTeX. Only improves (MAX rule).
  citable INTEGER NOT NULL DEFAULT 0,
  -- Registration last-write time (metadata refresh time), injected by the caller.
  ingested_at TEXT NOT NULL,
  -- Provider abstract (paper_registry read: literature triage). NULL when the
  -- provider shipped none; never invented, never generated.
  abstract TEXT,
  -- Provider that supplied `abstract` (its provenance).
  abstract_source TEXT
);

-- Source readiness + the captured extraction (KTD4). A paper with no row is
-- metadata-only. `status` 'ready' rows carry the one current captured text;
-- 'unavailable' / 'failed' rows record why no usable text exists (acquisition
-- recovery). Nothing here holds credentials: `ref` is a nonsecret reference.
CREATE TABLE IF NOT EXISTS paper_sources (
  doi TEXT PRIMARY KEY REFERENCES papers(doi) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ready','unavailable','failed')),
  -- openalex-pdf-url | openalex-oa-url | openalex-content-tei | openalex-content-pdf | s2-open-access-pdf | epmc-pdf | pmc-pdf | arxiv-pdf | arxiv-preprint-pdf | local-file
  kind TEXT,
  -- Nonsecret origin: URL without credentials, or project-relative file path.
  ref TEXT,
  -- Rights note carried from the provider location, when stated.
  license TEXT,
  -- sha256 of the acquired bytes: source half of the pointer revision.
  digest TEXT,
  -- Extractor identity + version: extraction half of the pointer revision.
  extraction TEXT,
  -- Pointer revision = H(digest, extraction, sha256(text)). Evidence binds here.
  revision TEXT,
  -- Chunk policy the derived chunks were built with (rechunk trigger).
  chunk_policy TEXT,
  -- Captured extracted text; evidence spans index it (UTF-16 offsets).
  text TEXT,
  -- JSON array of page start offsets when the extractor grounds pages.
  page_starts_json TEXT,
  -- JSON array of {start, heading, level} section marks (text offsets) when the extractor
  -- found structure (TEI heads, PDF heading lines); NULL = none known. Chunking consumes it.
  sections_json TEXT,
  prepared_at TEXT NOT NULL,
  -- Normalized failure reason (never a raw fetch exception) + short detail.
  failure_code TEXT,
  failure_detail TEXT
);

-- Derived chunks (rebuildable from paper_sources.text + chunk policy).
-- chunk_id is content-addressed: never reuse an ordinal as identity.
CREATE TABLE IF NOT EXISTS chunks (
  doi TEXT NOT NULL REFERENCES papers(doi) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  -- H(doi, revision, policy, char_start, char_end): the same document may back two papers.
  chunk_id TEXT NOT NULL UNIQUE,
  revision TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  est_tokens INTEGER NOT NULL,
  -- Judgment-cache join key.
  content_hash TEXT NOT NULL,
  -- The chunk text: judged passage and FTS content.
  text TEXT NOT NULL,
  -- Heading of the section the chunk starts in ('' before the first heading; NULL when the
  -- chunk policy is not section-based). Shown with evidence and passage results.
  section TEXT,
  PRIMARY KEY (doi, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);

-- Locator index (KTD6): derived, kept consistent by triggers (FK cascades fire them).
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  text, content='chunks', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunk_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

-- Passage vectors (pure compute cache): the embedding of a passage's text under one embedder
-- identity. Keyed by content, not by chunk, so a vector survives rechunking that keeps the text and
-- is shared by papers containing the same passage; never read for another embedder (embed_id names
-- model + prompt profile). Exact-cosine search scans these rows; nothing else reads them.
CREATE TABLE IF NOT EXISTS passage_vectors (
  content_hash TEXT NOT NULL,
  embed_id TEXT NOT NULL,
  dim INTEGER NOT NULL,
  -- little-endian float32 × dim, L2-normalised
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (content_hash, embed_id)
);

-- Reusable judgment compute cache. Pure cache: nothing reads evidence from it.
-- Key = effective decision identity: claim, passage content, model identity,
-- decision protocol. The confidence bar is policy applied on read, not a key.
CREATE TABLE IF NOT EXISTS claim_judgments (
  claim_hash TEXT NOT NULL,
  passage_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  p_true REAL NOT NULL,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (claim_hash, passage_hash, model_id, protocol)
);

-- One verification run = a fresh verify_claim call plus its continuations. The
-- row captures the selection (papers at their revisions and chunk policy, the
-- locator query, the decision identity) so a continuation can be refused when
-- anything it depends on changed, and holds the index of the first unchecked
-- candidate (NULL when the work is complete).
CREATE TABLE IF NOT EXISTS verify_runs (
  run_id TEXT PRIMARY KEY,
  claim_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  next_work INTEGER,
  -- Findings of the run's first call that every later page must repeat
  -- (sources without a usable source, unresolved handles, discarded stale evidence).
  carry_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Supporting evidence of a run, bound to the source revision it was judged
-- against and carrying its own decision, so it is reconstructable without any
-- judgment-cache row. Deleted with its run, its paper, or its revision.
CREATE TABLE IF NOT EXISTS claim_evidence (
  run_id TEXT NOT NULL REFERENCES verify_runs(run_id) ON DELETE CASCADE,
  doi TEXT NOT NULL REFERENCES papers(doi) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  -- Grounded page number (1-based) when the extractor maps pages.
  page INTEGER,
  chunk_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  min_confidence REAL NOT NULL,
  p_true REAL NOT NULL,
  -- NULL until the record was delivered to the agent; then the excerpt characters
  -- released (0 = pointer only). Delivery is exactly-once and counts against the
  -- per-source release budget across every page of the run.
  released_chars INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, doi, revision, char_start, char_end)
);

-- Single-row change counter: continuation tokens reject a registry that
-- changed since they were issued.
CREATE TABLE IF NOT EXISTS registry_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL
);
INSERT OR IGNORE INTO registry_state (id, generation) VALUES (1, 0);

PRAGMA user_version = 5;
