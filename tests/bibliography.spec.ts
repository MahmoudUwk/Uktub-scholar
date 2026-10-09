/**
 * Bibliography spec (U2): `refs/references.bib` is a deterministic image of
 * the citable registry rows (R12, R18) — byte-stable re-renders, citekey
 * order, provider BibTeX never synthesized (R13), the product's live-run
 * normalizers (month macros, HTML entities, LaTeX-safe `&`), atomic staged
 * render with temp-file sweep, sync-bib healing, and the render-as-last-
 * statement-before-COMMIT contract (KTD5) including its failure paths.
 *
 * The golden bytes below were captured by running the product's own renderer
 * (UktubAI_Agentic/deploy/sandbox-image/pi-registry.js publishPaper) over the
 * same two rows in this session.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, StatementSync } from "node:sqlite";

import { RegistryError, createRegistry, deregisterPapers, listPapers, registerPaper, syncBibliography } from "../src/core/registry.ts";
import type { PaperRecord } from "../src/core/registry.ts";

/** node:sqlite hands back `Record<string, SQLOutputValue>` rows; one boundary cast, then typed reads. */
function allRows<T extends object>(statement: StatementSync, ...params: SQLInputValue[]): T[] {
  return statement.all(...params) as T[];
}

/** The human is trusted: editing the read-only rendered bibliography is a deliberate chmod first. */
function humanEdit(path: string, content: string): void {
  chmodSync(path, 0o644);
  writeFileSync(path, content);
}

// ── fixtures ───────────────────────────────────────────────────────────────

let root: string;
let db: DatabaseSync;
let doiCounter = 0;

const FIXED_NOW = () => new Date("2026-01-01T00:00:00Z");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-bibliography-"));
  db = createRegistry(root);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const refsDir = (): string => join(root, "refs");
const bibText = (): string => readFileSync(join(refsDir(), "references.bib"), "utf8");
/** The keys the file states, in file order. */
const bibKeys = (): string[] => [...bibText().matchAll(/^@\w+\{([^,}\s]+)[,}]/gm)].map((m) => m[1]!);
const strayTemps = (): string[] => (existsSync(refsDir()) ? readdirSync(refsDir()).filter((name) => name.endsWith(".tmp")) : []);

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

function openRaw(timeoutMs: number): DatabaseSync {
  const conn = new DatabaseSync(join(root, ".registry", "registry.db"), { timeout: timeoutMs });
  conn.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys = ON;");
  return conn;
}


/** The citable keys the registry says the file must state. */
function registryBibKeys(): string[] {
  return allRows<{ citekey: string }>(
    db.prepare("SELECT citekey FROM papers WHERE citable = 1 AND provider_bibtex IS NOT NULL ORDER BY citekey"),
  ).map((row) => row.citekey);
}

/** Registers one paper carrying only `fields` as BibTeX body, returns the file. */
function renderWith(fields: string): string {
  const doi = `10.1000/render-${(doiCounter += 1)}`;
  register(
    paper(`Render case ${doiCounter}`, {
      doi,
      bibtex: `@article{Provider_Key, ${fields} }`,
    }),
  );
  return bibText();
}

// ── deterministic render (R12, R18) ────────────────────────────────────────

