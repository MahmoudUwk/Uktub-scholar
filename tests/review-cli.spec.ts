/**
 * `uktub-scholar review`: the deterministic manuscript review as a CLI command. It expands the manuscript the way the compile does,
 * writes the full report to a project file (never the paper's text back to the agent), prints a few lines, and refuses paths
 * outside the project. Measures themselves: review-measures.spec.ts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/main.ts";

let root: string;
const NOW = () => new Date("2026-10-09T12:00:00Z");

async function review(args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["review", ...args], { cwd: root, out: (l) => out.push(l), err: (l) => err.push(l), now: NOW, env: {} });
  return { code, out, err };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "review-cli-"));
  mkdirSync(join(root, "manuscript/sections"), { recursive: true });
  writeFileSync(join(root, "manuscript/main.tex"), String.raw`\documentclass{article}
\begin{document}
\input{sections/intro}
\input{sections/method}
\end{document}
`);
  writeFileSync(join(root, "manuscript/sections/intro.tex"), String.raw`\section{Introduction}
Earlier work \cite{a} studied the problem.
\begin{figure}\caption{Overview}\label{fig:overview}\end{figure}
As Figure~\ref{fig:overview} shows, we start from the data.
`);
  writeFileSync(join(root, "manuscript/sections/method.tex"), String.raw`\section{Method}
We describe the method here.
`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("review command", () => {
  it("writes the report to reviews/<date>-slop.md with file:line pointers into the included files, and prints a short summary", async () => {
    const r = await review([]);
    assert.equal(r.code, 0, r.err.join("\n"));
    const path = join(root, "reviews/2026-10-09-slop.md");
    assert.ok(existsSync(path), r.out.join("\n"));
    assert.ok(r.out.length <= 8, `${r.out.length} lines printed`);
    assert.match(r.out[0] ?? "", /reviews\/2026-10-09-slop\.md/);
    const report = readFileSync(path, "utf8");
    assert.match(report, /manuscript\/sections\/intro\.tex:3/, "the unreferenced figure is pointed to in the file it sits in");
    assert.match(report, /Cross-section references/);
    assert.match(report, /diagnostic/i);
  });

  it("never overwrites: a second run the same day gets a numbered file", async () => {
    await review([]);
    await review([]);
    assert.ok(existsSync(join(root, "reviews/2026-10-09-slop-2.md")));
  });

  it("an explicit --out stays inside the project, ends in .md and does not exist yet", async () => {
    assert.equal((await review(["--out", "reviews/mine.md"])).code, 0);
    assert.ok(existsSync(join(root, "reviews/mine.md")));
    for (const bad of ["../escape.md", "/tmp/escape.md", "manuscript/main.tex", "reviews/mine.md", ".registry/x.md"]) {
      const r = await review(["--out", bad]);
      assert.equal(r.code, 1, bad);
      assert.match(r.err.join("\n"), /out|exist|project|\.md|protected/i, bad);
    }
  });

  it("names the entry it used, accepts one explicitly, and says so when there is none", async () => {
    assert.equal((await review(["manuscript/main.tex"])).code, 0);
    rmSync(join(root, "manuscript"), { recursive: true });
    const r = await review([]);
    assert.equal(r.code, 1);
    assert.match(r.err.join("\n"), /no \.tex entry/);
  });
});
