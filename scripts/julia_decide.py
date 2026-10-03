#!/usr/bin/env python3
"""Resident Julia-1 decision engine: loads the checkpoint once, then answers
JSONL rows on stdin (one decision per line) until stdin closes.

Row format:  {"state": "<passage>", "instructions": "<question text>"}
Reply:       {"p_true": <float>}  — probability that the state entails the
question. Built for uktub-scholar claim verification (src/core/verify/claim.ts).

Environment: the `julia` package (pip install -e <Julia-1 checkpoint>) plus
torch/transformers. UKTUB_JULIA_MODEL names the checkpoint (path or HF repo
id; default: the published SupersonicLabs/Julia-1).
"""
import json
import os
import sys


def main() -> int:
    try:
        from huggingface_hub import snapshot_download
        from julia import load_model
    except ImportError as e:
        print(json.dumps({"error": f"julia package not importable: {e}"}), flush=True)
        return 1
    checkpoint = os.environ.get("UKTUB_JULIA_MODEL") or "SupersonicLabs/Julia-1"
    if not os.path.isdir(checkpoint):
        checkpoint = snapshot_download(checkpoint)
    engine = load_model(checkpoint, device="cpu", strict_encoding=True)
    print(json.dumps({"ready": True}), flush=True)
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
            question["instructions"] = (
                f'Claim under test: "{row["instructions"]}" Decide whether the state '
                "passage explicitly supports this claim. Answer true only if the "
                "passage itself states or directly entails the claim; answer false "
                "when the passage contradicts it or says nothing about it."
            )
            answer = engine.predict(state=row["state"], questions={"claim": dict(question)})["answers"]["claim"]
            print(json.dumps({"p_true": answer["noul"]}), flush=True)
        except Exception as e:  # noqa: BLE001 — one bad row must not kill the loop
            print(json.dumps({"error": str(e)}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
