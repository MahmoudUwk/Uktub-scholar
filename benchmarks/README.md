# Benchmarks

Durable evaluation sets + the runner for any capability that makes a
model-shaped decision (claim verification today; retrieval, writing quality,
and compile diagnostics later). Rule: **no engine is adopted without passing
the relevant dataset here** (docs/DECISIONS.md, evidence gate).

## Layout

```
benchmarks/
├── README.md                        ← this file: where data lives, how to run
└── datasets/
    └── claim-verification-v1/       ← one dataset = one folder
        ├── claims.json              ← the labeled claims
        └── manifest.json            ← counts, schema, corpus location, rules
```

- **Datasets** live in `benchmarks/datasets/<name>-v<N>/` — `claims.json`
  (data) + `manifest.json` (schema, corpus location, authorship, rules).
  Datasets are immutable once published: fixes mean a new `-v<N+1>`.
- **Corpus** (the papers themselves) stays OUT of the repo — the manifest
  records where the PDFs live and the extraction command (`pdftotext`).
- **Reports** (dated run results: metrics, tables, verdicts) go to
  `docs/benchmarks/<engine>-<dataset>-<date>.md` with the raw results JSON
  beside them.

## Datasets

### claim-verification-v1

135 claims over 14 real papers (74 TRUE / 61 FALSE; numeric/method/finding/
dataset kinds). Each claim: `{id, paper, claim, label, evidence, kind}` —
`label` is ground truth, `evidence` is a verbatim quote proving it (checked
programmatically: every quote was found in its paper). Authored by an
independent subagent, verified and curated by the orchestrator (2026-10-02).
See `datasets/claim-verification-v1/manifest.json` for schema and rules.

## Running an engine

```bash
# Julia-class engine (UKTUB_JULIA_MODEL names the checkpoint; python3 needs
# the julia package — see scripts/julia_decide.py):
UKTUB_JULIA_PYTHON=~/.venvs/julia/bin/python \
  node --experimental-strip-types scripts/bench-claim-verify.ts \
  --dataset benchmarks/datasets/claim-verification-v1 \
  --text-dir /tmp/claims-bench/text \
  --engine julia
```

The runner prints the metrics table (confusion at the 0.99 bar, threshold
sweep, AUC, timing) and writes a dated report to `docs/benchmarks/`. Engine
quality bars for claim verification (set 2026-10-02 after the two-model
sweep): **AUC ≥ 0.80 and decided-accuracy ≥ 0.90 on this dataset** before an
engine is adopted; sub-1B encoder classifiers measured at AUC 0.529
(Julia-1) and 0.541/0.533 accuracy (GLiNER2.5-Decide) — see
`docs/benchmarks/claim-verification-julia1-2026-10-02.md`.

## Adding a dataset

1. New folder `datasets/<capability>-v1/` with `data` + `manifest.json`
   (same shape: data file, schema, corpus pointer, authorship, rules).
2. Labeling: independent author (subagent) → orchestrator verifies every
   evidence/ground-truth artifact programmatically → drop anything
   unverifiable. Record both steps in the manifest.
3. Add the run command to this README. Results are never edited by hand.
