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
import { unzipSync, zipSync } from "fflate";

import { makePdf } from "../tests/helpers/pdf.ts";
import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry } from "../src/core/registry.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import { paperRegistryTool } from "../src/core/tools/registry.ts";
import { searchPassagesTool } from "../src/core/tools/passages.ts";
import { searchPapersTool } from "../src/core/tools/search.ts";
import { verifyClaimTool } from "../src/core/tools/verify.ts";
import { compileDocumentTool } from "../src/core/tools/compile.ts";
import { doctorTool } from "../src/core/tools/doctor.ts";
import { runProvenance } from "../src/core/provenance/run.ts";
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
  provenance(entry?: string): Promise<unknown>;
  writeFile(rel: string, text: string): Promise<void>;
  readBib(): Promise<string>;
  registryBytes(): Promise<number[] | null>;
  makeForeign(version: number): Promise<void>;
  exportFiles(): Promise<{ path: string; size: number }[]>;
  close(): Promise<void>;
}

function nodeCtx(root: string, cacheDir: string, extraEnv: Record<string, string | undefined> = {}, routes: CannedRoute[] = ALL_ROUTES): ToolContext {
  return {
    root,
    fetch: buildCannedFetch(routes),
    download: buildCannedDownload(ALL_DOWNLOADS),
    // Point the managed-embedding cache at an empty dir: no embedder is
    // installed there, so both sides resolve to clean lexical-only search
    // (the decided browser behavior) instead of the machine's home cache.
    env: { UKTUB_CACHE_DIR: cacheDir, ...extraEnv },
    now: () => new Date(FIXED_NOW_ISO),
    queue: new WriteQueue(),
    providerConfig: TEST_PROVIDER_CONFIG,
  };
}

