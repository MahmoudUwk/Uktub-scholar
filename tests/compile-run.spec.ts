/**
 * Compile orchestration spec: entry resolution, outdir creation, timeout
 * mapping, and outcome shaping — fully offline with a fake engine spawn.
 * The prod spawn and a real engine are exercised by the env-gated test at the
 * bottom and by the sandbox smoke (uktub-fresh).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { compileDocument, describeOutcome, timeoutMsFromEnv, DEFAULT_COMPILE_TIMEOUT_MS, type EngineSpawn } from "../src/core/compile/run.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-compile-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ENGINE_ENV = { UKTUB_TECTONIC_BIN: "/fake/tectonic", PATH: "" };
const engineFs = { exists: () => true, executable: () => true };

/** Fake spawn answering --version and the compile invocation from canned streams. */
function fakeSpawn(responds: { stdout: string; stderr: string; code: number; timedOut?: boolean }, writesPdf?: string): EngineSpawn {
  return async (_file, args, opts) => {
    if (args[0] === "--version") return { stdout: "Tectonic 0.15.0\n", stderr: "", code: 0, timedOut: false };
    assert.equal(args[0], "-X");
    assert.deepEqual(args.slice(1, 3), ["compile", args[2]]);
    assert.equal(opts.cwd, dirname(args[2] as string), "tectonic runs in the entry's own directory");
    if (writesPdf) {
      const outdir = args[args.indexOf("--outdir") + 1];
      writeFileSync(join(outdir, writesPdf), "%PDF-fake");
    }
    const outdirArg = args[args.indexOf("--outdir") + 1];
    return {
      stdout: responds.stdout.replace("build/main.pdf", `${outdirArg}/main.pdf`),
      stderr: responds.stderr,
      code: responds.code,
      // Real tectonic echoes the --outdir path exactly as given (verified
      // against 0.15.0): absolute outdir in, absolute path in the note.
      timedOut: responds.timedOut === true,
    };
  };
}

