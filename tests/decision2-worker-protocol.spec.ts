/**
 * Decision 2.0 worker protocol contract: the JSONL client in
 * scripts/decision2-client.ts against a fake worker process (no model, no GPU,
 * no network). Pins: "ready" line first, {"p_true"} replies, per-row
 * {"error"} that does not kill the session, explicit context refusals that
 * stay distinguishable from scores, crash/load-failure errors, and that the
 * python worker refuses to start without a pinned revision.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineError } from "../src/core/verify/claim.ts";
import { decision2Worker } from "../scripts/decision2-client.ts";

const FAKE = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const mode = process.env.FAKE_MODE ?? "ok";
if (mode === "load-fail") { console.log(JSON.stringify({ error: "decision2 model failed to load: boom" })); process.exit(1); }
console.log(JSON.stringify({ ready: true, model: "fake", revision: "abc", max_input_tokens: 8192, model_sha256: "sha", device: "cuda:0", load_s: 1.5 }));
let n = 0;
rl.on("line", (line) => {
  const row = JSON.parse(line);
  if (row.exit) process.exit(0);
  if (row.stats) return console.log(JSON.stringify({ stats: { rows_scored: n, tokens_scored: 7, infer_s: 0.5, peak_vram_mib: 100 } }));
  if (row.count) return console.log(JSON.stringify({ tokens: row.state.length, limit: 8192 }));
  n++;
  if (mode === "crash" && n === 2) process.exit(3);
  if (row.state === "too long") return console.log(JSON.stringify({ error: "context_limit: 9000 tokens exceeds the 8192-token window; refused, not truncated", refused: true, tokens: 9000, limit: 8192 }));
  if (row.state === "bad") return console.log(JSON.stringify({ error: "model answered invalid_model_output", tokens: 5 }));
  console.log(JSON.stringify({ p_true: row.state === "yes" ? 0.97 : 0.02, tokens: row.state.length }));
});
`;

function fake(mode = "ok") {
  const dir = mkdtempSync(join(tmpdir(), "d2-fake-"));
  const script = join(dir, "fake.cjs");
  writeFileSync(script, FAKE);
  return decision2Worker({ env: { ...process.env, FAKE_MODE: mode }, pythonBin: process.execPath, script });
}

describe("decision2 worker client", () => {
  it("reads the ready line first and scores rows in order", async () => {
    const w = fake();
    const ready = await w.ready;
    assert.equal(ready.max_input_tokens, 8192);
    assert.equal(ready.revision, "abc");
    assert.equal(ready.model_sha256, "sha");
    const out = await w.scoreMany([
      { state: "yes", instructions: "c" },
      { state: "no", instructions: "c" },
    ]);
    assert.deepEqual(out.map((r) => r.p), [0.97, 0.02]);
    assert.deepEqual(out.map((r) => r.tokens), [3, 2]);
    await w.close();
  });

  it("keeps the session alive after a per-row error and marks refusals explicitly", async () => {
    const w = fake();
    const [refused, bad, ok] = await w.scoreMany([
      { state: "too long", instructions: "c" },
      { state: "bad", instructions: "c" },
      { state: "yes", instructions: "c" },
    ]);
    assert.equal(refused.p, null);
    assert.equal(refused.refused, true);
    assert.equal(refused.tokens, 9000);
    assert.equal(bad.p, null);
    assert.equal(bad.refused, false);
    assert.match(bad.error ?? "", /invalid_model_output/);
    assert.equal(ok.p, 0.97);
    await w.close();
  });

  it("supports the count and stats ops", async () => {
    const w = fake();
    assert.deepEqual(await w.count({ state: "abcd", instructions: "c" }), { tokens: 4, limit: 8192 });
    const s = await w.stats();
    assert.equal(s.peak_vram_mib, 100);
    await w.close();
  });

  it("exposes a strict ClaimEngine that throws EngineError on any row error", async () => {
    const w = fake();
    const engine = w.asEngine();
    assert.deepEqual(await engine.run([{ state: "yes", instructions: "c" }]), [0.97]);
    await assert.rejects(engine.run([{ state: "bad", instructions: "c" }]), (e: unknown) => e instanceof EngineError && /invalid_model_output/.test(e.message));
    await w.close();
  });

  it("surfaces a load failure as EngineError", async () => {
    const w = fake("load-fail");
    await assert.rejects(w.ready, (e: unknown) => e instanceof EngineError && /failed to load: boom/.test(e.message));
  });

  it("rejects the in-flight row with EngineError when the worker dies", async () => {
    const w = fake("crash");
    await w.ready;
    const first = await w.score({ state: "yes", instructions: "c" });
    assert.equal(first.p, 0.97);
    await assert.rejects(w.score({ state: "yes", instructions: "c" }), (e: unknown) => e instanceof EngineError && /exited/.test(e.message));
  });
});

describe("decision2_decide.py preconditions", () => {
  it("refuses to start without a pinned model and revision (no import of torch needed)", () => {
    const r = spawnSync("python3", ["scripts/decision2_decide.py"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    assert.equal(r.status, 1);
    const first = JSON.parse(r.stdout.split("\n")[0]);
    assert.match(first.error, /UKTUB_DECISION2_REVISION/);
  });
});
