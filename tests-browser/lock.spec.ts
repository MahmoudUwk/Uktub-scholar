/** Two-page project-lock test: second tab refused, acquirable after close. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundle } from "./build.mjs";
import { serveDirectory } from "./server.mjs";
import { launchChromium } from "./launch.mjs";
import { tmpDir } from "./tmp.mjs";

test("project lock refuses a second tab, releases on close", { timeout: 120000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const outdir = tmpDir("diff-lock-www-");
  await bundle("tests-browser/lock-page.ts", path.join(path.relative(root, outdir), "lock-page.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { browser, executablePath } = await launchChromium();
  try {
    const project = `lock-test-${Date.now().toString(36)}`;
    // Two TABS in one context: Web Locks are origin-scoped, and separate
    // contexts may partition them; tabs share.
    const ctx = await browser.newContext();
    const page1 = await ctx.newPage();
    await page1.goto(`${server.url}/page.html`, { waitUntil: "load" });
    await page1.addScriptTag({ url: `${server.url}/lock-page.js` });
    const first = await page1.evaluate((p) => window.__acquire(p, false), project);
    assert.deepEqual(first, { held: true });

    const page2 = await ctx.newPage();
    await page2.goto(`${server.url}/page.html`, { waitUntil: "load" });
    await page2.addScriptTag({ url: `${server.url}/lock-page.js` });
    const second = await page2.evaluate((p) => window.__acquire(p, true), project);
    assert.deepEqual(second, { held: false, reason: "open-in-another-tab" });

    await page1.close();
    // The closed tab's realm releases the lock; poll briefly for it.
    let third = { held: false };
    for (let i = 0; i < 40; i++) {
      third = await page2.evaluate((p) => window.__acquire(p, true), project);
      if (third.held) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.deepEqual(third, { held: true });
    assert.equal(await page2.evaluate(() => window.__release()), "released");
    await ctx.close();
    console.log(`  browser: ${executablePath}`);
  } finally {
    await browser.close();
    await server.close();
  }
});
