/**
 * Phase 7 worker compile ops (real Chromium worker, TDD-first):
 * - `compilePrepare` refusals equal Node's core `resolveEntry` refusals.
 * - `compileFinish` on each genuine BusyTeX fixture log gives the expected
 *   status/diagnostics, writes `build/main.pdf` only on success, carries
 *   the provenance block on success, and sets `outputOverflow` when the
 *   client-policy log cap cuts the log.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bundle } from "./build.mjs";
import { serveDirectory } from "./server.mjs";
import { launchChromium } from "./launch.mjs";
import { callWorker, openWorkerPage } from "./rpc.mjs";
import { resolveEntry } from "../src/core/compile/run.ts";
/**
 * Mirrors `BROWSER_COMPILE_LOG_CAP_CHARS` in `src/browser/host.ts` (that
 * module is not Node-importable — it pulls the OPFS/sqlite shims). The
 * boundary tests below fail loudly if the two drift: LOG_CAP - 10 must not
 * overflow, LOG_CAP + 10 must.
 */
const BROWSER_COMPILE_LOG_CAP_CHARS = 1_000_000;

const FIX = (name) => fs.readFileSync(path.join(import.meta.dirname, "..", "tests", "fixtures", "busytex", name), "utf8");
const META = (name) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "tests", "fixtures", "busytex", name), "utf8"));
const ENGINE_LABEL = "busytex 1.4.1";
const FAKE_PDF = new Uint8Array(Buffer.from("%PDF-1.4\n%phase7-fixture\n"));

const nodeRefusal = (root, entry) => {
  const r = resolveEntry(root, entry);
  assert.equal(r.ok, false);
  return r.message;
};

