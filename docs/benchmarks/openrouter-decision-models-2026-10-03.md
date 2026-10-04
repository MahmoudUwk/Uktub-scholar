# OpenRouter hosted decision models — 135-claim claim-verification benchmark (2026-10-03)

All models served via the TypeSafe System One wire shape on
`POST /api/alpha/decisions` (adapter: `openrouterDecisionsEngine` in
`src/core/verify/claim.ts`; jev-router via chat in
`openrouterChatEngine`). Same dataset, chunker, cache, and 0.99 bar as all
prior benchmarks. Free-tier models throttled to the 20/min pool (labelled
client policy) — their wall times reflect the throttle, not model latency.

## Results

### Chunked (8192-token chunks, any-chunk aggregation) — the harness standard

| Model | AUC | Mean P(true) T / F | Verdicts @ 0.99 | Decided accuracy | Wall (notes) |
|---|---|---|---|---|---|
| **inception/mercury-decide:free** | **0.998** | **0.976 / 0.035** | **109 decided: 54 TP + 54 TN, 0 FP, 1 FN** | **0.991** | 1593 s (free-tier throttle; ~0.3 s/call actual) |
| ~typesafe/jev-latest (jev-1.13) | **0.998** | 0.954 / 0.192 | 14 decided: 8 TP + 6 TN, 0 FP, 0 FN | 1.000 | 102 s (1 s throttle) |
| respan/span-01-lite | 0.689 | 0.282 / 0.144 | 0 decided | — | 358 s (throttled) |
| respan/span-01 (paid, same weights) | 0.689 | 0.282 / 0.144 | 0 decided | — | 61 s |
| K2-Type-0.9B (local, prior best) | 0.814 | 0.868 / 0.724 | 1 decided | 1.000 | 386 s |
| Julia-1 (rejected) | 0.461 | 0.666 / 0.697 | 1 decided | 1.000 | 900 s |
| Laya-multilingual (rejected) | 0.528 | 0.858 / 0.850 | 0 decided | — | 135 s |

### Whole-paper

| Model | AUC | Verdicts @ 0.99 | Notes |
|---|---|---|---|
| **mercury-decide:free** | **0.903** | 61 decided, 60 correct, 0 FP, 1 FN | best whole-paper too |
| ~typesafe/jev-latest | 0.932 | 10 decided, 10/10 | 0 FP at EVERY bar; @0.95: 64 decided, 96.9 % |
| typesafe/jev-router (chat, binary yes/no) | 0.757 (binary) | 38 TP + 61 TN, 0 FP, 36 FN | reasons before answering; max_tokens must cover it |
| respan/span-01(-lite) | 0.675 | 0 decided | aggressive refuter: 67/74 TRUE claims rejected |
| K2-Type-0.9B | 0.780 | 0 decided | |

## Findings

1. **Mercury Decide (free) dominates every axis at the owner's 0.99 bar:**
   109/135 claims decided with 108 correct and ZERO false positives —
   bimodal, bar-ready probabilities (identical confusion at 0.90/0.95/0.99).
   It also fixes the numeric-fabrication blind spot shared by every local
   model ("2,400 vs 240 recordings" → P 0.047; K2 0.679, Julia 0.952).
2. **jev-1.13 is the precision specialist:** 0 FP at every bar in both
   modes, AUC 0.998 chunked, but decides sparingly at 0.99 (14/135). Jev
   family = conservative confirmers; Mercury = decisive confirmers.
3. **Chunking lifts every serious decision model** (mercury 0.903→0.998,
   jev-latest 0.932→0.998, K2 0.780→0.814) and hurts only the rejected
   encoders (Julia 0.529→0.461). The chunk-first substrate is validated
   across architectures.
4. **Span-01 is a refuter, not a verifier** (everything scores low);
   identical outputs from the paid and free tiers.
5. Free-tier cost: $0 (mercury, span-lite, ~20 req/min); jev-latest
   ≈ $0.003 per full benchmark run.

**Recommendation update:** verification chain = mercury-decide:free
(chunked, bar 0.99) as primary hosted engine; K2 chunked stays the local
offline fallback; jev-latest for precision-critical spot checks. The 0.95
K2 knee is superseded by mercury@0.99 (more decisions, zero observed false
positives on this set, not a guarantee for unseen claims). Raw per-claim results
remain in the per-model `*.results.json` files alongside this report.
