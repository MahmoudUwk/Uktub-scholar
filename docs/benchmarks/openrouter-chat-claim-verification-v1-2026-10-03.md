# openrouter-chat on claim-verification-v1 — 2026-10-03

135 claims (74 TRUE / 61 FALSE), paper context capped at 24000 chars, wall 293 s.

| Metric | Value |
|---|---|
| AUC | 0.794 |
| Mean P(true) TRUE / FALSE | 0.514 / 0.000 |
| Confusion @0.99 | {"bar":0.99,"tp":38,"tn":61,"fp":0,"fn":36,"unverified":0,"dangerous":36,"decided":135,"decidedAccuracy":0.733} |

| Bar | Decided | TP | FP | TN | FN | Unverified | Dangerous | Decided acc |
|---|---|---|---|---|---|---|---|---|
| 0.50 | 135 | 38 | 0 | 61 | 36 | 0 | 36 | 0.73 |
| 0.60 | 135 | 38 | 0 | 61 | 36 | 0 | 36 | 0.73 |
| 0.70 | 135 | 38 | 0 | 61 | 36 | 0 | 36 | 0.73 |
| 0.80 | 135 | 38 | 0 | 61 | 36 | 0 | 36 | 0.73 |
| 0.85 | 135 | 38 | 0 | 61 | 36 | 0 | 36 | 0.73 |
| 0.90 | 135 | 38 | 0 | 61 | 36 | 0 | 36 | 0.73 |
| 0.95 | 135 | 38 | 0 | 61 | 36 | 0 | 36 | 0.73 |
| 0.99 | 135 | 38 | 0 | 61 | 36 | 0 | 36 | 0.73 |

Per-claim rows: see the results JSON beside this file.
