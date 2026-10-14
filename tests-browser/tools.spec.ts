/**
 * Tool-level differential tests: the SAME script runs (a) in Node against a
 * temp directory (real `node:sqlite`/`node:fs`) and (b) in Chromium through
 * `src/browser/host.ts`, then the tools' text and structured results compare
 * after normalizing roots (`<root>`). Clocks are fixed on both sides.
 *
 * Covered: registry register (2 DOIs, canned Crossref) + read + idempotent
 * re-register + TEI attach + PDF attach (real unpdf in the worker, pointers
 * with page numbers) + sync_bibliography (0444
 * `refs/references.bib` byte-equal); passages lexical search; search with
 * canned providers; refusals (before-init, foreign `user_version`, path
 * escape, verify/compile with no engine). Durability + second-tab lock live in
 * the last two tests (persistent profile, no shutdown hook).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";

import { makePdf } from "../tests/helpers/pdf.ts";
import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry } from "../src/core/registry.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import { paperRegistryTool } from "../src/core/tools/registry.ts";
import { searchPassagesTool } from "../src/core/tools/passages.ts";
import { searchPapersTool } from "../src/core/tools/search.ts";
import { verifyClaimTool } from "../src/core/tools/verify.ts";
import { compileDocumentTool } from "../src/core/tools/compile.ts";
import {
  FIXED_NOW_ISO,
  TEST_PROVIDER_CONFIG,
  buildCannedDownload,
  buildCannedFetch,
  dataciteRoutes,
  normalizeForCompare,
  registerRoutes,
  searchRoutes,
  teiFixture,
  type CannedDownload,
  type CannedRoute,
} from "./scenarios/tools.ts";
import { bundle } from "./build.mjs";
import { serveDirectory } from "./server.mjs";
import { launchChromium, executableCandidates } from "./launch.mjs";
import { openWorkerPage, callWorker } from "./rpc.mjs";
import { diffResults } from "./compare.mjs";
import { tmpDir } from "./tmp.mjs";

// ── shared fixtures ─────────────────────────────────────────────────────────

/** An arXiv DOI: acquisition derives the PDF URL from the identifier alone (OpenAlex knows nothing of it in the canned routes). */
const DOI_ARXIV = "10.48550/arxiv.2501.00001";

const PAPERS = {
  "10.1001/aaa": {
    title: "Alpha Grid",
    bibtex: "@article{holder2024, title={Alpha Grid}, author={Holder, Ada}, year={2024}}",
    abstract: "<jats:p>Grids <jats:italic>age</jats:italic> slowly.</jats:p>",
  },
  "10.1001/bbb": {
    title: "Beta Cache",
    bibtex: "@article{holder2024a, title={Beta Cache}, author={Holder, Ada}, year={2024}}",
  },
};

const ARXIV_PAPER = {
  title: "Gamma Pipelines",
  bibtex: "@article{holder2025, title={Gamma Pipelines}, author={Holder, Ada}, year={2025}}",
  year: 2025,
};

const SEARCH_OPENALEX = [
  { title: "Thermal grids in the field", doi: "10.1000/oa-1" },
  { title: "Cache behavior under heat", doi: "10.1000/oa-2" },
];
const SEARCH_CROSSREF = [
  { title: "Thermal grids in the laboratory", doi: "10.1000/cr-1" },
  { title: "Aging grids survey", doi: "10.1000/cr-2" },
];
const SEARCH_S2 = [
  { title: "Thermal grids preprint", doi: "10.1000/s2-1" },
  { title: "Grid resonance notes", doi: "10.1000/s2-2" },
];

const ALL_ROUTES: CannedRoute[] = [
  ...registerRoutes(PAPERS),
  ...dataciteRoutes(DOI_ARXIV, ARXIV_PAPER),
  ...searchRoutes(SEARCH_OPENALEX, SEARCH_CROSSREF, SEARCH_S2),
];

/** The arXiv copy: a two-page PDF whose opening carries the arXiv stamp (identity), served by the canned download transport. */
function arxivPdfBytes(): Uint8Array {
  return makePdf([
    [
      "Gamma Pipelines",
      "arXiv:2501.00001v1 [cs.LG] 1 Jan 2025",
      "Pipeline throughput scales with the number of independent stages in the shared queue.",
    ],
    ["2 Results", "Stage latency dominated the end to end delay of the pipeline in every measured run."],
  ]);
}
const ALL_DOWNLOADS: CannedDownload[] = [
  { match: "arxiv.org/pdf/2501.00001", bytesBase64: Buffer.from(arxivPdfBytes()).toString("base64"), contentType: "application/pdf" },
];

