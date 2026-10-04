# Evidence quality — end to end — 2026-10-04

The package's own `verify_claim` workflow (unpdf extraction, chunking, FTS5 locator, two-stage judgment, containment) on `claim-verification-v1`, with a real local engine: Decision 2.0 Eos 0.8B behind the `llama-cpp` path, bar 0.99. Papers are split by source: even-indexed = tuning, odd-indexed = held-out. TRUE claims run scoped to their paper, exhaustive (no query) and guided (query = the claim); FALSE claims run exhaustive over all 14 papers. Each mode used its own fresh registry, so the judgment cache never flatters the cost comparison.

Gold-hit precision is a LOWER bound: a returned passage that supports the claim somewhere other than the gold quote counts as a miss here; see the independent review report for true precision.

| Chunk tokens | Part | Mode | TRUE claims (gold located) | Support recall | Gold-hit precision | Mean evidence / claim | Mean fresh judgments / claim | Mean wall s / claim | Excerpts withheld |
|---|---|---|---|---|---|---|---|---|---|
| 8192 | tuning | exhaustive | 37 (37) | 45.9% | 60.7% | 0.8 | 14.9 | 4.3 | 3/28 |
| 8192 | tuning | guided | 37 (37) | 45.9% | 60.7% | 0.8 | 14.2 | 3.7 | 3/28 |
| 8192 | held-out | exhaustive | 37 (37) | 64.9% | 88.9% | 0.7 | 14.8 | 2.8 | 3/27 |
| 8192 | held-out | guided | 37 (37) | 64.9% | 88.9% | 0.7 | 14.8 | 2.8 | 3/27 |
| 2048 | tuning | exhaustive | 37 (37) | 67.6% | 65.8% | 1.0 | 22.2 | 3.6 | 5/38 |
| 2048 | tuning | guided | 37 (37) | 64.9% | 64.9% | 1.0 | 9.4 | 1.4 | 4/37 |
| 2048 | held-out | exhaustive | 37 (37) | 78.4% | 87.9% | 0.9 | 14.3 | 2.1 | 3/33 |
| 2048 | held-out | guided | 37 (37) | 78.4% | 87.9% | 0.9 | 8.8 | 1.1 | 3/33 |

## False supports versus corpus size

FALSE claims are fabrications about one paper. `Papers` is how many papers are in scope (the claim's own paper plus the next n−1 in a fixed order); a false support is any supporting evidence returned from those papers. Supports from OTHER papers are not automatically errors (another paper may genuinely say the same thing); the review report decides. The last column is the hard case: support returned from the paper the claim was fabricated about.

| Chunk tokens | Part | Papers | FALSE claims | With any support | Rate | Own-paper rate |
|---|---|---|---|---|---|---|
| 8192 | tuning | 1 | 31 | 0 | 0.0% | 0.0% |
| 8192 | tuning | 2 | 31 | 0 | 0.0% | — |
| 8192 | tuning | 4 | 31 | 0 | 0.0% | — |
| 8192 | tuning | 7 | 31 | 0 | 0.0% | — |
| 8192 | tuning | 14 | 31 | 0 | 0.0% | — |
| 8192 | held-out | 1 | 30 | 1 | 3.3% | 3.3% |
| 8192 | held-out | 2 | 30 | 1 | 3.3% | — |
| 8192 | held-out | 4 | 30 | 1 | 3.3% | — |
| 8192 | held-out | 7 | 30 | 1 | 3.3% | — |
| 8192 | held-out | 14 | 30 | 1 | 3.3% | — |
| 2048 | tuning | 1 | 31 | 1 | 3.2% | 3.2% |
| 2048 | tuning | 2 | 31 | 1 | 3.2% | — |
| 2048 | tuning | 4 | 31 | 1 | 3.2% | — |
| 2048 | tuning | 7 | 31 | 1 | 3.2% | — |
| 2048 | tuning | 14 | 31 | 2 | 6.5% | — |
| 2048 | held-out | 1 | 30 | 2 | 6.7% | 6.7% |
| 2048 | held-out | 2 | 30 | 2 | 6.7% | — |
| 2048 | held-out | 4 | 30 | 2 | 6.7% | — |
| 2048 | held-out | 7 | 30 | 2 | 6.7% | — |
| 2048 | held-out | 14 | 30 | 2 | 6.7% | — |

Raw per-claim records (spans, counts, bounded excerpts): the results JSON files named in `docs/benchmarks/evidence-endtoend-*`.
