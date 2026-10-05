#!/usr/bin/env python3
"""Resident Decision 2.0 Eos engine on ONNX Runtime: no PyTorch, no transformers. The same JSONL protocol as
scripts/decision2_decide.py (the torch worker), so the adapter, the judgment cache and the 0.99 bar are unchanged.

Row:    {"state": "<passage>", "instructions": "<claim>"}
Reply:  {"p_true": <float>, "tokens": <int>}   P(true) that the passage supports the claim.
Error:  {"error": "<text>"} per row; an over-limit row also carries "refused": true, "tokens": N, "limit": L (never truncated).
First stdout line: {"ready": true, ...} with the effective model identity.
Extra ops: {"count": true, ...} -> {"tokens": N, "limit": L}; {"stats": true}; {"exit": true}.

Measured against the torch worker on 450 (claim, passage) judgments (docs/benchmarks/eos-onnx-parity-2026-10-05.md): the 8-bit
export `model_quantized` agrees 100% at the 0.99 bar (max |delta| 0.086, no bias near the bar). The 4-bit `model_q4f16` does NOT
(5 flips at the bar, -0.05 mid-range bias) and is refused here.

Environment:
  UKTUB_DECISION2_ONNX_DIR     directory holding tokenizer.json and onnx/model_quantized.onnx(+_data)   (required)
  UKTUB_DECISION2_REVISION     pinned revision label of the export (required; recorded in the identity)
  UKTUB_DECISION2_ONNX_SHA256  expected sha256 of onnx/model_quantized.onnx_data; a mismatch refuses to start (optional)
  UKTUB_DECISION2_DEVICE       "cpu" or "cuda" (default: cuda when onnxruntime-gpu offers it, else cpu)
  UKTUB_DECISION2_STDERR       optional file for stderr
Dependencies (isolated env): onnxruntime (or onnxruntime-gpu), numpy, tokenizers.
"""
import hashlib
import json
import math
import os
import sys
import time

_trace = os.environ.get("UKTUB_DECISION2_STDERR")
if _trace:
    sys.stderr = open(_trace, "a", buffering=1)

VARIANT = "model_quantized"  # the only validated export; see the module docstring
DEFAULT_LIMIT = 16384

# Same claim wording and criteria as the torch worker (like-for-like prompts, token-exact).
CRITERIA = {
    "true": "The passage explicitly states or directly entails the claim.",
    "false": "The passage contradicts the claim or says nothing about it.",
}
SUFFIX = "\n\nSelect the single option best supported by the context and instructions.\nDecision:"


def safe_print(payload: dict) -> None:
    """stdout write that survives a closed adapter pipe (EPIPE = stop quietly)."""
    try:
        print(json.dumps(payload), flush=True)
    except BrokenPipeError:
        raise SystemExit(0)


