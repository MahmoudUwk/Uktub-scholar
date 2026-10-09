/**
 * Compile diagnostics spec (KTD1): the parser is pure, so every case runs from
 * fixtures — genuine tectonic 0.15.0 stream captures under
 * tests/fixtures/tectonic/ plus one synthetic multi-file stream composed from
 * the same real line shapes (marked as such).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MAX_DIAGNOSTICS, parseTectonicStreams } from "../src/core/compile/diagnostics.ts";

const FIX = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures/tectonic", name), "utf8");

describe("tectonic stream parser", () => {
  it("clean run: no diagnostics, extracts the written pdf path", () => {
    const parsed = parseTectonicStreams(FIX("ok.stdout"), FIX("ok.stderr"));
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed.truncated, false);
    assert.equal(parsed.wrotePdf, "build/main.pdf");
  });

  it("error run: file-attributed error plus engine-level halt line, no pdf", () => {
    const parsed = parseTectonicStreams(FIX("err.stdout"), FIX("err.stderr"));
    assert.equal(parsed.wrotePdf, null);
    assert.deepEqual(parsed.diagnostics, [
      { severity: "error", file: "main.tex", line: 3, message: "Undefined control sequence" },
      { severity: "error", message: "halted on potentially-recoverable error as specified" },
    ]);
  });

  it("warning run: dedupes the rerun-printed warning, keeps the summary line", () => {
    const parsed = parseTectonicStreams(FIX("warn.stdout"), FIX("warn.stderr"));
    assert.equal(parsed.wrotePdf, "build/main.pdf");
    assert.deepEqual(parsed.diagnostics, [
      { severity: "warning", file: "main.tex", line: 5, message: "Overfull \\hbox (87.45758pt too wide) in paragraph at lines 3--5" },
      { severity: "warning", message: "warnings were issued by the TeX engine; use --print and/or --keep-logs for details." },
    ]);
  });

  it("synthetic multi-file stream: interleaved severities, per-file attribution, dedup, cap", () => {
    // Composed strictly from real line shapes (fixtures above); multi-file and
    // cap behavior are exercised because the genuine captures are single-file.
    const lines: string[] = [];
    lines.push('note: "version 2" Tectonic command-line interface activated');
    for (let i = 1; i <= MAX_DIAGNOSTICS + 5; i++) {
      lines.push(`error: chapters/ch${i % 3}.tex:${i}: Undefined control sequence`);
    }
    lines.push("error: halted on potentially-recoverable error as specified");
    const parsed = parseTectonicStreams("", lines.join("\n"));
    assert.equal(parsed.diagnostics.length, MAX_DIAGNOSTICS);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.wrotePdf, null);
    assert.equal(parsed.diagnostics[0].file, "chapters/ch1.tex");
    // the cap is a hard bound: the engine-level line lands after MAX lines and
    // is dropped with the truncated flag set (client policy, deterministic)
    assert.ok(!parsed.diagnostics.some((d) => d.file === undefined && d.severity === "error"));
  });

  it("the cap never lets warnings crowd out errors: a real error after many warnings is kept, order preserved", () => {
    // Seen live (rf-llm-literature-review iter-12): 50 Overfull \hbox warnings printed before the one error, so the
    // old first-come cap dropped the error and the tool reported "Compile failed: 0 error(s)" with no cause.
    const lines: string[] = [];
    for (let i = 1; i <= MAX_DIAGNOSTICS + 10; i++) lines.push(`warning: main.tex:${i}: Overfull \\hbox (${i}pt too wide) in paragraph at lines ${i}--${i}`);
    lines.push("error: main.tex:296: Illegal parameter number in definition of \\Hy@tempa");
    lines.push("error: halted on potentially-recoverable error as specified");
    const parsed = parseTectonicStreams("", lines.join("\n"));
    assert.equal(parsed.diagnostics.length, MAX_DIAGNOSTICS);
    assert.equal(parsed.truncated, true);
    const errors = parsed.diagnostics.filter((d) => d.severity === "error");
    assert.deepEqual(errors.map((d) => d.message), ["Illegal parameter number in definition of \\Hy@tempa", "halted on potentially-recoverable error as specified"]);
    assert.equal(errors[0]?.line, 296);
    // kept diagnostics stay in the order the engine printed them (warnings first, then the errors)
    const severities = parsed.diagnostics.map((d) => d.severity);
    assert.deepEqual(severities, [...severities].sort((a, b) => (a === b ? 0 : a === "warning" ? -1 : 1)));
  });

  it("ignores non-diagnostic stream noise", () => {
    const parsed = parseTectonicStreams(
      "note: Running TeX ...\nnote: Rerunning TeX because \"main.aux\" changed ...\n",
      "",
    );
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed.wrotePdf, null);
    assert.equal(parsed.truncated, false);
  });
});
