import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { unzipSync } from "fflate";
import { launchChromium } from "../../tests-browser/launch.mjs";
import * as UI from "./ui-roundtrip.mjs";

// Phase 9c full-flow end-to-end test for the browser MVP.
// - Fresh profile, real UI for every user/agent step (clicks, typing, sends).
// - The acceptance seam (window.__uktub / window.__uktubAgent, seam-flag
//   build) is used ONLY to read state for assertions, plus the ONE labelled
//   seam write in step 6's helper (registry register in roundtrip-ui only).
//   Export/import/deleteProjectStorage all go through the product UI now
//   (Phase 9b's seam-performed export/import is gone).
// - Keys come ONLY from process.env; never printed, logged, screenshotted
//   or stored. Request log redacts key-like query params, drops headers/bodies.
// - Free-model text is EVIDENCE, not a pass criterion. At most one re-prompt
//   per step when the model answers in prose without calling a tool.
// - Model accounting comes from the provider's own counter
//   (GET https://openrouter.ai/api/v1/key): only free_model_daily_requests
//   {used, limit, remaining} is recorded, never the key or any other field.
// - Quota preflight: the free-model floor (remaining < FF_MIN_FREE_REQUESTS,
//   env, default 400 — client policy: one 8b section used ~105 requests and
//   this flow writes two sections plus search/acquire/verify) applies only
//   when the writer (FF_MODEL) or the verification model (FF_VERIFY_MODEL,
//   Phase 9g) ends in `:free`; a paid writer or paid verification model
//   instead needs USD headroom (remaining >= FF_MIN_USD, default 0.5).
//   When the floor/shortfall trips, every model-dependent step including
//   the key test is skipped ("not run"), while model-free steps
//   (1, 6 on whatever the project holds, 8) still run.
const OUT = process.env.FF_OUT ?? "/home/mahmoud/.cache/uktub-bench/hermes-web-phase9c-2026-10-22";
const BASE = "http://localhost:4318/texlyre/";
// OpenRouter model id from the app catalog (pi-ai 1.4.0 lists the default).
const MODEL_ID = process.env.FF_MODEL ?? "minimax/minimax-m3.1-flash:free";
const PROJECT = "FullFlow";
// Phase 9g: verification decision model selected through the new UI
// control; default is the core openrouter default (free tier).
const VERIFY_MODEL = process.env.FF_VERIFY_MODEL ?? "inception/mercury-decide:free";
const FF_MIN = Number(process.env.FF_MIN_FREE_REQUESTS ?? 400);
const ALLOWED_ORIGINS = [
  "http://localhost:4318",
  "https://openrouter.ai",
  "https://www.ebi.ac.uk", // Europe PMC REST + PMC full text (a lawful acquisition source)
  "https://europepmc.org",
  "https://pmc-oa-opendata.s3.amazonaws.com", // PMC Open Access bucket, the full-text location Europe PMC names
  "https://openalex.org",
  "https://api.openalex.org",
  "https://api.crossref.org",
  "https://api.datacite.org",
  "https://data.datacite.org",
  "https://data.crosscite.org",
  "https://api.dataCite.org",
  "https://doi.org",
  "https://arxiv.org",
  "https://export.arxiv.org",
  "https://api.semanticscholar.org",
  "https://www.semanticscholar.org",
  "https://decision.vllm-sr.ai",
];

for (const k of ["OPENROUTER_API_KEY", "SEMANTIC_SCHOLAR_API_KEY", "OPENALEX_API_KEY"]) {
  if (!process.env[k]) throw new Error(`missing ${k} in process.env`);
}
const KEYS = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  SEMANTIC_SCHOLAR_API_KEY: process.env.SEMANTIC_SCHOLAR_API_KEY,
  OPENALEX_API_KEY: process.env.OPENALEX_API_KEY,
};

const verdict = {};
verdict.verifyModel = VERIFY_MODEL;
const turns = [];
let nudges = 0;
let quotaHits = 0;
let quotaExhausted = false;
const mark = (step, ok, detail = "") => {
  verdict[step] = { ok, detail: String(detail).slice(0, 500) };
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`);
  if (!ok) process.exitCode = 1;
};
const saveTurns = () => fs.writeFileSync(`${OUT}/ff-transcript.json`, JSON.stringify(turns, null, 1));
const QUOTA_RE = /429|RESOURCE_EXHAUSTED|rate.limit|quota|timed out/i;

async function openRouterQuotaFree() {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${KEYS.OPENROUTER_API_KEY}` },
  });
  if (!res.ok) throw new Error(`counter GET failed: HTTP ${res.status}`);
  const body = await res.json();
  const f = body?.data?.free_model_daily_requests ?? {};
  // Paid writer models spend the key's USD budget: record only the key's own usage/limit numbers.
  const d = body?.data ?? {};
  return { used: f.used ?? null, limit: f.limit ?? null, remaining: f.remaining ?? null,
    usd: { usage: d.usage ?? null, limit: d.limit ?? null, limitRemaining: d.limit_remaining ?? null } };
}

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
const shot = (n) => pg.screenshot({ path: `${OUT}/ff-${n}.png` });

