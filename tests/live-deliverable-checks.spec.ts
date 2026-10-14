/**
 * Tier 1 deliverable evaluator (scripts/live/deliverable-checks.ts):
 * behavior-first coverage. Each case pins a required behavior; Tier 1 reads
 * the provenance JSON, the registry and file mtimes on small synthetic
 * projects. The archived-run differential lives in
 * live-tier1-differential.spec.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  checkBibliography,
  checkCitationsInRegistry,
  checkEvidenceToolsUsed,
  checkTierBibliography,
  checkTierCitations,
  checkTierFigures,
  checkTierPdfCurrent,
  checkTierPointers,
  collectCompileInputs,
  countSources,
  defaultResolveEntry,
  extractVerifyHits,
  mergeRegistryPages,
  parseCitedKeys,
  parseScenarioSections,
  provenanceCitedKeys,
  readTierPaperTexts,
  resolveExpectedEntry,
  tierReport,
  type RegistryRecord,
  type TierProvenanceDoc,
  type TierProvenanceUnit,
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

function unit(over: Partial<TierProvenanceUnit> = {}): TierProvenanceUnit {
  return { id: "u1", kind: "sentence", file: "manuscript/main.tex", line: 1, section: "", text: "X holds.", cites: ["alpha2024"], status: "cited", pointers: [], ...over };
}

function doc(over: Partial<TierProvenanceDoc> = {}): TierProvenanceDoc {
  return {
    entry: "manuscript/main.tex",
    summary: { words: 10, audited: 1, verified: 0, cited: 1, uncited: 0, figures: { ok: 0, check: 0, open: 0, info: 0 }, unregistered: [] },
    items: [],
    document_digest: "ab".repeat(32),
    units: [unit()],
    ...over,
  };
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

// ── T1.1/T1.2: cites come from the provenance units ──────────────────────────

describe("provenanceCitedKeys", () => {
  it("dedupes and sorts unit cites", () => {
    const d = doc({ units: [unit({ cites: ["beta2025", "alpha2024"] }), unit({ id: "u2", cites: ["alpha2024"] })] });
    assert.deepEqual(provenanceCitedKeys(d), ["alpha2024", "beta2025"]);
  });

  it("is empty when no unit cites a paper", () => {
    assert.deepEqual(provenanceCitedKeys(doc({ units: [unit({ cites: [] })] })), []);
  });
});

describe("checkTierCitations", () => {
  it("passes when every unit cite resolves to a citable entry", () => {
    assert.equal(checkTierCitations(doc(), [rec()]).ok, true);
  });

  it("fails an unregistered unit cite", () => {
    const c = checkTierCitations(doc({ units: [unit({ cites: ["ghost2024"] })] }), [rec()]);
    assert.equal(c.ok, false);
    assert.match(c.detail, /ghost2024/);
  });

  it("fails with no citations at all", () => {
    assert.equal(checkTierCitations(doc({ units: [unit({ cites: [] })] }), [rec()]).ok, false);
  });
});

describe("checkTierBibliography", () => {
  it("covers every unit cite with only registered keys", () => {
    const c = checkTierBibliography(doc(), "@article{alpha2024,\n author={A},\n}\n", [rec()]);
    assert.equal(c.ok, true);
  });

  it("fails a missing unit cite and a missing .bib alike", () => {
    assert.equal(checkTierBibliography(doc(), "@article{alpha2024,\n}\n", [rec(), rec({ doi: "10.1000/b", citekey: "beta2025" })]).ok, true);
    const d = doc({ units: [unit({ cites: ["alpha2024", "beta2025"] })] });
    assert.equal(checkTierBibliography(d, "@article{alpha2024,\n}\n", [rec(), rec({ doi: "10.1000/b", citekey: "beta2025" })]).ok, false);
    assert.equal(checkTierBibliography(doc(), null, [rec()]).ok, false);
  });
});

// ── T1.3: PDF newer than the last .tex edit ──────────────────────────────────

function pdfProject(): string {
  const root = mkdtempSync(join(tmpdir(), "tier1-"));
  mkdirSync(join(root, "manuscript"), { recursive: true });
  mkdirSync(join(root, "build"), { recursive: true });
  writeFileSync(join(root, "manuscript/main.tex"), "\\documentclass{article}\n\\begin{document}\nHi \\cite{alpha2024}.\n\\end{document}\n");
  writeFileSync(join(root, "build/main.pdf"), "%PDF-1.4 bytes\n");
  writeFileSync(join(root, "notes.tex"), "unrelated draft\n");
  return root;
}

const at = (root: string, rel: string, ms: number): void => {
  utimesSync(join(root, rel), new Date(ms), new Date(ms));
};

describe("checkTierPdfCurrent", () => {
  it("passes when the PDF is newer than the last entry .tex edit", () => {
    const root = pdfProject();
    at(root, "manuscript/main.tex", 1_000_000);
    at(root, "build/main.pdf", 2_000_000);
    const c = checkTierPdfCurrent(root, "manuscript/main.tex");
    assert.equal(c.ok, true);
    assert.match(c.detail, /build\/main\.pdf is newer/);
  });

  it("fails when a .tex edit is newer than the PDF", () => {
    const root = pdfProject();
    at(root, "manuscript/main.tex", 3_000_000);
    at(root, "build/main.pdf", 2_000_000);
    assert.equal(checkTierPdfCurrent(root, "manuscript/main.tex").ok, false);
  });

  it("fails closed with no PDF", () => {
    const root = pdfProject();
    at(root, "manuscript/main.tex", 1_000_000);
    assert.equal(checkTierPdfCurrent(join(root, "manuscript"), "main.tex").ok, false);
  });

  it("ignores .tex outside the entry but counts every .tex without one", () => {
    const root = pdfProject();
    at(root, "manuscript/main.tex", 1_000_000);
    at(root, "build/main.pdf", 2_000_000);
    at(root, "notes.tex", 9_000_000);
    assert.equal(checkTierPdfCurrent(root, "manuscript/main.tex").ok, true, "unrelated .tex outside the entry is ignored");
    assert.equal(checkTierPdfCurrent(root, null).ok, false, "without an entry every .tex counts");
  });
});

// ── T1.4: pointers resolve in the current revision text ──────────────────────

describe("checkTierPointers", () => {
  const papers = [{ doi: "10.1000/alpha", revision: REV, text: "0123456789abcdef" }];

  it("passes a pointer inside the current revision text", () => {
    const d = doc({ units: [unit({ pointers: [PTR("10.1000/alpha", 0, 10)] })] });
    assert.equal(checkTierPointers(d, papers).ok, true);
  });

  it("passes with no pointers", () => {
    assert.equal(checkTierPointers(doc(), papers).ok, true);
  });

  it("fails a stale revision, an unknown DOI, an outside span and a malformed pointer", () => {
    const stale = doc({ units: [unit({ pointers: [`10.1000/alpha@ffffffffffffffff#0-10`] })] });
    assert.equal(checkTierPointers(stale, papers).ok, false);
    const unknown = doc({ units: [unit({ pointers: [PTR("10.1000/ghost", 0, 10)] })] });
    const cUnknown = checkTierPointers(unknown, papers);
    assert.equal(cUnknown.ok, false);
    assert.match(cUnknown.detail, /not registered/);
    const outside = doc({ units: [unit({ pointers: [PTR("10.1000/alpha", 0, 17)] })] });
    assert.equal(checkTierPointers(outside, papers).ok, false);
    const malformed = doc({ units: [unit({ pointers: ["not-a-pointer"] })] });
    assert.equal(checkTierPointers(malformed, papers).ok, false);
  });

  it("fails when the paper text is missing", () => {
    const d = doc({ units: [unit({ pointers: [PTR("10.1000/alpha", 0, 10)] })] });
    assert.equal(checkTierPointers(d, [{ doi: "10.1000/alpha", revision: REV, text: null }]).ok, false);
  });
});

describe("readTierPaperTexts", () => {
  function registryDb(): string {
    const root = mkdtempSync(join(tmpdir(), "tier1-reg-"));
    mkdirSync(join(root, ".registry"), { recursive: true });
    const db = new DatabaseSync(join(root, ".registry", "registry.db"));
    db.exec("CREATE TABLE paper_sources (doi TEXT, status TEXT, revision TEXT, text TEXT)");
    db.prepare("INSERT INTO paper_sources (doi, status, revision, text) VALUES (?, ?, ?, ?)").run("10.1000/alpha", "ready", REV, "sometext");
    db.prepare("INSERT INTO paper_sources (doi, status, revision, text) VALUES (?, ?, ?, ?)").run("10.1000/old", "unavailable", null, null);
    db.close();
    return root;
  }

  it("reads ready papers with revision and text, skipping other states", () => {
    assert.deepEqual(readTierPaperTexts(registryDb()), [{ doi: "10.1000/alpha", revision: REV, text: "sometext" }]);
  });

  it("is null without a registry", () => {
    assert.equal(readTierPaperTexts(mkdtempSync(join(tmpdir(), "tier1-empty-"))), null);
  });
});

// ── T1.5: no open or unsourced figure ────────────────────────────────────────

describe("checkTierFigures", () => {
  const item = (status: string, token = "24 GB") => ({ status, token, file: "manuscript/main.tex", line: 5, section: "", kind: "row", papers: ["alpha2024"], why: `${token} ${status}` });

  it("passes with no flagged items", () => {
    assert.equal(checkTierFigures(doc()).ok, true);
  });

  it("passes uncited, check and unavailable figures (reported, not gated)", () => {
    const d = doc({ items: [item("uncited"), item("check"), item("unavailable")] });
    assert.equal(checkTierFigures(d).ok, true);
    assert.deepEqual(tierReport(d), { words: 10, verified: 0, cited: 1, uncited: 0, figuresUncited: 1, figuresCheck: 1, figuresUnavailable: 1 });
  });

  it("fails open and unsourced figures", () => {
    assert.equal(checkTierFigures(doc({ items: [item("open", "A100")] })).ok, false);
    const c = checkTierFigures(doc({ items: [item("unsourced", "48 GB")] }));
    assert.equal(c.ok, false);
    assert.match(c.detail, /48 GB/);
  });
});

// ── evidence tools: successful verify required (reported) ────────────────────

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

  it("direct-text-only verify does not count as evidence-tool use", () => {
    const c = checkEvidenceToolsUsed({ verify: 1 }, [
      end({ name: "verify", structured: { claim: "X holds", result: { supportFound: true }, evidence: [{ attested: false, provenance: "caller_supplied_text", index: 0, excerpt: "X", judgment: { score: 1 } }] }, text: "SUPPORT" }),
    ]);
    assert.equal(c.ok, false);
  });
});

describe("extractVerifyHits", () => {
  it("extracts hits only from successful verify results, never search", () => {
    const hits = extractVerifyHits([
      verifyEnd("X holds", [PTR("10.1000/alpha", 0, 10)], ["alpha2024"]),
      end({ toolCallId: "c2", name: "passages", structured: null, text: `retrieved ${PTR("10.1000/alpha", 5, 15)}` }),
      end({ toolCallId: "c3", name: "verify", isError: true, structured: null, text: "Refused: VERIFY_X" }),
    ]);
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0]!.pointers, [PTR("10.1000/alpha", 0, 10)]);
  });

  it("caller-supplied text with supportFound is not a hit (no paper provenance)", () => {
    const hits = extractVerifyHits([
      end({ name: "verify", structured: { claim: "X holds", result: { supportFound: true }, evidence: [{ attested: false, provenance: "caller_supplied_text", index: 0, excerpt: "X holds", judgment: { score: 0.99 } }] }, text: "SUPPORT FOUND" }),
    ]);
    assert.equal(hits.length, 0);
  });
});

// ── compilation inputs: entry-bound, confined ─────────────────────────────────

describe("compile inputs", () => {
  it("default resolver picks the manuscript convention, not an arbitrary .tex", () => {
    assert.equal(defaultResolveEntry(["manuscript/main.tex", "notes.tex"]), "manuscript/main.tex");
    assert.equal(resolveExpectedEntry(null, ["manuscript/main.tex", "notes.tex"]), "manuscript/main.tex");
    assert.equal(resolveExpectedEntry("manuscript/main.tex", ["manuscript/main.tex", "notes.tex"]), "manuscript/main.tex");
  });

  function nestedProject(): string {
    const root = mkdtempSync(join(tmpdir(), "tier1-"));
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
    const inputs = collectCompileInputs(nestedProject(), "manuscript/main.tex");
    assert.ok(!inputs.some((f) => f.includes("hidden")), JSON.stringify(inputs));
    assert.ok(inputs.includes("manuscript/figs/plot.png"), JSON.stringify(inputs));
  });

  it("confines symlink escapes to the project", () => {
    const root = mkdtempSync(join(tmpdir(), "tier1-"));
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "evil.tex"), "evil\n");
    mkdirSync(join(root, "manuscript"), { recursive: true });
    symlinkSync(join(outside, "evil.tex"), join(root, "manuscript/evil.tex"));
    writeFileSync(join(root, "manuscript/main.tex"), "\\documentclass{article}\n\\input{evil}\n");
    const inputs = collectCompileInputs(root, "manuscript/main.tex");
    assert.ok(!inputs.includes("manuscript/evil.tex"), JSON.stringify(inputs));
  });
});

// ── scenario sections ─────────────────────────────────────────────────────────

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