function makeNodeRunner(opts: { env?: Record<string, string | undefined>; routes?: CannedRoute[] } = {}): Runner & { dir: string } {
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
      const ctx = nodeCtx(dir, cacheDir, opts.env, opts.routes);
      switch (name) {
        case "registry":
          return await paperRegistryTool(ctx, args as never);
        case "passages":
          return await searchPassagesTool(ctx, args as never);
        case "papers":
        case "search":
          return await searchPapersTool(ctx, args as never);
        case "verify":
          return await verifyClaimTool(ctx, args as never);
        case "compile":
          return await compileDocumentTool(ctx, args as never);
        case "doctor":
          return await doctorTool(ctx, args as never);
        default:
          throw new Error(`unknown tool ${name}`);
      }
    },
    async provenance(entry?: string) {
      const ctx = nodeCtx(dir, cacheDir, opts.env, opts.routes);
      return runProvenance({
        root: ctx.root,
        ...(entry !== undefined ? { entry } : {}),
        now: ctx.now,
        env: ctx.env,
      });
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

function makeBrowserRunner(page: unknown, projectId: string, opts: { env?: Record<string, string | undefined>; routes?: CannedRoute[] } = {}): Runner {
  const p = page as Parameters<typeof callWorker>[0];
  const call = (op: string, args: Record<string, unknown> = {}): Promise<unknown> => callWorker(p, op, args);
  return {
    root: "/proj",
    async init() {
      return await call("init", {
        projectId,
        env: opts.env ?? {},
        providerConfig: { ...TEST_PROVIDER_CONFIG },
        fetchRoutes: opts.routes ?? ALL_ROUTES,
        downloads: ALL_DOWNLOADS,
        nowIso: FIXED_NOW_ISO,
      });
    },
    async callTool(name: string, args: Record<string, unknown>) {
      return await call("callTool", { name, toolArgs: args });
    },
    async provenance(entry?: string) {
      return await call("provenance", entry !== undefined ? { entry } : {});
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

  const KEYS = ["register", "read", "reregister", "attach", "attachPdf", "syncBib", "bibText", "passages", "passagesPdf", "registerArxiv", "acquire", "passagesAcquired", "search", "pathEscape", "exportFiles"] as const;
  let total = 0;
  for (const k of KEYS) {
    const diffs = diffResults((expected as Record<string, unknown>)[k], (actual as Record<string, unknown>)[k]);
    for (const d of diffs.slice(0, 10)) console.log(`  DIFF ${k} ${d}`);
    console.log(`  ${k}: diffs=${diffs.length}`);
    total += diffs.length;
    assert.deepEqual(diffs, [], `differential mismatch in ${k}`);
  }

  // Refusals: codes must match exactly. verifyRefusal and foreignRead stay
  // byte-exact across hosts; compileRefusal keeps code+message but renders a
  // host-specific `Next:` (Phase 9a), asserted separately below.
  const refusedCode = (r: unknown): string | undefined =>
    (r as { details?: { refused?: { code?: string } } }).details?.refused?.code;
  const refusedText = (r: unknown): string =>
    (r as { content?: { text: string }[] }).content?.map((c) => c.text).join("\n") ?? "";
  for (const k of ["verifyRefusal", "foreignRead"] as const) {
    const e = (expected as Record<string, unknown>)[k];
    const a = (actual as Record<string, unknown>)[k];
    assert.equal(refusedCode(a), refusedCode(e), `${k} refusal code`);
    console.log(`  ${k}: code=${refusedCode(a)} (both)`);
  }
  // Phase 9a host-specific remedies: the compile refusal keeps the same code
  // and message on both hosts, but each host renders its own `Next:` (Node
  // names the tectonic install; the browser names the page reload).
  {
    const e = (expected as Record<string, unknown>).compileRefusal;
    const a = (actual as Record<string, unknown>).compileRefusal;
    assert.equal(refusedCode(a), "COMPILE_ENGINE_MISSING", "browser compile refusal code");
    assert.equal(refusedCode(e), "COMPILE_ENGINE_MISSING", "node compile refusal code");
    assert.match(refusedText(a), /reload the page/, "browser compile refusal names the browser remedy");
    assert.match(refusedText(e), /uktub-scholar tectonic install/, "node compile refusal keeps the Node remedy");
    const beforeNext = (t: string): string => t.slice(0, t.indexOf(" Next: "));
    assert.ok(refusedText(a).includes(" Next: ") && refusedText(e).includes(" Next: "), "both hosts render a Next: hint");
    assert.equal(beforeNext(refusedText(a)), beforeNext(refusedText(e)), "code and message are byte-identical across hosts; only Next: differs");
    console.log(`  compileRefusal: code=COMPILE_ENGINE_MISSING (both), host-specific Next`);
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

const HOSTED_VERIFY_ROUTES: CannedRoute[] = [
  ...ALL_ROUTES,
  { match: "decision.vllm-sr.ai/v1/models", status: 404, body: "not found" },
  {
    match: "decision.vllm-sr.ai/v1/systemone",
    status: 200,
    body: JSON.stringify({ model: "vllm-sr/d3-mini", answers: { c: { noul: 0.995 } } }),
  },
];

async function runWorkflowScript(r: Runner): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  await r.init();
  out.doctorEmpty = normalizeForCompare(r.root, await r.callTool("doctor", {}));
  // Exercise the canonical MCP tool name "papers" (as well as "search" in runScript).
  out.search = normalizeForCompare(r.root, await r.callTool("papers", { query: "thermal grids", limit: 5 }));
  out.register = normalizeForCompare(
    r.root,
    await r.callTool("registry", { action: "register", identifiers: [DOI_A, DOI_B, DOI_ARXIV] }),
  );
  out.acquire = normalizeForCompare(r.root, await r.callTool("registry", { action: "acquire", handles: [DOI_ARXIV] }));
  await r.writeFile(TEI_REL, teiFixture(DOI_A, PAPERS[DOI_A].title));
  await r.writeFile(PDF_REL, betaPdf());
  out.attach = normalizeForCompare(
    r.root,
    await r.callTool("registry", {
      action: "attach_source",
      attachments: [
        { handle: DOI_A, path: TEI_REL },
        { handle: DOI_B, path: PDF_REL },
      ],
    }),
  );
  out.syncBib = normalizeForCompare(r.root, await r.callTool("registry", { action: "sync_bibliography" }));
  out.passages = normalizeForCompare(
    r.root,
    await r.callTool("passages", { query: "pipeline throughput stages shared queue", limit: 5 }),
  );
  out.verifyClaim = normalizeForCompare(
    r.root,
    await r.callTool("verify", {
      claim: "Pipeline throughput scales with the number of independent stages in the shared queue.",
      papers: [DOI_ARXIV],
    }),
  );
  out.verifyDocument = normalizeForCompare(
    r.root,
    await r.callTool("verify", {
      text: "Pipeline throughput scales with the number of independent stages in the shared queue \\cite{holder2025gamma}. Cache eviction under sustained heat degrades the hit rate of the shared tier \\cite{holder2024beta}.",
    }),
  );
  // Multi-file manuscript with \input + project result CSV for document-mode file verify and provenance audit.
  await r.writeFile(
    "manuscript/sections/intro.tex",
    "Pipeline throughput scales with the number of independent stages in the shared queue \\cite{holder2025gamma}.\n" +
      "Cache eviction under sustained heat degrades the hit rate of the shared tier \\cite{holder2024beta}.\n",
  );
  await r.writeFile(
    "manuscript/main.tex",
    "\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\n\\input{sections/intro}\n\\section{Results}\nIn our local benchmark run, the measured queue drain accuracy was 93.7\\% with 42.75 GB peak memory.\n\\end{document}\n",
  );
  await r.writeFile("results/bench.csv", "metric,accuracy,memory\nqueue_drain,93.7%,42.75 GB\n");
  out.verifyDocumentFile = normalizeForCompare(
    r.root,
    await r.callTool("verify", { document: "manuscript/main.tex" }),
  );
  out.provenance = normalizeForCompare(r.root, await r.provenance("manuscript/main.tex"));
  out.doctorReady = normalizeForCompare(r.root, await r.callTool("doctor", {}));
  out.exportFiles = await r.exportFiles();
  return out;
}

test("workflow: static-browser end-to-end research workflow (doctor, search, register, acquire, attach, passages, hosted verify claim+document, cancellation, reload persistence, export)", { timeout: 300000 }, async () => {
  const wfEnv = { UKTUB_VERIFY_API_KEY: "test-hosted-key" };
  const node = makeNodeRunner({ env: wfEnv, routes: HOSTED_VERIFY_ROUTES });
  const expected = await runWorkflowScript(node);

  const root = path.resolve(import.meta.dirname, "..");
  const outdir = tmpDir("diff-workflow-www-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { chromium } = await import("playwright-core");
  const exe = executableCandidates()[0];
  assert.ok(exe, "no cached Chromium executable");
  const profileDir = tmpDir("diff-workflow-profile-");
  const projectId = `wf-${Date.now().toString(36)}`;
  const workerUrl = `${server.url}/worker.js`;

  const bootWorker = async (page: { evaluate(p: (u: string) => Promise<void>, u: string): Promise<void> }): Promise<void> => {
    await page.evaluate(async (u: string) => {
      const w = new Worker(u, { type: "module" });
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

  try {
    let actual: Record<string, unknown>;
    // Session 1: run full differential workflow + in-flight cancellation, then close without host close().
    {
      const browser = await chromium.launchPersistentContext(profileDir, { executablePath: exe, headless: true, args: ["--no-sandbox"] });
      try {
        const page = await browser.newPage();
        await page.goto(`${server.url}/page.html`, { waitUntil: "load" });
        await bootWorker(page);
        actual = await runWorkflowScript(makeBrowserRunner(page, projectId, { env: wfEnv, routes: HOSTED_VERIFY_ROUTES }));
      } finally {
        await browser.close();
      }
    }

    const KEYS = [
      "doctorEmpty",
      "search",
      "register",
      "acquire",
      "attach",
      "syncBib",
      "passages",
      "verifyClaim",
      "verifyDocument",
      "verifyDocumentFile",
      "provenance",
      "doctorReady",
      "exportFiles",
    ] as const;
    for (const k of KEYS) {
      const diffs = diffResults(expected[k], actual[k]);
      for (const d of diffs.slice(0, 10)) console.log(`  WF DIFF ${k} ${d}`);
      assert.deepEqual(diffs, [], `workflow differential mismatch in ${k}`);
    }

    const docReady = (actual.doctorReady as { structuredContent: { checks: { name: string; status: string; detail: string }[] } }).structuredContent.checks;
    assert.equal(docReady.find((c) => c.name === "verification")?.status, "ok", "doctor verification check ok in browser");
    assert.equal(docReady.find((c) => c.name === "registry")?.status, "ok", "doctor registry check ok in browser");
    assert.match(
      docReady.find((c) => c.name === "registry")?.detail ?? "",
      /3 paper\(s\), 3 with a ready source; 2 computed figure\(s\) from project result files/,
    );

    const prov = actual.provenance as {
      ok: boolean;
      entry: string;
      audit: { summary: { verified: number; figures: { computed: number } } };
    };
    assert.equal(prov.ok, true);
    assert.equal(prov.entry, "manuscript/main.tex");
    assert.equal(prov.audit.summary.verified, 2, "provenance sees 2 verified statements from claim_ledger");
    assert.equal(prov.audit.summary.figures.computed, 2, "provenance matches 93.7% and 42.75 GB against results/bench.csv");

    const vClaim = (actual.verifyClaim as { structuredContent: { result: { supportFound: boolean; searched: string }; coverage: { work: { complete: boolean } }; evidence: unknown[] } }).structuredContent;
    assert.equal(vClaim.result.supportFound, true);
    assert.equal(vClaim.result.searched, "candidate_limited");
    assert.ok(vClaim.evidence.length >= 1, "claim mode returned supporting evidence");
    assert.equal(vClaim.coverage.work.complete, true);

    const vDoc = (actual.verifyDocument as { structuredContent: { summary: { total: number; supported: number }; units: { status: string }[]; next: number | null } }).structuredContent;
    assert.equal(vDoc.summary.total, 2);
    assert.equal(vDoc.summary.supported, 2);
    assert.equal(vDoc.next, null);
    assert.deepEqual(vDoc.units.map((u) => u.status), ["supported", "supported"]);

    const vDocFile = (actual.verifyDocumentFile as { structuredContent: { source: string; summary: { total: number; supported: number }; units: { file: string; line: number; status: string }[] } }).structuredContent;
    assert.equal(vDocFile.source, "manuscript/main.tex");
    assert.equal(vDocFile.summary.total, 3);
    assert.equal(vDocFile.summary.supported, 2);
    assert.deepEqual(
      vDocFile.units.map((u) => `${u.file}:${u.line}`),
      ["manuscript/sections/intro.tex:1", "manuscript/sections/intro.tex:2", "manuscript/main.tex:6"],
    );

    // Session 2: reopen same project after reload — verify persistence, cached judgment reuse, in-flight cancellation, and exportProject.
    {
      const slowRoutes: CannedRoute[] = [
        ...ALL_ROUTES,
        { match: "decision.vllm-sr.ai/v1/models", status: 404, body: "not found" },
        {
          match: "decision.vllm-sr.ai/v1/systemone",
          status: 200,
          delayMs: 5000,
          body: JSON.stringify({ model: "vllm-sr/d3-mini", answers: { c: { noul: 0.995 } } }),
        },
      ];
      const browser = await chromium.launchPersistentContext(profileDir, { executablePath: exe, headless: true, args: ["--no-sandbox"] });
      try {
        const page = await browser.newPage();
        await page.goto(`${server.url}/page.html`, { waitUntil: "load" });
        await bootWorker(page);
        const call = (op: string, args: Record<string, unknown> = {}): Promise<unknown> => callWorker(page as never, op, args);
        assert.deepEqual(
          await call("init", {
            projectId,
            env: wfEnv,
            providerConfig: { ...TEST_PROVIDER_CONFIG },
            fetchRoutes: slowRoutes,
            downloads: ALL_DOWNLOADS,
            nowIso: FIXED_NOW_ISO,
          }),
          { ok: true },
        );

        // Cached judgment from Session 1 is reused from OPFS SQLite without hitting the 5000ms network route.
        const tReuse0 = Date.now();
        const reused = (await call("callTool", {
          name: "verify",
          toolArgs: {
            claim: "Pipeline throughput scales with the number of independent stages in the shared queue.",
            papers: [DOI_ARXIV],
          },
        })) as { structuredContent: { result: { supportFound: boolean }; coverage: { work: { cached: number; fresh: number } } } };
        assert.equal(reused.structuredContent.result.supportFound, true);
        assert.ok(reused.structuredContent.coverage.work.cached >= 1, "reopened session reused persisted SQLite judgments");
        assert.equal(reused.structuredContent.coverage.work.fresh, 0, "no fresh judgment needed on reopen");
        assert.ok(Date.now() - tReuse0 < 2000, "cached judgment reuse did not wait on slow network route");

        // In-flight cancellation: start fresh uncached verify calls (hitting 5000ms route), then cancel via cancelTool.
        const cancelProbe = await page.evaluate(async (doiArxiv: string) => {
          const w = (window as unknown as { __worker: Worker }).__worker;
          const rpc = (id: string, op: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: any; error?: string }> =>
            new Promise((resolve) => {
              const onMsg = (ev: MessageEvent): void => {
                const m = ev.data as { id?: string; ok?: boolean; result?: any; error?: string };
                if (m && m.id === id) {
                  w.removeEventListener("message", onMsg);
                  resolve({ ok: m.ok === true, result: m.result, error: m.error });
                }
              };
              w.addEventListener("message", onMsg);
              w.postMessage({ id, op, args });
            });
          const runCancelled = async (callId: string, toolArgs: Record<string, unknown>) => {
            const t0 = Date.now();
            const verifyPromise = rpc(callId, "callTool", { callId, name: "verify", toolArgs });
            await new Promise((r) => setTimeout(r, 120));
            const cancelReply = await rpc(`${callId}-cancel`, "cancelTool", { callId });
            const verifyReply = await verifyPromise;
            return { cancelReply, verifyReply, elapsedMs: Date.now() - t0 };
          };
          const claimCancel = await runCancelled("cancel-verify-claim", {
            claim: "Stage latency dominated the end to end delay of the pipeline in every measured run.",
            papers: [doiArxiv],
          });
          const docCancel = await runCancelled("cancel-verify-doc", {
            text: "Stage latency dominated the end to end delay of the pipeline in every measured run \\cite{holder2025gamma}.",
          });
          // Cancelling an unknown or already-settled callId returns { cancelled: false }.
          const cancelUnknown = await rpc("cancel-unknown", "cancelTool", { callId: "nonexistent-call-id" });
          const cancelSettled = await rpc("cancel-settled", "cancelTool", { callId: "cancel-verify-claim" });

          // Concurrent call isolation: cancelling one slow verify call does not disturb a concurrent passages call.
          const tIso = Date.now();
          const slowVerifyP = rpc("iso-slow-verify", "callTool", {
            callId: "iso-slow-verify",
            name: "verify",
            toolArgs: {
              claim: "Stage latency dominated the end to end delay of the pipeline in every measured run.",
              papers: [doiArxiv],
            },
          });
          const fastPassagesP = rpc("iso-fast-passages", "callTool", {
            callId: "iso-fast-passages",
            name: "passages",
            toolArgs: { query: "throughput", papers: [doiArxiv], limit: 3 },
          });
          await new Promise((r) => setTimeout(r, 120));
          const isoCancelReply = await rpc("iso-cancel-req", "cancelTool", { callId: "iso-slow-verify" });
          const [slowVerifyRes, fastPassagesRes] = await Promise.all([slowVerifyP, fastPassagesP]);
          return {
            claimCancel,
            docCancel,
            cancelUnknown,
            cancelSettled,
            isolation: { isoCancelReply, slowVerifyRes, fastPassagesRes, elapsedMs: Date.now() - tIso },
          };
        }, DOI_ARXIV);

        assert.equal(cancelProbe.claimCancel.cancelReply.ok, true);
        assert.deepEqual(cancelProbe.claimCancel.cancelReply.result, { cancelled: true });
        assert.equal(cancelProbe.claimCancel.verifyReply.ok, true, "cancelled claim verify settled cleanly");
        assert.ok(
          cancelProbe.claimCancel.elapsedMs < 2500,
          `cancelled claim verify settled in ${cancelProbe.claimCancel.elapsedMs}ms (< 2500ms, vs 5000ms route delay)`,
        );
        const claimCancelledText = (cancelProbe.claimCancel.verifyReply.result.content as { text: string }[]).map((c) => c.text).join("\n");
        assert.match(claimCancelledText, /INTERRUPTED \(cancelled\): the request was cancelled/);
        assert.equal(cancelProbe.claimCancel.verifyReply.result.structuredContent.result.complete, false);
        assert.equal(cancelProbe.claimCancel.verifyReply.result.structuredContent.coverage.work.interruption.reason, "cancelled");
        assert.equal(cancelProbe.claimCancel.verifyReply.result.structuredContent.coverage.work.fresh, 0, "cancelled claim cached nothing");
        const continuationToken = cancelProbe.claimCancel.verifyReply.result.structuredContent.continuation as string | null;
        assert.equal(typeof continuationToken, "string", "interrupted claim verification issued a v3 continuation token");

        assert.equal(cancelProbe.docCancel.cancelReply.ok, true);
        assert.deepEqual(cancelProbe.docCancel.cancelReply.result, { cancelled: true });
        assert.equal(cancelProbe.docCancel.verifyReply.ok, true, "cancelled document verify settled cleanly");
        assert.ok(
          cancelProbe.docCancel.elapsedMs < 2500,
          `cancelled document verify settled in ${cancelProbe.docCancel.elapsedMs}ms (< 2500ms, vs 5000ms route delay)`,
        );
        assert.deepEqual(cancelProbe.docCancel.verifyReply.result.details, {
          thrown: true,
          tool: "verify",
          message: "the request was cancelled",
        });

        assert.deepEqual(cancelProbe.cancelUnknown.result, { cancelled: false });
        assert.deepEqual(cancelProbe.cancelSettled.result, { cancelled: false });
        assert.deepEqual(cancelProbe.isolation.isoCancelReply.result, { cancelled: true });
        assert.ok(cancelProbe.isolation.elapsedMs < 2500, "isolated slow verify cancelled promptly");
        assert.equal(cancelProbe.isolation.slowVerifyRes.result.structuredContent.coverage.work.interruption.reason, "cancelled");
        assert.equal(cancelProbe.isolation.fastPassagesRes.ok, true, "concurrent passages call succeeded unaffected");
        assert.ok(
          (cancelProbe.isolation.fastPassagesRes.result.structuredContent.hits as unknown[]).length >= 1,
          "concurrent passages call returned matching chunks",
        );

        // Export project after reopen: zip + SQLite registry bytes.
        const exported = (await call("exportProject")) as {
          files: { path: string; size: number }[];
          zip: Record<string, number> | number[];
          registry: Record<string, number> | number[] | null;
        };
        assert.ok(exported.files.some((f) => f.path === "refs/references.bib"), "exported files list refs/references.bib");
        const zipBytes = Uint8Array.from(Object.values(exported.zip));
        const unzipped = unzipSync(zipBytes);
        assert.ok(unzipped["refs/references.bib"] && unzipped["refs/references.bib"].length > 0, "exported zip contains refs/references.bib");
        assert.ok(exported.registry !== null, "exported project includes .registry/registry.db bytes");
        const regBytes = Uint8Array.from(Object.values(exported.registry!));
        assert.equal(Buffer.from(regBytes.slice(0, 15)).toString("utf8"), "SQLite format 3", "exported registry bytes have SQLite header");

        // Session 3 (reload): resume the interrupted claim verification's v3 continuation token from OPFS SQLite on fast routes.
        await browser.close();
        const browser3 = await chromium.launchPersistentContext(profileDir, { executablePath: exe, headless: true, args: ["--no-sandbox"] });
        try {
          const page3 = await browser3.newPage();
          await page3.goto(`${server.url}/page.html`, { waitUntil: "load" });
          await bootWorker(page3);
          const call3 = (op: string, args: Record<string, unknown> = {}): Promise<unknown> => callWorker(page3 as never, op, args);
          assert.deepEqual(
            await call3("init", {
              projectId,
              env: wfEnv,
              providerConfig: { ...TEST_PROVIDER_CONFIG },
              fetchRoutes: HOSTED_VERIFY_ROUTES,
              downloads: ALL_DOWNLOADS,
              nowIso: FIXED_NOW_ISO,
            }),
            { ok: true },
          );
          // Mismatched scope on continuation is refused with CONTINUATION_INVALID before any new judgment.
          const badCont = (await call3("callTool", {
            name: "verify",
            toolArgs: {
              claim: "Stage latency dominated the end to end delay of the pipeline in every measured run.",
              papers: "all",
              continuation: continuationToken!,
            },
          })) as { details?: { refused?: { code: string } } };
          assert.equal(badCont.details?.refused?.code, "CONTINUATION_INVALID");

          // Valid continuation resumes the frozen candidate from OPFS SQLite and completes.
          const resumed = (await call3("callTool", {
            name: "verify",
            toolArgs: {
              claim: "Stage latency dominated the end to end delay of the pipeline in every measured run.",
              papers: [DOI_ARXIV],
              continuation: continuationToken!,
            },
          })) as {
            structuredContent: {
              result: { supportFound: boolean; searched: string };
              coverage: { work: { fresh: number; complete: boolean; interruption: unknown } };
              continuation: string | null;
            };
          };
          assert.equal(resumed.structuredContent.coverage.work.complete, true, "resumed continuation completed work after worker reload");
          assert.equal(resumed.structuredContent.coverage.work.interruption, null);
          assert.equal(resumed.structuredContent.result.supportFound, true, "resumed continuation found support on fast route");
          assert.equal(resumed.structuredContent.coverage.work.fresh, 1, "resumed continuation judged the 1 remaining candidate");
          assert.equal(resumed.structuredContent.continuation, null, "no further continuation needed after completing work");
        } finally {
          await browser3.close();
        }
      } finally {
        await browser.close().catch(() => {});
      }
    }
  } finally {
    await node.close().catch(() => {});
    await server.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});

test("tools: browser worker openrouter engine + doctor probe error diagnosis", { timeout: 120000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const outdir = tmpDir("diff-openrouter-www-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { browser, executablePath } = await launchChromium();
  try {
    // 1. OpenRouter engine in browser worker: doctor + direct-passage verify over ctx.fetch.
    {
      const { ctx, page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
      try {
        const call = (op: string, args: Record<string, unknown> = {}): Promise<unknown> => callWorker(page, op, args);
        assert.deepEqual(
          await call("init", {
            projectId: "proj-openrouter",
            env: {
              UKTUB_VERIFY_ENGINE: "openrouter",
              OPENROUTER_API_KEY: "test-or-key",
              UKTUB_OPENROUTER_API_KEY: "test-or-key",
              UKTUB_OPENROUTER_MODEL: "inception/mercury-decide",
            },
            providerConfig: { ...TEST_PROVIDER_CONFIG },
            fetchRoutes: [
              ...ALL_ROUTES,
              {
                match: "openrouter.ai/api/alpha/decisions",
                status: 200,
                body: JSON.stringify({ answers: { c: { noul: 0.995 } } }),
              },
            ],
            nowIso: FIXED_NOW_ISO,
          }),
          { ok: true },
        );
        const doc = (await call("callTool", { name: "doctor", toolArgs: {} })) as {
          structuredContent: { checks: { name: string; status: string; detail: string }[] };
        };
        const vCheck = doc.structuredContent.checks.find((c) => c.name === "verification");
        assert.equal(vCheck?.status, "ok");
        assert.match(vCheck?.detail ?? "", /engine openrouter: key present/);

        const vDirect = (await call("callTool", {
          name: "verify",
          toolArgs: {
            claim: "The experiment uses three antennas.",
            passages: [{ text: "In all trials, the experiment uses three antennas on the receiver array." }],
          },
        })) as { structuredContent: { engine: { name: string; model: string }; result: { supportFound: boolean; complete: boolean } } };
        assert.equal(vDirect.structuredContent.engine.name, "openrouter");
        assert.equal(vDirect.structuredContent.engine.model, "openrouter:inception/mercury-decide");
        assert.equal(vDirect.structuredContent.result.supportFound, true);
        assert.equal(vDirect.structuredContent.result.complete, true);

        // P7: `papers` and `search` alias return identical structured results.
        const papersRes = (await call("callTool", {
          name: "papers",
          toolArgs: { query: "attention", limit: 2, providers: ["openalex"] },
        })) as { structuredContent: unknown };
        const searchRes = (await call("callTool", {
          name: "search",
          toolArgs: { query: "attention", limit: 2, providers: ["openalex"] },
        })) as { structuredContent: unknown };
        assert.deepEqual(papersRes.structuredContent, searchRes.structuredContent);

        // Host file-store RPC ops (writeFile with text/base64, readFile, listFiles, deleteFile) + ownership guards.
        const written = (await call("writeFile", { rel: "manuscript/notes.tex", text: "Hello \\textbf{world}.\n" })) as {
          path: string;
          bytes: number;
        };
        assert.equal(written.path, "manuscript/notes.tex");
        assert.equal(written.bytes, 22);
        const readBack = (await call("readFile", { rel: "manuscript/notes.tex", encoding: "utf8" })) as {
          path: string;
          bytes: number;
          text: string;
        };
        assert.equal(readBack.text, "Hello \\textbf{world}.\n");
        const listed = (await call("listFiles", {})) as { files: { path: string; size: number }[] };
        assert.deepEqual(listed.files, [
          { path: "manuscript/notes.tex", size: 22 },
          { path: "refs/references.bib", size: 77 },
        ]);
        const bibRead = (await call("readFile", { rel: "refs/references.bib", encoding: "utf8" })) as {
          path: string;
          bytes: number;
          text: string;
        };
        assert.equal(bibRead.path, "refs/references.bib");
        assert.equal(bibRead.bytes, 77);

        // P4: overwrite updates file content and size; deleting a directory is explicitly refused.
        const overwritten = (await call("writeFile", { rel: "manuscript/notes.tex", text: "Updated v2\n" })) as {
          path: string;
          bytes: number;
        };
        assert.equal(overwritten.bytes, 11);
        const readOverwritten = (await call("readFile", { rel: "manuscript/notes.tex", encoding: "utf8" })) as {
          bytes: number;
          text: string;
        };
        assert.equal(readOverwritten.text, "Updated v2\n");
        assert.equal(readOverwritten.bytes, 11);
        await assert.rejects(() => call("deleteFile", { rel: "manuscript" }), /refused:.*directory/i);

        const deleted = (await call("deleteFile", { rel: "manuscript/notes.tex" })) as { deleted: boolean };
        assert.equal(deleted.deleted, true);
        const deletedAgain = (await call("deleteFile", { rel: "manuscript/notes.tex" })) as { deleted: boolean };
        assert.equal(deletedAgain.deleted, false);

        // P5: binary base64 round-trip, lossy UTF-8 replacement on non-UTF-8 bytes, and 0-byte empty file.
        await call("writeFile", { rel: "papers/blob.bin", base64: "AP/+QQ==" }); // [0x00, 0xff, 0xfe, 0x41]
        const blobB64 = (await call("readFile", { rel: "papers/blob.bin", encoding: "base64" })) as {
          path: string;
          bytes: number;
          base64: string;
        };
        assert.equal(blobB64.bytes, 4);
        assert.equal(blobB64.base64, "AP/+QQ==");
        const blobUtf8 = (await call("readFile", { rel: "papers/blob.bin", encoding: "utf8" })) as {
          bytes: number;
          text: string;
        };
        assert.equal(blobUtf8.bytes, 4);
        assert.ok(blobUtf8.text.includes("\uFFFD"), "invalid UTF-8 bytes decode with U+FFFD replacement");
        await call("deleteFile", { rel: "papers/blob.bin" });

        await call("writeFile", { rel: "manuscript/empty.tex", text: "" });
        const emptyRead = (await call("readFile", { rel: "manuscript/empty.tex", encoding: "utf8" })) as {
          bytes: number;
          text: string;
        };
        assert.equal(emptyRead.bytes, 0);
        assert.equal(emptyRead.text, "");
        await call("deleteFile", { rel: "manuscript/empty.tex" });

        // P7: provenance over missing entry or broken \input returns a structured outcome cleanly without throwing.
        const provMissing = (await call("provenance", { entry: "manuscript/no-such-main.tex" })) as {
          ok: boolean;
          message?: string;
        };
        assert.equal(provMissing.ok, false);
        assert.match(provMissing.message ?? "", /could not be read|entry|missing|not found/i);

        await call("writeFile", { rel: "manuscript/broken-include.tex", text: "\\documentclass{article}\n\\begin{document}\n\\input{manuscript/missing-child}\n\\end{document}\n" });
        const provBroken = (await call("provenance", { entry: "manuscript/broken-include.tex" })) as {
          ok: boolean;
          entry?: string;
        };
        assert.equal(typeof provBroken.ok, "boolean");
        await call("deleteFile", { rel: "manuscript/broken-include.tex" });

        // Manual PDF/TEI source import (`importSource`): stages under papers/ and attaches to registered paper; cleans up on refusal.
        await call("callTool", { name: "registry", toolArgs: { action: "register", identifiers: [DOI_A, DOI_B] } });
        for (const badName of ["../escape.pdf", "sub/nested.pdf", "notes.txt", ""]) {
          await assert.rejects(
            () => call("importSource", { id: DOI_B, filename: badName, text: betaPdf() }),
            /refused:.*filename/i,
          );
        }
        const refusedImport = (await call("importSource", {
          id: "10.9999/unregistered",
          filename: "orphan.pdf",
          text: betaPdf(),
        })) as { stagedPath: string | null; outcome?: { status?: string; refusalCode?: string | null } };
        assert.equal(refusedImport.stagedPath, null);
        assert.equal(refusedImport.outcome?.status, "refused");
        assert.equal(refusedImport.outcome?.refusalCode, "DOI_NOT_FOUND");
        const afterRefusedFiles = (await call("listFiles", {})) as { files: { path: string }[] };
        assert.ok(!afterRefusedFiles.files.some((f) => f.path === "papers/orphan.pdf"), "failed importSource cleans up staged file");

        const importedPdf = (await call("importSource", {
          id: DOI_B,
          filename: "beta-manual.pdf",
          text: betaPdf(),
        })) as { stagedPath: string | null; outcome?: { status?: string; source?: { status?: string; chunks?: number } } };
        assert.equal(importedPdf.stagedPath, "papers/beta-manual.pdf");
        assert.equal(importedPdf.outcome?.status, "attached");
        assert.equal(importedPdf.outcome?.source?.status, "ready");
        assert.ok((importedPdf.outcome?.source?.chunks ?? 0) >= 1);

        // Test manual TEI XML import via importSource
        const importedTei = (await call("importSource", {
          id: DOI_A,
          filename: "alpha-manual.tei.xml",
          text: teiFixture(DOI_A, "Alpha Grid"),
        })) as { stagedPath: string | null; outcome?: { status?: string; source?: { status?: string } } };
        assert.equal(importedTei.stagedPath, "papers/alpha-manual.tei.xml");
        assert.equal(importedTei.outcome?.status, "attached");
        assert.equal(importedTei.outcome?.source?.status, "ready");

        // Refuse importSource if destination path is an existing directory
        await call("writeFile", { rel: "papers/as-dir.pdf/child.txt", text: "placeholder" });
        await assert.rejects(
          () => call("importSource", { id: DOI_A, filename: "as-dir.pdf", text: betaPdf() }),
          /refused:.*directory/i,
        );
        await call("deleteFile", { rel: "papers/as-dir.pdf/child.txt" });

        const hitsAfterImport = (await call("callTool", {
          name: "passages",
          toolArgs: { query: "Cache eviction sustained heat" },
        })) as { structuredContent: { hits: { citekey: string }[] } };
        assert.equal(hitsAfterImport.structuredContent.hits[0]?.citekey, "holder2024beta");

        // Export project and round-trip into a brand-new worker via `importProject`.
        await call("writeFile", { rel: "manuscript/main.tex", text: "\\documentclass{article}\n\\begin{document}\nCache eviction degrades hit rate \\cite{holder2024beta}.\n\\end{document}\n" });
        const exportedSnap = (await call("exportProject", {})) as {
          files: { path: string; size: number }[];
          zip: Record<string, number> | number[];
          registry: Record<string, number> | number[] | null;
        };
        assert.ok(exportedSnap.registry !== null);

        // Path traversal outside /proj and writes/deletes on tool-owned/protected paths (.registry/*, .git/*, refs/references.bib) are refused.
        for (const [op, badArgs] of [
          ["writeFile", { rel: "../escape.tex", text: "no" }],
          ["writeFile", { rel: "manuscript/../notes.tex", text: "no" }],
          ["writeFile", { rel: ".registry/registry.db", text: "no" }],
          ["writeFile", { rel: "sub/.registry/x", text: "no" }],
          ["writeFile", { rel: ".git/config", text: "no" }],
          ["writeFile", { rel: "sub/.git/config", text: "no" }],
          ["writeFile", { rel: "refs/references.bib", text: "no" }],
          ["writeFile", { rel: "refs/references.bib/evil", text: "no" }],
          ["readFile", { rel: "../escape.tex" }],
          ["readFile", { rel: ".registry/registry.db" }],
          ["readFile", { rel: "sub/.registry/x" }],
          ["readFile", { rel: ".git/config" }],
          ["readFile", { rel: "sub/.git/config" }],
          ["readFile", { rel: "refs/references.bib/evil" }],
          ["deleteFile", { rel: "../escape.tex" }],
          ["deleteFile", { rel: ".registry/registry.db" }],
          ["deleteFile", { rel: "sub/.registry/x" }],
          ["deleteFile", { rel: "refs/references.bib" }],
          ["deleteFile", { rel: "refs/references.bib/evil" }],
        ] as const) {
          await assert.rejects(() => call(op, badArgs as Record<string, unknown>), /outside|tool-owned|protected|invalid|escaping/i);
        }

        // Round-trip `importProject` in a fresh worker context + atomic refusal of bad archives/DBs.
        const { ctx: ctxRestore, page: pageRestore } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
        try {
          const callRestore = (op: string, args: Record<string, unknown> = {}): Promise<unknown> => callWorker(pageRestore, op, args);
          assert.deepEqual(
            await callRestore("init", {
              projectId: "proj-import-roundtrip",
              providerConfig: { ...TEST_PROVIDER_CONFIG },
              fetchRoutes: ALL_ROUTES,
              nowIso: FIXED_NOW_ISO,
            }),
            { ok: true },
          );
          // Empty args refusal
          await assert.rejects(
            () => callRestore("importProject", {}),
            /refused:.*at least one of zip or registry/i,
          );

          const importedProj = (await callRestore("importProject", {
            zip: exportedSnap.zip,
            registry: exportedSnap.registry,
          })) as { ok: boolean; filesImported: number; registryImported: boolean };
          assert.deepEqual(importedProj, {
            ok: true,
            filesImported: exportedSnap.files.length,
            registryImported: true,
          });
          const restoredFiles = (await callRestore("listFiles", {})) as { files: { path: string; size: number }[] };
          assert.deepEqual(restoredFiles.files, exportedSnap.files);
          const restoredHits = (await callRestore("callTool", {
            name: "passages",
            toolArgs: { query: "Cache eviction sustained heat" },
          })) as { structuredContent: { hits: { citekey: string }[] } };
          assert.equal(restoredHits.structuredContent.hits[0]?.citekey, "holder2024beta");

          // Test replace: true cleans up stale files from previous project
          await callRestore("writeFile", { rel: "manuscript/stale.tex", text: "old stuff" });
          assert.ok(((await callRestore("listFiles", {})) as { files: { path: string }[] }).files.some((f) => f.path === "manuscript/stale.tex"));
          await callRestore("importProject", { zip: exportedSnap.zip, replace: true });
          assert.ok(!((await callRestore("listFiles", {})) as { files: { path: string }[] }).files.some((f) => f.path === "manuscript/stale.tex"));

          // Adversarial importProject inputs (non-SQLite bytes, foreign user_version=999 SQLite DB, escaping zip) are refused without clobbering the restored project.
          await assert.rejects(
            () => callRestore("importProject", { registry: [1, 2, 3, 4] }),
            /refused:.*SQLite/i,
          );
          let foreignDbBytes: number[] | null = null;
          const { ctx: ctxForeign, page: pageForeign } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
          try {
            const callForeign = (op: string, args: Record<string, unknown> = {}): Promise<unknown> => callWorker(pageForeign, op, args);
            await callForeign("init", { projectId: "proj-foreign-seed", nowIso: FIXED_NOW_ISO });
            await callForeign("makeForeignRegistry", { version: 999 });
            foreignDbBytes = (await callForeign("registryBytes", {})) as number[] | null;
          } finally {
            await ctxForeign.close();
          }
          assert.ok(foreignDbBytes !== null && foreignDbBytes.length >= 100);
          await assert.rejects(
            () => callRestore("importProject", { registry: foreignDbBytes }),
            /refused:.*incompatible or corrupt SQLite registry/i,
          );
          const badZip = Array.from(zipSync({ "../escape.tex": new Uint8Array([65]) }));
          await assert.rejects(
            () => callRestore("importProject", { zip: badZip }),
            /outside|escaping|invalid|refused/i,
          );
          const stillIntact = (await callRestore("callTool", {
            name: "passages",
            toolArgs: { query: "Cache eviction sustained heat" },
          })) as { structuredContent: { hits: { citekey: string }[] } };
          assert.equal(stillIntact.structuredContent.hits[0]?.citekey, "holder2024beta", "failed importProject rolls back and leaves existing registry intact");
        } finally {
          await ctxRestore.close();
        }
      } finally {
        await ctx.close();
      }
    }

    // 2. Doctor hosted probe error diagnosis in browser worker: HTTP 401 and wrong-model echo.
    for (const [label, route, wantMatch] of [
      [
        "401",
        { match: "decision.vllm-sr.ai/v1/systemone", status: 401, body: "unauthorized" },
        /answered HTTP 401 \(unauthorized\) — the key was rejected/,
      ],
      [
        "wrong-model",
        {
          match: "decision.vllm-sr.ai/v1/systemone",
          status: 200,
          body: JSON.stringify({ model: "other/weights-v0", answers: { c: { noul: 0.9 } } }),
        },
        /reports model "other\/weights-v0", not vllm-sr\/d3-mini/,
      ],
    ] as const) {
      const { ctx, page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
      try {
        const call = (op: string, args: Record<string, unknown> = {}): Promise<unknown> => callWorker(page, op, args);
        assert.deepEqual(
          await call("init", {
            projectId: `proj-doc-${label}`,
            env: { UKTUB_VERIFY_API_KEY: "test-key" },
            fetchRoutes: [route],
            nowIso: FIXED_NOW_ISO,
          }),
          { ok: true },
        );
        const doc = (await call("callTool", { name: "doctor", toolArgs: {} })) as {
          structuredContent: { summary: string; checks: { name: string; status: string; detail: string; fix: string }[] };
        };
        assert.match(doc.structuredContent.summary, /problem/);
        const vCheck = doc.structuredContent.checks.find((c) => c.name === "verification");
        assert.equal(vCheck?.status, "error");
        assert.match(vCheck?.detail ?? "", wantMatch);
        assert.ok((vCheck?.fix ?? "").length > 0, "error check carries a fix");
      } finally {
        await ctx.close();
      }
    }
    void executablePath;
  } finally {
    await browser.close();
    await server.close();
  }
});

// ── host lifecycle: close waits for in-flight calls; callIds are unique ─────

test("host: close waits for an in-flight tool call before it settles the store", { timeout: 120000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const outdir = tmpDir("diff-close-www-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { browser } = await launchChromium();
  try {
    const { ctx, page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
    try {
      // The openalex route ignores abort for 1500 ms, so the search call is still running when close arrives.
      const slowOpenalex: CannedRoute = { match: "api.openalex.test", delayMs: 1500, ignoreAbort: true, body: JSON.stringify({ results: [] }) };
      assert.deepEqual(
        await callWorker(page, "init", {
          projectId: `close-order-${Date.now().toString(36)}`,
          env: {},
          providerConfig: { ...TEST_PROVIDER_CONFIG },
          fetchRoutes: [slowOpenalex, ...ALL_ROUTES],
          downloads: ALL_DOWNLOADS,
          nowIso: FIXED_NOW_ISO,
        }),
        { ok: true },
      );
      const events = await page.evaluate(async () => {
        const w = (window as unknown as { __worker: Worker }).__worker;
        const events: string[] = [];
        const rpc = (id: string, op: string, args: Record<string, unknown>): Promise<unknown> =>
          new Promise((resolve) => {
            const onMsg = (ev: MessageEvent): void => {
              if ((ev.data as { id?: string })?.id === id) {
                w.removeEventListener("message", onMsg);
                resolve(ev.data);
              }
            };
            w.addEventListener("message", onMsg);
            w.postMessage({ id, op, args });
          });
        const slow = rpc("slow-search", "callTool", {
          callId: "slow-search",
          name: "search",
          toolArgs: { query: "thermal grids", limit: 5 },
        }).then((r) => {
          events.push("call-settled");
          return r;
        });
        await new Promise((r) => setTimeout(r, 200));
        const closed = rpc("close-1", "close", {}).then((r) => {
          events.push("close-resolved");
          return r;
        });
        await Promise.all([slow, closed]);
        return events;
      });
      assert.deepEqual(events, ["call-settled", "close-resolved"], "close resolved only after the in-flight call settled");
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

test("host: a second call with a live callId is refused and cancelTool still cancels the first", { timeout: 120000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const outdir = tmpDir("diff-dupid-www-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { browser } = await launchChromium();
  try {
    const { ctx, page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
    try {
      // `search` does not thread the tool signal into its providers, so this call runs to completion; the test only needs the entry.
      const slowOpenalex: CannedRoute = { match: "api.openalex.test", delayMs: 1500, body: JSON.stringify({ results: [] }) };
      assert.deepEqual(
        await callWorker(page, "init", {
          projectId: `dup-callid-${Date.now().toString(36)}`,
          env: {},
          providerConfig: { ...TEST_PROVIDER_CONFIG },
          fetchRoutes: [slowOpenalex, ...ALL_ROUTES],
          downloads: ALL_DOWNLOADS,
          nowIso: FIXED_NOW_ISO,
        }),
        { ok: true },
      );
      const probe = await page.evaluate(async () => {
        const w = (window as unknown as { __worker: Worker }).__worker;
        const rpc = (id: string, op: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: any; error?: string }> =>
          new Promise((resolve) => {
            const onMsg = (ev: MessageEvent): void => {
              const m = ev.data as { id?: string; ok?: boolean; result?: any; error?: string };
              if (m && m.id === id) {
                w.removeEventListener("message", onMsg);
                resolve({ ok: m.ok === true, result: m.result, error: m.error });
              }
            };
            w.addEventListener("message", onMsg);
            w.postMessage({ id, op, args });
          });
        const first = rpc("dup-first", "callTool", { callId: "dup", name: "search", toolArgs: { query: "thermal grids", limit: 5 } });
        await new Promise((r) => setTimeout(r, 120));
        const second = await rpc("dup-second", "callTool", { callId: "dup", name: "passages", toolArgs: { query: "thermal grids", limit: 5 } });
        const cancel = await rpc("dup-cancel", "cancelTool", { callId: "dup" });
        const firstReply = await first;
        return { second, cancel, firstReply };
      });
      assert.equal(probe.second.ok, true);
      assert.equal(probe.second.result.structuredContent, null, "duplicate callId refused with the typed error envelope");
      assert.equal(probe.second.result.details?.thrown, true);
      assert.match(probe.second.result.content[0].text, /already in flight/);
      assert.deepEqual(probe.cancel.result, { cancelled: true }, "the first call is still cancellable");
      assert.equal(probe.firstReply.ok, true, "the first call settled normally");
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
