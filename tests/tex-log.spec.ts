/**
 * TeX-log parser spec (Phase 7): every case runs from genuine BusyTeX
 * `logcat` captures in tests/fixtures/busytex/ (see that directory's README
 * for how they were captured and each fixture's BusyTeX exit code). No
 * hand-written logs: the grammar below is pinned to real engine output.
 *
 * TDD: written RED against the tex-log.ts stub, then green.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseTexLog } from "../src/core/compile/tex-log.ts";

const FIX = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures/busytex", name), "utf8");

describe("busytex tex-log parser", () => {
  it("clean run: no diagnostics (bibtex 'I found no ...' lines are benign)", () => {
    const parsed = parseTexLog(FIX("clean.log.txt"));
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed.truncated, false);
  });

  it("undefined control sequence: one error with line, file from the (-stack, emergency stop skipped", () => {
    const parsed = parseTexLog(FIX("undef-macro.log.txt"));
    assert.deepEqual(parsed.diagnostics, [
      // Real hyperref warning the aborted run emits before the error (engine order kept).
      { severity: "warning", file: "main.tex", message: "Rerun to get /PageLabels entry." },
      { severity: "error", file: "main.tex", line: 10, message: "Undefined control sequence." },
    ]);
  });

  it("missing input file: the LaTeX error names the file; the follow-on emergency stop is not a second error", () => {
    const parsed = parseTexLog(FIX("missing-input.log.txt"));
    assert.deepEqual(parsed.diagnostics, [
      { severity: "warning", file: "main.tex", message: "Rerun to get /PageLabels entry." },
      { severity: "error", file: "main.tex", line: 10, message: "LaTeX Error: File `nosuchfile.tex' not found." },
    ]);
  });

  it("undefined citation: warnings with the input line, plus the rerun summary", () => {
    const parsed = parseTexLog(FIX("undef-cite.log.txt"));
    assert.deepEqual(parsed.diagnostics, [
      { severity: "warning", file: "main.tex", line: 10, message: "Citation `missing2026' on page 1 undefined on input line 10." },
      { severity: "warning", file: "main.tex", message: "There were undefined references." },
    ]);
  });

  it("missing .bib entry: bibtex 'didn't find a database entry' warning plus the undefined-citation warnings", () => {
    const parsed = parseTexLog(FIX("missing-bibentry.log.txt"));
    assert.deepEqual(parsed.diagnostics, [
      { severity: "warning", message: `I didn't find a database entry for "missing2026"` },
      { severity: "warning", file: "main.tex", line: 10, message: "Citation `missing2026' on page 1 undefined on input line 10." },
      { severity: "warning", file: "main.tex", line: 3, message: "Empty `thebibliography' environment on input line 3." },
      { severity: "warning", file: "main.tex", message: "There were undefined references." },
    ]);
  });

  it("bibtex syntax error: an error with file and line even though BusyTeX exited 0", () => {
    const parsed = parseTexLog(FIX("bib-syntax.log.txt"));
    assert.equal(parsed.diagnostics[0]?.severity, "error");
    assert.equal(parsed.diagnostics[0]?.file, "broken.bib");
    assert.equal(parsed.diagnostics[0]?.line, 6);
    assert.match(parsed.diagnostics[0]?.message ?? "", /Illegal end of database file/);
    const warnings = parsed.diagnostics.filter((d) => d.severity === "warning").map((d) => d.message);
    for (const want of [
      "to sort, need author or key in brokentest",
      "empty author in brokentest",
      "empty title in brokentest",
      "empty journal in brokentest",
      "empty year in brokentest",
    ]) {
      assert.ok(warnings.some((m) => m.includes(want)), `missing bibtex warning: ${want}`);
    }
    // No second copy from the STDOUT-duplicated section.
    assert.equal(parsed.diagnostics.filter((d) => d.severity === "error").length, 1);
  });

  it("unknown package: the sty-not-found error with line (short log, few passes)", () => {
    const parsed = parseTexLog(FIX("unknown-package.log.txt"));
    assert.deepEqual(parsed.diagnostics, [
      { severity: "error", file: "main.tex", line: 6, message: "LaTeX Error: File `thispackagedoesnotexist123.sty' not found." },
    ]);
  });

  it("overfull box: warning with the paragraph end line (Node parity)", () => {
    const parsed = parseTexLog(FIX("overfull.log.txt"));
    assert.deepEqual(parsed.diagnostics, [
      { severity: "warning", file: "main.tex", line: 11, message: "Overfull \\hbox (487.60326pt too wide) in paragraph at lines 9--11" },
    ]);
  });

  it("package warning: continuations joined, info lines ignored", () => {
    const parsed = parseTexLog(FIX("pkg-warn.log.txt"));
    assert.equal(parsed.diagnostics.length, 1);
    assert.equal(parsed.diagnostics[0]?.severity, "warning");
    assert.match(parsed.diagnostics[0]?.message ?? "", /fixltx2e is not required with releases after 2015/);
  });
});
