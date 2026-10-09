/**
 * The skeleton in skills/uktub-slides/SKILL.md is what the agent starts from: with a figure and a bibliography file in place it must compile
 * with Tectonic (Beamer + Metropolis) to a PDF that has the title slide, the figure slide and the references. Skipped without tectonic.
 * pptx_outline.py reads a .pptx back (slides, titles, pictures, tables, equations, notes) with the Python standard library; its fixture is built here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFixturePptx } from "./helpers/pptx-fixture.ts";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const hasTectonic = spawnSync("tectonic", ["--version"], { encoding: "utf8" }).status === 0;
const SKILL = resolve(import.meta.dirname, "../skills/uktub-slides/SKILL.md");
// a 1x1 white PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("uktub-slides skeleton", { skip: !hasTectonic }, () => {
  it("compiles with a figure and a bibliography in place", () => {
    const tex = /```latex\n([\s\S]*?)```/.exec(readFileSync(SKILL, "utf8"))?.[1];
    assert.ok(tex, "no latex skeleton in the skill");
    const root = mkdtempSync(join(tmpdir(), "slides-"));
    mkdirSync(join(root, "slides"));
    writeFileSync(join(root, "figure.png"), PNG);
    writeFileSync(join(root, "refs.bib"), "@article{k, title={A Title}, author={Doe, J.}, year={2024}, journal={J}}\n");
    writeFileSync(join(root, "slides/talk.tex"), tex.replace("\\begin{frame}[allowframebreaks]", "\\nocite{k}\n\\begin{frame}[allowframebreaks]"));
    const r = spawnSync("tectonic", ["-X", "compile", "talk.tex"], { cwd: join(root, "slides"), encoding: "utf8", timeout: 300_000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-1500));
    assert.ok(existsSync(join(root, "slides/talk.pdf")));
    const info = spawnSync("pdfinfo", [join(root, "slides/talk.pdf")], { encoding: "utf8" });
    if (info.status === 0) assert.match(info.stdout, /Pages:\s+3\b/, "title, figure and references");
  });
});

describe("skills/uktub-slides/scripts/pptx_outline.py", () => {
  const OUTLINE = resolve(import.meta.dirname, "../skills/uktub-slides/scripts/pptx_outline.py");
  const pptx = writeFixturePptx;
  const outline = (path: string) => spawnSync("python3", [OUTLINE, path], { encoding: "utf8" });

  it("counts slides, pictures, tables, equations and notes, and gives each slide's title and text, in slide order", { skip: !hasPython }, () => {
    const r = outline(pptx());
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /talk\.pptx — 4 slides, pictures 1, tables 1, equations 1, notes on 1 slides/);
    assert.match(r.stdout, /\[1\] A synthetic study \| pictures 0, tables 0, equations 0, notes no/);
    assert.match(r.stdout, /\[2\] The method halves the error \| pictures 0, tables 0, equations 0, notes yes[\s\S]*text: Error fell from 13\.1 to 12\.5 units \| Training took 2 hours[\s\S]*notes: Say the baseline first\./);
    assert.match(r.stdout, /\[3\] The figure shows the trend \| pictures 1/);
    assert.match(r.stdout, /\[4\] \(no title\) \| pictures 0, tables 1, equations 1[\s\S]*table: Method \| Error ; Ours \| 12\.5/, "the numbers in a table are read back too");
    assert.ok(r.stdout.indexOf("[3]") < r.stdout.indexOf("[4]"), "slide10 must come after slide3, not after slide1");
  });
  it("refuses a file that is not a .pptx", { skip: !hasPython }, () => {
    const bad = join(mkdtempSync(join(tmpdir(), "pptx-")), "x.pptx");
    writeFileSync(bad, "not a zip");
    const r = outline(bad);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a \.pptx/);
  });
});