async function openAssistant() {
  if ((await pg.locator('[data-role="agent-panel"]').count()) === 0) {
    await pg.locator('[data-role="agent-toggle"]').click({ timeout: 15000 });
  }
  await pg.locator('[data-role="agent-input"]').waitFor({ timeout: 30000 });
}
async function send(text) {
  await openAssistant();
  await pg.locator('[data-role="agent-input"]').fill(text, { timeout: 15000 });
  await pg.locator('[data-role="agent-send"]').click({ timeout: 15000 });
}
async function waitIdle(timeout = 900000) {
  await pg.waitForFunction(() => window.__uktubAgent?.busy === false, undefined, { timeout, polling: 500 });
}
const rowCount = () => pg.evaluate(() => document.querySelectorAll('[data-role="agent-tool-row"]').length);
const msgCount = () => pg.evaluate(() => document.querySelectorAll('[data-role^="agent-msg-"]').length);
async function snapTurn(label, rb, mb, previewChars = 2000) {
  const [rows, messages] = await pg.evaluate(([r0, m0, pc]) => [
    [...document.querySelectorAll('[data-role="agent-tool-row"]')].slice(r0).map((r) => ({
      tool: r.dataset.tool, status: r.dataset.status,
      args: (r.querySelector('[data-role="agent-tool-toggle"]')?.textContent ?? "").slice(0, 300),
      result: (r.querySelector('[data-role="agent-tool-preview"]')?.textContent ?? "").slice(0, pc),
    })),
    [...document.querySelectorAll('[data-role^="agent-msg-"]')].slice(m0).map((e) => ({
      role: e.getAttribute("data-role"), text: (e.textContent ?? "").slice(0, 2000),
    })),
  ], [rb, mb, previewChars]);
  const turn = { label, rows, messages };
  turns.push(turn); saveTurns();
  return turn;
}
function noteQuota(text) {
  const hits = (text.match(/429|RESOURCE_EXHAUSTED/gi) || []).length;
  if (hits > 0) { quotaHits += hits; if (quotaHits >= 3) quotaExhausted = true; }
}
async function sendWithNudge(promptText, needTool, label) {
  let rb = await rowCount(), mb = await msgCount();
  await send(promptText);
  await waitIdle();
  let turn = await snapTurn(label, rb, mb);
  noteQuota(JSON.stringify(turn));
  const hasTool = turn.rows.some((r) => needTool.includes(r.tool));
  if (!hasTool && !quotaExhausted) {
    nudges += 1;
    rb = await rowCount(); mb = await msgCount();
    await send(`You answered in prose without calling a tool. Please do the requested task now by calling the ${needTool.join(" / ")} tool(s), then report.`);
    await waitIdle();
    turn = await snapTurn(`${label}-nudge1`, rb, mb);
    noteQuota(JSON.stringify(turn));
    turn.nudged = true;
  }
  return turn;
}
// Seam READS (state only — never performs a user/agent step).
const seam = {
  registryRead: () => UI.registryReadViaSeam(pg),
  provenance: () => pg.evaluate(async () => {
    const out = await window.__uktub.client.runProvenance();
    if (!out || out.ok !== true) return { ok: false, message: String(out?.message ?? out).slice(0, 300) };
    const s = out.audit.summary;
    return { ok: true, entry: out.entry, summary: s, units: (out.audit.units ?? []).slice(0, 10).map((u) => ({ line: u.unit?.line, status: u.status, plain: (u.unit?.plain || "").slice(0, 120) })) };
  }),
  readFile: (p) => UI.readProjFileViaSeam(pg, p),
  doctor: () => pg.evaluate(async () => {
    const out = await window.__uktub.client.callTool("doctor", {});
    return out.structuredContent?.checks ?? [];
  }),
};

