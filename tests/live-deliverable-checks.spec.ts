/**
 * Deliverable evaluator (scripts/live/deliverable-checks.ts): behavior-first
 * coverage for the researcher-deliverable unit. Each case pins a required
 * behavior from the unit brief; all fail on the verbatim-extraction baseline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  checkBibliography,
  checkCitationsInRegistry,
  checkCompiledCurrent,
  collectCompileInputs,
  checkEvidenceTable,
  checkEvidenceToolsUsed,
  checkPointerProvenance,
  collectDeliverablePointers,
  countSources,
  defaultResolveEntry,
  extractVerifyHits,
  mergeRegistryPages,
  normalizeEvidenceClaim,
  normalizeManuscriptText,
  parseCitedKeys,
  parseEvidenceTable,
  parseScenarioSections,
  readEvidenceTableFile,
  recordCompileSnapshot,
  resolveExpectedEntry,
  snapshotCompileAssets,
  type EvidenceRow,
  type RegistryRecord,
  type ToolEnd,
} from "../scripts/live/deliverable-checks.ts";

const REV = "0123456789abcdef";
const PTR = (doi: string, s: number, e: number): string => `${doi}@${REV}#${s}-${e}`;

function rec(over: Partial<RegistryRecord> = {}): RegistryRecord {
  return { doi: "10.1000/alpha", citekey: "alpha2024", citable: true, source: { status: "ready", revision: REV }, ...over };
}

function end(over: Partial<ToolEnd> = {}): ToolEnd {
  return { toolCallId: "c1", name: "verify", isError: false, text: "", structured: null, ...over };
}

function verifyEnd(claim: string, pointers: string[], citekeys: string[]): ToolEnd {
  const evidence = pointers.map((pointer, i) => ({ attested: true, doi: pointer.split("@")[0], pointer, citekey: citekeys[i] ?? citekeys[0], revision: REV }));
  return end({ name: "verify", structured: { claim, result: { supportFound: true }, evidence }, text: `ok ${pointers.join(" ")}` });
}

// ── sources: ready ONLY, pagination, citable ─────────────────────────────────

describe("countSources", () => {
  it("counts ready only; acquiring/unavailable/failed are separate", () => {
    const c = countSources([
      rec(),
      rec({ doi: "10.1000/b", citekey: "b", source: { status: "acquiring", revision: null } }),
      rec({ doi: "10.1000/c", citekey: "c", source: { status: "unavailable", revision: null } }),
      rec({ doi: "10.1000/d", citekey: "d", source: { status: "failed", revision: null } }),
      rec({ doi: "10.1000/e", citekey: "e", source: { status: "metadata_only", revision: null } }),
    ]);
    assert.equal(c.ready, 1);
    assert.equal(c.acquiring, 1);
    assert.equal(c.unavailable, 1);
    assert.equal(c.failed, 1);
    assert.equal(c.metadataOnly, 1);
  });
});

describe("mergeRegistryPages", () => {
  it("honors read pagination: concatenates every page in order", () => {
    const merged = mergeRegistryPages([
      { records: [rec()], nextCursor: "tok" },
      { records: [rec({ doi: "10.1000/b", citekey: "b" })], nextCursor: null },
    ]);
    assert.deepEqual(merged.map((r) => r.citekey), ["alpha2024", "b"]);
  });
});

describe("checkCitationsInRegistry", () => {
  it("fails an uncitable registered key: citable metadata is honored", () => {
    const c = checkCitationsInRegistry(["alpha2024"], [rec({ citable: false })]);
    assert.equal(c.ok, false);
  });

  it("requires citable === true: missing, null and false all fail, like the evidence-table check", () => {
    const missing = { doi: "10.1000/alpha", citekey: "alpha2024", source: { status: "ready", revision: REV } } as RegistryRecord;
    assert.equal(checkCitationsInRegistry(["alpha2024"], [missing]).ok, false, "missing citable must fail");
    assert.equal(checkCitationsInRegistry(["alpha2024"], [rec({ citable: null as unknown as boolean })]).ok, false, "null citable must fail");
    assert.equal(checkCitationsInRegistry(["alpha2024"], [rec({ citable: false })]).ok, false, "false citable must fail");
    assert.equal(checkCitationsInRegistry(["alpha2024"], [rec({ citable: true })]).ok, true, "true citable passes");
  });
});

// ── cites and bibliography ───────────────────────────────────────────────────

describe("parseCitedKeys", () => {
  it("parses optional arguments and comma-separated keys", () => {
    assert.deepEqual(parseCitedKeys("see \\citep[see][p.~3]{alpha2024, beta2025} and \\citet[chap.~2]{gamma9}"), [
      "alpha2024",
      "beta2025",
      "gamma9",
    ]);
  });

  it("ignores commented-out cites", () => {
    assert.deepEqual(parseCitedKeys("% \\cite{hidden2024}\nreal \\cite{shown2024}\n"), ["shown2024"]);
  });

  it("does not treat nocite wildcard as a required key", () => {
    assert.deepEqual(parseCitedKeys("\\nocite{*}\n\\cite{shown2024}"), ["shown2024"]);
  });
});

describe("checkBibliography", () => {
  it("fails when a cited key is missing from the .bib", () => {
    const c = checkBibliography("@article{alpha2024,\n author={A},\n}\n", ["alpha2024", "beta2025"], [
      rec(),
      rec({ doi: "10.1000/b", citekey: "beta2025" }),
    ]);
    assert.equal(c.ok, false);
  });

  it("fails a bibliography key with no registry record", () => {
    const c = checkBibliography("@article{ghost2024,\n author={G},\n}\n", ["ghost2024"], [rec()]);
    assert.equal(c.ok, false);
  });
});

// ── pointers: deliverable surface, verify-only provenance ────────────────────

describe("pointer provenance", () => {
  const rows: EvidenceRow[] = [{ claim: "X holds", citekeys: ["alpha2024"], pointers: [PTR("10.1000/alpha", 0, 10)], status: "verified" }];

  it("collects manuscript and evidence-table pointers, not chat finals", () => {
    const got = collectDeliverablePointers(`text ${PTR("10.1000/alpha", 0, 10)}`, rows);
    assert.deepEqual(got, [PTR("10.1000/alpha", 0, 10)]);
    assert.deepEqual(collectDeliverablePointers("no pointers here", []), []);
  });

  it("extracts hits only from successful verify results, never search", () => {
    const hits = extractVerifyHits([
      verifyEnd("X holds", [PTR("10.1000/alpha", 0, 10)], ["alpha2024"]),
      end({ toolCallId: "c2", name: "passages", structured: null, text: `retrieved ${PTR("10.1000/alpha", 5, 15)}` }),
      end({ toolCallId: "c3", name: "verify", isError: true, structured: null, text: "Refused: VERIFY_X" }),
    ]);
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0]!.pointers, [PTR("10.1000/alpha", 0, 10)]);
  });

  it("a search-only pointer is not verification provenance", () => {
    const c = checkPointerProvenance([PTR("10.1000/alpha", 5, 15)], extractVerifyHits([
      end({ toolCallId: "c2", name: "passages", structured: null, text: `hit ${PTR("10.1000/alpha", 5, 15)}` }),
    ]));
    assert.equal(c.ok, false);
  });

  it("a deliverable pointer with exact successful-verify provenance passes", () => {
    const c = checkPointerProvenance(
      [PTR("10.1000/alpha", 0, 10)],
      extractVerifyHits([verifyEnd("X holds", [PTR("10.1000/alpha", 0, 10)], ["alpha2024"])]),
    );
    assert.equal(c.ok, true);
  });
});

// ── evidence tools: successful verify required ───────────────────────────────

describe("checkEvidenceToolsUsed", () => {
  it("retrieval alone does not establish factual verification", () => {
    const c = checkEvidenceToolsUsed(
      { passages: 3 },
      [end({ toolCallId: "c2", name: "passages", structured: null, text: "hits" })],
    );
    assert.equal(c.ok, false);
  });

  it("passes on a successful verify with support", () => {
    const c = checkEvidenceToolsUsed(
      { verify: 1 },
      [verifyEnd("X holds", [PTR("10.1000/alpha", 0, 10)], ["alpha2024"])],
    );
    assert.equal(c.ok, true);
  });
});

// ── evidence table ───────────────────────────────────────────────────────────

describe("checkEvidenceTable", () => {
  const records = [rec()];
  const hits = [{ claim: "X holds", pointers: [PTR("10.1000/alpha", 0, 10)], citekeys: ["alpha2024"], supportFound: true }];

  it("accepts a row whose exact claim, pointer and revision map to a successful verify", () => {
    const rows = parseEvidenceTable(
      JSON.stringify([{ claim: "X holds", citekeys: ["alpha2024"], pointers: [PTR("10.1000/alpha", 0, 10)], status: "verified" }]),
    );
    assert.equal(checkEvidenceTable(rows, hits, records).ok, true);
  });

  it("fails a stale-revision pointer", () => {
    const rows: EvidenceRow[] = [
      { claim: "X holds", citekeys: ["alpha2024"], pointers: ["10.1000/alpha@ffffffffffffffff#0-10"], status: "verified" },
    ];
    assert.equal(checkEvidenceTable(rows, hits, records).ok, false);
  });

  it("fails a verified-status row with no matching successful verify", () => {
    const rows: EvidenceRow[] = [{ claim: "Unseen claim", citekeys: ["alpha2024"], pointers: [PTR("10.1000/alpha", 0, 10)], status: "verified" }];
    assert.equal(checkEvidenceTable(rows, [], records).ok, false);
  });

  it("allows explicit unverified rows as disclosed limitations, not verified status", () => {
    const rows: EvidenceRow[] = [{ claim: "Open question", citekeys: [], pointers: [], status: "unverified" }];
    const c = checkEvidenceTable(rows, [], records);
    assert.equal(c.ok, true);
  });

  it("fails an unverified row that still carries pointers (fabricated verified status)", () => {
    const rows: EvidenceRow[] = [
      { claim: "Open question", citekeys: ["alpha2024"], pointers: [PTR("10.1000/alpha", 0, 10)], status: "no-support" },
    ];
    assert.equal(checkEvidenceTable(rows, hits, records).ok, false);
  });
});

// ── compilation: entry-bound digest provenance ───────────────────────────────

function projectWithManuscript(): string {
  const root = mkdtempSync(join(tmpdir(), "deliverable-"));
  mkdirSync(join(root, "manuscript"), { recursive: true });
  mkdirSync(join(root, "refs"), { recursive: true });
  mkdirSync(join(root, "build"), { recursive: true });
  writeFileSync(join(root, "manuscript/main.tex"), "\\documentclass{article}\n\\input{section1}\n\\bibliography{../refs/references}\n");
  writeFileSync(join(root, "manuscript/section1.tex"), "hello \\cite{alpha2024}\n");
  writeFileSync(join(root, "refs/references.bib"), "@article{alpha2024,\n author={A},\n}\n");
  writeFileSync(join(root, "build/main.pdf"), "%PDF-1.4 compiled-bytes\n");
  writeFileSync(join(root, "notes.tex"), "unrelated draft\n");
  return root;
}

describe("compile provenance", () => {
  it("default resolver picks the manuscript convention, not an arbitrary .tex", () => {
    assert.equal(defaultResolveEntry(["manuscript/main.tex", "notes.tex"]), "manuscript/main.tex");
    assert.equal(resolveExpectedEntry(null, ["manuscript/main.tex", "notes.tex"]), "manuscript/main.tex");
    assert.equal(resolveExpectedEntry("manuscript/main.tex", ["manuscript/main.tex", "notes.tex"]), "manuscript/main.tex");
  });

  it("snapshot covers the entry, its inputs and the bibliography; current passes untouched", () => {
    const root = projectWithManuscript();
    const snap = recordCompileSnapshot(root, { status: "compiled", entry: "manuscript/main.tex", pdfPath: "build/main.pdf" });
    assert.ok(snap);
    assert.ok(Object.keys(snap!.files).includes("manuscript/main.tex"));
    assert.ok(Object.keys(snap!.files).includes("refs/references.bib"));
    assert.equal(checkCompiledCurrent(root, [snap!], "manuscript/main.tex").ok, true);
  });

  it("a bibliography change after compile fails the check", () => {
    const root = projectWithManuscript();
    const snap = recordCompileSnapshot(root, { status: "compiled", entry: "manuscript/main.tex", pdfPath: "build/main.pdf" });
    writeFileSync(join(root, "refs/references.bib"), "@article{alpha2024,\n author={CHANGED},\n}\n");
    assert.equal(checkCompiledCurrent(root, [snap!], "manuscript/main.tex").ok, false);
  });

  it("a hand-touched PDF fails the provenance check", () => {
    const root = projectWithManuscript();
    const snap = recordCompileSnapshot(root, { status: "compiled", entry: "manuscript/main.tex", pdfPath: "build/main.pdf" });
    writeFileSync(join(root, "build/main.pdf"), "%PDF-1.4 hand-edited-by-human\n");
    assert.equal(checkCompiledCurrent(root, [snap!], "manuscript/main.tex").ok, false);
  });

  it("a compile naming a missing PDF yields no trusted snapshot, and a later-created PDF still fails", () => {
    const root = projectWithManuscript();
    rmSync(join(root, "build/main.pdf")); // the compile result names a PDF that does not exist
    const snap = recordCompileSnapshot(root, { status: "compiled", entry: "manuscript/main.tex", pdfPath: "build/main.pdf" });
    assert.equal(snap, null, "a missing PDF must not produce a trusted snapshot");
    writeFileSync(join(root, "build/main.pdf"), "%PDF-1.4 planted-after-compile\n");
    assert.equal(checkCompiledCurrent(root, snap === null ? [] : [snap], "manuscript/main.tex").ok, false);
  });

  it("a compile naming an unconfined PDF yields no trusted snapshot", () => {
    const root = projectWithManuscript();
    assert.equal(recordCompileSnapshot(root, { status: "compiled", entry: "manuscript/main.tex", pdfPath: "../outside.pdf" }), null);
    assert.equal(recordCompileSnapshot(root, { status: "compiled", entry: "manuscript/main.tex", pdfPath: "/tmp/outside.pdf" }), null);
  });

  it("a snapshot without a PDF digest is not trusted", () => {
    const root = projectWithManuscript();
    const snap = recordCompileSnapshot(root, { status: "compiled", entry: "manuscript/main.tex", pdfPath: "build/main.pdf" });
    assert.equal(checkCompiledCurrent(root, [{ ...snap!, pdfDigest: null }], "manuscript/main.tex").ok, false);
  });

  it("an unrelated .tex outside the entry does not fail the check", () => {
    const root = projectWithManuscript();
    const snap = recordCompileSnapshot(root, { status: "compiled", entry: "manuscript/main.tex", pdfPath: "build/main.pdf" });
    writeFileSync(join(root, "notes.tex"), "more unrelated draft\n");
    assert.equal(checkCompiledCurrent(root, [snap!], "manuscript/main.tex").ok, true);
  });

  it("snapshotCompileAssets is deterministic for unchanged trees", () => {
    const root = projectWithManuscript();
    assert.deepEqual(snapshotCompileAssets(root, "manuscript/main.tex"), snapshotCompileAssets(root, "manuscript/main.tex"));
  });
});

// ── manuscript association normalization ─────────────────────────────────────

describe("manuscript association", () => {
  const assoc = (claim: string, manuscript: string): boolean =>
    normalizeManuscriptText(manuscript).includes(normalizeEvidenceClaim(claim));

  it("a removed cite leaves no space before closing punctuation", () => {
    assert.equal(assoc("X reduces memory.", "X reduces memory \\cite{k}."), true);
    assert.equal(assoc("X reduces memory.", "X reduces memory\\cite{k}."), true);
    assert.equal(assoc("A, B, and C hold.", "A, B, and C hold \\cite[p.~3]{k}."), true);
    assert.equal(assoc("X reduces memory.", "X \\cite{k} reduces memory."), true);
  });

  it("a TeX tie (~) is whitespace: `text~\\cite{k}.` and `Table~2` match the plain claim (iteration 6: all 12 rows failed on this)", () => {
    assert.equal(assoc("X reduces memory.", "X reduces memory~\\cite{k}."), true);
    assert.equal(assoc("X reduces memory.", "X reduces memory~\\citep[p.~3]{k}."), true);
    assert.equal(assoc("See Table 2 for details.", "See Table~2 for details."), true);
    assert.equal(assoc("by 3 times.", "by~4 times~\\cite{k}."), false);
    assert.equal(assoc("see Table 2.", "see Table~3."), false);
  });

  it("any word, number, negation, ordering or sign change still fails", () => {
    assert.equal(assoc("by 3 times.", "by 4 times \\cite{k}."), false);
    assert.equal(assoc("is competitive", "is not competitive \\cite{k}"), false);
    assert.equal(assoc("reduces memory", "increases memory \\cite{k}"), false);
    assert.equal(assoc("memory reduces X", "X reduces memory \\cite{k}."), false);
    assert.equal(assoc("0.09%", "0.90\\%"), false);
  });

  it("a claim tail past % is compared, never cut (no vacuous pass)", () => {
    assert.equal(assoc("The rate is 0.09% and the gap is wide.", "The rate is 0.09\\% and the gap is narrow \\cite{k}."), false);
    assert.equal(assoc("The rate is 0.09% and the gap is narrow.", "The rate is 0.09\\% and the gap is narrow \\cite{k}."), true);
  });

  it("a real manuscript % comment is still ignored, and \\% never starts one", () => {
    assert.equal(assoc("text more", "text % a comment\n more"), true);
    assert.equal(assoc("0.09% of x", "0.09\\% of x"), true);
  });

  it("the check itself fails a row whose full claim text is not in the manuscript", () => {
    const records = [rec()];
    const claim = "The rate is 0.09% and the gap is wide.";
    const hits = [{ claim, pointers: [PTR("10.1000/alpha", 0, 10)], citekeys: ["alpha2024"], supportFound: true }];
    const rows: EvidenceRow[] = [{ claim, citekeys: ["alpha2024"], pointers: [PTR("10.1000/alpha", 0, 10)], status: "verified" }];
    const manuscript = { citedKeys: ["alpha2024"], pointers: [PTR("10.1000/alpha", 0, 10)], entryText: "The rate is 0.09\\% and the gap is narrow \\cite{alpha2024}." };
    const c = checkEvidenceTable(rows, hits, records, manuscript);
    assert.equal(c.ok, false);
    assert.match(c.detail, /association/);
  });
});

// ── evidence-table failure detail states the total ───────────────────────────

describe("evidence-table failure detail", () => {
  const records = [rec()];
  const failing = (n: number): EvidenceRow[] =>
    Array.from({ length: n }, (_, i) => ({ claim: `Unseen ${i}`, citekeys: ["alpha2024"], pointers: [PTR("10.1000/alpha", 0, 10)], status: "verified" }));

  it("states the exact total for 1, 5 and 8 problems, showing the first five", () => {
    assert.equal(
      checkEvidenceTable(failing(1), [], records).detail,
      "1 problem(s): row 0: exact claim has no successful verify (Unseen 0)",
    );
    assert.equal(
      checkEvidenceTable(failing(5), [], records).detail,
      "5 problem(s): " + [0, 1, 2, 3, 4].map((i) => `row ${i}: exact claim has no successful verify (Unseen ${i})`).join("; "),
    );
    assert.equal(
      checkEvidenceTable(failing(8), [], records).detail,
      "8 problem(s): " + [0, 1, 2, 3, 4].map((i) => `row ${i}: exact claim has no successful verify (Unseen ${i})`).join("; ") + " (+3 more)",
    );
  });
});

// ── scenario sections for the new multi-section host ─────────────────────────
describe("parseScenarioSections", () => {
  it("reads Prompt, Success, the evidence-table path and the expected entry", () => {
    const spec = parseScenarioSections(
      ["## Prompt", "do research", "## Success", "a manuscript", "## Evidence table", "path evidence/claims.json", "## Entry", "manuscript/main.tex", ""].join("\n"),
    );
    assert.equal(spec.prompt, "do research");
    assert.equal(spec.success, "a manuscript");
    assert.equal(spec.evidenceTablePath, "evidence/claims.json");
    assert.equal(spec.expectedEntry, "manuscript/main.tex");
  });

  it("leaves the table path null when the scenario declares no requirement", () => {
    const spec = parseScenarioSections("## Prompt\np\n## Success\ns\n");
    assert.equal(spec.evidenceTablePath, null);
  });
});

// ── repair: false passes (review 2026-10-13) ────────────────────────────────

describe("repair: paper-attested hits only", () => {
  const records = [rec()];
  const goodHits = [{ claim: "X holds", pointers: [PTR("10.1000/alpha", 0, 10)], citekeys: ["alpha2024"], supportFound: true }];

  it("caller-supplied text with supportFound is not a hit (no paper provenance)", () => {
    const hits = extractVerifyHits([
      end({ name: "verify", structured: { claim: "X holds", result: { supportFound: true }, evidence: [{ attested: false, provenance: "caller_supplied_text", index: 0, excerpt: "X holds", judgment: { score: 0.99 } }] }, text: "SUPPORT FOUND" }),
    ]);
    assert.equal(hits.length, 0);
  });

  it("unattested items carrying a pointer are dropped", () => {
    const hits = extractVerifyHits([
      end({ name: "verify", structured: { claim: "X holds", result: { supportFound: true }, evidence: [{ attested: false, pointer: PTR("10.1000/alpha", 0, 10), citekey: "alpha2024" }] }, text: "x" }),
    ]);
    assert.equal(hits[0]?.pointers.length ?? 0, 0);
  });

  it("a verified row needs nonempty citekeys and pointers", () => {
    const rows: EvidenceRow[] = [{ claim: "X holds", citekeys: [], pointers: [], status: "verified" }];
    assert.equal(checkEvidenceTable(rows, goodHits, records).ok, false);
  });

  it("pointer revision must equal a ready non-null source revision", () => {
    const row: EvidenceRow[] = [{ claim: "X holds", citekeys: ["alpha2024"], pointers: [PTR("10.1000/alpha", 0, 10)], status: "verified" }];
    assert.equal(checkEvidenceTable(row, goodHits, [rec({ source: { status: "ready", revision: null } })]).ok, false);
    assert.equal(checkEvidenceTable(row, goodHits, [rec({ source: { status: "unavailable", revision: REV } })]).ok, false);
  });

  it("citekeys need citable:true from the read, not mere presence", () => {
    const rows: EvidenceRow[] = [{ claim: "X holds", citekeys: ["alpha2024"], pointers: [PTR("10.1000/alpha", 0, 10)], status: "verified" }];
    assert.equal(checkEvidenceTable(rows, goodHits, [{ doi: "10.1000/alpha", citekey: "alpha2024" }]).ok, false);
  });

  it("direct-text-only verify does not count as evidence-tool use", () => {
    const c = checkEvidenceToolsUsed({ verify: 1 }, [
      end({ name: "verify", structured: { claim: "X holds", result: { supportFound: true }, evidence: [{ attested: false, provenance: "caller_supplied_text", index: 0, excerpt: "X", judgment: { score: 1 } }] }, text: "SUPPORT" }),
    ]);
    assert.equal(c.ok, false);
  });

  it("hit evidence combines across continuation pages with the same exact claim", () => {
    const split = [
      { claim: "X holds", pointers: [PTR("10.1000/alpha", 0, 10)], citekeys: ["alpha2024"], supportFound: true },
      { claim: "X holds", pointers: [PTR("10.1000/alpha", 10, 20)], citekeys: ["alpha2024"], supportFound: true },
    ];
    const rows: EvidenceRow[] = [{ claim: "X holds", citekeys: ["alpha2024"], pointers: [PTR("10.1000/alpha", 0, 10)], status: "verified" }];
    assert.equal(checkEvidenceTable(rows, split, records).ok, true);
  });

  it("a verified claim must appear in the entry manuscript (exact association)", () => {
    const rows: EvidenceRow[] = [{ claim: "X holds", citekeys: ["alpha2024"], pointers: [PTR("10.1000/alpha", 0, 10)], status: "verified" }];
    const c = (checkEvidenceTable as any)(rows, goodHits, records, { citedKeys: ["alpha2024"], pointers: [PTR("10.1000/alpha", 0, 10)], entryText: "unrelated manuscript about frogs" });
    assert.equal(c.ok, false);
  });

  it("manuscript citekeys outside the table fail coverage", () => {
    const rows: EvidenceRow[] = [{ claim: "X holds", citekeys: ["alpha2024"], pointers: [PTR("10.1000/alpha", 0, 10)], status: "verified" }];
    const c = (checkEvidenceTable as any)(rows, goodHits, records, { citedKeys: ["alpha2024", "beta2025"], pointers: [], entryText: "X holds \\cite{alpha2024} \\cite{beta2025}" });
    assert.equal(c.ok, false);
  });
});

describe("repair: compile deps and confinement", () => {
  function nestedProject(): string {
    const root = mkdtempSync(join(tmpdir(), "deliverable-"));
    mkdirSync(join(root, "manuscript/sections"), { recursive: true });
    mkdirSync(join(root, "manuscript/figs"), { recursive: true });
    mkdirSync(join(root, "build"), { recursive: true });
    writeFileSync(join(root, "manuscript/main.tex"), "\\documentclass{article}\n\\input{sections/a}\n% \\input{hidden}\n\\graphicspath{{figs/}}\n\\includegraphics{plot}\n");
    writeFileSync(join(root, "manuscript/sections/a.tex"), "see \\input{shared}\n");
    writeFileSync(join(root, "manuscript/shared.tex"), "shared body\n");
    writeFileSync(join(root, "manuscript/figs/plot.png"), "PNGDATA");
    writeFileSync(join(root, "build/main.pdf"), "%PDF-1.4 bytes\n");
    return root;
  }

  it("resolves inputs against the entry compile cwd, not the child file dir", () => {
    const inputs = collectCompileInputs(nestedProject(), "manuscript/main.tex");
    assert.ok(inputs.includes("manuscript/shared.tex"), JSON.stringify(inputs));
    assert.ok(!inputs.some((f) => f === "manuscript/sections/shared" || f === "manuscript/sections/shared.tex"), JSON.stringify(inputs));
  });

  it("covers extensionless graphics via graphicspath and ignores comments", () => {
    const root = nestedProject();
    const inputs = collectCompileInputs(root, "manuscript/main.tex");
    assert.ok(!inputs.some((f) => f.includes("hidden")), JSON.stringify(inputs));
    const snap = recordCompileSnapshot(root, { status: "compiled", entry: "manuscript/main.tex", pdfPath: "build/main.pdf" });
    assert.ok(Object.keys(snap!.files).includes("manuscript/figs/plot.png"), JSON.stringify(Object.keys(snap!.files)));
  });

  it("confines symlink escapes to the project", () => {
    const root = mkdtempSync(join(tmpdir(), "deliverable-"));
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "evil.tex"), "evil\n");
    mkdirSync(join(root, "manuscript"), { recursive: true });
    symlinkSync(join(outside, "evil.tex"), join(root, "manuscript/evil.tex"));
    writeFileSync(join(root, "manuscript/main.tex"), "\\documentclass{article}\n\\input{evil}\n");
    const snap = recordCompileSnapshot(root, { status: "compiled", entry: "manuscript/main.tex", pdfPath: "manuscript/main.tex" });
    assert.ok(snap === null || !Object.keys(snap.files).includes("manuscript/evil.tex"), JSON.stringify(snap?.files));
  });

  it("a new dependency after the snapshot fails the check", () => {
    const root = mkdtempSync(join(tmpdir(), "deliverable-"));
    mkdirSync(join(root, "manuscript"), { recursive: true });
    mkdirSync(join(root, "build"), { recursive: true });
    writeFileSync(join(root, "manuscript/main.tex"), "\\documentclass{article}\n\\input{maybe}\n");
    writeFileSync(join(root, "build/main.pdf"), "%PDF-1.4 bytes\n");
    const snap = recordCompileSnapshot(root, { status: "compiled", entry: "manuscript/main.tex", pdfPath: "build/main.pdf" });
    writeFileSync(join(root, "manuscript/maybe.tex"), "late content\n");
    assert.equal(checkCompiledCurrent(root, [snap!], "manuscript/main.tex").ok, false);
  });

  it("a table path escaping the project is not read", () => {
    const root = mkdtempSync(join(tmpdir(), "deliverable-"));
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "claims.json"), "[]");
    assert.equal(readEvidenceTableFile(root, `../${basename(outside)}/claims.json`), null);
  });
});
