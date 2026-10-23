// Phase 9d M1 model-free browser check (no model, no keys, no network
// beyond the app origin): the agent's own tool `execute` path, driven
// through the seam-flag `__uktubAgent.runTool` (as Phase 9a drove the
// worker `callTool` path through `__uktub.client`).
//
// Flow: fresh profile -> create "Phase9d" -> agent `write` of
// `manuscript/sections/01-x.tex` with a sentence -> agent `edit` of
// `main.tex` adding `\input{sections/01-x}` -> agent `compile` ->
// `compiled: true`, the PDF text contains the sentence, and the file is
// still in `/proj` (the Phase 8b crash shape: every agent compile missed
// the new section, then the turn died on a 429).
//
// Run (from the repo root):
//   1. VITE_UKTUB_ACCEPTANCE_SEAMS=1 pnpm --dir web run build
//   2. pnpm --dir web exec vite preview --port 4318   (record the PID)
//   3. node web/e2e/agent-tools-9d.mjs
import fs from "node:fs";
import { launchChromium } from "../../tests-browser/launch.mjs";
import * as UI from "./ui-roundtrip.mjs";

const OUT = "/home/mahmoud/.cache/uktub-bench/hermes-web-phase9d-2026-10-22";
const BASE = "http://localhost:4318/texlyre/";
const PROJECT = "Phase9d";
const SECTION_REL = "manuscript/sections/01-x.tex";
const MARKER = "UKTUB9D";
const SENTENCE = `A fresh section sentence ${MARKER}.`;

const verdict = {};
const mark = (step, ok, detail = "") => {
  verdict[step] = { ok, detail: String(detail).slice(0, 500) };
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`);
  if (!ok) process.exitCode = 1;
};

const { browser } = await launchChromium();
const ctx = await browser.newContext();
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

await pg.goto(BASE, { waitUntil: "load", timeout: 60000 });
await pg.waitForTimeout(9000);
await UI.createProject(pg, BASE, PROJECT);
mark("create", true);

// Open the assistant panel; wait for the agent seam with its tool executes.
await pg.locator('[data-role="agent-toggle"]').click({ timeout: 15000 });
await pg.locator('[data-role="agent-panel"]').waitFor({ timeout: 30000 });
await pg.waitForFunction(
  () => typeof window.__uktubAgent?.runTool === "function" && (window.__uktubAgent.surfaceToolCount ?? 0) > 0,
  undefined,
  { timeout: 60000, polling: 1000 },
);
const toolNames = await pg.evaluate(() => window.__uktubAgent.toolNames);
mark("seam-tools-early", true, `agent builds lazily: [${toolNames.join(",")}]`);

// Agent `write` of the new section file (the file did not exist when the agent was built).
const written = await pg.evaluate(async ({ rel, sentence }) => window.__uktubAgent.runTool("write", { path: rel, content: sentence + "\n" }), { rel: SECTION_REL, sentence: SENTENCE });
mark("agent-write", written.ok && !written.isError, written.text ?? written.error);

// Agent `edit` of main.tex wiring the new section in.
const mainBefore = await UI.readProjFileViaSeam(pg, "manuscript/main.tex");
const edited = await pg.evaluate(
  async (input) => window.__uktubAgent.runTool("edit", { path: "manuscript/main.tex", edits: [{ oldText: input, newText: `\\input{sections/01-x}\n\n${input}` }] }),
  "\\end{document}",
);
mark("agent-edit", edited.ok && !edited.isError, edited.text ?? edited.error);
const mainAfter = await UI.readProjFileViaSeam(pg, "manuscript/main.tex");
mark("edit-wired", mainAfter.includes("\\input{sections/01-x}"), `${mainBefore.length} -> ${mainAfter.length} chars`);

// Agent `compile`: the run that missed the section in Phase 8b.
const compiled = await pg.evaluate(async () => window.__uktubAgent.runTool("compile", {}));
mark("agent-compile", compiled.ok && !compiled.isError, (compiled.text ?? compiled.error ?? "").slice(0, 200));
const toolNamesAfter = await pg.evaluate(() => window.__uktubAgent.toolNames);
mark("seam-tools", toolNamesAfter.includes("write") && toolNamesAfter.includes("edit") && toolNamesAfter.includes("compile"), toolNamesAfter.join(","));
// The agent compile's own PDF bytes must contain the sentence (pulled
// from `/proj`, where the worker finish landed it — no viewer tab state
// involved).
const pdfB64 = await pg.evaluate(async () => (await window.__uktub.client.readFile("build/main.pdf", "base64")).base64);
if (!pdfB64) mark("pdf-bytes", false, "build/main.pdf unreadable");
else {
  fs.writeFileSync(`${OUT}/a9d-main.pdf`, Buffer.from(pdfB64, "base64"));
  const { execFileSync } = await import("node:child_process");
  const pdfText = execFileSync("pdftotext", [`${OUT}/a9d-main.pdf`, "-"], { encoding: "utf8" });
  fs.writeFileSync(`${OUT}/a9d-pdf.txt`, pdfText);
  mark("pdf-bytes", true, `${Buffer.from(pdfB64, "base64").length} bytes`);
  mark("pdf-sentence", pdfText.includes(MARKER), pdfText.slice(0, 200));
}

// The file is still in `/proj` (never deleted, never lost).
const listed = await pg.evaluate(async () => (await window.__uktub.client.listFiles()).files.map((f) => f.path));
const back = await UI.readProjFileViaSeam(pg, SECTION_REL);
mark("proj-kept", listed.includes(SECTION_REL) && back.includes(MARKER), listed.filter((p) => p.includes("sections")).join(","));

// Zero model requests: this check is fully model-free.
const modelReqs = requests.filter((r) => /openrouter\.ai|api\.(openai|anthropic)\.com/.test(r.url));
mark("no-model-requests", modelReqs.length === 0, `${requests.length} requests total`);
const offOrigin = requests.filter((r) => !/^http:\/\/localhost:4318\//.test(r.url));
mark("same-origin", offOrigin.length === 0, offOrigin.slice(0, 3).map((r) => r.url).join(" | "));
mark("console-clean", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/a9d-verdict.json`, JSON.stringify({ verdict, requests: requests.length, consoleErrors }, null, 2));
await browser.close();
console.log(`evidence: ${OUT}/a9d-verdict.json`);