describe("compileDocument", () => {
  it("success: creates build/, reports the pdf relative to root with its size", async () => {
    mkdirSync(join(root, "manuscript"), { recursive: true });
    writeFileSync(join(root, "manuscript", "main.tex"), "\\begin{document}hi\\end{document}");
    const outcome = await compileDocument(
      {
        root,
        env: ENGINE_ENV,
        fs: engineFs,
        spawn: fakeSpawn(
          {
            stdout: 'note: "version 2" Tectonic command-line interface activated\nnote: Writing `build/main.pdf` (3.79 KiB)\n',
            stderr: "",
            code: 0,
          },
          "main.pdf",
        ),
      },
    );
    assert.equal(outcome.kind, "compiled");
    if (outcome.kind === "compiled") {
      assert.equal(outcome.entry, "manuscript/main.tex");
      assert.equal(outcome.pdfPath, "build/main.pdf");
      assert.equal(outcome.pdfSizeBytes, "%PDF-fake".length);
      assert.equal(outcome.engineVersion, "0.15.0");
      assert.deepEqual(outcome.diagnostics, []);
    }
    assert.ok(existsSync(join(root, "build")), "build/ is created before the engine runs");
  });

  it("errors: exit 1 with error diagnostics keeps the tool successful but status errors", async () => {
    mkdirSync(join(root, "manuscript"), { recursive: true });
    writeFileSync(join(root, "manuscript", "main.tex"), "\\asdf");
    const outcome = await compileDocument({
      root,
      env: ENGINE_ENV,
      fs: engineFs,
      spawn: fakeSpawn({
        stdout: "note: Running TeX ...\n",
        stderr: "error: main.tex:1: Undefined control sequence\nerror: halted on potentially-recoverable error as specified\n",
        code: 1,
      }),
    });
    assert.equal(outcome.kind, "errors");
    if (outcome.kind === "errors") {
      assert.equal(outcome.diagnostics.length, 2);
    }
  });

  it("errors: a non-zero exit that printed no error line still says why, never a bare '0 error(s)' failure", async () => {
    mkdirSync(join(root, "manuscript"), { recursive: true });
    writeFileSync(join(root, "manuscript", "main.tex"), "x");
    const outcome = await compileDocument({
      root,
      env: ENGINE_ENV,
      fs: engineFs,
      spawn: fakeSpawn({ stdout: "note: Running TeX ...\n", stderr: "warning: main.tex:5: Overfull \\hbox (3pt too wide) in paragraph at lines 5--5\n", code: 3 }),
    });
    assert.equal(outcome.kind, "errors");
    if (outcome.kind === "errors") {
      const errors = outcome.diagnostics.filter((d) => d.severity === "error");
      assert.equal(errors.length, 1);
      assert.match(errors[0]?.message ?? "", /exited with code 3 without printing an error line/);
      assert.match(describeOutcome(outcome), /1 error\(s\)/);
    }
  });

  it("diagnostics name files as project-relative paths with their extension, so the agent can open them (live: tectonic prints `sections/intro`)", async () => {
    mkdirSync(join(root, "manuscript", "multi", "sections"), { recursive: true });
    writeFileSync(join(root, "manuscript", "multi", "main.tex"), "\\input{sections/intro}");
    writeFileSync(join(root, "manuscript", "multi", "sections", "intro.tex"), "\\undefinedcmd");
    const outcome = await compileDocument({
      root,
      env: ENGINE_ENV,
      fs: engineFs,
      spawn: fakeSpawn({
        stdout: "",
        stderr: "warning: main.tex:1: Overfull \\hbox (1pt too wide) in paragraph at lines 1--1\nerror: sections/intro:1: Undefined control sequence\nerror: ghost/missing:4: not a file we can find\nerror: halted on potentially-recoverable error as specified\n",
        code: 1,
      }),
    }, "manuscript/multi/main.tex");
    assert.equal(outcome.kind, "errors");
    if (outcome.kind === "errors") {
      assert.deepEqual(outcome.diagnostics.map((d) => d.file), ["manuscript/multi/main.tex", "manuscript/multi/sections/intro.tex", "ghost/missing", undefined]);
      assert.equal(outcome.diagnostics[1]?.line, 1);
    }
  });

  it("timeout: the spawn's timedOut maps to the COMPILE_TIMEOUT refusal", async () => {
    mkdirSync(join(root, "manuscript"), { recursive: true });
    writeFileSync(join(root, "manuscript", "main.tex"), "x");
    const outcome = await compileDocument({
      root,
      env: ENGINE_ENV,
      fs: engineFs,
      spawn: fakeSpawn({ stdout: "", stderr: "", code: 1, timedOut: true }),
    });
    assert.equal(outcome.kind, "refusal");
    if (outcome.kind === "refusal") assert.equal(outcome.code, "COMPILE_TIMEOUT");
  });

  it("engine missing: resolution failure is the typed refusal, never a spawn attempt", async () => {
    mkdirSync(join(root, "manuscript"), { recursive: true });
    writeFileSync(join(root, "manuscript", "main.tex"), "x");
    let compileAttempted = false;
    const outcome = await compileDocument({
      root,
      env: { PATH: "/no/such/dir", UKTUB_CACHE_DIR: join(root, "empty-cache") },
      spawn: async () => {
        compileAttempted = true;
        return { stdout: "", stderr: "", code: 0, timedOut: false };
      },
    });
    assert.equal(outcome.kind, "refusal");
    if (outcome.kind === "refusal") {
      assert.equal(outcome.code, "COMPILE_ENGINE_MISSING");
      assert.match(outcome.message, /tectonic install --yes/, "a user with no TeX tooling is told the one command that fixes it");
    }
    assert.equal(compileAttempted, false);
  });

  it("entry defaults: manuscript/main.tex wins; multiple candidates refuse", async () => {
    mkdirSync(join(root, "manuscript"), { recursive: true });
    writeFileSync(join(root, "manuscript", "a.tex"), "a");
    writeFileSync(join(root, "manuscript", "b.tex"), "b");
    const multi = await compileDocument({
      root,
      env: ENGINE_ENV,
      fs: engineFs,
      spawn: fakeSpawn({ stdout: "", stderr: "", code: 0 }),
    });
    assert.equal(multi.kind, "refusal");

    writeFileSync(join(root, "manuscript", "main.tex"), "m");
    rmSync(join(root, "manuscript", "a.tex"));
    rmSync(join(root, "manuscript", "b.tex"));
    const single = await compileDocument({
      root,
      env: ENGINE_ENV,
      fs: engineFs,
      spawn: fakeSpawn({ stdout: "", stderr: "", code: 0 }),
    });
    assert.equal(single.kind, "compiled");
  });

  it("entry confinement: absolute paths, traversal, and non-.tex are refused", async () => {
    mkdirSync(join(root, "manuscript"), { recursive: true });
    writeFileSync(join(root, "manuscript", "main.tex"), "m");
    for (const bad of ["/etc/passwd", "../outside.tex", "manuscript/main.txt", "build/main.tex"]) {
      const outcome = await compileDocument({ root, env: ENGINE_ENV, fs: engineFs, spawn: fakeSpawn({ stdout: "", stderr: "", code: 0 }) }, bad);
      assert.equal(outcome.kind, "refusal", `entry ${bad} must be refused`);
      if (outcome.kind === "refusal") assert.equal(outcome.code, "COMPILE_NO_ENTRY");
    }
  });
});