const TEI_REL = "papers/alpha.tei.xml";
const DOI_A = "10.1001/aaa";
const DOI_B = "10.1001/bbb";
const PDF_REL = "papers/beta.pdf";

/** A two-page text PDF whose opening carries the DOI and title (identity), ASCII only so it crosses `writeFile` as text. */
function betaPdf(): string {
  const page1 = [
    `Beta Cache ${DOI_B}`,
    "Cache eviction under sustained heat degrades the hit rate of the shared tier.",
    "We measure the hit rate of the cache across many independent thermal cycles.",
  ];
  const page2 = ["Results", "The hit rate of the cache fell steadily as the temperature of the shared tier rose."];
  return Buffer.from(makePdf([page1, page2])).toString("latin1");
}

// ── runners ─────────────────────────────────────────────────────────────────

interface Runner {
  /** Project root string used for result normalization. */
  root: string;
  init(): Promise<unknown>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  writeFile(rel: string, text: string): Promise<void>;
  readBib(): Promise<string>;
  registryBytes(): Promise<number[] | null>;
  makeForeign(version: number): Promise<void>;
  exportFiles(): Promise<{ path: string; size: number }[]>;
  close(): Promise<void>;
}

function nodeCtx(root: string, cacheDir: string): ToolContext {
  return {
    root,
    fetch: buildCannedFetch(ALL_ROUTES),
    download: buildCannedDownload(ALL_DOWNLOADS),
    // Point the managed-embedding cache at an empty dir: no embedder is
    // installed there, so both sides resolve to clean lexical-only search
    // (the decided browser behavior) instead of the machine's home cache.
    env: { UKTUB_CACHE_DIR: cacheDir },
    now: () => new Date(FIXED_NOW_ISO),
    queue: new WriteQueue(),
    providerConfig: TEST_PROVIDER_CONFIG,
  };
}

function makeNodeRunner(): Runner & { dir: string } {
  const dir = tmpDir("diff-tools-");
  const cacheDir = tmpDir("diff-tools-cache-");
  let db: { close(): void } | null = null;
  return {
    dir,
    root: dir,
    async init() {
      db = createRegistry(dir);
      db.close();
      db = null;
      return { ok: true };
    },
    async callTool(name: string, args: Record<string, unknown>) {
      const ctx = nodeCtx(dir, cacheDir);
      switch (name) {
        case "registry":
          return await paperRegistryTool(ctx, args as never);
        case "passages":
          return await searchPassagesTool(ctx, args as never);
        case "search":
          return await searchPapersTool(ctx, args as never);
        case "verify":
          return await verifyClaimTool(ctx, args as never);
        case "compile":
          return await compileDocumentTool(ctx, args as never);
        default:
          throw new Error(`unknown tool ${name}`);
      }
    },
    async writeFile(rel: string, text: string) {
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    },
    async readBib() {
      return fs.readFileSync(path.join(dir, "refs/references.bib"), "utf8");
    },
    async registryBytes() {
      const p = path.join(dir, ".registry/registry.db");
      return fs.existsSync(p) ? Array.from(fs.readFileSync(p)) : null;
    },
    async makeForeign(version: number) {
      const { DatabaseSync } = await import("node:sqlite");
      const db2 = new DatabaseSync(path.join(dir, ".registry/registry.db"));
      try {
        db2.exec("CREATE TABLE IF NOT EXISTS probe(x)");
        db2.exec(`PRAGMA user_version = ${version}`);
      } finally {
        db2.close();
      }
    },
    async exportFiles() {
      const out: { path: string; size: number }[] = [];
      const walk = (d: string): void => {
        for (const e of fs.readdirSync(d)) {
          const abs = path.join(d, e);
          if (abs.includes(".registry")) continue;
          const st = fs.statSync(abs);
          if (st.isDirectory()) walk(abs);
          else out.push({ path: path.relative(dir, abs).split(path.sep).join("/"), size: st.size });
        }
      };
      walk(dir);
      return out.sort((a, b) => (a.path < b.path ? -1 : 1));
    },
    async close() {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    },
  };
}

