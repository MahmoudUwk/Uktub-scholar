# Backlog — deferred capabilities

Each item names its trigger (what reopens it) and its source/template.
Adoption discipline: see `docs/DECISIONS.md`; attribution rules: `NOTICE.md`.

## Deliverable companions (host-side, never bundled)

- **Slides — open-slide runtime** (MIT, github.com/open-slide/open-slide).
  Agent-written React decks on a fixed 1920×1080 canvas with present mode;
  ships `/create-slide` + `/slide-authoring` skills. Alternative runtime:
  **Slidev** (Markdown decks) via slideblocks-skill (MIT) — dormant upstream,
  prefer per session: React-canvas polish vs Markdown simplicity. Trigger: a
  real session asks for a talk/deck from a registered paper set. Content
  guidance template: OpenScience `writing/scientific-slides`.
- **Office deliverables — GenOffice** (Apache-2.0, genspark-ai/genoffice) for
  interactive editing; **Paper Office** (paperinstruments.com, paper-docx/
  paper-pptx/paper-xlsx + skills) for agent-scripted manipulation —
  benchmarked 92.5% vs 80.7% upstream / 69.5% Anthropic skills. Trigger:
  grant/collaboration sessions need real .docx/.pptx. Not our UI (DECISIONS).
- **Charts — evident-charts** (MIT, rhiever/evident-charts). Trigger: chart
  sessions. Already documented in README.
- **Document ingestion — LiteParse** (Apache-2.0, run-llama/liteparse; npm
  `@llamaindex/liteparse`). Rust parser (PDF/docs → text/markdown) for
  reading the USER'S OWN documents the agent must consume (drafts,
  supplementary PDFs); official skill:
  `npx skills add run-llama/llamaparse-agent-skills --skill liteparse`.
  Trigger: sessions where the agent must read non-LaTeX documents in the
  project. Ingestion only — not manipulation; never bundled (zero-dependency
  runtime stays).

## Package capabilities (build here when triggered)

- **Europe PMC source** — trigger: sessions need PubMed/biomedical coverage.
  Patterns: OpenScience `databases/pubmed-database`, workspace `europepmc`
  skill; Unpaywall is forbidden (workspace rule) — OA via OpenAlex only.
- **`paper-figures` skill** — publication-grade figures. Trigger: figure
  sessions accumulate. Templates: evident-charts (rule structure) + OpenScience
  `core/figures`/`scientific-visualization` (LaTeX/vector specifics ours).
  Reference-only (NOASSERTION license — patterns, not code):
  github.com/ChenLiu-1996/figures4papers.
- **Grant-proposal support** — trigger: proposal sessions. Template:
  OpenScience `research/research-grants` (NSF/NIH/DOE/DARPA structure,
  review criteria, broader impacts).
- **Host adapters (Claude Code, Codex)** — MCP wrapper around `src/core`.
  Trigger: a second host user community appears; core stays host-agnostic
  until then (import-allowlist test already enforces the boundary).

## Owner-gated (separate approval required)

- **PDF acquisition** (durable `acquire-paper` task; OpenAlex OA only, no
  Unpaywall, no scraping) and **evidence retrieval** (FTS5 over registered
  abstracts). Deferred with v0; revisit only on owner instruction.
- **UI workbench for non-technical users** — thin layer ABOVE the package;
  enforcement lives there, never inside. Trigger: non-technical user demand.

## Research infrastructure (long arc)

- **RRSI-style harness evolution** — trigger: a corpus of real user sessions
  large enough to evolve against without overfitting (paper:
  arxiv.org/abs/2609.24972). Until then the decision log + evidence gates are
  the manual version of it.
