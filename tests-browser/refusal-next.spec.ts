/**
 * Phase 9a item 1b: host-specific refusal remedies.
 *
 * - Table part (no browser): every browser `next` override is non-empty and
 *   free of Node-only remedy tokens, and every Node `next` that names a
 *   Node-only remedy has a browser override (completeness, so a future Node
 *   edit cannot leak a CLI/env remedy into the browser agent's text).
 * - Live part (real Chromium worker, model-free): the refusals the agent's
 *   `verify`/`registry` execute paths actually return name only browser
 *   remedies — in both the rendered text and the `refused.message`.
 */
import { describe, it, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { REFUSALS, type RefusalCode } from "../src/core/refusals.ts";
import { BROWSER_REFUSAL_NEXT, NODE_ONLY_DENYLIST } from "../src/browser/refusal-next.ts";
import { bundle } from "./build.mjs";
import { serveDirectory } from "./server.mjs";
import { launchChromium } from "./launch.mjs";
import { callWorker, openWorkerPage } from "./rpc.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

const hasToken = (text: string): string | null => {
  const lower = text.toLowerCase();
  for (const token of NODE_ONLY_DENYLIST) {
    if (lower.includes(token.toLowerCase())) return token;
  }
  return null;
};

test("browser refusal nexts: non-empty and free of Node-only remedy tokens", () => {
  const codes = Object.keys(BROWSER_REFUSAL_NEXT) as RefusalCode[];
  assert.ok(codes.length > 0, "the browser overrides at least one code");
  for (const code of codes) {
    const next = BROWSER_REFUSAL_NEXT[code];
    assert.ok(typeof next === "string" && next.length > 0, `${code} browser next is empty`);
    assert.equal(hasToken(next), null, `${code} browser next names a Node-only remedy: ${next}`);
  }
});

test("denylist forbids the hosted CORS-blocked remedy (client policy, measured 2026-10-22)", () => {
  assert.ok(
    NODE_ONLY_DENYLIST.includes("decision.vllm-sr.ai"),
    "the hosted server origin is a forbidden browser remedy token",
  );
  assert.ok(NODE_ONLY_DENYLIST.includes("hosted"), "'hosted' is a forbidden browser remedy token");
});

test("browser refusal nexts: every Node next with a Node-only remedy is overridden", () => {
  const missing: string[] = [];
  for (const [code, entry] of Object.entries(REFUSALS)) {
    if (hasToken(entry.next) !== null && BROWSER_REFUSAL_NEXT[code as RefusalCode] === undefined) {
      missing.push(`${code} (Node next names ${JSON.stringify(hasToken(entry.next))})`);
    }
  }
  assert.deepEqual(missing, [], `Node-only remedies without a browser override: ${missing.join("; ")}`);
});

describe("browser refusal wording live (model-free worker)", { timeout: 300000 }, async () => {
  const outdir = fs.mkdtempSync(path.join(ROOT, "tests-browser", "tmp-refusal9a-"));
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
  const pid = (tag) => `refusal9a-${tag}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;

  it("verify with the default (openrouter) engine and no key refuses with browser-only wording", async () => {
    const id = pid("verify");
    assert.deepEqual(await call("init", { projectId: id, env: {} }), { ok: true });
    try {
      assert.deepEqual(await call("setEnv", { env: { UKTUB_VERIFY_ENGINE: "openrouter" } }), { ok: true });
      const failed = (await call("callTool", {
        name: "verify",
        toolArgs: {
          claim: "The experiment uses three antennas.",
          passages: [{ text: "In all trials, the experiment uses three antennas on the receiver array." }],
        },
      })) as { content: { text: string }[]; details: { refused: { code: string; message: string } } };
      assert.equal(failed.details.refused.code, "VERIFY_ENGINE_MISSING");
      assert.match(failed.details.refused.message, /openrouter decisions engine: OPENROUTER_API_KEY is not set/);
      const text = failed.content.map((c) => c.text).join("\n");
      assert.equal(hasToken(text), null, `verify refusal names a Node-only remedy: ${text}`);
      assert.equal(hasToken(failed.details.refused.message), null, `verify message names a Node-only remedy: ${failed.details.refused.message}`);
      assert.match(text, /Verification settings/, "browser remedy names where to enable an engine");
    } finally {
      await call("close", {});
    }
  });

  it("registry before init refuses with the browser next", async () => {
    const res = (await call("callTool", { name: "registry", toolArgs: { action: "read" } })) as {
      content: { text: string }[];
      details: { refused: { code: string; message: string } };
    };
    assert.equal(res.details.refused.code, "REGISTRY_NOT_INITIALIZED");
    const text = res.content.map((c) => c.text).join("\n");
    assert.equal(hasToken(text), null, `registry refusal names a Node-only remedy: ${text}`);
    assert.match(text, /reopen the project/, "browser remedy tells the agent what to do");
  });
});
