/**
 * Registry core (R9–R13, R15 cross-process half): one self-contained SQLite
 * file at `.registry/registry.db` beside the LaTeX project. Ported from the
 * product's `UktubAI_Agentic/deploy/sandbox-image/pi-registry.js` onto the
 * minimal KTD4 schema.
 *
 * Write contract (KTD5): every identity-bearing write runs as ONE
 * `BEGIN IMMEDIATE` transaction whose LAST statement re-renders
 * `refs/references.bib` under the write lock, before COMMIT — a failed render
 * or COMMIT rolls the rows back and re-renders the file from the unchanged
 * registry (`abandonWrite`). Cross-process writers serialize on SQLite with a
 * 5 s busy timeout; an exhausted wait surfaces as the typed REGISTRY_BUSY.
 *
 * Root is injected — never process.env, never a hardcoded workspace path.
 * `ingested_at` is the only clock value and arrives through the injected
 * `now` (KTD6).
 */
import { cliCommand } from "./launch.ts";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, StatementSync } from "node:sqlite";

import type { RefusalCode, WarningCode } from "./refusals.ts";
import { firstFreeCitekey, generateCitekey } from "./citekey.ts";
import { isRekeyableBibtex, renderBibliography } from "./bibrender.ts";
import { arxivDoi, normalizeRegistryDoi } from "./doi.ts";

/** The project's canonical paper registry, created by `init` (R9). */
export const REGISTRY_REL_PATH = ".registry/registry.db";

/** The registry-rendered bibliography (R12) — derived state (D5). */
export const BIBLIOGRAPHY_REL_PATH = "refs/references.bib";

/** The only schema version this package speaks (KTD4). */
export const REGISTRY_SCHEMA_VERSION = 5;

/**
 * R15/KTD5: cross-process writes serialize through SQLite's busy wait. The
 * timeout is set at open (`timeout`), not by a later pragma: the journal-mode
 * pragma itself takes a lock, and a second writer opening concurrently must
 * wait on it rather than fail with SQLITE_BUSY at once.
 */
export const BUSY_TIMEOUT_MS = 5000;

/** Journal mode stays DELETE (KTD2): the registry is ONE self-contained file; backup = copy one file. */
const OPEN_PRAGMAS = "PRAGMA journal_mode=DELETE; PRAGMA foreign_keys = ON;";

/** Typed registry failure; `code` is stable and table-checked in refusals.ts (R7). */
export class RegistryError extends Error {
  code: RefusalCode;

  constructor(code: RefusalCode, message: string) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
  }
}

/**
 * node:sqlite hands back `Record<string, SQLOutputValue>` rows; these two
 * casts are the module's only unchecked boundary — after them, reads are typed.
 */
function getRow<T extends object>(statement: StatementSync, ...params: SQLInputValue[]): T | undefined {
  return statement.get(...params) as T | undefined;
}
function allRows<T extends object>(statement: StatementSync, ...params: SQLInputValue[]): T[] {
  return statement.all(...params) as T[];
}

const BUSY_PATTERN = /database is locked|database table is locked/i;
const CORRUPT_PATTERN = /file is not a database|database disk image is malformed|file is encrypted|malformed database schema/i;

/**
 * Map SQLite's failure modes onto the typed refusal codes; anything that is
 * neither a lock wait nor corruption (a constraint violation, an fs error)
 * passes through unchanged — those carry their own precise report.
 */
