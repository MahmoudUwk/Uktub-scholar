/**
 * Registry core spec (U2): schema shape and open gates, registration (DOI
 * identity, R13 provider-BibTeX citability, KTD8 MAX rule), citekey pinning
 * and suffix discipline (R11), deregistration, list order, cross-process
 * busy handling (R15).
 *
 * Ported behavior evidence:
 * UktubAI_Agentic/tests/contract/registry-schema.spec.ts and registry-cli.spec.ts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, StatementSync } from "node:sqlite";

/**
 * node:sqlite hands back `Record<string, SQLOutputValue>` rows of dynamic
 * shape; these two casts are the only unchecked boundary, then reads are typed.
 */
function getRow<T extends object>(statement: StatementSync, ...params: SQLInputValue[]): T | undefined {
  return statement.get(...params) as T | undefined;
}
function allRows<T extends object>(statement: StatementSync, ...params: SQLInputValue[]): T[] {
  return statement.all(...params) as T[];
}

import {
  BUSY_TIMEOUT_MS,
  REGISTRY_SCHEMA_VERSION,
  RegistryError,
  createRegistry,
  deregisterPapers,
  listPapers,
  openRegistry,
  registerPaper,
  syncBibliography,
} from "../src/core/registry.ts";
import type { PaperRecord } from "../src/core/registry.ts";
import { generateCitekey } from "../src/core/citekey.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

let root: string;
let db: DatabaseSync;
let doiCounter = 0;

/** Clock injection (KTD6): `ingested_at` is never pinned by assertions. */
const FIXED_NOW = () => new Date("2026-01-01T00:00:00Z");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-registry-"));
  db = createRegistry(root);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const bibText = (): string => readFileSync(join(root, "refs", "references.bib"), "utf8");
const bibKeys = (): string[] => [...bibText().matchAll(/^@\w+\{([^,}\s]+)[,}]/gm)].map((m) => m[1]!);

/** A provider-shaped record; `extra.bibtex: null` means the provider gave none. */
function paper(title: string, extra: Partial<PaperRecord> = {}): PaperRecord {
  const doi = extra.doi ?? `10.1000/paper-${(doiCounter += 1)}`;
  const bibtex =
    extra.bibtex !== undefined
      ? extra.bibtex
      : `@article{Provider_Key_${doi.replace(/\W/g, "")},\n  title = {${title}},\n  year = {2020},\n  doi = {${doi}}\n}`;
  return {
    doi,
    title,
    authors: extra.authors ?? ["Alice Smith"],
    year: extra.year ?? 2020,
    venue: extra.venue ?? null,
    bibtex,
    bibtexSource: bibtex === null ? null : (extra.bibtexSource ?? "crossref"),
  };
}

const register = (record: PaperRecord) => registerPaper(db, record, { now: FIXED_NOW });

const openRaw = (timeoutMs: number): DatabaseSync => {
  const conn = new DatabaseSync(join(root, ".registry", "registry.db"), { timeout: timeoutMs });
  conn.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys = ON;");
  return conn;
};

function columnsOf(handle: DatabaseSync, table: string): string[] {
  const rows = allRows<{ name: string }>(handle.prepare("SELECT name FROM pragma_table_info(?)"), table);
  return rows.map((r) => r.name);
}

const EXPECTED_PAPER_COLUMNS = [
  "doi",
  "citekey",
  "title",
  "authors_json",
  "year",
  "venue",
  "provider_bibtex",
  "bibtex_source",
  "citable",
  "ingested_at",
  "abstract",
  "abstract_source",
];

// ── schema and open gates ──────────────────────────────────────────────────

