# decision2-kai on claim-verification-v1 — chunked (policyB-paragraph) — 2026-10-04

135 claims (74 TRUE / 61 FALSE), 14 papers. New measurement from `scripts/bench-claim-verify.ts` (schema bench-claim-verify/2); metrics are recomputed from the raw per-chunk probabilities in the JSON beside this file.

Engine `decision2-kai:claim-noul-criteria-v1`, revision `cd49ea3813fd8ba0928a9a23ef6c9a0f2f0cd764`. Chunks: 7800 tokens x 3.3 chars/token = 25740 chars, overlap 422 chars, boundary paragraph, text mode paragraph, 40 chunks.

| Metric | Value |
|---|---|
| AUC, tie-corrected (max checked chunk score) | 0.963 over 135 claims (0 unchecked excluded) |
| Mean claim score TRUE / FALSE | 0.721 / 0.411 |
| Support at 0.99: supported / true / FALSE SUPPORTS | 0 / 0 / 0 |
| Support precision / recall at 0.99 | n/a / 0.000 |
| Abstention rate at 0.99 | 1.000 |
| Checked coverage (claims fully checked / chunks checked) | 0.933 / 0.977 (377/386 chunks; 0 claims unchecked) |
| Compatibility decided accuracy at 0.99 (two-sided, historical definition) | n/a over 0 decided (tp 0, fp 0, tn 0, fn 0) |
| AUC of the historical aggregate score at 0.99 (comparison only) | 0.963 |
| Verifier calls (fresh / from cache) | 386 / 0 |
| Tokens processed (fresh / total checks) | 1816367 / 1895078 |
| Context refusals / error rows | 9 / 0 |
| Wall time | 317 s (worker inference 310.849 s) |
| Model load | 2.436 s, 1437.8 MiB resident |
| Peak GPU memory (allocated / reserved) | 1999.1 / 2070 MiB |

Threshold sweep, recomputed from raw scores. Support columns follow the package question (any checked chunk >= bar supports; a low score only abstains). The last three columns are the labelled historical two-sided *compatibility* metric.

| Bar | Supported | True | False supports | Support precision | Support recall | Abstention | Compat decided | Compat correct | Compat decided acc |
|---|---|---|---|---|---|---|---|---|---|
| 0.5 | 87 | 71 | 16 | 0.82 | 0.96 | 0.36 | 135 | 116 | 0.859 |
| 0.6 | 69 | 64 | 5 | 0.93 | 0.86 | 0.49 | 131 | 116 | 0.885 |
| 0.7 | 50 | 50 | 0 | 1.00 | 0.68 | 0.63 | 117 | 97 | 0.829 |
| 0.8 | 16 | 16 | 0 | 1.00 | 0.22 | 0.88 | 42 | 34 | 0.810 |
| 0.85 | 7 | 7 | 0 | 1.00 | 0.09 | 0.95 | 10 | 10 | 1.000 |
| 0.9 | 2 | 2 | 0 | 1.00 | 0.03 | 0.99 | 2 | 2 | 1.000 |
| 0.95 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 0 | 0 | n/a |
| 0.99 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 0 | 0 | n/a |
| 0.995 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 0 | 0 | n/a |
| 0.999 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 0 | 0 | n/a |

By kind at the policy bar:

| Kind | Claims | AUC | Supported | False supports | Support recall |
|---|---|---|---|---|---|
| dataset | 23 | 0.992 | 0 | 0 | 0.00 |
| finding | 39 | 0.931 | 0 | 0 | 0.00 |
| method | 37 | 0.970 | 0 | 0 | 0.00 |
| numeric | 36 | 0.996 | 0 | 0 | 0.00 |

Gold-quote reference (evaluation only, never an input): 74/74 TRUE claims have their gold quote inside at least one chunk of the checked input; 0 TRUE claims were supported at 0.99 by a chunk containing the gold quote.

Unchecked rows: 9 refused over the context limit, 0 errors. Samples: c059#6: context_limit: 8746 tokens exceeds the 8192-token window; refused, not truncated; c060#6: context_limit: 8751 tokens exceeds the 8192-token window; refused, not truncated; c061#6: context_limit: 8740 tokens exceeds the 8192-token window; refused, not truncated; c062#6: context_limit: 8760 tokens exceeds the 8192-token window; refused, not truncated; c063#6: context_limit: 8748 tokens exceeds the 8192-token window; refused, not truncated

Raw per-claim and per-chunk probabilities: see the results JSON beside this file.

