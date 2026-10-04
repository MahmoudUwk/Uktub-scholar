# decision2-kai on claim-verification-v1 — prefix — 2026-10-04

135 claims (74 TRUE / 61 FALSE), 14 papers. New measurement from `scripts/bench-claim-verify.ts` (schema bench-claim-verify/2); metrics are recomputed from the raw per-chunk probabilities in the JSON beside this file.

Engine `decision2-kai:claim-noul-criteria-v1`, revision `cd49ea3813fd8ba0928a9a23ef6c9a0f2f0cd764`. Context: first 24000 characters of each whitespace-normalized paper.

| Metric | Value |
|---|---|
| AUC, tie-corrected (max checked chunk score) | 0.700 over 135 claims (0 unchecked excluded) |
| Mean claim score TRUE / FALSE | 0.533 / 0.350 |
| Support at 0.99: supported / true / FALSE SUPPORTS | 0 / 0 / 0 |
| Support precision / recall at 0.99 | n/a / 0.000 |
| Abstention rate at 0.99 | 1.000 |
| Checked coverage (claims fully checked / chunks checked) | 1.000 / 1.000 (135/135 chunks; 0 claims unchecked) |
| Compatibility decided accuracy at 0.99 (two-sided, historical definition) | n/a over 0 decided (tp 0, fp 0, tn 0, fn 0) |
| AUC of the historical aggregate score at 0.99 (comparison only) | 0.700 |
| Verifier calls (fresh / from cache) | 135 / 0 |
| Tokens processed (fresh / total checks) | 690417 / 690417 |
| Context refusals / error rows | 0 / 0 |
| Wall time | 128 s (worker inference 122.663 s) |
| Model load | 2.581 s, 1437.8 MiB resident |
| Peak GPU memory (allocated / reserved) | 1861.7 / 1910 MiB |

Threshold sweep, recomputed from raw scores. Support columns follow the package question (any checked chunk >= bar supports; a low score only abstains). The last three columns are the labelled historical two-sided *compatibility* metric.

| Bar | Supported | True | False supports | Support precision | Support recall | Abstention | Compat decided | Compat correct | Compat decided acc |
|---|---|---|---|---|---|---|---|---|---|
| 0.5 | 51 | 40 | 11 | 0.78 | 0.54 | 0.62 | 135 | 90 | 0.667 |
| 0.6 | 39 | 37 | 2 | 0.95 | 0.50 | 0.71 | 111 | 78 | 0.703 |
| 0.7 | 31 | 30 | 1 | 0.97 | 0.41 | 0.77 | 77 | 55 | 0.714 |
| 0.8 | 13 | 13 | 0 | 1.00 | 0.18 | 0.90 | 26 | 21 | 0.808 |
| 0.85 | 5 | 5 | 0 | 1.00 | 0.07 | 0.96 | 6 | 6 | 1.000 |
| 0.9 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 0 | 0 | n/a |
| 0.95 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 0 | 0 | n/a |
| 0.99 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 0 | 0 | n/a |
| 0.995 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 0 | 0 | n/a |
| 0.999 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 0 | 0 | n/a |

By kind at the policy bar:

| Kind | Claims | AUC | Supported | False supports | Support recall |
|---|---|---|---|---|---|
| dataset | 23 | 0.685 | 0 | 0 | 0.00 |
| finding | 39 | 0.678 | 0 | 0 | 0.00 |
| method | 37 | 0.693 | 0 | 0 | 0.00 |
| numeric | 36 | 0.804 | 0 | 0 | 0.00 |

Gold-quote reference (evaluation only, never an input): 37/74 TRUE claims have their gold quote inside at least one chunk of the checked input; 0 TRUE claims were supported at 0.99 by a chunk containing the gold quote.

No refusals or error rows.

Raw per-claim and per-chunk probabilities: see the results JSON beside this file.

