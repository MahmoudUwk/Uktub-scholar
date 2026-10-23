/**
 * Phase 4b: per-project browser storage. Each Uktub `projectId` gets its own
 * OPFS directory (`uktub/projects/<projectId>/`) holding its own
 * `opfs-sahpool` pool, while the open project still appears at `/proj`.
 *
 * (a) two projects A and B in the same origin keep separate files and
 *     registries, across fresh workers;
 * (b) deleting B removes B's storage and leaves A intact; deleting an
 *     open/locked project is refused;
 * (c) invalid `projectId` values are refused at `init`;
 * (d) export/import round-trips per project.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bundle } from "./build.mjs";
import { serveDirectory } from "./server.mjs";
import { launchChromium } from "./launch.mjs";
import { callWorker } from "./rpc.mjs";
import { tmpDir } from "./tmp.mjs";
import {
  FIXED_NOW_ISO,
  TEST_PROVIDER_CONFIG,
  registerRoutes,
} from "./scenarios/tools.ts";

const DOI_A = "10.1001/aaa";
const DOI_B = "10.1001/bbb";

const PAPERS_A = {
  [DOI_A]: {
    title: "Alpha Grid",
    bibtex: "@article{holder2024, title={Alpha Grid}, author={Holder, Ada}, year={2024}}",
  },
};
const PAPERS_B = {
  [DOI_B]: {
    title: "Beta Cache",
    bibtex: "@article{holder2024a, title={Beta Cache}, author={Holder, Ada}, year={2024}}",
  },
};

const SENT_A = "Alpha project sentence.";
const SENT_B = "Beta project sentence.";

async function setup() {
  const root = path.resolve(import.meta.dirname, "..");
  const outdir = tmpDir("diff-projects-www-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { browser } = await launchChromium();
  return { server, browser, workerUrl: `${server.url}/worker.js`, pageUrl: `${server.url}/page.html` };
}

/** Boot a dedicated worker on a page of a shared context (shared OPFS). */
async function bootWorker(page, workerUrl) {
  await page.evaluate(async (u) => {
    const w = new Worker(u, { type: "module" });
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
  }, workerUrl);
}

async function newWorkerPage(ctx, pageUrl, workerUrl) {
  const page = await ctx.newPage();
  await page.goto(pageUrl, { waitUntil: "load" });
  await bootWorker(page, workerUrl);
  return page;
}

const call = (page, op, args = {}) => callWorker(page, op, args);

function initArgs(projectId, papers) {
  return {
    projectId,
    env: {},
    providerConfig: { ...TEST_PROVIDER_CONFIG },
    fetchRoutes: registerRoutes(papers),
    nowIso: FIXED_NOW_ISO,
  };
}

async function seedProject(page, projectId, papers, doi, sentence) {
  assert.deepEqual(await call(page, "init", initArgs(projectId, papers)), { ok: true });
  await call(page, "writeFile", { rel: "manuscript/main.tex", text: sentence });
  const reg = await call(page, "callTool", { name: "registry", toolArgs: { action: "register", identifiers: [doi] } });
  assert.deepEqual(
    reg.structuredContent.outcomes.map((o) => o.status),
    ["registered"],
    `${projectId} register`,
  );
}

async function readProject(page, projectId) {
  const read = await call(page, "readFile", { rel: "manuscript/main.tex" });
  const reg = await call(page, "callTool", { name: "registry", toolArgs: { action: "read" } });
  return { text: read.text, dois: reg.structuredContent.records.map((r) => r.doi) };
}