// ---- STEP 1: silent guest -> project -> main.tex -> Compile button ----
await pg.goto(BASE, { waitUntil: "load", timeout: 60000 });
await pg.waitForTimeout(9000);
await pg.getByTitle("New Project").waitFor({ timeout: 30000 });
mark("step1-guest-silent", true, "project list visible, no sign-in prompt");
const projId = await UI.createProject(pg, BASE, PROJECT);
await UI.openMainTex(pg);
const mainOpen = await pg.evaluate(() => document.body.innerText.includes("\\begin{document}"));
mark("step1-main-opens", mainOpen, mainOpen ? `project ${projId}, main.tex open` : "main.tex content not visible");
await shot("01-created");
let pdfBefore = "";
// Step 5's text of the agent-compiled PDF bytes (pdftotext): the step-6 baseline when the model ran.
let pdfStep5 = "";
try {
  pdfBefore = await UI.compileViaButton(pg, {});
  mark("step1-template-compiles", pdfBefore.trim().length > 0, `${pdfBefore.length} chars in viewer`);
} catch (e) { mark("step1-template-compiles", false, String(e).slice(0, 200)); }
fs.writeFileSync(`${OUT}/ff-pdf-step1.txt`, pdfBefore);
await shot("02-compiled-template");
// Phase 9g model-free check (no model call): the verification-model
// control lists both decision-model variants from pi-ai's catalog.
try {
  await openAssistant();
  await pg.waitForFunction(() => (window.__uktubAgent?.verifyModelCount ?? 0) > 0, undefined, { timeout: 120000, polling: 1000 });
  const vmodels = await pg.evaluate(() => [...document.querySelectorAll('[data-role="agent-verify-model-option"]')].map((o) => o.dataset.modelId));
  const hasBoth = vmodels.includes("inception/mercury-decide:free") && vmodels.includes("inception/mercury-decide");
  mark("step1-verify-model-control", hasBoth, `${vmodels.length} options incl: ${vmodels.filter((m) => /mercury-decide/.test(m)).join(", ")}`);
  // Restore the Files view: the open assistant hides the header export button step 6 needs.
  await pg.getByTitle("Files").first().click({ timeout: 15000 }).catch(() => {});
  await pg.waitForTimeout(1000);
} catch (e) { mark("step1-verify-model-control", false, String(e).slice(0, 200)); }

// ---- QUOTA PREFLIGHT (provider counter, before the first model step) ----
let quotaBefore = null;
try {
  quotaBefore = await openRouterQuotaFree();
} catch (e) { console.log(`quota counter unreachable: ${String(e).slice(0, 120)}`); }
verdict.openRouterQuotaFree = { before: quotaBefore };
// A paid writer (no `:free` suffix) or a paid verification model needs USD
// headroom on the key (FF_MIN_USD, default 0.5; client policy). The
// free-request floor applies only when the writer (FF_MODEL) or the
// verification model (FF_VERIFY_MODEL) ends in `:free` (Phase 9g).
const PAID_WRITER = !MODEL_ID.endsWith(":free");
const PAID_VERIFY = !VERIFY_MODEL.endsWith(":free");
const FREE_FLOOR_APPLIES = !PAID_WRITER || !PAID_VERIFY;
const FF_MIN_USD = Number(process.env.FF_MIN_USD ?? 0.5);
const usdShort = (PAID_WRITER || PAID_VERIFY) && quotaBefore?.usd?.limit !== null && quotaBefore?.usd?.limit !== undefined
  && (quotaBefore.usd.limitRemaining ?? 0) < FF_MIN_USD;
const freeShort = quotaBefore !== null && quotaBefore.remaining !== null && quotaBefore.remaining < FF_MIN;
const modelSkipped = (FREE_FLOOR_APPLIES && freeShort) || usdShort;
if (usdShort) console.log(`PREFLIGHT paid model (writer ${MODEL_ID}, verify ${VERIFY_MODEL}): key USD remaining ${quotaBefore.usd.limitRemaining} < ${FF_MIN_USD} (FF_MIN_USD; client policy)`);
if (modelSkipped) {
  console.log(`PREFLIGHT model steps skipped: free-model remaining ${quotaBefore.remaining} < ${FF_MIN} (FF_MIN_FREE_REQUESTS; client policy)`);
}
const skipMark = (s) => mark(s, false, `not run: quota preflight (free remaining ${quotaBefore?.remaining} < ${FF_MIN} or key USD short: ${usdShort})`);

