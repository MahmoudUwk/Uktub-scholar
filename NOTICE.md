# NOTICE — per-file provenance

This package is licensed under AGPL-3.0-only. Third-party provenance is recorded per file or directory below.

## Project-internal extraction (same author, an earlier private UktubAI codebase; paths kept for provenance)

- `src/core/registry.ts`, `src/core/citekey.ts`, `src/core/bibrender.ts` — ported from the
  author's earlier private codebase (`UktubAI_Agentic/deploy/sandbox-image/pi-registry.js` and related sandbox
  modules, same author and licence origin). Behaviors and BibTeX normalizers are ported; the
  schema is trimmed to this package's v0 contract.
- `src/core/providers/*`, `src/core/scholarly.ts` — ported from
  `UktubAI_Agentic/apps/control-api/src/tools/providers*` and `scholarly.ts` (same author).
- `src/core/doi.ts` — DOI normalization inlined from `UktubAI_Agentic/packages/shared/src/doi.ts`
  (same author).

## Feynman (MIT, Copyright (c) 2026 Companion, Inc.)

- Methods adopted, not code: incident-derived payload caps (search default 5 / max 20),
  endpoint provenance on search candidates, DOI-shaped-query hint, two-source title
  cross-check at registration. Source: https://github.com/Companion-Inc/feynman
  (commit e17f5fd0ea57775def66ebd2b16b40b39d3dc867 inspected read-only).
- No Feynman source files are copied into this package in v0. If a future version copies
  Feynman code, list each file here with its upstream path and commit.

## Reference-repository studies (2026-10-07; ideas and public API shapes only, no code copied)

- aipoch/open-science (Apache-2.0, commit 2102e6d), alphaXiv/OpenResearch (MIT, commit b9ce4f3) and synthetic-sciences/OpenScience
  (Apache-2.0, commit 44d0334) were cloned shallow into the gitignored `reference_repos/` and read, never executed. Adopted as design
  ideas: the Europe PMC DOI lookup and the PubMed Central open-data bucket route for open-access PDFs (aipoch `src/main/literature/full-text-sources.ts`;
  both are public services documented by their operators), and the arXiv 429/403 cooldown (OpenScience `connectors/literature/arxiv.ts`).
  Reading list for what was not adopted and why: [docs/plans/2026-10-07-reference-repos-integration-plan.md](docs/plans/2026-10-07-reference-repos-integration-plan.md).

## OpenScience (Apache-2.0, Synthetic Sciences)

- Design reference only in v0 (RRF merge shape, per-host HTTP-layer patterns). No
  Apache-2.0 code is included in v0; `NOTICE` obligations would attach to any future copied
  file, which must be listed here. Source: https://github.com/synthetic-sciences/openscience
  (commit 10e03a984313cae78424cf798e316e81ad4433fc inspected read-only).
- Skill methods adapted (ideas, not text; owner-authorized 2026-10-02):
  `skills/uktub-research/SKILL.md` sections "Running a review" (retrieval-loop
  discipline) and the claim-source marking rule derive from that repo's MIT
  `core/literature-review` and `core/sources` skills (upstream
  K-Dense-AI/claude-scientific-writer, MIT). No skill text is copied verbatim.

## evident-charts / GenOffice (companion recommendations, not bundled)

- evident-charts (MIT, https://github.com/rhiever/evident-charts) and GenOffice
  (Apache-2.0, https://github.com/genspark-ai/genoffice) are recommended
  host-side companions; nothing from either is included in this package.

## Product skills (ideas adapted; our own text and code, nothing copied)

- `skills/uktub-figures`: the rules and process derive from OpenScience `core/figures` (MIT, itself adapted from alphaXiv
  OpenResearch `orx-figures`, MIT; pins in [docs/BACKLOG.md](docs/BACKLOG.md) §7) and from the render-then-look review loop of
  rhiever/evident-charts (MIT). `scripts/figstyle.py` is our own implementation; its palette is the Okabe-Ito colour-blind-safe set
  (Okabe and Ito, 2008).
- `skills/uktub-review` and `src/core/review/`: the four measures are reimplemented from the definitions in Appendix A of Oh et al., "Science or Slop?"
  (arXiv 2610.00531); the authors' repository carries no licence and none of its code was used. The review structure (blocking and minor findings, no verdict)
  draws on OpenScience `core/peer-review` (MIT upstream). The parity check uses the CC-BY-4.0 dataset `yerim0210/Scientific_Slop`.
- `skills/uktub-slides`: ideas (action titles, one exhibit per slide) from `Gabberflast/academic-pptx-skill` (MIT; its `SKILL.md` frontmatter says "Proprietary" while the
  repository `LICENSE` is MIT, so only ideas are taken). The Metropolis Beamer theme is used as a LaTeX package at compile time, not distributed here.
- `skills/uktub-diagrams`, `skills/uktub-office`, `skills/uktub-grants`: our own text and code (`docx_changes.py` is standard-library Python). The Specific Aims
  structure follows common funder guidance and OpenScience `research/research-grants` (MIT upstream) as an idea only. pandoc (GPL) and LibreOffice are
  programs the user installs; nothing of them is included.
