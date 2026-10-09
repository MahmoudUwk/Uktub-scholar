# Decision 2.0 (Kai 0.6B, Eos 0.8B) — evaluation status, 2026-10-04

Decision: **neither model is adopted and no default changed.** Both were
evaluated end to end on the immutable `claim-verification-v1` dataset (135
claims, 74 TRUE / 61 FALSE, 14 papers). Every row of every run was checked:
no skipped rows, no invalid outputs, no incomplete runs. The one run that hit
the context limit (Kai, policy B) is disclosed below.

- **Eos 0.8B** discriminates well (AUC 0.968, 95% CI 0.937-0.990) and, at the
  package's 0.99 bar, supports 38 of 135 claims with 1 false support
  (support precision 0.974, recall 0.500). It works as a conservative
  support finder; recall at 0.99 is half the TRUE claims.
- **Kai 0.6B** discriminates almost as well (AUC 0.955, CI 0.921-0.983) but
  its probabilities never exceed 0.93, so it supports **zero** claims at the
  0.99 bar. Its ranking is useful; its scores are not on the scale the 0.99
  policy assumes. The package policy was not changed to fit it.
- Neither model reads a 24,000-character prefix well (AUC 0.700 / 0.707):
  only 37 of 74 TRUE claims have their gold quote inside that prefix.
  Exhaustive chunking is what makes both usable.

All numbers below are **new measurements** from this session unless a row
says "historical". Raw per-claim and per-chunk probabilities are in the
`*.results.json` files; every metric is recomputed from them.

## Pins and environment

| Item | Value |
|---|---|
| Kai checkpoint | `vllm-sr/Decision-2.0-Kai-0.6B` @ `cd49ea3813fd8ba0928a9a23ef6c9a0f2f0cd764` (8,192-token window); identity `model_sha256` `bb806f31a14d4532a1b5e00984442128f47f46cbbc68e57e7623327c81cfb983` |
| Eos checkpoint | `vllm-sr/Decision-2.0-Eos-0.8B` @ `3594047d69f476f1d01cf84c593e213fc3a4dfe0` (16,384-token window); identity `model_sha256` `d97127991870ae202017a99eb496bdc56a62afd038594a67febfab0aea9d76fe` |
| Runtime | isolated `uv` venv `~/.cache/uktub-bench/decision2/venv`: Python 3.12.13, torch 2.11.0+cu128, transformers 5.18.0, safetensors 0.8.0, huggingface-hub 1.33.0, tokenizers 0.23.2, triton 3.6.0 (full lock: [decision2-requirements-lock-2026-10-04.txt](decision2-requirements-lock-2026-10-04.txt)) |
| Hardware | NVIDIA GeForce RTX 4060 Laptop GPU, 8 GB, driver 595.91.07; Intel i7-14650HX; 62 GB RAM; Linux 7.0.0-38 |
| Repo | `8b6db8d` plus uncommitted work (each results JSON records `provenance.git`) |
| Scoring path | model card API `AutoModel.from_pretrained(..., trust_remote_code=True).system_one(state, questions)`, one `noul` question per row; score = `answers.claim.noul` |
| Prompt | same claim wording and true/false criteria as `julia_decide.py` / `laya_decide.py` (like-for-like); fixed in advance, not tuned on the benchmark |
| Dataset text | `pdftotext -q`, whitespace-normalized (manifest convention); 0 of 135 gold quotes missing from the extracted text |

Not exercised: `flash-linear-attention` and `causal-conv1d` kernels (Eos prints
a "falling back to reference PyTorch implementation" warning; timings below
are with the fallback), ROCm fast path, `share_context`, bf16z storage,
multi-GPU, CPU inference, Hub download at the pin (weights were fetched once
with `snapshot_download(revision=...)` and loaded offline).

## Custom-code review (before `trust_remote_code=True`)

Reviewed at the pinned revisions: `modeling_decision2.py`,
`configuration_decision2.py`, `pipeline_decision2.py`, `decision2/api.py`,
`decision2/qwen.py`, the vendored `dev2model/*` and the `fast*.py` /
`shared_ctx.py` runtime files. All 34 files hash-match `MODEL_MANIFEST.json`.
Kai and Eos share identical runtime files except three vendored files
(`decision_model.py`, `infer.py`, `lora.py`), where Eos adds Gemma/Qwen-MoE
and BOS-prompt support that these checkpoints do not use.