describe("bibliography render", () => {
  it("renders the same rows to byte-identical output in citekey order", () => {
    register(paper("Zebra Crossing", { authors: ["Zoe Zed"] }));
    register(paper("Aardvark Study", { authors: ["Ann Adams"], year: 2019 }));
    register(paper("Median Path", { authors: ["Max Miller"] }));
    const first = bibText();

    assert.deepEqual(bibKeys(), ["adams2019aardvark", "miller2020median", "zed2020zebra"], "stable order is citekey order");
    assert.deepEqual(bibKeys(), registryBibKeys(), "the file states exactly the registry's citable rows");

    assert.deepEqual(syncBibliography(db), { syncedCount: 3 });
    assert.equal(bibText(), first, "a re-render of unchanged rows must not change one byte");
    assert.deepEqual(syncBibliography(db), { syncedCount: 3 });
    assert.equal(bibText(), first);
    assert.deepEqual(strayTemps(), []);
  });

  it("byte-compares against the product renderer's output for the same rows", () => {
    // Golden captured from UktubAI_Agentic's pi-registry.js publishPaper
    // (its schema + its render path) over exactly these two records.
    const GOLDEN = `% Generated from .registry/registry.db — do not edit; register papers instead.

@article{adams2019aardvark,
  title = {Aardvark Study},
  publisher = {Wiley \\& Sons},
  year = {2019},
  note = {Niño \\& La Niña}
}

@article{zed2020quantum,
  title = {Quantum Networks},
  journal = {Environmental Science \\& Technology},
  year = {2020},
  month = jun,
  doi = {10.1000/gold-1},
  url = {https://example.org/a?x=1&y=2}
}
`;
    register(
      paper("Aardvark Study", {
        doi: "10.1000/gold-2",
        authors: ["Ann Adams"],
        year: 2019,
        bibtex: "@article{Provider_Key_2,\n  title = {Aardvark Study},\n  publisher = {Wiley & Sons},\n  year = {2019},\n  note = {Ni&#241;o &amp; La Ni&#xF1;a}\n}",
      }),
    );
    register(
      paper("Quantum Networks", {
        doi: "10.1000/gold-1",
        authors: ["Zoe Zed"],
        year: 2020,
        bibtex: "@article{Provider_Key_1,\n  title = {Quantum Networks},\n  journal = {Environmental Science &amp;amp; Technology},\n  year = {2020},\n  month = June,\n  doi = {10.1000/gold-1},\n  url = {https://example.org/a?x=1&amp;y=2}\n}",
      }),
    );
    assert.equal(bibText(), GOLDEN);
  });

  it("keeps uncitable papers out of the file but still gives them a stable pinned key", () => {
    const uncitable = register(paper("Working Draft", { bibtex: null, bibtexSource: null }));
    assert.equal(uncitable.citekey, "smith2020working");
    assert.doesNotMatch(bibText(), /Working Draft/);
    assert.equal(listPapers(db)[0]!.citable, false);

    const malformed = register(paper("Other Draft", { bibtex: "not bibtex at all" }));
    assert.equal(malformed.citable, false);
    assert.deepEqual(bibKeys(), []);
  });

  it("renders the header-only file for an empty registry and releases the write lock", () => {
    assert.deepEqual(syncBibliography(db), { syncedCount: 0 });
    assert.equal(db.isTransaction, false, "the render-only transaction must release the lock");
    register(paper("Quantum Networks")); // a second writer can take the lock immediately
    assert.deepEqual(bibKeys(), registryBibKeys());
  });

  it("the rendered file is read-only, so no host's edit tool can add a fabricated entry; a re-render still replaces it", () => {
    const a = register(paper("Quantum Networks"));
    const bib = join(refsDir(), "references.bib");
    assert.equal(statSync(bib).mode & 0o222, 0, "no write bit on the rendered bibliography");
    if (process.getuid?.() !== 0) {
      assert.throws(() => writeFileSync(bib, `${bibText()}@article{invented, title={Not a real paper}}\n`), /EACCES|EPERM/);
      assert.deepEqual(bibKeys(), [a.citekey], "the refused write changed nothing");
    }
    const b = register(paper("Sensing Things", { authors: ["Bob Brown"], year: 2021 }));
    assert.deepEqual(bibKeys(), [a.citekey, b.citekey].sort(), "the next registry write replaces the read-only file");
    assert.equal(statSync(bib).mode & 0o222, 0, "and the new image is read-only again");
    chmodSync(bib, 0o644); // the human is trusted and may make it writable on purpose
    writeFileSync(bib, "% a deliberate human edit\n");
    assert.equal(bibText(), "% a deliberate human edit\n");
  });

  it("sweeps a dead writer's staging file under the lock, and only ours", () => {
    mkdirSync(refsDir(), { recursive: true });
    writeFileSync(join(refsDir(), "references.bib.99999.tmp"), "orphan of a writer killed mid-write");
    writeFileSync(join(refsDir(), "notes.tmp"), "not ours");
    writeFileSync(join(refsDir(), "references.bib.backup"), "not ours either");

    register(paper("Quantum Networks"));

    assert.deepEqual(readdirSync(refsDir()).sort(), ["notes.tmp", "references.bib", "references.bib.backup"]);
  });
});

// ── sync-bib healing (R12, R17's core half) ────────────────────────────────

