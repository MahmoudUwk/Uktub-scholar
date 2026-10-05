/**
 * Engine adapter spec: the confidence-bar override and the resident-engine
 * adapters — offline. The Julia-1 adapter's live smoke is gated by UKTUB_JULIA_PYTHON;
 * historical quality measurements are retained in docs/benchmarks/.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { spawn as realSpawn, spawnSync } from "node:child_process";

import {
  DEFAULT_MIN_CONFIDENCE,
  eosEngine,
  eosOnnxEngine,
  juliaEngine,
  minConfidenceFromEnv,
} from "../src/core/verify/claim.ts";

describe("confidence bar from the environment", () => {
  it("valid override wins; junk or out-of-range falls back to 0.99", () => {
    assert.equal(minConfidenceFromEnv({ UKTUB_VERIFY_MIN_CONFIDENCE: "0.9" }), 0.9);
    assert.equal(minConfidenceFromEnv({ UKTUB_VERIFY_MIN_CONFIDENCE: "0.2" }), DEFAULT_MIN_CONFIDENCE);
    assert.equal(minConfidenceFromEnv({ UKTUB_VERIFY_MIN_CONFIDENCE: "abc" }), DEFAULT_MIN_CONFIDENCE);
    assert.equal(minConfidenceFromEnv({}), DEFAULT_MIN_CONFIDENCE);
  });
});

describe("eos engine adapter (resident Decision 2.0 worker)", () => {
  // A real child process speaking the worker's protocol, so the JSONL plumbing is exercised for real.
  const FAKE = `
    process.stdout.write(JSON.stringify({ready:true, model:"fake", env:{m:process.env.UKTUB_DECISION2_MODEL, r:process.env.UKTUB_DECISION2_REVISION}}) + "\\n");
    let buf = ""; process.stdin.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\\n")) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const row = JSON.parse(line); if (row.exit) process.exit(0); process.stdout.write(JSON.stringify({p_true: row.state.includes("support") ? 0.995 : 0.05, tokens: 3}) + "\\n"); } });`;
  const calls: { bin: string; env: Record<string, string | undefined> }[] = [];
  const children: { kill(): boolean }[] = [];
  const fakeSpawn = ((bin: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ bin, env: { ...opts.env } });
    const child = realSpawn(process.execPath, ["-e", FAKE], opts as never);
    children.push(child);
    return child;
  }) as unknown as typeof realSpawn;
  after(() => children.forEach((c) => c.kill())); // the engine keeps its worker resident by design

  it("starts the worker with the pinned checkpoint by default and answers rows through it", async () => {
    const engine = eosEngine({ env: {}, spawnImpl: fakeSpawn });
    assert.deepEqual(await engine.run([{ state: "a passage that will support it", instructions: "claim" }, { state: "unrelated", instructions: "claim" }]), [0.995, 0.05]);
    assert.equal(calls.at(-1)!.bin, "python3");
    assert.equal(calls.at(-1)!.env.UKTUB_DECISION2_MODEL, "vllm-sr/Decision-2.0-Eos-0.8B");
    assert.equal(calls.at(-1)!.env.UKTUB_DECISION2_REVISION, "3594047d69f476f1d01cf84c593e213fc3a4dfe0");
  });

  it("honours UKTUB_EOS_PYTHON / _MODEL / _REVISION", async () => {
    const engine = eosEngine({ env: { UKTUB_EOS_PYTHON: "/opt/venv/bin/python", UKTUB_EOS_MODEL: "/models/eos", UKTUB_EOS_REVISION: "abc123" }, spawnImpl: fakeSpawn });
    await engine.run([{ state: "support", instructions: "c" }]);
    assert.equal(calls.at(-1)!.bin, "/opt/venv/bin/python");
    assert.deepEqual([calls.at(-1)!.env.UKTUB_DECISION2_MODEL, calls.at(-1)!.env.UKTUB_DECISION2_REVISION], ["/models/eos", "abc123"]);
  });
});

describe("eos-onnx engine adapter (the same worker protocol on ONNX Runtime, no PyTorch)", () => {
  const FAKE = `
    process.stdout.write(JSON.stringify({ready:true, model:"fake"}) + "\\n");
    let buf = ""; process.stdin.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\\n")) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const row = JSON.parse(line); if (row.exit) process.exit(0); process.stdout.write(JSON.stringify({p_true: row.state.includes("support") ? 0.995 : 0.05, tokens: 3}) + "\\n"); } });`;
  const calls: { bin: string; args: string[]; env: Record<string, string | undefined> }[] = [];
  const children: { kill(): boolean }[] = [];
  const fakeSpawn = ((bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ bin, args, env: { ...opts.env } });
    const child = realSpawn(process.execPath, ["-e", FAKE], opts as never);
    children.push(child);
    return child;
  }) as unknown as typeof realSpawn;
  after(() => children.forEach((c) => c.kill()));

  it("runs scripts/decision2_onnx.py with the pinned export and answers rows through it", async () => {
    const engine = eosOnnxEngine({ env: { UKTUB_EOS_ONNX_DIR: "/models/eos-onnx" }, spawnImpl: fakeSpawn });
    assert.deepEqual(await engine.run([{ state: "support", instructions: "c" }, { state: "other", instructions: "c" }]), [0.995, 0.05]);
    const call = calls.at(-1)!;
    assert.equal(call.bin, "python3");
    assert.match(call.args[0] ?? "", /scripts[\\/]decision2_onnx\.py$/);
    assert.equal(call.env.UKTUB_DECISION2_ONNX_DIR, "/models/eos-onnx");
    assert.match(call.env.UKTUB_DECISION2_REVISION ?? "", /^[0-9a-f]{40}$/, "a pinned revision of the export");
    assert.match(call.env.UKTUB_DECISION2_ONNX_SHA256 ?? "", /^[0-9a-f]{64}$/, "the pinned weights digest is handed to the worker, which refuses a mismatch");
  });

  it("honours UKTUB_EOS_ONNX_PYTHON, and a user override of the digest/revision pin", async () => {
    const engine = eosOnnxEngine({ env: { UKTUB_EOS_ONNX_DIR: "/m", UKTUB_EOS_ONNX_PYTHON: "/opt/venv/bin/python", UKTUB_EOS_ONNX_REVISION: "abc123", UKTUB_EOS_ONNX_SHA256: "f".repeat(64) }, spawnImpl: fakeSpawn });
    await engine.run([{ state: "support", instructions: "c" }]);
    const call = calls.at(-1)!;
    assert.equal(call.bin, "/opt/venv/bin/python");
    assert.deepEqual([call.env.UKTUB_DECISION2_REVISION, call.env.UKTUB_DECISION2_ONNX_SHA256], ["abc123", "f".repeat(64)]);
  });

  it("with no model directory it fails with a message that names the installer", async () => {
    const engine = eosOnnxEngine({ env: { UKTUB_CACHE_DIR: "/nonexistent-cache" }, spawnImpl: fakeSpawn });
    await assert.rejects(engine.run([{ state: "support", instructions: "c" }]), /eos install/);
  });
});

describe("worker engines never keep the process alive", () => {
  it("a slow resident worker is waited for (a pending request keeps the process alive), and the process exits by itself once idle", () => {
    const script = `
      import { eosEngine } from ${JSON.stringify(new URL("../src/core/verify/claim.ts", import.meta.url).href)};
      import { spawn } from "node:child_process";
      const FAKE = ${JSON.stringify(`setTimeout(() => process.stdout.write('{"ready":true}\\n'), 700); process.stdin.on("data", d => { for (const l of String(d).split("\\n")) if (l.trim()) setTimeout(() => process.stdout.write('{"p_true":0.9}\\n'), 700); }); setInterval(() => {}, 1000);`)};
      const engine = eosEngine({ env: {}, spawnImpl: (b, a, o) => spawn(process.execPath, ["-e", FAKE], o) });
      const first = await engine.run([{ state: "s", instructions: "c" }]);
      const second = await engine.run([{ state: "s2", instructions: "c" }]); // a later call on the already-running worker
      console.log(JSON.stringify([...first, ...second]));
    `;
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000 });
    assert.equal(out.status, 0, `${out.signal ?? ""} ${out.stderr}`);
    assert.equal(out.stdout.trim(), "[0.9,0.9]");
  });
});

describe("julia engine adapter (real model, env-gated)", () => {
  const python = process.env.UKTUB_JULIA_PYTHON ?? "";
  const hasEngine = python !== "";
  it("answers rows through the resident process", { skip: !hasEngine }, async () => {
    const engine = juliaEngine({ env: { ...process.env, UKTUB_JULIA_MODEL: process.env.UKTUB_JULIA_MODEL ?? "SupersonicLabs/Julia-1" }, pythonBin: python });
    const p = await engine.run([
      { state: "The Eiffel Tower is located in Paris, France.", instructions: "The Eiffel Tower is located in Paris." },
    ]);
    assert.equal(p.length, 1);
    assert.ok(p[0] >= 0 && p[0] <= 1);
  });
});