def canon(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def claim_instructions(claim: str) -> str:
    return (
        f'Claim under test: "{claim}" Decide whether the state passage explicitly supports this claim. Answer true only if the '
        "passage itself states or directly entails the claim; answer false when the passage contradicts it or says nothing about it."
    )


def encode_prompt(tokenizer, state: str, claim: str):
    """Token ids, the last-token position of each option block, and the answer position (the final token)."""
    prefix = f"Context:\n{state}\n\nTask type: noul\nQuestion:\n{claim_instructions(claim)}\nOptions:"
    ids = tokenizer.encode(prefix, add_special_tokens=False).ids
    option_positions = []
    for key in ("true", "false"):
        block = "\n<option>\n" + canon({"key": key, "description": CRITERIA[key]}) + "\n</option>"
        ids = ids + tokenizer.encode(block, add_special_tokens=False).ids
        option_positions.append(len(ids) - 1)
    ids = ids + tokenizer.encode(SUFFIX, add_special_tokens=False).ids
    return ids, option_positions, len(ids) - 1


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    model_dir = os.environ.get("UKTUB_DECISION2_ONNX_DIR")
    revision = os.environ.get("UKTUB_DECISION2_REVISION")
    if not model_dir or not revision:
        safe_print({"error": "UKTUB_DECISION2_ONNX_DIR and UKTUB_DECISION2_REVISION are required (pinned export)"})
        return 1
    try:
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer

        t0 = time.time()
        graph = os.path.join(model_dir, "onnx", f"{VARIANT}.onnx")
        data = graph + "_data"
        for needed in (graph, data, os.path.join(model_dir, "tokenizer.json")):
            if not os.path.isfile(needed):
                raise FileNotFoundError(needed)
        digest = sha256_file(data)
        expected = os.environ.get("UKTUB_DECISION2_ONNX_SHA256")
        if expected and expected != digest:
            raise ValueError(f"weights sha256 {digest[:16]}… does not match the pinned {expected[:16]}…")
        tokenizer = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
        limit = DEFAULT_LIMIT
        config = os.path.join(model_dir, "config.json")
        if os.path.isfile(config):
            with open(config, encoding="utf-8") as f:
                limit = int(json.load(f).get("decision2", {}).get("max_input_tokens", DEFAULT_LIMIT))
        available = ort.get_available_providers()
        want = (os.environ.get("UKTUB_DECISION2_DEVICE") or "").lower()
        if want == "cuda" and "CUDAExecutionProvider" not in available:
            raise RuntimeError("UKTUB_DECISION2_DEVICE=cuda but onnxruntime has no CUDAExecutionProvider (install onnxruntime-gpu)")
        use_cuda = want == "cuda" or (want == "" and "CUDAExecutionProvider" in available)
        providers = [("CUDAExecutionProvider", {"device_id": 0}), "CPUExecutionProvider"] if use_cuda else ["CPUExecutionProvider"]
        options = ort.SessionOptions()
        options.log_severity_level = 3
        session = ort.InferenceSession(graph, options, providers=providers)
        load_s = time.time() - t0
    except Exception as e:  # noqa: BLE001
        safe_print({"error": f"decision2 onnx model failed to load: {type(e).__name__}: {e}"})
        return 1

    device = "cuda:0" if session.get_providers()[0] == "CUDAExecutionProvider" else "cpu"
    safe_print({
        "ready": True,
        "model": "Decision-2.0-Eos-0.8B-ONNX",
        "variant": VARIANT,
        "model_ref": model_dir,
        "revision": revision,
        "model_sha256": digest,
        "max_input_tokens": limit,
        "device": device,
        "load_s": round(load_s, 3),
        "versions": {"onnxruntime": ort.__version__, "numpy": np.__version__, "python": sys.version.split()[0]},
    })

    infer_s = 0.0
    rows_scored = 0
    tokens_scored = 0
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
        if row.get("stats"):
            safe_print({"stats": {"rows_scored": rows_scored, "tokens_scored": tokens_scored, "infer_s": round(infer_s, 3), "peak_vram_mib": None}})
            continue
        try:
            state, claim = row["state"], row["instructions"]
            if not isinstance(state, str) or not state.strip() or not isinstance(claim, str) or not claim.strip():
                safe_print({"error": "state and instructions must be non-empty text"})
                continue
            ids, option_positions, answer_position = encode_prompt(tokenizer, state, claim)
            tokens = len(ids)
            if row.get("count"):
                safe_print({"tokens": tokens, "limit": limit})
                continue
            if tokens > limit:
                safe_print({"error": f"context_limit: {tokens} tokens exceeds the {limit}-token window; refused, not truncated", "refused": True, "tokens": tokens, "limit": limit})
                continue
            t1 = time.time()
            batch = np.array([ids], dtype=np.int64)
            (logits,) = session.run(None, {
                "input_ids": batch,
                "attention_mask": np.ones_like(batch),
                "answer_pos": np.array([answer_position], dtype=np.int64),
                "option_pos": np.array([option_positions], dtype=np.int64),
            })
            infer_s += time.time() - t1
            z = logits[0].astype(np.float64)
            p = np.exp(z - z.max())
            p /= p.sum()
            p_true = float(p[0])  # option order [true, false]
            if not math.isfinite(p_true) or p_true < 0.0 or p_true > 1.0:
                safe_print({"error": f"invalid probability {p_true!r}", "tokens": tokens})
                continue
            rows_scored += 1
            tokens_scored += tokens
            safe_print({"p_true": p_true, "tokens": tokens})
        except Exception as e:  # noqa: BLE001 — one bad row must not kill the loop
            safe_print({"error": f"{type(e).__name__}: {e}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
