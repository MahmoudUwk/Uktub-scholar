/** Differential test: the zlib shim in Chromium must match node:zlib classes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { runZlibScenario } from "./scenarios/zlib.ts";
import { bundle } from "./build.mjs";
import { serveDirectory } from "./server.mjs";
import { launchChromium } from "./launch.mjs";
import { openWorkerPage, callWorker } from "./rpc.mjs";
import { diffResults } from "./compare.mjs";
import { tmpDir } from "./tmp.mjs";

test("zlib shim matches node:zlib", { timeout: 240000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const payloadText = "tei payload héllo ".repeat(500);
  const payload = new TextEncoder().encode(payloadText);
  const gz = gzipSync(payload);
  const fx = {
    gz: [...gz],
    payloadLen: payload.length,
    payloadHead: [...payload].slice(0, 8),
    payloadText,
  };
  const expected = runZlibScenario(fx);

  const outdir = tmpDir("diff-zlib-www-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { browser, executablePath } = await launchChromium();
  let actual;
  try {
    const { ctx, page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
    try {
      actual = await callWorker(page, "zlib", fx);
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(`  browser: ${executablePath}`);
  // fflate's corruption messages differ textually from zlib's; the error
  // CLASS (name/code) is contractual, the text is not.
  const exempt = new Set(["$.corrupt", "$.truncated", "$.emptyInput", "$.notGzip"].map((k) => k));
  const diffs = diffResults(expected, actual, { messageExempt: exempt });
  for (const d of diffs.slice(0, 20)) console.log(`  DIFF ${d}`);
  console.log(`  checks: ${Object.keys(expected).length}, diffs: ${diffs.length}`);
  assert.deepEqual(diffs, []);
});
