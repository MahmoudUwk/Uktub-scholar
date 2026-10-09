# vela on claim-verification-v1 — chunked (chunks-policyA-paragraph-0.8B) — 2026-10-08

135 claims (74 TRUE / 61 FALSE), 14 papers. New measurement from `scripts/bench-claim-verify.ts` (schema bench-claim-verify/2); metrics are recomputed from the raw per-chunk probabilities in the JSON beside this file.

Engine `vela:snapshot-08-326b01d81f61@326b01d81f61`, revision `unpinned`. Chunks: 8192 tokens x 2.8 chars/token = 22937 chars, overlap 358 chars, boundary paragraph, text mode paragraph, 43 chunks.

| Metric | Value |
|---|---|
| AUC, tie-corrected (max checked chunk score) | 0.884 over 135 claims (0 unchecked excluded) |
| Mean claim score TRUE / FALSE | 0.808 / 0.456 |
| Support at 0.99: supported / true / FALSE SUPPORTS | 0 / 0 / 0 |
| Support precision / recall at 0.99 | n/a / 0.000 |
| Abstention rate at 0.99 | 1.000 |
| Checked coverage (claims fully checked / chunks checked) | 1.000 / 1.000 (416/416 chunks; 0 claims unchecked) |
| Compatibility decided accuracy at 0.99 (two-sided, historical definition) | 1.000 over 5 decided (tp 0, fp 0, tn 5, fn 0) |
| AUC of the historical aggregate score at 0.99 (comparison only) | 0.888 |
| Verifier calls (fresh / from cache) | 416 / 0 |
| Tokens processed (fresh / total checks) | 0 / 0 |
| Context refusals / error rows | 0 / 0 |
| Wall time | 370 s |

Threshold sweep, recomputed from raw scores. Support columns follow the package question (any checked chunk >= bar supports; a low score only abstains). The last three columns are the labelled historical two-sided *compatibility* metric.

| Bar | Supported | True | False supports | Support precision | Support recall | Abstention | Compat decided | Compat correct | Compat decided acc |
|---|---|---|---|---|---|---|---|---|---|
| 0.5 | 94 | 67 | 27 | 0.71 | 0.91 | 0.30 | 135 | 101 | 0.748 |
| 0.6 | 79 | 62 | 17 | 0.78 | 0.84 | 0.41 | 130 | 102 | 0.785 |
| 0.7 | 62 | 55 | 7 | 0.89 | 0.74 | 0.54 | 118 | 98 | 0.831 |
| 0.8 | 54 | 50 | 4 | 0.93 | 0.68 | 0.60 | 103 | 89 | 0.864 |
| 0.85 | 47 | 44 | 3 | 0.94 | 0.59 | 0.65 | 95 | 82 | 0.863 |
| 0.9 | 32 | 32 | 0 | 1.00 | 0.43 | 0.76 | 75 | 66 | 0.880 |
| 0.95 | 20 | 20 | 0 | 1.00 | 0.27 | 0.85 | 47 | 42 | 0.894 |
| 0.99 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 5 | 5 | 1.000 |
| 0.995 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 2 | 2 | 1.000 |
| 0.999 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 0 | 0 | n/a |

By kind at the policy bar:

| Kind | Claims | AUC | Supported | False supports | Support recall |
|---|---|---|---|---|---|
| dataset | 23 | 0.731 | 0 | 0 | 0.00 |
| finding | 39 | 0.853 | 0 | 0 | 0.00 |
| method | 37 | 0.963 | 0 | 0 | 0.00 |
| numeric | 36 | 0.892 | 0 | 0 | 0.00 |

Gold-quote reference (evaluation only, never an input): 74/74 TRUE claims have their gold quote inside at least one chunk of the checked input; 0 TRUE claims were supported at 0.99 by a chunk containing the gold quote.

No refusals or error rows.

Raw per-claim and per-chunk probabilities: see the results JSON beside this file.

