# Backlog — deferred capabilities

Each item names its trigger (what reopens it) and its source/template.
Adoption discipline: see `docs/DECISIONS.md`; attribution rules: `NOTICE.md`.

## Deliverable companions (host-side, never bundled)

- **Slides — open-slide runtime** (MIT, github.com/open-slide/open-slide).
  Agent-written React decks on a fixed 1920×1080 canvas with present mode;
  ships `/create-slide` + `/slide-authoring` skills. Alternative runtime:
  **Slidev** (Markdown decks) via slideblocks-skill (MIT) — dormant upstream,
  prefer per session: React-canvas polish vs Markdown simplicity. For
  .pptx-flavoured academic decks, **academic-pptx-skill** (MIT,
  Gabberflast/academic-pptx-skill) is the content-discipline template:
  action titles, argument structure, ghost-deck test, exhibit/citation
  standards. Trigger: a real session asks for a talk/deck from a registered
  paper set. Content guidance template: OpenScience
  `writing/scientific-slides`.
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

- **Evidence retrieval + claim verification (RAG-era design)** — when the
  owner green-lights retrieval: SQLite FTS5 over registered abstracts first
  (minimal, offline); the WeKnora-inspired pattern on top when corpus scale
  demands it — chunk retrieval → **local CPU-class decision model** filters
  chunks by query relevance → claim-vs-passage verification with provenance.
  Owner proposal for the decision model: **Julia-1**
  (huggingface.co/SupersonicLabs/Julia-1, small, CPU) — DEFERRED by owner
  instruction; re-evaluate model choice at build time against CPU latency
  and filtering quality. WeKnora itself (Tencent, MIT+exceptions, Go
  platform) stays prior art / optional self-hosted service — never a package
  component.
- **PDF acquisition** (durable `acquire-paper` task; OpenAlex OA only, no
  Unpaywall, no scraping). Deferred with v0; revisit only on owner
  instruction.
- **UI workbench for non-technical users** — thin layer ABOVE the package;
  enforcement lives there, never inside. Trigger: non-technical user demand.

## Computational experiments (simulation & coding sessions)

- **Pattern (adopted): autoresearch-style autonomous experiment loops** —
  budget-bounded keep-or-discard iterations against one metric; human-owned
  `program.md` instructions, agent-edited code file; every experiment logged
  with its verdict (joins the RRSI discipline in `docs/DECISIONS.md`). The
  source repo carries NO license — pattern only, no code.
- **Capabilities (build here when triggered):** port from the OpenScience
  library per demand — `physics` (pde-solver, uncertainty-and-units,
  symbolic-regression), `quantum` (qiskit, pennylane), `coding`
  (exploratory-data-analysis, statistical-analysis, scikit-learn, sympy).
  Trigger: the first session asking the package to run or verify a
  simulation / computational analysis; each capability lands as its own
  skill with NOTICE attribution.

## Research infrastructure (long arc)

- **RRSI-style harness evolution** — trigger: a corpus of real user sessions
  large enough to evolve against without overfitting (paper:
  arxiv.org/abs/2609.24972). Until then the decision log + evidence gates are
  the manual version of it.
