/**
 * `doctor` self-diagnosis: the four checks, their statuses and fixes.
 * Offline: every hosted probe runs against an injected fetch — no quota.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { doctorTool, type DoctorStructured } from "../src/core/tools/doctor.ts";
import { createRegistry } from "../src/core/registry.ts";
import { WriteQueue } from "../src/core/queue.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import { TOOL_NAMES } from "../src/core/tool-names.ts";
import { DEFAULTS } from "../src/core/config.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-doctor-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const NO_FETCH: ToolContext["fetch"] = async () => {
  throw new Error("no network in this test");
};

function ctx(env: Record<string, string | undefined> = {}, fetch: ToolContext["fetch"] = NO_FETCH): ToolContext {
  return { root, fetch, env: { ...env }, now: () => new Date("2026-10-15T00:00:00Z"), queue: new WriteQueue() };
}

/** A hosted endpoint stub: status + JSON body for POST /v1/systemone. */
function hostedFetch(status: number, body: unknown): ToolContext["fetch"] {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as ToolContext["fetch"];
}

const NO_BIN = { exists: () => false, executable: () => false };

function out(result: Awaited<ReturnType<typeof doctorTool>>): DoctorStructured {
  return result.structuredContent as DoctorStructured;
}

function check(s: DoctorStructured, name: string) {
  const c = s.checks.find((c) => c.name === name);
  assert.ok(c, `missing check ${name}`);
  return c;
}

describe("doctor", () => {
  it("is the sixth canonical tool and hosted is the default engine", () => {
    assert.deepEqual([...TOOL_NAMES].sort(), ["compile", "doctor", "papers", "passages", "registry", "verify"]);
    assert.equal(DEFAULTS.verification.engine, "hosted");
  });

  it("with no key the verification check errors with the link and never a key", async () => {
    const r = await doctorTool(ctx({ PATH: "", UKTUB_VERIFY_ENGINE: "hosted" }), {}, { fs: NO_BIN });
    const s = out(r);
    const v = check(s, "verification");
    assert.equal(v.status, "error");
    assert.match(v.detail + v.fix, /https:\/\/decision\.vllm-sr\.ai\//);
    assert.match(v.fix, /UKTUB_VERIFY_API_KEY/);
    const text = r.content.map((c) => c.text).join("\n");
    assert.doesNotMatch(text, /sk-|secret|Bearer/i);
    assert.match(text, /tell the user the fix/i);
  });

  it("with a stubbed probe OK the verification check is ok", async () => {
    const fetch = hostedFetch(200, { answers: { c: { noul: 0.97 } }, model: "vllm-sr/d3-mini" });
    const r = await doctorTool(ctx({ UKTUB_VERIFY_API_KEY: "k" }, fetch), {});
    assert.equal(check(out(r), "verification").status, "ok");
  });

  it("a 401 probe errors naming the status and never the key", async () => {
    const fetch = hostedFetch(401, { error: "unauthorized" });
    const r = await doctorTool(ctx({ UKTUB_VERIFY_API_KEY: "sk-secret-xyz" }, fetch), {});
    const v = check(out(r), "verification");
    assert.equal(v.status, "error");
    assert.match(v.detail, /401/);
    assert.doesNotMatch(r.content.map((c) => c.text).join("\n"), /sk-secret-xyz/);
  });

  it("eos with no python errors with the install fix", async () => {
    const r = await doctorTool(ctx({ PATH: "", UKTUB_VERIFY_ENGINE: "eos" }), {}, { fs: NO_BIN });
    const v = check(out(r), "verification");
    assert.equal(v.status, "error");
    assert.match(v.fix, /uktub-scholar eos install --yes/);
  });

  it("eos-onnx with nothing installed errors with the install fix", async () => {
    const r = await doctorTool(ctx({ PATH: "", UKTUB_VERIFY_ENGINE: "eos-onnx", XDG_CACHE_HOME: root }, NO_FETCH), {}, { fs: NO_BIN });
    const v = check(out(r), "verification");
    assert.equal(v.status, "error");
    assert.match(v.fix, /uktub-scholar eos install --yes/);
  });

  it("an absent registry is a warn to register a paper", async () => {
    const r = await doctorTool(ctx({ PATH: "" }), {}, { fs: NO_BIN });
    const g = check(out(r), "registry");
    assert.equal(g.status, "warn");
    assert.match(g.fix, /register a paper/);
  });

  it("a present registry reports its version and counts", async () => {
    createRegistry(root).close();
    const r = await doctorTool(ctx({ PATH: "" }), {}, { fs: NO_BIN });
    const g = check(out(r), "registry");
    assert.equal(g.status, "ok");
    assert.match(g.detail, /schema version 6/);
    assert.match(g.detail, /0 paper\(s\), 0 with a ready source/);
  });

  it("missing provider keys are a warn, never an error", async () => {
    const r = await doctorTool(ctx({ PATH: "" }), {}, { fs: NO_BIN });
    const p = check(out(r), "providers");
    assert.equal(p.status, "warn");
    assert.match(p.detail, /SEMANTIC_SCHOLAR_API_KEY/);
  });

  it("the summary counts problems", async () => {
    const r = await doctorTool(ctx({ PATH: "" }), {}, { fs: NO_BIN });
    const s = out(r);
    const n = s.checks.filter((c) => c.status !== "ok").length;
    assert.ok(n > 0);
    assert.equal(s.summary, `doctor: ${n} problem(s)`);
    assert.match(r.content.map((c) => c.text).join("\n"), new RegExp(`^${s.summary.replace(/[(]/g, "\\(").replace(/[)]/g, "\\)")}`, "m"));
  });

  it("all checks passed when nothing is wrong", async () => {
    createRegistry(root).close();
    const fetch = hostedFetch(200, { answers: { c: { noul: 0.99 } }, model: "vllm-sr/d3-mini" });
    const r = await doctorTool(
      ctx(
        {
          UKTUB_VERIFY_API_KEY: "k",
          SEMANTIC_SCHOLAR_API_KEY: "k",
          OPENALEX_API_KEY: "k",
          CROSSREF_MAILTO: "a@b.c",
          UKTUB_TECTONIC_BIN: "/nonexistent",
        },
        fetch,
      ),
      {},
      { fs: { exists: (p: string) => p === "/nonexistent", executable: () => true }, execProbe: async () => ({ stdout: "tectonic 0.17.0", stderr: "" }) },
    );
    assert.equal(out(r).summary, "doctor: all checks passed");
  });
});
