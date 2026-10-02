# uktub-scholar

Local-first scholarly research tools for coding agents: paper search, a citation
registry, and a rendered `references.bib`. Ships as a Pi 1.0 package; the core is
host-agnostic so later hosts (MCP servers for Claude Code / Codex) attach around the
same core.

## Install

Pi package (working name `uktub-scholar`; the final npm name is still open):

```
pi install npm:uktub-scholar
```

The extension registers exactly four tools: `search_papers`, `register_papers`,
`list_papers`, `compile_document`. It fails closed at load if the Pi 1.0 API surface is missing.

CLI (development install — the package is currently `private`):

```
pnpm install
pnpm exec uktub-scholar --help   # bin shim runs the TypeScript CLI directly (adds
                      # --experimental-strip-types on Node 22.x)
```

CLI commands: `init` (create the registry and an empty `refs/references.bib`),
`deregister <doi|citekey>...`, `sync-bib` (re-render the bibliography), `list`,
`compile [entry.tex]` (Tectonic build; PDF in `build/`).

## Requirements

- Node >= 22.19 (`engines` floor; Pi 1.0 floor). `node:sqlite` verified loading
  without flags on Node 22.21.1, 22.23.0, and 26.3.1; an ExperimentalWarning on
  22.x is expected.
- Pi >= 1.0.0 (`@earendil-works/pi-coding-agent`), which exposes `pi.registerTool`.
- `compile_document` / `uktub-scholar compile` need a local
  [Tectonic](https://tectonic-typesetting.github.io) >= 0.15.0 — on `PATH` or at
  `UKTUB_TECTONIC_BIN`. The engine is never downloaded or bundled; without it
  the compile tools refuse (`COMPILE_ENGINE_MISSING`) and everything else works.

## Tools and limits
| Tool | Limits | Source |
|---|---|---|
| `search_papers(query, limit?)` | `limit` default 5, clamped to max 20 | Feynman-incident-derived tool cap (labelled, R19) |
| `register_papers(dois[])` | at most 50 DOIs per call; the whole call refuses `BATCH_TOO_LARGE` above the cap | client policy, Feynman-incident-informed (labelled, R19) |
| `list_papers(limit?)` | cap 200; `truncated` + `remaining` returned at the cap | client policy (labelled, R19) |
| `compile_document(entry?)` | 120 s engine budget (`UKTUB_COMPILE_TIMEOUT_S` overrides, seconds, min 5); diagnostics capped at 50 | client policy (labelled) |

Search merges OpenAlex, Crossref, and Semantic Scholar (DataCite serves arXiv DOIs
at registration) in RRF relevance order; a per-provider failure degrades the result
into warnings — only when every provider fails does the call refuse
(`SEARCH_UNAVAILABLE`).

Optional environment keys, read live at call time, never required:

- `OPENALEX_API_KEY` — OpenAlex `api_key` parameter
- `SEMANTIC_SCHOLAR_API_KEY` — Semantic Scholar `x-api-key` header (anonymous callers are
  rate-limited hard)
- `CROSSREF_MAILTO` — Crossref polite-pool contact

## Registry and bibliography

- The registry is a single SQLite file at `.registry/registry.db` beside the LaTeX
  project, created by `uktub-scholar init`.
- `refs/references.bib` is **derived state**: rendered only by the registry,
  re-rendered inside every registry write, agent-write-protected. Hand edits are
  overwritten by the next registry write; `uktub-scholar sync-bib` restores it
  idempotently after any divergence.
- Citekeys are pinned once at first registration (first-author family + year +
  first significant title word, base-26 suffix on collision) and never recomputed.
- Only provider-supplied BibTeX makes a paper citable. A paper without it
  registers with `citable: false` and a `BIBTEX_UNAVAILABLE` warning, and stays
  out of `references.bib`; a later citable re-register upgrades it in place
  without moving the citekey.

## Refusals and warnings

Every tool failure is a typed refusal rendered as
`Refused: CODE — <message>. Next: <next>.`; warnings attach to successful
outcomes instead. Codes: `REGISTRY_NOT_INITIALIZED`, `REGISTRY_CORRUPT`,
`REGISTRY_SCHEMA_UNSUPPORTED`, `REGISTRY_BUSY`, `INVALID_DOI`, `DOI_NOT_FOUND`,
`QUERY_REQUIRED`, `PATH_REFUSED`, `SEARCH_UNAVAILABLE`, `BATCH_TOO_LARGE`,
`PI_EXTENSION_API_UNAVAILABLE`. Warnings: `BIBTEX_UNAVAILABLE`,
`DOI_TITLE_MISMATCH`. Paths are confined to the project root; `.registry` and
`.git` are protected segments.

## Verification

```
pnpm typecheck
pnpm test
```

Tests are fully offline: provider fakes are the only search path. Evidence tiers
(fake-driven specs, real-Pi smoke, live API) are never mixed in one run.

## Interactive sandbox

`scripts/test-sandbox.sh` — disposable Docker Pi TUI with the live package
mounted, ADC mounted read-only. Project data (registry, bibliography) and Pi
session transcripts persist on the host next to the repo (`../uktub-sandbox/`)
for direct inspection; `--fresh` wipes both. The TUI also shows a registry
panel (below the editor) that refreshes after every tool call.

## Design principles

Trust the technical user — conventions over enforcement; the package owns only
`.registry/` and `refs/references.bib`, the user owns everything else (git,
layout, toolchains). The project folder is the whole world: no global index,
no parallel session store (Pi owns sessions), nested projects are refused.
`references.bib` is canonical; the SQLite registry is a derived agent-side
cache with one-way sync. Sandboxing is opt-in; a future UI layer may enforce
more for non-technical users, above the package, never inside it. See
`docs/VISION.md` and `AGENTS.md`.

## Companion skills

Chart/figure work (papers, grant proposals): we recommend installing
[evident-charts](https://github.com/rhiever/evident-charts) (MIT) alongside
this package — it teaches the agent clear, honest chart-making with
rendered-image review, and installs host-side in one command
(`npx skills add rhiever/evident-charts` for Agent-Skills agents). We do not
bundle it: the skill evolves upstream and belongs to the host, not the
package. A LaTeX/PGF-flavoured `paper-figures` skill of our own is on the
roadmap once figure workflows justify it.

## Next steps

Active direction lives in `docs/BACKLOG.md` — every deferred capability
(slides via open-slide, GenOffice deliverables, Europe PMC, paper-figures,
grant support, host adapters, the UI workbench) is recorded there with the
trigger that reopens it. Near-term: Europe PMC source, host adapters,
`paper-figures` skill.

## Attribution

Borrowed-code provenance is recorded per file in `NOTICE.md`. Licence:
AGPL-3.0-only;
Apache-2.0 attribution obligations are tracked there as well.

## Out of scope (v0)

No PDF acquisition, no evidence retrieval, no drafting/writing tools — the
package is tailored tools, not workflows. `compile_document` covers
build-and-diagnostics only; thesis-scale orchestration stays with the user.
