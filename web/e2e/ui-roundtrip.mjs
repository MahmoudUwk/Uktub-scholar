// Shared model-free UI round-trip helpers for the browser MVP (Phase 9c).
// Every step below drives the real product UI (clicks, typing, sends,
// downloads, file inputs). The acceptance seam (window.__uktub, seam-flag
// build) is used ONLY for state reads, plus ONE labelled write:
// seeding the registry (registry register), which has no product UI path.
// Reused by roundtrip-ui.mjs (M1) and full-flow.mjs step 6 (M2).

export const redactUrl = (u) => {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) {
      if (/key|token|auth|secret|signature|mailto/i.test(k)) url.searchParams.set(k, "[redacted]");
    }
    return url.toString().slice(0, 200);
  } catch { return String(u).slice(0, 200); }
};

export async function goToList(pg, base) {
  // Already on the Projects list: stay (a reload would drop memory-only keys, which a user would not do).
  if ((await pg.getByTitle("New Project").count()) > 0) return;
  const back = pg.getByRole("button", { name: /^projects$/i });
  if ((await back.count()) > 0) await back.first().click({ timeout: 15000 });
  else await pg.goto(base, { waitUntil: "load", timeout: 60000 });
  await pg.waitForTimeout(8000);
  await pg.getByTitle("New Project").waitFor({ timeout: 30000 });
}

export async function createProject(pg, base, name) {
  await goToList(pg, base);
  await pg.getByTitle("New Project").click({ timeout: 15000 });
  await pg.locator("#project-name").fill(name);
  await pg.getByRole("button", { name: /create project/i }).last().click({ timeout: 15000 });
  await pg.waitForTimeout(12000);
  const id = await pg.evaluate(() => window.__uktub?.projectId ?? null);
  if (!id) throw new Error(`no __uktub project after creating ${name}`);
  return id;
}

export async function openFromList(pg, base, name, expectId) {
  await goToList(pg, base);
  await pg.waitForFunction((n) => document.body.innerText.includes(n), name, { timeout: 60000, polling: 1000 });
  const found = await pg.evaluate((nm) => {
    const cards = [...document.querySelectorAll("div.ui-card")].filter((c) => (c.innerText || "").includes(nm));
    if (!cards.length) return "no-card";
    const btn = [...cards[0].querySelectorAll("button")].find((b) => /open project/i.test(b.getAttribute("title") || "") || /^open$/i.test((b.innerText || "").trim()));
    if (!btn) return "no-button";
    btn.click();
    return "clicked";
  }, name);
  if (found !== "clicked") throw new Error(`open button for ${name} not found (${found})`);
  if (expectId) {
    await pg.waitForFunction((id) => window.__uktub?.projectId === id && window.__uktub?.status?.kind === "ready", expectId, { timeout: 45000, polling: 1000 });
  } else {
    await pg.waitForFunction(() => window.__uktub?.status?.kind === "ready", undefined, { timeout: 45000, polling: 1000 });
  }
  await pg.waitForTimeout(3000);
}

export async function deleteFromList(pg, base, name) {
  await goToList(pg, base);
  await pg.waitForFunction((n) => document.body.innerText.includes(n), name, { timeout: 60000, polling: 1000 });
  const found = await pg.evaluate((nm) => {
    const cards = [...document.querySelectorAll("div.ui-card")].filter((c) => (c.innerText || "").includes(nm));
    if (!cards.length) return "no-card";
    const btn = [...cards[0].querySelectorAll("button")].find((b) => /delete/i.test(b.getAttribute("title") || "") || /^delete$/i.test((b.innerText || "").trim()));
    if (!btn) return "no-button:" + [...cards[0].querySelectorAll("button")].map((b) => `${b.getAttribute("title")}|${(b.innerText || "").trim()}`).join(";");
    btn.click();
    return "clicked";
  }, name);
  if (found !== "clicked") throw new Error(`delete button for ${name} not found (${found})`);
  await pg.waitForTimeout(2000);
  const confirmed = await pg.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    const ok = btns.find((b) => /^delete( \d+)? projects?$/i.test((b.innerText || "").trim()) || /confirm/i.test((b.innerText || "").trim()));
    if (!ok) return "no-confirm:" + btns.map((b) => (b.innerText || "").trim()).join(";");
    ok.click();
    return "confirmed";
  });
  if (confirmed !== "confirmed") {
    const dlg = pg.getByRole("button", { name: /^delete$/i });
    if ((await dlg.count()) > 0) await dlg.first().click({ timeout: 10000 });
    else throw new Error(`delete confirm not found (${confirmed})`);
  }
  await pg.waitForTimeout(6000);
}

export async function projectGoneFromList(pg, base, name) {
  await goToList(pg, base);
  await pg.waitForFunction((n) => !document.body.innerText.includes(n), name, { timeout: 30000, polling: 1000 }).catch(() => {});
  return pg.evaluate((n) => !document.body.innerText.includes(n), name);
}