test("projects: two projects side by side keep separate files and registries", { timeout: 300000 }, async () => {
  const { server, browser, workerUrl, pageUrl } = await setup();
  const run = Date.now().toString(36);
  const idA = `p4b-A-${run}`;
  const idB = `p4b-B-${run}`;
  try {
    const ctx = await browser.newContext();
    try {
      const pageA = await newWorkerPage(ctx, pageUrl, workerUrl);
      const pageB = await newWorkerPage(ctx, pageUrl, workerUrl);
      // Both projects open concurrently in one origin (two pools coexist).
      await seedProject(pageA, idA, PAPERS_A, DOI_A, SENT_A);
      await seedProject(pageB, idB, PAPERS_B, DOI_B, SENT_B);
      // While both are open, each sees only its own state.
      assert.deepEqual(await readProject(pageA, idA), { text: SENT_A, dois: [DOI_A] });
      assert.deepEqual(await readProject(pageB, idB), { text: SENT_B, dois: [DOI_B] });
      assert.deepEqual(await call(pageA, "close", {}), { ok: true });
      assert.deepEqual(await call(pageB, "close", {}), { ok: true });
      // Reopen each in a fresh worker: nothing leaks across projects.
      const pageA2 = await newWorkerPage(ctx, pageUrl, workerUrl);
      assert.deepEqual(await call(pageA2, "init", initArgs(idA, PAPERS_A)), { ok: true });
      assert.deepEqual(await readProject(pageA2, idA), { text: SENT_A, dois: [DOI_A] });
      const pageB2 = await newWorkerPage(ctx, pageUrl, workerUrl);
      assert.deepEqual(await call(pageB2, "init", initArgs(idB, PAPERS_B)), { ok: true });
      assert.deepEqual(await readProject(pageB2, idB), { text: SENT_B, dois: [DOI_B] });
      console.log("  A and B isolated across concurrent opens and fresh-worker reopens");
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

test("projects: delete removes one project, refuses open and locked projects", { timeout: 300000 }, async () => {
  const { server, browser, workerUrl, pageUrl } = await setup();
  const run = Date.now().toString(36);
  const idA = `p4b-del-A-${run}`;
  const idB = `p4b-del-B-${run}`;
  try {
    const ctx = await browser.newContext();
    try {
      const pageA = await newWorkerPage(ctx, pageUrl, workerUrl);
      await seedProject(pageA, idA, PAPERS_A, DOI_A, SENT_A);
      await call(pageA, "close", {});
      const pageB = await newWorkerPage(ctx, pageUrl, workerUrl);
      await seedProject(pageB, idB, PAPERS_B, DOI_B, SENT_B);
      await call(pageB, "close", {});
      // Delete B from a worker that holds no project.
      const pageDel = await newWorkerPage(ctx, pageUrl, workerUrl);
      assert.deepEqual(await call(pageDel, "deleteProjectStorage", { projectId: idB }), { deleted: true });
      // A is intact; B is gone (fresh worker sees a fresh empty project).
      const pageA2 = await newWorkerPage(ctx, pageUrl, workerUrl);
      assert.deepEqual(await call(pageA2, "init", initArgs(idA, PAPERS_A)), { ok: true });
      assert.deepEqual(await readProject(pageA2, idA), { text: SENT_A, dois: [DOI_A] });
      const pageB2 = await newWorkerPage(ctx, pageUrl, workerUrl);
      assert.deepEqual(await call(pageB2, "init", initArgs(idB, PAPERS_B)), { ok: true });
      const regB = await call(pageB2, "callTool", { name: "registry", toolArgs: { action: "read" } });
      assert.equal(regB.structuredContent.total, 0, "deleted project has an empty registry");
      await assert.rejects(() => call(pageB2, "readFile", { rel: "manuscript/main.tex" }), /no such file|ENOENT/i);
      console.log("  delete B: A intact, B storage gone");
      // Deleting the open project is refused.
      await assert.rejects(
        () => call(pageA2, "deleteProjectStorage", { projectId: idA }),
        /open in this worker|close it first/i,
        "delete of the open project is refused",
      );
      // Deleting a project locked by another tab is refused.
      await assert.rejects(
        () => call(pageDel, "deleteProjectStorage", { projectId: idA }),
        /another tab/i,
        "delete of a locked project is refused",
      );
      console.log("  delete of open/locked projects refused");
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

test("projects: invalid projectId values are refused at init", { timeout: 300000 }, async () => {
  const { server, browser, workerUrl, pageUrl } = await setup();
  try {
    const ctx = await browser.newContext();
    try {
      const page = await newWorkerPage(ctx, pageUrl, workerUrl);
      for (const bad of ["../x", "", "a/b", "x".repeat(200), ".", "-leading", "has space", "trailing/"]) {
        await assert.rejects(
          () => call(page, "init", { ...initArgs("unused", PAPERS_A), projectId: bad }),
          bad === "" ? /non-empty string/ : /invalid projectId/i,
          `init refuses ${JSON.stringify(bad.slice(0, 20))}`,
        );
      }
      // The worker is still usable after refused inits.
      assert.deepEqual(await call(page, "init", initArgs("p4b-valid-after-refusals", PAPERS_A)), { ok: true });
      console.log("  8 invalid projectIds refused, worker still usable");
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

test("projects: export/import round-trips per project", { timeout: 300000 }, async () => {
  const { server, browser, workerUrl, pageUrl } = await setup();
  const run = Date.now().toString(36);
  const idA = `p4b-xp-A-${run}`;
  const idB = `p4b-xp-B-${run}`;
  try {
    const ctx = await browser.newContext();
    try {
      const pageA = await newWorkerPage(ctx, pageUrl, workerUrl);
      await seedProject(pageA, idA, PAPERS_A, DOI_A, SENT_A);
      const exported = await call(pageA, "exportProject", {});
      assert.ok(Array.isArray(exported.files) && exported.files.length > 0, "export lists files");
      assert.ok(exported.zip !== undefined, "export has a zip");
      assert.ok(exported.registry !== null, "export has registry bytes");
      await call(pageA, "close", {});
      // Import into B (fresh, empty project): B gains A's content, A untouched.
      const pageB = await newWorkerPage(ctx, pageUrl, workerUrl);
      assert.deepEqual(await call(pageB, "init", initArgs(idB, PAPERS_B)), { ok: true });
      const imp = await call(pageB, "importProject", { zip: exported.zip, registry: exported.registry });
      assert.equal(imp.ok, true);
      assert.deepEqual(await readProject(pageB, idB), { text: SENT_A, dois: [DOI_A] });
      // A still has its own content (import into B did not touch A).
      const pageA2 = await newWorkerPage(ctx, pageUrl, workerUrl);
      assert.deepEqual(await call(pageA2, "init", initArgs(idA, PAPERS_A)), { ok: true });
      assert.deepEqual(await readProject(pageA2, idA), { text: SENT_A, dois: [DOI_A] });
      console.log("  export A -> import B round-trips files and registry; A untouched");
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