function makeBrowserRunner(page: unknown, projectId: string): Runner {
  const p = page as Parameters<typeof callWorker>[0];
  const call = (op: string, args: Record<string, unknown> = {}): Promise<unknown> => callWorker(p, op, args);
  return {
    root: "/proj",
    async init() {
      return await call("init", {
        projectId,
        env: {},
        providerConfig: { ...TEST_PROVIDER_CONFIG },
        fetchRoutes: ALL_ROUTES,
        downloads: ALL_DOWNLOADS,
        nowIso: FIXED_NOW_ISO,
      });
    },
    async callTool(name: string, args: Record<string, unknown>) {
      return await call("callTool", { name, toolArgs: args });
    },
    async writeFile(rel: string, text: string) {
      await call("writeFile", { rel, base64: Buffer.from(text, "utf8").toString("base64") });
    },
    async readBib() {
      const exp = (await call("exportProject")) as { zip: Uint8Array; files: unknown };
      const unzipped = unzipSync(new Uint8Array((exp.zip as unknown as number[]).length ? Uint8Array.from(exp.zip as unknown as number[]) : new Uint8Array(0)));
      const raw = unzipped["refs/references.bib"];
      if (!raw) throw new Error("refs/references.bib missing from exported zip");
      return Buffer.from(raw).toString("utf8");
    },
    async registryBytes() {
      return (await call("registryBytes")) as number[] | null;
    },
    async makeForeign(version: number) {
      await call("makeForeignRegistry", { version });
    },
    async exportFiles() {
      const exp = (await call("exportProject")) as { files: { path: string; size: number }[] };
      return exp.files.filter((f) => !f.path.startsWith(".registry/"));
    },
    async close() {
      await call("close", {});
    },
  };
}

// ── the shared script ───────────────────────────────────────────────────────

async function runScript(r: Runner): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  await r.init();
  out.register = normalizeForCompare(r.root, await r.callTool("registry", { action: "register", identifiers: [DOI_A, "10.1001/bbb"] }));
  out.read = normalizeForCompare(
    r.root,
    await r.callTool("registry", {
      action: "read",
      fields: ["authors", "venue", "abstract", "source", "refreshedAt", "bibtex", "bibtexSource"],
    }),
  );
  out.reregister = normalizeForCompare(
    r.root,
    await r.callTool("registry", { action: "register", identifiers: [DOI_A, "10.1001/bbb"] }),
  );
  await r.writeFile(TEI_REL, teiFixture(DOI_A, PAPERS[DOI_A].title));
  out.attach = normalizeForCompare(
    r.root,
    await r.callTool("registry", { action: "attach_source", attachments: [{ handle: DOI_A, path: TEI_REL }] }),
  );
  await r.writeFile(PDF_REL, betaPdf());
  out.attachPdf = normalizeForCompare(
    r.root,
    await r.callTool("registry", { action: "attach_source", attachments: [{ handle: DOI_B, path: PDF_REL }] }),
  );
  out.passagesPdf = normalizeForCompare(r.root, await r.callTool("passages", { query: "hit rate of the cache shared tier", limit: 5 }));
  // acquire: register an arXiv-DOI paper, fetch its open copy through the download transport, then find its text.
  out.registerArxiv = normalizeForCompare(r.root, await r.callTool("registry", { action: "register", identifiers: [DOI_ARXIV] }));
  out.acquire = normalizeForCompare(r.root, await r.callTool("registry", { action: "acquire", handles: [DOI_ARXIV] }));
  out.passagesAcquired = normalizeForCompare(r.root, await r.callTool("passages", { query: "pipeline throughput stages shared queue", limit: 5 }));
  out.syncBib = normalizeForCompare(r.root, await r.callTool("registry", { action: "sync_bibliography" }));
  out.bibText = await r.readBib();
  out.passages = normalizeForCompare(r.root, await r.callTool("passages", { query: "thermal grids", limit: 5 }));
  out.search = normalizeForCompare(r.root, await r.callTool("search", { query: "thermal grids", limit: 5 }));
  out.pathEscape = normalizeForCompare(
    r.root,
    await r.callTool("registry", { action: "attach_source", attachments: [{ handle: DOI_A, path: "../evil.pdf" }] }),
  );
  out.verifyRefusal = normalizeForCompare(
    r.root,
    await r.callTool("verify", { claim: "Cells age faster at high temperature.", papers: "all" }),
  );
  out.compileRefusal = normalizeForCompare(r.root, await r.callTool("compile", {}));
  // Foreign/newer registry LAST: every later registry open refuses.
  // Snapshot AFTER stamping the version: the stamp itself changes bytes;
  // the refused read must leave them untouched.
  await r.makeForeign(99);
  const bytesBefore = await r.registryBytes();
  out.foreignRead = normalizeForCompare(r.root, await r.callTool("registry", { action: "read" }));
  out.foreignBytesStable = JSON.stringify(await r.registryBytes()) === JSON.stringify(bytesBefore);
  out.exportFiles = await r.exportFiles();
  return out;
}