export function pdfTextViaViewer(pg) {
  return pg.evaluate(() => [...document.querySelectorAll(".textLayer")].map((el) => el.innerText).join("\n").slice(0, 6000));
}

// Fixed compile wait: differ-from-before plus non-empty (or an expected
// marker), with the timeout actually passed as Playwright options.
export async function compileViaButton(pg, { timeout = 300000, before = null, marker = null } = {}) {
  const prev = before ?? await pdfTextViaViewer(pg);
  await pg.getByTitle("Compile LaTeX (F9)").first().click({ timeout: 15000 });
  await pg.waitForFunction(
    ([p, m]) => {
      const t = [...document.querySelectorAll(".textLayer")].map((el) => el.innerText).join("\n");
      if (m) return t.includes(m);
      return t.trim().length > 0 && t !== p;
    },
    [prev, marker],
    { timeout, polling: 2000 },
  );
  return pdfTextViaViewer(pg);
}

export async function openMainTex(pg) {
  await pg.getByText("main.tex", { exact: false }).first().click({ timeout: 15000 });
  await pg.waitForTimeout(4000);
}

// Replace the whole open editor buffer through the editor UI (select all +
// real key events through CodeMirror).
export async function replaceEditorText(pg, text) {
  await pg.locator(".cm-content").first().click({ timeout: 15000 });
  await pg.keyboard.press("ControlOrMeta+a");
  await pg.waitForTimeout(500);
  await pg.keyboard.type(text, { delay: 2 });
  await pg.waitForTimeout(2000);
}

// The editor sidebar shows one view at a time (Files, Search, History, Assistant): the file tree and its
// toolbar (incl. "Export Current Project") exist only in the Files view, so switch back before using them.
export async function showFiles(pg) {
  const tab = pg.getByTitle("Files", { exact: true });
  if ((await tab.count()) > 0) {
    await tab.first().click({ timeout: 15000 });
    await pg.waitForTimeout(1000);
  }
}

// Projects list / editor export modal (TeXlyre format default) -> download.
// Returns { path, filename }. Throws when the modal reports an error.
export async function exportViaModal(pg, savePath) {
  await showFiles(pg);
  const exportBtn = pg.getByTitle("Export Current Project");
  if ((await exportBtn.count()) > 0) {
    await exportBtn.first().click({ timeout: 15000 });
  } else {
    throw new Error("no Export Current Project button in this view (pass a Projects-list exporter instead)");
  }
  await pg.waitForTimeout(2000);
  // Uktub format is the default; click its card explicitly.
  const uktub = pg.getByText("Uktub Format", { exact: false });
  if ((await uktub.count()) > 0) await uktub.first().click({ timeout: 10000 }).catch(() => {});
  await pg.waitForTimeout(1000);
  const dlPromise = pg.waitForEvent("download", { timeout: 120000 });
  const modalText = await pg.evaluate(() => document.body.innerText.slice(0, 4000));
  await pg.getByRole("button", { name: /Export \d+ Project/ }).first().click({ timeout: 15000 });
  const dl = await dlPromise;
  await dl.saveAs(savePath);
  await pg.waitForTimeout(3000);
  const err = await pg.evaluate(() => {
    const msgs = [...document.querySelectorAll(".ui-message")].filter((e) => /error|failed/i.test(e.className) || e.dataset.tone === "error");
    return msgs.map((e) => (e.innerText || "").slice(0, 300)).join(" | ");
  });
  if (err) throw new Error(`export modal error: ${err}`);
  return { path: savePath, filename: dl.suggestedFilename(), modalText };
}

// Projects list -> Import Projects modal with a zip on disk: scans the
// archive, selects the named project, imports, waits for it to list.
export async function importZipViaModal(pg, base, zipPath, name) {
  await goToList(pg, base);
  await pg.getByTitle("Import Projects").click({ timeout: 15000 });
  await pg.waitForTimeout(2000);
  const input = pg.locator('.import-options input[type="file"], [role="dialog"] input[type="file"], input[type="file"]').first();
  await pg.evaluate(() => {
    const el = document.querySelector('input[type="file"]');
    if (el) el.style.display = "block";
  });
  await input.setInputFiles(zipPath, { timeout: 30000 });
  await pg.waitForFunction((n) => document.body.innerText.includes("Available Projects") && document.body.innerText.includes(n), name, { timeout: 60000, polling: 1000 });
  // Click the name (not the checkbox: row onClick + checkbox onChange
  // would toggle twice) to select the project.
  await pg.evaluate((nm) => {
    const items = [...document.querySelectorAll(".ui-list-item")].filter((c) => (c.innerText || "").includes(nm));
    const row = items[0] ?? null;
    (row?.querySelector("strong") ?? row)?.click?.();
  }, name);
  await pg.waitForTimeout(1000);
  await pg.getByRole("button", { name: /Import \d+ Project/ }).first().click({ timeout: 15000 });
  await pg.waitForFunction((n) => document.body.innerText.includes(n) && !document.body.innerText.includes("Importing"), name, { timeout: 120000, polling: 1000 });
  const err = await pg.evaluate(() => {
    const msgs = [...document.querySelectorAll(".ui-message")].filter((e) => e.dataset.tone === "error");
    return msgs.map((e) => (e.innerText || "").slice(0, 300)).join(" | ");
  }).catch(() => "");
  return err;
}

