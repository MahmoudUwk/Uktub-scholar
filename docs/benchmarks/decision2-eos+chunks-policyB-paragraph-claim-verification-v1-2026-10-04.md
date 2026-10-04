# decision2-eos on claim-verification-v1 — chunked (policyB-paragraph) — 2026-10-04

135 claims (74 TRUE / 61 FALSE), 14 papers. New measurement from `scripts/bench-claim-verify.ts` (schema bench-claim-verify/2); metrics are recomputed from the raw per-chunk probabilities in the JSON beside this file.

Engine `decision2-eos:claim-noul-criteria-v1`, revision `3594047d69f476f1d01cf84c593e213fc3a4dfe0`. Chunks: 15500 tokens x 3.3 chars/token = 51150 chars, overlap 422 chars, boundary paragraph, text mode paragraph, 24 chunks.

| Metric | Value |
|---|---|
| AUC, tie-corrected (max checked chunk score) | 0.960 over 135 claims (0 unchecked excluded) |
| Mean claim score TRUE / FALSE | 0.965 / 0.424 |
| Support at 0.99: supported / true / FALSE SUPPORTS | 35 / 34 / 1 |
| Support precision / recall at 0.99 | 0.971 / 0.459 |
| Abstention rate at 0.99 | 0.741 |
| Checked coverage (claims fully checked / chunks checked) | 1.000 / 1.000 (232/232 chunks; 0 claims unchecked) |
| Compatibility decided accuracy at 0.99 (two-sided, historical definition) | 0.904 over 52 decided (tp 34, fp 1, tn 13, fn 4) |
| AUC of the historical aggregate score at 0.99 (comparison only) | 0.918 |
| Verifier calls (fresh / from cache) | 232 / 0 |
| Tokens processed (fresh / total checks) | 1884302 / 1884302 |
| Context refusals / error rows | 0 / 0 |
| Wall time | 391 s (worker inference 383.743 s) |
| Model load | 3.219 s, 1925.1 MiB resident |
| Peak GPU memory (allocated / reserved) | 3869.7 / 4032 MiB |

Threshold sweep, recomputed from raw scores. Support columns follow the package question (any checked chunk >= bar supports; a low score only abstains). The last three columns are the labelled historical two-sided *compatibility* metric.

| Bar | Supported | True | False supports | Support precision | Support recall | Abstention | Compat decided | Compat correct | Compat decided acc |
|---|---|---|---|---|---|---|---|---|---|
| 0.5 | 95 | 73 | 22 | 0.77 | 0.99 | 0.30 | 135 | 112 | 0.830 |
| 0.6 | 91 | 73 | 18 | 0.80 | 0.99 | 0.33 | 132 | 113 | 0.856 |
| 0.7 | 86 | 72 | 14 | 0.84 | 0.97 | 0.36 | 123 | 107 | 0.870 |
| 0.8 | 83 | 71 | 12 | 0.86 | 0.96 | 0.39 | 116 | 103 | 0.888 |
| 0.85 | 81 | 71 | 10 | 0.88 | 0.96 | 0.40 | 115 | 104 | 0.904 |
| 0.9 | 77 | 69 | 8 | 0.90 | 0.93 | 0.43 | 107 | 97 | 0.907 |
| 0.95 | 72 | 67 | 5 | 0.93 | 0.91 | 0.47 | 98 | 90 | 0.918 |
| 0.99 | 35 | 34 | 1 | 0.97 | 0.46 | 0.74 | 52 | 47 | 0.904 |
| 0.995 | 23 | 22 | 1 | 0.96 | 0.30 | 0.83 | 29 | 27 | 0.931 |
| 0.999 | 6 | 6 | 0 | 1.00 | 0.08 | 0.96 | 7 | 7 | 1.000 |

By kind at the policy bar:

| Kind | Claims | AUC | Supported | False supports | Support recall |
|---|---|---|---|---|---|
| dataset | 23 | 1.000 | 4 | 0 | 0.31 |
| finding | 39 | 0.925 | 12 | 0 | 0.50 |
| method | 37 | 0.933 | 14 | 1 | 0.48 |
| numeric | 36 | 0.973 | 5 | 0 | 0.50 |

Gold-quote reference (evaluation only, never an input): 74/74 TRUE claims have their gold quote inside at least one chunk of the checked input; 34 TRUE claims were supported at 0.99 by a chunk containing the gold quote.

No refusals or error rows.

Raw per-claim and per-chunk probabilities: see the results JSON beside this file.

