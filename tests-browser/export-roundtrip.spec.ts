/**
 * Phase 9a item 4: the Uktub worker's `exportProject`/`importProject` round
 * trip keeps `.registry/registry.db`, `refs/references.bib`, sections and
 * results. Model-free: real Chromium worker, canned provider routes.
 *
 * export → close → deleteProjectStorage → init (fresh, empty registry) →
 * import → registry `read` lists the same papers and every project file
 * (entry, section, bib) is byte-identical.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";

import { bundle } from "./build.mjs";
import { serveDirectory } from "./server.mjs";
import { launchChromium } from "./launch.mjs";
import { callWorker, openWorkerPage } from "./rpc.mjs";
import {
  FIXED_NOW_ISO,
  TEST_PROVIDER_CONFIG,
  buildCannedDownload,
  buildCannedFetch,
  registerRoutes,
  type CannedDownload,
  type CannedRoute,
} from "./scenarios/tools.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

const PAPERS = {
  "10.1001/aaa": {
    title: "Alpha Grid",
    bibtex: "@article{holder2024, title={Alpha Grid}, author={Holder, Ada}, year={2024}}",
  },
  "10.1001/bbb": {
    title: "Beta Cache",
    bibtex: "@article{holder2024a, title={Beta Cache}, author={Holder, Ada}, year={2024}}",
  },
};
const DOIS = Object.keys(PAPERS).sort();

const MAIN_TEX = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Grids age slowly \\cite{holder2024} and caches too \\cite{holder2024a}.",
  "\\bibliographystyle{plain}",
  "\\bibliography{../refs/references}",
  "\\end{document}",
  "",
].join("\n");
const SECTION_TEX = "Introduction: grids age slowly.\n";
const RESULTS_TXT = "run1: hit rate 0.91\n";

function toBytes(input: Uint8Array | number[] | null | undefined): Uint8Array | null {
  if (input === null || input === undefined) return null;
  return input instanceof Uint8Array ? input : Uint8Array.from(input);
}

describe("worker export/import round trip keeps registry and files", { timeout: 300000 }, async () => {
  const outdir = fs.mkdtempSync(path.join(ROOT, "tests-browser", "tmp-export9a-"));
  let server;
  let browser;
  let page;

  before(async () => {
    await bundle("src/browser/worker.ts", path.join(path.relative(ROOT, outdir), "worker.js"));
    fs.copyFileSync(path.join(ROOT, "tests-browser/page.html"), path.join(outdir, "page.html"));
    server = await serveDirectory(outdir);
    ({ browser } = await launchChromium());
    ({ page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`));
  });

  after(async () => {
    try { await browser?.close(); } catch {}
    try { await server?.close(); } catch {}
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  const call = (op, args = {}) => callWorker(page, op, args);
  const pid = `export9a-${Date.now().toString(36)}`;

  const readText = async (rel: string): Promise<string> => {
    const res = (await call("readFile", { rel, encoding: "utf8" })) as { text?: string };
    assert.ok(typeof res.text === "string", `readFile ${rel} returns text`);
    return res.text;
  };

  it("export → delete → import restores papers and files", async () => {
    const routes: CannedRoute[] = [...registerRoutes(PAPERS)];
    const downloads: CannedDownload[] = [];
    assert.deepEqual(await call("init", {
      projectId: pid,
      env: {},
      providerConfig: { ...TEST_PROVIDER_CONFIG },
      fetchRoutes: routes,
      downloads,
      nowIso: FIXED_NOW_ISO,
    }), { ok: true });
    try {
      const reg = (await call("callTool", { name: "registry", toolArgs: { action: "register", identifiers: DOIS } })) as {
        structuredContent: { outcomes: { status: string; doi: string }[] };
      };
      assert.deepEqual(reg.structuredContent.outcomes.map((o) => o.doi).sort(), DOIS);

      const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
      await call("writeFile", { rel: "manuscript/main.tex", base64: b64(MAIN_TEX) });
      await call("writeFile", { rel: "manuscript/sections/intro.tex", base64: b64(SECTION_TEX) });
      await call("writeFile", { rel: "results/notes.txt", base64: b64(RESULTS_TXT) });

      const beforeFiles = ((await call("listFiles", {})) as { files: { path: string }[] }).files.map((f) => f.path).sort();
      const beforeMain = await readText("manuscript/main.tex");
      const beforeBib = await readText("refs/references.bib");

      const exported = (await call("exportProject", {})) as { files: unknown[]; zip: Uint8Array | number[]; registry: Uint8Array | number[] | null };
      const zipBytes = toBytes(exported.zip);
      const regBytes = toBytes(exported.registry);
      assert.ok(zipBytes !== null && zipBytes.byteLength > 0, "export carries a files zip");
      assert.ok(regBytes !== null && regBytes.byteLength > 100, "export carries the registry bytes");
      assert.equal(Buffer.from(regBytes.subarray(0, 15)).toString("ascii"), "SQLite format 3", "registry bytes are a SQLite database");
      const unzipped = unzipSync(zipBytes);
      assert.ok(unzipped["manuscript/main.tex"] !== undefined, "files zip holds the entry");
      assert.ok(unzipped["refs/references.bib"] !== undefined, "files zip holds the rendered bibliography");

      await call("close", {});
      assert.deepEqual(await call("deleteProjectStorage", { projectId: pid }), { deleted: true });

      assert.deepEqual(await call("init", {
        projectId: pid,
        env: {},
        providerConfig: { ...TEST_PROVIDER_CONFIG },
        fetchRoutes: routes,
        downloads,
        nowIso: FIXED_NOW_ISO,
      }), { ok: true });
      const empty = (await call("callTool", { name: "registry", toolArgs: { action: "read" } })) as {
        structuredContent: { total: number };
      };
      assert.equal(empty.structuredContent.total, 0, "fresh init after delete holds no papers");

      const imported = (await call("importProject", {
        zip: Array.from(zipBytes),
        registry: regBytes === null ? null : Array.from(regBytes),
        replace: true,
      })) as { ok: boolean; filesImported: number; registryImported: boolean };
      assert.equal(imported.ok, true);
      assert.equal(imported.registryImported, true, "registry restored from export");

      const after = (await call("callTool", { name: "registry", toolArgs: { action: "read" } })) as {
        structuredContent: { total: number; records: { doi: string }[] };
      };
      assert.equal(after.structuredContent.total, 2, "round trip keeps both papers");
      assert.deepEqual(after.structuredContent.records.map((r) => r.doi).sort(), DOIS);
      const afterFiles = ((await call("listFiles", {})) as { files: { path: string }[] }).files.map((f) => f.path).sort();
      assert.deepEqual(afterFiles, beforeFiles, "round trip keeps the file list");
      assert.equal(await readText("manuscript/main.tex"), beforeMain, "entry byte-identical");
      assert.equal(await readText("manuscript/sections/intro.tex"), SECTION_TEX, "section byte-identical");
      assert.equal(await readText("results/notes.txt"), RESULTS_TXT, "results byte-identical");
      assert.equal(await readText("refs/references.bib"), beforeBib, "rendered bibliography byte-identical");
    } finally {
      await call("close", {}).catch(() => {});
    }
  });
});
