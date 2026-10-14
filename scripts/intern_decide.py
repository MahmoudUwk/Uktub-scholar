#!/usr/bin/env python3
"""Resident Intern-Decision-0.8B decision engine (internlm/Intern-Decision-0.8B): loads one pinned checkpoint once, then answers JSONL rows on stdin until
stdin closes. The protocol of scripts/decision2_decide.py, so scripts/decision2-client.ts and the benchmark runner are unchanged.

Row:    {"state": "<passage>", "instructions": "<claim>"}
Reply:  {"p_true": <float>, "tokens": <int>}   P(yes) that the passage supports the claim.
Error:  {"error": "<text>"} per row; a row the model could not take is refused, never truncated: {"error": ..., "refused": true}.
First stdout line: {"ready": true, ...} with the effective model identity.

Extra ops (benchmark only): {"stats": true} -> {"stats": {...}}; {"exit": true} ends the session. {"count": true} is not supported:
intern reports the tokens it read per answer (usage.input_tokens), which is what the reply carries.

How a claim is posed (schema mapping onto Intern-Decision's own request schema):
  passage -> request["state"] (the shared state, verbatim).
  claim   -> request["questions"]["claim"]["instructions"], using exactly the
            criteria-style wording of the Decision 3.0 worker:
            'Claim under test: "<claim>" Decide whether the state passage
            explicitly supports this claim. Answer true only if the passage
            itself states or directly entails the claim; answer false when the
            passage contradicts it or says nothing about it.'
  criteria -> request["questions"]["claim"]["criteria"] =
            {"false": "The passage contradicts the claim or says nothing about it.",
             "true": "The passage explicitly states or directly entails the claim."}
            ("false"/"true" keys select Intern-Decision's no/yes options with
            these descriptions; option order is fixed no-then-yes.)
The question type is "noul" (binary no/yes). p_true is the calibrated
probability of "yes" (answers["claim"]["noul"] after the checkpoint's default
temperature scaling, T=2.747760550703). Text only: no images are ever sent.

Environment:
  UKTUB_INTERN_MODEL     local snapshot directory of Intern-Decision-0.8B (required)
  UKTUB_INTERN_REVISION  pinned commit hash of the snapshot (required; recorded in the identity)
  UKTUB_INTERN_DEVICE    default cuda:0 if available else cpu
  UKTUB_INTERN_PROMPT    `criteria` (default; the only supported style)
  UKTUB_INTERN_STDERR    optional file for stderr
The snapshot is loaded fully offline (HF_HUB_OFFLINE=1). Dependencies (own env):
the snapshot's requirements.txt (torch, torchvision, transformers, Pillow).
"""
import hashlib
import json
import math
import os
import sys
import time

_trace = os.environ.get("UKTUB_INTERN_STDERR")
if _trace:
    sys.stderr = open(_trace, "a", buffering=1)

PINNED_MODEL = "internlm/Intern-Decision-0.8B"

# Same claim wording and noul criteria as the d3/decision2 workers (like-for-like).
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


def question_for(claim: str) -> dict:
    return {
        "claim": {
            "type": "noul",
            "instructions": (
                f'Claim under test: "{claim}" Decide whether the state '
                "passage explicitly supports this claim. Answer true only if the "
                "passage itself states or directly entails the claim; answer false "
                "when the passage contradicts it or says nothing about it."
            ),
            "criteria": {"false": CRITERIA["false"], "true": CRITERIA["true"]},
        }
    }


def sha_of_index(model_ref: str) -> str:
    """sha256 of the weights index (model.safetensors.index.json), which names every shard."""
    h = hashlib.sha256()
    with open(os.path.join(model_ref, "model.safetensors.index.json"), "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    model_ref = os.environ.get("UKTUB_INTERN_MODEL")
    revision = os.environ.get("UKTUB_INTERN_REVISION")
    if not model_ref or not revision:
        safe_print({"error": "UKTUB_INTERN_MODEL and UKTUB_INTERN_REVISION are required (pinned checkpoint)"})
        return 1
    if not os.path.isdir(model_ref):
        safe_print({"error": "UKTUB_INTERN_MODEL must be a local snapshot directory (the worker never downloads)"})
        return 1
    style = os.environ.get("UKTUB_INTERN_PROMPT", "criteria")
    if style != "criteria":
        safe_print({"error": f"UKTUB_INTERN_PROMPT must be criteria, not {style!r}"})
        return 1
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    try:
        import torch
        import transformers

        sys.path.insert(0, model_ref)
        from inference import DecisionEngine

        device = os.environ.get("UKTUB_INTERN_DEVICE")
        if not device:
            device = "cuda:0" if torch.cuda.is_available() else "cpu"
        t0 = time.time()
        # float32 on CPU (bf16 matmuls are slow/unavailable on some CPUs); default bf16 on CUDA.
        engine = DecisionEngine(
            checkpoint=model_ref,
            device=device,
            dtype="float32" if torch.device(device).type == "cpu" else "bfloat16",
        )
        load_s = time.time() - t0
        limit = engine.backend.max_length
        runtime_device = str(engine.backend.device)
    except Exception as e:  # noqa: BLE001
        safe_print({"error": f"intern model failed to load: {type(e).__name__}: {e}"})
        return 1

    on_cuda = runtime_device.startswith("cuda")
    if on_cuda:
        torch.cuda.reset_peak_memory_stats()
    try:
        digest = sha_of_index(model_ref)
    except Exception as e:  # noqa: BLE001
        safe_print({"error": f"cannot hash weights index: {e}"})
        return 1
    safe_print({
        "ready": True,
        "model": "Intern-Decision-0.8B",
        "model_ref": model_ref,
        "revision": revision,
        "prompt": style,
        "model_sha256": f"index:{digest}",
        "max_input_tokens": limit,
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
            safe_print({"error": "count is not supported by the intern worker"})
            continue
        try:
            state, claim = row["state"], row["instructions"]
            if not isinstance(state, str) or not state.strip() or not isinstance(claim, str) or not claim.strip():
                safe_print({"error": "state and instructions must be non-empty text"})
                continue
            t1 = time.time()
            try:
                result = engine.predict({"state": state, "questions": question_for(claim)})
            except ValueError as e:
                if "truncation is forbidden" in str(e) or "above" in str(e):
                    safe_print({"error": f"refused: {e}", "refused": True})
                    continue
                raise
            if on_cuda:
                torch.cuda.synchronize()
            infer_s += time.time() - t1
            tokens = int(result["usage"]["input_tokens"])
            answer = result["answers"]["claim"]
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
