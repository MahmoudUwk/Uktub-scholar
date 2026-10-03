# openrouter on claim-verification-v1 — 2026-10-03

135 claims (74 TRUE / 61 FALSE), paper context capped at 24000 chars, wall 402 s.

| Metric | Value |
|---|---|
| AUC | 0.675 |
| Mean P(true) TRUE / FALSE | 0.159 / 0.082 |
| Confusion @0.99 | {"bar":0.99,"tp":0,"tn":0,"fp":0,"fn":0,"unverified":135,"dangerous":0,"decided":0,"decidedAccuracy":0} |

| Bar | Decided | TP | FP | TN | FN | Unverified | Dangerous | Decided acc |
|---|---|---|---|---|---|---|---|---|
| 0.50 | 135 | 7 | 2 | 59 | 67 | 0 | 69 | 0.49 |
| 0.60 | 128 | 5 | 0 | 58 | 65 | 7 | 65 | 0.49 |
| 0.70 | 124 | 3 | 0 | 57 | 64 | 11 | 64 | 0.48 |
| 0.80 | 121 | 3 | 0 | 57 | 61 | 14 | 61 | 0.50 |
| 0.85 | 112 | 3 | 0 | 54 | 55 | 23 | 55 | 0.51 |
| 0.90 | 99 | 3 | 0 | 52 | 44 | 36 | 44 | 0.56 |
| 0.95 | 63 | 2 | 0 | 35 | 26 | 72 | 26 | 0.59 |
| 0.99 | 0 | 0 | 0 | 0 | 0 | 135 | 0 | 0.00 |

Per-claim rows: see the results JSON beside this file.
