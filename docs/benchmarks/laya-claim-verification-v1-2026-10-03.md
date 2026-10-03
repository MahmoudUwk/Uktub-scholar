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

## Addendum: usage audit (independent subagent, 2026-10-03)

Hypothesis "we used Laya wrong" was tested surgically on 10 failing cases
(chunks only) against the card and the installed package source.

**Usage exonerated:**
- Worker matches the card's exact long-document prescription (Router mode,
  `model="multilingual"`, `max_len=8192`); signature and answer extraction
  match `Router.predict` (router.py:963-985).
- `criteria` on noul is first-class API (agent.py:956-972 renders the
  true/false texts as the option pair); package presets use noul+criteria.
- Nothing truncated: `state_tokens_dropped=0` (5,047 state tokens vs 8,192).
- Exact-usage reproduction re-scored all 10 cases within ±0.0005 of the
  benchmark; recorded paper-level scores provably came from the evidence
  chunk.

**Root cause (model limitation, proven by control):** laya-multilingual's
noul collapses to a claim-blind "true" prior beyond ~1,000-2,000 chars of
dense prose. An unrelated claim ("The Eiffel Tower is located in Berlin")
scores 0.706 on a full chunk, 0.920-0.944 on 3k-char in-window slices —
and 0.013 on a trivial out-of-domain sentence. Dose-response saturates for
ANY claim past ~2,000 chars. The card's long-context table is a choice
task (needle in filler), never noul entailment at length; its entailment
evidence (XNLI 0.843) is short-premise.

**Short-state sanity:** evidence-sentence-only states discriminate (8/10;
one negation miss) — the failure is length-dependent, not claim-dependent.
No parameter combination recovers full-chunk discrimination (bare noul,
minimal wording, criteria removal, max_len 1024 vs 8192, predict_long,
english and typed-decisions checkpoints all ≤4/10; predict_long is
actively harmful for FALSE claims via max-over-windows, 0.89-0.96).

The "rejected" verdict stands; the corrected root cause is
**length-dependent claim-blindness**, not usage error.
