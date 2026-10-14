/**
 * Differential test: the fs/os shims in Chromium match real node:fs/node:os.
 * Same scenario both sides (temp dir vs `/proj`); normalized results compared
 * exactly. Then Chromium-only sections: the visible-registry rule, exact os
 * strings, durability across an abrupt page close, and perf/size ceilings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fsCaseCount, runFsScenario } from "./scenarios/fs.ts";
import { bundle } from "./build.mjs";
import { serveDirectory } from "./server.mjs";
import { launchChromium } from "./launch.mjs";
import { openWorkerPage, callWorker } from "./rpc.mjs";
import { diffResults } from "./compare.mjs";
import { tmpDir } from "./tmp.mjs";

async function withWorkerPage(t, outdir, fn) {
  const root = path.resolve(import.meta.dirname, "..");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { browser, executablePath } = await launchChromium();
  console.log(`  browser: ${executablePath}`);
  try {
    return await fn(browser, server);
  } finally {
    await browser.close();
    await server.close();
  }
}

test("fs shim matches node:fs", { timeout: 300000 }, async (t) => {
  assert.ok(fsCaseCount() >= 50, `only ${fsCaseCount()} cases`);
  const tmp = tmpDir("diff-fs-");
  const expected = runFsScenario(tmp);
  assert.equal(Object.keys(expected).length, fsCaseCount());

  const outdir = tmpDir("diff-fs-www-");
  const actual = await withWorkerPage(t, outdir, async (browser, server) => {
    const { ctx, page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
    try {
      return await callWorker(page, "fs", { root: "/proj" });
    } finally {
      await ctx.close();
    }
  });
  const diffs = diffResults(expected, actual);
  for (const d of diffs.slice(0, 20)) console.log(`  DIFF ${d}`);
  console.log(`  checks: ${Object.keys(expected).length}, diffs: ${diffs.length}`);
  assert.deepEqual(diffs, []);
});

test("fs visible-registry rule + exact os strings (Chromium only)", { timeout: 300000 }, async (t) => {
  const outdir = tmpDir("diff-fsreg-www-");
  const actual = await withWorkerPage(t, outdir, async (browser, server) => {
    const { ctx, page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
    try {
      return await callWorker(page, "fsregistry", { root: "/proj" });
    } finally {
      await ctx.close();
    }
  });
  assert.deepEqual(actual["osExact"], { tmp: "/tmp", home: "/home/user" });
  assert.deepEqual(actual["constantsMatch"], { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1 });
  assert.equal((actual["absentRegistry"]).exists, false);
  assert.equal((actual["absentRegistry"]).stat.code, "ENOENT");
  assert.equal((actual["visibleRegistry"]).exists, true);
  assert.equal((actual["visibleRegistry"]).isFile, true);
  assert.equal((actual["visibleRegistry"]).sizeGt0, 1);
  assert.ok(((actual["visibleRegistry"]).parent).includes("registry.db"));
  for (const k of ["refuseRead", "refuseWrite", "refuseRm", "refuseCopyFrom", "refuseRenameTo", "refuseChmod"]) {
    assert.equal(actual[k].code, "EPERM", k);
    assert.match(actual[k].message, /not reachable through fs/);
  }
  assert.equal(actual["accessWOk"], null);
  assert.equal(actual["accessXThrows"].code, "EACCES");
  for (const k of ["osPlatformThrows", "osArchThrows"]) {
    assert.match(actual[k].message, new RegExp(`not implemented in the browser build: node:os\\.${k === "osPlatformThrows" ? "platform" : "arch"}`));
  }
  for (const [k, name] of [["fsOpenThrows", "openSync"], ["fsStreamThrows", "createReadStream"], ["fsAppendThrows", "appendFileSync"], ["fsMkdtempThrows", "mkdtempSync"]]) {
    assert.match(actual[k].message, new RegExp(`not implemented in the browser build: fs\\.${name}`));
  }
  console.log("  registry-rule + stub assertions: 20 ok");
});

test("fs durability across abrupt page close (Chromium only)", { timeout: 300000 }, async (t) => {
  const root = path.resolve(import.meta.dirname, "..");
  const outdir = tmpDir("diff-fsdur-www-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { browser, executablePath } = await launchChromium();
  console.log(`  browser: ${executablePath}`);
  const proj = `/dur-${Date.now().toString(36)}`;
  try {
    const ctx = await browser.newContext();
    try {
      const page1 = await ctx.newPage();
      await page1.goto(`${server.url}/page.html`, { waitUntil: "load" });
      await page1.evaluate(async (workerUrl) => {
        const w = new Worker(workerUrl, { type: "module" });
        window.__worker = w;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("worker boot timeout")), 30000);
          const onMsg = (ev) => {
            if (ev.data && ev.data.boot) {
              clearTimeout(timer);
              w.removeEventListener("message", onMsg);
              if (ev.data.ok) resolve();
              else reject(new Error(ev.data.error));
            }
          };
          w.addEventListener("message", onMsg);
        });
      }, `${server.url}/worker.js`);
      const written = await callWorker(page1, "fswrite", { root: proj });
      // Abrupt close: no shutdown hook, no worker close, no context close.
      await page1.close({ runBeforeUnload: false });
      const page2 = await ctx.newPage();
      await page2.goto(`${server.url}/page.html`, { waitUntil: "load" });
      await page2.evaluate(async (workerUrl) => {
        const w = new Worker(workerUrl, { type: "module" });
        window.__worker = w;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("worker boot timeout")), 30000);
          const onMsg = (ev) => {
            if (ev.data && ev.data.boot) {
              clearTimeout(timer);
              w.removeEventListener("message", onMsg);
              if (ev.data.ok) resolve();
              else reject(new Error(ev.data.error));
            }
          };
          w.addEventListener("message", onMsg);
        });
      }, `${server.url}/worker.js`);
      const read = await callWorker(page2, "fsread", { root: proj });
      await ctx.close();
      // Mtimes survive the close (they are stored rows, not live Dates).
      const stripMtime = (d) => ({ ...d, files: d.files.map((f) => ({ ...f, mtime: "MTIME" })) });
      assert.deepEqual(stripMtime(read).files, stripMtime(written).files);
      for (const f of read.files) assert.ok(f.mtime > 946684800000 && f.mtime < Date.now() + 60000, `mtime ${f.rel}`);
      assert.equal(read.integrity, "ok");
      // Atomic rename: either the whole old or the whole new tree, no mixture.
      const rels = new Set(read.files.map((f) => f.rel));
      assert.ok(![...rels].some((r) => r === "pack" || r.startsWith("pack/")), "old tree gone");
      assert.ok(rels.has("packed/f0.txt") && rels.has("packed/f4.txt"), "new tree whole");
      assert.ok(rels.has("docs/readonly.md") && read.files.find((f) => f.rel === "docs/readonly.md").ro === 1);
      console.log(`  durability: ${read.files.length} entries intact, integrity ok`);
    } finally {
      await ctx.close().catch(() => {});
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

test("fs latency + size ceilings (Chromium only)", { timeout: 600000 }, async (t) => {
  const outdir = tmpDir("diff-fsperf-www-");
  const actual = await withWorkerPage(t, outdir, async (browser, server) => {
    const { ctx, page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
    try {
      return await callWorker(page, "fsperf", { root: "/proj" }, { timeoutMs: 500000 });
    } finally {
      await ctx.close();
    }
  });
  console.log(`  latencyMsMedian: ${JSON.stringify(actual["latencyMsMedian"])}`);
  console.log(`  ceiling: ${JSON.stringify(actual["ceiling"])}`);
  console.log(`  overhead: ${JSON.stringify(actual["overhead"])}`);
  assert.ok(actual["ceiling"].maxRoundTripBytes >= 20 * 1024 * 1024, "20 MiB must round-trip");
  assert.ok(actual["overhead"].dbBytes >= actual["overhead"].payloadBytes, "db holds at least the payload");
});