describe("syncBibliography", () => {
  it("restores a stale, hand-edited, missing file and a missing refs/ directory byte for byte", () => {
    register(paper("Quantum Networks"));
    register(paper("Quantum Sensing"));
    const image = bibText();

    const damage: Array<[string, () => void]> = [
      ["a stale older image", () => humanEdit(join(refsDir(), "references.bib"), "% Generated from .registry/registry.db — no citable papers registered yet.\n")],
      ["a hand edit", () => humanEdit(join(refsDir(), "references.bib"), `${image}@article{handwritten, title={Not in the registry}}\n`)],
      ["a missing file", () => rmSync(join(refsDir(), "references.bib"))],
      ["a missing refs/ directory", () => rmSync(refsDir(), { recursive: true, force: true })],
    ];
    for (const [label, harm] of damage) {
      harm();
      assert.deepEqual(syncBibliography(db), { syncedCount: 2 }, label);
      assert.equal(bibText(), image, `${label}: parity is restored byte for byte`);
      assert.deepEqual(bibKeys(), registryBibKeys());
      assert.deepEqual(syncBibliography(db), { syncedCount: 2 }, `${label}: idempotent`);
      assert.equal(bibText(), image);
    }
    assert.deepEqual(strayTemps(), []);
  });

  it("deregistration re-renders the file as the registry sheds the entry", () => {
    const a = register(paper("Quantum Networks"));
    const b = register(paper("Sensing Things", { authors: ["Bob Brown"], year: 2021 }));
    assert.deepEqual(bibKeys(), [a.citekey, b.citekey].sort());

    deregisterPapers(db, [a.citekey]);
    assert.deepEqual(bibKeys(), [b.citekey]);
  });
});

// ── failure paths: the render is the last statement before COMMIT (KTD5) ───

describe("transactional render failures", () => {
  it("rolls the registration back and keeps the previous file when the render fails mid-transaction", () => {
    register(paper("Quantum Networks"));
    const before = bibText();
    // A directory squatting on this process's staging path makes the write itself fail.
    const squatter = join(refsDir(), `references.bib.${process.pid}.tmp`);
    mkdirSync(squatter);

    assert.throws(() => register(paper("Quantum Sensing")), /EISDIR/);
    assert.equal(db.isTransaction, false, "the failed write must not leave the write lock held");
    assert.equal(listPapers(db).some((r) => r.title === "Quantum Sensing"), false, "no row survives a failed render");
    assert.equal(bibText(), before);

    rmSync(squatter, { recursive: true });
    const retried = register(paper("Quantum Sensing"));
    assert.equal(retried.status, "registered", "the registry is not wedged by the earlier failure");
    assert.deepEqual(bibKeys(), registryBibKeys());
    assert.equal(bibKeys().length, 2);
  });

  it("a failure after staging removes its temp file and rolls the rows back", () => {
    // The rename onto a directory fails AFTER the temp file was written.
    rmSync(join(refsDir(), "references.bib"));
    mkdirSync(join(refsDir(), "references.bib"), { recursive: true });
    assert.throws(() => register(paper("Quantum Networks")));
    assert.deepEqual(strayTemps(), [], "no references.bib.<pid>.tmp is left behind");
    assert.equal(listPapers(db).length, 0, "the registration rolled back");
    assert.equal(db.isTransaction, false);
  });

  it("a failed COMMIT rolls the publication back and re-renders the file from the unchanged registry", () => {
    register(paper("Quantum Networks"));
    const before = bibText();
    // A deferred foreign key a trigger violates: the statements succeed and the COMMIT itself fails.
    db.exec("CREATE TABLE commit_guard (paper_id TEXT REFERENCES papers(doi) DEFERRABLE INITIALLY DEFERRED);");
    db.exec(`CREATE TRIGGER fail_commit AFTER INSERT ON papers WHEN new.title = 'Commit Victim'
      BEGIN INSERT INTO commit_guard (paper_id) VALUES ('no-such-paper'); END;`);

    assert.throws(() => register(paper("Commit Victim")), /FOREIGN KEY constraint failed/);
    assert.equal(db.isTransaction, false, "the failed commit must not leave the write lock held");
    assert.equal(listPapers(db).some((r) => r.title === "Commit Victim"), false, "the rows roll back with the failed commit");
    assert.equal(bibText(), before, "the file never stays ahead of the registry");
    assert.deepEqual(strayTemps(), []);

    db.exec("DROP TRIGGER fail_commit;");
    const retried = register(paper("Commit Victim"));
    assert.equal(retried.status, "registered", "the same handle is healthy once the fault is gone");
    assert.deepEqual(bibKeys(), registryBibKeys());
  });

  it("a COMMIT refused by a concurrent reader surfaces REGISTRY_BUSY and the file is healed", () => {
    register(paper("Quantum Networks"));
    const before = bibText();
    const writer = openRaw(150);
    const reader = openRaw(150);
    try {
      reader.exec("BEGIN;");
      reader.prepare("SELECT COUNT(*) FROM papers").get(); // holds a SHARED lock: a COMMIT cannot get EXCLUSIVE
      assert.throws(
        () => registerPaper(writer, paper("Quantum Sensing"), { now: FIXED_NOW }),
        (err: unknown) => err instanceof RegistryError && err.code === "REGISTRY_BUSY",
      );
      assert.equal(writer.isTransaction, false);
      assert.equal(bibText(), before, "the render that preceded the refused COMMIT is undone");
      assert.deepEqual(strayTemps(), []);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
      writer.close();
    }
    assert.equal(listPapers(db).some((r) => r.title === "Quantum Sensing"), false);
    const retried = register(paper("Quantum Sensing"));
    assert.equal(retried.status, "registered");
    assert.deepEqual(bibKeys(), registryBibKeys());
    assert.equal(bibKeys().length, 2);
  });
});

