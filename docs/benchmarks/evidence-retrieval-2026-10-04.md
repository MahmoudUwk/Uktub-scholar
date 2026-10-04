# Locator retrieval recall — 2026-10-04

FTS5/BM25 candidate recall for the TRUE claims of `claim-verification-v1`: is the gold quote inside a candidate chunk when the locator is the claim text itself? Papers are split by source (even-indexed = tuning, odd-indexed = held-out). `share` is the mean fraction of a paper's chunks that become candidates (verifier work saved = 1 − share).

| Chunk tokens | K | Part | Claims (gold located) | Candidate recall | Mean candidate share |
|---|---|---|---|---|---|
| 1024 | 1 | tuning | 37 (37) | 81.1% | 3.9% |
| 1024 | 1 | held-out | 37 (37) | 86.5% | 8.3% |
| 1024 | 3 | tuning | 37 (37) | 91.9% | 11.7% |
| 1024 | 3 | held-out | 37 (37) | 97.3% | 24.8% |
| 1024 | 5 | tuning | 37 (37) | 97.3% | 19.5% |
| 1024 | 5 | held-out | 37 (37) | 97.3% | 34.2% |
| 1024 | 8 | tuning | 37 (37) | 100.0% | 31.3% |
| 1024 | 8 | held-out | 37 (37) | 100.0% | 48.2% |
| 1024 | 12 | tuning | 37 (37) | 100.0% | 46.9% |
| 1024 | 12 | held-out | 37 (37) | 100.0% | 66.8% |
| 2048 | 1 | tuning | 37 (37) | 81.1% | 8.0% |
| 2048 | 1 | held-out | 37 (37) | 78.4% | 14.5% |
| 2048 | 3 | tuning | 37 (37) | 94.6% | 23.9% |
| 2048 | 3 | held-out | 37 (37) | 100.0% | 38.0% |
| 2048 | 5 | tuning | 37 (37) | 97.3% | 39.8% |
| 2048 | 5 | held-out | 37 (37) | 100.0% | 56.2% |
| 2048 | 8 | tuning | 37 (37) | 100.0% | 56.0% |
| 2048 | 8 | held-out | 37 (37) | 100.0% | 79.6% |
| 2048 | 12 | tuning | 37 (37) | 100.0% | 72.7% |
| 2048 | 12 | held-out | 37 (37) | 100.0% | 92.3% |
| 8192 | 1 | tuning | 37 (37) | 81.1% | 30.0% |
| 8192 | 1 | held-out | 37 (37) | 89.2% | 46.4% |
| 8192 | 3 | tuning | 37 (37) | 100.0% | 77.7% |
| 8192 | 3 | held-out | 37 (37) | 100.0% | 95.9% |
| 8192 | 5 | tuning | 37 (37) | 100.0% | 92.8% |
| 8192 | 5 | held-out | 37 (37) | 100.0% | 100.0% |
| 8192 | 8 | tuning | 37 (37) | 100.0% | 98.2% |
| 8192 | 8 | held-out | 37 (37) | 100.0% | 100.0% |
| 8192 | 12 | tuning | 37 (37) | 100.0% | 100.0% |
| 8192 | 12 | held-out | 37 (37) | 100.0% | 100.0% |

Raw rows: the results JSON beside this file. Gold spans are located in the `unpdf` text by token matching because the dataset quotes were authored against `pdftotext`; claims whose quote cannot be located are excluded and counted.
