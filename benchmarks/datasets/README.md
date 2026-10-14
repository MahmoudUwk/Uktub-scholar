# Datasets

Claim-verification benchmarks: a paper, a one-sentence claim, and a label saying whether the paper supports it. Measured results are in [docs/benchmarks](../../docs/benchmarks), not here.

| Dataset | Use it for | Size | Status |
|---|---|---|---|
| [**claim-verification-v2**](claim-verification-v2/README.md) | comparing verification models: counts misses and false supports together | 547 claims (269 TRUE, 278 FALSE) over 48 public arXiv papers (CC BY 4.0) | **current**, immutable |
| [claim-verification-v1](claim-verification-v1) | the earlier engine benchmarks (Eos, Kai, Vela, Decision 3.0, d1-omni, hosted models) and passage-search tests | 135 claims (74 TRUE, 61 FALSE) over 14 papers of the owner's own library (wireless sensing and smart home) | historical: the papers are the owner's and are **not** in this repository; too small to resolve a false-support rate (one false support is 1.6 points) |

`claim-verification-v1` holds `claims.json`, `manifest.json` (schema and rules) and `rag-queries.json` (one paraphrase and one question for each of its 74 TRUE claims, for the passage-search retrieval tests).

New work uses v2. Rebuilding or changing a published dataset is a new version, never an edit.