// ── browser harness ─────────────────────────────────────────────────────────

async function runInBrowser(projectId: string, fn: (r: Runner) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const root = path.resolve(import.meta.dirname, "..");
  const outdir = tmpDir("diff-tools-www-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { browser, executablePath } = await launchChromium();
  console.log(`  browser: ${executablePath}`);
  try {
    const { ctx, page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
    try {
      return await fn(makeBrowserRunner(page, projectId));
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

// ── tests ───────────────────────────────────────────────────────────────────

test("tools: Node and Chromium agree (registry/passages/search/refusals)", { timeout: 300000 }, async () => {
  const node = makeNodeRunner();
  const expected = await runScript(node);
  const actual = await runInBrowser(`tools-${Date.now().toString(36)}`, (r) => runScript(r));
  await node.close().catch(() => {});

  const KEYS = ["register", "read", "reregister", "attach", "attachPdf", "syncBib", "bibText", "passages", "passagesPdf", "registerArxiv", "acquire", "passagesAcquired", "search", "pathEscape", "compileRefusal", "exportFiles"] as const;
  let total = 0;
  for (const k of KEYS) {
    const diffs = diffResults((expected as Record<string, unknown>)[k], (actual as Record<string, unknown>)[k]);
    for (const d of diffs.slice(0, 10)) console.log(`  DIFF ${k} ${d}`);
    console.log(`  ${k}: diffs=${diffs.length}`);
    total += diffs.length;
    assert.deepEqual(diffs, [], `differential mismatch in ${k}`);
  }

  // Refusals: codes must match exactly (compile is byte-exact too: neither side
  // names an engine binary — the injected env carries no PATH and the managed
  // cache is empty — so both report the same COMPILE_ENGINE_MISSING refusal).
  const refusedCode = (r: unknown): string | undefined =>
    (r as { details?: { refused?: { code?: string } } }).details?.refused?.code;
  for (const k of ["verifyRefusal", "foreignRead"] as const) {
    const e = (expected as Record<string, unknown>)[k];
    const a = (actual as Record<string, unknown>)[k];
    assert.equal(refusedCode(a), refusedCode(e), `${k} refusal code`);
    console.log(`  ${k}: code=${refusedCode(a)} (both)`);
  }
  assert.equal((actual as Record<string, unknown>).foreignBytesStable, true, "foreign registry refused before any write");
  assert.equal((expected as Record<string, unknown>).foreignBytesStable, true, "foreign registry refused before any write (node)");

  // Statuses both sides registered/attached (not just equal-to-each-other).
  const reg = (actual.register as { structuredContent: { outcomes: { status: string }[] } }).structuredContent.outcomes;
  assert.deepEqual(reg.map((o) => o.status), ["registered", "registered"]);
  const att = (actual.attach as { structuredContent: { outcomes: { status: string }[] } }).structuredContent.outcomes;
  assert.equal(att[0].status, "attached");
  const attPdf = (actual.attachPdf as { structuredContent: { outcomes: { status: string }[] } }).structuredContent.outcomes;
  assert.equal(attPdf[0].status, "attached", "a PDF attaches in the browser worker (not misreported as malformed)");
  const pdfHits = JSON.stringify(actual.passagesPdf);
  assert.ok(pdfHits.includes(DOI_B), "passages finds the attached PDF's text in the browser");
  const regArxiv = (actual.registerArxiv as { structuredContent: { outcomes: { status: string }[] } }).structuredContent.outcomes;
  assert.equal(regArxiv[0].status, "registered", "an arXiv DOI registers through DataCite (a refusal on both sides would diff to zero and prove nothing)");
  const acq = (actual.acquire as { structuredContent: { outcomes: { status: string; source: { kind?: string } | null }[] } }).structuredContent.outcomes;
  assert.equal(acq[0].status, "ready", "acquire fetches the arXiv copy through the download transport");
  assert.equal(acq[0].source?.kind, "arxiv-pdf");
  assert.ok(JSON.stringify(actual.passagesAcquired).includes(DOI_ARXIV), "passages finds the acquired paper's text in the browser");
  assert.ok(!(JSON.stringify(actual.attach).includes("thermal cycling") && JSON.stringify(actual.attach).length < 100), "attach echoes no source text");

  console.log(`  exact-equal keys: ${KEYS.length}, total diffs: ${total}`);
});

test("tools: refusal wordings per environment", { timeout: 300000 }, async () => {
  const node = makeNodeRunner();
  const expected = await runScript(node);
  const actual = await runInBrowser(`tools-word-${Date.now().toString(36)}`, (r) => runScript(r));
  await node.close().catch(() => {});
  const text = (r: unknown): string => (r as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
  const code = (r: unknown): string | undefined => (r as { details: { refused?: { code?: string } } }).details?.refused?.code;

  // Verify/compile engine refusals: same code, engine-specific messages recorded here.
  assert.equal(code((expected as Record<string, unknown>).verifyRefusal), "VERIFY_ENGINE_MISSING");
  assert.equal(code((actual as Record<string, unknown>).verifyRefusal), "VERIFY_ENGINE_MISSING");
  console.log(`  node verify message: ${JSON.stringify(text((expected as Record<string, unknown>).verifyRefusal)).slice(0, 200)}`);
  console.log(`  browser verify message: ${JSON.stringify(text((actual as Record<string, unknown>).verifyRefusal)).slice(0, 200)}`);
  assert.equal(code((expected as Record<string, unknown>).compileRefusal), "COMPILE_ENGINE_MISSING");
  assert.equal(code((actual as Record<string, unknown>).compileRefusal), "COMPILE_ENGINE_MISSING");
  console.log(`  node compile message: ${JSON.stringify(text((expected as Record<string, unknown>).compileRefusal)).slice(0, 200)}`);
  console.log(`  browser compile message: ${JSON.stringify(text((actual as Record<string, unknown>).compileRefusal)).slice(0, 200)}`);
  assert.equal(code((expected as Record<string, unknown>).foreignRead), "REGISTRY_SCHEMA_UNSUPPORTED");
  assert.equal(code((actual as Record<string, unknown>).foreignRead), "REGISTRY_SCHEMA_UNSUPPORTED");
});

test("tools: durability across reload, second tab refused", { timeout: 300000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const outdir = tmpDir("diff-tools-durable-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { chromium } = await import("playwright-core");
  const exe = executableCandidates()[0];
  assert.ok(exe, "no cached Chromium executable");
  const profileDir = tmpDir("diff-tools-profile-");
  const projectId = `durable-${Date.now().toString(36)}`;
  const routes = registerRoutes({ [DOI_A]: PAPERS[DOI_A] });
  const initArgs = {
    projectId,
    env: {},
    providerConfig: { ...TEST_PROVIDER_CONFIG },
    fetchRoutes: routes,
    nowIso: FIXED_NOW_ISO,
  };
  const bootWorker = async (page: { evaluate(p: (u: string) => Promise<void>, u: string): Promise<void> }, workerUrl: string): Promise<void> => {
    await page.evaluate(async (workerUrl: string) => {
      const w = new Worker(workerUrl, { type: "module" });
      (window as unknown as { __worker: Worker }).__worker = w;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker boot timeout")), 30000);
        const onMsg = (ev: MessageEvent): void => {
          if (ev.data && (ev.data as { boot?: unknown }).boot) {
            clearTimeout(timer);
            w.removeEventListener("message", onMsg);
            if ((ev.data as { ok?: boolean }).ok) resolve();
            else reject(new Error((ev.data as { error?: string }).error));
          }
        };
        w.addEventListener("message", onMsg);
      });
    }, workerUrl);
  };
  const workerUrl = `${server.url}/worker.js`;
  try {
    // Session 1: register, then die WITHOUT close (no shutdown hook).
    {
      const browser = await chromium.launchPersistentContext(profileDir, { executablePath: exe, headless: true, args: ["--no-sandbox"] });
      const page = await browser.newPage();
      await page.goto(`${server.url}/page.html`, { waitUntil: "load" });
      await bootWorker(page, workerUrl);
      const call = (op: string, args: Record<string, unknown> = {}): Promise<unknown> => callWorker(page as never, op, args);
      assert.deepEqual((await call("init", initArgs)) as unknown, { ok: true });
      const reg = (await call("callTool", { name: "registry", toolArgs: { action: "register", identifiers: [DOI_A] } })) as {
        structuredContent: { outcomes: { status: string }[] };
      };
      assert.deepEqual(reg.structuredContent.outcomes.map((o) => o.status), ["registered"]);
      await browser.close();
      console.log("  session 1: registered, killed without close");
    }
    // Session 2: same profile, same project — data survives, lock is free.
    {
      const browser = await chromium.launchPersistentContext(profileDir, { executablePath: exe, headless: true, args: ["--no-sandbox"] });
      try {
        const page = await browser.newPage();
        await page.goto(`${server.url}/page.html`, { waitUntil: "load" });
        await bootWorker(page, workerUrl);
        const call = (op: string, args: Record<string, unknown> = {}): Promise<unknown> => callWorker(page as never, op, args);
        assert.deepEqual((await call("init", initArgs)) as unknown, { ok: true });
        const read = (await call("callTool", { name: "registry", toolArgs: { action: "read" } })) as {
          structuredContent: { total: number; records: { doi: string }[] };
        };
        assert.equal(read.structuredContent.total, 1);
        assert.equal(read.structuredContent.records[0].doi, DOI_A);
        console.log("  session 2: read after reopen returns the registered paper");
        // Second tab: same project while the first worker holds it — refused.
        const page2 = await browser.newPage();
        await page2.goto(`${server.url}/page.html`, { waitUntil: "load" });
        await bootWorker(page2, workerUrl);
        const init2 = (await callWorker(page2 as never, "init", initArgs)) as { ok: boolean; reason?: string };
        assert.deepEqual(init2, { ok: false, reason: "open-in-another-tab" });
        console.log("  second tab: refused open-in-another-tab");
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});

test("tools: registry before init refuses with the browser cliCommand wording", { timeout: 300000 }, async () => {
  // Node side: bare temp dir, no registry.
  const node = makeNodeRunner();
  const nodeRes = (await node.callTool("registry", { action: "read" })) as { details: { refused?: { code?: string } }; content: { text: string }[] };
  const nodeText = nodeRes.content.map((c) => c.text).join("\n");
  assert.equal(nodeRes.details?.refused?.code, "REGISTRY_NOT_INITIALIZED");

  // Browser side: fresh worker, callTool before init.
  const root = path.resolve(import.meta.dirname, "..");
  const outdir = tmpDir("diff-tools-pre-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { browser } = await launchChromium();
  try {
    const { ctx, page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
    try {
      const res = (await callWorker(page, "callTool", { name: "registry", toolArgs: { action: "read" } })) as typeof nodeRes;
      assert.equal(res.details?.refused?.code, "REGISTRY_NOT_INITIALIZED");
      const text = res.content.map((c) => c.text).join("\n");
      assert.match(text, /the app's "init" action/, "browser cliCommand wording");
      console.log(`  node: ${JSON.stringify(nodeText).slice(0, 160)}`);
      console.log(`  browser: ${JSON.stringify(text).slice(0, 160)}`);
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  await node.close().catch(() => {});
});

test("tools: bundled schema.sql equals the repo file through the core code path", { timeout: 300000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const expected = fs.readFileSync(path.join(root, "src/core/schema.sql"), "utf8");
  const outdir = tmpDir("diff-tools-asset-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { browser } = await launchChromium();
  try {
    const { ctx, page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
    try {
      // The exact call the core makes: readFileSync(new URL("./schema.sql", import.meta.url), "utf8").
      const actual = (await callWorker(page, "readAsset", { path: "/__uktub__/src/core/schema.sql" })) as string;
      assert.equal(actual, expected, "schema.sql bytes equal through readFileSync");
      console.log(`  schema.sql bytes: ${expected.length} (equal)`);
      // Writes refused, directory lists, missing names 404.
      const probe = await page.evaluate(async () => {
        const w = (window as unknown as { __worker: Worker }).__worker;
        const send = (op: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
          new Promise((resolve) => {
            const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            const onMsg = (ev: MessageEvent): void => {
              const m = ev.data as { id?: string; ok?: boolean; result?: unknown; error?: string };
              if (m && m.id === id) {
                w.removeEventListener("message", onMsg);
                resolve({ ok: m.ok === true, result: m.result, error: m.error });
              }
            };
            w.addEventListener("message", onMsg);
            w.postMessage({ id, op, args });
          });
        return await send("readAsset", { path: "/__uktub__/src/core/missing.sql" });
      });
      assert.equal(probe.ok, false);
      assert.match(String(probe.error), /ENOENT/);
      console.log(`  missing asset: ${JSON.stringify(probe.error)?.slice(0, 120)}`);
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
