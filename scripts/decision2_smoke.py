#!/usr/bin/env python3
"""Functional smoke for scripts/decision2_decide.py against a real checkpoint:
output schema, score mapping on support / unrelated / contradiction /
numeric-mismatch / negation cases, valid probabilities, over-limit refusal and
row-error behavior. Prints one JSON document (committed as evidence).

Usage: decision2_smoke.py <kai|eos> <revision> [model-dir]
Python: the isolated env (~/.cache/uktub-bench/decision2/venv).
"""
import json
import os
import subprocess
import sys

name, revision = sys.argv[1], sys.argv[2]
home = os.path.expanduser("~/.cache/uktub-bench/decision2")
model_dir = sys.argv[3] if len(sys.argv) > 3 else f"{home}/models/{name}"
env = dict(os.environ, UKTUB_DECISION2_MODEL=model_dir, UKTUB_DECISION2_REVISION=revision)
worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "decision2_decide.py")
p = subprocess.Popen([sys.executable, worker], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
ready = json.loads(p.stdout.readline())

PASSAGE = (
    "We collected 2,400 recordings from 12 volunteers using a single microphone array. "
    "The classifier reaches 94.2% accuracy on the held-out test set. "
    "No camera data was used in any experiment. The model is not trained with federated learning."
)
CASES = [
    ("explicit support", "support", "The classifier achieves 94.2% accuracy on the held-out test set."),
    ("paraphrase support", "support", "The dataset consists of 2,400 recordings gathered from twelve volunteers."),
    ("unrelated claim", "not-support", "The Eiffel Tower is located in Berlin."),
    ("contradiction", "not-support", "The classifier reaches only 71% accuracy on the held-out test set."),
    ("numeric mismatch", "not-support", "The study collected 240 recordings from 12 volunteers."),
    ("negated claim, false", "not-support", "Camera data was used in the experiments."),
    ("negated claim, true", "support", "The experiments did not use camera data."),
    ("negated claim 2, true", "support", "The model is not trained with federated learning."),
    ("negated claim 2, false", "not-support", "The model is trained with federated learning."),
]


def send(obj):
    p.stdin.write(json.dumps(obj) + "\n")
    p.stdin.flush()
    return json.loads(p.stdout.readline())


cases = []
for label, expected, claim in CASES:
    r = send({"state": PASSAGE, "instructions": claim})
    cases.append({"case": label, "expected": expected, "claim": claim, **r, "mapped_ok": (r.get("p_true", 0) >= 0.5) == (expected == "support")})
checks = {
    "count_op": send({"count": True, "state": PASSAGE, "instructions": CASES[0][2]}),
    "over_limit_refusal": send({"state": "word " * 20000, "instructions": "x claim"}),
    "empty_state": send({"state": "", "instructions": "x claim"}),
    "missing_key": send({"state": "abc"}),
}
p.stdin.write("not json\n")
p.stdin.flush()
checks["bad_json"] = json.loads(p.stdout.readline())
stats = send({"stats": True})["stats"]
p.stdin.write(json.dumps({"exit": True}) + "\n")
p.stdin.flush()
exit_code = p.wait(timeout=60)
finite = all(isinstance(c.get("p_true"), float) and 0.0 <= c["p_true"] <= 1.0 for c in cases)
print(json.dumps({"ready": ready, "cases": cases, "worker_checks": checks, "stats": stats, "clean_exit_code": exit_code, "all_probabilities_finite_in_unit_interval": finite}, indent=1))