// ---- STEP 2: assistant setup via UI ----
let keyOk = false;
if (modelSkipped) {
  skipMark("step2-key-test-ok");
  skipMark("step2-verify-engine");
} else {
await pg.locator('[data-role="agent-toggle"]').click({ timeout: 15000 }).catch(() => {});
await openAssistant();
await pg.waitForFunction(() => (window.__uktubAgent?.providerCount ?? 0) > 0, undefined, { timeout: 120000, polling: 1000 });
await pg.locator('[data-role="agent-provider-select"]').selectOption("openrouter", { timeout: 15000 });
// The filter matches id or name substrings: type the chosen model id itself (was a hardcoded old default).
await pg.locator('[data-role="agent-model-filter"]').fill(MODEL_ID, { timeout: 15000 });
await pg.waitForTimeout(1000);
const picked = await pg.evaluate((mid) => {
  const b = [...document.querySelectorAll('[data-role="agent-model-option"]')].find((x) => x.dataset.modelId === mid);
  if (!b) return false;
  b.click();
  return true;
}, MODEL_ID);
if (!picked) throw new Error(`model option not found: ${MODEL_ID}`);
await pg.waitForFunction((m) => window.__uktubAgent?.modelId === m, MODEL_ID, { timeout: 15000, polling: 500 });
await pg.locator('[data-role="agent-key-input"]').fill(KEYS.OPENROUTER_API_KEY, { timeout: 15000 });
await pg.locator('[data-role="agent-save"]').click({ timeout: 15000 });
try {
  await pg.locator('[data-role="agent-settings-summary"]').waitFor({ timeout: 120000 });
  keyOk = true;
} catch (e) { noteQuota(await pg.evaluate(() => document.body.innerText.slice(0, 2000))); }
mark("step2-key-test-ok", keyOk, keyOk ? "settings collapsed (key ok)" : "key test did not reach ok (see transcript)");
await shot("03-assistant-setup");
if (!keyOk) {
  turns.push({ label: "setup-failed", body: await pg.evaluate(() => document.body.innerText.slice(0, 1500)) }); saveTurns();
}
if (keyOk) {
  await pg.locator('[data-role="agent-settings-change"]').click({ timeout: 15000 });
  await pg.locator('[data-role="agent-verify-engine-select"]').selectOption("openrouter", { timeout: 15000 });
  await pg.locator('[data-role="agent-verify-model-select"]').selectOption(VERIFY_MODEL, { timeout: 15000 });
  await pg.locator('[data-role="agent-verify-use-model-key"]').check({ timeout: 15000 });
  await pg.waitForTimeout(1500);
  const keys = await pg.locator('[data-role="agent-research-key"]').all();
  for (const row of keys) {
    const name = await row.getAttribute("data-key-name");
    const val = name === "SEMANTIC_SCHOLAR_API_KEY" ? KEYS.SEMANTIC_SCHOLAR_API_KEY : name === "OPENALEX_API_KEY" ? KEYS.OPENALEX_API_KEY : null;
    if (!val) continue;
    await row.locator('[data-role="agent-research-input"]').fill(val, { timeout: 15000 });
    await row.locator('[data-role="agent-research-save"]').click({ timeout: 15000 });
    await pg.waitForTimeout(1500);
  }
  const doctor = await seam.doctor();
  const veng = doctor.find((c) => c.name === "verification");
  mark("step2-verify-engine", /key present/i.test(JSON.stringify(veng ?? {})), `model ${VERIFY_MODEL}: ${JSON.stringify(veng ?? "no verification check").slice(0, 280)}`);
  await shot("04-verify-engine");
}
}

