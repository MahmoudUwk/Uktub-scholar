/**
 * claim-verification-v2 engine registry (docs/plans/2026-10-11-claim-verification-v2-benchmark-plan.md): how each candidate is launched by the
 * runner, so a run of one model can never be mistaken for another and every pin is a recorded one. Offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VERIFICATION_ENGINES } from "../src/core/verify/engines.ts";
import { engineSpecs } from "../scripts/bench-claims-v2-engines.ts";

describe("engine specs of the v2 runner", () => {
  const specs = engineSpecs("/h");
  it("name every candidate of the v2 table once, in a stable order", () => {
    assert.deepEqual(Object.keys(specs), ["eos", "kai", "d3-lite", "d3-edge", "d1-omni", "intern-0.8b", "kev-0.8b", "kev-0.8b-native", "d3-mini-api", "eos-onnx", "eos-q8"]);
  });
  it("run through a product engine, or are injected under a product engine name with a declared identity", () => {
    for (const [id, s] of Object.entries(specs)) {
      assert.ok((VERIFICATION_ENGINES as readonly string[]).includes(s.engine), `${id}: ${s.engine} is a product engine`);
      const declared = s.adapter?.declaredId ?? s.server?.declaredId;
      if (s.adapter || s.server) assert.match(declared ?? "", new RegExp(`^${id}@[0-9a-f]{12}:`), `${id}: the declared identity names the model, its revision and the wording`);
    }
  });
  it("point an injected adapter at a worker script that exists in the repository", () => {
    for (const [id, s] of Object.entries(specs)) if (s.adapter) assert.ok(existsSync(join("scripts", s.adapter.script)), `${id}: ${s.adapter.script}`);
  });
  it("pin every model to a recorded revision: the 40-hex commit, or the 12-hex prefix the earlier reports use (Eos is pinned by the product itself)", () => {
    const revs = Object.entries(specs).map(([id, s]) => [id, s.adapter?.env.UKTUB_D3_REVISION ?? s.adapter?.env.UKTUB_D1_REVISION ?? s.adapter?.env.UKTUB_INTERN_REVISION ?? s.server?.declaredId.match(/@([0-9a-f]{12})/)?.[1] ?? s.env.UKTUB_EOS_REVISION] as const);
    for (const [id, r] of revs) if (id !== "eos" && id !== "eos-onnx" && id !== "eos-q8" && !specs[id]!.remote) assert.match(r ?? "", /^[0-9a-f]{12}([0-9a-f]{28})?$/, id);
  });
  it("a hosted candidate has no weights to pin: it names the served model and the wording, so a rerun of the same claims is its parity check", () => {
    for (const [id, s] of Object.entries(specs)) {
      if (!s.remote) continue;
      assert.match(s.remote.url, /^https:\/\//, `${id}: hosted over HTTPS`);
      assert.equal(s.remote.declaredId, `${s.remote.model}:${s.remote.wording}`, `${id}: the declared identity is the served model id and the wording`);
    }
  });
  it("put the d3 pair on different weights", () => {
    assert.notEqual(specs["d3-lite"]!.adapter!.env.UKTUB_D3_MODEL, specs["d3-edge"]!.adapter!.env.UKTUB_D3_MODEL);
  });
  it("ask for the GPU everywhere an engine has the choice", () => {
    assert.equal(specs["d3-lite"]!.adapter!.env.UKTUB_D3_DEVICE, "cuda:0");
    assert.equal(specs["d1-omni"]!.adapter!.env.UKTUB_D1_DEVICE, "cuda:0");
    assert.equal(specs["intern-0.8b"]!.adapter!.env.UKTUB_INTERN_DEVICE, "cuda:0");
  });
  it("serve Kev with the author's own server from local directories, offline, on the GPU, one wording per spec", () => {
    const a = specs["kev-0.8b"]!.server!;
    const b = specs["kev-0.8b-native"]!.server!;
    assert.deepEqual([a.wording, b.wording], ["criteria", "native"]);
    assert.match(a.declaredId, /:criteria$/);
    assert.match(b.declaredId, /:native$/);
    for (const srv of [a, b]) {
      assert.match(srv.command.join(" "), /kev\.serve/);
      assert.equal(srv.env.HF_HUB_OFFLINE, "1", "never downloads at run time");
      assert.equal(srv.env.CUDA_VISIBLE_DEVICES, "0");
      assert.ok(srv.command.includes("/h/kev/run"), "serves the local, repointed run directory");
      assert.ok(srv.url.endsWith(`:${srv.command[srv.command.indexOf("--port") + 1]}`), "the url names the port the server is started on");
    }
  });
  it("run the portable 8-bit ONNX artifact of Eos on the GPU through the product's eos-onnx engine, with the venv's own CUDA libraries on the path", () => {
    const q8 = specs["eos-q8"]!;
    assert.equal(q8.engine, "eos-onnx");
    assert.equal(q8.env.UKTUB_EOS_ONNX_PYTHON, "/h/decision2/venv/bin/python", "the environment that has onnxruntime-gpu");
    for (const lib of ["cudnn", "cublas", "cuda_runtime"]) assert.ok((q8.env.LD_LIBRARY_PATH ?? "").includes(`/h/decision2/venv/lib/python3.12/site-packages/nvidia/${lib}/lib`), lib);
    assert.equal(q8.env.UKTUB_DECISION2_DEVICE, "cuda");
  });
});

