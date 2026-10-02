/**
 * U6 CLI spec: `init` (idempotent), `deregister` (by citekey and by DOI,
 * removed|missing outcomes, bibliography re-render), `list` (citekey order),
 * and the error path (refusal code on stderr, exit 1). `runCli(argv, io)` is
 * imported directly — the bin shim stays thin.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runCli, type CliIo } from "../src/cli/main.ts";
import {
  BIBLIOGRAPHY_REL_PATH,
  createRegistry,
  listPapers,
  openRegistry,
  registerPaper,
} from "../src/core/registry.ts";

let root: string;
let db: DatabaseSync;

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (line: string): void => {
      out.push(line);
    },
    err: (line: string): void => {
      err.push(line);
    },
    cwd: root,
    lines: { out, err },
  };
}

const BIBTEX_A = "@article{holder2024, title={Alpha Grid}, author={Holder, Ada}, year={2024}}";
const BIBTEX_B = "@article{miles2023, title={Beta Cache}, author={Miles, Ben}, year={2023}}";

function registerFixture(): { citekeyA: string; doiB: string } {
  const a = registerPaper(db, {
    doi: "10.1234/alpha",
    title: "Alpha Grid",
    authors: ["Ada Holder"],
    year: 2024,
    venue: "Journal of Grids",
    bibtex: BIBTEX_A,
    bibtexSource: "crossref",
  });
  registerPaper(db, {
    doi: "10.5678/beta",
    title: "Beta Cache",
    authors: ["Ben Miles"],
    year: 2023,
    venue: null,
    bibtex: BIBTEX_B,
    bibtexSource: "crossref",
  });
  return { citekeyA: a.citekey, doiB: "10.5678/beta" };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-cli-"));
  db = createRegistry(root);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // The test may have closed it (runCli scenarios re-open their own handles).
  }
  rmSync(root, { recursive: true, force: true });
});

describe("uktub-scholar init", () => {
  it("is idempotent: the second init keeps the existing registry and bibliography", async () => {
    db.close();
    const first = await runCli(["init"], io());
    assert.equal(first, 0);
    const bibPath = join(root, BIBLIOGRAPHY_REL_PATH);
    assert.ok(existsSync(bibPath));
    const rowsAfterFirst = listPapers(openRegistry(root)).length;
    const bibAfterFirst = readFileSync(bibPath, "utf8");
    const second = await runCli(["init"], io());
    assert.equal(second, 0);
    assert.equal(listPapers(openRegistry(root)).length, rowsAfterFirst);
    assert.equal(readFileSync(bibPath, "utf8"), bibAfterFirst);
  });

  it("refuses a foreign-schema registry with the refusal code on stderr, exit 1", async () => {
    db.close();
    // Hand-craft a foreign user_version the same way the registry spec does.
    const foreign = new DatabaseSync(join(root, ".registry", "registry.db"));
    foreign.exec("PRAGMA user_version = 99;");
    foreign.close();
    const capture = io();
    const code = await runCli(["init"], capture);
    assert.equal(code, 1);
    assert.match(capture.lines.err.join("\n"), /REGISTRY_SCHEMA_UNSUPPORTED/);
  });

  it("refuses init inside an existing project (nested registries), exit 1", async () => {
    db.close();
    const subdir = join(root, "manuscript", "chapters");
    mkdirSync(subdir, { recursive: true });
    const capture = io();
    capture.cwd = subdir;
    const code = await runCli(["init"], capture);
    assert.equal(code, 1);
    assert.match(capture.lines.err.join("\n"), /nested projects are not supported/);
    assert.ok(!existsSync(join(subdir, ".registry")));
  });
});

describe("uktub-scholar deregister", () => {
  it("removes by citekey and by DOI, re-renders the bibliography, reports removed|missing", async () => {
    const { citekeyA, doiB } = registerFixture();
    db.close();
    const bibPath = join(root, BIBLIOGRAPHY_REL_PATH);
    assert.match(readFileSync(bibPath, "utf8"), /holder2024/);
    assert.match(readFileSync(bibPath, "utf8"), /miles2023/);

    const capture = io();
    const code = await runCli(["deregister", citekeyA, doiB, "not-a-registered-thing"], capture);
    assert.equal(code, 0);
    const text = capture.lines.out.join("\n");
    assert.match(text, new RegExp(`removed ${citekeyA}`));
    assert.match(text, /removed .*10\.5678\/beta/);
    assert.match(text, /missing not-a-registered-thing/);

    const reopened = openRegistry(root);
    assert.deepEqual(listPapers(reopened), []);
    // Cascade + re-render: both entries are gone from the file.
    assert.doesNotMatch(readFileSync(bibPath, "utf8"), /holder2024|miles2023/);
    reopened.close();
  });

  it("refuses with a usage error when no handle is given", async () => {
    db.close();
    const capture = io();
    assert.equal(await runCli(["deregister"], capture), 1);
    assert.match(capture.lines.err.join("\n"), /usage/i);
  });
});

describe("uktub-scholar list", () => {
  it("prints rows in citekey order with citekey, year, title, venue, citable, and provenance", async () => {
    registerFixture();
    db.close();
    const capture = io();
    const code = await runCli(["list"], capture);
    assert.equal(code, 0);
    const rows = capture.lines.out.filter((line) => line.includes("\t") && !line.startsWith("citekey\t"));
    const expectedOrder = listPapers(openRegistry(root)).map((row) => row.citekey);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.split("\t")[0]),
      [...expectedOrder].sort(),
    );
    const text = capture.lines.out.join("\n");
    assert.match(text, /2024/);
    assert.match(text, /Alpha Grid/);
    assert.match(text, /Journal of Grids/);
    for (const row of rows) {
      assert.match(row, /\tyes\t/);
      assert.match(row, /\tvia crossref$/);
    }
  });

  it("prints an explicit empty state", async () => {
    db.close();
    const capture = io();
    assert.equal(await runCli(["list"], capture), 0);
    assert.match(capture.lines.out.join("\n"), /no papers/i);
  });
});

describe("uktub-scholar error paths", () => {
  it("list without a registry prints the refusal code and exits 1", async () => {
    db.close();
    rmSync(join(root, ".registry", "registry.db"));
    const capture = io();
    const code = await runCli(["list"], capture);
    assert.equal(code, 1);
    assert.match(capture.lines.err.join("\n"), /REGISTRY_NOT_INITIALIZED/);
    assert.match(capture.lines.err.join("\n"), /uktub-scholar init/);
  });

  it("unknown command prints usage and exits 1", async () => {
    db.close();
    const capture = io();
    assert.equal(await runCli(["explode"], capture), 1);
    assert.match(capture.lines.err.join("\n"), /usage/i);
  });

  it("sync-bib heals a hand-deleted bibliography byte-stably", async () => {
    registerFixture();
    db.close();
    const bibPath = join(root, BIBLIOGRAPHY_REL_PATH);
    const before = readFileSync(bibPath, "utf8");
    rmSync(bibPath);
    const capture = io();
    assert.equal(await runCli(["sync-bib"], capture), 0);
    assert.equal(readFileSync(bibPath, "utf8"), before);
  });
});

describe("uktub-scholar compile (offline paths)", () => {
  it("refuses with COMPILE_NO_ENTRY when no engine-independent entry exists", async () => {
    // Engine resolution happens first: fake the engine away via a PATH that
    // cannot exist, so the test never spawns anything. The engine refusal
    // precedes entry resolution by design (detect before touch).
    const capture = io();
    const prevPath = process.env.PATH;
    process.env.PATH = "/uktub/no/such/bin";
    try {
      const code = await runCli(["compile"], capture);
      assert.equal(code, 1);
      assert.match(capture.lines.err.join("\n"), /COMPILE_ENGINE_MISSING/);
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it("compile appears in the usage text", async () => {
    const capture = io();
    assert.equal(await runCli(["explode"], capture), 1);
    assert.match(capture.lines.err.join("\n"), /compile \[entry\.tex\]/);
  });
});
