// Phase 9e screenshots: header (no user menu), Projects list, export modal
// (single format). Model-free, fresh profile.
import { launchChromium } from "../../tests-browser/launch.mjs";
import * as UI from "./ui-roundtrip.mjs";

const OUT = "/home/mahmoud/.cache/uktub-bench/hermes-web-phase9e-2026-10-22";
const BASE = "http://localhost:4318/texlyre/";

const { browser } = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const pg = await ctx.newPage();
await UI.goToList(pg, BASE);
await pg.screenshot({ path: `${OUT}/shot-projects-list.png` });
const header = pg.locator("header[data-role='projects']");
await header.screenshot({ path: `${OUT}/shot-header.png` });
// open the first project into the editor, then open the export modal there
await UI.createProject(pg, BASE, "Shot9e");
await UI.goToList(pg, BASE);
await UI.openFromList(pg, BASE, "Shot9e");
await pg.waitForTimeout(6000);
const exportBtn = pg.getByTitle("Export Current Project");
await exportBtn.first().click({ timeout: 15000 });
await pg.locator("input[name='exportFormat']").first().waitFor({ timeout: 15000 });
await pg.waitForTimeout(1000);
await pg.screenshot({ path: `${OUT}/shot-export-modal.png` });
const radios = await pg.locator("input[name='exportFormat']").count();
const bodyText = await pg.evaluate(() => document.body.innerText);
console.log("exportFormat radios:", radios);
console.log("has 'Guest User':", /Guest User/.test(bodyText));
console.log("has 'Files Only':", /Files Only/.test(bodyText));
console.log("has 'TeXlyre Format':", /TeXlyre Format/.test(bodyText));
await browser.close();
console.log("done");
