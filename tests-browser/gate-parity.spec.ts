/**
 * Phase 8a Part A (TDD-first): worker gate ops + workflow parity.
 *
 * - `agentSurface().workflow` equals
 *   `writingWorkflowSection(readFileSync("skills/uktub-research/SKILL.md"))`
 *   (the same file Pi ships, no copy).
 * - Gate ops (`gateStartUserPrompt`, `gateToolEnded`, `gateSettle`) backed by
 *   ONE `createCompletionGate()` per open project produce byte-identical
 *   texts to the neutral core on real `/proj` documents and a real registry:
 *   the 7 settle-parity scenarios from `tests/agent-runtime-neutral.spec.ts`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bundle } from "./build.mjs";
import { serveDirectory } from "./server.mjs";
import { launchChromium } from "./launch.mjs";
import { callWorker, openWorkerPage } from "./rpc.mjs";
import { writingWorkflowSection } from "../src/agent/workflow.ts";
import { createCompletionGate } from "../src/agent/completion-gate.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKILL_TEXT = fs.readFileSync(path.join(ROOT, "skills/uktub-research/SKILL.md"), "utf8");
const EXPECTED_WORKFLOW = writingWorkflowSection(SKILL_TEXT);
assert.notEqual(EXPECTED_WORKFLOW, null);

const TEX = (body) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
const SENT = (n, extra = "") => `Statement number ${n} holds in every trial${extra}.`;

describe("phase 8a worker gate + workflow", { timeout: 300000 }, async () => {
  const outdir = fs.mkdtempSync(path.join(ROOT, "tests-browser", "tmp-gate8a-"));
  let server;
  let browser;
  let workerUrl;
  let pageUrl;
  let page;
  let ctx;

  before(async () => {
    await bundle("src/browser/worker.ts", path.join(path.relative(ROOT, outdir), "worker.js"));
    fs.copyFileSync(path.join(ROOT, "tests-browser/page.html"), path.join(outdir, "page.html"));
    server = await serveDirectory(outdir);
    ({ browser } = await launchChromium());
    workerUrl = `${server.url}/worker.js`;
    pageUrl = `${server.url}/page.html`;
    ({ ctx, page } = await openWorkerPage(browser, pageUrl, workerUrl));
  });

  after(async () => {
    try { await ctx?.close(); } catch {}
    try { await browser?.close(); } catch {}
    try { await server?.close(); } catch {}
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  const call = (op, args = {}) => callWorker(page, op, args);
  const pid = (tag) => `gate8a-${tag}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;

  it("agentSurface().workflow equals writingWorkflowSection(SKILL.md)", async () => {
    const id = pid("wf");
    assert.deepEqual(await call("init", { projectId: id, env: {} }), { ok: true });
    try {
      const surface = await call("agentSurface", {});
      assert.equal(surface.workflow, EXPECTED_WORKFLOW);
    } finally {
      await call("close", {});
    }
  });

  async function settleScenario(body, gateOps) {
    const id = pid("s");
    assert.deepEqual(await call("init", { projectId: id, env: {} }), { ok: true });
    try {
      await call("writeFile", { rel: "manuscript/main.tex", text: TEX(body) });
      await call("gateStartUserPrompt", {});
      for (const op of gateOps) await call("gateToolEnded", op);
      const settled = await call("gateSettle", {});
      const provenance = await call("provenance", {});
      return { settled, provenance };
    } finally {
      await call("close", {});
    }
  }

  function expectedText(provenance) {
    const gate = createCompletionGate();
    gate.startUserPrompt();
    // The caller drives toolEnded separately; here we only compute the text
    // for a completed, touched run (the scenarios touch via compile below).
    gate.toolEnded({ toolName: "compile", args: {}, isError: false });
    if (!gate.shouldAudit("completed")) return null;
    return gate.followUp(provenance);
  }

  it("unlabelled only: 3 pointers, byte-identical text", async () => {
    const body = [SENT(1), SENT(2), SENT(3)].join(" ");
    const { settled, provenance } = await settleScenario(body, [{ toolName: "compile", args: {}, isError: false }]);
    assert.equal(provenance.ok, true);
    assert.equal(provenance.audit.summary.unlabelledUnverified, 3);
    assert.deepEqual(provenance.audit.summary.unregistered, []);
    assert.equal(settled.text, expectedText(provenance));
    assert.match(settled.text, /3 statement\(s\) in manuscript\/main\.tex/);
  });

  it("unregistered only: registry block, no pointers", async () => {
    const body = `This is unverified \\cite{smith2025retrieval}.`;
    const { settled, provenance } = await settleScenario(body, [{ toolName: "compile", args: {}, isError: false }]);
    assert.equal(provenance.ok, true);
    assert.equal(provenance.audit.summary.unlabelledUnverified, 0);
    assert.deepEqual(provenance.audit.summary.unregistered, ["smith2025retrieval"]);
    assert.equal(settled.text, expectedText(provenance));
    assert.match(settled.text, /these citation keys are not in the registry: smith2025retrieval/);
  });

  it("both blocks in one text", async () => {
    const body = `${SENT(1)} ${SENT(2)} This is unverified \\cite{smith2025retrieval}.`;
    const { settled, provenance } = await settleScenario(body, [{ toolName: "edit", args: { path: "main.tex" }, isError: false }]);
    assert.equal(provenance.ok, true);
    assert.ok(provenance.audit.summary.unlabelledUnverified >= 1);
    assert.deepEqual(provenance.audit.summary.unregistered, ["smith2025retrieval"]);
    assert.equal(settled.text, expectedText(provenance));
    assert.match(settled.text, /Also,/);
  });

  it("more than 10 pointers: capped at 10 with overflow count", async () => {
    const body = Array.from({ length: 12 }, (_, i) => SENT(i + 1)).join(" ");
    const { settled, provenance } = await settleScenario(body, [{ toolName: "compile", args: {}, isError: false }]);
    assert.equal(provenance.ok, true);
    assert.ok(provenance.audit.summary.unlabelledUnverified >= 10);
    assert.equal(settled.text, expectedText(provenance));
    assert.match(settled.text, /\(and \d+ more\)/);
  });

  it("more than 10 unregistered keys: capped at 10 with overflow count", async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `k${String(i + 1).padStart(2, "0")}`).join(",");
    const body = `This is unverified \\cite{${keys}}.`;
    const { settled, provenance } = await settleScenario(body, [{ toolName: "compile", args: {}, isError: false }]);
    assert.equal(provenance.ok, true);
    assert.equal(provenance.audit.summary.unlabelledUnverified, 0);
    assert.equal(provenance.audit.summary.unregistered.length, 12);
    assert.equal(settled.text, expectedText(provenance));
    assert.match(settled.text, /\(and 2 more\)/);
  });

  it("cap of two per prompt: third settle is null", async () => {
    const id = pid("cap");
    assert.deepEqual(await call("init", { projectId: id, env: {} }), { ok: true });
    try {
      await call("writeFile", { rel: "manuscript/main.tex", text: TEX(`${SENT(1)} ${SENT(2)}`) });
      await call("gateStartUserPrompt", {});
      await call("gateToolEnded", { toolName: "compile", args: {}, isError: false });
      const first = await call("gateSettle", {});
      const second = await call("gateSettle", {});
      const third = await call("gateSettle", {});
      assert.ok(typeof first.text === "string" && first.text.length > 0);
      assert.ok(typeof second.text === "string" && second.text.length > 0);
      assert.equal(first.text, second.text);
      assert.equal(third.text, null);
    } finally {
      await call("close", {});
    }
  });

  it("untouched document: settle is null", async () => {
    const id = pid("unt");
    assert.deepEqual(await call("init", { projectId: id, env: {} }), { ok: true });
    try {
      await call("writeFile", { rel: "manuscript/main.tex", text: TEX(SENT(1)) });
      await call("gateStartUserPrompt", {});
      const settled = await call("gateSettle", {});
      assert.equal(settled.text, null);
    } finally {
      await call("close", {});
    }
  });
});