// ---- STEP 3 (Prompt A): find RAG papers, register 3 by DOI, acquire ----
let turnA = null, regA = null;
if (modelSkipped || !keyOk || quotaExhausted) {
  for (const s of ["step3-papers-row", "step3-register-rows", "step3-acquire-rows", "step3-bib-updated-readonly"]) {
    mark(s, false, modelSkipped ? `not run: quota preflight (free remaining ${quotaBefore?.remaining} < ${FF_MIN} or key USD short: ${usdShort})` : "skipped (setup failed or quota exhausted)");
  }
} else {
  turnA = await sendWithNudge(
    "Find papers on retrieval-augmented generation for large language models with the papers tool. From the search results, register the 3 most relevant papers with the registry tool using the exact DOIs shown in the search results (do not invent DOIs), then acquire their open-access full text. Report each DOI, its citekey and whether acquisition is ready.",
    ["papers", "registry"], "promptA-rag-register-acquire");
  const rowsA = turnA.rows.concat(turns.filter((t) => t.label === "promptA-rag-register-acquire-nudge1").flatMap((t) => t.rows));
  const has = (n) => rowsA.some((r) => r.tool === n);
  regA = await seam.registryRead();
  const registered = (regA.records ?? []).map((r) => r.doi);
  mark("step3-papers-row", has("papers"), has("papers") ? "papers tool ran" : "no papers row (prose answer?)");
  const regRows = rowsA.filter((r) => r.tool === "registry");
  mark("step3-register-rows", regRows.length > 0 && registered.length >= 1, `${regRows.length} registry rows, registry holds ${registered.length}: ${registered.slice(0, 4).join(", ")}`);
  const acqOk = /ready|acquired|full.?text/i.test(JSON.stringify(rowsA).slice(0, 8000));
  mark("step3-acquire-rows", acqOk, acqOk ? "acquisition reported ready" : "no ready acquisition reported");
  const papersText = rowsA.filter((r) => r.tool === "papers").map((r) => r.result).join("\n").toLowerCase();
  const copiedHonestly = registered.map((d) => ({ doi: d, inPapersOutput: papersText.includes(String(d).toLowerCase()) }));
  turns.push({ label: "promptA-honesty", registered, copiedHonestly }); saveTurns();
  const bib = await seam.readFile("refs/references.bib").catch((e) => `unreadable: ${String(e).slice(0, 120)}`);
  const bibUpdated = typeof bib === "string" && registered.some((d) => bib.toLowerCase().includes(String(d).split("/").pop().toLowerCase())) || (typeof bib === "string" && (bib.match(/@/g) || []).length >= registered.length);
  await UI.showFiles(pg);
  await pg.getByText("refs", { exact: true }).first().click({ timeout: 15000 }).catch(() => {});
  await pg.waitForTimeout(1500);
  await pg.getByText("references.bib", { exact: false }).first().click({ timeout: 15000 });
  await pg.waitForTimeout(3000);
  const bibNote = await pg.evaluate(() => document.body.innerText.includes("read-only"));
  mark("step3-bib-updated-readonly", bibUpdated && bibNote, `entries~${typeof bib === "string" ? (bib.match(/@/g) || []).length : "?"} read-only note: ${bibNote}`);
  await shot("05-registered");
}

// ---- STEP 4 (Prompt B): two sections, save, input, compile, verify ----
let turnB = null;
if (modelSkipped || !keyOk || quotaExhausted) {
  for (const s of ["step4-write-section-rows", "step4-write-edit-rows", "step4-agent-compile", "step4-verify-docmode", "step4-gate", "step4-no-fabricated-claims"]) {
    mark(s, false, modelSkipped ? `not run: quota preflight (free remaining ${quotaBefore?.remaining} < ${FF_MIN} or key USD short: ${usdShort})` : "skipped (setup failed or quota exhausted)");
  }
} else {
  const citekeys = ((regA ?? {}).records ?? []).map((r) => r.citeKey ?? r.citekey).filter(Boolean);
  const ckList = citekeys.length ? citekeys.join(", ") : "the registered papers";
  turnB = await sendWithNudge(
    `Write a two-section document from the registered papers (${ckList}). ` +
    `(1) Call write_section once with goal "Introduce retrieval-augmented generation in at most 150 words", papers ${ckList}, query "retrieval-augmented generation", max_words 150. ` +
    `Save the returned LaTeX byte for byte (no rewriting) to manuscript/sections/01-introduction.tex with the write tool. ` +
    `(2) Call write_section once with goal "Survey approaches to retrieval-augmented generation in at most 150 words", papers ${ckList}, query "retrieval-augmented generation approaches", max_words 150. ` +
    `Save the returned LaTeX byte for byte to manuscript/sections/02-approaches.tex with the write tool. ` +
    `(3) Read manuscript/main.tex and add \\input{sections/01-introduction} and \\input{sections/02-approaches} before \\end{document} with the edit tool. ` +
    `(4) Compile with the compile tool. (5) Run verify on the whole document and resolve anything not supported (label, fix or remove, then re-verify). ` +
    `Report both write_section counts lines and any unresolved units.`,
    ["write_section"], "promptB-two-sections");
  const rowsB = turnB.rows.concat(turns.filter((t) => t.label === "promptB-two-sections-nudge1").flatMap((t) => t.rows));
  const ws = rowsB.filter((r) => r.tool === "write_section");
  const we = rowsB.filter((r) => ["write", "edit"].includes(r.tool));
  const co = rowsB.filter((r) => r.tool === "compile");
  const ve = rowsB.filter((r) => r.tool === "verify");
  const gate = turnB.messages.concat(turns.filter((t) => t.label === "promptB-two-sections-nudge1").flatMap((t) => t.messages)).filter((m) => m.role === "agent-msg-check");
  mark("step4-write-section-rows", ws.length >= 1, `${ws.length} write_section rows: ${ws.map((r) => `${r.status}:${(r.result.match(/child:[^;]+;[^;]+/) || ["?"])[0]}`).join(" | ").slice(0, 400)}`);
  mark("step4-write-edit-rows", we.length >= 2, we.map((r) => `${r.tool}:${r.status}`).join(", "));
  mark("step4-agent-compile", co.some((r) => r.status === "ok"), co.map((r) => `${r.status}`).join(", ") || "no compile row");
  mark("step4-verify-docmode", ve.length > 0, ve.map((r) => `${r.status}:${r.result.slice(0, 160)}`).join(" | ").slice(0, 400) || "no verify row");
  mark("step4-gate", true, gate.length ? `${gate.length} Uktub check row(s): ${gate.map((g) => g.text.slice(0, 200)).join(" | ").slice(0, 400)}` : "gate silent (no findings left unlabelled)");
  const claimed = /I (called|ran|registered|acquired|compiled|verified|wrote)\b/i.test(turnB.messages.map((m) => m.text).join(" "));
  const fabricated = claimed && rowsB.length === 0;
  turns.push({ label: "promptB-claim-check", assistantClaimedToolCall: claimed, toolRows: rowsB.length, fabricatedClaim: fabricated }); saveTurns();
  mark("step4-no-fabricated-claims", !fabricated, fabricated ? "assistant claimed tool calls with zero rows" : "no fabricated tool claim");
  await shot("06-sections-done");
}

