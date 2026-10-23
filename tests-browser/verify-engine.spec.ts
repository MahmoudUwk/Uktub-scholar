/**
 * Phase 8b Part B (TDD-first): the browser verification-engine setting.
 * Phase 9f: the browser offers only engines a page can reach — `hosted` is
 * CORS-blocked in pages (measured 2026-10-22 from real Chromium: OPTIONS
 * 405, no ACAO on the 401, "Failed to fetch" for preloaded and simple
 * POSTs), so the surface list is exactly `["openrouter"]`.
 *
 * - `agentSurface().verificationEngines` is exactly `["openrouter"]`.
 * - `setEnv` `UKTUB_VERIFY_ENGINE=openrouter` without a key: `verify`
 *   fails with the engine's own missing-key error, and `doctor` reflects
 *   the engine (its openrouter key check).
 * - The `write_section` document path (`verify` with `{ text, offset }`)
 *   reaches the worker verify tool (observed outcome pinned below).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bundle } from "./build.mjs";
import { serveDirectory } from "./server.mjs";
import { launchChromium } from "./launch.mjs";
import { callWorker, openWorkerPage } from "./rpc.mjs";
import { VERIFICATION_ENGINES } from "../src/core/verify/engines.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("phase 8b verification engine setting", { timeout: 300000 }, async () => {
  const outdir = fs.mkdtempSync(path.join(ROOT, "tests-browser", "tmp-verify8b-"));
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
  const pid = (tag) => `verify8b-${tag}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;

  it("agentSurface().verificationEngines is exactly [openrouter] (hosted is CORS-blocked in pages)", async () => {
    const id = pid("engines");
    assert.deepEqual(await call("init", { projectId: id, env: {} }), { ok: true });
    try {
      const surface = await call("agentSurface", {});
      assert.deepEqual(surface.verificationEngines, ["openrouter"]);
      for (const e of surface.verificationEngines) {
        assert.ok((VERIFICATION_ENGINES as readonly string[]).includes(e), `${e} is a known core engine`);
      }
    } finally {
      await call("close", {});
    }
  });

  it("openrouter without a key: verify fails with the engine's missing-key error; doctor reflects the engine", async () => {
    const id = pid("orkey");
    assert.deepEqual(await call("init", { projectId: id, env: {} }), { ok: true });
    try {
      assert.deepEqual(await call("setEnv", { env: { UKTUB_VERIFY_ENGINE: "openrouter" } }), { ok: true });
      const failed = (await call("callTool", {
        name: "verify",
        toolArgs: {
          claim: "The experiment uses three antennas.",
          passages: [{ text: "In all trials, the experiment uses three antennas on the receiver array." }],
        },
      })) as { content: { text: string }[]; structuredContent: null; details: { refused: { code: string; message: string } } };
      assert.equal(failed.details.refused.code, "VERIFY_ENGINE_MISSING");
      assert.match(failed.details.refused.message, /openrouter decisions engine: OPENROUTER_API_KEY is not set/);
      const doc = (await call("callTool", { name: "doctor", toolArgs: {} })) as {
        structuredContent: { checks: { name: string; status: string; detail: string }[] };
      };
      const vCheck = doc.structuredContent.checks.find((c) => c.name === "verification");
      assert.equal(vCheck?.status, "error");
      assert.match(vCheck?.detail ?? "", /engine openrouter: no key in UKTUB_OPENROUTER_API_KEY/);
    } finally {
      await call("close", {});
    }
  });

  it("openrouter with a key: doctor reports the engine ready (no probe, no network)", async () => {
    const id = pid("okready");
    assert.deepEqual(await call("init", { projectId: id, env: {} }), { ok: true });
    try {
      assert.deepEqual(
        await call("setEnv", { env: { UKTUB_VERIFY_ENGINE: "openrouter", OPENROUTER_API_KEY: "k", UKTUB_OPENROUTER_API_KEY: "k" } }),
        { ok: true },
      );
      const doc = (await call("callTool", { name: "doctor", toolArgs: {} })) as {
        structuredContent: { checks: { name: string; status: string; detail: string }[] };
      };
      const vCheck = doc.structuredContent.checks.find((c) => c.name === "verification");
      assert.equal(vCheck?.status, "ok");
      assert.match(vCheck?.detail ?? "", /engine openrouter: key present/);
    } finally {
      await call("close", {});
    }
  });

  it("verify with { text, offset } reaches document mode in the worker (observed outcome pinned)", async () => {
    const id = pid("docmode");
    assert.deepEqual(await call("init", { projectId: id, env: {} }), { ok: true });
    try {
      const out = (await call("callTool", {
        name: "verify",
        toolArgs: { text: "Cells age faster in every trial we ran.", offset: 0 },
      })) as { content: { text: string }[]; details: Record<string, unknown>; structuredContent: unknown };
      assert.ok(Array.isArray(out.content) && out.content.length > 0, "a well-formed tool result, not a crash");
    } finally {
      await call("close", {});
    }
  });

  it("Phase 9g: pushed UKTUB_OPENROUTER_MODEL selects the worker engine's model (stubbed fetch names it)", async () => {
    const id = pid("vmodel");
    const routes = [{ match: "openrouter.ai", status: 500, body: "boom" }];
    assert.deepEqual(await call("init", { projectId: id, env: {}, fetchRoutes: routes }), { ok: true });
    try {
      assert.deepEqual(
        await call("setEnv", {
          env: {
            UKTUB_VERIFY_ENGINE: "openrouter",
            OPENROUTER_API_KEY: "k",
            UKTUB_OPENROUTER_API_KEY: "k",
            UKTUB_OPENROUTER_MODEL: "inception/mercury-decide",
          },
        }),
        { ok: true },
      );
      const out = (await call("callTool", {
        name: "verify",
        toolArgs: {
          claim: "The experiment uses three antennas.",
          passages: [{ text: "In all trials, the experiment uses three antennas on the receiver array." }],
        },
      })) as { content: { text: string }[]; structuredContent: null; details: { refused: { code: string; message: string } } };
      assert.equal(out.details.refused.code, "VERIFY_ENGINE_MISSING");
      assert.match(out.details.refused.message, /openrouter decisions \(inception\/mercury-decide\): HTTP 500/);
    } finally {
      await call("close", {});
    }
  });

  it("Phase 9g: without UKTUB_OPENROUTER_MODEL the worker engine targets the core free default (stubbed fetch names it)", async () => {
    const id = pid("vmodeldef");
    const routes = [{ match: "openrouter.ai", status: 500, body: "boom" }];
    assert.deepEqual(await call("init", { projectId: id, env: {}, fetchRoutes: routes }), { ok: true });
    try {
      assert.deepEqual(
        await call("setEnv", {
          env: { UKTUB_VERIFY_ENGINE: "openrouter", OPENROUTER_API_KEY: "k", UKTUB_OPENROUTER_API_KEY: "k" },
        }),
        { ok: true },
      );
      const out = (await call("callTool", {
        name: "verify",
        toolArgs: {
          claim: "The experiment uses three antennas.",
          passages: [{ text: "In all trials, the experiment uses three antennas on the receiver array." }],
        },
      })) as { content: { text: string }[]; structuredContent: null; details: { refused: { code: string; message: string } } };
      assert.equal(out.details.refused.code, "VERIFY_ENGINE_MISSING");
      assert.match(out.details.refused.message, /openrouter decisions \(inception\/mercury-decide:free\): HTTP 500/);
    } finally {
      await call("close", {});
    }
  });
});
