# Independent evidence review — 2026-10-04

Returned supporting excerpts were rated by a fresh Claude reviewer (an LLM, not a human) that saw only the claim and the excerpt — no engine score, no gold quote, no mode. Ratings: **supports** (the excerpt states or directly entails the claim), **partial** (related or supports part of it), **does_not_support**. Strata: `gold-hit` overlaps the dataset's gold quote; `extra` is returned support elsewhere in the paper; `false-claim` is support returned for a FALSE (fabricated) claim.

| Stratum | Reviewed | Supports | Partial | Strict precision / lenient precision |
|---|---|---|---|---|
| gold-hit | 45 | 45 (100.0%) | 0 | 100.0% / 100.0% |
| extra | 44 | 26 (59.1%) | 18 | 59.1% / 100.0% |
| false-claim | 5 | 1 (20.0%) | 0 | 20.0% / 20.0% |
| window 8192 (all strata) | 41 | 32 (78.0%) | 8 | 78.0% / 97.6% |
| window 2048 (all strata) | 53 | 40 (75.5%) | 10 | 75.5% / 94.3% |
| all reviewed | 94 | 72 (76.6%) | 18 | 76.6% / 95.7% |

Strict = supports only; lenient = supports + partial. An LLM reviewer can be wrong; a human spot-check of the `partial` and `does_not_support` rows is the next evidence step.
