# lumma on claim-verification-v1 — 2026-10-03

135 claims (74 TRUE / 61 FALSE), paper context capped at 24000 chars, wall 149 s.

| Metric | Value |
|---|---|
| AUC | 0.449 |
| Mean P(true) TRUE / FALSE | 0.390 / 0.404 |
| Confusion @0.99 | {"bar":0.99,"tp":0,"tn":0,"fp":0,"fn":0,"unverified":135,"dangerous":0,"decided":0,"decidedAccuracy":0} |

| Bar | Decided | TP | FP | TN | FN | Unverified | Dangerous | Decided acc |
|---|---|---|---|---|---|---|---|---|
| 0.50 | 135 | 7 | 6 | 55 | 67 | 0 | 73 | 0.46 |
| 0.60 | 67 | 2 | 0 | 29 | 36 | 68 | 36 | 0.46 |
| 0.70 | 21 | 0 | 0 | 6 | 15 | 114 | 15 | 0.29 |
| 0.80 | 5 | 0 | 0 | 2 | 3 | 130 | 3 | 0.40 |
| 0.85 | 1 | 0 | 0 | 0 | 1 | 134 | 1 | 0.00 |
| 0.90 | 0 | 0 | 0 | 0 | 0 | 135 | 0 | 0.00 |
| 0.95 | 0 | 0 | 0 | 0 | 0 | 135 | 0 | 0.00 |
| 0.99 | 0 | 0 | 0 | 0 | 0 | 135 | 0 | 0.00 |

Per-claim rows: see the results JSON beside this file.
