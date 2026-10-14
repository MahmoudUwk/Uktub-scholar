/**
 * Differential test: `extractPdf` (unpdf / pdf.js) in Chromium's worker must give
 * the same captured text, page starts, section marks, extraction identity and
 * section chunks as Node, and the same typed refusal for unusable input.
 *
 * Fixtures: hand-built PDFs (always) plus every real PDF under `test_papers/`
 * of at most REAL_PDF_MAX_BYTES (gitignored; absent on a fresh clone, so those
 * rows are skipped, and the count is printed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPdfScenario, type PdfFixture } from "./scenarios/pdf.ts";
import { makePdf } from "../tests/helpers/pdf.ts";
import { bundle } from "./build.mjs";
import { serveDirectory } from "./server.mjs";
import { launchChromium } from "./launch.mjs";
import { openWorkerPage, callWorker } from "./rpc.mjs";
import { diffResults } from "./compare.mjs";
import { tmpDir } from "./tmp.mjs";

/** Client policy for the test only: keeps the run to a few minutes. */
const REAL_PDF_MAX_BYTES = 8 * 1024 * 1024;

function realPdfs(root: string): string[] {
  const dir = path.join(root, "test_papers");
  const found: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith(".pdf") && fs.statSync(p).size <= REAL_PDF_MAX_BYTES) found.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found.sort();
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

test("pdf extraction matches Node (text, pages, sections, chunks, refusals)", { timeout: 900000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const good = makePdf([["Introduction", "Battery chemistry limits cycle life.", "Cells age faster at high temperature."], ["2 Methods", "Second page about capacity fade."]]);
  const inline: PdfFixture[] = [
    { name: "synthetic-two-pages", bytes: good },
    { name: "synthetic-image-only", bytes: makePdf([[], []]) },
    { name: "refused-not-a-pdf", bytes: text("<html><body>Please log in</body></html>") },
    { name: "refused-truncated", bytes: good.slice(0, Math.floor(good.length * 0.6)) },
    { name: "refused-garbled", bytes: text("%PDF-1.4\n1 0 obj\n<< /Broken >>\nendobj\n%%EOF\n") },
  ];
  const reals = realPdfs(root).map((p, i) => ({ name: `real-${String(i).padStart(2, "0")}-${path.basename(p)}`, file: p }));
  console.log(`  fixtures: ${inline.length} synthetic, ${reals.length} real PDFs from test_papers/`);

  const fixtures: PdfFixture[] = [...inline, ...reals.map((r) => ({ name: r.name, bytes: new Uint8Array(fs.readFileSync(r.file)) }))];
  const expected = await runPdfScenario(fixtures);

  const outdir = tmpDir("diff-pdf-www-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  fs.mkdirSync(path.join(outdir, "fixtures"));
  for (const r of reals) fs.copyFileSync(r.file, path.join(outdir, "fixtures", r.name));
  const server = await serveDirectory(outdir);
  const { browser, executablePath } = await launchChromium();
  let actual: unknown;
  try {
    const { ctx, page } = await openWorkerPage(browser, `${server.url}/page.html`, `${server.url}/worker.js`);
    try {
      actual = await callWorker(
        page,
        "pdf",
        {
          inline: inline.map((f) => ({ name: f.name, base64: Buffer.from(f.bytes).toString("base64") })),
          urls: reals.map((r) => ({ name: r.name, url: `${server.url}/fixtures/${encodeURIComponent(r.name)}` })),
        },
        { timeoutMs: 800000 },
      );
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(outdir, { recursive: true, force: true });
  }
  console.log(`  browser: ${executablePath}`);

  const diffs = diffResults(expected, actual);
  for (const d of diffs.slice(0, 20)) console.log(`  DIFF ${d}`);
  const e = expected as Record<string, { ok: boolean; code?: string; textLength?: number; chunkCount?: number }>;
  for (const name of Object.keys(e)) {
    const r = e[name];
    console.log(`  ${name}: ${r.ok ? `text ${r.textLength} chars, ${r.chunkCount} chunks` : `refused ${r.code}`}`);
  }
  assert.deepEqual(diffs, []);

  // Node itself must extract the good fixtures and refuse the bad ones with the contracted codes (not equal-by-both-failing).
  assert.equal(e["synthetic-two-pages"].ok, true);
  assert.equal(e["synthetic-image-only"].code, "no_text_layer");
  assert.equal(e["refused-not-a-pdf"].code, "not_a_document");
  assert.equal(e["refused-truncated"].code, "truncated");
  assert.equal(e["refused-garbled"].code, "malformed");
  for (const r of reals) assert.equal(e[r.name].ok, true, `${r.name} extracts in Node`);
});
