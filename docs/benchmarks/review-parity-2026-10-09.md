# Manuscript review: parity with the published SciSlop scores (2026-10-09)

The four deterministic measures of `uktub-scholar review` (`src/core/review/`) were reimplemented from Appendix A of Oh et al., "Science or Slop?"
(arXiv 2610.00531). The authors' code has no licence and was not used. This run scores the **body view** of all 773 papers of SciSlopBench
(`yerim0210/Scientific_Slop`, CC-BY-4.0: 390 AI-generated papers each paired with a human-written anchor) and compares our rate per paper with the
published `scores` table. Exact agreement is not expected (their parser, their cue lists); what matters is that we rank papers alike (Spearman) and
separate AI from human papers as well (pair accuracy: the share of pairs where the AI paper scores higher; the published values are the paper's Table 3).

Measured 773 papers in 3.0 s on one CPU core, no model.

| Measure | papers compared | Spearman | mean abs diff | pair accuracy: published | pair accuracy: ours |
|---|---|---|---|---|---|
| macro_redundancy | 773 | 0.923 | 0.004 | 0.723 (390 pairs) | 0.719 (390 pairs) |
| cross_section_refs | 772 | 0.942 | 0.029 | 0.905 (389 pairs) | 0.873 (389 pairs) |
| citation_isolation | 719 | 0.959 | 0.028 | 0.793 (336 pairs) | 0.764 (341 pairs) |
| evidence_gap | 536 | 0.435 | 0.256 | 0.764 (220 pairs) | 0.654 (198 pairs) |

Reading: macro redundancy matches the published pair accuracy to the third decimal; cross-section references and citation isolation rank papers
almost as the published scores do (Spearman above 0.94) and lose 3 points of pair accuracy. **Evidence gap is not comparable here**: the dataset's body
view has no appendix, and the measure is closed by an exhibit anywhere in the paper, appendix included, so papers whose exhibits sit in the appendix
look like gaps to us. Choices the paper leaves open and what parity showed: printed "Figure 2" or "Table 3" mentions do not count as pointers (counting them
lowered agreement); the first-section roadmap is excluded; a section answers to every label inside it; cue words between two works are not used (adding
them lowered agreement); a caption announces an exhibit only if it opens with the word.

Reproduce: export `papers.parquet` (`paper_id`, `body_tex`) and `scores.parquet` to JSON, then `node scripts/bench-review-parity.ts papers.json scores.json --out-dir docs/benchmarks`.
