// Phase 9c M1: model-free UI round trip for the registry-preserving
// export/import. Fresh profile, real product UI for every step except ONE
// labelled seam write (registry register, which has no product UI path).
// Run: node web/e2e/run-roundtrip-ui.mjs  (keys from the repo .env).
import fs from "node:fs";
import { unzipSync } from "fflate";
import { launchChromium } from "../../tests-browser/launch.mjs";
import * as UI from "./ui-roundtrip.mjs";

const OUT = "/home/mahmoud/.cache/uktub-bench/hermes-web-phase9c-2026-10-22";
const BASE = "http://localhost:4318/texlyre/";
const PROJECT = "Roundtrip";
const DOIS = ["10.48550/arXiv.1706.03762", "10.48550/arXiv.1406.2661"];
const MARKER = "UKTUB9C";

for (const k of ["OPENALEX_API_KEY", "SEMANTIC_SCHOLAR_API_KEY"]) {
  if (!process.env[k]) throw new Error(`missing ${k} in process.env`);
}
const RKEYS = {
  OPENALEX_API_KEY: process.env.OPENALEX_API_KEY,
  SEMANTIC_SCHOLAR_API_KEY: process.env.SEMANTIC_SCHOLAR_API_KEY,
};

const verdict = {};
const mark = (step, ok, detail = "") => {
  verdict[step] = { ok, detail: String(detail).slice(0, 500) };
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`);
  if (!ok) process.exitCode = 1;
};

const { browser } = await launchChromium();
const ctx = await browser.newContext({ acceptDownloads: true });
const pg = await ctx.newPage();
const requests = [];
const consoleErrors = [];
pg.on("request", (r) => requests.push({ url: UI.redactUrl(r.url()), method: r.method() }));
pg.on("response", (res) => {
  const hit = [...requests].reverse().find((q) => q.url === UI.redactUrl(res.url()) && q.status === undefined);
  if (hit) { try { hit.status = res.status(); } catch {} }
});
pg.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 400)); });
pg.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 400)));

// 1. create + open
await pg.goto(BASE, { waitUntil: "load", timeout: 60000 });
await pg.waitForTimeout(9000);
const projId = await UI.createProject(pg, BASE, PROJECT);
mark("rt-create", true, `project ${projId}`);
await UI.openMainTex(pg);

// 2. seed registry through the seam (ONLY seam-performed step, labelled)
await UI.pushResearchKeysViaSeam(pg, RKEYS);
let citekeys = [];
try {
  for (const doi of DOIS) {
    await UI.seedRegistryViaSeam(pg, [doi]);
  }
  const regNow = await UI.registryReadViaSeam(pg);
  const have = ((regNow.records ?? []).map((r) => String(r.doi ?? "").toLowerCase()) ?? []).sort();
  citekeys = [...new Set(((regNow.records ?? []).map((r) => r.citekey ?? r.citeKey).filter(Boolean)))];
  const want = [...DOIS].map((d) => d.toLowerCase()).sort();
  mark("rt-seed", JSON.stringify(have) === JSON.stringify(want) && citekeys.length >= 2, `seeded via seam; registry holds ${JSON.stringify(have)}; citekeys ${citekeys.join(", ")}`);
} catch (e) { mark("rt-seed", false, String(e).slice(0, 200)); }

// 3. cite through the editor + Compile button
const mainTex = [
  "\\documentclass{article}",
  "\\begin{document}",
  `Roundtrip probe ${MARKER} cites \\cite{${citekeys[0] ?? "missing1"}} and \\cite{${citekeys[1] ?? "missing2"}}.`,
  "\\bibliographystyle{plain}",
  "\\bibliography{../refs/references}",
  "\\end{document}",
  "",
].join("\n");
try {
  if (citekeys.length < 2) throw new Error(`seed gave ${citekeys.length} citekeys`);
  await UI.replaceEditorText(pg, mainTex);
  mark("rt-cite", true, `citekeys ${citekeys.join(", ")} typed through the editor`);
} catch (e) { mark("rt-cite", false, String(e).slice(0, 200)); }

let pdfBefore = "";
if (citekeys.length >= 2) {
try {
  pdfBefore = await UI.compileViaButton(pg, { marker: MARKER });
  fs.writeFileSync(`${OUT}/rt-pdf-before.txt`, pdfBefore);
  mark("rt-compile-before", pdfBefore.includes(MARKER) && /\[\d\]/.test(pdfBefore), `${pdfBefore.length} chars, marker + numeric cites`);
} catch (e) { mark("rt-compile-before", false, String(e).slice(0, 200)); }
} else { mark("rt-compile-before", false, "skipped (seed failed)"); }
await pg.screenshot({ path: `${OUT}/rt-compiled.png` });

// 4. Projects list state + export modal -> download
let bibBefore = "";
let doisBefore = [];
try {
  const reg = await UI.registryReadViaSeam(pg);
  doisBefore = ((reg.records ?? []).map((r) => r.doi) ?? []).sort();
  bibBefore = await UI.readProjFileViaSeam(pg, "refs/references.bib");
} catch (e) { mark("rt-state-before", false, String(e).slice(0, 200)); }

let exportPath = `${OUT}/rt-export.zip`;
try {
  const { filename, modalText } = await UI.exportViaModal(pg, exportPath);
  mark("rt-export-copy", modalText.includes("Uktub registry"), modalText.includes("Uktub registry") ? "modal states the registry rides along" : "modal copy lacks the registry note");
  const entries = Object.keys(unzipSync(fs.readFileSync(exportPath)));
  const hasZip = entries.includes(`projects/${projId}/uktub/proj.zip`);
  const hasDb = entries.includes(`projects/${projId}/uktub/registry.db`);
  mark("rt-export", hasZip && hasDb, `${filename}: uktub payload ${hasZip && hasDb ? "present" : "MISSING"} (${entries.length} entries)`);
} catch (e) { mark("rt-export", false, String(e).slice(0, 200)); }
await pg.screenshot({ path: `${OUT}/rt-exported.png` });

// 5. delete via Projects-list UI
try {
  await UI.deleteFromList(pg, BASE, PROJECT);
  const gone = await UI.projectGoneFromList(pg, BASE, PROJECT);
  mark("rt-ui-delete", gone, gone ? "project gone from list (real delete UI)" : "project still listed");
} catch (e) { mark("rt-ui-delete", false, String(e).slice(0, 200)); }

// 6. import modal with the downloaded zip + open
try {
  const err = await UI.importZipViaModal(pg, BASE, exportPath, PROJECT);
  mark("rt-import", !err, err ? `modal error: ${err}` : "archive imported through the import modal");
} catch (e) { mark("rt-import", false, String(e).slice(0, 200)); }

let pdfAfter = "";
try {
  await UI.openFromList(pg, BASE, PROJECT, projId);
  mark("rt-open", true, "re-imported project opened from the list");
} catch (e) { mark("rt-open", false, String(e).slice(0, 200)); }
if (verdict["rt-open"]?.ok) {
try {
  const reg = await UI.registryReadViaSeam(pg);
  const doisAfter = ((reg.records ?? []).map((r) => String(r.doi ?? "").toLowerCase()) ?? []).sort();
  const want = [...DOIS].map((d) => d.toLowerCase()).sort();
  mark("rt-registry-same", JSON.stringify(doisAfter) === JSON.stringify(want) && doisAfter.length === 2, `before ${JSON.stringify(doisBefore)} after ${JSON.stringify(doisAfter)}`);
  const bibAfter = await UI.readProjFileViaSeam(pg, "refs/references.bib");
  mark("rt-bib-identical", bibAfter === bibBefore, `bib ${bibAfter?.length ?? "?"} chars, identical: ${bibAfter === bibBefore}`);
  fs.writeFileSync(`${OUT}/rt-bib-after.bib`, bibAfter ?? "");
} catch (e) { mark("rt-registry-same", false, String(e).slice(0, 200)); }
if (verdict["rt-registry-same"]?.ok) {
try {
  await pg.getByText("main.tex", { exact: false }).first().click({ timeout: 15000 });
  await pg.waitForTimeout(3000);
  pdfAfter = await UI.compileViaButton(pg, { marker: MARKER });
  fs.writeFileSync(`${OUT}/rt-pdf-after.txt`, pdfAfter);
  mark("rt-compile-same-text", UI.samePdfText(pdfAfter, pdfBefore), `after ${pdfAfter.length} chars, same text (hyphenation-normalized): ${UI.samePdfText(pdfAfter, pdfBefore)}`);
} catch (e) { mark("rt-compile-same-text", false, String(e).slice(0, 200)); }
}
}
for (const [s, why] of [["rt-open", "import failed"], ["rt-registry-same", "open failed"], ["rt-bib-identical", "open failed"], ["rt-compile-same-text", "registry check failed"]]) {
  if (verdict[s] === undefined) mark(s, false, `skipped (${why})`);
}
await pg.screenshot({ path: `${OUT}/rt-roundtrip.png` });

// 7. network: no model calls in this script
{
  const origins = {};
  for (const r of requests) { let o; try { o = new URL(r.url).origin; } catch { o = "(unparseable)"; } origins[o] = (origins[o] ?? 0) + 1; }
  const modelReqs = origins["https://openrouter.ai"] ?? 0;
  mark("rt-no-model-requests", modelReqs === 0, `openrouter.ai requests: ${modelReqs}; scholarly: ${Object.entries(origins).filter(([o]) => !o.includes("4318")).map(([o, n]) => `${o}=${n}`).join(", ")}`);
  verdict.modelRequests = modelReqs;
  const realErrs = consoleErrors.filter((e) => !/Failed to load resource|ERR_FAILED|CORS|net::|429|Failed to fetch/i.test(e));
  mark("rt-console", realErrs.length === 0, realErrs.length ? realErrs.slice(0, 3).join(" | ").slice(0, 400) : `${consoleErrors.length} total, all listed noise`);
}
fs.writeFileSync(`${OUT}/rt-requests.json`, JSON.stringify(requests, null, 1));
fs.writeFileSync(`${OUT}/rt-console-errors.json`, JSON.stringify(consoleErrors, null, 1));
{
  const pdfBeforeTxt = fs.existsSync(`${OUT}/rt-pdf-before.txt`) ? fs.readFileSync(`${OUT}/rt-pdf-before.txt`, "utf8") : "";
  const pdfAfterTxt = fs.existsSync(`${OUT}/rt-pdf-after.txt`) ? fs.readFileSync(`${OUT}/rt-pdf-after.txt`, "utf8") : "";
  const hay = [pdfBeforeTxt, pdfAfterTxt, JSON.stringify(verdict)].join("\n");
  let leaked = false;
  for (const [name, val] of Object.entries(RKEYS)) {
    if (val && hay.includes(val)) { mark("rt-leak-scan", false, `key in evidence: ${name}`); leaked = true; }
  }
  if (!leaked) mark("rt-leak-scan", true, "no key in evidence");
}
fs.writeFileSync(`${OUT}/rt-verdict.json`, JSON.stringify(verdict, null, 1));
console.log("DONE");
await browser.close();
