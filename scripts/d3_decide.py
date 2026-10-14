#!/usr/bin/env python3
"""Resident Decision 3.0 decision engine (vllm-sr/d3-edge): loads one pinned checkpoint once, then answers JSONL rows on stdin until
stdin closes. The protocol of scripts/decision2_decide.py, so scripts/decision2-client.ts and the benchmark runner are unchanged.

Row:    {"state": "<passage>", "instructions": "<claim>"}
Reply:  {"p_true": <float>, "tokens": <int>}   P(true) that the passage supports the claim.
Error:  {"error": "<text>"} per row; a row the model could not take is refused, never truncated: {"error": ..., "refused": true}.
First stdout line: {"ready": true, ...} with the effective model identity.

Extra ops (benchmark only): {"stats": true} -> {"stats": {...}}; {"exit": true} ends the session. {"count": true} is not supported:
d3 reports the tokens it read per answer (usage.input_tokens), which is what the reply carries.

How a claim is posed (UKTUB_D3_PROMPT): `criteria` (default) is the same question, wording and criteria as the Decision 2.0 worker (a
`noul` yes/no question over the passage as the state), so a result is comparable with the Eos and Kai runs. `native` is the style of
d3's own README (a plain yes/no question, no criteria), declared before it was run as the one sensitivity check of the wording.
d3 answers `{"noul": P(yes)}`.

Environment:
  UKTUB_D3_MODEL     local snapshot directory of vllm-sr/d3-edge (required)
  UKTUB_D3_REVISION  pinned commit hash of the snapshot (required; recorded in the identity)
  UKTUB_D3_DEVICE    default cuda:0 if available else cpu
  UKTUB_D3_DTYPE     `bfloat16` (default: as the runtime ships, it loads the backbone in bfloat16 on every device) or `float32` (the
                     backbone is cast after loading, exactly: bfloat16 values are representable in float32). On a CPU with no
                     bfloat16 matrix hardware float32 is about 3 times faster (docs/DECISIONS.md); on a GPU leave the default.
  UKTUB_D3_PROMPT    `criteria` (default) or `native`
  UKTUB_D3_STDERR    optional file for stderr
The snapshot is loaded fully offline (HF_HUB_OFFLINE=1). It runs the snapshot's own code (trust_remote_code): review the files at the
pinned revision before pointing this at a new one. Dependencies (own env): torch, transformers==5.17.0 (the version d3 is validated
with), accelerate, safetensors, einops, pillow; flash-linear-attention is optional (without it transformers uses its slower reference path).
"""
import json
import math
import os
import sys
import time

_trace = os.environ.get("UKTUB_D3_STDERR")
if _trace:
    sys.stderr = open(_trace, "a", buffering=1)

# Same claim wording and noul criteria as the decision2 worker (like-for-like).
CRITERIA = {
    "true": "The passage explicitly states or directly entails the claim.",
    "false": "The passage contradicts the claim or says nothing about it.",
}


def safe_print(payload: dict) -> None:
    """stdout write that survives a closed adapter pipe (EPIPE = stop quietly)."""
    try:
        print(json.dumps(payload), flush=True)
    except BrokenPipeError:
        raise SystemExit(0)


def question_for(claim: str, style: str = "criteria") -> dict:
    if style == "native":
        return {"claim": {"type": "noul", "instructions": f'Does the state explicitly support this claim? Claim: "{claim}"'}}
    return {
        "claim": {
            "type": "noul",
            "instructions": (
                f'Claim under test: "{claim}" Decide whether the state '
                "passage explicitly supports this claim. Answer true only if the "
                "passage itself states or directly entails the claim; answer false "
                "when the passage contradicts it or says nothing about it."
            ),
            "criteria": dict(CRITERIA),
        }
    }


