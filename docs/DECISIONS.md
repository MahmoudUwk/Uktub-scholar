# Decision log

Verdicts on design proposals, newest first. A falsified proposal is never
re-proposed without new evidence (RRSI discipline: the edit history exists so
dead hypotheses are not redrawn). Entries record the verdict, the reason, and
the evidence that would reopen the question.

## 2026-10-02

- **Registry guard + project-conventions snippet — SHIPPED (owner-authorized,
  pulled ahead of the backlog triggers).** `pi.on("tool_call")` guard makes
  `.registry/**` package-owned (no agent tool, read or write) and `refs/**`
  agent-read-only against the host's own tools; pure classification in
  `src/core/guard.ts`, honest bash-scan limits documented. Optional
  `AGENTS.md`/`SYSTEM.md` snippet documented in README (never auto-written
  by `init`). Verified: 124 offline specs + live sandbox (blocked
  `sqlite3 .registry/...` verbatim; benign bash passed).
- **open-slide (MIT, Vercel OSS) — deferred to backlog as the slides
  runtime.** Agent-native React deck framework (fixed 1920×1080 canvas,
  present mode, ships its own authoring skills). Not bundled: no slide
  sessions yet, and a generated deck is its own project, not package
  surface. Trigger + pattern recorded in `docs/BACKLOG.md`; content-guidance
  template when triggered: OpenScience `writing/scientific-slides`.
- **Backlog consolidated** — all deferred capabilities now live in
  `docs/BACKLOG.md` with trigger conditions (companions: open-slide,
  GenOffice, evident-charts; package capabilities: Europe PMC,
  paper-figures, grants, host adapters; owner-gated: PDF acquisition,
  evidence retrieval, UI workbench; long arc: RRSI-style evolution).

- **First skill folds — ADOPTED (owner-authorized).** `uktub-research` gains
  "Running a review" (mode agreement, bounded loop, dedup, load-bearing
  reading, provenance marking) and the claim-source rule, adapted from
  OpenScience `core/literature-review` + `core/sources` (ideas, not text;
  NOTICE updated). This opens the evidence gate by owner instruction; future
  folds still wait on real sessions.
- **GenOffice (genspark-ai, Apache-2.0) — NOT our UI; recommended companion
  for office-format deliverables.** It is an AI office-document suite
  (.docx/.xlsx/.pptx/PDF editors with an agent panel + CLI/skill/MCP), not a
  research workbench — no registry/bibliography/project concept, so adopting
  it as the package UI would be the wrong shape. Our future UI stays the
  dedicated thin workbench (VISION). When grant/collaboration sessions need
  .docx/.pptx deliverables for co-authors, recommend GenOffice host-side
  (same pattern as evident-charts). Reopen as embedded UI only if it gains a
  project/workspace concept.
- **OpenScience (synthetic-sciences, Apache-2.0 repo / MIT skills) — THE
  adoption library for the widened scope.** ~400 skills by domain; ours to
  port piecemeal with NOTICE attribution as capabilities earn their place:
  - Fits current surface (candidate skill folds, awaiting the real-session
    evidence gate): `core/literature-review` (fixed-budget retrieval loop,
    dedup, load-bearing-paper reading, PRISMA escalation),
    `core/sources` (claim→source audit, provenance table),
    `core/citations` (fabricated/mismatched .bib audits — mostly covered by
    register + sync-bib).
  - Roadmap templates: `research/research-grants` (NSF/NIH/DOE/DARPA
    proposals — the grant direction), `core/figures` + `scientific-visualization`
    (paper-figures skill, alongside evident-charts), `core/peer-review`,
    `core/paper-writing`, `writing/latex-posters`, `writing/scientific-slides`,
    `research/statistical-power`, `research/experimental-design`.
  - Later (connector patterns): `databases/*` for the Europe PMC era.
  - Never: cloud-compute, ml-training/inference, llm-tools, quantum,
    biology/chemistry domains — specialist capability, not harness.
- **Scope: all research kinds — ADOPTED as direction.** The package is not a
  literature-review tool; figures, data analysis, and grant-proposal support
  are in-arc, adopted one capability at a time as real sessions demand them.
- **evident-charts (rhiever, MIT) — RECOMMENDED COMPANION, not bundled.** One
  week old and evolving fast; vendoring would freeze it and bloat the
  package. Users install it host-side (`npx skills add rhiever/evident-charts`)
  when they need charts. Reopen vendoring (or write our own
  `paper-figures` skill) when figure sessions accumulate — its rule
  structure (code-checkable first, vision review where code can't) is the
  template.

- **Sandbox-by-default for agent sessions — REJECTED.** Opt-in stays. Evidence:
  Gemini CLI, Aider, and Pi all default sandbox off; default-on frameworks
  (Codex, OpenHands) pair it with approval ladders that belong to the host
  (Pi), not to a package. Reopen only if a real session shows unisolated
  agents harming users at scale.
- **Parallel/persistent wrapper session store — REJECTED as a *new* store;
  KEPT as a bind of Pi's store.** Pi owns sessions (cwd-keyed); the sandbox
  mounts a host directory for Pi's own store so transcripts survive container
  exits. Dropping it would destroy researcher transcripts — more restriction,
  not less. Reopen only if Pi changes its session model.
- **Global project index — REJECTED.** Filesystem scan is the maintained
  pattern (DVC up-scan, Quarto marker); global-DB registries couple projects
  (Zotero's lesson). Nested projects are refused by `init`.
- **Two-way references.bib sync — REJECTED, permanently.** A .bib carries no
  merge semantics; the registry is the source of truth, `sync-bib` renders
  one-way (Better BibTeX maintainer's argument applies verbatim). Reopen only
  if a maintained standard adds merge metadata to BibTeX.
- **Bundling a LaTeX engine — REJECTED.** The engine is the user's (PATH or
  `UKTUB_TECTONIC_BIN`); the package owns detection, invocation, outdir, and
  diagnostics. The sandbox image pins Tectonic 0.15.0 for zero-install
  sandbox use. Reopen only if optionalDependencies distribution proves
  painless and users ask for it.
- **Trust model — ADOPTED.** The CLI/TUI user is technical and trusted;
  conventions over enforcement; a future UI layer may enforce more for
  non-technical users, above the package, never inside it.
