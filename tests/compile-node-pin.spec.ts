/**
 * Node/Tectonic result pin (Phase 7): byte-identical guard for the core
 * split. Captured from the pre-refactor `compileDocument` against the
 * genuine tectonic 0.15.0 fixtures in tests/fixtures/tectonic/. After the
 * split into engine-run + engine-neutral finish, this spec must stay green
 * UNCHANGED — any diff means Node behavior moved.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileDocument, describeOutcome, type EngineSpawn } from "../src/core/compile/run.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-compile-pin-"));
  mkdirSync(join(root, "manuscript"), { recursive: true });
  writeFileSync(join(root, "manuscript", "main.tex"), "\\begin{document}hi\\end{document}");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const FIX = (name: string): string =>
  readFileSync(join(import.meta.dirname, "fixtures/tectonic", name), "utf8");

const ENGINE_ENV = { UKTUB_TECTONIC_BIN: "/fake/tectonic", PATH: "" };
const engineFs = { exists: () => true, executable: () => true };

function fakeSpawn(responds: { stdout: string; stderr: string; code: number; timedOut?: boolean }, writesPdf?: string): EngineSpawn {
  return async (_file, args, _opts) => {
    if (args[0] === "--version") return { stdout: "Tectonic 0.15.0\n", stderr: "", code: 0, timedOut: false };
    assert.equal(args[0], "-X");
    if (writesPdf) {
      const outdir = args[args.indexOf("--outdir") + 1];
      writeFileSync(join(outdir, writesPdf), "%PDF-fake");
    }
    const outdirArg = args[args.indexOf("--outdir") + 1];
    return {
      stdout: responds.stdout.replaceAll("build/main.pdf", `${outdirArg}/main.pdf`),
      stderr: responds.stderr,
      code: responds.code,
      timedOut: responds.timedOut === true,
    };
  };
}

describe("compile Node/Tectonic pin (byte-identical across the Phase 7 split)", () => {
  it("ok fixture: compiled outcome is byte-identical", async () => {
    const outcome = await compileDocument({
      root, env: ENGINE_ENV, fs: engineFs,
      spawn: fakeSpawn({ stdout: FIX("ok.stdout"), stderr: FIX("ok.stderr"), code: 0 }, "main.pdf"),
    });
    assert.deepEqual(outcome, {
      kind: "compiled",
      engineVersion: "0.15.0",
      entry: "manuscript/main.tex",
      pdfPath: "build/main.pdf",
      pdfSizeBytes: 9,
      diagnostics: [],
      truncated: false,
    });
    assert.equal(
      describeOutcome(outcome as Exclude<typeof outcome, { kind: "refusal" }>),
      "Compiled manuscript/main.tex with tectonic 0.15.0 → build/main.pdf (9 bytes). 0 error(s), 0 warning(s).",
    );
  });

  it("warn fixture: compiled outcome with warnings is byte-identical", async () => {
    const outcome = await compileDocument({
      root, env: ENGINE_ENV, fs: engineFs,
      spawn: fakeSpawn({ stdout: FIX("warn.stdout"), stderr: FIX("warn.stderr"), code: 0 }, "main.pdf"),
    });
    assert.deepEqual(outcome, {
      kind: "compiled",
      engineVersion: "0.15.0",
      entry: "manuscript/main.tex",
      pdfPath: "build/main.pdf",
      pdfSizeBytes: 9,
      diagnostics: [
        { severity: "warning", file: "manuscript/main.tex", line: 5, message: "Overfull \\hbox (87.45758pt too wide) in paragraph at lines 3--5" },
        { severity: "warning", message: "warnings were issued by the TeX engine; use --print and/or --keep-logs for details." },
      ],
      truncated: false,
    });
    assert.equal(
      describeOutcome(outcome as Exclude<typeof outcome, { kind: "refusal" }>),
      "Compiled manuscript/main.tex with tectonic 0.15.0 → build/main.pdf (9 bytes). 0 error(s), 2 warning(s).\n" +
      "- warning manuscript/main.tex:5: Overfull \\hbox (87.45758pt too wide) in paragraph at lines 3--5\n" +
      "- warning: warnings were issued by the TeX engine; use --print and/or --keep-logs for details.",
    );
  });

  it("err fixture: errors outcome is byte-identical (including the null wrotePdf)", async () => {
    const outcome = await compileDocument({
      root, env: ENGINE_ENV, fs: engineFs,
      spawn: fakeSpawn({ stdout: FIX("err.stdout"), stderr: FIX("err.stderr"), code: 1 }),
    });
    assert.deepEqual(outcome, {
      kind: "errors",
      engineVersion: "0.15.0",
      entry: "manuscript/main.tex",
      diagnostics: [
        { severity: "error", file: "manuscript/main.tex", line: 3, message: "Undefined control sequence" },
        { severity: "error", message: "halted on potentially-recoverable error as specified" },
      ],
      truncated: false,
      wrotePdf: null,
    });
    assert.equal(
      describeOutcome(outcome as Exclude<typeof outcome, { kind: "refusal" }>),
      "Compile failed: manuscript/main.tex — 2 error(s), 0 warning(s) from tectonic 0.15.0.\n" +
      "- error manuscript/main.tex:3: Undefined control sequence\n" +
      "- error: halted on potentially-recoverable error as specified",
    );
  });

  it("timeout refusal text is byte-identical", async () => {
    const outcome = await compileDocument({
      root, env: ENGINE_ENV, fs: engineFs,
      spawn: fakeSpawn({ stdout: "", stderr: "", code: 1, timedOut: true }),
    });
    assert.deepEqual(outcome, {
      kind: "refusal",
      code: "COMPILE_TIMEOUT",
      message: "tectonic exceeded the 120s budget (UKTUB_COMPILE_TIMEOUT_S overrides it in seconds)",
    });
  });

  it("output-overflow and synthetic-error texts are byte-identical", async () => {
    const overflow = await compileDocument({
      root, env: ENGINE_ENV, fs: engineFs,
      spawn: async (_file, args) => {
        if (args[0] === "--version") return { stdout: "Tectonic 0.15.0\n", stderr: "", code: 0, timedOut: false };
        return { stdout: "warning: main.tex:1: Overfull \\hbox (1pt too wide) in paragraph at lines 1--1\n", stderr: "", code: 0, timedOut: false, outputOverflow: true };
      },
    });
    assert.equal(overflow.kind, "errors");
    if (overflow.kind === "errors") {
      assert.deepEqual(overflow.diagnostics, [
        { severity: "warning", file: "manuscript/main.tex", line: 1, message: "Overfull \\hbox (1pt too wide) in paragraph at lines 1--1" },
        { severity: "error", message: "tectonic's output exceeded the 16 MiB output cap (client policy) and was cut off, so the build log is incomplete; reduce the log volume (for example the number of warnings) and compile again" },
      ]);
    }
    const bare = await compileDocument({
      root, env: ENGINE_ENV, fs: engineFs,
      spawn: fakeSpawn({ stdout: "note: Running TeX ...\n", stderr: "", code: 3 }),
    });
    assert.equal(bare.kind, "errors");
    if (bare.kind === "errors") {
      assert.deepEqual(bare.diagnostics, [
        { severity: "error", message: "tectonic exited with code 3 without printing an error line (see the warnings above, if any)" },
      ]);
    }
  });
});
