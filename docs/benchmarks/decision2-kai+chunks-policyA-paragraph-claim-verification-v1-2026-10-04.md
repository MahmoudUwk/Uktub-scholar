# decision2-kai on claim-verification-v1 — chunked (policyA-paragraph) — 2026-10-04

135 claims (74 TRUE / 61 FALSE), 14 papers. New measurement from `scripts/bench-claim-verify.ts` (schema bench-claim-verify/2); metrics are recomputed from the raw per-chunk probabilities in the JSON beside this file.

Engine `decision2-kai:claim-noul-criteria-v1`, revision `cd49ea3813fd8ba0928a9a23ef6c9a0f2f0cd764`. Chunks: 8192 tokens x 2.8 chars/token = 22937 chars, overlap 358 chars, boundary paragraph, text mode paragraph, 43 chunks.

| Metric | Value |
|---|---|
| AUC, tie-corrected (max checked chunk score) | 0.955 over 135 claims (0 unchecked excluded) |
| Mean claim score TRUE / FALSE | 0.725 / 0.404 |
| Support at 0.99: supported / true / FALSE SUPPORTS | 0 / 0 / 0 |
| Support precision / recall at 0.99 | n/a / 0.000 |
| Abstention rate at 0.99 | 1.000 |
| Checked coverage (claims fully checked / chunks checked) | 1.000 / 1.000 (416/416 chunks; 0 claims unchecked) |
| Compatibility decided accuracy at 0.99 (two-sided, historical definition) | n/a over 0 decided (tp 0, fp 0, tn 0, fn 0) |
| AUC of the historical aggregate score at 0.99 (comparison only) | 0.955 |
| Verifier calls (fresh / from cache) | 416 / 0 |
| Tokens processed (fresh / total checks) | 1900118 / 1900118 |
| Context refusals / error rows | 0 / 0 |
| Wall time | 326 s (worker inference 319.153 s) |
| Model load | 2.466 s, 1437.8 MiB resident |
| Peak GPU memory (allocated / reserved) | 1985.6 / 2050 MiB |

Threshold sweep, recomputed from raw scores. Support columns follow the package question (any checked chunk >= bar supports; a low score only abstains). The last three columns are the labelled historical two-sided *compatibility* metric.

| Bar | Supported | True | False supports | Support precision | Support recall | Abstention | Compat decided | Compat correct | Compat decided acc |
|---|---|---|---|---|---|---|---|---|---|
| 0.5 | 84 | 70 | 14 | 0.83 | 0.95 | 0.38 | 135 | 117 | 0.867 |
| 0.6 | 69 | 64 | 5 | 0.93 | 0.86 | 0.49 | 129 | 114 | 0.884 |
| 0.7 | 52 | 51 | 1 | 0.98 | 0.69 | 0.61 | 110 | 95 | 0.864 |
| 0.8 | 21 | 21 | 0 | 1.00 | 0.28 | 0.84 | 42 | 35 | 0.833 |
| 0.85 | 10 | 10 | 0 | 1.00 | 0.14 | 0.93 | 12 | 12 | 1.000 |
| 0.9 | 2 | 2 | 0 | 1.00 | 0.03 | 0.99 | 2 | 2 | 1.000 |
| 0.95 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 0 | 0 | n/a |
| 0.99 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 0 | 0 | n/a |
| 0.995 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 0 | 0 | n/a |
| 0.999 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 0 | 0 | n/a |

By kind at the policy bar:

| Kind | Claims | AUC | Supported | False supports | Support recall |
|---|---|---|---|---|---|
| dataset | 23 | 0.992 | 0 | 0 | 0.00 |
| finding | 39 | 0.917 | 0 | 0 | 0.00 |
| method | 37 | 0.970 | 0 | 0 | 0.00 |
| numeric | 36 | 0.985 | 0 | 0 | 0.00 |

Gold-quote reference (evaluation only, never an input): 74/74 TRUE claims have their gold quote inside at least one chunk of the checked input; 0 TRUE claims were supported at 0.99 by a chunk containing the gold quote.

No refusals or error rows.

Raw per-claim and per-chunk probabilities: see the results JSON beside this file.

