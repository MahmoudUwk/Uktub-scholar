/**
 * Vela 2.0 worker contract (scripts/vela_decide.py), offline: the worker runs against a stand-in `vela2_inference.py` so the
 * protocol, the claim-to-question mapping, the digest guards and the per-row error handling are pinned without the model.
 * Row {"state": passage, "instructions": claim} -> {"p_true"}; P(supported) = 1 - the model's highest unsupported-word
 * probability for the claim. The real model is exercised by the env-gated test at the end (UKTUB_VELA_DIR).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INFERENCE = `
import json, os

class Vela2:
    @classmethod
    def from_pretrained(cls, path, backend="torch", onnx_file="onnx/model.onnx", device="cpu", amp_bf16=False, **kw):
        o = cls()
        o.cal = {"halu_schema": {"text": "Which spans of the answer are not supported by the context?",
                                 "labels": {"unsupported": "a claim not supported by the context"}}}
        o.load = {"path": path, "backend": backend, "onnx_file": onnx_file, "device": device, "amp_bf16": amp_bf16}
        return o

    def system_one(self, state, questions):
        with open(os.environ["FAKE_TRACE"], "a") as f:
            f.write(json.dumps({"load": self.load, "state": state, "questions": questions}) + "\\n")
        claim = state["answer"]
        if claim == "boom":
            raise RuntimeError("model exploded")
        noul = {"supported claim": 0.004, "unsupported claim": 0.93, "not a number": float("nan"), "out of range": 1.5}[claim]
        return {"answers": {"halu": {"type": "noul", "noul": noul}}}
`;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fixture(): { dir: string; trace: string; weightsSha: string; inferenceSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "vela-fake-"));
  mkdirSync(join(dir, "onnx"));
  writeFileSync(join(dir, "vela2_inference.py"), INFERENCE);
  writeFileSync(join(dir, "onnx", "model.onnx"), "fake weights");
  return { dir, trace: join(dir, "trace.jsonl"), weightsSha: sha256("fake weights"), inferenceSha: sha256(INFERENCE) };
}

function run(env: Record<string, string>, rows: object[], python = "python3", timeoutMs = 20_000): { status: number | null; lines: Record<string, unknown>[] } {
  const r = spawnSync(python, ["scripts/vela_decide.py"], {
    encoding: "utf8",
    input: rows.map((x) => JSON.stringify(x)).join("\n") + "\n",
    env: { PATH: process.env.PATH ?? "", ...env },
    timeout: timeoutMs,
  });
  const lines = r.stdout.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  return { status: r.status, lines };
}

describe("vela worker (stand-in inference module)", () => {
  it("refuses to start without a model directory and a pinned revision", () => {
    const { status, lines } = run({}, []);
    assert.equal(status, 1);
    assert.match(String(lines[0]?.error), /UKTUB_VELA_DIR/);
    assert.match(String(lines[0]?.error), /UKTUB_VELA_REVISION/);
  });

  it("announces itself, then answers P(supported) = 1 - the unsupported-word probability, in row order", () => {
    const f = fixture();
    const { status, lines } = run(
      { UKTUB_VELA_DIR: f.dir, UKTUB_VELA_REVISION: "rev1", FAKE_TRACE: f.trace },
      [{ state: "The trial enrolled 1,204 adults.", instructions: "supported claim" }, { state: "p", instructions: "unsupported claim" }],
    );
    assert.equal(status, 0);
    assert.equal(lines[0]?.ready, true);
    assert.equal(lines[0]?.revision, "rev1");
    assert.equal(lines[0]?.weights_file, "onnx/model.onnx");
    assert.equal(lines[0]?.backend, "onnx");
    assert.ok(Math.abs((lines[1]?.p_true as number) - 0.996) < 1e-9);
    assert.ok(Math.abs((lines[2]?.p_true as number) - 0.07) < 1e-9);
  });

  it("poses the passage as the source and the claim as the answer, with the trained hallucination question, on the ONNX backend", () => {
    const f = fixture();
    run({ UKTUB_VELA_DIR: f.dir, UKTUB_VELA_REVISION: "rev1", FAKE_TRACE: f.trace }, [{ state: "PASSAGE TEXT", instructions: "supported claim" }]);
    const call = JSON.parse(readFileSync(f.trace, "utf8").trim().split("\n")[0]!) as {
      load: { path: string; backend: string; onnx_file: string; device: string; amp_bf16: boolean };
      state: unknown;
      questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }>;
    };
    assert.deepEqual(call.load, { path: f.dir, backend: "onnx", onnx_file: "onnx/model.onnx", device: "cpu", amp_bf16: false });
    assert.deepEqual(call.state, { source: "PASSAGE TEXT", answer: "supported claim" });
    assert.deepEqual(Object.keys(call.questions), ["halu"]);
    assert.equal(call.questions.halu?.type, "span");
    assert.equal(call.questions.halu?.instructions, "Which spans of the answer are not supported by the context?");
    assert.deepEqual(call.questions.halu?.criteria, { unsupported: "a claim not supported by the context" });
  });

  it("refuses weights or inference code that do not match the pinned digests (the inference script is executed code)", () => {
    const f = fixture();
    const base = { UKTUB_VELA_DIR: f.dir, UKTUB_VELA_REVISION: "rev1", FAKE_TRACE: f.trace };
    const ok = run({ ...base, UKTUB_VELA_WEIGHTS_SHA256: f.weightsSha, UKTUB_VELA_INFERENCE_SHA256: f.inferenceSha }, [{ state: "p", instructions: "supported claim" }]);
    assert.equal(ok.lines[0]?.ready, true, "matching digests start normally");
    const badWeights = run({ ...base, UKTUB_VELA_WEIGHTS_SHA256: "0".repeat(64) }, []);
    assert.equal(badWeights.status, 1);
    assert.match(String(badWeights.lines[0]?.error), /sha256/);
    assert.match(String(badWeights.lines[0]?.error), /model\.onnx/);
    const badCode = run({ ...base, UKTUB_VELA_INFERENCE_SHA256: "f".repeat(64) }, []);
    assert.equal(badCode.status, 1);
    assert.match(String(badCode.lines[0]?.error), /vela2_inference\.py/);
  });

  it("the torch backend (Vela 2.0 0.8B has no ONNX export) loads on the requested device, with bf16 autocast on CUDA as evaluated", () => {
    const f = fixture();
    writeFileSync(join(f.dir, "model.safetensors"), "fake torch weights");
    const base = { UKTUB_VELA_DIR: f.dir, UKTUB_VELA_REVISION: "rev1", FAKE_TRACE: f.trace, UKTUB_VELA_BACKEND: "torch", UKTUB_VELA_WEIGHTS_FILE: "model.safetensors" };
    const gpu = run({ ...base, UKTUB_VELA_DEVICE: "cuda", UKTUB_VELA_WEIGHTS_SHA256: sha256("fake torch weights") }, [{ state: "p", instructions: "supported claim" }]);
    assert.equal(gpu.lines[0]?.ready, true);
    assert.deepEqual([gpu.lines[0]?.backend, gpu.lines[0]?.device, gpu.lines[0]?.weights_file], ["torch", "cuda", "model.safetensors"]);
    const loads = readFileSync(f.trace, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { load: { backend: string; device: string; amp_bf16: boolean } }).load);
    assert.deepEqual([loads[0]?.backend, loads[0]?.device, loads[0]?.amp_bf16], ["torch", "cuda", true]);
    const cpu = run({ ...base, UKTUB_VELA_DEVICE: "cpu" }, [{ state: "p", instructions: "supported claim" }]);
    const cpuLoad = JSON.parse(readFileSync(f.trace, "utf8").trim().split("\n").at(-1)!) as { load: { backend: string; device: string; amp_bf16: boolean } };
    assert.deepEqual([cpu.lines[0]?.device, cpuLoad.load.device, cpuLoad.load.amp_bf16], ["cpu", "cpu", false], "FP32 on CPU");
  });

  it("refuses an unknown backend or device instead of guessing", () => {
    const f = fixture();
    const base = { UKTUB_VELA_DIR: f.dir, UKTUB_VELA_REVISION: "rev1", FAKE_TRACE: f.trace };
    const badBackend = run({ ...base, UKTUB_VELA_BACKEND: "tensorrt" }, []);
    assert.equal(badBackend.status, 1);
    assert.match(String(badBackend.lines[0]?.error), /UKTUB_VELA_BACKEND/);
    const badDevice = run({ ...base, UKTUB_VELA_DEVICE: "tpu" }, []);
    assert.equal(badDevice.status, 1);
    assert.match(String(badDevice.lines[0]?.error), /UKTUB_VELA_DEVICE/);
  });

  it("a bad row yields an error line and the session keeps answering", () => {
    const f = fixture();
    const { status, lines } = run({ UKTUB_VELA_DIR: f.dir, UKTUB_VELA_REVISION: "rev1", FAKE_TRACE: f.trace }, [
      { state: "p", instructions: "   " },
      { state: "p", instructions: "boom" },
      { state: "p", instructions: "not a number" },
      { state: "p", instructions: "out of range" },
      { state: "p", instructions: "supported claim" },
    ]);
    assert.equal(status, 0);
    assert.match(String(lines[1]?.error), /non-empty/);
    assert.match(String(lines[2]?.error), /model exploded/);
    assert.match(String(lines[3]?.error), /invalid probability/);
    assert.match(String(lines[4]?.error), /invalid probability/);
    assert.ok(Math.abs((lines[5]?.p_true as number) - 0.996) < 1e-9);
  });

  it("stops on an exit row", () => {
    const f = fixture();
    const { status, lines } = run({ UKTUB_VELA_DIR: f.dir, UKTUB_VELA_REVISION: "rev1", FAKE_TRACE: f.trace }, [{ exit: true }, { state: "p", instructions: "supported claim" }]);
    assert.equal(status, 0);
    assert.equal(lines.length, 1, "only the ready line: the row after exit is never read");
  });
});

describe("vela worker (real model, env-gated)", () => {
  const dir = process.env.UKTUB_VELA_DIR ?? "";
  it("separates a supported claim from a wrong number and an off-topic claim", { skip: dir === "" }, () => {
    const passage = "In this randomized trial of 1,204 adults, metformin reduced HbA1c by 1.1 percentage points over 24 weeks compared with placebo (p<0.001).";
    const optional = Object.fromEntries(["UKTUB_VELA_BACKEND", "UKTUB_VELA_DEVICE", "UKTUB_VELA_WEIGHTS_FILE"].flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));
    const { lines } = run(
      { UKTUB_VELA_DIR: dir, UKTUB_VELA_REVISION: process.env.UKTUB_VELA_REVISION ?? "local", ...optional },
      [
        { state: passage, instructions: "Metformin lowered HbA1c compared with placebo over 24 weeks." },
        { state: passage, instructions: "Metformin reduced HbA1c by 3.5 percentage points." },
        { state: passage, instructions: "The trial enrolled children under ten years old." },
      ],
      process.env.UKTUB_VELA_PYTHON ?? "python3",
      180_000, // a real model: load plus the first forward passes
    );
    const [supported, wrongNumber, offTopic] = [lines[1], lines[2], lines[3]].map((l) => l?.p_true as number);
    assert.ok(supported! > wrongNumber! && supported! > offTopic!, `${supported} ${wrongNumber} ${offTopic}`);
  });
});
