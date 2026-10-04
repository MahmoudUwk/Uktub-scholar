# decision2-eos on claim-verification-v1 — chunked (policyA-paragraph) — 2026-10-04

135 claims (74 TRUE / 61 FALSE), 14 papers. New measurement from `scripts/bench-claim-verify.ts` (schema bench-claim-verify/2); metrics are recomputed from the raw per-chunk probabilities in the JSON beside this file.

Engine `decision2-eos:claim-noul-criteria-v1`, revision `3594047d69f476f1d01cf84c593e213fc3a4dfe0`. Chunks: 8192 tokens x 2.8 chars/token = 22937 chars, overlap 358 chars, boundary paragraph, text mode paragraph, 43 chunks.

| Metric | Value |
|---|---|
| AUC, tie-corrected (max checked chunk score) | 0.968 over 135 claims (0 unchecked excluded) |
| Mean claim score TRUE / FALSE | 0.967 / 0.418 |
| Support at 0.99: supported / true / FALSE SUPPORTS | 38 / 37 / 1 |
| Support precision / recall at 0.99 | 0.974 / 0.500 |
| Abstention rate at 0.99 | 0.719 |
| Checked coverage (claims fully checked / chunks checked) | 1.000 / 1.000 (416/416 chunks; 0 claims unchecked) |
| Compatibility decided accuracy at 0.99 (two-sided, historical definition) | 0.875 over 64 decided (tp 37, fp 1, tn 19, fn 7) |
| AUC of the historical aggregate score at 0.99 (comparison only) | 0.899 |
| Verifier calls (fresh / from cache) | 416 / 0 |
| Tokens processed (fresh / total checks) | 1914008 / 1914008 |
| Context refusals / error rows | 0 / 0 |
| Wall time | 355 s (worker inference 347.293 s) |
| Model load | 3.262 s, 1925.1 MiB resident |
| Peak GPU memory (allocated / reserved) | 2908.7 / 3010 MiB |

Threshold sweep, recomputed from raw scores. Support columns follow the package question (any checked chunk >= bar supports; a low score only abstains). The last three columns are the labelled historical two-sided *compatibility* metric.

| Bar | Supported | True | False supports | Support precision | Support recall | Abstention | Compat decided | Compat correct | Compat decided acc |
|---|---|---|---|---|---|---|---|---|---|
| 0.5 | 96 | 73 | 23 | 0.76 | 0.99 | 0.29 | 135 | 111 | 0.822 |
| 0.6 | 90 | 73 | 17 | 0.81 | 0.99 | 0.33 | 133 | 115 | 0.865 |
| 0.7 | 90 | 73 | 17 | 0.81 | 0.99 | 0.33 | 133 | 115 | 0.865 |
| 0.8 | 87 | 73 | 14 | 0.84 | 0.99 | 0.36 | 130 | 115 | 0.885 |
| 0.85 | 81 | 71 | 10 | 0.88 | 0.96 | 0.40 | 126 | 113 | 0.897 |
| 0.9 | 72 | 67 | 5 | 0.93 | 0.91 | 0.47 | 121 | 111 | 0.917 |
| 0.95 | 67 | 63 | 4 | 0.94 | 0.85 | 0.50 | 107 | 97 | 0.907 |
| 0.99 | 38 | 37 | 1 | 0.97 | 0.50 | 0.72 | 64 | 56 | 0.875 |
| 0.995 | 23 | 23 | 0 | 1.00 | 0.31 | 0.83 | 41 | 36 | 0.878 |
| 0.999 | 5 | 5 | 0 | 1.00 | 0.07 | 0.96 | 7 | 6 | 0.857 |

By kind at the policy bar:

| Kind | Claims | AUC | Supported | False supports | Support recall |
|---|---|---|---|---|---|
| dataset | 23 | 0.969 | 4 | 0 | 0.31 |
| finding | 39 | 0.939 | 12 | 0 | 0.50 |
| method | 37 | 0.952 | 16 | 1 | 0.56 |
| numeric | 36 | 0.981 | 6 | 0 | 0.60 |

Gold-quote reference (evaluation only, never an input): 74/74 TRUE claims have their gold quote inside at least one chunk of the checked input; 37 TRUE claims were supported at 0.99 by a chunk containing the gold quote.

No refusals or error rows.

Raw per-claim and per-chunk probabilities: see the results JSON beside this file.

