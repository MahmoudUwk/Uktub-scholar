#!/usr/bin/env python3
"""Resident Decision 2.0 decision engine (vllm-sr/Decision-2.0-Kai-0.6B and
Eos-0.8B): loads one pinned checkpoint once, then answers JSONL rows on stdin
until stdin closes. Same protocol as scripts/julia_decide.py.

Row:    {"state": "<passage>", "instructions": "<claim>"}
Reply:  {"p_true": <float>, "tokens": <int>}   P(true) that the passage supports the claim.
Error:  {"error": "<text>"} per row; a refused over-limit row also carries
        "refused": true, "tokens": N, "limit": L. Refusals are explicit: the
        input is never truncated and the caller must count it as unchecked.
First stdout line: {"ready": true, ...} with the effective model identity.

Extra ops (benchmark only; the plain protocol above is unchanged):
  {"count": true, "state": ..., "instructions": ...} -> {"tokens": N, "limit": L}
  {"stats": true}                                      -> {"stats": {...}}
  {"exit": true}                                       -> clean shutdown

Token accounting uses the checkpoint's OWN encoder on the complete serialized
prompt (context + task type + claim instructions + both option blocks +
suffix), i.e. what the model reads; the runtime's usage.input_tokens must
agree or the row fails.

Environment:
  UKTUB_DECISION2_MODEL     local snapshot directory, or an HF repo id (required)
  UKTUB_DECISION2_REVISION  pinned commit hash (required; used as the Hub
                            revision for repo ids and recorded for local dirs)
  UKTUB_DECISION2_DEVICE    default cuda:0 if available else cpu
  UKTUB_DECISION2_STDERR    optional file for stderr
A local directory is loaded fully offline (HF_HUB_OFFLINE=1).
Dependencies (isolated env): torch, transformers>=5.17, safetensors.
"""
import json
import math
import os
import sys
import time

_trace = os.environ.get("UKTUB_DECISION2_STDERR")
if _trace:
    sys.stderr = open(_trace, "a", buffering=1)

# Same claim wording and noul criteria as the julia/laya workers (like-for-like).
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
            "criteria": dict(CRITERIA),
        }
    }


def main() -> int:
    model_ref = os.environ.get("UKTUB_DECISION2_MODEL")
    revision = os.environ.get("UKTUB_DECISION2_REVISION")
    if not model_ref or not revision:
        safe_print({"error": "UKTUB_DECISION2_MODEL and UKTUB_DECISION2_REVISION are required (pinned checkpoint)"})
        return 1
    local = os.path.isdir(model_ref)
    if local:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    try:
        import importlib

        import torch
        import transformers
        from transformers import AutoModel

        t0 = time.time()
        kwargs = {"trust_remote_code": True}  # reviewed at the pinned revision (see docs/benchmarks)
        if not local:
            kwargs["revision"] = revision
        device = os.environ.get("UKTUB_DECISION2_DEVICE")
        if device:
            kwargs["device"] = device
        model = AutoModel.from_pretrained(model_ref, **kwargs)
        load_s = time.time() - t0
        backend = model.runtime.backend
        base_pkg = type(backend).__module__.rsplit(".", 1)[0]
        vendored = importlib.import_module(base_pkg + "._vendor.dev2model.decision_model")
        infer = importlib.import_module(base_pkg + "._vendor.dev2model.infer")
        tokenizer = backend.tokenizer
        encode_fn = backend.encode_fn or vendored.encode
        limit = int(model.max_input_tokens)
    except Exception as e:  # noqa: BLE001
        safe_print({"error": f"decision2 model failed to load: {type(e).__name__}: {e}"})
        return 1

    on_cuda = str(backend.device).startswith("cuda")
    if on_cuda:
        torch.cuda.reset_peak_memory_stats()

    def count_tokens(state: str, claim: str) -> int:
        row = infer.question_to_row({"id": "request", "state": state}, "claim", question_for(claim)["claim"])
        return len(encode_fn(row, tokenizer, 10**9)["ids"])  # huge cap: only count here; the limit is enforced below

    safe_print({
        "ready": True,
        "model": model.model_name,
        "model_ref": model_ref,
        "revision": revision,
        "model_sha256": model.manifest["identity"]["model_sha256"],
        "max_input_tokens": limit,
        "device": str(backend.device),
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
        try:
            state, claim = row["state"], row["instructions"]
            if not isinstance(state, str) or not state.strip() or not isinstance(claim, str) or not claim.strip():
                safe_print({"error": "state and instructions must be non-empty text"})
                continue
            tokens = count_tokens(state, claim)
            if row.get("count"):
                safe_print({"tokens": tokens, "limit": limit})
                continue
            if tokens > limit:
                safe_print({"error": f"context_limit: {tokens} tokens exceeds the {limit}-token window; refused, not truncated", "refused": True, "tokens": tokens, "limit": limit})
                continue
            t1 = time.time()
            result = model.system_one(state=state, questions=question_for(claim))
            if on_cuda:
                torch.cuda.synchronize()
            infer_s += time.time() - t1
            answer = result["answers"]["claim"]
            if "error" in answer:
                safe_print({"error": f"model answered {answer['error']}", "tokens": tokens})
                continue
            p = answer["noul"]
            used = result["usage"]["input_tokens"]
            if used != tokens:
                safe_print({"error": f"token accounting mismatch: counted {tokens}, runtime used {used}", "tokens": tokens})
                continue
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
