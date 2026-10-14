/**
 * Differential test: the shim in Chromium must behave exactly like node:sqlite.
 * Same scenario script, both sides; normalized results compared (bm25 floats
 * at relative tolerance 1e-12).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSqliteScenario } from "./scenarios/sqlite.ts";
import { bundle } from "./build.mjs";
import { serveDirectory } from "./server.mjs";
import { launchChromium } from "./launch.mjs";
import { openWorkerPage, callWorker } from "./rpc.mjs";
import { diffResults } from "./compare.mjs";
import { tmpDir } from "./tmp.mjs";

test("sqlite shim matches node:sqlite", { timeout: 240000 }, async (t) => {
  const root = path.resolve(import.meta.dirname, "..");
  const schema = fs.readFileSync(path.join(root, "src/core/schema.sql"), "utf8");
  const runId = Date.now().toString(36);
  const tmp = tmpDir("diff-sqlite-");
  const nodePath = path.join(tmp, "registry.db");
  const browserPath = `/diff-${runId}/registry.db`;
  const expected = runSqliteScenario(nodePath, schema);
  await t.test("node reference produces its result keys", () => {
    assert.ok(Object.keys(expected).length > 40, `only ${Object.keys(expected).length} checks`);
  });

  const outdir = tmpDir("diff-sqlite-www-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { browser, executablePath } = await launchChromium();
  let actual;
  try {
    const { ctx, page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
    try {
      actual = await callWorker(page, "sqlite", { dbPath: browserPath, schemaSql: schema });
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(`  browser: ${executablePath}`);
  // location() returns each side's own store path (disk tmp vs sahpool key);
  // assert each echoes its input, then compare the rest.
  assert.equal(expected["location"], nodePath);
  assert.equal((actual as Record<string, unknown>)["location"], browserPath);
  assert.equal(((expected["secondOpen"] ?? {}) as Record<string, unknown>)["loc"], nodePath);
  assert.equal(((actual as Record<string, unknown>)["secondOpen"] as Record<string, unknown>)["loc"], browserPath);
  delete expected["location"];
  delete (actual as Record<string, unknown>)["location"];
  delete ((expected["secondOpen"] ?? {}) as Record<string, unknown>)["loc"];
  delete ((actual as Record<string, unknown>)["secondOpen"] as Record<string, unknown>)["loc"];
  const diffs = diffResults(expected, actual);
  for (const d of diffs.slice(0, 20)) console.log(`  DIFF ${d}`);
  console.log(`  checks: ${Object.keys(expected).length}, diffs: ${diffs.length}`);
  assert.deepEqual(diffs, []);
});
