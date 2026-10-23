/**
 * Phase 6 (Part A) + Phase 7: the worker's agent surface.
 *
 * - `agentSurface` lists exactly the MCP definitions (including `compile`
 *   since Phase 7 — deep-equal to `src/core/tools/definitions.ts`), plus
 *   the shared rules and the research-service key names.
 * - `setEnv` changes what a later tool call sees (doctor reports a key as
 *   set), and the key value appears in no result or error payload.
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
import { TOOL_DEFINITIONS } from "../src/core/tools/definitions.ts";
import { AGENT_RULES } from "../src/core/agent-rules.ts";
import { RESEARCH_SERVICE_KEY_NAMES } from "../src/core/tools/doctor.ts";

const SECRET = "sk-test-surface-secret-9f8e7d6c5b4a";

async function setup() {
  const root = path.resolve(import.meta.dirname, "..");
  const outdir = tmpDir("agent-surface-www-");
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));
  const server = await serveDirectory(outdir);
  const { browser } = await launchChromium();
  return { server, browser, workerUrl: `${server.url}/worker.js`, pageUrl: `${server.url}/page.html` };
}

test("agentSurface lists the MCP definitions including compile, plus rules and key names", { timeout: 300000 }, async () => {
  const { server, browser, workerUrl, pageUrl } = await setup();
  const projectId = `surface-${Date.now().toString(36)}`;
  try {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(pageUrl, { waitUntil: "load" });
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
      const call = (op, args = {}) => callWorker(page, op, args);
      assert.deepEqual(await call("init", { projectId, env: {} }), { ok: true });

      const surface = await call("agentSurface", {});
      const expectedTools = TOOL_DEFINITIONS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: JSON.parse(JSON.stringify(t.inputSchema)),
      }));
      assert.deepEqual(surface.tools, JSON.parse(JSON.stringify(expectedTools)));
      assert.ok(surface.tools.some((t) => t.name === "compile"), "compile is in the agent surface since Phase 7");
      // The page reuses the core budget through the surface (never a copied number).
      assert.equal(typeof surface.compileTimeoutMs, "number");
      assert.ok(surface.compileTimeoutMs >= 5000);
      assert.deepEqual(surface.rules, [...AGENT_RULES]);
      // Only keys a browser engine or provider reads: `UKTUB_VERIFY_API_KEY` serves the hosted/llama-cpp
      // engines, which no page can reach (Phase 9f), so the panel must not ask for it.
      assert.deepEqual(surface.keyNames, [...RESEARCH_SERVICE_KEY_NAMES]);
      // The surface carries no env: the init secret (none here) and any key would leak otherwise.
      assert.ok(!JSON.stringify(surface).includes(SECRET), "surface carries no key material");
      await call("close", {});
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

test("setEnv changes what doctor sees, without ever echoing the key", { timeout: 300000 }, async () => {
  const { server, browser, workerUrl, pageUrl } = await setup();
  const projectId = `setenv-${Date.now().toString(36)}`;
  try {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(pageUrl, { waitUntil: "load" });
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
      const call = (op, args = {}) => callWorker(page, op, args);
      assert.deepEqual(await call("init", { projectId, env: {} }), { ok: true });

      const before = await call("callTool", { name: "doctor", toolArgs: {} });
      const providersBefore = before.structuredContent.checks.find((c) => c.name === "providers");
      assert.equal(providersBefore.status, "warn", "no provider keys set before setEnv");

      assert.deepEqual(
        await call("setEnv", {
          env: {
            SEMANTIC_SCHOLAR_API_KEY: SECRET,
            OPENALEX_API_KEY: "oa-test-key",
            CROSSREF_MAILTO: "test@example.org",
          },
        }),
        { ok: true },
      );
      const after = await call("callTool", { name: "doctor", toolArgs: {} });
      const providersAfter = after.structuredContent.checks.find((c) => c.name === "providers");
      assert.equal(providersAfter.status, "ok", "doctor sees the keys after setEnv");
      assert.match(providersAfter.detail, /all optional provider keys set/);

      // The key value appears in no result, error, or progress payload.
      assert.ok(!JSON.stringify(after).includes(SECRET), "doctor result carries no key value");
      const surface = await call("agentSurface", {});
      assert.ok(!JSON.stringify(surface).includes(SECRET), "agentSurface carries no key value");
      await call("close", {});
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