describe("registry schema (KTD4)", () => {
  it("creates the current schema: papers plus the source, chunk, vector, judgment, run and evidence tables", () => {
    assert.deepEqual(columnsOf(db, "papers"), EXPECTED_PAPER_COLUMNS);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'chunk_fts%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    assert.deepEqual(tables, ["chunks", "claim_evidence", "claim_judgments", "paper_sources", "papers", "passage_vectors", "registry_state", "verify_runs"]);
    const version = getRow<{ user_version: number }>(db.prepare("PRAGMA user_version"));
    assert.equal(version?.user_version, REGISTRY_SCHEMA_VERSION);
  });

  it("is idempotent: a re-init keeps rows, schema and the rendered bibliography", () => {
    register(paper("Quantum Networks"));
    const columnsBefore = columnsOf(db, "papers");
    const bibBefore = bibText();

    const second = createRegistry(root);
    second.close();

    assert.deepEqual(columnsOf(db, "papers"), columnsBefore);
    assert.equal(listPapers(db).length, 1);
    assert.equal(bibText(), bibBefore, "the re-render is byte-identical");
  });

  it("refuses to open when the registry file is missing", () => {
    db.close();
    rmSync(join(root, ".registry", "registry.db"));
    assert.throws(
      () => openRegistry(root),
      (err: unknown) => err instanceof RegistryError && err.code === "REGISTRY_NOT_INITIALIZED",
    );
    db = createRegistry(root); // restore for afterEach
  });

  it("refuses non-SQLite bytes as REGISTRY_CORRUPT", () => {
    db.close();
    writeFileSync(join(root, ".registry", "registry.db"), "this is definitely not a sqlite database", "utf-8");
    assert.throws(
      () => openRegistry(root),
      (err: unknown) => err instanceof RegistryError && err.code === "REGISTRY_CORRUPT",
    );
    rmSync(join(root, ".registry", "registry.db"));
    db = createRegistry(root);
  });

  it("refuses a foreign schema version as REGISTRY_SCHEMA_UNSUPPORTED", () => {
    db.close();
    const raw = openRaw(1000);
    raw.exec(`PRAGMA user_version = 99`);
    raw.close();
    assert.throws(
      () => openRegistry(root),
      (err: unknown) => err instanceof RegistryError && err.code === "REGISTRY_SCHEMA_UNSUPPORTED",
    );
    const repair = openRaw(1000);
    repair.exec(`PRAGMA user_version = ${REGISTRY_SCHEMA_VERSION}`);
    repair.close();
    db = createRegistry(root);
  });

  it("init refuses to re-initialize a foreign schema version instead of rewriting it", () => {
    db.close();
    const raw = openRaw(1000);
    raw.exec(`PRAGMA user_version = 99`);
    raw.close();
    assert.throws(
      () => createRegistry(root),
      (err: unknown) => err instanceof RegistryError && err.code === "REGISTRY_SCHEMA_UNSUPPORTED",
    );
    const repair = openRaw(1000);
    repair.exec(`PRAGMA user_version = ${REGISTRY_SCHEMA_VERSION}`);
    repair.close();
    db = createRegistry(root);
  });
});

// ── registration (R5, R13, KTD8) ───────────────────────────────────────────