describe("compile timeout budget", () => {
  it("default is the client-policy 120s; env override wins in seconds; junk falls back", () => {
    assert.equal(timeoutMsFromEnv({}), DEFAULT_COMPILE_TIMEOUT_MS);
    assert.equal(timeoutMsFromEnv({ UKTUB_COMPILE_TIMEOUT_S: "30" }), 30_000);
    assert.equal(timeoutMsFromEnv({ UKTUB_COMPILE_TIMEOUT_S: "4" }), DEFAULT_COMPILE_TIMEOUT_MS);
    assert.equal(timeoutMsFromEnv({ UKTUB_COMPILE_TIMEOUT_S: "abc" }), DEFAULT_COMPILE_TIMEOUT_MS);
  });
});

describe("prod spawn against a real tectonic (env-gated)", () => {
  const realEngine = process.env.UKTUB_REAL_TECTONIC ?? "";
  const hasEngine = realEngine !== "";
  it("compiles a minimal document end-to-end through the real binary", { skip: !hasEngine }, async () => {
    mkdirSync(join(root, "manuscript"), { recursive: true });
    writeFileSync(join(root, "manuscript", "main.tex"), "\\documentclass{article}\\begin{document}Real.\\end{document}\n");
    const outcome = await compileDocument({
      root,
      env: { UKTUB_TECTONIC_BIN: realEngine, PATH: "" },
      spawn: (await import("../src/core/compile/run.ts")).prodSpawn,
    });
    assert.equal(outcome.kind, "compiled");
    if (outcome.kind === "compiled") {
      assert.ok(outcome.pdfPath === "build/main.pdf");
      assert.ok((outcome.pdfSizeBytes ?? 0) > 1000);
      assert.ok(statSync(join(root, "build", "main.pdf")).isFile());
    }
  });
});

describe("describeOutcome hints (a precise engine error the model still cannot act on gets the working recipe)", () => {
  const failed = (message: string) => ({
    kind: "errors" as const,
    entry: "manuscript/main.tex",
    engineVersion: "0.17.0",
    diagnostics: [{ severity: "error" as const, message }],
    truncated: false,
  });

  it("biblatex through a parent path: names the BibTeX form that works from manuscript/", () => {
    const text = describeOutcome(failed("relative parent paths are not supported for the external tool. Got path `../refs/references.bib`."));
    assert.match(text, /hint:/i);
    assert.match(text, /\\bibliography\{\.\.\/refs\/references\}/);
    assert.match(text, /biblatex/i);
  });

  it("a missing biber is the same hint (Tectonic runs BibTeX, not biber)", () => {
    assert.match(describeOutcome(failed("biber: command not found")), /\\bibliography/);
  });

  it("an ordinary error gets no hint, and a clean build none", () => {
    assert.doesNotMatch(describeOutcome(failed("LaTeX Error: Environment itemze undefined.")), /hint:/i);
  });
});

describe("describeOutcome: known engine behavior", () => {
  // Seen in real sessions (experiments/runs/rf-llm-literature-review/iter-04 and iter-06): the agent spent 6+ extra compile/edit cycles switching
  // bibliography styles to clear the two Tectonic 0.15.0 main.bbl warnings the README already calls spurious.
  const compiled = (engineVersion: string, messages: string[]) => ({
    kind: "compiled" as const,
    entry: "manuscript/main.tex",
    engineVersion,
    pdfPath: "build/main.pdf",
    pdfSizeBytes: 100,
    diagnostics: messages.map((message) => ({ severity: "warning" as const, message })),
    truncated: false,
  });
  const BBL = ["internal consistency problem when checking if main.bbl changed", "TeX rerun seems needed, but stopping at 6 passes"];

  it("the two Tectonic 0.15.0 main.bbl warnings are listed AND explained as a known engine behavior that editing the document does not clear", () => {
    const text = describeOutcome(compiled("0.15.0", BBL));
    assert.match(text, /- warning: internal consistency problem/, "the warning is still disclosed");
    assert.match(text, /note: .*0\.15\.0.*every bibliography build.*not caused by the document/i);
  });

  it("other warnings, or a clean build, get no such note", () => {
    assert.doesNotMatch(describeOutcome(compiled("0.15.0", ["Overfull \\hbox (33pt too wide) detected at line 131"])), /note:/i);
    assert.doesNotMatch(describeOutcome(compiled("0.17.0", [])), /note:/i);
  });
});