function asRegistryError(err: unknown): unknown {
  if (err instanceof RegistryError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (BUSY_PATTERN.test(message)) {
    return new RegistryError("REGISTRY_BUSY", `another writer held the registry lock; the ${BUSY_TIMEOUT_MS} ms wait was exhausted`);
  }
  if (CORRUPT_PATTERN.test(message)) {
    return new RegistryError("REGISTRY_CORRUPT", `${REGISTRY_REL_PATH} is not a readable SQLite database`);
  }
  return err;
}

function readUserVersion(db: DatabaseSync): number {
  return getRow<{ user_version: number }>(db.prepare("PRAGMA user_version"))?.user_version ?? 0;
}

const SCHEMA_SQL = (): string => readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/** Legacy tables v2 added. Their rows carry no source provenance, so v3 drops
 *  them: evidence must name an attested source revision (KTD4). */
const LEGACY_V2_TABLES = ["claim_pointers", "claim_verdicts", "chunks"] as const;

function tableExists(db: DatabaseSync, name: string): boolean {
  return getRow(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?"), name) !== undefined;
}

/** Columns added after v3 shipped: [table, column, type]. v1/v2 gain them with their v3 tables. */
const ADDED_COLUMNS = [
  ["paper_sources", "sections_json", "TEXT"],
  ["chunks", "section", "TEXT"],
] as const;

/**
 * Explicit in-place migration of the known package schemas (v1–v4) to the
 * current version, inside one transaction. Papers, citekeys, captured texts and
 * chunks are never rewritten; v3 gains columns and v4 gains the vector cache table. v2's chunk/verdict/pointer
 * rows are dropped (unsourced); when any exist the whole file is copied to
 * `<db>.v2.bak` first (backup = copy one file). Anything else — foreign or
 * newer — is refused by the callers.
 */
export function migrateLegacy(db: DatabaseSync, file: string, from: 1 | 2 | 3 | 4): void {
  if (from === 2) {
    const held = LEGACY_V2_TABLES.some(
      (t) => tableExists(db, t) && Number(getRow<{ n: number }>(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`))?.n ?? 0) > 0,
    );
    if (held) copyFileSync(file, `${file}.v2.bak`);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    // Another process may have migrated while this one waited for the write lock.
    if (readUserVersion(db) === REGISTRY_SCHEMA_VERSION) {
      db.exec("ROLLBACK");
      return;
    }
    const cols = allRows<{ name: string }>(db.prepare("PRAGMA table_info(papers)")).map((c) => c.name);
    if (!cols.includes("abstract")) db.exec("ALTER TABLE papers ADD COLUMN abstract TEXT");
    if (!cols.includes("abstract_source")) db.exec("ALTER TABLE papers ADD COLUMN abstract_source TEXT");
    if (from < 3) for (const t of LEGACY_V2_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    for (const [table, column, type] of ADDED_COLUMNS) {
      if (!tableExists(db, table)) continue; // v1/v2 have no source tables: SCHEMA_SQL creates them with the column
      const have = allRows<{ name: string }>(db.prepare(`PRAGMA table_info(${table})`)).map((c) => c.name);
      if (!have.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    db.exec(SCHEMA_SQL());
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // rollback of a failed DDL transaction; original error is the report
    }
    throw err;
  }
}

function unsupported(version: number, verb: string): RegistryError {
  return new RegistryError(
    "REGISTRY_SCHEMA_UNSUPPORTED",
    `${verb} a registry of schema version ${version} is not supported (this package speaks version ${REGISTRY_SCHEMA_VERSION}, and migrates 1 to 4)`,
  );
}

/**
 * Open the database file and settle its schema version BEFORE any pragma that
 * could write: a foreign or newer database is refused byte-for-byte unchanged
 * (setting `journal_mode` on a WAL database would rewrite it). Known legacy
 * versions migrate; version 0 is accepted only when `allowFresh` (init).
 */
function openDatabaseFile(abs: string, allowFresh: boolean): DatabaseSync {
  let opened: DatabaseSync | undefined;
  try {
    opened = new DatabaseSync(abs, { timeout: BUSY_TIMEOUT_MS });
    const version = readUserVersion(opened);
    // A database that never set user_version is ours to initialise only when it is EMPTY;
    // someone else's tables are refused untouched.
    const empty = getRow<{ n: number }>(opened.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"))?.n === 0;
    const fresh = version === 0 && allowFresh && empty;
    if (!fresh && version !== REGISTRY_SCHEMA_VERSION && version !== 1 && version !== 2 && version !== 3 && version !== 4) {
      throw unsupported(version, allowFresh ? "refusing to re-initialize" : "opening");
    }
    opened.exec(OPEN_PRAGMAS);
    if (version === 1 || version === 2 || version === 3 || version === 4) migrateLegacy(opened, abs, version);
    return opened;
  } catch (err) {
    try {
      opened?.close();
    } catch {
      // The open failure is the report.
    }
    throw asRegistryError(err);
  }
}

/**
 * Walk up from `root` and return the nearest ancestor directory that already
 * contains a project registry, or null. `root` itself is excluded — re-running
 * `init` in the project root is the documented idempotent path (DVC-style
 * nesting rule: one registry per tree, never nested projects).
 */
export function findEnclosingProject(root: string): string | null {
  const resolved = resolve(root);
  let dir = dirname(resolved);
  const stop = parse(dir).root;
  while (true) {
    if (existsSync(join(dir, REGISTRY_REL_PATH))) return dir;
    if (dir === stop) return null;
    dir = dirname(dir);
  }
}

/**
 * Open the project registry for an existing project; refuses a missing file
 * (REGISTRY_NOT_INITIALIZED — `init` creates it), non-SQLite bytes
 * (REGISTRY_CORRUPT) and a foreign or newer schema version
 * (REGISTRY_SCHEMA_UNSUPPORTED, without touching the file). Known older
 * versions migrate in place.
 */
export function openRegistry(root: string): DatabaseSync {
  const abs = join(root, REGISTRY_REL_PATH);
  if (!existsSync(abs)) {
    throw new RegistryError("REGISTRY_NOT_INITIALIZED", `no registry at ${REGISTRY_REL_PATH} under ${root}. To create one in that folder run: (cd "${root}" && ${cliCommand("init")})`);
  }
  return openDatabaseFile(abs, false);
}

/**
 * Create (or idempotently re-open and re-validate) the registry for a project
 * and render the header-only bibliography — `init`'s core. An uninitialized
 * (version 0) database gets the schema; a current one re-applies it (every
 * statement is IF NOT EXISTS); a known legacy one migrates; a foreign or newer
 * version is refused unchanged. Returns the open handle.
 */
export function createRegistry(root: string): DatabaseSync {
  const abs = join(root, REGISTRY_REL_PATH);
  mkdirSync(dirname(abs), { recursive: true });
  let db: DatabaseSync | undefined;
  try {
    db = openDatabaseFile(abs, true); // creates the file when missing; maps corrupt/busy
    // One transaction: an interrupted init leaves an empty database, never half a schema.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(SCHEMA_SQL());
      db.exec("COMMIT");
    } catch (err) {
      rollbackQuietly(db);
      throw err;
    }
    syncBibliography(db);
    return db;
  } catch (err) {
    try {
      db?.close();
    } catch {
      // The original error is the report.
    }
    throw asRegistryError(err);
  }
}

/** Registry change counter: continuation tokens carry it and are refused once
 *  it moves. Bumped inside every transaction that changes papers or sources. */
export function generationOf(db: DatabaseSync): number {
  return Number(getRow<{ generation: number }>(db.prepare("SELECT generation FROM registry_state WHERE id = 1"))?.generation ?? 0);
}
export function bumpGeneration(db: DatabaseSync): void {
  db.prepare("UPDATE registry_state SET generation = generation + 1 WHERE id = 1").run();
}

// ── registration ───────────────────────────────────────────────────────────

/** One paper as the register tool's resolved record delivers it. */
export interface PaperRecord {
  doi: string;
  title: string;
  authors: string[];
  year?: number | null;
  venue?: string | null;
  /** Provider BibTeX verbatim; null when the provider supplied none (R13). */
  bibtex?: string | null;
  /** Provenance of `bibtex` (e.g. "crossref"); stored only alongside citable BibTeX. */
  bibtexSource?: string | null;
  /** Provider abstract (plain text); never generated. Kept when a refresh brings none. */
  abstract?: string | null;
  /** Provider that supplied `abstract`. */
  abstractSource?: string | null;
}

export interface RegisterOptions {
  /** Clock injection (KTD6); defaults to the real clock. */
  now?: () => Date;
}

export interface RegisterOutcome {
  doi: string;
  citekey: string;
  /** The STORED row's citability after the write — not the incoming record's. */
  citable: boolean;
  status: "registered" | "updated";
  /** Warning-class codes for the outcome (KTD6); surfaced in tool results. */
  warnings: WarningCode[];
}

/**
 * The single upsert. On conflict (a re-registration) the stored citekey is
 * never assigned — the citekey is pinned on the row's first registration
 * (R11). `provider_bibtex`/`bibtex_source`/`citable` are ONE fact the
 * bibliography renders from: the pair is replaced only by an incoming citable
 * pair, and `citable` only improves (MAX rule, KTD8) — nothing un-cites a
 * paper except deregistration. All other metadata is latest-wins.
 */
const UPSERT_PAPER_SQL = `INSERT INTO papers
  (doi, citekey, title, authors_json, year, venue, provider_bibtex, bibtex_source, citable, ingested_at, abstract, abstract_source)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(doi) DO UPDATE SET
  title = excluded.title,
  authors_json = excluded.authors_json,
  venue = excluded.venue,
  year = excluded.year,
  provider_bibtex = CASE WHEN excluded.citable = 1 THEN excluded.provider_bibtex ELSE papers.provider_bibtex END,
  bibtex_source = CASE WHEN excluded.citable = 1 THEN excluded.bibtex_source ELSE papers.bibtex_source END,
  citable = MAX(papers.citable, excluded.citable),
  ingested_at = excluded.ingested_at,
  abstract = COALESCE(excluded.abstract, papers.abstract),
  abstract_source = CASE WHEN excluded.abstract IS NOT NULL THEN excluded.abstract_source ELSE papers.abstract_source END`;

/** `ingested_at` storage form: second precision, no milliseconds. */
function toIsoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Register one paper as ONE `BEGIN IMMEDIATE` transaction (KTD5): the upsert
 * with citekey pinning, then the bibliography re-render as the LAST statement
 * before COMMIT. The caller resolved provider metadata and BibTeX; the
 * registry decides citability: exactly a provider BibTeX pair the renderer can
 * re-key (R13) — never the caller's claim, never a synthesis.
 */
export function registerPaper(db: DatabaseSync, record: PaperRecord, options: RegisterOptions = {}): RegisterOutcome {
  const doi = normalizeRegistryDoi(record.doi);
  if (doi === null) {
    throw new RegistryError(
      "INVALID_DOI",
      `not a DOI: ${JSON.stringify(record.doi)} — a bare arXiv id must be registered in its 10.48550/arxiv.<id> form`,
    );
  }
  const bibtex = typeof record.bibtex === "string" ? record.bibtex : null;
  const incomingCitable = bibtex !== null && isRekeyableBibtex(bibtex) ? 1 : 0;
  const bibtexSource = incomingCitable === 1 ? (record.bibtexSource ?? null) : null;
  const ingestedAt = toIsoSeconds(options.now?.() ?? new Date());
  const abstract = typeof record.abstract === "string" && record.abstract.trim().length > 0 ? record.abstract.trim() : null;

  try {
    db.exec("BEGIN IMMEDIATE;");
  } catch (err) {
    throw asRegistryError(err);
  }
  let bibliographyStarted = false;
  try {
    const status = getRow<{ citekey: string }>(db.prepare("SELECT citekey FROM papers WHERE doi = ?"), doi) === undefined
      ? "registered"
      : "updated";
    // The citekey column of the VALUES row is discarded on conflict; a fresh
    // row takes the first free disambiguation of its base (R11), probed under
    // the write lock so concurrent writers cannot mint the same suffix.
    const citekey =
      status === "registered" ? firstFreeCitekey(db, generateCitekey(record.authors ?? [], record.year ?? null, record.title)) : "";
    db.prepare(UPSERT_PAPER_SQL).run(
      doi,
      citekey,
      record.title,
      JSON.stringify(record.authors ?? []),
      record.year ?? null,
      record.venue ?? null,
      bibtex,
      bibtexSource,
      incomingCitable,
      ingestedAt,
      abstract,
      abstract === null ? null : (record.abstractSource ?? null),
    );

    // The STORED row's state, read after the upsert: a re-registration that
    // brought no new BibTeX keeps the stored pair, so the outcome reports the
    // registry's citability, not the incoming record's.
    const stored = getRow<{ citekey: string; citable: number }>(
      db.prepare("SELECT citekey, citable FROM papers WHERE doi = ?"),
      doi,
    );
    if (stored === undefined) throw new Error(`registered row vanished for ${doi}`);
    bumpGeneration(db);

    bibliographyStarted = true;
    writeBibliography(db);

    db.exec("COMMIT;");
    const citable = Number(stored.citable) === 1;
    return {
      doi,
      citekey: stored.citekey,
      citable,
      status,
      warnings: citable ? [] : ["BIBTEX_UNAVAILABLE"],
    };
  } catch (err) {
    abandonWrite(db, bibliographyStarted);
    throw asRegistryError(err);
  }
}

// ── listing (R6 order contract) ────────────────────────────────────────────

/** One registry row as the list tool and CLI display it. */
export interface PaperRow {
  doi: string;
  citekey: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  /** Provenance of the stored BibTeX pair; null when uncitable. */
  bibtexSource: string | null;
  citable: boolean;
  ingestedAt: string;
}

/** Papers in citekey ASC order — the total order every consumer shares (KTD6).
 *  `limit` pushes the cap into SQL (the tool layer's truncation probe uses
 *  cap+1); omit it to read the whole registry (the CLI's human listing). */
export function listPapers(db: DatabaseSync, limit?: number): PaperRow[] {
  const statement = Number.isInteger(limit) && limit !== undefined && limit >= 0
    ? db.prepare(
      "SELECT doi, citekey, title, authors_json, year, venue, bibtex_source, citable, ingested_at FROM papers ORDER BY citekey ASC LIMIT ?",
    )
    : db.prepare(
      "SELECT doi, citekey, title, authors_json, year, venue, bibtex_source, citable, ingested_at FROM papers ORDER BY citekey ASC",
    );
  const rows = allRows<{
    doi: string;
    citekey: string;
    title: string;
    authors_json: string;
    year: number | null;
    venue: string | null;
    bibtex_source: string | null;
    citable: number;
    ingested_at: string;
  }>(
    statement,
    ...(Number.isInteger(limit) && limit !== undefined && limit >= 0 ? [limit] : []),
  );
  return rows.map((row) => ({
    doi: row.doi,
    citekey: row.citekey,
    title: row.title,
    authors: JSON.parse(row.authors_json) as string[],
    year: row.year ?? null,
    venue: row.venue ?? null,
    bibtexSource: row.bibtex_source ?? null,
    citable: Number(row.citable) === 1,
    ingestedAt: row.ingested_at,
  }));
}

/** Total registry size — the total behind `paper_registry` read's
 *  `remaining` marker without materializing every row. */
export function countPapers(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM papers").get() as { n: number };
  return Number(row.n);
}

// ── handles ────────────────────────────────────────────────────────────────

/** Canonical DOI for a handle written as a DOI, `doi:`/URL form, or explicit `arxiv:<id>`; else null. */
export function canonicalDoiOf(handle: string): string | null {
  return normalizeRegistryDoi(handle) ?? (/^arxiv:/i.test(handle.trim()) ? arxivDoi(handle) : null);
}

export interface RegistryHandleRow {
  doi: string;
  citekey: string;
  title: string;
}

/** Resolve one DOI-form or citekey handle to its registered paper, or null. Never guesses. */
export function resolveHandle(db: DatabaseSync, handle: string): RegistryHandleRow | null {
  const doi = canonicalDoiOf(handle);
  const row =
    doi !== null
      ? getRow<RegistryHandleRow>(db.prepare("SELECT doi, citekey, title FROM papers WHERE doi = ?"), doi)
      : getRow<RegistryHandleRow>(db.prepare("SELECT doi, citekey, title FROM papers WHERE citekey = ?"), handle.trim());
  return row ?? null;
}

/** One registry row with every stored column the read projection can name. */
export interface PaperDetail extends PaperRow {
  providerBibtex: string | null;
  abstract: string | null;
  abstractSource: string | null;
}

/** Papers in citekey order after `afterCitekey`, optionally restricted to `dois`; `limit` rows. */
export function selectPapers(db: DatabaseSync, opts: { dois?: string[]; afterCitekey?: string; limit: number }): PaperDetail[] {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (opts.dois !== undefined) {
    if (opts.dois.length === 0) return [];
    where.push(`doi IN (${opts.dois.map(() => "?").join(",")})`);
    params.push(...opts.dois);
  }
  if (opts.afterCitekey !== undefined) {
    where.push("citekey > ?");
    params.push(opts.afterCitekey);
  }
  const rows = allRows<{
    doi: string; citekey: string; title: string; authors_json: string; year: number | null; venue: string | null;
    bibtex_source: string | null; citable: number; ingested_at: string; provider_bibtex: string | null; abstract: string | null; abstract_source: string | null;
  }>(
    db.prepare(
      `SELECT doi, citekey, title, authors_json, year, venue, bibtex_source, citable, ingested_at, provider_bibtex, abstract, abstract_source
       FROM papers ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY citekey ASC LIMIT ?`,
    ),
    ...params,
    opts.limit,
  );
  return rows.map((row) => ({
    doi: row.doi,
    citekey: row.citekey,
    title: row.title,
    authors: JSON.parse(row.authors_json) as string[],
    year: row.year ?? null,
    venue: row.venue ?? null,
    bibtexSource: row.bibtex_source ?? null,
    citable: Number(row.citable) === 1,
    ingestedAt: row.ingested_at,
    providerBibtex: row.provider_bibtex ?? null,
    abstract: row.abstract ?? null,
    abstractSource: row.abstract_source ?? null,
  }));
}

// ── deregistration ─────────────────────────────────────────────────────────

export interface RemovedPaper {
  doi: string;
  citekey: string;
  title: string;
}

/** One outcome per input handle, in input order. */
export interface RemoveOutcome {
  input: string;
  /** removed: this input caused the deletion; duplicate: names a paper an earlier input already removed;
   *  absent: no such paper (already gone); refused: blank handle. */
  status: "removed" | "duplicate" | "absent" | "refused";
  doi: string | null;
  citekey: string | null;
  duplicateOf: number | null;
}

export interface DeregisterResult {
  removed: RemovedPaper[];
  missing: string[];
  outcomes: RemoveOutcome[];
}

/**
 * Remove papers by DOI, DOI alias or citekey in ONE `BEGIN IMMEDIATE`
 * transaction — the same write contract as registration: rows and re-render
 * land together, and a failure restores the file to the unchanged registry's
 * image. Aliases of one paper cause one deletion; every input keeps an outcome.
 * There is no all-delete selector: a handle names one paper or nothing.
 */
export function deregisterPapers(db: DatabaseSync, handles: string[]): DeregisterResult {
  const removed: RemovedPaper[] = [];
  const missing: string[] = [];
  const outcomes: RemoveOutcome[] = [];
  try {
    db.exec("BEGIN IMMEDIATE;");
  } catch (err) {
    throw asRegistryError(err);
  }
  let bibliographyStarted = false;
  try {
    // Resolve every handle against the registry as it stands, THEN delete: two
    // handles naming one paper (DOI alias, citekey) resolve to the same row.
    const del = db.prepare("DELETE FROM papers WHERE doi = ?");
    const firstIndexOf = new Map<string, number>();
    handles.forEach((handle, index) => {
      if (handle.trim().length === 0) {
        outcomes.push({ input: handle, status: "refused", doi: null, citekey: null, duplicateOf: null });
        return;
      }
      const row = resolveHandle(db, handle);
      if (row === null) {
        missing.push(handle);
        outcomes.push({ input: handle, status: "absent", doi: canonicalDoiOf(handle), citekey: null, duplicateOf: null });
        return;
      }
      const earlier = firstIndexOf.get(row.doi);
      if (earlier !== undefined) {
        outcomes.push({ input: handle, status: "duplicate", doi: row.doi, citekey: row.citekey, duplicateOf: earlier });
        return;
      }
      firstIndexOf.set(row.doi, index);
      removed.push({ doi: row.doi, citekey: row.citekey, title: row.title });
      outcomes.push({ input: handle, status: "removed", doi: row.doi, citekey: row.citekey, duplicateOf: null });
    });
    for (const r of removed) del.run(r.doi);
    if (removed.length > 0) bumpGeneration(db);
    bibliographyStarted = true;
    writeBibliography(db);
    db.exec("COMMIT;");
  } catch (err) {
    abandonWrite(db, bibliographyStarted);
    throw asRegistryError(err);
  }
  return { removed, missing, outcomes };
}

// ── the bibliography render (R12) ──────────────────────────────────────────

/** A bibliography staged by `writeBibliography` (`references.bib.<pid>.tmp`). */
const STAGED_BIBLIOGRAPHY = /^references\.bib\.\d+\.tmp$/;

/**
 * Render `refs/references.bib` from every citable paper's provider BibTeX
 * under its pinned citekey, and replace the file atomically (staged write +
 * rename, so a reader never sees a truncated bibliography).
 *
 * CALLERS MUST HOLD THE REGISTRY WRITE LOCK (an open `BEGIN IMMEDIATE`) —
 * that lock is what serializes writers across processes, so the rename of an
 * older image can never land over a newer one. `registerPaper` and
 * `deregisterPapers` call this as their last statement before COMMIT;
 * `syncBibliography` is the on-demand entry.
 *
 * Because every writer holds the lock while staging, any OTHER
 * `references.bib.<pid>.tmp` found here belongs to a writer killed between
 * staging and rename, so it is swept before staging instead of accumulating
 * in `refs/`.
 */
function writeBibliography(db: DatabaseSync): { syncedCount: number } {
  // The workspace root is the directory holding `.registry/`, taken from the
  // open handle itself so the file always lands beside the registry it was rendered from.
  const location = db.location() ?? ""; // types allow null for unnamed handles; an open registry always has a file path
  const root = resolve(dirname(location), "..");
  const rows = allRows<{ citekey: string; provider_bibtex: string }>(
    db.prepare(
      "SELECT citekey, provider_bibtex FROM papers WHERE citable = 1 AND provider_bibtex IS NOT NULL ORDER BY citekey",
    ),
  );
  const content = renderBibliography(rows.map((row) => ({ citekey: row.citekey, bibtex: row.provider_bibtex })));
  const refsDir = join(root, dirname(BIBLIOGRAPHY_REL_PATH));
  mkdirSync(refsDir, { recursive: true });
  try {
    for (const entry of readdirSync(refsDir, { withFileTypes: true })) {
      if (entry.isFile() && STAGED_BIBLIOGRAPHY.test(entry.name)) rmSync(join(refsDir, entry.name), { force: true });
    }
  } catch {
    // Housekeeping only: a sweep that cannot finish must not block the write;
    // the render below reports its own failure.
  }
  const target = join(root, BIBLIOGRAPHY_REL_PATH);
  const staged = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(staged, content, "utf-8");
    // Read-only on disk: the bibliography is rendered, never hand-written, and no host's edit tool can append an invented entry to it.
    // The rename below replaces a read-only target (it needs the directory, not the file); the human may chmod it on purpose.
    chmodSync(staged, 0o444);
    renameSync(staged, target);
  } catch (err) {
    try {
      rmSync(staged, { force: true });
    } catch {
      // The write already failed; that error is the report.
    }
    throw err;
  }
  return { syncedCount: rows.length };
}

/**
 * Re-render `refs/references.bib` from the registry as it stands — the
 * on-demand, idempotent heal (`sync-bib`) for a stale, edited, or missing
 * file. The render runs inside its own `BEGIN IMMEDIATE`, the same
 * cross-process mutex the writers hold, so it cannot interleave with one.
 * Nothing is written to the database, so the transaction ends with ROLLBACK,
 * not COMMIT: in a rollback-journal database even an empty COMMIT is refused
 * while another connection is mid-read, whereas ROLLBACK only releases the
 * lock. Must not be called inside an open transaction.
 */
export function syncBibliography(db: DatabaseSync): { syncedCount: number } {
  try {
    db.exec("BEGIN IMMEDIATE;");
    try {
      return writeBibliography(db);
    } finally {
      rollbackQuietly(db);
    }
  } catch (err) {
    throw asRegistryError(err);
  }
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK;");
  } catch {
    // Nothing was written, or SQLite already ended the transaction; a failed
    // release carries no signal beyond the statement's own outcome.
  }
}

/**
 * The failure path both write transactions share. ROLLBACK first — after a
 * failed COMMIT the transaction is still open, holding the write lock — and
 * then, when the render had begun, put `refs/references.bib` back in step
 * with the now-unchanged rows. The heal takes the write lock again
 * (`syncBibliography`): the rollback released it, and rendering without it
 * could rename a stale image over a concurrent writer's newer one. A heal
 * that cannot finish is swallowed — the caller gets the ORIGINAL error, and
 * the next write or `sync-bib` re-renders the file from the registry, which
 * is the source of truth.
 */
function abandonWrite(db: DatabaseSync, bibliographyStarted: boolean): void {
  rollbackQuietly(db);
  if (!bibliographyStarted) return;
  try {
    syncBibliography(db);
  } catch {
    // Best effort; see above.
  }
}
