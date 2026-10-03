# openrouter on claim-verification-v1 — 2026-10-03

135 claims (74 TRUE / 61 FALSE), paper context capped at 24000 chars, wall 134 s.

| Metric | Value |
|---|---|
| AUC | 0.932 |
| Mean P(true) TRUE / FALSE | 0.617 / 0.096 |
| Confusion @0.99 | {"bar":0.99,"tp":5,"tn":5,"fp":0,"fn":0,"unverified":125,"dangerous":0,"decided":10,"decidedAccuracy":1} |

| Bar | Decided | TP | FP | TN | FN | Unverified | Dangerous | Decided acc |
|---|---|---|---|---|---|---|---|---|
| 0.50 | 135 | 41 | 0 | 61 | 33 | 0 | 33 | 0.76 |
| 0.60 | 130 | 39 | 0 | 61 | 30 | 5 | 30 | 0.77 |
| 0.70 | 119 | 38 | 0 | 57 | 24 | 16 | 24 | 0.80 |
| 0.80 | 98 | 37 | 0 | 50 | 11 | 37 | 11 | 0.89 |
| 0.85 | 86 | 36 | 0 | 46 | 4 | 49 | 4 | 0.95 |
| 0.90 | 75 | 33 | 0 | 39 | 3 | 60 | 3 | 0.96 |
| 0.95 | 64 | 27 | 0 | 35 | 2 | 71 | 2 | 0.97 |
| 0.99 | 10 | 5 | 0 | 5 | 0 | 125 | 0 | 1.00 |

Per-claim rows: see the results JSON beside this file.