// ── provider month names → BibTeX month macros (2026-09-29 live run) ───────

describe("month macro normalization", () => {
  it("rewrites a bare full month name to the standard macro", () => {
    for (const [name, macro] of [
      ["June", "jun"],
      ["July", "jul"],
      ["september", "sep"],
      ["SEPTEMBER", "sep"],
      ["Sept", "sep"],
      ["December", "dec"],
    ] as const) {
      const bib = renderWith(`year={2020}, month=${name}`);
      assert.match(bib, new RegExp(`month=${macro}(?=[,\\s}])`), `${name} -> ${macro}`);
      assert.doesNotMatch(bib, new RegExp(`month=${name}`), `${name} is gone`);
    }
  });

  it("leaves macros, braced values, numbers and other fields untouched", () => {
    for (const month of ["month=Apr", "month=may", "month={June}", "month = {July}", "month={6}", "month=6"]) {
      assert.ok(renderWith(`year={2020}, ${month}`).includes(month), `${month} stays verbatim`);
    }
    const noMonth = renderWith("year={2020}, note={reported in June}");
    assert.ok(noMonth.includes("note={reported in June}"));
  });

  it("does not depend on order: the same rows give byte-identical output", () => {
    const doi = `10.1000/stable-${(doiCounter += 1)}`;
    const record = paper("A month test", { doi, bibtex: "@article{Provider_Key, title={A month test}, year={2020}, month=June, pages={1} }" });
    register(record);
    const first = bibText();
    register(record);
    assert.equal(bibText(), first);
  });
});

// ── provider HTML entities → LaTeX (2026-09-29 live run) ──────────────────

describe("entity and ampersand normalization", () => {
  it("decodes single and double escaped ampersands and escapes the result for LaTeX", () => {
    assert.ok(renderWith("journal={Environmental Science &amp;amp; Technology}").includes("journal={Environmental Science \\& Technology}"));
    assert.ok(renderWith("journal={Science &amp; Technology}").includes("journal={Science \\& Technology}"));
    assert.ok(renderWith("publisher={Wiley & Sons}").includes("publisher={Wiley \\& Sons}"), "a bare & is escaped too");
  });

  it("leaves an already escaped ampersand alone and decodes the other XML entities and numeric references", () => {
    assert.ok(renderWith("journal={A \\& B}").includes("journal={A \\& B}"), "no double escaping");
    assert.ok(renderWith("title={Cats &lt; dogs &gt; birds, &quot;maybe&quot;}").includes('title={Cats < dogs > birds, "maybe"}'));
    assert.ok(renderWith("title={Ni&#241;o &amp; La Ni&#xF1;a}").includes("title={Niño \\& La Niña}"));
  });

  it("never rewrites url, doi or eprint values, where & is data", () => {
    const bib = renderWith("url={https://example.org/a?x=1&amp;y=2}, doi={10.1000/a&b}, journal={J &amp; K}");
    assert.ok(bib.includes("url={https://example.org/a?x=1&y=2}"), "url: entity decoded, & not escaped");
    assert.ok(bib.includes("doi={10.1000/a&b}"));
    assert.ok(bib.includes("journal={J \\& K}"));
  });

  it("leaves unknown entities and text without ampersands exactly as the provider wrote it", () => {
    // An unknown entity is not guessed at: it stays as text, with its & escaped so LaTeX prints it literally.
    assert.ok(renderWith("note={AT&T &unknownentity; plain}").includes("note={AT\\&T \\&unknownentity; plain}"));
    const plain = renderWith("title={No ampersands here}");
    assert.ok(plain.includes("title={No ampersands here}"));
  });
});