// ---- seam READS (state only), plus ONE labelled seam write: seeding ----
// Seed the registry with real DOIs (the ONLY seam-performed step; the
// register tool has no product UI path in this flow). Needs research keys
// in the worker env; the caller pushes them first.
export async function seedRegistryViaSeam(pg, dois) {
  return pg.evaluate(async (ids) => {
    const res = await window.__uktub.client.callTool("registry", { action: "register", identifiers: ids });
    return res.structuredContent ?? { raw: JSON.stringify(res).slice(0, 1000) };
  }, dois);
}

export async function pushResearchKeysViaSeam(pg, keys) {
  return pg.evaluate(async (k) => {
    await window.__uktub.client.setEnv({
      SEMANTIC_SCHOLAR_API_KEY: k.SEMANTIC_SCHOLAR_API_KEY,
      OPENALEX_API_KEY: k.OPENALEX_API_KEY,
    });
    return true;
  }, keys);
}

export function registryReadViaSeam(pg) {
  return pg.evaluate(async () => {
    const res = await window.__uktub.client.callTool("registry", { action: "read" });
    return res.structuredContent ?? { raw: JSON.stringify(res).slice(0, 1000) };
  });
}

export function readProjFileViaSeam(pg, rel) {
  return pg.evaluate(async (p) => (await window.__uktub.client.readFile(p)).text, rel);
}

// PDF text from the viewer differs in line-break hyphenation and spacing between renders.
export function samePdfText(a, b) {
  // Viewer text layers and pdftotext differ in spacing, line-end hyphenation and ligatures: compare letters
  // and digits only, after Unicode compatibility normalization.
  const norm = (t) => String(t ?? "").normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");
  return norm(a) === norm(b) && norm(a).length > 0;
}

// The PDF viewer (Previous/Next Page buttons, a "n / N" counter) renders text layers only for pages near
// the visible one: wait for the page count, then step through every page and join each page's text once.
// Both sides of a comparison must use this.
async function viewerPageCount(pg) {
  return pg.evaluate(() => {
    const next = [...document.querySelectorAll('[title="Next Page"]')].find((b) => b.offsetParent !== null);
    let el = next?.parentElement;
    for (let i = 0; el && i < 4; i++, el = el.parentElement) {
      const m = (el.innerText || "").match(/\/\s*(\d+)/);
      if (m) return Number(m[1]);
    }
    return null;
  });
}

export async function pdfAllPagesText(pg, maxPages = 40) {
  let n = null;
  for (let i = 0; i < 30 && !n; i++) {
    n = await viewerPageCount(pg);
    if (!n) await pg.waitForTimeout(500);
  }
  n = Math.min(n ?? 1, maxPages);
  const prev = pg.locator('[title="Previous Page"]:visible').first();
  for (let i = 0; i < n && (await prev.count()) > 0 && (await prev.isEnabled()); i++) {
    await prev.click();
    await pg.waitForTimeout(400);
  }
  // The viewer renders text layers lazily for pages near the visible one (one or several at a time):
  // keep each distinct page text once, in first-seen (page) order.
  const texts = [];
  for (let p = 1; p <= n; p++) {
    await pg.waitForTimeout(1200);
    const layers = await pg.evaluate(() => [...document.querySelectorAll(".textLayer")].map((el) => el.innerText));
    for (const t of layers) if (t.trim() && !texts.includes(t)) texts.push(t);
    if (p < n) {
      const next = pg.locator('[title="Next Page"]:visible').first();
      await next.waitFor({ state: "visible", timeout: 15000 });
      for (let i = 0; i < 40 && !(await next.isEnabled()); i++) await pg.waitForTimeout(500);
      await next.click();
    }
  }
  return texts.join("\n");
}

// Press Compile and read every page. Recompiling an unchanged project may leave the text unchanged, so the
// change-wait is bounded (client policy: 90 s) instead of required.
export async function compileAndReadAll(pg, { waitMs = 90000 } = {}) {
  const prev = await pdfTextViaViewer(pg);
  await pg.getByTitle("Compile LaTeX (F9)").first().click({ timeout: 15000 });
  await pg.waitForFunction(
    (p) => {
      const t = [...document.querySelectorAll(".textLayer")].map((el) => el.innerText).join("\n");
      return t.trim().length > 0 && t !== p;
    },
    prev,
    { timeout: waitMs, polling: 2000 },
  ).catch(() => {});
  await pg.waitForTimeout(3000);
  return pdfAllPagesText(pg);
}

