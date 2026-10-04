# decision2-eos on claim-verification-v1 — chunked (policyA-normalized) — 2026-10-04

135 claims (74 TRUE / 61 FALSE), 14 papers. New measurement from `scripts/bench-claim-verify.ts` (schema bench-claim-verify/2); metrics are recomputed from the raw per-chunk probabilities in the JSON beside this file.

Engine `decision2-eos:claim-noul-criteria-v1`, revision `3594047d69f476f1d01cf84c593e213fc3a4dfe0`. Chunks: 8192 tokens x 2.8 chars/token = 22937 chars, overlap 358 chars, boundary paragraph, text mode normalized, 42 chunks.

| Metric | Value |
|---|---|
| AUC, tie-corrected (max checked chunk score) | 0.967 over 135 claims (0 unchecked excluded) |
| Mean claim score TRUE / FALSE | 0.965 / 0.408 |
| Support at 0.99: supported / true / FALSE SUPPORTS | 43 / 42 / 1 |
| Support precision / recall at 0.99 | 0.977 / 0.568 |
| Abstention rate at 0.99 | 0.681 |
| Checked coverage (claims fully checked / chunks checked) | 1.000 / 1.000 (406/406 chunks; 0 claims unchecked) |
| Compatibility decided accuracy at 0.99 (two-sided, historical definition) | 0.873 over 71 decided (tp 42, fp 1, tn 20, fn 8) |
| AUC of the historical aggregate score at 0.99 (comparison only) | 0.889 |
| Verifier calls (fresh / from cache) | 406 / 0 |
| Tokens processed (fresh / total checks) | 1877414 / 1877414 |
| Context refusals / error rows | 0 / 0 |
| Wall time | 347 s (worker inference 339.871 s) |
| Model load | 3.221 s, 1925.1 MiB resident |
| Peak GPU memory (allocated / reserved) | 2875.7 / 2990 MiB |

Threshold sweep, recomputed from raw scores. Support columns follow the package question (any checked chunk >= bar supports; a low score only abstains). The last three columns are the labelled historical two-sided *compatibility* metric.

| Bar | Supported | True | False supports | Support precision | Support recall | Abstention | Compat decided | Compat correct | Compat decided acc |
|---|---|---|---|---|---|---|---|---|---|
| 0.5 | 95 | 73 | 22 | 0.77 | 0.99 | 0.30 | 135 | 112 | 0.830 |
| 0.6 | 91 | 73 | 18 | 0.80 | 0.99 | 0.33 | 134 | 115 | 0.858 |
| 0.7 | 86 | 73 | 13 | 0.85 | 0.99 | 0.36 | 132 | 118 | 0.894 |
| 0.8 | 81 | 71 | 10 | 0.88 | 0.96 | 0.40 | 126 | 113 | 0.897 |
| 0.85 | 81 | 71 | 10 | 0.88 | 0.96 | 0.40 | 124 | 111 | 0.895 |
| 0.9 | 75 | 68 | 7 | 0.91 | 0.92 | 0.44 | 114 | 104 | 0.912 |
| 0.95 | 65 | 62 | 3 | 0.95 | 0.84 | 0.52 | 103 | 95 | 0.922 |
| 0.99 | 43 | 42 | 1 | 0.98 | 0.57 | 0.68 | 71 | 62 | 0.873 |
| 0.995 | 26 | 26 | 0 | 1.00 | 0.35 | 0.81 | 46 | 38 | 0.826 |
| 0.999 | 6 | 6 | 0 | 1.00 | 0.08 | 0.96 | 10 | 8 | 0.800 |

By kind at the policy bar:

| Kind | Claims | AUC | Supported | False supports | Support recall |
|---|---|---|---|---|---|
| dataset | 23 | 0.977 | 5 | 0 | 0.38 |
| finding | 39 | 0.939 | 14 | 0 | 0.58 |
| method | 37 | 0.948 | 18 | 1 | 0.63 |
| numeric | 36 | 0.981 | 6 | 0 | 0.60 |

Gold-quote reference (evaluation only, never an input): 74/74 TRUE claims have their gold quote inside at least one chunk of the checked input; 42 TRUE claims were supported at 0.99 by a chunk containing the gold quote.

No refusals or error rows.

Raw per-claim and per-chunk probabilities: see the results JSON beside this file.

