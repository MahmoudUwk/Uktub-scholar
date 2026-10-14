---
license: cc-by-4.0
language: en
task_categories:
- text-classification
tags:
- scientific-claims
- claim-verification
- benchmark
- arxiv
pretty_name: claim-verification-v2
size_categories:
- n<1K
---

# claim-verification-v2

**Given ONE paper and ONE sentence, does the paper support the sentence?** Each row is a model-written claim about one public arXiv paper, labelled TRUE (the paper supports it) or FALSE (it does not). FALSE means "this paper does not support it", never "false in the world": a verifier answers *supported* or *no support found*, not *false*.

It was built to compare claim verifiers in a way that counts both misses (a supported claim not found) and false supports (an unsupported claim passed as supported). Created 2026-10-11 by Uktub Scholar; immutable once published (a fix is v3).

## At a glance

| | |
|---|---|
| Claims | **547**: 269 TRUE, 278 FALSE |
| Papers | **48** arXiv papers, all **CC BY 4.0**; 16 arXiv categories x 3; 8 to 40 pages (44,000 to 131,000 characters); submitted 2026-09 |
| Per paper | 8 to 12 claims (26 papers have 12); a claim is one sentence of 8 to 43 words |
| Claim types | reworded 180, numeric 89 (TRUE); perturbed 94, fabricated 90, contradiction 46, general 48 (FALSE) |
| Folds | 4 folds of 12 papers (stratified by category) for fitting a bar on other papers |
| Written and checked by | Claude Haiku 5.5 (395 claims) and Sonnet 5.5 (152, the first 13 papers); blind annotator Haiku 5.5 (512) and Opus 5.5 (35). No human labelled anything. |
| Kept / dropped | 547 kept, 29 dropped (28 by the programmatic checks, 1 by the annotator): [dropped.json](dropped.json) |
| Licence | claims, labels and metadata CC BY 4.0; quotes stay under their paper's licence ([ATTRIBUTION.md](ATTRIBUTION.md)); PDFs are not redistributed |

## What is in this folder

| File | What it is |
|---|---|
| [claims.json](claims.json) | the 547 rows (`{"claims": [...]}`), the dataset itself |
| [corpus.json](corpus.json) | per paper: arXiv id and version, category, title, authors, licence, PDF URL, PDF sha256 and size, pages, characters, fold; plus the selection rule and seed |
| [manifest.json](manifest.json) | counts by label, type and kind; models; agreement by type; per-paper counts; the row schema |
| [dropped.json](dropped.json) | every claim that was dropped, with the reason |
| [AUTHORING.md](AUTHORING.md), [ANNOTATION.md](ANNOTATION.md) | the two protocols given to the models (their sha256 is in every row) |
| [ATTRIBUTION.md](ATTRIBUTION.md) | credit for each paper under its own licence |
| [LICENSE](LICENSE) | CC BY 4.0 |

## The claims

| Type | Label | What it is | n |
|---|---|---|---|
| reworded | TRUE | a statement the paper makes, in new words | 180 |
| numeric | TRUE | a statement with an exact value the paper reports | 89 |
| perturbed | FALSE | a true statement with exactly one thing changed (a number, name, direction or comparison) | 94 |
| fabricated | FALSE | plausible for the field, absent from the paper | 90 |
| contradiction | FALSE | the paper states the opposite | 46 |
| general | FALSE | true in the world, but neither stated nor implied by this paper | 48 |

The first row (long strings shortened with …; every field is described in [manifest.json](manifest.json) under `schema`):

```json
{
  "id": "v2-2610.00717v1-01",
  "paper": "2610.00717v1",
  "arxiv_id": "2610.00717",
  "arxiv_version": 1,
  "license": "http://creativecommons.org/licenses/by/4.0/",
  "pdf_sha256": "c5787b69c427…",
  "claim": "The activation-induced metric is built from the current compressed mod…",
  "label": "TRUE",
  "type": "reworded",
  "kind": "method",
  "evidence_quote": "constructing its activation-induced metric from the current compressed…",
  "altered_from_quote": null,
  "author_model": "claude-haiku-5-5",
  "annotator_model": "claude-haiku-5-5",
  "authoring_protocol_sha256": "d1f728f885ad…",
  "annotation_protocol_sha256": "e92c02d5414e…",
  "verification": "passed the programmatic checks (scripts/bench-v2-check.ts) and a blind…"
}
```

`kind` is method, dataset, finding, numeric, limitation or general. `altered_from_quote` is the true quote a perturbed claim was changed from.

## How it was made

