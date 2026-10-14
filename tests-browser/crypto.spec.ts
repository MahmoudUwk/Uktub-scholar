/** Differential test: the crypto shim in Chromium must match node:crypto digests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCryptoScenario } from "./scenarios/crypto.ts";
import { bundle } from "./build.mjs";
import { serveDirectory } from "./server.mjs";
import { launchChromium } from "./launch.mjs";
import { openWorkerPage, callWorker } from "./rpc.mjs";
import { diffResults } from "./compare.mjs";
import { tmpDir } from "./tmp.mjs";

test("crypto shim matches node:crypto", { timeout: 240000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const expected = runCryptoScenario();

  const outdir = tmpDir("diff-crypto-www-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { browser, executablePath } = await launchChromium();
  let actual;
  try {
    const { ctx, page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
    try {
      actual = await callWorker(page, "crypto", {});
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(`  browser: ${executablePath}`);
  // md5 is unsupported in the browser build BY DESIGN: node digests it, the
  // shim throws "not implemented ... createHash" at call time.
  const md5Node = expected["unsupportedAlgo"];
  const md5Browser = (actual as Record<string, { message?: string }>)["unsupportedAlgo"];
  assert.equal(typeof md5Node, "string");
  assert.match(String(md5Node), /^[0-9a-f]{32}$/);
  assert.match(String(md5Browser?.message ?? ""), /not implemented in the browser build: node:crypto\.createHash/);
  delete expected["unsupportedAlgo"];
  delete actual["unsupportedAlgo"];
  const diffs = diffResults(expected, actual);
  for (const d of diffs.slice(0, 20)) console.log(`  DIFF ${d}`);
  console.log(`  checks: ${Object.keys(expected).length}, diffs: ${diffs.length}`);
  assert.deepEqual(diffs, []);
});
