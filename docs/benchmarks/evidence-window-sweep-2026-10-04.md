# Chunk-window sweep — Eos 0.8B — 2026-10-04

The same 46 claims (every third claim of each label, deterministic) at four stage-1 window sizes, in-package `eos` engine, bar 0.99, own-paper scope. Fresh registry per mode, so no cache sharing. The 8,192 and 2,048 rows are the earlier full runs restricted to these claims (their FALSE claims ran over all papers; only support from the claim's own paper is counted here). Locator query = the claim text.

| Window (tokens) | Mode | TRUE claims | Support recall | Gold-hit precision (lower bound) | Evidence / claim | Fresh judgments / claim | Wall s / claim | FALSE claims with support (own paper) |
|---|---|---|---|---|---|---|---|---|
| 8192 | exhaustive | 25 | 52.0% | 65.0% | 0.80 | 16.0 | 3.6 | 0/21 |
| 8192 | guided | 25 | 52.0% | 65.0% | 0.80 | 15.7 | 3.3 | n/a |
| 2048 | exhaustive | 25 | 76.0% | 76.0% | 1.00 | 18.2 | 2.9 | 2/21 |
| 2048 | guided | 25 | 72.0% | 75.0% | 0.96 | 9.0 | 1.2 | n/a |
| 1024 | exhaustive | 25 | 84.0% | 72.4% | 1.16 | 30.5 | 3.1 | 2/21 |
| 1024 | guided | 25 | 84.0% | 72.4% | 1.16 | 7.9 | 0.9 | 2/21 |
| 512 | exhaustive | 25 | 84.0% | 75.0% | 1.12 | 50.1 | 3.5 | 2/21 |
| 512 | guided | 25 | 84.0% | 77.8% | 1.08 | 5.0 | 0.5 | 2/21 |

Reading: recall rises from 52 % at 8,192 to 84 % at 1,024 and does not improve at 512; the own-paper false-support count is the same at 2,048, 1,024 and 512. A locator query keeps the recall and removes most of the work once windows are small. Samples are small (25 true, 21 false claims): differences of one claim are noise; the direction agrees with the larger 2,048-vs-8,192 runs.
