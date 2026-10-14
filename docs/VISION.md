# Vision

**Uktub Scholar is free and open-source software (AGPL-3.0-only) for researchers who need scholarly tools without a hosted
Uktub service. The top product priority is an easy static web app for nontechnical researchers: all Uktub logic and project
data stay in the browser.** Researchers may host the static site. Direct scholarly and model-provider requests use the
researcher's own credentials; provider calls may receive the query or selected text excerpts needed for that request. The
current product is still the Node CLI, MCP server and Pi package; a browser runtime is not implemented. See
[handoff](handoff.md) for the decisions, the boundary and the open work.

The tools find papers, register sources, keep a clean bibliography, compile LaTeX, search registered papers' text, and find
passages that support a claim, with exact pointers and honest coverage. The core must not depend on Pi.

## Open source, all the way

- **Free software, no hosted Uktub service.** No accounts, billing, quotas or telemetry. The planned browser app has no
  Uktub backend or local helper; the existing CLI/MCP/Pi package runs on the researcher's machine. Provider calls use
  researcher-owned credentials and may send the request query or selected excerpts to that provider.
- **Open parts only.** Every component is a maintained open-source library or an open-weights model with a checked licence,
  pinned by revision and sha256, and attributed in [NOTICE.md](../NOTICE.md). No model or service is a hidden dependency.
- **Inspectable evidence.** Every adoption or rejection is a dated decision ([handoff](handoff.md)) backed by a
  measurement in this repository ([docs/benchmarks](benchmarks/), raw data). A score is evidence about one dataset, not a guarantee.
- **Lawful sources only.** Open-access copies that provider records name, with every transport guard; no paywall
  circumvention, no scraping of landing pages.

## Who it is for

Researchers using either a terminal or a browser. The existing CLI/MCP/Pi tools serve technical users who manage their
own project folders and toolchains. The browser app is the priority for nontechnical researchers; its browser equivalents
and feasibility remain open work in the [handoff](handoff.md).

## Principles

1. **Trust the technical user.** Conventions over enforcement. The package owns two artifacts, the registry and the
   rendered bibliography; everything else stays theirs.
2. **Project data stays with the project.** In the current Node product, one `.registry/` belongs to a project tree, sessions
   belong to the host, and there is no global index or cloud store. The planned browser app must provide an equivalent
   researcher-owned persistence boundary within the browser; its storage and export behavior remain open work.
3. **Standard machinery only.** SQLite, BibTeX, the Model Context Protocol, Tectonic. What a maintained library does
   better, we do not rebuild.
4. **Honest refusal beats silent improvisation.** The agent cites only what it registered. Missing coverage is reported,
   never papered over, and "no support found" is never reported as "false".

## Where it is going

Today: the Node tools provide search, registry, compile, claim support, passage search, acquisition of open-access sources,
a live test harness and a Docker sandbox. Next, establish browser feasibility and build the static client, then continue
evidence-gated work such as a traceable multi-section writing workflow
([handoff](handoff.md), candidate D4 and appendix F), better host adapters, and further skills for the Uktub agent (slide
and Word, Excel and PDF editing, scientific figures, manuscript review, grant proposals), each adopted on evidence from the
skill libraries recorded in the [handoff](handoff.md) (appendix F).

## Non-goals

Accounts and billing; a Uktub backend or local helper; verdicts that a claim is false; exporting full paper
text through the tools; OCR (scanned documents are refused); thesis-scale orchestration (the current compile tool builds
and reports diagnostics).