1. **Papers by rule, not by hand.** For each of 16 arXiv categories the 100 most recent papers of the window 2026-07-01 to 2026-09-30 were shuffled with seed 20261011 and walked until papers passed: CC BY or CC0 licence read from arXiv's metadata, 8 to 40 pages, 40,000 to 140,000 characters of text, not a survey, review, tutorial or position paper. Other arXiv licences were excluded on purpose (they do not clearly allow quotes in an open dataset). The text is `pdftotext -q` output.
2. **Claims.** One model author per paper wrote about a dozen claims following [AUTHORING.md](AUTHORING.md), with no engine scores and no labels from any engine.
3. **Programmatic checks** ([scripts/bench-v2-check.ts](../../../scripts/bench-v2-check.ts), tested offline): one sentence of 8 to 60 words; every quote is verbatim in the paper; no TRUE claim copies 8 consecutive words; a numeric claim's numbers are in its quote and the paper; a perturbed or fabricated number is absent from the paper; no duplicates.
4. **Blind annotation.** A second model saw only the paper and the shuffled claims (no type, no label, no quote) and labelled each SUPPORTED or NOT_SUPPORTED with a quote ([ANNOTATION.md](ANNOTATION.md)). A claim is kept only when that label is what its type implies: it agreed on 547 of 548.
5. **Audit.** An independent pass compared every row with its paper's text and found no problem; `node scripts/bench-v2-validate.ts` keeps rows, corpus, manifest and protocol hashes consistent.

## Using it

```bash
# 1. the 48 papers and their texts, each checked against the manifest's sha256 and size
node scripts/bench-v2-fetch.ts --out ~/.cache/uktub-bench/v2-corpus

# 2. a model through the product's verify_claim path: each claim against its own paper, 512-token section chunks
node scripts/bench-claims-v2.ts --spec eos --device gpu          # candidates: scripts/bench-claims-v2-engines.ts

# 3. the numbers, and the comparison table of several models
node scripts/bench-claims-v2-report.ts docs/benchmarks/claims-v2-eos-gpu-<date>.results.json
node scripts/bench-claims-v2-table.ts --meta docs/benchmarks/claims-v2-models.meta.json <results.json,...>
```

`scripts/bench-v2-corpus.ts` rebuilds the corpus from arXiv's listing and refuses to overwrite `corpus.json` without `--rebuild`: it is for building a new version, not for fetching this one.

**Scoring.** A claim's score is the highest probability any chunk of its paper gets from the verifier, so the whole score range is available and a claim whose paper could not be checked has no score (counted as not supported, never as a low score). Models are compared by:

- **recall at a fixed false-support rate** (1 % and 2 % of the false claims), the bar fitted on the other three folds and applied to the held-out one, so a model's score scale does not decide the ranking;
- **utility** (supported true claims minus w x false supports) / true claims, for w = 5, 10, 20: w is how many misses one false citation is worth, reported as a grid;
- AUC and partial AUC as diagnostics; the product's 0.99 bar as one extra row;
- every interval resamples whole papers (the claims of one paper are not independent), and a comparison between two models uses the same resampled papers for both (paired).

## Results so far

The [handoff](../../../docs/handoff.md) (section 5) has one row per model class (the full table is regenerated from the results with `scripts/bench-claims-v2-table.ts`); ten models in all (accuracy with intervals, a paired comparison with Eos, size, licence, GPU and CPU cost). Only d3-lite is clearly better than the current verifier (Eos) in AUC (and, run in float32, it passes the 2-second CPU rule narrowly); Kai ties Eos, d3-edge is not distinguishable from it, and the rest are clearly worse. The negatives are not too easy: for Eos, fabricated and general-knowledge claims are separated almost perfectly (AUC 0.98), while perturbed (0.94) and contradiction (0.90) claims, a changed value, direction or negation inside an otherwise matching claim, are where false supports happen. Method and decisions: the protocol files above and the [handoff](../../../docs/handoff.md).

## Limits

- Claims and labels are model-written and model-annotated; no human labelled them, so some label noise is possible. The annotator's agreement is not a measure of correctness.
- arXiv only, English only, CC BY papers only (not a random sample of arXiv); no clinical or social-science journals.
- Balanced 50/50 on purpose so a false-support rate resolves to 0.4 points; real drafts contain fewer false claims, so a rate here is per false claim, not an error count for a draft.
- Own-paper scope: each claim is checked against its own paper only. A claim checked against many papers has more chances of a false support and is not measured here.
- The authoring protocol was clarified twice while claims were written (the `kind` of a `general` claim is `general`; `limitation` is allowed); the protocol hash in every row is that of the file as released.
- Quotes depend on `pdftotext` (poppler 26.01.0); a different version can change line breaks and hyphenation.

## Licence, attribution, citation

The claims, labels and metadata are CC BY 4.0. The quotes in `evidence_quote` and `altered_from_quote` remain under the licence of their source paper (CC BY, per-row `license`); credit the papers as in [ATTRIBUTION.md](ATTRIBUTION.md). Takedown: a rights holder who wants a paper removed should open an issue in the Uktub Scholar repository (issue-tracker URL to be filled in when the repository is published). Citation details are not fixed yet: cite as `claim-verification-v2, Uktub Scholar, 2026-10-11`, and credit the source papers.
