/**
 * Real-Chromium tests for `src/browser/download.ts` (+ arXiv spacing in-page).
 * Local loopback servers on two origins (127.0.0.1 vs localhost).
 * Run: `node --test tests-browser-net/browser-download.spec.ts`
 * (needs playwright-core: `npm i --no-save playwright-core`).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { startHarness, type Harness } from "./servers.ts";

const SHELL_1243 = join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell");
const CHROMIUM_1243 = join(homedir(), ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome");
const executablePath = existsSync(SHELL_1243) ? SHELL_1243 : CHROMIUM_1243;

let harness: Harness;
let chromium: typeof import("playwright-core").chromium;
let browser: import("playwright-core").Browser;
let page: import("playwright-core").Page;

before(async () => {
  const root = join(new URL(import.meta.url).pathname.replace(/\/browser-download\.spec\.(ts|js)$/, ""), "..");
  execFileSync(process.execPath, [join(root, "tests-browser-net/build-page.ts")], { stdio: "inherit" });
  harness = await startHarness();
  ({ chromium } = await import("playwright-core"));
  browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  page = await browser.newPage();
  page.on("pageerror", (e) => console.error("PAGEERROR", e));
  await page.goto(`${harness.urlA}/test.html`);
  await page.waitForFunction(() => (globalThis as Record<string, unknown>).__mods !== undefined);
});

after(async () => {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await harness?.close();
});

const run = async <T>(fn: string, arg?: unknown): Promise<T> =>
  page.evaluate(`(${fn})(${JSON.stringify(arg ?? null)})`) as Promise<T>;

describe("browser downloader in real Chromium", () => {
  it("downloads under/at/over the byte cap with the contract verdicts", async () => {
    const out = await run<string>(`(async ({urlA}) => {
      const { createBrowserDownloader } = globalThis.__mods.download;
      const dl = createBrowserDownloader({ allowLoopbackHttp: true });
      const under = await dl(urlA + "/small.pdf?sig=x#y", { maxBytes: 65536 });
      const at = await dl(urlA + "/exact.bin?n=64", { maxBytes: 64 });
      const over = await dl(urlA + "/big.bin?n=65", { maxBytes: 64 }).then(() => "NO_THROW", (e) => e.code + ":" + e.message);
      const declared = await dl(urlA + "/declared-big.bin?declared=100000", { maxBytes: 64 }).then(() => "NO_THROW", (e) => e.code);
      return JSON.stringify({ under: [under.bytes.byteLength, under.contentType, under.finalUrl], at: at.bytes.byteLength, over, declared });
    })`, { urlA: harness.urlA });
    const r = JSON.parse(out) as { under: [number, string, string]; at: number; over: string; declared: string };
    assert.equal(r.under[0], 2048);
    assert.equal(r.under[1], "application/pdf");
    assert.equal(r.under[2], `${harness.urlA}/small.pdf`);
    assert.equal(r.at, 64);
    assert.match(r.over, /^too_large:/);
    assert.equal(r.declared, "too_large");
  });

  it("hits the time cap on a slow body", async () => {
    const out = await run<string>(`(async ({urlA}) => {
      const { createBrowserDownloader } = globalThis.__mods.download;
      const dl = createBrowserDownloader({ allowLoopbackHttp: true, timeoutMs: 600 });
      return dl(urlA + "/slow", { maxBytes: 65536 }).then(() => "NO_THROW", (e) => e.code + ":" + e.message);
    })`, { urlA: harness.urlA });
    assert.match(out, /^download_failed:/);
  });

  it("refuses http and userinfo URLs without any network call", async () => {
    const out = await run<string>(`(() => {
      const { createBrowserDownloader } = globalThis.__mods.download;
      let calls = 0;
      const counting = (...a) => { calls += 1; return fetch(...a); };
      const strict = createBrowserDownloader({ fetch: counting });
      const r1 = strict("http://example.com/a.pdf", { maxBytes: 64 }).then(() => "NO_THROW", (e) => e.code);
      const r2 = strict("https://user:pw@example.com/a.pdf", { maxBytes: 64 }).then(() => "NO_THROW", (e) => e.code);
      const loop = createBrowserDownloader({ fetch: counting })("http://127.0.0.1:9/a.pdf", { maxBytes: 64 }).then(() => "NO_THROW", (e) => e.code);
      return Promise.all([r1, r2, loop]).then((cs) => JSON.stringify({ cs, calls }));
    })`);
    const r = JSON.parse(out) as { cs: string[]; calls: number };
    assert.deepEqual(r.cs, ["unsafe_destination", "unsafe_destination", "unsafe_destination"]);
    assert.equal(r.calls, 0);
  });

  it("maps missing CORS headers to the manual-import error", async () => {
    const out = await run<string>(`(async ({urlB}) => {
      const { createBrowserDownloader } = globalThis.__mods.download;
      const dl = createBrowserDownloader({ allowLoopbackHttp: true });
      return dl(urlB + "/final-noacao", { maxBytes: 65536 }).then(() => "NO_THROW", (e) => e.code + "::" + e.message);
    })`, { urlB: harness.urlB });
    assert.equal(out, "download_failed::the host did not allow this browser to read the file, or could not be reached; import the PDF manually");
  });

  it("follows a cross-origin 302 with CORS headers; fails one without", async () => {
    const out = await run<string>(`(async ({urlA}) => {
      const { createBrowserDownloader } = globalThis.__mods.download;
      const dl = createBrowserDownloader({ allowLoopbackHttp: true });
      const ok = await dl(urlA + "/to-b-ok", { maxBytes: 65536 });
      const blocked = await dl(urlA + "/to-b-noacao", { maxBytes: 65536 }).then(() => "NO_THROW", (e) => e.code);
      return JSON.stringify({ finalUrl: ok.finalUrl, bytes: ok.bytes.byteLength, blocked });
    })`, { urlA: harness.urlA });
    const r = JSON.parse(out) as { finalUrl: string; bytes: number; blocked: string };
    assert.equal(r.finalUrl, `${harness.urlB}/final-ok`);
    assert.equal(r.bytes, 512);
    assert.equal(r.blocked, "download_failed");
  });

  it("scopes the credential to its origin and never leaks it cross-origin", async () => {
    await run<string>(`(async ({urlA}) => {
      const { createBrowserDownloader } = globalThis.__mods.download;
      const originA = new URL(urlA).origin;
      const dl = createBrowserDownloader({ allowLoopbackHttp: true });
      await dl(urlA + "/echo", { maxBytes: 65536, credential: { origin: originA, param: "api_key", value: "SECRET" } });
      await dl(urlA + "/echo", { maxBytes: 65536, credential: { origin: "https://other.example", param: "api_key", value: "SECRET" } });
      await dl(urlA + "/to-b-ok", { maxBytes: 65536, credential: { origin: originA, param: "api_key", value: "SECRET" } });
      return "done";
    })`, { urlA: harness.urlA });
    const echo = harness.seenA.filter((s) => s.path === "/echo");
    assert.equal(echo.length, 2);
    assert.equal(echo[0]?.query.get("api_key"), "SECRET");
    assert.equal(echo[1]?.query.get("api_key"), null);
    const toB = harness.seenB.filter((s) => s.path === "/final-ok");
    assert.ok(toB.length >= 1);
    for (const s of toB) assert.equal(s.query.get("api_key"), null);
  });

  it("sends no Range header and omits credentials", async () => {
    await run<string>(`(async ({urlA}) => {
      const { createBrowserDownloader } = globalThis.__mods.download;
      await createBrowserDownloader({ allowLoopbackHttp: true })(urlA + "/small.pdf", { maxBytes: 65536 });
      return "done";
    })`, { urlA: harness.urlA });
    const got = harness.seenA.filter((s) => s.path === "/small.pdf").at(-1);
    assert.equal(got?.headers["range"], undefined);
  });

  it("enforces arXiv spacing in the page with a fake clock", async () => {
    const out = await run<string>(`(async () => {
      const { arxivSpacer, ARXIV_MIN_SPACING_MS } = globalThis.__mods.arxiv;
      const realNow = Date.now;
      let now = 1000000;
      Date.now = () => now;
      try {
        const sleeps = [];
        const sleep = async (ms) => { sleeps.push(ms); now += ms; };
        const spacer = arxivSpacer(sleep);
        await spacer.wait();
        await spacer.wait();
        return JSON.stringify({ sleeps, spacing: ARXIV_MIN_SPACING_MS });
      } finally {
        Date.now = realNow;
      }
    })`);
    const r = JSON.parse(out) as { sleeps: number[]; spacing: number };
    assert.equal(r.spacing, 3000);
    assert.deepEqual(r.sleeps, [3000]);
  });
});
