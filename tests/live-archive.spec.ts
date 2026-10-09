/**
 * Archiving a live skills run (scripts/live/archive.ts) into docs/benchmarks/skills/: one folder per case with a readable report, the
 * machine-readable result, and the artifacts the case produced (small files inside the project only), plus an index. This is the proof
 * the benchmarks folder keeps of what each skill did against a real model.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveRun } from "../scripts/live/archive.ts";

function fakeRun(artifacts: string[], verdict: "PASS" | "FAIL" = "PASS"): { run: string; out: string } {
  const run = mkdtempSync(join(tmpdir(), "run-"));
  const out = mkdtempSync(join(tmpdir(), "bench-"));
  mkdirSync(join(run, "project/manuscript/figures"), { recursive: true });
  writeFileSync(join(run, "project/manuscript/figures/a.pdf"), "%PDF-fake");
  writeFileSync(join(run, "project/manuscript/figures/a.png"), "png-bytes");
  writeFileSync(join(run, "project/manuscript/figures/big.png"), Buffer.alloc(3_000_000, 1));
  writeFileSync(join(run, "results.json"), JSON.stringify({
    manifest: { startedAt: "2026-10-09T10:00:00.000Z", commit: "abcdef1234567", model: "google-vertex/gemini-3.8-flash (Vertex client)", skillCasesVersion: "v1", providerKeysPassed: ["OPENALEX_API_KEY"] },
    results: [{ id: "skill.figures.demo", tool: "uktub-figures", verdict, elapsedMs: 61000, contract: "makes a figure", detail: { turn: "figure", artifacts }, error: verdict === "FAIL" ? "AssertionError: nope" : undefined }],
  }));
  writeFileSync(join(run, "pi-turns.jsonl"), `${JSON.stringify({
    id: "figure", prompt: "Make a figure from data/x.csv.", final: "I made manuscript/figures/a.pdf.", model: "google-vertex/gemini-3.8-flash", elapsedMs: 60000,
    calls: [{ name: "read", args: { path: "/opt/stage/node_modules/uktub-scholar/skills/uktub-figures/SKILL.md" } }, { name: "bash", args: { command: "python3 plot.py" } }],
    usage: { input: 1000, output: 200, total: 1500, costUsd: 0.05, responses: 4 },
  })}\n`);
  return { run, out };
}

describe("archiveRun", () => {
  it("writes report.md, results.json and the artifacts into a dated folder per case, and an index", async () => {
    const { run, out } = fakeRun(["manuscript/figures/a.pdf", "manuscript/figures/a.png"]);
    const made = await await archiveRun({ runDir: run, outRoot: out });
    assert.deepEqual(made.map((p) => p.slice(out.length + 1)), ["2026-10-09-figures-demo"]);
    const dir = join(out, "2026-10-09-figures-demo");
    const report = readFileSync(join(dir, "report.md"), "utf8");
    assert.match(report, /skill\.figures\.demo/);
    assert.match(report, /PASS/);
    assert.match(report, /Make a figure from data\/x\.csv\./, "the prompt is part of the proof");
    assert.match(report, /I made manuscript\/figures\/a\.pdf\./, "the agent's answer is part of the proof");
    assert.match(report, /read.*SKILL\.md.*bash|SKILL\.md/s, "the order of tools shows the skill was loaded");
    assert.match(report, /\$0\.05/);
    assert.match(report, /artifacts\/a\.png/);
    assert.ok(existsSync(join(dir, "artifacts/a.pdf")) && existsSync(join(dir, "artifacts/a.png")));
    const result = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
    assert.equal(result.verdict, "PASS");
    assert.equal(result.commit, "abcdef1234567");
    assert.equal(JSON.stringify(result).includes("OPENALEX_API_KEY"), false, "no key names or values in the archive");
    const index = readFileSync(join(out, "README.md"), "utf8");
    assert.match(index, /2026-10-09-figures-demo/);
    assert.match(index, /PASS/);
  });

  it("copies only small files that sit inside the project, and says what it skipped", async () => {
    const { run, out } = fakeRun(["manuscript/figures/big.png", "../results.json", "/etc/passwd", "manuscript/figures/a.pdf"]);
    await archiveRun({ runDir: run, outRoot: out });
    const dir = join(out, "2026-10-09-figures-demo");
    assert.ok(existsSync(join(dir, "artifacts/a.pdf")));
    assert.equal(existsSync(join(dir, "artifacts/big.png")), false, "over the size cap");
    assert.equal(existsSync(join(dir, "artifacts/passwd")), false);
    const report = readFileSync(join(dir, "report.md"), "utf8");
    assert.match(report, /skipped/i);
    assert.match(report, /big\.png/);
  });

  it("finds an artifact the runner saved under artifacts/<case id>/ even after the project was reset for the next case", async () => {
    const { run, out } = fakeRun(["manuscript/figures/gone.pdf"]);
    mkdirSync(join(run, "artifacts/skill.figures.demo"), { recursive: true });
    writeFileSync(join(run, "artifacts/skill.figures.demo/gone.pdf"), "%PDF-saved");
    await archiveRun({ runDir: run, outRoot: out });
    assert.equal(readFileSync(join(out, "2026-10-09-figures-demo/artifacts/gone.pdf"), "utf8"), "%PDF-saved");
  });

  it("archives a failed case too, with its error, so the record is honest", async () => {
    const { run, out } = fakeRun([], "FAIL");
    await archiveRun({ runDir: run, outRoot: out });
    const report = readFileSync(join(out, "2026-10-09-figures-demo/report.md"), "utf8");
    assert.match(report, /FAIL/);
    assert.match(report, /AssertionError: nope/);
  });

  it("keeps a run on the owner's own paper in private/ (gitignored), out of the public index, and summarises it with no content", async () => {
    const { run, out } = fakeRun(["manuscript/figures/a.pdf"]);
    await archiveRun({ runDir: run, outRoot: out });
    await archiveRun({ runDir: run, outRoot: out, private: true, label: "own-paper" });
    const dir = join(out, "private/2026-10-09-figures-demo--own-paper");
    assert.match(readFileSync(join(dir, "report.md"), "utf8"), /Make a figure from data\/x\.csv\./, "the full evidence is kept locally");
    assert.ok(existsSync(join(dir, "artifacts/a.pdf")));
    const index = readFileSync(join(out, "README.md"), "utf8");
    assert.doesNotMatch(index, /private\/|--own-paper|figures-demo--/, "the public index links nothing private");
    assert.match(index, /own-paper-summary\.md/, "the index points at the summary");
    const summary = readFileSync(join(out, "own-paper-summary.md"), "utf8");
    assert.match(summary, /skill\.figures\.demo \| uktub-figures \| PASS \| google-vertex\/gemini-3\.8-flash \| 61 s \| \$0\.05 \| 2 tool calls/);
    for (const content of ["Make a figure", "I made manuscript", "a.pdf", "x.csv"]) assert.equal(summary.includes(content), false, `the summary must not carry "${content}"`);
  });

  it("shows the files a failed case left behind, kept by the runner under artifacts/<case id>/ although the case reported none", async () => {
    const { run, out } = fakeRun([], "FAIL");
    mkdirSync(join(run, "artifacts/skill.figures.demo"), { recursive: true });
    writeFileSync(join(run, "artifacts/skill.figures.demo/left-behind.pptx"), "pptx");
    await archiveRun({ runDir: run, outRoot: out });
    const dir = join(out, "2026-10-09-figures-demo");
    assert.equal(readFileSync(join(dir, "artifacts/left-behind.pptx"), "utf8"), "pptx");
    assert.match(readFileSync(join(dir, "report.md"), "utf8"), /artifacts\/left-behind\.pptx/);
  });

  it("does not give a failed case another case's turn when the run held several cases and it recorded none", async () => {
    const { run, out } = fakeRun([]);
    const j = JSON.parse(readFileSync(join(run, "results.json"), "utf8"));
    j.results = [{ id: "skill.slides.demo", tool: "uktub-slides", verdict: "FAIL", elapsedMs: 5000, contract: "makes slides", error: "AssertionError: nope" }, ...j.results];
    writeFileSync(join(run, "results.json"), JSON.stringify(j));
    await archiveRun({ runDir: run, outRoot: out });
    const failed = JSON.parse(readFileSync(join(out, "2026-10-09-slides-demo/results.json"), "utf8"));
    assert.equal(failed.usage, undefined, "the cost belongs to the other case");
    assert.equal(failed.tools, undefined);
    assert.doesNotMatch(readFileSync(join(out, "2026-10-09-slides-demo/report.md"), "utf8"), /Make a figure from data/);
    assert.ok(JSON.parse(readFileSync(join(out, "2026-10-09-figures-demo/results.json"), "utf8")).usage, "the case that did record its turn keeps it");
  });
});
