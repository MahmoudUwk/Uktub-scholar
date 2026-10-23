# Fork provenance — TeXlyre app in `web/`

This directory is a fork of the TeXlyre editor app for Uktub Scholar's browser MVP.

- Upstream: https://github.com/TeXlyre/texlyre
- Base commit: `ccbe092` ("Updated texlyre-busytex and vulnerable dependencies", 2026-10-16)
- Upstream version: 0.13.3
- Licence: AGPL-3.0-or-later (see `LICENSE`; all upstream AGPL headers kept)
- Engine dependency: `texlyre-busytex` 1.4.1
  (upstream https://github.com/TeXlyre/texlyre-busytex, commit `61b83cd`;
  TeX/LaTeX WASM assets downloaded at build time from its pinned release,
  see `scripts/download-core-assets.cjs`)

Rule: Uktub changes are made on top of this tree and must stay diffable against
the base commit (`git diff` from a clean `git archive ccbe092` extraction, i.e.
this directory as copied). Do not rewrite history to hide the upstream base;
keep this file updated if the base commit changes.

Fork created: 2026-10-20. Owner decision: standalone package with its own lockfile
(not a pnpm workspace member of the repo root).

The per-phase change notes (Phases 2–9i, 2026-10-20 to 2026-10-22) are in git history: `git show c9972da:web/FORK.md`.

## What Uktub changed on top of the base (summary)

- **Engine and assets:** BusyTeX XeLaTeX (bibtex8) is the only engine; only the recommended TeX Live bundle ships, served
  from the app's own origin. SwiftLaTeX, the Typst compile path and remote TeX endpoints were removed.
- **Removed upstream features:** collaboration (peer sync, `y-websocket`, FilePizza), accounts and profiles, backups to
  disk/folder/Git forges, files-only export. Export is one "Uktub format" zip that includes each project's registry.
- **Project bridge:** `src/services/UktubProjectService.ts` keeps the editor's files and the Uktub worker's `/proj` in sync
  (fixed layout `manuscript/main.tex`, `manuscript/sections/`, `results/`, read-only `refs/references.bib`); files the
  worker creates are pulled into the view, never deleted.
- **Assistant:** `src/components/agent/AgentPanel.tsx` runs a pi-agent-core 1.4.0 agent with any API-key provider from
  pi-ai's catalog (nothing hardcoded), a one-call key test, keys in memory unless remembered, the six Uktub tools from the
  worker, file tools on the project, `compile` on BusyTeX, `write_section`, the always-on writing workflow and the
  pre-completion gate, Pi-parity retries, a stable session id per conversation and a per-reply token usage line.
- **Verification in the browser:** the `openrouter` engine only (the hosted verifier answers no browser preflight); the
  verification model is chosen from pi-ai's OpenRouter classifier models and persists like the model selection.

## Differences from Pi in `write_section` (`src/services/agent/agentWriteSection.ts`)

- The child system prompt is the shared composition (rules + workflow); Pi's child also gets Pi's coding-agent default
  prompt sections and the extension's `before_agent_start` rules.
- `disposeWriter` detaches the usage tally (pi-agent-core has no session dispose); `cost.total` comes from pi-ai's catalog.
- pi-agent-core has no auto-retry, so the child stream is wrapped in the same Pi retry loop as the parent; retries are
  reported in `details.child.retries`.
- The child gets its own session id derived from the parent's (`<parent>:ws<n>`).

## Tests

- Unit and component tests: `web/tests/` (Jest; `pnpm test` in `web/`), `tsc` in `web/`.
- End to end in Chromium: `web/e2e/` (`full-flow.mjs` with a real model, `agent-tools-9d.mjs`, `run-roundtrip-ui.mjs`;
  see `web/e2e/README.md`). Acceptance seams exist only in builds with `VITE_UKTUB_ACCEPTANCE_SEAMS=1`.
- Owner, 2026-10-23: the verification and section-writer redesign is tested on the local Node harness, not here; the
  browser is ported after it passes (`docs/handoff.md`).
