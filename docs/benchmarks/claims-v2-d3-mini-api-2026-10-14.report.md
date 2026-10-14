# claim-verification-v2: d3-mini-api (2026-10-14)

Each claim runs through the real `verify_claim` path, scoped to its own paper, exhaustive, at the product's chunking. A claim's score is the highest probability any chunk of its paper got. The bar for a false-support rate is fitted on the other papers (4-fold cross-fit by paper) and applied to the held-out ones; every interval resamples whole papers (95 %).

## Read first

- d3-mini-api ran with uncommitted changes in `src/`, `scripts/` or the dataset, so the commit alone does not reproduce it.

## Setup

- **d3-mini-api**: engine `llama-cpp` (`declared:vllm-sr/d3-mini:criteria`, protocol `systemone-noul-v1`), device api; commit `331bb7b143f4c28e2999421c3b4ca95ba86c5b01`; dataset claims sha256 `396330e267ca`, 547 claims over 48 papers; chunks of 512 tokens, section boundary, overlap 0; `max_judgments` raised from 120 so a paper completes in one call; Intel(R) Core(TM) i7-14650HX, 24 cores, 62 GB, node v26.3.1; load average 2.1/0.9/0.9 at start, 0.0/0.0/0.1 at end; 53 min.

## Ranking

AUC and partial AUC are diagnostics of the ranking, not a comparison of what a user gets.

| Run | Positives | Negatives | Not checked | AUC | Partial AUC (up to 5 % false supports) |
| --- | --- | --- | --- | --- | --- |
| d3-mini-api | 269 | 278 | 0 | 1.00 (1.00–1.00) | 0.96 (0.93–0.99) |

## Bar fitted for a false-support rate of 1 % of negatives

Recall is the share of positives supported; the false-support rate is the share of negatives supported. Utility is (supported positives − w × false supports) / positives, w being the number of misses one false citation is worth.

| Run | Supported positives | False supports | Recall | False-support rate | Utility w = 5 | Utility w = 10 | Utility w = 20 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| d3-mini-api | 251 | 3 | 93.3% (88.4–98.9) | 1.1% (0.7–2.5) | 0.88 (0.80–0.93) | 0.82 (0.69–0.88) | 0.71 (0.43–0.81) |

## Bar fitted for a false-support rate of 2 % of negatives

Recall is the share of positives supported; the false-support rate is the share of negatives supported. Utility is (supported positives − w × false supports) / positives, w being the number of misses one false citation is worth.

| Run | Supported positives | False supports | Recall | False-support rate | Utility w = 5 | Utility w = 10 | Utility w = 20 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| d3-mini-api | 264 | 6 | 98.1% (91.2–99.6) | 2.2% (1.4–4.3) | 0.87 (0.75–0.90) | 0.76 (0.54–0.82) | 0.54 (0.10–0.66) |

## What the product bar returns

The current setting (`min_confidence` 0.99) with no bar fitted, for runs that cover the whole dataset; a partial run's counts at the bar are in its agreement section, on the claims it shares with the first run.

| Run and bar | Supported positives | False supports | Recall | False-support rate | Utility w = 5 | Utility w = 10 | Utility w = 20 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| d3-mini-api, product bar 0.99 | 198 | 0 | 73.6% | 0.0% | 0.74 | 0.74 | 0.74 |

## False supports by the reason a claim is a negative

| Run | Type | Negatives | AUC against this type | False supports at 1 % | False supports at 2 % | False supports at the product bar |
| --- | --- | --- | --- | --- | --- | --- |
| d3-mini-api | contradiction | 46 | 0.997 | 0 | 1 | 0 |
| d3-mini-api | fabricated | 90 | 1.000 | 0 | 0 | 0 |
| d3-mini-api | general | 48 | 1.000 | 0 | 0 | 0 |
| d3-mini-api | perturbed | 94 | 0.995 | 3 | 5 | 0 |

## Cost

| Run | Claims | Chunks per paper | Seconds per claim (mean) | Seconds per claim (median) | Seconds per judgment |
| --- | --- | --- | --- | --- | --- |
| d3-mini-api | 547 | 67 | 5.8 | 4.9 | 0.09 |

Seconds per judgment is wall time over every fresh judgment of the run (chunks and localization checks), so it includes the call overhead of the worker; a machine that was busy inflates it.

## Checks

- d3-mini-api: the product's own verdict equals `score >= 0.99` on 547 of 547 claims.

## Limits

- A negative is a claim the paper does not support, whatever the reason; no support found is not a finding that a claim is false.
- Claims and labels are model-written and model-annotated (no human labelled them); arXiv papers with a CC BY or CC0 licence only; balanced 50/50, so a false-support rate here is a rate per negative, not the number of errors in a real draft.
- Own-paper scope isolates the model and the chunking; a claim checked against many papers has more chances to be falsely supported and is not measured here.
