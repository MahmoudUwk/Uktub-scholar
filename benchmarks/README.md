# Benchmarks

Immutable evaluation datasets and dated engine evidence. Current package
behavior belongs to [README](../README.md); adoption rationale to
[DECISIONS](../docs/DECISIONS.md). An implemented adapter is not necessarily
an adopted verifier. Historical runs are not fresh checkout verification;
the latest Mercury CLI attempt was quota-blocked.

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
# Local engine, exhaustive chunked evaluation (Decision 2.0 Kai; isolated env, see the status report):
node scripts/bench-claim-verify.ts \
  --dataset benchmarks/datasets/claim-verification-v1 \
  --text-dir /path/to/extracted-paper-text \
  --engine decision2-kai --chunked --text-mode paragraph \
  --chunk-tokens 8192 --overlap-tokens 128 --chars-per-token 2.8 --boundary paragraph

# Hosted engine (network/quota required; not run in the Decision 2.0 evaluation):
OPENROUTER_API_KEY=... UKTUB_OPENROUTER_MODEL=inception/mercury-decide:free \
  node scripts/bench-claim-verify.ts --text-dir /path/to/text --engine openrouter --chunked
```

Run from this checkout with Node >= 22.19 (types are stripped natively).
`--text-dir` holds `<paper-id>.txt` files matching the dataset
(`pdftotext -q`, per the manifest). The runner is self-contained: it imports
only the chunker, the config loader and the `ClaimEngine` adapters, keeps
chunks in memory, and caches scores in JSON
(`~/.cache/uktub-bench/score-cache.json`, keyed by engine id, revision, claim
hash and chunk hash; `--cache FILE` or `--no-cache`).

- **Modes.** Without `--chunked`, each claim sees the first 24,000 characters of
  its paper (`--cap` overrides). With `--chunked`, every chunk of the paper is
  verified. Chunk flags (`--chunk-tokens`, `--overlap-tokens`,
  `--chars-per-token`, `--boundary`) override `config/chunking.yaml`; give all
  four to make a run independent of that file. `--workers N` sets concurrent
  lanes for network engines (resident local engines run one lane).
- **Text mode.** `--text-mode normalized` (default) is the manifest/historical
  text: whitespace collapsed, so the paragraph chunker has no paragraph breaks
  and splits at hard offsets. `--text-mode paragraph` keeps blank-line
  paragraph breaks from `pdftotext`.
- **Output.** Each run writes a report `.md` and a `.results.json` into
  `docs/benchmarks/` (`--out-dir`, `--tag` for variants). The JSON holds raw
  per-claim and per-chunk probabilities, token counts, refusals and errors;
  gold evidence quotes are never an input. `--rerender FILE [--bar X]`
  recomputes every metric and the report from the stored raw scores without a
  model. `UKTUB_VERIFY_MIN_CONFIDENCE` sets the bar (default 0.99).
- **The bar is a score threshold, not a precision.** `UKTUB_VERIFY_MIN_CONFIDENCE` (default 0.99) is a cut on the engine's raw output; the engines' scores are not calibrated probabilities. Read precision off the report: Eos supports 38 claims at 0.99 and 37 are true (0.97).
- **Metrics (fixed 2026-10-04).** AUC is tie-corrected (average ranks) over
  each claim's best checked chunk. Support metrics come from raw scores at any
  bar: false supports, support precision/recall, abstention rate, checked
  coverage. A low score abstains; it never refutes. The historical two-sided
  figure is kept and labelled **compatibility decided accuracy**. Threshold
  sweeps are recomputed from raw probabilities, never from verdicts fixed at
  another bar. Over-limit or failed rows are unchecked (reported, never
  scored as negatives), and mixed cached/fresh chunk scores are aligned by
  chunk. Older reports used rank-sum AUC without tie correction and fixed
  verdicts; see
  [historical-auc-recomputed](../docs/benchmarks/historical-auc-recomputed-2026-10-04.md).
  Tests: `node --test tests/bench-metrics.spec.ts`.

Runner engines: `julia` (runner default, not the package default), `k2`, `laya`,
`bev`, `lumma`, `openrouter`, `openrouter-chat`, `decision2-kai`,
`decision2-eos`. `llama-cpp` is a package engine, not a runner option;
`openrouter-chat` is benchmark-only and requires
`UKTUB_OPENROUTER_CHAT_MODEL`. Existing adapters are in
[claim.ts](../src/core/verify/claim.ts) and [engines.ts](../src/core/verify/engines.ts).
The `decision2-*` engines use `scripts/decision2_decide.py` (same JSONL
protocol as `julia_decide.py`) through `scripts/decision2-client.ts`, which keeps
per-row refusals and errors as results instead of failing the batch. Setup:
an isolated venv (torch, transformers >= 5.17), pinned checkpoint
revisions, `UKTUB_DECISION2_MODEL` / `_REVISION` / `_PYTHON`; commands, pins and
results are in the
[Decision 2.0 status report](../docs/benchmarks/decision2-evaluation-status-2026-10-04.md).
`scripts/` is not in `tsconfig.json`; the two test files that import it are,
so `pnpm exec tsc --noEmit` checks the metric and client modules.

Adoption bars: **AUC ≥ 0.80 and decided accuracy ≥ 0.90** on this dataset.
The [2026-10-03 hosted-model report](../docs/benchmarks/openrouter-decision-models-2026-10-03.md)
records Mercury chunked AUC 0.998, 108/109 correct decisions at bar 0.99,
and zero false positives in that run. This is dataset evidence, not a
guarantee for unseen papers. Local/rejected-model reports and raw JSON remain
in [docs/benchmarks](../docs/benchmarks/).

## Adding a dataset

1. New folder `datasets/<capability>-v1/` with `data` + `manifest.json`
   (same shape: data file, schema, corpus pointer, authorship, rules).
2. Labeling: independent author (subagent) → orchestrator verifies every
   evidence/ground-truth artifact programmatically → drop anything
   unverifiable. Record both steps in the manifest.
3. Add the run command to this README. Results are never edited by hand.

## Evidence-quality experiment (`scripts/bench-evidence.ts`)

Measures the package's own claim → supporting-passage workflow (unpdf extraction, FTS5 locator,
two-stage judgment, containment) on `claim-verification-v1`, with a real local engine behind the
`llama-cpp` path. Not a contract test; needs the owner's PDFs and a GPU.

```bash
# Decision 2.0 Eos behind a System One endpoint (pinned revision, isolated venv from the status report)
UKTUB_DECISION2_MODEL=… UKTUB_DECISION2_REVISION=… UKTUB_DECISION2_PYTHON=… \
  node scripts/system-one-server.ts --port 8099
node scripts/bench-evidence.ts --phase retrieval                       # locator recall vs K and window (no engine)
node scripts/bench-evidence.ts --phase endtoend --chunk-tokens 2048 --papers tuning|held-out --label T2048
node scripts/bench-evidence.ts --phase redact --private-dir <outside repo> --results <files>   # keep exemplars only
node scripts/bench-evidence.ts --phase report --name end-to-end --results <redacted files>
node scripts/bench-evidence.ts --phase review-out --results <private full-excerpt files> --out <outside repo>
node scripts/bench-evidence.ts --phase review-in --labels <labels.json>
```

Papers split by source: even-indexed tune, odd-indexed are held out. Committed result files keep
spans, scores and 160-character exemplars only; full excerpts stay outside the repository.
Reports: `docs/benchmarks/evidence-retrieval-*`, `evidence-quality-*`, `evidence-review-*`.

