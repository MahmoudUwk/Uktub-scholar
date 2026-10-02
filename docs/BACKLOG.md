# Backlog — deferred capabilities

Each item names its trigger (what reopens it) and its source/template.
Adoption discipline: see `docs/DECISIONS.md`; attribution rules: `NOTICE.md`.

## Deliverable companions (host-side, never bundled)

- **Slides — open-slide runtime** (MIT, github.com/open-slide/open-slide).
  Agent-written React decks on a fixed 1920×1080 canvas with present mode;
  ships `/create-slide` + `/slide-authoring` skills. Trigger: a real session
  asks for a talk/deck from a registered paper set (conference talk, lab
  meeting, defense). Content guidance template: OpenScience
  `writing/scientific-slides`. Pattern: recommend host-side like
  evident-charts/GenOffice.
- **Office deliverables — GenOffice** (Apache-2.0, genspark-ai/genoffice).
  Trigger: grant/collaboration sessions need real .docx/.pptx for co-authors
  or agency submission. Not our UI (see DECISIONS 2026-10-02).
- **Charts — evident-charts** (MIT, rhiever/evident-charts). Trigger: chart
  sessions. Already documented in README.

## Package capabilities (build here when triggered)

- **Registry-guard hook** — Pi extension using the tool-interception hook
  surface to block built-in write/bash tools from `.registry/**` and keep
  `refs/**` read-only for the agent, making the package contract enforceable
  against the host's own tools (reference: walkinglabs learn-harness-engineering
  Pi harness analysis; community pattern: pi-agent-harness `.env` guard).
  Trigger: first real session where an agent bypasses the fence and corrupts
  a registry — until then convention + typed refusals suffice (trust-the-user).
- **Research-project `AGENTS.md`/`SYSTEM.md` snippet** — documented convention
  (not auto-written by `init`) declaring project framing for hosts that load
  hierarchical instruction files. Trigger: sessions where the model misses
  project framing despite the skill.

- **Europe PMC source** — trigger: sessions need PubMed/biomedical coverage.
  Patterns: OpenScience `databases/pubmed-database`, workspace `europepmc`
  skill; Unpaywall is forbidden (workspace rule) — OA via OpenAlex only.
- **`paper-figures` skill** — publication-grade figures. Trigger: figure
  sessions accumulate. Templates: evident-charts (rule structure) + OpenScience
  `core/figures`/`scientific-visualization` (LaTeX/vector specifics ours).
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
