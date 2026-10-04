/**
 * Registry migration (R16): genuine v1/v2 registries upgrade to the current
 * schema without losing papers or citekeys; foreign/newer schemas are refused
 * without any mutation; unsourced legacy chunks never become evidence.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REGISTRY_SCHEMA_VERSION, RegistryError, createRegistry, openRegistry, listPapers } from "../src/core/registry.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { LEGACY_PAPER, V3_PAPER, buildForeignRegistry, buildLegacyRegistry, buildV3Registry, buildV4Registry } from "./helpers/legacy-registry.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-migrate-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const tables = (db: ReturnType<typeof openRegistry>): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

describe("registry migration", () => {
  for (const version of [1, 2] as const) {
    it(`v${version} registry opens at the current version with papers and citekeys intact`, () => {
      buildLegacyRegistry(root, version);
      const db = openRegistry(root);
      assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, REGISTRY_SCHEMA_VERSION);
      const [paper] = listPapers(db);
      assert.equal(paper.doi, LEGACY_PAPER.doi);
      assert.equal(paper.citekey, LEGACY_PAPER.citekey);
      assert.equal(paper.citable, true);
      assert.ok(tables(db).includes("paper_sources"), "v3 source table exists");
      db.close();
    });
  }

  it("a v3 registry gains section storage in place, keeping papers, source text, chunks and the version it is at", () => {
    buildV3Registry(root);
    const db = openRegistry(root);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, REGISTRY_SCHEMA_VERSION);
    const cols = (t: string): string[] => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols("paper_sources").includes("sections_json"));
    assert.ok(cols("chunks").includes("section"));
    const src = db.prepare("SELECT text, sections_json, chunk_policy FROM paper_sources WHERE doi = ?").get(V3_PAPER.doi) as { text: string; sections_json: string | null; chunk_policy: string };
    assert.equal(src.text, V3_PAPER.text);
    assert.equal(src.sections_json, null, "no marks were stored before; they are derived on the next rechunk");
    assert.equal(src.chunk_policy, "oldpolicy", "the policy stamp is left for the rechunk check to compare");
    const chunk = db.prepare("SELECT text, section FROM chunks WHERE doi = ?").get(V3_PAPER.doi) as { text: string; section: string | null };
    assert.equal(chunk.text, V3_PAPER.text);
    assert.equal(chunk.section, null);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM chunk_fts WHERE chunk_fts MATCH 'captured'").get() as { n: number }).n, 1, "the locator index still finds the migrated chunk");
    db.close();
  });

  it("a v4 registry gains the passage-vector cache in place and keeps its papers", () => {
    buildV4Registry(root);
    const db = openRegistry(root);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, REGISTRY_SCHEMA_VERSION);
    assert.ok(tables(db).includes("passage_vectors"));
    assert.equal(listPapers(db)[0].doi, "10.1234/v4paper");
    db.close();
  });

  it("a stale v3 migration run after another process migrated changes nothing", async () => {
    buildV3Registry(root);
    const first = openRegistry(root);
    first.prepare("UPDATE paper_sources SET sections_json = '[{\"start\":0,\"heading\":\"x\",\"level\":1}]' WHERE doi = ?").run(V3_PAPER.doi);
    const { migrateLegacy } = await import("../src/core/registry.ts");
    migrateLegacy(first, join(root, ".registry", "registry.db"), 3);
    assert.match((first.prepare("SELECT sections_json FROM paper_sources").get() as { sections_json: string }).sections_json, /"heading":"x"/);
    first.close();
  });

  it("legacy chunks, verdicts and pointers carry no source provenance and are not kept as evidence", () => {
    buildLegacyRegistry(root, 2);
    const db = openRegistry(root);
    const names = tables(db);
    for (const gone of ["claim_pointers", "claim_verdicts"]) assert.ok(!names.includes(gone), `${gone} dropped`);
    assert.equal((db.prepare("SELECT count(*) n FROM chunks").get() as { n: number }).n, 0, "unsourced chunk rows are not carried over");
    db.close();
  });

  it("a v2 registry that held legacy rows is backed up before they are dropped", () => {
    const file = buildLegacyRegistry(root, 2);
    openRegistry(root).close();
    assert.ok(existsSync(`${file}.v2.bak`), "backup copy exists");
    const bytes = readFileSync(`${file}.v2.bak`);
    assert.ok(bytes.includes(Buffer.from("legacy chunk")), "backup still holds the legacy chunk text");
  });

  it("migration is idempotent across reopen and re-init", () => {
    buildLegacyRegistry(root, 1);
    openRegistry(root).close();
    openRegistry(root).close();
    const db = createRegistry(root);
    assert.equal(listPapers(db).length, 1);
    db.close();
  });

  for (const [label, userVersion] of [["newer", 99], ["uninitialised foreign", 0], ["foreign lookalike above the current version", REGISTRY_SCHEMA_VERSION + 1]] as const) {
    it(`${label} schema (user_version ${userVersion}) is refused without mutation`, () => {
      const file = buildForeignRegistry(root, userVersion, "wal");
      const before = readFileSync(file);
      assert.throws(() => openRegistry(root), (e) => e instanceof RegistryError && e.code === "REGISTRY_SCHEMA_UNSUPPORTED");
      assert.deepEqual(readFileSync(file), before, "database bytes unchanged");
      assert.ok(!existsSync(`${file}.v2.bak`));
    });
  }

  it("re-init refuses a newer schema without mutation", () => {
    const file = buildForeignRegistry(root, 99);
    const before = readFileSync(file);
    assert.throws(() => createRegistry(root), (e) => e instanceof RegistryError && e.code === "REGISTRY_SCHEMA_UNSUPPORTED");
    assert.deepEqual(readFileSync(file), before);
  });
});

describe("registry migration — races and foreign files", () => {
  it("a second process that read the legacy version before another migrated cannot drop the new tables' rows", async () => {
    buildLegacyRegistry(root, 2);
    const first = openRegistry(root); // process A migrates and publishes a source with chunks
    const { registerPaper: reg } = await import("../src/core/registry.ts");
    void reg;
    first.prepare("INSERT INTO paper_sources (doi, status, prepared_at, kind, revision, chunk_policy, text) VALUES (?, 'ready', ?, 'local-file', ?, 'pol', ?)").run(LEGACY_PAPER.doi, "2026-10-04T00:00:00Z", "r".repeat(16), "some captured text that is long enough");
    first.prepare("INSERT INTO chunks (doi, chunk_index, chunk_id, revision, char_start, char_end, est_tokens, content_hash, text) VALUES (?, 0, 'c0', ?, 0, 10, 3, 'h', 'some text')").run(LEGACY_PAPER.doi, "r".repeat(16));
    // process B, which had read user_version 2 before A finished, now runs the migration body
    const { migrateLegacy } = await import("../src/core/registry.ts");
    migrateLegacy(first, join(root, ".registry", "registry.db"), 2);
    assert.equal((first.prepare("SELECT COUNT(*) n FROM chunks").get() as { n: number }).n, 1, "v3 chunks survive a stale migration");
    assert.equal(existsSync(join(root, ".registry", "registry.db.v2.bak")), true);
    first.close();
  });

  it("init refuses a foreign file that merely never set user_version, without adding a single table", () => {
    const file = join(root, ".registry", "registry.db");
    mkdirSync(join(root, ".registry"), { recursive: true });
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TABLE somebody_elses (x TEXT); INSERT INTO somebody_elses VALUES ('keep')");
    raw.close();
    const before = readFileSync(file);
    assert.throws(() => createRegistry(root), (e) => e instanceof RegistryError && e.code === "REGISTRY_SCHEMA_UNSUPPORTED");
    assert.deepEqual(readFileSync(file), before);
  });

  it("init still creates a registry in an empty database file", () => {
    const file = join(root, ".registry", "registry.db");
    mkdirSync(join(root, ".registry"), { recursive: true });
    new DatabaseSync(file).close();
    const db = createRegistry(root);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, REGISTRY_SCHEMA_VERSION);
    db.close();
  });
});
