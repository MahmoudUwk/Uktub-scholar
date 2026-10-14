/**
 * Differential test: the Buffer shim in Chromium must match Node's Buffer
 * (edge cases, the exact core expressions, and the real core extractors),
 * and the process shim must report its shape with throwing event methods.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBufferScenario } from "./scenarios/buffer.ts";
import { bundle } from "./build.mjs";
import { serveDirectory } from "./server.mjs";
import { launchChromium } from "./launch.mjs";
import { openWorkerPage, callWorker } from "./rpc.mjs";
import { diffResults } from "./compare.mjs";
import { tmpDir } from "./tmp.mjs";

async function bootWorker() {
  const root = path.resolve(import.meta.dirname, "..");
  const outdir = tmpDir("diff-buffer-www-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { browser, executablePath } = await launchChromium();
  console.log(`  browser: ${executablePath}`);
  const { ctx, page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
  return { browser, server, ctx, page };
}

test("Buffer shim matches Node Buffer", { timeout: 240000 }, async () => {
  const expected = await runBufferScenario();
  const { browser, server, ctx, page } = await bootWorker();
  let actual: Record<string, { message?: string }>;
  try {
    try {
      actual = await callWorker(page as never, "buffer", {}) as Record<string, { message?: string }>;
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  // write() is unsupported in the browser build BY DESIGN: Node writes bytes,
  // the shim throws "not implemented ... Buffer.write" at call time.
  assert.equal(typeof expected["unsupported"], "number");
  assert.match(String(actual["unsupported"]?.message ?? ""), /not implemented in the browser build: Buffer\.write/);
  delete expected["unsupported"];
  delete actual["unsupported"];
  // Garbage-with-markers normalizes to the same malformed SourceError on both
  // sides, so it diffs like any other case (below). Real PDFs are covered by
  // pdf.spec.ts (unpdf runs in the worker).
  const diffs = diffResults(expected, actual);
  for (const d of diffs.slice(0, 20)) console.log(`  DIFF ${d}`);
  console.log(`  checks: ${Object.keys(expected).length}, diffs: ${diffs.length}`);
  assert.deepEqual(diffs, []);
});

test("process shim contract in the worker", { timeout: 240000 }, async () => {
  const { browser, server, ctx, page } = await bootWorker();
  let res: { platform: string; arch: string; pid: number; env: Record<string, string>; throws: Record<string, string> };
  try {
    try {
      res = await callWorker(page as never, "process", { setEnv: { UKTUB_TEST: "1" } }) as typeof res;
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  assert.equal(res.platform, "browser");
  assert.equal(res.env["UKTUB_TEST"], "1");
  for (const m of ["once", "on", "exit"]) {
    assert.match(String(res.throws[m] ?? ""), new RegExp(`not implemented in the browser build: process\\.${m}`));
  }
  console.log(`  process: platform=${res.platform} arch=${res.arch} pid=${res.pid} envKeys=${Object.keys(res.env).length}`);
});
