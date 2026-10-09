# vela on claim-verification-v1 — chunked (chunks-policyA-paragraph) — 2026-10-08

135 claims (74 TRUE / 61 FALSE), 14 papers. New measurement from `scripts/bench-claim-verify.ts` (schema bench-claim-verify/2); metrics are recomputed from the raw per-chunk probabilities in the JSON beside this file.

Engine `vela:vllm-sr/Vela-2.0-0.3B@d6f03aa9baca`, revision `unpinned`. Chunks: 8192 tokens x 2.8 chars/token = 22937 chars, overlap 358 chars, boundary paragraph, text mode paragraph, 43 chunks.

| Metric | Value |
|---|---|
| AUC, tie-corrected (max checked chunk score) | 0.866 over 135 claims (0 unchecked excluded) |
| Mean claim score TRUE / FALSE | 0.669 / 0.257 |
| Support at 0.99: supported / true / FALSE SUPPORTS | 5 / 5 / 0 |
| Support precision / recall at 0.99 | 1.000 / 0.068 |
| Abstention rate at 0.99 | 0.963 |
| Checked coverage (claims fully checked / chunks checked) | 1.000 / 1.000 (416/416 chunks; 0 claims unchecked) |
| Compatibility decided accuracy at 0.99 (two-sided, historical definition) | 0.733 over 15 decided (tp 5, fp 0, tn 6, fn 4) |
| AUC of the historical aggregate score at 0.99 (comparison only) | 0.823 |
| Verifier calls (fresh / from cache) | 416 / 0 |
| Tokens processed (fresh / total checks) | 0 / 0 |
| Context refusals / error rows | 0 / 0 |
| Wall time | 2092 s |

Threshold sweep, recomputed from raw scores. Support columns follow the package question (any checked chunk >= bar supports; a low score only abstains). The last three columns are the labelled historical two-sided *compatibility* metric.

| Bar | Supported | True | False supports | Support precision | Support recall | Abstention | Compat decided | Compat correct | Compat decided acc |
|---|---|---|---|---|---|---|---|---|---|
| 0.5 | 62 | 54 | 8 | 0.87 | 0.73 | 0.54 | 135 | 107 | 0.793 |
| 0.6 | 51 | 45 | 6 | 0.88 | 0.61 | 0.62 | 134 | 100 | 0.746 |
| 0.7 | 43 | 37 | 6 | 0.86 | 0.50 | 0.68 | 129 | 89 | 0.690 |
| 0.8 | 35 | 32 | 3 | 0.91 | 0.43 | 0.74 | 125 | 85 | 0.680 |
| 0.85 | 31 | 29 | 2 | 0.94 | 0.39 | 0.77 | 121 | 81 | 0.669 |
| 0.9 | 26 | 25 | 1 | 0.96 | 0.34 | 0.81 | 107 | 74 | 0.692 |
| 0.95 | 13 | 12 | 1 | 0.92 | 0.16 | 0.90 | 68 | 45 | 0.662 |
| 0.99 | 5 | 5 | 0 | 1.00 | 0.07 | 0.96 | 15 | 11 | 0.733 |
| 0.995 | 3 | 3 | 0 | 1.00 | 0.04 | 0.98 | 6 | 6 | 1.000 |
| 0.999 | 0 | 0 | 0 | n/a | 0.00 | 1.00 | 0 | 0 | n/a |

By kind at the policy bar:

| Kind | Claims | AUC | Supported | False supports | Support recall |
|---|---|---|---|---|---|
| dataset | 23 | 0.923 | 1 | 0 | 0.08 |
| finding | 39 | 0.792 | 0 | 0 | 0.00 |
| method | 37 | 0.763 | 3 | 0 | 0.11 |
| numeric | 36 | 0.931 | 1 | 0 | 0.10 |

Gold-quote reference (evaluation only, never an input): 74/74 TRUE claims have their gold quote inside at least one chunk of the checked input; 5 TRUE claims were supported at 0.99 by a chunk containing the gold quote.

No refusals or error rows.

Raw per-claim and per-chunk probabilities: see the results JSON beside this file.