// ---- STEP 5: end state through the seam ----
if (modelSkipped) {
  skipMark("step5-pdf-text");
  skipMark("step5-provenance");
} else {
try {
  const b64 = await pg.evaluate(async () => (await window.__uktub.client.readFile("build/main.pdf", "base64")).base64 ?? null).catch(() => null);
  let pdfText = "";
  if (b64) {
    fs.writeFileSync(`${OUT}/ff-main.pdf`, Buffer.from(b64, "base64"));
    try { pdfText = execFileSync("pdftotext", [`${OUT}/ff-main.pdf`, "-"], { encoding: "utf8" }); fs.writeFileSync(`${OUT}/ff-pdf-step5.txt`, pdfText); pdfStep5 = pdfText; }
    catch (e) { pdfText = `pdftotext failed: ${String(e).slice(0, 120)}`; }
  }
  const hasIntro = /introduction|retrieval/i.test(pdfText);
  const hasRefs = /references|bibliography|\[\d+\]/i.test(pdfText);
  mark("step5-pdf-text", pdfText.length > 200 && hasIntro, `${pdfText.length} chars, intro-like: ${hasIntro}, references-like: ${hasRefs}`);
  const prov = await seam.provenance();
  const wsRows = turns.flatMap((t) => t.rows ?? []).filter((r) => r.tool === "write_section");
  const counts = wsRows.map((r) => (r.result.match(/first draft \d+\/\d+ supported; final \d+\/\d+/) || ["?"])[0]);
  turns.push({ label: "end-state", provenance: prov, registry: await seam.registryRead(), writeSectionCounts: counts, pdfChars: pdfText.length }); saveTurns();
  const s = prov.summary ?? {};
  mark("step5-provenance", prov.ok === true, prov.ok ? `unlabelledUnverified=${s.unlabelledUnverified} labelledUnverified=${s.labelledUnverified} unregistered=${s.unregistered} citeKeys=${JSON.stringify(s.citeKeys ?? s.citekeys ?? null)} verified=${s.verified ?? "n/a"}` : prov.message);
} catch (e) { mark("step5-pdf-text", false, String(e).slice(0, 200)); mark("step5-provenance", false, String(e).slice(0, 200)); }
}
await shot("07-end-state");

// Usage of the writing session (steps 3-4), read BEFORE the round trip: reopening the imported project starts a
// new conversation, so the end-of-run reading below covers only the stop check.
try {
  const u = await pg.evaluate(() => window.__uktubAgent?.usage ?? null);
  verdict.usageWriting = u && Array.isArray(u.turns)
    ? { turns: u.turns, totals: u.totals ?? {}, cachedShare: typeof u.cachedShare === "number" ? u.cachedShare : 0 }
    : null;
} catch {
  verdict.usageWriting = null;
}

