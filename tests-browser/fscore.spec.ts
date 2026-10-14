/** Differential test: REAL core file code through the fs seam (Node vs shim). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFscoreScenario } from "./scenarios/fscore.ts";
import { bundle } from "./build.mjs";
import { serveDirectory } from "./server.mjs";
import { launchChromium } from "./launch.mjs";
import { openWorkerPage, callWorker } from "./rpc.mjs";
import { diffResults } from "./compare.mjs";
import { tmpDir } from "./tmp.mjs";

test("core project-file code matches through the fs seam", { timeout: 300000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const tmp = tmpDir("diff-fscore-");
  const expected = runFscoreScenario(tmp);
  console.log(`  node checks: ${Object.keys(expected).length}`);

  const outdir = tmpDir("diff-fscore-www-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { browser, executablePath } = await launchChromium();
  let actual;
  try {
    const { ctx, page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
    try {
      actual = await callWorker(page, "fscore", { root: "/proj" });
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(`  browser: ${executablePath}`);
  const diffs = diffResults(expected, actual);
  for (const d of diffs.slice(0, 20)) console.log(`  DIFF ${d}`);
  console.log(`  checks: ${Object.keys(expected).length}, diffs: ${diffs.length}`);
  assert.deepEqual(diffs, []);
});
