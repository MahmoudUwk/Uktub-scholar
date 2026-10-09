# Benchmarks

Immutable evaluation datasets and the runner protocol. Dated results are in [docs/benchmarks/](../docs/benchmarks/); adoption
rationale is in [DECISIONS](../docs/DECISIONS.md); current behavior is in the [README](../README.md). An implemented adapter
is not an adopted verifier, and a historical run is not a fresh verification of this checkout.

## Datasets

`benchmarks/datasets/<name>-v<N>/` holds `claims.json` (data) and `manifest.json` (schema, corpus pointer, authorship, rules).
A published dataset is immutable: a fix is a new `-v<N+1>`. The corpus PDFs stay out of the repository (locally in the
gitignored `test_papers/`); the manifest records where they live and the extraction command (`pdftotext -q`).

**claim-verification-v1**: 135 claims over 14 real papers (74 TRUE / 61 FALSE; numeric, method, finding and dataset kinds). Each
claim is `{id, paper, claim, label, evidence, kind}`; `evidence` is a verbatim quote, programmatically verified in its paper.
Authored by an independent subagent and curated by the orchestrator (2026-10-02).

Adding a dataset: new folder with data and manifest in the same shape; an independent author labels, the orchestrator verifies
every ground-truth artifact programmatically and drops what cannot be verified (both steps recorded in the manifest); add the
run command here. Results are never edited by hand.

## Running an engine

Node >= 22.19 (types stripped natively). `--text-dir` holds `<paper-id>.txt` files (`pdftotext -q`).

```bash
# Local engine, exhaustive chunked evaluation (isolated env: see the Decision 2.0 status report)
node scripts/bench-claim-verify.ts --dataset benchmarks/datasets/claim-verification-v1 --text-dir /path/to/text \
  --engine decision2-eos --chunked --text-mode paragraph \
  --chunk-tokens 8192 --overlap-tokens 128 --chars-per-token 2.8 --boundary paragraph

# Hosted engine (network and quota required)
OPENROUTER_API_KEY=... UKTUB_OPENROUTER_MODEL=inception/mercury-decide:free \
  node scripts/bench-claim-verify.ts --text-dir /path/to/text --engine openrouter --chunked
```

The runner imports only the chunker, the config loader and the `ClaimEngine` adapters, keeps chunks in memory and caches scores
in `~/.cache/uktub-bench/score-cache.json` (keyed by engine, revision, claim hash and chunk hash; `--cache FILE`, `--no-cache`).

- **Modes.** Without `--chunked`, a claim sees the first 24,000 characters of its paper (`--cap`). With it, every chunk is
  verified. `--chunk-tokens`, `--overlap-tokens`, `--chars-per-token` and `--boundary` override `config/chunking.yaml`; give all
  four to be independent of that file. `--workers N` sets lanes for network engines (resident local engines use one).
- **Text mode.** `--text-mode normalized` (default, the historical text) collapses whitespace, so paragraph chunking splits at
  hard offsets; `paragraph` keeps blank-line paragraph breaks.
- **Output.** A report `.md` and a `.results.json` per run in `docs/benchmarks/` (`--out-dir`, `--tag`), with raw per-claim and
  per-chunk probabilities, token counts, refusals and errors; gold quotes are never an input. `--rerender FILE [--bar X]`
  recomputes every metric from stored scores without a model.
- **The bar is a score threshold, not a precision.** `UKTUB_VERIFY_MIN_CONFIDENCE` (default 0.99) cuts the engine's raw output,
  which is not a calibrated probability. Read precision off the report: Eos supports 38 claims at 0.99 and 37 are true (0.97).
- **Metrics (fixed 2026-10-04).** AUC is tie-corrected over each claim's best checked chunk. Support metrics (false supports,
  precision, recall, abstention, checked coverage) come from raw scores at any bar; a low score abstains and never refutes. The
  historical two-sided figure is labelled *compatibility decided accuracy*. Over-limit or failed rows are unchecked, never scored
  as negatives. Older reports used rank-sum AUC without tie correction: see
  [historical-auc-recomputed](../docs/benchmarks/historical-auc-recomputed-2026-10-04.md). Tests: `node --test tests/bench-metrics.spec.ts`.
- **Engines.** `julia` (runner default, not the package default), `k2`, `laya`, `bev`, `lumma`, `openrouter`, `openrouter-chat`
  (needs `UKTUB_OPENROUTER_CHAT_MODEL`), `decision2-kai`, `decision2-eos`, `vela`. The `decision2-*` engines use
  `scripts/decision2_decide.py` through `scripts/decision2-client.ts`, which keeps per-row refusals as results. They need an
  isolated venv (torch, transformers >= 5.17), pinned revisions and `UKTUB_DECISION2_MODEL` / `_REVISION` / `_PYTHON`; commands,
  pins and results: [Decision 2.0 status report](../docs/benchmarks/decision2-evaluation-status-2026-10-04.md). Adapters are in
  [claim.ts](../src/core/verify/claim.ts) and [engines.ts](../src/core/verify/engines.ts).

Adoption bars: **AUC >= 0.80 and decided accuracy >= 0.90** on this dataset. That is dataset evidence, not a guarantee for
unseen papers.

## Evidence-quality experiment (`scripts/bench-evidence.ts`)

Measures the package's own claim-to-supporting-passage workflow (unpdf extraction, FTS5 locator, two-stage judgment,
containment) on `claim-verification-v1` with a real local engine behind the `llama-cpp` path. It needs the PDFs and a GPU.

```bash
UKTUB_DECISION2_MODEL=… UKTUB_DECISION2_REVISION=… UKTUB_DECISION2_PYTHON=… node scripts/system-one-server.ts --port 8099
node scripts/bench-evidence.ts --phase retrieval                     # locator recall vs K and window (no engine)
node scripts/bench-evidence.ts --phase endtoend --chunk-tokens 2048 --papers tuning|held-out --label T2048
node scripts/bench-evidence.ts --phase redact --private-dir <outside repo> --results <files>   # keep exemplars only
node scripts/bench-evidence.ts --phase report --name end-to-end --results <redacted files>
node scripts/bench-evidence.ts --phase review-out --results <private files> --out <outside repo>
node scripts/bench-evidence.ts --phase review-in --labels <labels.json>
```

Papers split by source: even-indexed tune, odd-indexed are held out. Committed results keep spans, scores and 160-character
exemplars only; full excerpts stay outside the repository. Reports: `docs/benchmarks/evidence-retrieval-*`,
`evidence-quality-*`, `evidence-review-*`.

## Skills and the manuscript review

Skill acceptance runs (a real model, a real paper) are archived in [docs/benchmarks/skills/](../docs/benchmarks/skills/README.md). The four deterministic measures of
`uktub-scholar review` are checked against the published scores of SciSlopBench with `scripts/bench-review-parity.ts`
([latest report](../docs/benchmarks/review-parity-2026-10-09.md)).