Found:

- No network access in the scoring path. `huggingface_hub.snapshot_download`
  is called only when the model argument is not a local directory; every
  vendored load uses `local_files_only=True`; the worker sets
  `HF_HUB_OFFLINE=1` for local snapshots.
- No `subprocess`, `os.system`, `eval`/`exec`, `pickle`, `torch.load`, `ctypes`
  or base64 use. Weights load through `safetensors`.
- Filesystem writes: the loader copies the `decision2/` runtime files into the
  transformers dynamic-module cache next to the model code, verifying each file
  against the manifest SHA-256 first. It refuses symlinks in the package.
- Integrity checks at load: manifest inventory, per-file SHA-256, parameter
  counts, and scored model identity. Environment reads: only
  `DECISION2_FAST/GRAPHS/KERNELS` on/off switches.
- Triton kernels (`fast_kernels.py`) run only on a ROCm GPU with the verified
  transformers release; not used here (CUDA).
- Input over budget is answered `max_length_exceeded`, never truncated. The
  worker counts tokens itself first and refuses over-limit rows explicitly.

Benign warning: transformers 5.18 prints "tokenizer ... incorrect regex
pattern (Mistral)". Encoding a full paper (`2411.09996v1`, 7,169 / 7,416
tokens for Kai / Eos) with and without `fix_mistral_regex=True` gave identical
token ids for both tokenizers, so the warning does not change inputs.

## Functional smoke (real weights, before the benchmark)

Evidence: [kai](decision2-smoke-kai-2026-10-04.json),
[eos](decision2-smoke-eos-2026-10-04.json) (script
`scripts/decision2_smoke.py`). Passage: 4 sentences, ~190 serialized tokens.

| Case | Kai P(true) | Eos P(true) | Expected |
|---|---|---|---|
| explicit support | 0.986 | 1.000 | support |
| paraphrase support | 0.983 | 1.000 | support |
| unrelated claim | 0.093 | 0.002 | not support |
| contradiction (71% vs 94.2%) | 0.056 | 0.001 | not support |
| **numeric mismatch (240 vs 2,400)** | **0.957** | **0.884** | not support (both fail) |
| negated claim, false | 0.038 | 0.000 | not support |
| negated claim, true | 0.940 | 1.000 | support |
| second negation pair (true / false) | 0.967 / 0.022 | 0.999 / 0.000 | support / not support |

Schema: `{"model","answers":{"claim":{"type":"noul","noul":<float>}},"usage":{"input_tokens":N,"output_tokens":0}}`.
`noul` is P(true) in [0,1]; all probabilities were finite. Over-limit input is
refused by the worker with the token count; empty state, a missing key and a
bad JSON line each return a per-row `{"error"}` and the worker keeps serving;
`{"exit":true}` exits cleanly (code 0). The worker's own token count equals the
runtime's `usage.input_tokens` on every scored row (a mismatch would fail the
row).

Both models miss a simple numeric mismatch in the smoke test, as earlier local
models did. On the dataset's 36 numeric claims Eos does better (see below).

## Token budgeting (real tokenizer)

