/**
 * claim-verification-v2 CPU gate (owner rule, 2026-10-11: refuse any model that takes more than 2 seconds to run a chunk on CPU): how the
 * seconds per chunk come out of a real run on CPU, and how a spec is turned into its CPU variant. Offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { secondsPerChunkOf } from "../scripts/bench-claims-v2-cpu-gate.ts";
import { cpuVariant, engineSpecs } from "../scripts/bench-claims-v2-engines.ts";
import type { RunRecord } from "../scripts/bench-claims-v2.ts";

const rec = (wallMs: number, fresh: number, localizationFresh = 0): RunRecord => ({
  id: "c", paper: "p", label: "TRUE", type: "reworded", fold: 0, score: 0.5, unjudged: 0, chunks: fresh, supportFound: false, fresh, cached: 0, localizationFresh, wallMs, refused: null,
});

describe("seconds per chunk of a run on CPU", () => {
  it("is the median over claims of wall time per fresh judgment, localization checks included", () => {
    const x = secondsPerChunkOf([rec(60_000, 60), rec(130_000, 60, 10), rec(300_000, 100)]) as number;
    assert.ok(Math.abs(x - 130 / 70) < 1e-12, `1 s, 130/70 = 1.857 s and 3 s: the median is 1.857, got ${x}`);
  });
  it("ignores a claim with no fresh judgment (reused work is no time), and is null when nothing was judged", () => {
    assert.equal(secondsPerChunkOf([rec(1000, 0), rec(10_000, 10)]), 1);
    assert.equal(secondsPerChunkOf([rec(1000, 0)]), null);
  });
});

describe("the CPU variant of an engine spec", () => {
  const specs = engineSpecs("/h");
  it("turns every device setting of a worker into cpu", () => {
    assert.equal(cpuVariant(specs["vela-0.8b"]!).env.UKTUB_VELA_DEVICE, "cpu");
    assert.equal(cpuVariant(specs["d3-lite"]!).adapter!.env.UKTUB_D3_DEVICE, "cpu");
    assert.equal(cpuVariant(specs["d1-omni"]!).adapter!.env.UKTUB_D1_DEVICE, "cpu");
    assert.equal(cpuVariant(specs["intern-0.8b"]!).adapter!.env.UKTUB_INTERN_DEVICE, "cpu");
  });
  it("runs a model whose runtime hard-codes bfloat16 in float32 on the CPU, which has no bfloat16 matrix hardware here, and keeps the shipped dtype on the GPU", () => {
    assert.equal(specs["d3-lite"]!.adapter!.env.UKTUB_D3_DTYPE, "bfloat16");
    assert.equal(specs["d3-edge"]!.adapter!.env.UKTUB_D3_DTYPE, "bfloat16");
    assert.equal(cpuVariant(specs["d3-lite"]!).adapter!.env.UKTUB_D3_DTYPE, "float32");
    assert.equal(cpuVariant(specs["d3-edge"]!).adapter!.env.UKTUB_D3_DTYPE, "float32");
  });
  it("hides the GPU from a server so it cannot use it", () => {
    assert.equal(cpuVariant(specs["kev-0.8b"]!).server!.env.CUDA_VISIBLE_DEVICES, "");
  });
  it("leaves the original untouched and keeps what is not a device setting", () => {
    cpuVariant(specs["d3-lite"]!);
    assert.equal(specs["d3-lite"]!.adapter!.env.UKTUB_D3_DEVICE, "cuda:0");
    assert.equal(cpuVariant(specs["d3-lite"]!).adapter!.env.UKTUB_D3_PROMPT, "criteria");
  });
  it("has a product CPU path for Eos: the 8-bit ONNX export", () => {
    assert.equal(specs["eos-onnx"]!.engine, "eos-onnx");
  });
});
