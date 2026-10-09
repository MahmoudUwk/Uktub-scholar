#!/usr/bin/env python3
"""Resident Vela 2.0 claim-support engine: the 0.3B on ONNX Runtime (no PyTorch, no transformers) or any Vela 2.0 size on PyTorch
(the 0.8B has no ONNX export). The JSONL protocol of the other resident workers, so the adapter, the judgment cache and the
confidence bar are unchanged.

Row:    {"state": "<passage>", "instructions": "<claim>"}
Reply:  {"p_true": <float>, "tokens": <int>}   P(supported) that the passage supports the claim.
Error:  {"error": "<text>"} per row; the session keeps answering.
First stdout line: {"ready": true, ...} with the effective model identity. {"exit": true} ends the session.

How a claim is posed: Vela's trained hallucination question ("which spans of the answer are not supported by the context?",
labels from calibration.json) over state {"source": passage, "answer": claim}. The model returns, per word of the answer, the
probability that it is unsupported; the highest of them is the claim's unsupported probability, and
P(supported) = 1 - that. A claim is only as supported as its least-supported word. Vela windows inputs longer than its
input budget itself (8,192 tokens for the 0.3B, 16,384 for the 0.8B; logits averaged), so nothing is truncated or refused here.

Environment:
  UKTUB_VELA_DIR               directory holding vela2_inference.py, config.json, calibration.json, tokenizer.json and the weights   (required)
  UKTUB_VELA_REVISION          pinned revision label of the snapshot (required; recorded in the identity)
  UKTUB_VELA_BACKEND           "onnx" (default) or "torch"
  UKTUB_VELA_DEVICE            "cpu" (default) or "cuda" (torch only; bf16 autocast on CUDA, the evaluated setting, FP32 on CPU)
  UKTUB_VELA_WEIGHTS_FILE      weights relative to the directory: default onnx/model.onnx (onnx) or model.safetensors (torch); the 0.3B's
                               onnx/model_fp16.onnx is the fp16 encoder, the 0.8B's is model-00001-of-00001.safetensors
  UKTUB_VELA_WEIGHTS_SHA256    expected sha256 of that weights file; a mismatch refuses to start (optional)
  UKTUB_VELA_INFERENCE_SHA256  expected sha256 of vela2_inference.py, which this worker EXECUTES; a mismatch refuses to start (optional)
  UKTUB_VELA_STDERR            optional file for stderr
Dependencies (own env): onnx backend: onnxruntime, numpy, tokenizers; torch backend: torch, transformers>=5.17, safetensors, numpy, tokenizers.
"""
import hashlib
import importlib.util
import json
import math
import os
import sys
import time

_trace = os.environ.get("UKTUB_VELA_STDERR")
if _trace:
    sys.stderr = open(_trace, "a", buffering=1)

DEFAULT_WEIGHTS = {"onnx": "onnx/model.onnx", "torch": "model.safetensors"}


def safe_print(payload: dict) -> None:
    """stdout write that survives a closed adapter pipe (EPIPE = stop quietly)."""
    try:
        print(json.dumps(payload), flush=True)
    except BrokenPipeError:
        raise SystemExit(0)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def check_digest(path: str, label: str, expected: str | None) -> str:
    digest = sha256_file(path)
    if expected and expected != digest:
        raise ValueError(f"{label} sha256 {digest[:16]}… does not match the pinned {expected[:16]}…")
    return digest


def package_version(name: str):
    try:
        from importlib.metadata import version

        return version(name)
    except Exception:  # noqa: BLE001
        return None


def main() -> int:
    model_dir = os.environ.get("UKTUB_VELA_DIR")
    revision = os.environ.get("UKTUB_VELA_REVISION")
    if not model_dir or not revision:
        safe_print({"error": "UKTUB_VELA_DIR and UKTUB_VELA_REVISION are required (pinned snapshot)"})
        return 1
    backend = os.environ.get("UKTUB_VELA_BACKEND") or "onnx"
    device = os.environ.get("UKTUB_VELA_DEVICE") or "cpu"
    if backend not in DEFAULT_WEIGHTS:
        safe_print({"error": f"UKTUB_VELA_BACKEND must be onnx or torch, not {backend!r}"})
        return 1
    if device not in ("cpu", "cuda") or (backend == "onnx" and device != "cpu"):
        safe_print({"error": f"UKTUB_VELA_DEVICE must be cpu or cuda (cuda needs UKTUB_VELA_BACKEND=torch), not {device!r} with backend {backend}"})
        return 1
    weights_file = os.environ.get("UKTUB_VELA_WEIGHTS_FILE") or DEFAULT_WEIGHTS[backend]
    try:
        t0 = time.time()
        inference = os.path.join(model_dir, "vela2_inference.py")
        weights = os.path.join(model_dir, weights_file)
        for needed in (inference, weights):
            if not os.path.isfile(needed):
                raise FileNotFoundError(needed)
        inference_sha = check_digest(inference, "vela2_inference.py", os.environ.get("UKTUB_VELA_INFERENCE_SHA256"))
        weights_sha = check_digest(weights, weights_file, os.environ.get("UKTUB_VELA_WEIGHTS_SHA256"))
        spec = importlib.util.spec_from_file_location("vela2_inference", inference)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if backend == "onnx":
            engine = module.Vela2.from_pretrained(model_dir, backend="onnx", onnx_file=weights_file)
        else:
            # no backend argument: torch is the default of the 0.3B class and the only backend of the 0.8B class
            engine = module.Vela2.from_pretrained(model_dir, device=device, amp_bf16=device == "cuda")
        schema = engine.cal["halu_schema"]
        question = {"type": "span", "instructions": schema["text"], "criteria": schema["labels"]}
        load_s = time.time() - t0
    except Exception as e:  # noqa: BLE001
        safe_print({"error": f"vela model failed to load: {type(e).__name__}: {e}"})
        return 1

    safe_print({
        "ready": True,
        "model": "Vela-2.0",
        "revision": revision,
        "backend": backend,
        "weights_file": weights_file,
        "model_sha256": weights_sha,
        "inference_sha256": inference_sha,
        "model_ref": model_dir,
        "device": device,
        "load_s": round(load_s, 3),
        "versions": {name: package_version(name) for name in ("onnxruntime", "torch", "transformers", "numpy", "tokenizers")} | {"python": sys.version.split()[0]},
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception as e:  # noqa: BLE001
            safe_print({"error": f"bad row: {e}"})
            continue
        if row.get("exit"):
            break
        try:
            state, claim = row["state"], row["instructions"]
            if not isinstance(state, str) or not state.strip() or not isinstance(claim, str) or not claim.strip():
                safe_print({"error": "state and instructions must be non-empty text"})
                continue
            result = engine.system_one(state={"source": state, "answer": claim}, questions={"halu": question})
            unsupported = result["answers"]["halu"]["noul"]
            if not isinstance(unsupported, (int, float)) or not math.isfinite(unsupported) or unsupported < 0.0 or unsupported > 1.0:
                safe_print({"error": f"invalid probability {unsupported!r}"})
                continue
            reply = {"p_true": 1.0 - float(unsupported)}
            tokens = (result.get("usage") or {}).get("input_tokens")
            if isinstance(tokens, int):
                reply["tokens"] = tokens
            safe_print(reply)
        except Exception as e:  # noqa: BLE001 — one bad row must not kill the loop
            safe_print({"error": f"{type(e).__name__}: {e}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
