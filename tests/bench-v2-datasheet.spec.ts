/**
 * Checks for the ATTRIBUTION.md builder for claim-verification-v2: licence short names, the per-paper credit table, the full document, and the CLI. Offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attributionDocument, attributionTable, licenseName, type Paper } from "../scripts/bench-v2-datasheet.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "bench-v2-datasheet.ts");

const paper = (over: Partial<Paper> = {}): Paper => ({
  id: "2609.18631v1",
  category: "q-bio.QM",
  title: "Automatic denoising and differentiation based on Savitzky-Golay filters",
  authors: ["Jane Q. Doe", "A. B. Smith"],
  license: "http://creativecommons.org/licenses/by/4.0/",
  sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ...over,
});

describe("licenseName", () => {
  it("names CC BY 4.0 and any other CC BY version by its number", () => {
    assert.equal(licenseName("http://creativecommons.org/licenses/by/4.0/"), "CC BY 4.0");
    assert.equal(licenseName("http://creativecommons.org/licenses/by/3.0/"), "CC BY 3.0");
  });
  it("names the CC0 public domain dedication", () => {
    assert.equal(licenseName("http://creativecommons.org/publicdomain/zero/1.0/"), "CC0 1.0");
  });
  it("accepts https and a missing trailing slash", () => {
    assert.equal(licenseName("https://creativecommons.org/licenses/by/4.0/"), "CC BY 4.0");
    assert.equal(licenseName("http://creativecommons.org/licenses/by/4.0"), "CC BY 4.0");
    assert.equal(licenseName("https://creativecommons.org/publicdomain/zero/1.0"), "CC0 1.0");
  });
  it("reports a closed licence as not an open licence", () => {
    assert.equal(licenseName("http://arxiv.org/licenses/nonexclusive-distrib/1.0/"), "not an open licence");
    assert.equal(licenseName("http://creativecommons.org/licenses/by-sa/4.0/"), "not an open licence");
    assert.equal(licenseName("http://creativecommons.org/licenses/by-nc/4.0/"), "not an open licence");
    assert.equal(licenseName(null), "not an open licence");
  });
});

describe("attributionTable", () => {
  it("starts with the stated header and a separator row", () => {
    const lines = attributionTable([paper()]).split("\n");
    assert.equal(lines[0], "| arXiv id | Title | Authors | Licence | PDF sha256 |");
    assert.match(lines[1] ?? "", /^\|(?:\s*-+\s*\|)+$/);
  });
  it("links the full id to the versionless abs page", () => {
    assert.ok(attributionTable([paper()]).includes("[2609.18631v1](https://arxiv.org/abs/2609.18631)"));
  });
  it("escapes pipes in cells and joins authors with commas", () => {
    const table = attributionTable([paper({ title: "A | B", authors: ["X", "Y"] })]);
    assert.ok(table.includes("A \\| B"));
    assert.ok(table.includes("X, Y"));
    assert.ok(!table.includes("A | B"));
  });
  it("prints (not recorded) for a paper with no authors", () => {
    assert.ok(attributionTable([paper({ authors: [] })]).includes("(not recorded)"));
  });
  it("links an open licence and prints a closed one as plain text", () => {
    assert.ok(attributionTable([paper()]).includes("[CC BY 4.0](http://creativecommons.org/licenses/by/4.0/)"));
    const closed = attributionTable([paper({ license: "http://arxiv.org/licenses/nonexclusive-distrib/1.0/" })]);
    assert.ok(closed.includes("not an open licence"));
    assert.ok(!closed.includes("](http://arxiv.org/licenses/nonexclusive-distrib/1.0/)"));
  });
  it("keeps the papers in the order given with a 16-character hash in backticks", () => {
    const a = paper({ id: "2609.18631v1", sha256: "a".repeat(64) });
    const b = paper({ id: "2610.00578v2", sha256: "b".repeat(64) });
    const table = attributionTable([a, b]);
    assert.ok(table.indexOf("2609.18631v1") < table.indexOf("2610.00578v2"));
    assert.ok(table.includes("`aaaaaaaaaaaaaaaa`"));
    assert.ok(table.includes("`bbbbbbbbbbbbbbbb`"));
    assert.ok(!table.includes("a".repeat(17)));
  });
});

describe("attributionDocument", () => {
  it("counts papers by licence with the most frequent first", () => {
    const papers = [
      paper({ license: "http://creativecommons.org/licenses/by/4.0/" }),
      paper({ license: "http://creativecommons.org/publicdomain/zero/1.0/" }),
      paper({ license: "http://creativecommons.org/publicdomain/zero/1.0/" }),
    ];
    assert.ok(attributionDocument({ papers }).includes("3 papers: 2 CC0 1.0, 1 CC BY 4.0"));
  });
  it("repeats the licence rule and keeps every quote under its own paper licence", () => {
    const doc = attributionDocument({ papers: [paper()], rule: { licenses: "CC BY (any version), CC0" } });
    assert.ok(doc.includes("CC BY (any version), CC0"));
    assert.match(doc, /quote/i);
    assert.ok(doc.includes("| arXiv id | Title | Authors | Licence | PDF sha256 |"));
  });
});

describe("the CLI", () => {
  it("writes the attribution document for the sample corpus", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "datasheet-"));
    const corpus = path.join(dir, "corpus.json");
    const out = path.join(dir, "ATTR.md");
    fs.writeFileSync(corpus, JSON.stringify({ rule: { licenses: "CC BY (any version), CC0" }, papers: [
      { id: "2609.18631v1", category: "q-bio.QM", title: "A paper", authors: ["Jane Q. Doe"], license: "http://creativecommons.org/licenses/by/4.0/", sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
      { id: "2610.00578v2", category: "astro-ph.GA", title: "Another paper", authors: [], license: "http://creativecommons.org/publicdomain/zero/1.0/", sha256: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210" },
    ] }));
    const run = spawnSync(process.execPath, [script, "--corpus", corpus, "--out", out], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const text = fs.readFileSync(out, "utf8");
    assert.ok(text.includes("2 papers:"));
    assert.ok(text.includes("2609.18631v1"));
    assert.ok(text.includes("2610.00578v2"));
  });
});
