# Vision

**Uktub Scholar is free and open-source software (AGPL-3.0-only) that gives coding agents the scholarly tools a researcher
needs, inside the project folder the researcher already owns.** Find papers, register sources, keep a clean bibliography,
compile LaTeX, search the registered papers' text, and find the passages that support a claim, with exact pointers and
honest coverage. Five MCP tools, a Pi package and a CLI; the core is host-agnostic.

## Open source, all the way

- **Free software, no service.** No accounts, billing, quotas, telemetry or hosted backend, now or planned. Nothing runs
  anywhere but the researcher's machine (or a browser tab, for the planned static client). The only network traffic is to
  the scholarly providers and model providers the user chooses, with the user's own keys.
- **Open parts only.** Every component is a maintained open-source library or an open-weights model with a checked licence,
  pinned by revision and sha256, and attributed in [NOTICE.md](../NOTICE.md). No model or service is a hidden dependency.
- **Inspectable evidence.** Every adoption or rejection is a dated decision ([DECISIONS](DECISIONS.md)) backed by a
  measurement in this repository ([docs/benchmarks](benchmarks/)). A score is evidence about one dataset, not a guarantee.
- **Lawful sources only.** Open-access copies that provider records name, with every transport guard; no paywall
  circumvention, no scraping of landing pages.

## Who it is for

Researchers who live in a terminal: they run LaTeX toolchains, git and backups themselves. The package is a careful
librarian inside their workflow, not a platform around it. A non-technical audience is served later by a separate thin
client above this package (a static, bring-your-own-key web app is the researched direction, [BACKLOG §5](BACKLOG.md)),
never by enforcement inside it.

## Principles

1. **Trust the technical user.** Conventions over enforcement. The package owns two artifacts, the registry and the
   rendered bibliography; everything else stays theirs.
2. **The project folder is the whole world.** One `.registry/` per tree, sessions belong to the host, no global index, no
   cloud. Delete the folder and the project is gone; copy it and it moves.
3. **Standard machinery only.** SQLite, BibTeX, the Model Context Protocol, Tectonic. What a maintained library does
   better, we do not rebuild.
4. **Honest refusal beats silent improvisation.** The agent cites only what it registered. Missing coverage is reported,
   never papered over, and "no support found" is never reported as "false".

## Where it is going

Today: search, registry, compile, claim support, passage search, acquisition of open-access sources, a live test harness
and a Docker sandbox. Next, each step gated on evidence from real sessions: a traceable multi-section writing workflow
([plan](plans/2026-10-07-document-writing-workflow-plan.md)), better host adapters, and further skills for the Uktub agent (slide
and Word, Excel and PDF editing, scientific figures, manuscript review, grant proposals), each adopted on evidence from the
skill libraries recorded in [BACKLOG §7](BACKLOG.md).

## Non-goals

Accounts and billing; a hosted service; a UI inside the package; verdicts that a claim is false; exporting full paper
text through the tools; OCR (scanned documents are refused); thesis-scale orchestration (`compile_document` builds and
reports diagnostics).
