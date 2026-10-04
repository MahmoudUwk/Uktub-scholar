/**
 * Genuine legacy registries for migration tests: the v1 and v2 DDL exactly as
 * those package versions shipped it (git history of src/core/schema.sql), built
 * with raw SQL — never through the current createRegistry.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const V1_DDL = `
CREATE TABLE papers (
  doi TEXT PRIMARY KEY,
  citekey TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  authors_json TEXT NOT NULL,
  year INTEGER,
  venue TEXT,
  provider_bibtex TEXT,
  bibtex_source TEXT,
  citable INTEGER NOT NULL DEFAULT 0,
  ingested_at TEXT NOT NULL
);`;

const V2_ADDITIONS = `
CREATE TABLE chunks (
  doi TEXT NOT NULL REFERENCES papers(doi) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_id TEXT NOT NULL UNIQUE,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  est_tokens INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (doi, chunk_index)
);
CREATE TABLE claim_verdicts (
  claim_hash TEXT NOT NULL, chunk_hash TEXT NOT NULL, model TEXT NOT NULL,
  min_confidence REAL NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('supported','refuted','unverified')),
  confidence REAL NOT NULL, evidence_quote TEXT, decided_at TEXT NOT NULL,
  PRIMARY KEY (claim_hash, chunk_hash, model, min_confidence)
);
CREATE TABLE claim_pointers (
  doc_id TEXT NOT NULL, claim_text TEXT NOT NULL, claim_hash TEXT NOT NULL,
  doi TEXT NOT NULL REFERENCES papers(doi) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL, char_start INTEGER NOT NULL, char_end INTEGER NOT NULL,
  verdict TEXT NOT NULL, confidence REAL NOT NULL, model TEXT NOT NULL,
  min_confidence REAL NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, claim_hash, doi, chunk_index),
  FOREIGN KEY (doi, chunk_index) REFERENCES chunks(doi, chunk_index) ON DELETE CASCADE
);`;

export const LEGACY_PAPER = {
  doi: "10.1234/legacy",
  citekey: "legacy2024",
  title: "A Legacy Paper",
  authors: '["Ada Lovelace"]',
  year: 2024,
  bibtex: "@article{legacy,\n  title={A Legacy Paper},\n  year={2024}\n}",
};

/** Build `<root>/.registry/registry.db` at schema version 1 or 2 with one paper
 *  (v2 also gets one chunk, one cached verdict and one pointer). */
export function buildLegacyRegistry(root: string, version: 1 | 2): string {
  const file = join(root, ".registry", "registry.db");
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(V1_DDL);
  if (version === 2) db.exec(V2_ADDITIONS);
  db.prepare(
    "INSERT INTO papers (doi, citekey, title, authors_json, year, venue, provider_bibtex, bibtex_source, citable, ingested_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(LEGACY_PAPER.doi, LEGACY_PAPER.citekey, LEGACY_PAPER.title, LEGACY_PAPER.authors, LEGACY_PAPER.year, null, LEGACY_PAPER.bibtex, "crossref", 1, "2026-10-01T00:00:00Z");
  if (version === 2) {
    db.prepare("INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?)").run(LEGACY_PAPER.doi, 0, `${LEGACY_PAPER.doi}#c0`, 0, 12, 3, "h0", "legacy chunk");
    db.prepare("INSERT INTO claim_verdicts VALUES (?,?,?,?,?,?,?,?)").run("c", "h0", "m", 0.99, "supported", 0.995, null, "2026-10-02T00:00:00Z");
    db.prepare("INSERT INTO claim_pointers VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("doc", "claim", "c", LEGACY_PAPER.doi, 0, 0, 12, "supported", 0.995, "m", 0.99, "2026-10-02T00:00:00Z");
  }
  db.exec(`PRAGMA user_version = ${version}`);
  db.close();
  return file;
}

/** A SQLite file at a foreign/newer schema version holding one marker table. */
export function buildForeignRegistry(root: string, userVersion: number, journal: "delete" | "wal" = "delete"): string {
  const file = join(root, ".registry", "registry.db");
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (journal === "wal") db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE marker (x TEXT); INSERT INTO marker VALUES ('untouched')");
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
  return file;
}
