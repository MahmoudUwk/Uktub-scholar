# Vision

**Uktub Scholar** is a local-first scholarly research package for coding
agents (Pi first): find papers, register sources, keep a clean bibliography,
write citation-grounded LaTeX — and verify claims against the sources that
support them with a local decision model — inside the project folder the
researcher already owns. The long arc is broader than literature work:
support all kinds of research output — data analysis, figures, grant
proposals — one adopted capability at a time, each earning its place with
real sessions.

## Who it is for

Researchers who live in a terminal: they run LaTeX toolchains, git, and
backups themselves. The package is a careful librarian inside their
workflow, not a managed platform around it.

## How capabilities arrive

The scope is all kinds of research output; adoption is evidence-gated and
attributed. Two standing sources: the OpenScience skill library
(synthetic-sciences, MIT skills — literature-review loops, claim-source
audits, grant proposals, figures, peer review) ported piecemeal with NOTICE
attribution, and companion skills the user installs host-side for fast-moving
third-party capabilities (evident-charts for charts, GenOffice for
.docx/.pptx deliverables). The future UI for non-technical users is a
dedicated thin workbench above this package — never an adopted office suite.

## Principles

1. **Trust the technical user.** Conventions over enforcement. We own
   exactly two artifacts — the registry and the bibliography file — and
   everything else stays theirs. A future UI may enforce more for
   non-technical users; that layer sits above this package and never
   leaks back into it.
2. **The project folder is the whole world.** One `.registry/` marker per
   tree, sessions belong to Pi (cwd-keyed), no global index, no cloud.
   Delete the folder and the project is gone; copy it and it moves.
3. **Standard machinery only.** SQLite (`node:sqlite`), BibTeX rendering,
   Pi's package/skill/extension APIs. Anything a maintained library does
   better, we don't rebuild.
4. **Honest refusal beats silent improvisation.** The agent cites only
   what it registered; missing coverage is reported, never papered over.

## Non-goals (v0)

PDF acquisition, citation-checking, and drafting/writing tools.
`compile_document` covers build-and-diagnostics only; thesis-scale
orchestration stays with the user. Model gateways, accounts, and any UI are
out. Host integrations for Claude Code / Codex are future adapters; the core
stays host-agnostic.
