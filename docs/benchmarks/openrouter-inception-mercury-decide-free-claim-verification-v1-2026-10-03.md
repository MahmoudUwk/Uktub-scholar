# openrouter on claim-verification-v1 — 2026-10-03

135 claims (74 TRUE / 61 FALSE), paper context capped at 24000 chars, wall 469 s.

| Metric | Value |
|---|---|
| AUC | 0.903 |
| Mean P(true) TRUE / FALSE | 0.597 / 0.077 |
| Confusion @0.99 | {"bar":0.99,"tp":24,"tn":36,"fp":0,"fn":1,"unverified":74,"dangerous":1,"decided":61,"decidedAccuracy":0.984} |

| Bar | Decided | TP | FP | TN | FN | Unverified | Dangerous | Decided acc |
|---|---|---|---|---|---|---|---|---|
| 0.50 | 135 | 40 | 2 | 59 | 34 | 0 | 36 | 0.73 |
| 0.60 | 132 | 40 | 2 | 58 | 32 | 3 | 34 | 0.74 |
| 0.70 | 125 | 39 | 1 | 56 | 29 | 10 | 30 | 0.76 |
| 0.80 | 114 | 38 | 1 | 52 | 23 | 21 | 24 | 0.79 |
| 0.85 | 106 | 38 | 0 | 50 | 18 | 29 | 18 | 0.83 |
| 0.90 | 103 | 38 | 0 | 49 | 16 | 32 | 16 | 0.84 |
| 0.95 | 92 | 37 | 0 | 44 | 11 | 43 | 11 | 0.88 |
| 0.99 | 61 | 24 | 0 | 36 | 1 | 74 | 1 | 0.98 |

Per-claim rows: see the results JSON beside this file.
