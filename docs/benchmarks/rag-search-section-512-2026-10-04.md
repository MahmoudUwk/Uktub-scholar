# Passage search — lexical vs vector vs hybrid — 2026-10-04

Gold-passage recall@k for the located TRUE claims of `claim-verification-v1` (claim: 74, paraphrase: 74, question: 74), over 697 section-512 chunks of the 14 papers (embeddinggemma prompts, `embeddinggemma-300m-qat-q8_0-dense`). Query styles: `claim` = the claim text; `paraphrase` / `question` = rewrites written without seeing the papers. A hit = a returned passage of the claim's own paper overlaps the gold span. `own` searches the claim's paper only; `all` searches all 14 (distractors). Hybrid = Reciprocal Rank Fusion (k = 60) of the two rankings (pool 50 each).

| Query | Scope | Papers | Claims | Method | @1 | @3 | @5 | @10 |
|---|---|---|---|---|---|---|---|---|
| claim | own | tuning | 37 | lexical | 83.8% | 100.0% | 100.0% | 100.0% |
| claim | own | tuning | 37 | vector | 62.2% | 89.2% | 97.3% | 97.3% |
| claim | own | tuning | 37 | hybrid | 86.5% | 97.3% | 97.3% | 100.0% |
| claim | own | held-out | 37 | lexical | 94.6% | 97.3% | 97.3% | 100.0% |
| claim | own | held-out | 37 | vector | 64.9% | 89.2% | 94.6% | 97.3% |
| claim | own | held-out | 37 | hybrid | 89.2% | 94.6% | 100.0% | 100.0% |
| claim | own | both | 74 | lexical | 89.2% | 98.6% | 98.6% | 100.0% |
| claim | own | both | 74 | vector | 63.5% | 89.2% | 95.9% | 97.3% |
| claim | own | both | 74 | hybrid | 87.8% | 95.9% | 98.6% | 100.0% |
| claim | all | tuning | 37 | lexical | 81.1% | 100.0% | 100.0% | 100.0% |
| claim | all | tuning | 37 | vector | 59.5% | 86.5% | 89.2% | 94.6% |
| claim | all | tuning | 37 | hybrid | 81.1% | 94.6% | 94.6% | 100.0% |
| claim | all | held-out | 37 | lexical | 86.5% | 94.6% | 97.3% | 100.0% |
| claim | all | held-out | 37 | vector | 56.8% | 75.7% | 81.1% | 89.2% |
| claim | all | held-out | 37 | hybrid | 73.0% | 86.5% | 94.6% | 97.3% |
| claim | all | both | 74 | lexical | 83.8% | 97.3% | 98.6% | 100.0% |
| claim | all | both | 74 | vector | 58.1% | 81.1% | 85.1% | 91.9% |
| claim | all | both | 74 | hybrid | 77.0% | 90.5% | 94.6% | 98.6% |
| paraphrase | own | tuning | 37 | lexical | 51.4% | 73.0% | 78.4% | 86.5% |
| paraphrase | own | tuning | 37 | vector | 54.1% | 70.3% | 81.1% | 94.6% |
| paraphrase | own | tuning | 37 | hybrid | 51.4% | 81.1% | 86.5% | 94.6% |
| paraphrase | own | held-out | 37 | lexical | 59.5% | 73.0% | 86.5% | 94.6% |
| paraphrase | own | held-out | 37 | vector | 62.2% | 78.4% | 86.5% | 91.9% |
| paraphrase | own | held-out | 37 | hybrid | 67.6% | 81.1% | 81.1% | 97.3% |
| paraphrase | own | both | 74 | lexical | 55.4% | 73.0% | 82.4% | 90.5% |
| paraphrase | own | both | 74 | vector | 58.1% | 74.3% | 83.8% | 93.2% |
| paraphrase | own | both | 74 | hybrid | 59.5% | 81.1% | 83.8% | 95.9% |
| paraphrase | all | tuning | 37 | lexical | 40.5% | 59.5% | 70.3% | 78.4% |
| paraphrase | all | tuning | 37 | vector | 45.9% | 59.5% | 70.3% | 78.4% |
| paraphrase | all | tuning | 37 | hybrid | 43.2% | 64.9% | 75.7% | 81.1% |
| paraphrase | all | held-out | 37 | lexical | 48.6% | 64.9% | 70.3% | 83.8% |
| paraphrase | all | held-out | 37 | vector | 54.1% | 64.9% | 73.0% | 75.7% |
| paraphrase | all | held-out | 37 | hybrid | 56.8% | 67.6% | 70.3% | 89.2% |
| paraphrase | all | both | 74 | lexical | 44.6% | 62.2% | 70.3% | 81.1% |
| paraphrase | all | both | 74 | vector | 50.0% | 62.2% | 71.6% | 77.0% |
| paraphrase | all | both | 74 | hybrid | 50.0% | 66.2% | 73.0% | 85.1% |
| question | own | tuning | 37 | lexical | 29.7% | 43.2% | 54.1% | 64.9% |
| question | own | tuning | 37 | vector | 40.5% | 73.0% | 83.8% | 86.5% |
| question | own | tuning | 37 | hybrid | 43.2% | 64.9% | 78.4% | 83.8% |
| question | own | held-out | 37 | lexical | 45.9% | 73.0% | 73.0% | 86.5% |
| question | own | held-out | 37 | vector | 43.2% | 75.7% | 86.5% | 86.5% |
| question | own | held-out | 37 | hybrid | 54.1% | 73.0% | 81.1% | 89.2% |
| question | own | both | 74 | lexical | 37.8% | 58.1% | 63.5% | 75.7% |
| question | own | both | 74 | vector | 41.9% | 74.3% | 85.1% | 86.5% |
| question | own | both | 74 | hybrid | 48.6% | 68.9% | 79.7% | 86.5% |
| question | all | tuning | 37 | lexical | 24.3% | 32.4% | 37.8% | 45.9% |
| question | all | tuning | 37 | vector | 37.8% | 59.5% | 67.6% | 81.1% |
| question | all | tuning | 37 | hybrid | 27.0% | 56.8% | 64.9% | 67.6% |
| question | all | held-out | 37 | lexical | 18.9% | 40.5% | 45.9% | 54.1% |
| question | all | held-out | 37 | vector | 35.1% | 59.5% | 70.3% | 70.3% |
| question | all | held-out | 37 | hybrid | 35.1% | 54.1% | 56.8% | 70.3% |
| question | all | both | 74 | lexical | 21.6% | 36.5% | 41.9% | 50.0% |
| question | all | both | 74 | vector | 36.5% | 59.5% | 68.9% | 75.7% |
| question | all | both | 74 | hybrid | 31.1% | 55.4% | 60.8% | 68.9% |

Cost: embedding 697 passages took 19.7 s once (cached afterwards); median rank time over all papers — lexical 1.25 ms, vector scan 3.18 ms; median end-to-end hybrid search (incl. one query embedding) 30 ms.
