/**
 * Phase 9f tripwire: the hosted verifier is not reachable from a page.
 *
 * Measured 2026-10-22 from real Chromium: `OPTIONS` to
 * `https://decision.vllm-sr.ai/v1/systemone` returns 405, the 401 to a
 * POST carries no `Access-Control-Allow-Origin`, and both a preflighted
 * and a simple POST report "Failed to fetch". So the browser offers only
 * `openrouter` (`BROWSER_VERIFICATION_ENGINES`).
 *
 * Real-network check, model-free (no key, no verdict: the preflight
 * fails before any model could run). A page `fetch` with an
 * `authorization` header (forces the preflight) must reject as a CORS
 * block. The day the provider enables CORS this test FAILS on the
 * resolved response — that failure is the signal to re-add `hosted` to
 * the browser engine list (re-measure with a real Chromium fetch, not a
 * stub).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { launchChromium } from "../tests-browser/launch.mjs";
import { startHarness, type Harness } from "./servers.ts";

const HOSTED_URL = "https://decision.vllm-sr.ai/v1/systemone";

describe("hosted verifier CORS tripwire (real network, no model)", { timeout: 120000 }, () => {
  let harness: Harness | undefined;
  let browser: import("playwright-core").Browser | undefined;
  let page: import("playwright-core").Page | undefined;

  before(async () => {
    harness = await startHarness();
    ({ browser } = await launchChromium());
    page = await browser.newPage();
    await page.goto(`${harness.urlA}/test.html`);
  });

  after(async () => {
    try { await page?.close(); } catch {}
    try { await browser?.close(); } catch {}
    try { await harness?.close(); } catch {}
  });

  it("a page fetch with an authorization header fails as a CORS block", async () => {
    const out = (await page!.evaluate(`(async () => {
      try {
        const r = await fetch(${JSON.stringify(HOSTED_URL)}, {
          method: "POST",
          headers: { authorization: "Bearer NO-KEY-CORS-PROBE", "content-type": "application/json" },
          body: "{}",
          mode: "cors",
          credentials: "omit",
        });
        return JSON.stringify({ resolved: true, status: r.status });
      } catch (e) {
        return JSON.stringify({ resolved: false, error: String(e).slice(0, 200) });
      }
    })()`)) as string;
    const row = JSON.parse(out) as { resolved: boolean; status?: number; error?: string };
    assert.equal(
      row.resolved,
      false,
      `hosted allows page CORS now (resolved with status ${row.status}): re-measure with a real Chromium fetch and re-add "hosted" to BROWSER_VERIFICATION_ENGINES — ${out}`,
    );
    assert.match(row.error ?? "", /failed to fetch|typeerror|load failed/i);
  });
});
