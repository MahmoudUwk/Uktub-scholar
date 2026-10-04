# Historical AUC, recomputed with tie correction — 2026-10-04

Decision: the historical AUC values barely move. One exception matters: the
binary `openrouter-chat` run falls from 0.794 to 0.757 (the number the
2026-10-03 hosted-model report already quotes as "binary"). No historical
ranking changes.

This is a **recomputation** of old runs, not a new measurement. It reads the
stored per-claim `pTrue` in `docs/benchmarks/*.results.json` (files written
before schema `bench-claim-verify/2`). The old runner ranked scores with a
rank-sum and no tie correction; the "original formula" column re-applies that
formula to confirm the stored numbers reproduce, and the last column is the
tie-correct (average-rank) AUC from `scripts/bench-metrics.ts`.

Limits:

- Chunked historical files store only the claim-level aggregate score, not
  per-chunk probabilities, and that aggregate depends on the 0.99 bar (best
  supporting chunk, else weakest refuting chunk, else best chunk). Only AUC
  can be recomputed for them; false supports and abstention cannot.
- Chunked historical runs fed the chunker whitespace-normalized text, so
  the paragraph chunker had no paragraph breaks and split at hard character
  offsets. New runs report text mode explicitly.

Reproduce: `node scripts/bench-recompute-historical.ts docs/benchmarks` (prints this table).

| Run | Mode | Claims | Distinct scores | Stored AUC | Original formula, recomputed | Tie-correct, recomputed |
|---|---|---|---|---|---|---|
| `bev-avbiswas-bev-decider-0.4B+chunks` | chunked (stored claim aggregate) | 135 | 135 | not stored | 0.671 | 0.671 |
| `julia+chunks` | chunked (stored claim aggregate) | 135 | 135 | not stored | 0.461 | 0.461 |
| `k2+chunks` | chunked (stored claim aggregate) | 135 | 129 | not stored | 0.814 | 0.814 |
| `k2` | whole paper (24k prefix) | 135 | 131 | 0.78 | 0.780 | 0.779 |
| `laya+chunks` | chunked (stored claim aggregate) | 135 | 126 | not stored | 0.528 | 0.528 |
| `laya` | whole paper (24k prefix) | 135 | 119 | 0.522 | 0.522 | 0.522 |
| `lumma-FrontiersMind-lumma-fev-0.6b+chunks` | chunked (stored claim aggregate) | 135 | 118 | not stored | 0.456 | 0.456 |
| `lumma-FrontiersMind-lumma-fev-0.6b` | whole paper (24k prefix) | 135 | 128 | 0.449 | 0.449 | 0.449 |
| `openrouter+chunks` | chunked (stored claim aggregate) | 135 | 135 | not stored | 0.689 | 0.689 |
| `openrouter--typesafe-jev-latest+chunks` | chunked (stored claim aggregate) | 135 | 46 | not stored | 0.998 | 0.998 |
| `openrouter--typesafe-jev-latest` | whole paper (24k prefix) | 135 | 52 | 0.932 | 0.932 | 0.932 |
| `openrouter-chat` | whole paper (24k prefix) | 135 | 2 | 0.794 | 0.794 | 0.757 |
| `openrouter` | whole paper (24k prefix) | 135 | 135 | 0.675 | 0.675 | 0.675 |
| `openrouter-inception-mercury-decide-free+chunks` | chunked (stored claim aggregate) | 135 | 135 | not stored | 0.998 | 0.998 |
| `openrouter-inception-mercury-decide-free` | whole paper (24k prefix) | 135 | 130 | 0.903 | 0.903 | 0.903 |
| `openrouter-respan-span-01-lite+chunks` | chunked (stored claim aggregate) | 135 | 135 | not stored | 0.689 | 0.689 |
