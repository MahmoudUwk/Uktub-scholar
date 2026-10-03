# k2 on claim-verification-v1 — 2026-10-03

135 claims (74 TRUE / 61 FALSE), paper context capped at 24000 chars, wall 152 s.

| Metric | Value |
|---|---|
| AUC | 0.78 |
| Mean P(true) TRUE / FALSE | 0.783 / 0.565 |
| Confusion @0.99 | {"bar":0.99,"tp":0,"tn":0,"fp":0,"fn":0,"unverified":135,"dangerous":0,"decided":0,"decidedAccuracy":0} |

| Bar | Decided | TP | FP | TN | FN | Unverified | Dangerous | Decided acc |
|---|---|---|---|---|---|---|---|---|
| 0.50 | 135 | 72 | 39 | 22 | 2 | 0 | 41 | 0.70 |
| 0.60 | 110 | 66 | 31 | 13 | 0 | 25 | 31 | 0.72 |
| 0.70 | 84 | 56 | 19 | 9 | 0 | 51 | 19 | 0.77 |
| 0.80 | 55 | 37 | 11 | 7 | 0 | 80 | 11 | 0.80 |
| 0.85 | 37 | 26 | 6 | 5 | 0 | 98 | 6 | 0.84 |
| 0.90 | 24 | 17 | 3 | 4 | 0 | 111 | 3 | 0.88 |
| 0.95 | 11 | 9 | 0 | 2 | 0 | 124 | 0 | 1.00 |
| 0.99 | 0 | 0 | 0 | 0 | 0 | 135 | 0 | 0.00 |

Per-claim rows: see the results JSON beside this file.

## Chunked mode (8192-token chunks, any-chunk aggregation)

AUC 0.814 (whole-paper 0.78); mean P(true) TRUE 0.868 / FALSE 0.724;
42 chunks, 420 chunk-verifications, wall 386 s (4 workers, one GPU server).

Sweep (best-p proxy; supported = any chunk >= bar):

| bar | decided | tp | fp | fn | dangerous | accuracy |
|---|---|---|---|---|---|---|
| 0.85 | 58 | 48 | 10 | 0 | 10 | 0.828 |
| 0.90 | 39 | 37 | 2 | 0 | 2 | 0.949 |
| **0.95** | **18** | **18** | **0** | **0** | **0** | **1.000** |
| 0.98 | 6 | 6 | 0 | 0 | 0 | 1.000 |
| 0.99 | 1 | 1 | 0 | 0 | 0 | 1.000 |

**Verdict: K2-Type-0.9B ADOPTED as the primary verification engine
(chunked, jev server on GPU).** First engine with a useful safe operating
point: at 0.95 it confirms 18 true claims with zero false positives and
never refutes on this set (Julia-1: AUC 0.529/0.461, 0 useful
confirmations). Paraphrase entailments Julia missed score 0.78-0.94.
Known residual blind spot: numeric fabrications still score high
("16 kW" vs 6 kW: 0.906; "2,400 recordings" vs 240: 0.679 whole-paper) —
the 0.95 knee is measured on THIS set; the owner may keep 0.99 as default
bar (config/chunking.yaml verification.min_confidence, currently 0.99) or
lower to 0.95 per the knee above. Model card limits honored: inputs >
8192 tokens refused HTTP 413 (never truncated); decision head only.