def main() -> int:
    model_ref = os.environ.get("UKTUB_D3_MODEL")
    revision = os.environ.get("UKTUB_D3_REVISION")
    if not model_ref or not revision:
        safe_print({"error": "UKTUB_D3_MODEL and UKTUB_D3_REVISION are required (pinned checkpoint)"})
        return 1
    if not os.path.isdir(model_ref):
        safe_print({"error": "UKTUB_D3_MODEL must be a local snapshot directory (the worker never downloads)"})
        return 1
    style = os.environ.get("UKTUB_D3_PROMPT", "criteria")
    if style not in ("criteria", "native"):
        safe_print({"error": f"UKTUB_D3_PROMPT must be criteria or native, not {style!r}"})
        return 1
    dtype = os.environ.get("UKTUB_D3_DTYPE", "bfloat16")
    if dtype not in ("bfloat16", "float32"):
        safe_print({"error": f"UKTUB_D3_DTYPE must be bfloat16 or float32, not {dtype!r}"})
        return 1
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    try:
        import torch
        import transformers
        from transformers import AutoModel

        t0 = time.time()
        kwargs = {"trust_remote_code": True}  # reviewed at the pinned revision (see docs/benchmarks)
        device = os.environ.get("UKTUB_D3_DEVICE")
        if device:
            kwargs["device"] = device
        model = AutoModel.from_pretrained(model_ref, **kwargs)
        if dtype == "float32":
            model.runtime.backbone.float()  # the runtime's own code is untouched; the readout is float32 already
        load_s = time.time() - t0
        runtime_device = str(model.runtime.device)
        limit = model.max_input_tokens
    except Exception as e:  # noqa: BLE001
        safe_print({"error": f"d3 model failed to load: {type(e).__name__}: {e}"})
        return 1

    on_cuda = runtime_device.startswith("cuda")
    if on_cuda:
        torch.cuda.reset_peak_memory_stats()
    safe_print({
        "ready": True,
        "model": model.model_name,
        "model_ref": model_ref,
        "revision": revision,
        "prompt": style,
        "dtype": dtype,
        "model_sha256": model.manifest["identity"]["model_sha256"],
        "max_input_tokens": limit,  # null: d3 configures no limit and never truncates
        "device": runtime_device,
        "load_s": round(load_s, 3),
        "vram_after_load_mib": round(torch.cuda.memory_allocated() / 2**20, 1) if on_cuda else None,
        "versions": {"torch": torch.__version__, "cuda": torch.version.cuda, "transformers": transformers.__version__, "python": sys.version.split()[0]},
        "gpu": torch.cuda.get_device_name(0) if on_cuda else None,
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
            safe_print({"stats": {
                "rows_scored": rows_scored,
                "tokens_scored": tokens_scored,
                "infer_s": round(infer_s, 3),
                "peak_vram_mib": round(torch.cuda.max_memory_allocated() / 2**20, 1) if on_cuda else None,
                "peak_vram_reserved_mib": round(torch.cuda.max_memory_reserved() / 2**20, 1) if on_cuda else None,
            }})
            continue
        if row.get("count"):
            safe_print({"error": "count is not supported by the d3 worker"})
            continue
        try:
            state, claim = row["state"], row["instructions"]
            if not isinstance(state, str) or not state.strip() or not isinstance(claim, str) or not claim.strip():
                safe_print({"error": "state and instructions must be non-empty text"})
                continue
            t1 = time.time()
            result = model.system_one(state=state, questions=question_for(claim, style))
            if on_cuda:
                torch.cuda.synchronize()
            infer_s += time.time() - t1
            tokens = int(result["usage"]["input_tokens"])
            answer = result["answers"]["claim"]
            if "error" in answer:
                refused = answer["error"] == "max_length_exceeded"
                payload = {"error": f"model answered {answer['error']}: {answer.get('message', '')}", "tokens": tokens}
                if refused:
                    payload["refused"] = True
                safe_print(payload)
                continue
            p = answer["noul"]
            if not isinstance(p, float) or not math.isfinite(p) or p < 0.0 or p > 1.0:
                safe_print({"error": f"invalid probability {p!r}", "tokens": tokens})
                continue
            rows_scored += 1
            tokens_scored += tokens
            safe_print({"p_true": p, "tokens": tokens})
        except Exception as e:  # noqa: BLE001 — one bad row must not kill the loop
            safe_print({"error": f"{type(e).__name__}: {e}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
