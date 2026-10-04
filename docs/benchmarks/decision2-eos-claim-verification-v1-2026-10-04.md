# decision2-eos on claim-verification-v1 — prefix — 2026-10-04

135 claims (74 TRUE / 61 FALSE), 14 papers. New measurement from `scripts/bench-claim-verify.ts` (schema bench-claim-verify/2); metrics are recomputed from raw per-chunk probabilities in the JSON beside this file.

Engine `decision2-eos:claim-noul-criteria-v1`, revision `3594047d69f476f1d01cf84c593e213fc3a4dfe0`. Context: first 24000 characters of each whitespace-normalized paper.

| Metric | Value |
|---|---|
| AUC, tie-corrected (max checked chunk score) | 0.707 over 135 claims (0 unchecked excluded) |
| Mean claim score TRUE / FALSE | 0.616 / 0.309 |
| Support at 0.99: supported / true / FALSE SUPPORTS | 20 / 20 / 0 |
| Support precision / recall at 0.99 | 1.000 / 0.270 |
| Abstention rate at 0.99 | 0.852 |
| Checked coverage (claims fully checked / chunks checked) | 1.000 / 1.000 (135/135 chunks; 0 claims unchecked) |
| Compatibility decided accuracy at 0.99 (two-sided, historical definition) | 0.771 over 35 decided (tp 20, fp 0, tn 7, fn 8) |
| Verifier calls (fresh / from cache) | 135 / 0 |
| Tokens processed (fresh / total checks) | 694226 / 694226 |
| Context refusals / error rows | 0 / 0 |
| Wall time | 132 s (worker inference 126.538 s) |
| Model load | 3.248 s, 1925.1 MiB resident |
| Peak GPU memory (allocated / reserved) | 2737.2 / 2830 MiB |

Threshold sweep, recomputed from raw scores. Support columns follow the package question (any checked chunk >= bar supports; a low score only abstains). The last three columns are the labelled historical two-sided *compatibility* metric.

| Bar | Supported | True | False supports | Support precision | Support recall | Abstention | Compat decided | Compat correct | Compat decided acc |
|---|---|---|---|---|---|---|---|---|---|
| 0.5 | 63 | 46 | 17 | 0.73 | 0.62 | 0.53 | 135 | 90 | 0.667 |
| 0.6 | 57 | 44 | 13 | 0.77 | 0.59 | 0.58 | 126 | 86 | 0.683 |
| 0.7 | 55 | 43 | 12 | 0.78 | 0.58 | 0.59 | 118 | 81 | 0.686 |
| 0.8 | 50 | 40 | 10 | 0.80 | 0.54 | 0.63 | 105 | 72 | 0.686 |
| 0.85 | 47 | 40 | 7 | 0.85 | 0.54 | 0.65 | 98 | 70 | 0.714 |
| 0.9 | 41 | 37 | 4 | 0.90 | 0.50 | 0.70 | 86 | 64 | 0.744 |
| 0.95 | 36 | 33 | 3 | 0.92 | 0.45 | 0.73 | 72 | 54 | 0.750 |
| 0.99 | 20 | 20 | 0 | 1.00 | 0.27 | 0.85 | 35 | 27 | 0.771 |
| 0.995 | 13 | 13 | 0 | 1.00 | 0.18 | 0.90 | 23 | 17 | 0.739 |
| 0.999 | 6 | 6 | 0 | 1.00 | 0.08 | 0.96 | 7 | 6 | 0.857 |

By kind at the policy bar:

| Kind | Claims | AUC | Supported | False supports | Support recall |
|---|---|---|---|---|---|
| dataset | 23 | 0.692 | 3 | 0 | 0.23 |
| finding | 39 | 0.733 | 6 | 0 | 0.25 |
| method | 37 | 0.659 | 8 | 0 | 0.30 |
| numeric | 36 | 0.877 | 3 | 0 | 0.30 |

Gold-quote reference (evaluation only, never an input): 37/74 TRUE claims have their gold quote inside at least one checked-input chunk; 20 TRUE claims were supported at 0.99 by a chunk containing the gold quote.

No refusals or error rows.

Raw per-claim and per-chunk probabilities: see the results JSON beside this file.

