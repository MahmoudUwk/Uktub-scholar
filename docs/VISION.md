# Vision

**Uktub Scholar** is a local-first scholarly research package for coding
agents (Pi first): find papers, register sources, keep a clean bibliography,
write citation-grounded LaTeX — inside the project folder the researcher
already owns.

## Who it is for

Researchers who live in a terminal: they run LaTeX toolchains, git, and
backups themselves. The package is a careful librarian inside their
workflow, not a managed platform around it.

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

PDF acquisition, citation-checking, compilation, model gateways, accounts,
and any UI. Host integrations for Claude Code / Codex are future adapters;
the core stays host-agnostic.
