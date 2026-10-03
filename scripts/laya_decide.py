#!/usr/bin/env python3
"""Resident Laya decision engine (Router mode, the model card's recommended
usage): loads checkpoints once, then answers JSONL rows on stdin until stdin
closes.

Row format:  {"state": "<passage>", "instructions": "<claim>"}
Reply:       {"p_true": <float>}  — P(true) that the state supports the claim.

Long-document prescription from the model card (convaiinnovations/laya):
long mostly-English text would otherwise route to the English checkpoint,
which reads only 512 tokens — so every prediction pins
`model="multilingual"` and `max_len=8192`. noul criteria spell out the
entailment semantics the same way as the julia worker (like-for-like).

Environment: `pip install laya` (+ torch CUDA) in UKTUB_LAYA_PYTHON.
"""
import json
import os
import sys
import time

_trace = os.environ.get("UKTUB_LAYA_STDERR")
if _trace:
    sys.stderr = open(_trace, "a", buffering=1)  # line-buffered trace of crashes/warnings


def safe_print(payload: str) -> None:
    """stdout write that survives a closed adapter pipe (EPIPE = stop quietly)."""
    try:
        print(payload, flush=True)
    except BrokenPipeError:
        raise SystemExit(0)


def main() -> int:
    try:
        from laya import Router
    except ImportError as e:
        print(json.dumps({"error": f"laya package not importable: {e}"}), flush=True)
        return 1
    router = Router(device=os.environ.get("UKTUB_LAYA_DEVICE", "cuda"))
    router.preload(["multilingual"])  # only the checkpoint this worker uses: preload(True) would load all three and strain 8 GB GPUs
    safe_print(json.dumps({"ready": True}))
    question = {
        "type": "noul",
        "instructions": "",
        "criteria": {
            "true": "The passage explicitly states or directly entails the claim.",
            "false": "The passage contradicts the claim or says nothing about it.",
        },
    }
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception as e:  # noqa: BLE001
            safe_print(json.dumps({"error": f"bad row: {e}"}))
            continue
        if row.get("exit"):
            break  # clean shutdown sentinel from the adapter (no orphaned VRAM)
        try:
            question["instructions"] = (
                f'Claim under test: "{row["instructions"]}" Decide whether the state '
                "passage explicitly supports this claim. Answer true only if the "
                "passage itself states or directly entails the claim; answer false "
                "when the passage contradicts it or says nothing about it."
            )
            t0 = time.time()
            result = router.predict(
                row["state"],
                {"claim": dict(question)},
                model="multilingual",  # card: long text must not route to the 512-token English checkpoint
                max_len=8192,          # card: multilingual ships with 1024; pass 8192 for long documents
            )
            try:
                import gc
                import torch
                gc.collect()
                torch.cuda.empty_cache()  # 8k-token forwards fragment the allocator over hundreds of rows
            except Exception:
                pass
            print(f"[laya-trace] row ok in {time.time()-t0:.2f}s, chars={len(row['state'])}", file=sys.stderr)
            safe_print(json.dumps({"p_true": result["answers"]["claim"]["noul"]}))
        except Exception as e:  # noqa: BLE001 — one bad row must not kill the loop
            safe_print(json.dumps({"error": str(e)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