The complete serialized prompt (context + task type + claim instructions + both
option blocks + suffix, via the checkpoint's own encoder) was counted.
Instruction/option overhead is 128-158 tokens (Kai) and 136-166 (Eos) per claim.

- Whole-paper density: 3.54-4.74 chars/token (Kai) and 3.55-4.76 (Eos).
  The repo's `chars_per_token: 2.8` (calibrated on mmBERT) is therefore
  conservative for these Qwen tokenizers on whole papers.
- Dense regions are close to 2.8, though. In `2609.04707v1` one 23,844-character
  chunk needed 8,739 tokens (about 2.78 chars/token after overhead), and policy A
  chunk 7 of the same paper reached 7,539 tokens at 19,458 characters. So 2.8
  is a near-edge heuristic here, not a safe bound.

Chunk policies used (same chunker, `scripts/bench-claim-verify.ts`):

| Policy | Chunk size | Why |
|---|---|---|
| A (comparable) | 8,192 tokens x 2.8 = 22,937 chars, 358-char overlap | the historical policy; fits both models (max input 7,539 of 8,192 for Kai) |
| B (window-fitted) | Kai 7,800 x 3.3 = 25,740 chars; Eos 15,500 x 3.3 = 51,150 chars | sized to each model's own window minus measured overhead |

Text modes: `paragraph` keeps blank-line paragraph breaks from `pdftotext`;
`normalized` is the manifest/historical text (whitespace collapsed), where the
paragraph chunker has no breaks and splits at hard offsets. Historical chunked
runs were therefore effectively hard-split.

## Results (new)

Support at the package bar 0.99: a claim is supported when any checked chunk
scores >= 0.99; a low score only abstains. AUC uses the maximum checked chunk
score, with tie correction. "Compat" is the historical two-sided decided
accuracy, kept for comparison only.

### Kai 0.6B

| Run | AUC | Supported / true / false supports @0.99 | Precision / recall | Abstention | Claims fully checked | Compat decided acc (decided) | Calls | Tokens | Wall (s) | Peak GPU MiB |
|---|---|---|---|---|---|---|---|---|---|---|
| 24k prefix | 0.700 | 0 / 0 / 0 | n/a / 0.00 | 1.00 | 135/135 | n/a (0) | 135 | 690,417 | 128 | 1862 |
| **A paragraph** | **0.955** | 0 / 0 / 0 | n/a / 0.00 | 1.00 | 135/135 | n/a (0) | 416 | 1,900,118 | 326 | 1986 |
| A normalized (historical text mode) | 0.965 | 0 / 0 / 0 | n/a / 0.00 | 1.00 | 135/135 | n/a (0) | 406 | 1,874,612 | 322 | 1963 |
| B paragraph (25,740 chars) | 0.963 | 0 / 0 / 0 | n/a / 0.00 | 1.00 | **126/135 (9 refused rows)** | n/a (0) | 386 | 1,816,367 | 317 | 1999 |

Kai policy B: 9 rows (claims c059-c067 on paper `2609.04707v1`, chunk 6) were
refused for exceeding the window (8,739-8,760 tokens > 8,192). They are
counted as unchecked (126 claims fully checked) and never scored as negatives;
those 9 claims still have other checked chunks, so AUC covers all 135 claims. Max chunk probability in any Kai run: 0.931.

Kai threshold sweep (policy A paragraph; in-sample, bars chosen after the
fact, so optimistic):

| Bar | Supported | True | False supports | Precision | Recall |
|---|---|---|---|---|---|
| 0.5 | 84 | 70 | 14 | 0.83 | 0.95 |
| 0.7 | 52 | 51 | 1 | 0.98 | 0.69 |
| 0.8 | 21 | 21 | 0 | 1.00 | 0.28 |
| 0.9 | 2 | 2 | 0 | 1.00 | 0.03 |
| 0.95 / 0.99 | 0 | 0 | 0 | n/a | 0.00 |

### Eos 0.8B

| Run | AUC | Supported / true / false supports @0.99 | Precision / recall | Abstention | Claims fully checked | Compat decided acc (decided) | Calls | Tokens | Wall (s) | Peak GPU MiB |
|---|---|---|---|---|---|---|---|---|---|---|
| 24k prefix | 0.707 | 20 / 20 / 0 | 1.00 / 0.27 | 0.85 | 135/135 | 0.771 (35) | 135 | 694,226 | 132 | 2737 |
| **A paragraph** | **0.968** | **38 / 37 / 1** | **0.97 / 0.50** | 0.72 | 135/135 | 0.875 (64) | 416 | 1,914,008 | 355 | 2909 |
| A normalized (historical text mode) | 0.967 | 43 / 42 / 1 | 0.98 / 0.57 | 0.68 | 135/135 | 0.873 (71) | 406 | 1,877,414 | 347 | 2876 |
| B paragraph (51,150 chars) | 0.960 | 35 / 34 / 1 | 0.97 / 0.46 | 0.74 | 135/135 | 0.904 (52) | 232 | 1,884,302 | 391 | 3870 |

Eos threshold sweep (policy A paragraph; in-sample):

| Bar | Supported | True | False supports | Precision | Recall |
|---|---|---|---|---|---|
| 0.5 | 96 | 73 | 23 | 0.76 | 0.99 |
| 0.8 | 87 | 73 | 14 | 0.84 | 0.99 |
| 0.9 | 72 | 67 | 5 | 0.93 | 0.91 |
| 0.95 | 67 | 63 | 4 | 0.94 | 0.85 |
| **0.99** | **38** | **37** | **1** | **0.97** | **0.50** |
| 0.995 | 23 | 23 | 0 | 1.00 | 0.31 |
| 0.999 | 5 | 5 | 0 | 1.00 | 0.07 |

Eos by kind at 0.99 (policy A paragraph): numeric 6 supported / 0 false
(AUC 0.981), dataset 4 / 0 (0.969), finding 12 / 0 (0.939), method 16 / 1
(0.952). The one false support is `c101` ("smart meter prototyped with Arduino
and the smart plug with Raspberry Pi", P 0.991): the two devices are swapped
relative to the paper. The next-highest false supports are `c130` (0.976,
numeric) and `c086` (0.969), both below the bar.

### Cost and timing

| | Kai | Eos |
|---|---|---|
| Model load | 2.4-2.6 s, 1,438 MiB resident | 3.2-3.3 s, 1,925 MiB resident |
| Policy A chunked: calls / tokens | 416 / 1.90 M | 416 / 1.91 M |
| Policy A chunked: wall (all 135 claims, no cache) | 326 s (0.78 s/call) | 355 s (0.85 s/call) |
| Policy B chunked | 386 calls / 317 s (9 rows refused) | 232 calls / 391 s, peak 3.9 GB |
| Peak GPU memory, policy A (allocated) | 1.99 GB | 2.91 GB |
| Single 15.7k-token Eos input (ad hoc probe, not a committed script) | n/a | 4.3 s, peak 4.1 GB (reference attention fallback) |

Token work is about the same for policies A and B because every chunk of a
paper is read once per claim either way; B halves Eos's call count. Verifier
calls equal chunks x claims-per-paper because retrieval is exhaustive (no
cache, no candidate selection). Errors: 0 everywhere; refusals: 0 except Kai
policy B (9).

Reproducibility: the full Kai A-paragraph run was executed twice and every
per-chunk probability and token count matched exactly (wall 328 s and 326 s).

## Comparison with historical runs (labelled)

Historical numbers are from `docs/benchmarks/` (2026-10-03). AUC marked
"recomputed" is tie-correct, recomputed from the stored per-claim `pTrue`
([historical-auc-recomputed-2026-10-04.md](historical-auc-recomputed-2026-10-04.md));
only AUC can be recomputed for chunked history. Historical chunked runs used
normalized text and the historical aggregate score, so compare to the
"A normalized" rows.

| Run | Source | AUC | At 0.99 (two-sided historical metric) |
|---|---|---|---|
| Eos, A normalized | new | 0.967 | 71 decided, 0.873 accuracy, 1 FP, 8 FN |
| Kai, A normalized | new | 0.965 | 0 decided |
| Mercury decide (hosted), chunked | historical, AUC recomputed | 0.998 | 109 decided, 108 correct, 0 FP (as reported) |
| jev-latest (hosted), chunked | historical, AUC recomputed | 0.998 | 14 decided, 14 correct |
| K2-Type-0.9B (local), chunked | historical, AUC recomputed | 0.814 | 1 decided |
| bev-decider-0.4B (local), chunked | historical, AUC recomputed | 0.671 | zero FP (as reported) |

Existing bars (AUC >= 0.80, decided accuracy >= 0.90) are comparison gates
only. Against them: Eos A passes AUC and misses decided accuracy at 0.99
(0.875), reaches 0.907 at 0.95 and 0.904 for policy B at 0.99; Kai passes AUC
and has no decisions at 0.99. The hosted Mercury result remains stronger
(AUC 0.998, 108/109 correct decisions); these local models were not compared
against it on cost or latency. The two-sided metric counts a TRUE claim as
"refuted" when any single irrelevant chunk scores <= 0.01, which is the source
of Eos's 7-8 false negatives; it is not a support error.

## Unresolved limits (per model)

Eos 0.8B

- Coverage at 0.99: supports 37 of 74 TRUE claims (recall 0.50); 37 TRUE
  claims abstain, 1 of them with a best chunk score under 0.5.
- Quality: 1 false support in 38 at 0.99 (role swap, P 0.991). Zero false
  supports needs 0.995 and costs recall (0.31). Smoke numeric mismatch fails.
- Cost: 0.85 s per verifier call at ~4.6k tokens; 4.3 s at 15.7k tokens with
  the unoptimized attention fallback; 2.9-3.9 GB VRAM. Hosted/other engines
  were not re-timed.
- Output is a chunk-level score, not an evidence span.

Kai 0.6B

- Coverage at 0.99: none. Max chunk probability 0.931; the manifest ships no
  calibration (temperatures 1.0). Any usable bar is below 0.93, and the best
  zero-false-support bar seen (0.8, recall 0.28) was found on the evaluation
  data itself.
- Quality: AUC 0.955, so ranking is good; at 0.5, 14 false supports.
  Smoke numeric mismatch fails.
- Cost: 0.78 s per call, 2.0 GB VRAM, 8,192-token window leaves only ~8%
  headroom with the 2.8 heuristic (policy B refused 9 rows).

Both

- One dataset: 135 claims, 14 papers, claims written from the same papers; no
  held-out papers. AUC intervals are ~+/-0.03 and claims within a paper are not
  independent. Kai vs Eos AUC difference is 0.013 (95% CI -0.015 to 0.043), not
  distinguishable. All threshold choices above are in-sample.
- Retrieval recall, excerpt faithfulness and cross-paper precision were not
  measured here; AUC and decided accuracy do not substitute for them.
- Prompt wording is one fixed variant; other wordings were not tried.
- The numeric-mismatch weakness seen in smoke was not isolated on the dataset
  (numeric AUC 0.985 Kai / 0.981 Eos), so its real-world rate is unknown.

## Reproduce

```bash
# 1. isolated environment (versions: see the lock file)
uv venv --python 3.12 ~/.cache/uktub-bench/decision2/venv
uv pip install --python ~/.cache/uktub-bench/decision2/venv/bin/python torch --index-url https://download.pytorch.org/whl/cu128
uv pip install --python ~/.cache/uktub-bench/decision2/venv/bin/python "transformers>=5.17" safetensors huggingface_hub

# 2. pinned weights
PY=~/.cache/uktub-bench/decision2/venv/bin/python
$PY -c "from huggingface_hub import snapshot_download as s; \
s('vllm-sr/Decision-2.0-Kai-0.6B', revision='cd49ea3813fd8ba0928a9a23ef6c9a0f2f0cd764', local_dir='$HOME/.cache/uktub-bench/decision2/models/kai'); \
s('vllm-sr/Decision-2.0-Eos-0.8B', revision='3594047d69f476f1d01cf84c593e213fc3a4dfe0', local_dir='$HOME/.cache/uktub-bench/decision2/models/eos')"

# 3. paper text (outside the repo)
P=test_papers; T=/path/to/text; mkdir -p $T
for id in $(node -e 'for (const p of new Set(JSON.parse(require("fs").readFileSync("benchmarks/datasets/claim-verification-v1/claims.json","utf8")).claims.map(c=>c.paper))) console.log(p)'); do
  pdftotext -q "$(ls $P/RF/$id*.pdf $P/smarthome/$id*.pdf 2>/dev/null | head -1)" "$T/$id.txt"; done

# 4. smoke, then the eight runs per model (one model at a time; M = kai | eos)
$PY scripts/decision2_smoke.py kai cd49ea3813fd8ba0928a9a23ef6c9a0f2f0cd764
R="node scripts/bench-claim-verify.ts --text-dir $T --no-cache"
A="--chunk-tokens 8192 --overlap-tokens 128 --chars-per-token 2.8 --boundary paragraph"
$R --engine decision2-M                                                         # 24k prefix
$R --engine decision2-M --chunked --text-mode paragraph  $A --tag policyA-paragraph
$R --engine decision2-M --chunked --text-mode normalized $A --tag policyA-normalized
$R --engine decision2-M --chunked --text-mode paragraph --chunk-tokens N --overlap-tokens 128 --chars-per-token 3.3 --boundary paragraph --tag policyB-paragraph   # N = 7800 (kai), 15500 (eos)

# 5. offline checks
node --test tests/bench-metrics.spec.ts tests/decision2-worker-protocol.spec.ts
node scripts/bench-bootstrap-auc.ts docs/benchmarks/decision2-kai+chunks-policyA-paragraph-*.results.json docs/benchmarks/decision2-eos+chunks-policyA-paragraph-*.results.json
node scripts/bench-claim-verify.ts --rerender <results.json> [--bar 0.95]   # recompute any bar without a model
```

Per-run reports (auto-generated, with full sweeps and by-kind tables) are the
`decision2-{kai,eos}[+chunks-<policy>]-claim-verification-v1-2026-10-04.md`
files beside this one.
