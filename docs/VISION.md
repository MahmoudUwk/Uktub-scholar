# Vision

**Uktub Scholar is free and open-source software (AGPL-3.0-only) for researchers who need scholarly tools without a hosted
Uktub service. The top product priority is an easy static web app for nontechnical researchers: all Uktub logic and project
data stay in the browser.** Researchers may host the static site. Direct scholarly and model-provider requests use the
researcher's own credentials; provider calls may receive the query or selected text excerpts needed for that request. The
released product is the Node CLI, MCP server and Pi package; the browser app is an unreleased MVP in `web/` (an
Overleaf-like workspace forked from TeXlyre, owner decision 2026-10-20). See [handoff](handoff.md) for the decisions, the
boundary and the open work.

The tools find papers, register sources, keep a clean bibliography, compile LaTeX, search registered papers' text, and find
passages that support a claim, with exact pointers and honest coverage. The core must not depend on Pi.

## Open source, all the way

- **Free software, no hosted Uktub service.** No accounts, billing, quotas or telemetry. The browser app has no
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
own project folders and toolchains. The browser app is the priority for nontechnical researchers; it runs the same core in a
Web Worker and the same agent rules as the Pi package; what remains before release is in the [handoff](handoff.md).

## Principles

1. **Trust the technical user.** Conventions over enforcement. The package owns two artifacts, the registry and the
   rendered bibliography; everything else stays theirs.
2. **Project data stays with the project.** In the current Node product, one `.registry/` belongs to a project tree, sessions
   belong to the host, and there is no global index or cloud store. The browser app keeps one equivalent boundary
   per project in the browser's private storage (OPFS), with export/import as a zip that includes the registry.
3. **Standard machinery only.** SQLite, BibTeX, the Model Context Protocol, Tectonic (BusyTeX XeLaTeX in the browser). What a maintained library does
   better, we do not rebuild.
4. **Honest refusal beats silent improvisation.** The agent cites only what it registered. Missing coverage is reported,
   never papered over, and "no support found" is never reported as "false".

## Where it is going

Today: the Node tools provide search, registry, compile, claim support (hosted d3-mini by default, a free key away;
local Eos selectable), passage search, document-as-written verification, a setup `doctor`, acquisition of open-access
sources, a live test harness and a Docker sandbox. Direction (2026-10-15): the agent is a general scientific research
assistant that plans and does what the user asks (literature, writing, analysis, code for simulations and experiments), with
honesty enforced by tools (verification of the text as written, provenance, audits of cited and computed figures) and a short
prompt rather than long rules. The browser MVP exists (`web/`). Direction (owner, 2026-10-23): verification judges whole
paper sections with all of a paper's claims in one request, and runs automatically only after a section is written; section
writers are agents that read the full text of at most 20 parent-assigned papers through a code-scoped registry and mark
each claim with its sources; the parent writes abstract, introduction and conclusion last from the written sections. No
summaries or paper cards ([handoff](handoff.md) §1). Then continue evidence-gated work, better host adapters, and further skills for the Uktub agent (slide
and Word, Excel and PDF editing, scientific figures, manuscript review, grant proposals), each adopted on evidence from the
skill libraries recorded in handoff V1 (commit 331bb7b, appendix F).

## Non-goals

Accounts and billing; a Uktub backend or local helper; verdicts that a claim is false; exporting full paper
text through the tools; OCR (scanned documents are refused); thesis-scale orchestration (the current compile tool builds
and reports diagnostics).
