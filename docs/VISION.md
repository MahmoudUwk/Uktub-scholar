# Vision

**Uktub Scholar** is a local-first scholarly research package for coding
agents (unified Stdio MCP server, Pi package, and CLI): find papers, register sources, keep a clean bibliography,
write citation-grounded LaTeX — and find supporting passages for a claim, with
exact pointers and honest coverage, using a configurable decision engine —
inside the project folder the
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
   Model Context Protocol (`@modelcontextprotocol/sdk`), and Tectonic LaTeX. Anything a maintained library does
   better, we don't rebuild.
4. **Honest refusal beats silent improvisation.** The agent cites only
   what it registered; missing coverage is reported, never papered over.

## Non-goals (v0)

Drafting/writing tools, manuscript-wide review, and OCR. The package returns supporting
evidence for ONE claim at a time (never a verdict that a claim is false) and keeps full
paper text internal. Source acquisition uses lawful open-access copies named by provider records (OpenAlex, arXiv, Semantic Scholar) with every transport guard; scanned documents are
refused. `compile_document` covers build-and-diagnostics only; thesis-scale orchestration
stays with the user.
Accounts and a UI are out. Model Context Protocol (MCP) provides universal multi-host integration across Claude Code, Pi, Cursor, Codex, OpenCode, and Antigravity.
