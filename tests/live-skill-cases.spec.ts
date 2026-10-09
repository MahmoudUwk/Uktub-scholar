/**
 * Offline checks of the skill-case fixtures (scripts/live/skill-cases.ts): the data the live figure case plots, and the detector for
 * the overclaim an agent made about it in a real session.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { NotRun } from "../scripts/live/cases.ts";
import { writeFixturePptx } from "./helpers/pptx-fixture.ts";
import { acronymsNotInRequest, loadTestPaper, misplacedPrintedRefs, overclaimsAcrossSizes, pptxFacts, saveProjectOutputs, writeFigureFixtures, writeOwnPaper } from "../scripts/live/skill-cases.ts";

describe("figure case fixture", () => {
  it("is deterministic, and built so that 'ours at 500 examples' stays below 'the baseline at 5,000'", () => {
    const a = writeFigureFixtures(mkdtempSync(join(tmpdir(), "figfx-")));
    const b = writeFigureFixtures(mkdtempSync(join(tmpdir(), "figfx-")));
    assert.deepEqual(a.means, b.means);
    assert.deepEqual(a.sizes, [100, 200, 500, 1000, 2000, 5000]);
    assert.ok(a.means.ours![2]! < a.means.baseline![5]!, "the premise of the overclaim check no longer holds");
  });
});

describe("overclaimsAcrossSizes", () => {
  it("flags the sentences a real agent wrote that the data contradict", () => {
    assert.ok(overclaimsAcrossSizes("achieving higher accuracy with 500 examples than the baseline achieves with 5,000."));
    assert.ok(overclaimsAcrossSizes("matching with 500 examples what the baseline achieves only at 5,000."));
    assert.ok(overclaimsAcrossSizes("Ours at 500 examples outperforms the baseline trained on 5000 examples."));
  });
  it("lets true statements through", () => {
    assert.equal(overclaimsAcrossSizes("Ours is 7 to 9 percentage points above the baseline at every size from 100 to 5,000 examples."), undefined);
    assert.equal(overclaimsAcrossSizes("At 500 examples ours reaches 0.59; the baseline reaches 0.61 only with 5,000 examples."), undefined);
  });
});

describe("review case helpers", () => {
  it("pointerCheck accepts only file:line pointers that name a real file and an existing line", async () => {
    const { pointerCheck } = await import("../scripts/live/skill-cases.ts");
    const dir = mkdtempSync(join(tmpdir(), "ptr-"));
    writeFileSync(join(dir, "intro.tex"), "a\nb\nc\n");
    const r = pointerCheck("See intro.tex:2 and intro.tex:3 (the last line), intro.tex:4 (past the end), intro.tex:99, nothing.tex:1, and intro.tex:2 again.", dir);
    assert.deepEqual(r.valid.sort(), ["intro.tex:2", "intro.tex:3"]);
    assert.deepEqual(r.invalid.sort(), ["intro.tex:4", "intro.tex:99", "nothing.tex:1"]);
  });
  it("treeDigest changes when any file changes and not otherwise", async () => {
    const { treeDigest } = await import("../scripts/live/skill-cases.ts");
    const dir = mkdtempSync(join(tmpdir(), "dig-"));
    writeFileSync(join(dir, "a.tex"), "one");
    const first = treeDigest(dir);
    assert.equal(treeDigest(dir), first);
    writeFileSync(join(dir, "a.tex"), "two");
    assert.notEqual(treeDigest(dir), first);
  });
});

describe("unfoundQuotes", () => {
  it("matches quoted passages against the manuscript on letters and digits, so LaTeX markup does not matter, and reports invented ones", async () => {
    const { unfoundQuotes } = await import("../scripts/live/skill-cases.ts");
    const dir = mkdtempSync(join(tmpdir(), "quote-"));
    writeFileSync(join(dir, "r.tex"), "Compared to the baseline, our method reduces the mean error by about 5\\% (12.5 vs. 13.1 units).\nNo fixed random seed is set; each training run uses a fresh environment seed.\n");
    const answer = 'It says “our method reduces the mean error by about 5% (12.5 vs. 13.1 units)” and "each training run uses a fresh environment seed", but also “the authors guarantee convergence on every household in the world”. Short “no seed” is ignored.';
    const r = unfoundQuotes(answer, dir);
    assert.equal(r.total, 3);
    assert.deepEqual(r.missing, ["the authors guarantee convergence on every household in the world"]);
  });
});

describe("numbersNotInPaper", () => {
  it("flags decimal numbers on a deck that the paper does not state, ignoring markup and page numbers", async () => {
    const { numbersNotInPaper } = await import("../scripts/live/skill-cases.ts");
    const dir = mkdtempSync(join(tmpdir(), "num-"));
    writeFileSync(join(dir, "p.tex"), "Error fell from 13.1 to 12.5~units, a gain of 0.6 (5\\%). Table: 9.9 & 12.\n");
    const r = numbersNotInPaper("Error 12.5 and 13.1 and 0.6 and 9.9 and an invented 14.2 and 3.0.1 version, slide 3", dir);
    assert.equal(r.total, 5);
    assert.deepEqual(r.missing, ["14.2"]);
  });
  it("compares values, not spellings: 9.90 is the paper's 9.9 and 70.00 its 70", async () => {
    const { numbersNotInPaper } = await import("../scripts/live/skill-cases.ts");
    const dir = mkdtempSync(join(tmpdir(), "num-"));
    writeFileSync(join(dir, "p.tex"), "The reference costs 9.9 units and the target is 70\\% of capacity; 0.2 kW.\n");
    assert.deepEqual(numbersNotInPaper("9.90 and 70.00 and 0.200 and 9.91", dir), { total: 4, missing: ["9.91"] });
  });
  it("does not take a reference to a section, table, figure or line for a result", async () => {
    const { numbersNotInPaper } = await import("../scripts/live/skill-cases.ts");
    const dir = mkdtempSync(join(tmpdir(), "num-"));
    writeFileSync(join(dir, "p.tex"), "Cost 12.5.\n");
    const r = numbersNotInPaper("Cost 12.5 (Section 5.3, Table 5.5; Sections 5.3.1 and 5.4; Fig. 2.1; lines 499\u2013506; Eq. 3.2).", dir);
    assert.deepEqual(r, { total: 1, missing: [] });
  });
  it("can be limited to one part of a page, so proposed targets elsewhere are not held to the paper", async () => {
    const { numbersNotInPaper, sectionText } = await import("../scripts/live/skill-cases.ts");
    const dir = mkdtempSync(join(tmpdir(), "num-"));
    writeFileSync(join(dir, "p.tex"), "Cost 12.5.\n");
    const page = "# Aims\n### Preliminary Results\nWe reached 12.5 and 14.2.\n### Specific Aims\nTarget 7.3 and 2.2.\n";
    assert.equal(sectionText(page, /Preliminary/i).includes("7.3"), false);
    assert.deepEqual(numbersNotInPaper(sectionText(page, /Preliminary/i), dir).missing, ["14.2"]);
  });
  it("finds a section the agent wrote as a bold lead-in paragraph, as a real agent did, and stops at the next one", async () => {
    const { sectionText } = await import("../scripts/live/skill-cases.ts");
    const page = "# Title\n\n**Preliminary Results:** Over 100 days the method cost 12.5 units (Table 3).\nThe gap is 2.9.\n\n**Aim 1: Narrow the gap.**\nTarget 7.25.\n";
    const found = sectionText(page, /preliminary/i);
    assert.match(found, /12\.5/);
    assert.match(found, /2\.9/);
    assert.doesNotMatch(found, /7\.25/);
  });
});

describe("co-author fixture", () => {
  it("the tool in the office skill reads exactly the changes the fixture contains", async () => {
    const { writeCoauthorDocx, COAUTHOR_CHANGES: c, docxFacts } = await import("../scripts/live/skill-cases.ts");
    const { spawnSync } = await import("node:child_process");
    const file = join(mkdtempSync(join(tmpdir(), "co-")), "returned.docx");
    writeCoauthorDocx(file);
    const r = spawnSync("python3", [join(import.meta.dirname, "../skills/uktub-office/scripts/docx_changes.py"), file], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /5 tracked changes \(2 insertions, 2 deletions, 1 formatting\), 1 comment/);
    for (const x of [c.numberDeleted, c.numberInserted, c.sentenceInserted, c.sentenceDeleted.trim(), c.comment]) assert.ok(r.stdout.includes(x), x);
    assert.match(r.stdout, new RegExp(`Comment 0 by Dr Co \\(2026-10-08\\) on "${c.commentOn}"`));
    assert.match(docxFacts(file).text, /Compared to the baseline, our method reduces/);
  });
});

describe("missingClaimedFiles", () => {
  it("reports files an answer says it made that are not on disk, ignoring templates, absolute paths and bare names", async () => {
    const { missingClaimedFiles } = await import("../scripts/live/skill-cases.ts");
    const { mkdirSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "claim-"));
    mkdirSync(join(dir, "manuscript/figures"), { recursive: true });
    writeFileSync(join(dir, "manuscript/figures/a.pdf"), "x");
    const answer = "Made `manuscript/figures/a.pdf` (and build/a.pdf), source manuscript/figures/a.tex; include figures/a.pdf and figures/<name>.pdf; see /opt/stage/x/SKILL.md or notes.md.";
    assert.deepEqual(missingClaimedFiles(answer, dir).sort(), ["build/a.pdf", "manuscript/figures/a.tex"], "figures/a.pdf is the LaTeX path relative to manuscript/, so it exists");
  });
});

describe("case isolation", () => {
  it("freshProject empties the manuscript, data, reviews, grants, build and papers folders but keeps the registry", async () => {
    const { freshProject } = await import("../scripts/live/skill-cases.ts");
    const { mkdirSync, existsSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "fresh-"));
    for (const d of ["manuscript/figures", "data", "reviews", "grants", "build", ".registry"]) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, "manuscript/figures/old.pdf"), "x");
    writeFileSync(join(dir, ".registry/registry.db"), "db");
    freshProject(dir);
    assert.equal(existsSync(join(dir, "manuscript/figures")), false);
    assert.equal(existsSync(join(dir, "data")), false);
    assert.ok(existsSync(join(dir, "manuscript")));
    assert.ok(existsSync(join(dir, ".registry/registry.db")));
  });
  it("saveArtifacts copies the files a case reports, project-relative and inside the project only", async () => {
    const { saveArtifacts } = await import("../scripts/live/skill-cases.ts");
    const { mkdirSync, existsSync } = await import("node:fs");
    const project = mkdtempSync(join(tmpdir(), "proj-"));
    const dest = join(mkdtempSync(join(tmpdir(), "dest-")), "artifacts/case");
    mkdirSync(join(project, "manuscript"), { recursive: true });
    writeFileSync(join(project, "manuscript/a.pdf"), "x");
    saveArtifacts(project, dest, { artifacts: ["manuscript/a.pdf", "../outside.txt", "missing.png"] });
    assert.ok(existsSync(join(dest, "a.pdf")));
    assert.equal(existsSync(join(dest, "outside.txt")), false);
  });
});

describe("fundingAmount", () => {
  it("finds a money amount in prose and ignores dollar signs that open LaTeX mathematics", async () => {
    const { fundingAmount } = await import("../scripts/live/skill-cases.ts");
    assert.equal(fundingAmount("Request $1.2 million over three years."), "$1.2");
    assert.equal(fundingAmount("A budget of 250,000 EUR is needed."), "250,000 EUR");
    assert.equal(fundingAmount("Halve the gap: $9.90 + 0.5 \\times 2.90 = 11.35$ units, with $\\alpha \\le 0.5$."), undefined);
    assert.equal(fundingAmount("Budget: [budget]"), undefined);
  });
});

describe("acronymsNotInRequest", () => {
  const request = "A central HEMS controller (a reinforcement-learning agent) manages the grid connection through a smart meter, a rooftop PV array, a home battery (ESS), an electric vehicle with its charger and an HVAC unit.";
  it("flags the algorithm and V2G names a real agent added to the figure", () => {
    const figure = spawnSync("pdftotext", [join(import.meta.dirname, "..", "docs/benchmarks/skills/2026-10-09-diagrams-smart-home--superseded-extra-labels/artifacts/hems_system_diagram.pdf"), "-"], { encoding: "utf8" }).stdout;
    assert.deepEqual(acronymsNotInRequest(figure, request), ["DQN", "PPO", "SAC", "V2G", "V2H"]);
  });
  it("lets the user's own names, abbreviations of them (EV for electric vehicle), the AC bus and units through", () => {
    assert.deepEqual(acronymsNotInRequest("HEMS controller\nPV array, ESS, EV charger, HVAC unit\nHome AC Power Bus 3 kWh", request), []);
  });
});

describe("misplacedPrintedRefs", () => {
  // Shaped like `pdftotext` on the published paper: headings and captions on their own lines, table bodies after the caption.
  const filler = Array.from({ length: 60 }, (_, i) => `Text of the paper, line ${i}.`);
  const paper = [
    "6.1. Experimental Setup", "Components follow the parameters in Table 6.", "Table 6: Reward Function Weights.", "wcost 1.0", "wHVAC 0.5", "weight 0.25", ...filler,
    "6.2. Performance Comparisons", "6.2.1. Training Convergence", "Training converges after 400 episodes.",
    "6.2.2. Quantitative Evaluation on Test Set", "The method has the lowest mean error (12.5 units).", "Table 9: Comparison among the methods.", "12.5", "13.1", "20.4", "9.9",
    "6.3. Operational Analysis", "Load stays near 30% of capacity.",
    "6.7. Trading Analysis", "Case 1 earns 2.1 units.",
    "6.6. Scheduling Analysis", "The job starts at 14:00.",
  ].join("\n");
  const sentence = (refs: string) => `The method gives 12.5 units against 13.1 for the baseline (${refs}).`;
  it("flags the references a real agent guessed from the .tex order: Table 6 for the results, Section 6.7 for the cost gap", () => {
    const problems = misplacedPrintedRefs(sentence("Table 6, Section 6.7"), paper);
    assert.equal(problems.length, 2);
    assert.match(problems[0]!, /Table 6/);
    assert.match(problems[1]!, /Section 6\.7/);
  });
  it("accepts the table and section the numbers are in, subsections included, and ignores sentences without numbers", () => {
    assert.deepEqual(misplacedPrintedRefs(sentence("Table 9; Section 6.2"), paper), []);
    assert.deepEqual(misplacedPrintedRefs("The next aim builds on Table 6 and Section 6.7.", paper), []);
  });
  it("flags a table or section the paper does not have, and reads lists like Sections 6.2 and 6.7", () => {
    assert.match(misplacedPrintedRefs(sentence("Table 12"), paper)[0]!, /does not exist/);
    const problems = misplacedPrintedRefs(sentence("Sections 6.2 and 6.7"), paper);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /Section 6\.7/);
  });
});

describe("test paper config", () => {
  const config = { entry: "main.tex", pdf: "main.pdf", title: "A Synthetic Study", limitations: ["seed", "single site"], exclude: ["cls"], docx: { mustContain: "Synthetic", headings: 2, images: 1, equations: 1, tables: 1, bibliography: 1 } };
  function paperDir(overrides: Record<string, unknown> = {}): string {
    const root = mkdtempSync(join(tmpdir(), "papers-"));
    mkdirSync(join(root, "mine"));
    for (const f of ["main.tex", "main.pdf", "main.aux", "results.tex", "ref.bib"]) writeFileSync(join(root, "mine", f), f);
    mkdirSync(join(root, "mine", "cls"));
    writeFileSync(join(root, "mine", "cls", "x.sty"), "x");
    writeFileSync(join(root, "mine", "uktub-case.json"), JSON.stringify({ ...config, ...overrides }));
    return root;
  }
  it("finds the paper that has a config, and turns the strings into the regular expressions the cases use", () => {
    const root = paperDir();
    mkdirSync(join(root, "other-without-config"));
    const paper = loadTestPaper(root);
    assert.equal(paper.dir, join(root, "mine"));
    assert.equal(paper.entry, "main.tex");
    assert.ok(paper.title.test("a synthetic study"), "the title match is case-insensitive");
    assert.deepEqual(paper.limitations.map((r) => r.test("One seed only")), [true, false]);
    assert.equal(paper.docx.headings, 2);
  });
  it("is NOT_RUN with an instruction when there is no paper, and names the missing field when the config is incomplete", () => {
    assert.throws(() => loadTestPaper(mkdtempSync(join(tmpdir(), "papers-"))), (e: Error) => e instanceof NotRun && /uktub-case\.json/.test(e.message));
    const root = paperDir({ entry: undefined });
    assert.throws(() => loadTestPaper(root), /entry/);
  });
  it("copies the paper into the agent's project without its build products, its published PDF, its excluded names and the grader's own config", () => {
    const project = mkdtempSync(join(tmpdir(), "proj-"));
    writeOwnPaper(project, loadTestPaper(paperDir()));
    const files = readdirSync(join(project, "manuscript")).sort();
    assert.deepEqual(files, ["main.tex", "ref.bib", "results.tex"]);
  });
});

describe("pptxFacts", () => {
  it("reports what the skill's own reader prints: counts, titles, untitled slides and all the text", { skip: spawnSync("python3", ["--version"]).status !== 0 }, () => {
    const f = pptxFacts(writeFixturePptx());
    assert.deepEqual({ ...f, text: undefined }, { slides: 4, pictures: 1, tables: 1, equations: 1, slidesWithNotes: 1, titles: ["A synthetic study", "The method halves the error", "The figure shows the trend"], untitled: 1, text: undefined });
    assert.match(f.text, /Error fell from 13\.1 to 12\.5 units/);
    assert.match(f.text, /The method halves the error/);
    assert.match(f.text, /Ours \| 12\.5/, "table cells are part of the text the numbers are checked in");
  });
});

describe("saveProjectOutputs", () => {
  it("keeps what the agent produced in the output folders (small files only), not the inputs, so a failed case can be inspected", () => {
    const project = mkdtempSync(join(tmpdir(), "proj-"));
    for (const d of ["manuscript/figures", "manuscript/slides", "grants", "data", "manuscript/sections"]) mkdirSync(join(project, d), { recursive: true });
    writeFileSync(join(project, "manuscript/figures/a.pdf"), "pdf");
    writeFileSync(join(project, "manuscript/slides/talk.pptx"), "pptx");
    writeFileSync(join(project, "grants/specific-aims.md"), "aims");
    writeFileSync(join(project, "manuscript/figures/huge.png"), Buffer.alloc(2_000_000, 1));
    writeFileSync(join(project, "data/input.csv"), "x");
    writeFileSync(join(project, "manuscript/sections/results.tex"), "tex");
    const dest = join(mkdtempSync(join(tmpdir(), "dest-")), "case");
    const saved = saveProjectOutputs(project, dest);
    assert.deepEqual(saved.sort(), ["a.pdf", "specific-aims.md", "talk.pptx"]);
    assert.deepEqual(readdirSync(dest).sort(), ["a.pdf", "specific-aims.md", "talk.pptx"]);
  });
});