describe("worker compile ops (compilePrepare / compileFinish)", { timeout: 300000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const outdir = fs.mkdtempSync(path.join(root, "tests-browser", "tmp-compile-"));
  let server;
  let browser;
  let workerUrl;
  let pageUrl;
  let page;
  let ctx;

  before(async () => {
    await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
    fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
    server = await serveDirectory(outdir);
    ({ browser } = await launchChromium());
    workerUrl = `${server.url}/worker.js`;
    pageUrl = `${server.url}/page.html`;
    ({ ctx, page } = await openWorkerPage(browser, pageUrl, workerUrl));
  });

  after(async () => {
    try { await ctx?.close(); } catch {}
    try { await browser?.close(); } catch {}
    try { await server?.close(); } catch {}
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  const call = (op, args = {}) => callWorker(page, op, args);
  const pid = (tag) => `compile-${tag}-${Date.now().toString(36)}`;

  it("compilePrepare before init is refused (no project)", async () => {
    await assert.rejects(call("compilePrepare", {}), /not initialized/);
  });

  it("compilePrepare refusals equal Node core resolveEntry refusals", async () => {
    const id = pid("prep");
    assert.deepEqual(await call("init", { projectId: id, env: {} }), { ok: true });
    try {
      // Empty project: same NO_ENTRY message Node reports for an empty root.
      const empty = await call("compilePrepare", {});
      assert.equal(empty.ok, false);
      assert.equal(empty.code, "COMPILE_NO_ENTRY");
      assert.equal(empty.message, nodeRefusal("/nonexistent-uktub-root-xyz", undefined));
      // Explicit missing file: same message as Node.
      const missing = await call("compilePrepare", { entry: "manuscript/main.tex" });
      assert.equal(missing.ok, false);
      assert.equal(missing.code, "COMPILE_NO_ENTRY");
      assert.equal(missing.message, nodeRefusal("/nonexistent-uktub-root-xyz", "manuscript/main.tex"));
      // Escapes and non-.tex: identical to Node.
      for (const bad of ["../outside.tex", "refs/references.bib"]) {
        const got = await call("compilePrepare", { entry: bad });
        assert.equal(got.ok, false);
        assert.equal(got.code, "COMPILE_NO_ENTRY");
        assert.equal(got.message, nodeRefusal("/nonexistent-uktub-root-xyz", bad));
      }
      // With the entry present: resolved project-relative, defaults first.
      await call("writeFile", { rel: "manuscript/main.tex", text: "\\begin{document}hi\\end{document}" });
      assert.deepEqual(await call("compilePrepare", {}), { ok: true, rel: "manuscript/main.tex" });
      assert.deepEqual(await call("compilePrepare", { entry: "manuscript/main.tex" }), { ok: true, rel: "manuscript/main.tex" });
    } finally {
      await call("close", {});
    }
  });

  it("compileFinish on each BusyTeX fixture: expected status, engine label, pdf write rules", async () => {
    const id = pid("fin");
    assert.deepEqual(await call("init", { projectId: id, env: {} }), { ok: true });
    try {
      await call("writeFile", { rel: "manuscript/main.tex", text: "The shared queue drains faster when independent stages run in parallel.\n" });
      await call("writeFile", { rel: "manuscript/broken.bib", text: "@article{x,\n}\n" });
      const cases = [
        "clean", "undef-macro", "missing-input", "undef-cite", "missing-bibentry",
        "bib-syntax", "unknown-package", "overfull", "pkg-warn",
      ];
      const wantStatus = {
        clean: "compiled", "undef-macro": "errors", "missing-input": "errors",
        "undef-cite": "compiled", "missing-bibentry": "compiled", "bib-syntax": "errors",
        "unknown-package": "errors", overfull: "compiled", "pkg-warn": "compiled",
      };
      for (const name of cases) {
        const meta = META(`${name}.meta.json`);
        const log = FIX(`${name}.log.txt`);
        const res = await call("compileFinish", {
          entry: "manuscript/main.tex", engineLabel: ENGINE_LABEL,
          code: meta.status, timedOut: false, log,
          ...(meta.hasPdf ? { pdf: FAKE_PDF } : {}),
        });
        const s = res.structuredContent;
        assert.equal(s.status, wantStatus[name], `${name}: status`);
        assert.equal(s.engine, ENGINE_LABEL, `${name}: engine label`);
        assert.equal(s.entry, "manuscript/main.tex", `${name}: entry`);
        assert.equal(typeof res.content[0].text, "string", `${name}: text content`);
        if (wantStatus[name] === "compiled") {
          assert.equal(s.pdfPath, "build/main.pdf", `${name}: pdf path`);
          assert.equal(s.pdfSizeBytes, FAKE_PDF.length, `${name}: pdf size`);
          const files = (await call("listFiles", {})).files.map((f) => f.path);
          assert.ok(files.includes("build/main.pdf"), `${name}: build/main.pdf written`);
          assert.ok(s.provenance !== undefined && s.provenance !== null, `${name}: provenance block present`);
          assert.ok(res.content[0].text.includes("provenance:"), `${name}: provenance text present`);
          await call("deleteFile", { rel: "build/main.pdf" });
        } else {
          assert.equal(s.pdfPath, null, `${name}: no pdf path`);
          assert.equal(s.pdfSizeBytes, null, `${name}: no pdf size`);
          assert.ok(s.diagnostics.some((d) => d.severity === "error"), `${name}: an error diagnostic`);
          const files = (await call("listFiles", {})).files.map((f) => f.path);
          assert.ok(!files.includes("build/main.pdf"), `${name}: no build/main.pdf on failure`);
        }
      }
      // Spot diagnostics: the undefined-macro line survives the worker round trip with its project path.
      const spot = await call("compileFinish", {
        entry: "manuscript/main.tex", engineLabel: ENGINE_LABEL,
        code: 1, timedOut: false, log: FIX("undef-macro.log.txt"),
      });
      assert.ok(
        spot.structuredContent.diagnostics.some((d) => d.severity === "error" && d.file === "manuscript/main.tex" && d.line === 10),
        "undef-macro error keeps file+line through compileFinish",
      );
      // Exit 0 with no PDF bytes and no parsed error is still errors (never a bare compiled-with-nothing).
      const nopdf = await call("compileFinish", {
        entry: "manuscript/main.tex", engineLabel: ENGINE_LABEL,
        code: 0, timedOut: false, log: FIX("clean.log.txt"),
      });
      assert.equal(nopdf.structuredContent.status, "errors", "clean log without pdf bytes is errors");
    } finally {
      await call("close", {});
    }
  });

  it("compileFinish timeout maps to COMPILE_TIMEOUT like Node; the log cap sets outputOverflow", async () => {
    const id = pid("cap");
    assert.deepEqual(await call("init", { projectId: id, env: {} }), { ok: true });
    try {
      await call("writeFile", { rel: "manuscript/main.tex", text: "x\n" });
      const timed = await call("compileFinish", {
        entry: "manuscript/main.tex", engineLabel: ENGINE_LABEL,
        code: 1, timedOut: true, log: "cut",
      });
      assert.equal(timed.structuredContent, null);
      assert.equal(timed.details.refused.code, "COMPILE_TIMEOUT");
      assert.match(timed.details.refused.message, /busytex exceeded the 120s budget/);
      const big = await call("compileFinish", {
        entry: "manuscript/main.tex", engineLabel: ENGINE_LABEL,
        code: 0, timedOut: false, log: `! Something broke.\n${"x".repeat(BROWSER_COMPILE_LOG_CAP_CHARS + 100)}`,
      });
      assert.equal(big.structuredContent.status, "errors");
      assert.equal(big.structuredContent.diagnosticsTruncated, true);
      assert.ok(
        big.structuredContent.diagnostics.some((d) => d.severity === "error" && /output cap/.test(d.message)),
        "log cap overflow error names the cap",
      );
      const under = await call("compileFinish", {
        entry: "manuscript/main.tex", engineLabel: ENGINE_LABEL,
        code: 0, timedOut: false, log: `! Something broke.\n${"x".repeat(BROWSER_COMPILE_LOG_CAP_CHARS - 100)}`,
      });
      assert.ok(
        !under.structuredContent.diagnostics.some((d) => d.severity === "error" && /output cap/.test(d.message)),
        "a log just under the cap does not overflow",
      );
    } finally {
      await call("close", {});
    }
  });
});