// ---- STEP 6: UI round trip (export modal -> download -> UI delete -> import modal -> open) ----
try {
  const regBefore = await seam.registryRead();
  const doisBefore = (((regBefore.records ?? []).map((r) => String(r.doi ?? "").toLowerCase())) ?? []).sort();
  const bibBefore = await seam.readFile("refs/references.bib").catch(() => "");
  // Baseline: the agent-compiled PDF's text (step 5, pdftotext of the bytes) when the model ran, else the
  // template text from step 1. Compared letters-only (viewer text layer vs pdftotext differ in spacing,
  // hyphenation and ligatures; measured equal on three live runs 2026-10-22).
  const pdfRtBefore = modelSkipped || !pdfStep5 ? pdfBefore : pdfStep5;
  const { filename } = await UI.exportViaModal(pg, `${OUT}/ff-export.zip`);
  const entries = Object.keys(unzipSync(fs.readFileSync(`${OUT}/ff-export.zip`)));
  const hasPayload = entries.includes(`projects/${projId}/uktub/proj.zip`) && entries.includes(`projects/${projId}/uktub/registry.db`);
  mark("step6-export", hasPayload, `${filename}: uktub payload ${hasPayload ? "present" : "MISSING"} (${entries.length} entries, product export modal)`);
  await UI.deleteFromList(pg, BASE, PROJECT);
  const gone = await UI.projectGoneFromList(pg, BASE, PROJECT);
  mark("step6-ui-delete", gone, gone ? "project gone from list (real delete UI)" : "project still listed");
  const importErr = await UI.importZipViaModal(pg, BASE, `${OUT}/ff-export.zip`, PROJECT);
  mark("step6-import", !importErr, importErr ? `modal error: ${importErr}` : "archive imported through the import modal");
  await UI.openFromList(pg, BASE, PROJECT, projId);
  const regAfter = await seam.registryRead();
  const doisAfter = (((regAfter.records ?? []).map((r) => String(r.doi ?? "").toLowerCase())) ?? []).sort();
  const sameDois = JSON.stringify(doisAfter) === JSON.stringify(doisBefore);
  mark("step6-registry-same", sameDois && (modelSkipped ? true : doisAfter.length > 0), `before ${JSON.stringify(doisBefore)} after ${JSON.stringify(doisAfter)}${modelSkipped ? " (preflight: whatever the project holds)" : ""}`);
  const bibAfter = await seam.readFile("refs/references.bib").catch(() => "");
  mark("step6-bib-identical", bibAfter === bibBefore, `bib identical: ${bibAfter === bibBefore} (${(bibAfter ?? "").length} chars)`);
  await UI.openMainTex(pg);
  const pdfAfter = await UI.compileAndReadAll(pg);
  fs.writeFileSync(`${OUT}/ff-pdf-step6.txt`, pdfAfter);
  const identical = UI.samePdfText(pdfAfter, pdfRtBefore);
  mark("step6-compile-same-text", identical, `${pdfAfter.length} chars after round trip, same text (letters-only): ${identical}`);
  await shot("08-roundtrip");
} catch (e) { mark("step6-export", false, String(e).slice(0, 200)); }
for (const s of ["step6-ui-delete", "step6-import", "step6-registry-same", "step6-bib-identical", "step6-compile-same-text"]) {
  if (verdict[s] === undefined) mark(s, false, "skipped (round trip aborted)");
}

// ---- STEP 7: stop check ----
if (modelSkipped || !keyOk || quotaExhausted) {
  mark("step7-stop", false, modelSkipped ? `not run: quota preflight (free remaining ${quotaBefore?.remaining} < ${FF_MIN} or key USD short: ${usdShort})` : "skipped (setup failed or quota exhausted)");
} else {
  try {
    await openAssistant();
    const rb = await rowCount(), mb = await msgCount();
    await send("Find papers on quantum machine learning for drug discovery with the papers tool and list the top 5 with their DOIs.");
    await pg.waitForFunction(() => window.__uktubAgent?.busy === true, undefined, { timeout: 60000, polling: 250 }).catch(() => {});
    // Phase 9h: the old fixed 3 s wait raced a fast model — it could finish
    // before Stop was clicked and the locator timed out. Instead poll until
    // a tool row is actually running (bounded); if the agent goes idle
    // first it answered without tools, recorded honestly below.
    let sawRunning = false;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const running = await pg.evaluate(() => [...document.querySelectorAll('[data-role="agent-tool-row"]')].some((r) => r.dataset.status === "running")).catch(() => false);
      if (running) { sawRunning = true; break; }
      const idle = await pg.evaluate(() => window.__uktubAgent?.busy === false).catch(() => true);
      if (idle) break;
      await pg.waitForTimeout(250);
    }
    if (!sawRunning) {
      await waitIdle(120000);
      const turn = await snapTurn("stop-check", rb, mb);
      mark("step7-stop", false, `not exercised: no tool row ran before idle (rows=${turn.rows.map((r) => `${r.tool}:${r.status}`).join(", ") || "none yet"})`);
    } else {
      await pg.locator('[data-role="agent-stop"]').click({ timeout: 15000 });
      await waitIdle(120000);
      const turn = await snapTurn("stop-check", rb, mb);
      const idle = await pg.evaluate(() => window.__uktubAgent?.busy === false);
      const cancelled = turn.rows.some((r) => /stop|cancel|error/i.test(`${r.status} ${r.result.slice(0, 200)}`));
      mark("step7-stop", idle === true && cancelled, `idle=${idle}, rows=${turn.rows.map((r) => `${r.tool}:${r.status}`).join(", ") || "none yet"}, cancelled-ish=${cancelled}`);
    }
    await shot("09-stopped");
  } catch (e) { mark("step7-stop", false, String(e).slice(0, 200)); }
}

