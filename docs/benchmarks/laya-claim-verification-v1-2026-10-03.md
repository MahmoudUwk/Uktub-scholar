# laya on claim-verification-v1 — 2026-10-03

135 claims (74 TRUE / 61 FALSE), paper context capped at 24000 chars, wall 40 s.

| Metric | Value |
|---|---|
| AUC | 0.522 |
| Mean P(true) TRUE / FALSE | 0.805 / 0.805 |
| Confusion @0.99 | {"bar":0.99,"tp":0,"tn":0,"fp":0,"fn":0,"unverified":135,"dangerous":0,"decided":0,"decidedAccuracy":0} |

| Bar | Decided | TP | FP | TN | FN | Unverified | Dangerous | Decided acc |
|---|---|---|---|---|---|---|---|---|
| 0.50 | 135 | 73 | 61 | 0 | 1 | 0 | 62 | 0.54 |
| 0.60 | 131 | 71 | 60 | 0 | 0 | 4 | 60 | 0.54 |
| 0.70 | 113 | 61 | 52 | 0 | 0 | 22 | 52 | 0.54 |
| 0.80 | 87 | 48 | 39 | 0 | 0 | 48 | 39 | 0.55 |
| 0.85 | 49 | 29 | 20 | 0 | 0 | 86 | 20 | 0.59 |
| 0.90 | 11 | 6 | 5 | 0 | 0 | 124 | 5 | 0.55 |
| 0.95 | 4 | 2 | 2 | 0 | 0 | 131 | 2 | 0.50 |
| 0.99 | 0 | 0 | 0 | 0 | 0 | 135 | 0 | 0.00 |

Per-claim rows: see the results JSON beside this file.

## Chunked mode (8192-token chunks, any-chunk aggregation, GPU)

Run: 42 chunks, 406 fresh chunk-verifications, wall 135 s on RTX 4060
(resident Router worker, GPU stable across all worker recycles). The
multilingual checkpoint ships invalid calibration temperatures (runtime
warning: probabilities uncalibrated) — measured behavior confirms it.

AUC 0.528 (whole-paper 0.522); mean P(true) TRUE 0.858 / FALSE 0.850 —
everything scores high, nothing discriminates. Max best-p 0.9745: no
claim ever reaches the 0.99 bar.

Sweep (best-p proxy):

| bar | decided | tp | fp | fn | dangerous | accuracy |
|---|---|---|---|---|---|---|
| 0.85 | 75 | 43 | 32 | 0 | 32 | 0.573 |
| 0.90 | 38 | 24 | 14 | 0 | 14 | 0.632 |
| 0.95 | 4 | 2 | 2 | 0 | 2 | 0.500 |
| 0.99 | 0 | 0 | 0 | 0 | 0 | — |

**Verdict: Laya-multilingual REJECTED for claim verification** (zero-shot,
per model-card recommended usage): coin-flip discrimination with
over-confident probabilities and NO safe operating bar — at 0.95 it is a
coin flip WITH dangerous verdicts. Consistent with the checkpoint's
invalid calibration temperatures. Kept as a measured-rejected engine;
the Router-mode adapter (scripts/laya_decide.py) survives it.