describe("registerPaper", () => {
  it("registers a DOI with provider BibTeX: citable row, entry under the pinned citekey", () => {
    const outcome = register(paper("Quantum Networks"));

    assert.equal(outcome.status, "registered");
    assert.equal(outcome.citekey, "smith2020quantum");
    assert.equal(outcome.citable, true);
    assert.deepEqual(outcome.warnings, []);

    const rows = listPapers(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.citable, true);
    assert.equal(rows[0]!.bibtexSource, "crossref");
    assert.match(bibText(), /@article\{smith2020quantum,/);
    assert.doesNotMatch(bibText(), /Provider_Key_/, "the provider's key is never rendered");
  });

  it("registers without provider BibTeX as uncitable, absent from the bibliography, with a BIBTEX_UNAVAILABLE outcome warning", () => {
    const none = register(paper("Working Draft", { bibtex: null, bibtexSource: null }));
    assert.equal(none.citable, false);
    assert.deepEqual(none.warnings, ["BIBTEX_UNAVAILABLE"]);

    // BibTeX the bibliography cannot re-key is not provider-citable BibTeX either.
    const malformed = register(paper("Other Draft", { bibtex: "not bibtex at all", bibtexSource: null }));
    assert.equal(malformed.citable, false);
    assert.deepEqual(malformed.warnings, ["BIBTEX_UNAVAILABLE"]);

    assert.doesNotMatch(bibText(), /Working Draft/);
    assert.doesNotMatch(bibText(), /Other Draft/);
    const rows = listPapers(db);
    assert.deepEqual(
      rows.map((r) => [r.citekey, r.citable, r.bibtexSource]),
      [
        ["smith2020other", false, null],
        ["smith2020working", false, null],
      ],
    );
  });

  it("re-registering with improved BibTeX upgrades citability and keeps the pinned citekey", () => {
    const first = register(paper("Working Draft", { bibtex: null, bibtexSource: null }));
    assert.equal(first.citable, false);

    const improved = register(paper("Quantum Networks", { doi: first.doi }));
    assert.equal(improved.status, "updated");
    assert.equal(improved.citekey, first.citekey, "the citekey never moves (R11)");
    assert.equal(improved.citable, true);
    assert.deepEqual(improved.warnings, []);

    assert.match(bibText(), /@article\{smith2020working,/);
    assert.match(bibText(), /Quantum Networks/);
    assert.equal(listPapers(db)[0]!.bibtexSource, "crossref");
  });

  it("re-registering without usable BibTeX never demotes a citable row (MAX rule)", () => {
    const first = register(paper("Quantum Networks"));
    assert.equal(first.citable, true);
    const before = bibText();
    const storedPair = (): { provider_bibtex: string; bibtex_source: string | null; citable: number } => {
      const row = getRow<{ provider_bibtex: string; bibtex_source: string | null; citable: number }>(
        db.prepare("SELECT provider_bibtex, bibtex_source, citable FROM papers WHERE doi = ?"),
        first.doi,
      );
      assert.ok(row, "the registered row must exist");
      return { ...row };
    };
    const original = storedPair();

    for (const bibtex of [null, "not bibtex at all"] as const) {
      const again = register(paper("Quantum Networks, revised", { doi: first.doi, bibtex }));
      assert.equal(again.status, "updated");
      assert.equal(again.citekey, first.citekey);
      assert.equal(again.citable, true, "the receipt reports the STORED state, not the incoming record");
      assert.deepEqual(again.warnings, []);
      assert.deepEqual(storedPair(), original, `the stored pair stands for bibtex=${JSON.stringify(bibtex)}`);
      assert.equal(bibText(), before, "the file is a byte-identical image of the unchanged BibTeX");
    }

    assert.equal(listPapers(db)[0]!.title, "Quantum Networks, revised", "non-BibTeX metadata is latest-wins");
  });

  it("refuses malformed DOIs with INVALID_DOI (bare arXiv IDs are not DOIs)", () => {
    for (const bad of ["not-a-doi", "1234.5678", ""]) {
      assert.throws(
        () => register(paper("Whatever", { doi: bad })),
        (err: unknown) => err instanceof RegistryError && err.code === "INVALID_DOI",
        `expected INVALID_DOI for ${JSON.stringify(bad)}`,
      );
    }
    assert.equal(listPapers(db).length, 0);
  });

  it("normalizes DOI surface forms to one identity", () => {
    const a = register(paper("Mixed Case", { doi: "10.1000/MixEdCase" }));
    const b = register(paper("Mixed Case", { doi: "https://doi.org/10.1000/mixedcase" }));
    const c = register(paper("Mixed Case", { doi: "doi:10.1000/MIXEDCASE" }));

    assert.equal(a.status, "registered");
    assert.equal(b.status, "updated");
    assert.equal(c.status, "updated");
    assert.equal(listPapers(db).length, 1);
    assert.equal(listPapers(db)[0]!.doi, "10.1000/mixedcase");
    assert.equal(bibKeys().length, 1, "one paper, one entry");
  });
});

// ── citekeys (R11) ─────────────────────────────────────────────────────────

describe("citekeys", () => {
  it("derives the base key from first author family, year and first significant title word", () => {
    assert.equal(generateCitekey(["Ashish Vaswani", "Noam Shazeer"], 2017, "Attention Is All You Need"), "vaswani2017attention");
    assert.equal(generateCitekey(["Smith, Alice"], 2020, "The Quantum Computing Survey"), "smith2020quantum");
    assert.equal(generateCitekey(["François Chollet"], 2017, "Xception: Deep Learning"), "chollet2017xception");
    assert.equal(generateCitekey([], null, ""), "unknownnodatepaper");
  });

  it("assigns collision suffixes in registration order and reuses a freed suffix deterministically", () => {
    const first = register(paper("Quantum Networks"));
    const second = register(paper("Quantum Sensing"));
    const third = register(paper("Quantum Memory"));
    assert.deepEqual(
      [first, second, third].map((o) => o.citekey),
      ["smith2020quantum", "smith2020quantuma", "smith2020quantumb"],
      "suffixes follow registration order, not DOI or title order",
    );

    deregisterPapers(db, [second.citekey]);
    const fourth = register(paper("Quantum Gates"));
    assert.equal(fourth.citekey, "smith2020quantuma", "the freed suffix is the first free key again");
  });

  it("never moves a citekey when metadata is corrected", () => {
    const first = register(paper("Quantum Networks"));
    const corrected = register(paper("Entangled Networks", { doi: first.doi, authors: ["Alice Smuth"], year: 2021 }));
    assert.equal(corrected.citekey, "smith2020quantum", "\\cite{} in the manuscript must keep resolving");
  });
});

// ── deregistration (R17's core half) ───────────────────────────────────────

describe("deregisterPapers", () => {
  it("removes by citekey and by DOI, reports missing handles, and re-renders the bibliography", () => {
    const a = register(paper("Quantum Networks"));
    const b = register(paper("Sensing Things", { authors: ["Bob Brown"], year: 2021 }));

    const result = deregisterPapers(db, [a.citekey, b.doi, "10.1000/never-registered"]);

    assert.deepEqual(
      result.removed.map((r) => r.citekey).sort(),
      [a.citekey, b.citekey].sort(),
    );
    assert.deepEqual(result.missing, ["10.1000/never-registered"]);
    assert.equal(listPapers(db).length, 0);
  });

  it("deduplicates handles in one call", () => {
    const a = register(paper("Quantum Networks"));
    const result = deregisterPapers(db, [a.citekey, a.citekey]);
    assert.equal(result.removed.length, 1);
    assert.deepEqual(result.missing, []);
    assert.equal(listPapers(db).length, 0);
  });
});

// ── listing (R6 order contract) ────────────────────────────────────────────

describe("listPapers", () => {
  it("lists rows in citekey order with parsed display fields", () => {
    register(paper("Zebra Crossing", { authors: ["Zoe Zed"], venue: "Nature" }));
    register(paper("Aardvark Study", { authors: ["Ann Adams"], year: 2019 }));
    register(paper("Working Draft", { authors: ["Mia Mill"], bibtex: null, bibtexSource: null }));

    const rows = listPapers(db);
    assert.deepEqual(rows.map((r) => r.citekey), ["adams2019aardvark", "mill2020working", "zed2020zebra"]);
    assert.deepEqual(rows[0]!.authors, ["Ann Adams"]);
    assert.equal(rows[0]!.year, 2019);
    assert.equal(rows[2]!.venue, "Nature");
    assert.equal(rows[2]!.citable, true);
    assert.equal(rows[1]!.citable, false);
    assert.equal(rows[0]!.bibtexSource, "crossref");
  });
});

// ── cross-process serialization (R15) ──────────────────────────────────────

describe("registry busy handling", () => {
  it("surfaces REGISTRY_BUSY after the 5 s busy timeout when another writer holds the lock", () => {
    register(paper("Quantum Networks"));
    const holder = openRaw(BUSY_TIMEOUT_MS);
    holder.exec("BEGIN IMMEDIATE");
    holder.prepare("SELECT COUNT(*) FROM papers").get();

    const started = Date.now();
    assert.throws(
      () => register(paper("Quantum Sensing")),
      (err: unknown) => err instanceof RegistryError && err.code === "REGISTRY_BUSY",
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 4500, `the busy wait must exhaust the ${BUSY_TIMEOUT_MS} ms policy, took ${elapsed} ms`);

    holder.exec("ROLLBACK");
    holder.close();

    const outcome = register(paper("Quantum Sensing"));
    assert.equal(outcome.status, "registered", "the lock is taken again once the holder releases");
  });

  it("maps a contended lock to REGISTRY_BUSY on a short-timeout handle without the full wait", () => {
    const holder = openRaw(10_000);
    holder.exec("BEGIN IMMEDIATE");
    const short = openRaw(100);
    try {
      const started = Date.now();
      assert.throws(
        () => syncBibliography(short),
        (err: unknown) => err instanceof RegistryError && err.code === "REGISTRY_BUSY",
      );
      assert.ok(Date.now() - started < 2000, "the mapping must honor the handle's own timeout");
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
      short.close();
    }
  });
});