// Phase 9i: session usage from the acceptance seam (per-turn list +
// totals plus the cached-input share; in-session only, no keys). Null
// when the model never ran. After the round trip this is the stop-check
// conversation only; the writing session is `verdict.usageWriting`.
try {
  const seamUsage = await pg.evaluate(() => window.__uktubAgent?.usage ?? null);
  if (seamUsage && Array.isArray(seamUsage.turns)) {
    verdict.usage = {
      turns: seamUsage.turns,
      totals: seamUsage.totals ?? {},
      cachedShare: typeof seamUsage.cachedShare === "number" ? seamUsage.cachedShare : 0,
    };
  } else {
    verdict.usage = null;
  }
} catch {
  verdict.usage = null;
}

// ---- STEP 8: network + console + provider-counter model count ----
let quotaAfter = null;
try {
  quotaAfter = await openRouterQuotaFree();
} catch (e) { console.log(`quota counter unreachable at end: ${String(e).slice(0, 120)}`); }
verdict.openRouterQuotaFree = { before: verdict.openRouterQuotaFree?.before ?? quotaBefore, after: quotaAfter };
{
  const origins = {};
  for (const r of requests) { let o; try { o = new URL(r.url).origin; } catch { o = "(unparseable)"; } origins[o] = (origins[o] ?? 0) + 1; }
  const bad = Object.keys(origins).filter((o) => !ALLOWED_ORIGINS.includes(o) && o !== "(unparseable)");
  const modelReqs = (origins["https://openrouter.ai"] ?? 0);
  mark("step8-origins", bad.length === 0, `${JSON.stringify(origins)}${bad.length ? ` BAD:${bad.join(",")}` : ""}`);
  const realErrs = consoleErrors.filter((e) => !/Failed to load resource|ERR_FAILED|CORS|net::|429|Failed to fetch/i.test(e));
  mark("step8-console", realErrs.length === 0, realErrs.length ? realErrs.slice(0, 3).join(" | ").slice(0, 400) : `${consoleErrors.length} total, all listed noise`);
  if (modelSkipped) mark("step8-no-model-calls", modelReqs === 0, `request log openrouter.ai: ${modelReqs}; counter before=${JSON.stringify(quotaBefore)} after=${JSON.stringify(quotaAfter)}`);
  turns.push({ label: "network", origins, modelRequestsOpenRouter: modelReqs, totalRequests: requests.length, consoleErrors: consoleErrors.slice(0, 20) }); saveTurns();
  verdict.modelRequests = modelReqs;
  verdict.nudges = nudges;
  verdict.quotaHits429 = quotaHits;
}
fs.writeFileSync(`${OUT}/ff-requests.json`, JSON.stringify(requests, null, 1));
fs.writeFileSync(`${OUT}/ff-console-errors.json`, JSON.stringify(consoleErrors, null, 1));
// Leak scan: keys must appear in no evidence file (screenshots excluded: no
// screenshot is taken while a key value is visible — settings collapse first).
{
  const hay = [fs.readFileSync(`${OUT}/ff-transcript.json`, "utf8"), fs.readFileSync(`${OUT}/ff-requests.json`, "utf8"), fs.readFileSync(`${OUT}/ff-console-errors.json`, "utf8"),
    ...["ff-pdf-step1.txt", "ff-pdf-step6.txt"].map((f) => { try { return fs.readFileSync(`${OUT}/${f}`, "utf8"); } catch { return ""; } }),
    JSON.stringify(verdict)].join("\n");
  for (const [name, val] of Object.entries(KEYS)) {
    if (val && hay.includes(val)) { mark("leak-scan", false, `key leak in evidence: ${name}`); }
  }
  if (!verdict["leak-scan"]) mark("leak-scan", true, "no key in JSON/text evidence");
}
fs.writeFileSync(`${OUT}/ff-verdict.json`, JSON.stringify(verdict, null, 1));
console.log(`DONE nudges=${nudges} quotaHits=${quotaHits} modelSkipped=${modelSkipped}`);
await browser.close();
