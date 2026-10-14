# Changelog

All notable changes to `uktub-scholar`, in [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) form, versioned with
[Semantic Versioning](https://semver.org/). Rationale, measurements and open
work are in [docs/handoff.md](docs/handoff.md).

## [Unreleased]

### Added
- **Hosted verify engine** (`verification.engine: hosted`): `vllm-sr/d3-mini` on `https://decision.vllm-sr.ai` with a free key from [decision.vllm-sr.ai](https://decision.vllm-sr.ai/) (`UKTUB_VERIFY_API_KEY`); without a key it refuses with that link and never switches engine. Local Eos stays the default. On claim-verification-v2: 93 % recall at about 1 % false supports (Eos 49 %); at the 0.99 bar 198/269 true and 0/278 false supported (`docs/benchmarks/claims-v2-d3-mini-api-2026-10-14.*`). The System One engine also accepts `UKTUB_VERIFY_API_KEY`/`UKTUB_VERIFY_MODEL` (key sent only to the configured HTTPS origin).
- **Durable verify evidence** (registry schema v6, `claim_ledger`): released evidence with its verbatim claim text survives the 24 h continuation sweep; it is deleted only with its paper or source revision. v5 registries migrate (table starts empty). Provenance reads `verified` only from the ledger.
- **`provenance --json`** adds `document_digest` and `units` (every extracted unit with id, kind, location, text, cites, status, pointers).
- **Measurement harness** (`scripts/live/`): scripted user (`--user scripted`, default) with scenario v2 files (`## Request/Revision/Nudge`); model settings (`--assistant-model`, `--verify-engine eos|hosted`, `--pilot`); run validity (VALID/BLOCKED/INVALID) and a whole-working-tree hash in the manifest; five-check Tier 1 evaluator computed from the provenance JSON (replaces the 13 regex checks); blind grading pipeline (`pnpm grade`, frozen source corpus, rubric v1); analysis/simulation (`analysis.ts`); root-cause trace (`trace-causes.ts`); post-composition replay (`replay-post-compose.ts`). Scenario `rf-llm-review-v2`.

### Removed
- The agent-authored `evidence/claims.json` deliverable and its checks (`evidence-table-present/valid`), `sourced-numerics` and the evaluator's regex document model.
- **Provenance view** (`src/core/provenance/`, [handoff](docs/handoff.md)): a deterministic, read-only audit of a manuscript against the registry, no model: per statement, table row and caption whether `verify` supported that exact wording (from the package's own ledger), only cites a registered paper, or cites nothing; per figure whether the cited paper's text contains it (`OPEN`, `CHECK`); the reader-visible word count. Surfaces: the `compile` result (`provenance` summary, additive, `UKTUB_PROVENANCE=off` removes it) and `uktub-scholar provenance [entry.tex] [--json]`.
- **Visibility A/B harness** (`pnpm experiment <scenario> --arm A|B1|B2`, [design and results](docs/handoff.md), section 12): the simulated user gets an exact, stated observation channel (A: as before; B: the whole manuscript, the evidence table, an activity digest of the assistant's reply, the provenance view), a detailed spec (`experiments/simulator-v2.md`, used only with `--arm`) and an auditable `<review>` block per turn. Pure parts in `scripts/live/sim-view.ts`.
- **Agent rule for figures** (`src/core/agent-rules.ts`): a number, size, speed or hardware limit is a reported result only if a registered paper the agent read
  states it and it cites that paper; its own inference is labelled an estimate or omitted ([handoff](docs/handoff.md)). Not shown to work: iteration 7 still invented a hardware column.
- **Browser core seams (`src/browser/`, `tests-browser/`, `tests-browser-net/`; not part of the published package):** shims that let the unchanged,
  synchronous core run in one dedicated worker, each proven by differential tests that run the same scenario against the real Node module and in
  Chromium (`pnpm test:browser`, `pnpm typecheck:browser`): `node:sqlite` over official SQLite WASM on `opfs-sahpool`, `node:fs`/`node:os` over a
  SQLite-backed project store, `crypto` (`createHash`), `zlib`, `path`, `url`, `Buffer` and `process`, a `navigator.locks` project lock, a Node-global audit
  of the tool import graph, and a page-side `DownloadLike` with a provider-request audit. Dev dependencies added: `esbuild`, `playwright-core`,
  `@sqlite.org/sqlite-wasm`, `@noble/hashes`. No core file changed. A worker host (`src/browser/host.ts`: init, tool call, project export, close) runs the
  five real tools in Chromium over bundled core assets (`schema.sql` and the engine locks); 11 scenarios (register, read, TEI and PDF attach, bibliography sync,
  lexical passages, canned search, path escape, compile refusal, export list) give results identical to Node, and verify/compile refuse with their typed codes
  because no engine is wired yet. `unpdf` runs unstubbed in the worker: text, page starts, section marks, section chunks and refusal codes match Node exactly
  on 24 real PDFs plus synthetic and refused inputs (`tests-browser/pdf.spec.ts`); a PDF attaches through the registry tool and `passages` finds it, and `acquire` of an arXiv DOI (DataCite registration, canned arXiv PDF download) matches Node end to end.
- **Two evaluator checks** for scenarios that declare an evidence table: `length-within-request` (body words against the range the prompt states) and
  `sourced-numerics` (every figure, unit or hardware name in a cited sentence or table row occurs in text the agent actually saw); critical and conditional;
  `scripts/live/replay-checks.ts` recomputes them read-only on a recorded run. Runs recorded with the older 11-check set are refused as historical.
- **`scripts/provider-access-probe/`**: a static, dependency-free page that probes direct model-provider access with the researcher's
  own credentials (OpenRouter PKCE or a pasted key; models and free/paid classification, streaming, a tool round trip, cancellation,
  truthful 401/402/429 handling, never switching model); 27 tests against a local mock, which prove client logic only. No keyed
  provider call has been made ([handoff](docs/handoff.md), section 7).
- **October 13 closeout work (not yet accepted):** short MCP names and installer migration, arXiv acquisition recovery, and a
  multi-section workflow scenario with an evaluator. The checkpoint's harness defects and review findings are fixed (see Fixed); the
  complete workflow is not accepted: iteration 4 passed all 13 checks and an independent fact-check found no wrong or misattributed
  figure, but iterations 6 and 7 each failed two checks (invented hardware and figures in a table, a note over the requested length), so no pair has passed. See [handoff](docs/handoff.md) for evidence and limits.
- **Live test harness** ([handoff](docs/handoff.md), section 8 and appendix E): Docker-isolated acceptance of every tool and action against real
  providers and engines, directly over stdio MCP (`pnpm live:direct`) and through a real Pi session on
  `google-vertex/gemini-3.8-flash` (`pnpm live:agent`, one labelled rerun on `gemini-3.5-flash-lite` after an HTTP 429); a
  boundary probe (`pnpm live:probe`); user-simulation experiments (`pnpm experiment`); a self-improving loop with held-out and
  out-of-domain scenarios (`pnpm evolve`). Verdicts are PASS / FAIL / BLOCKED / NOT_RUN with evidence and a manifest per run;
  provider keys are forwarded by name from the shell or a gitignored `.env`.
- **`pnpm sandbox`**: a fresh Pi in Docker, preconfigured with this package, Vertex AI (read-only ADC), the Eos engine and
  provider keys; the host's own Pi is untouched; state lives in `.sandbox/`.
- **Source acquisition**: `paper_registry acquire` with a typed status per paper (`metadata_only | acquiring | ready |
  unavailable | failed`) and background acquisition after registration (`UKTUB_ACQUIRE_ON_REGISTER=0` disables it). Routes: OpenAlex
  `pdf_url` and `oa_url`, arXiv, PubMed Central through Europe PMC, Semantic Scholar `openAccessPdf` and its arXiv preprint, the
  OpenAlex Content API with a key. Guards unchanged; evidence taken from a preprint is disclosed.
- **MCP host contract**: a title and all four annotation hints per tool (from a side-effect audit), progress heartbeats every
  15 s so long calls survive host timeouts, `UKTUB_MCP_TRACE=1` to log the negotiated protocol revision.
- **Agent guard rails**: rules delivered in the MCP handshake and the Pi system prompt; the Pi extension blocks agent
  `edit`/`write` on `refs/references.bib` and `.registry/`, confirms destructive shell commands, and appends a "Tool notices"
  footer with refusals and warnings the final answer left out.
- **Engines and tools without a toolchain**: `eos-onnx` (`uktub-scholar eos status | install --yes [--gpu]`, no PyTorch) and
  `uktub-scholar tectonic status | install --yes` (pinned 0.17.0). Experimental `vela` engine (Vela 2.0 0.3B and 0.8B),
  benchmarked and not adopted.

- **Product skills** ([README](README.md#skills-for-the-agent)): `uktub-figures` (page-width vector plots from the user's data with a style helper, an audit and a record of the plotted
  numbers), `uktub-diagrams` (TikZ system diagrams), `uktub-review`, `uktub-slides` (Beamer from a paper, or an editable PowerPoint `.pptx` through pandoc, read back with a stdlib script), `uktub-office` (LaTeX to `.docx`; a reader for a co-author's
  tracked changes and comments) and `uktub-grants` (Specific Aims). Each was adopted test first against a real model (`pnpm live:skills`); the evidence is in
  `docs/benchmarks/skills`. The `.pptx` route is built and proven.
- **`uktub-scholar review [entry.tex]`**: the four deterministic scientific-slop measures (cross-section references, macro redundancy, citation isolation, evidence gap),
  reimplemented from arXiv 2610.00531, with a full report of file:line evidence in `reviews/<date>-slop.md`. On the paper's own benchmark they rank papers like the published
  scores (Spearman 0.92 to 0.96; raw result `docs/benchmarks/review-parity-2026-10-09.results.json`).

### Changed
- The coding-agent skills in `.agents/skills/` carry `metadata.internal: true`, so `npx skills add` does not offer them to users.
- `compile_document` lists errors before warnings (a real 23-page paper printed 49 warnings above its one error) and explains EPS figures, which Tectonic cannot include.
- **One repository root**: skills (`.agents/skills/`), benchmark PDFs (`test_papers/`) and sandbox state (`.sandbox/`, both
  gitignored) now live here; one `AGENTS.md`, `docs/VISION.md` and one handoff (decisions, backlog, testing, plans and reviews were folded into the handoff on 2026-10-14).
- **Embedding model**: EmbeddingGemma 2 Q4_K_XL (176 MB, Apache-2.0) on llama.cpp `b11476`, replacing EmbeddingGemma 300M Q8_0
  on `b11398`: half the download, same speed, about 4–5 points lower hybrid recall (accepted by the owner). Run
  `uktub-scholar embed install --yes` again.
- Pi pin 1.0.0 to 1.1.0. `refs/references.bib` is written read-only (mode 0444). Compile diagnostics name included files by
  project-relative path.

### Fixed
- **Evidence-table association ignored the TeX tie** (test first): `layer~\cite{k}.` normalized to `layer~.` and never matched the plain claim `layer.`,
  so all 12 verified rows of iteration 6 failed `evidence-table-valid` on a manuscript that contained every claim. A tie in the manuscript is now whitespace.
- **Live-harness defects from the October 13 checkpoint and code review** (test first; evidence summarized in the handoff): the install case
  reads the installer's `uktub` key; run provenance hashes the complete `git diff HEAD` (a 1.4 MB dirty diff was lost to `ENOBUFS`),
  recording a failed capture as an explicit failure instead of an empty string; `no-unrequested-removal` is a non-compensatory check and
  the evidence-table checks are critical wherever a scenario declares them; `metrics.json` is bound to its run manifest by digest and by
  scenario and iteration; model profiles are compared exactly (no substring match) and fallback turns must be labelled; a compile with no
  readable PDF never yields a trusted snapshot; a registry row without `citable: true` fails the citation check. The evidence-table check
  no longer fails a sentence because `\cite{}` leaves a space before its period, no longer cuts a claim at a `%` (which also passed
  claims vacuously), folds TeX escapes such as `\%`, and reports the total number of failing rows. Replaying the preserved iteration 1
  through the fixed check associates all 13 verified rows; no live iteration has been rerun since, and the recorded iteration stays a FAIL.
- From a live skill-acceptance run: the slides skill says a figure converted for the deck (EPS or PDF to PNG) is written into
  `manuscript/slides/`, the only part of the manuscript a deck writes (a deck wrote one into the manuscript folder); the
  invented-number check reads the paper folder's text files (`.txt`, `.md`, `.csv` beside `.tex`/`.bib`), not `.tex` only
  ([handoff](docs/handoff.md)).
- The published package no longer ships Python bytecode (`__pycache__`) from the skills' helper scripts; a test lists what `npm pack` would ship.
- The Pi package was inert after `pi install` and `mcp install` wrote a command no host could spawn; every host config now
  launches `node <absolute bin> mcp`, and installed copies ship compiled `dist/`.
- Semantic Scholar was never reached (doubled `/graph/v1`); the SSRF guard covers the IPv4-translated range; `mcp install` no
  longer overwrites a non-object server table.
- From live user-simulation runs: `search_papers` names each failing provider and gives a DOI-shaped query its register hint;
  `search_passages` says how to get a source; `verify_claim` states what an exhaustive check costs; compile output explains the
  two Tectonic 0.15.0 `main.bbl` warnings and lists errors before warnings.
- Interruption notices are tied to their run, per-item refusals reach the footer, a malformed `read` cursor is refused as
  `CONTINUATION_INVALID`; `register` and `attach` exit non-zero when every item was refused.
- Live evidence leaked provider key values an agent printed; every evidence write now redacts them
  (`scripts/live/redact.ts`) and the affected earlier runs were redacted in place.

### Removed
- **Narrative documents (2026-10-14):** `docs/{DECISIONS,BACKLOG,testing}.md`, the dated plans, reviews and benchmark/skill-acceptance reports,
  the script READMEs and the generated `REMAINING-NODE-IMPORTS.md` (`tests-browser/bundle.spec.ts` no longer writes it). Their content that still
  matters is in `docs/handoff.md` (`docs/VISION.md` stays); the files are archived outside the repository. Raw benchmark data (`docs/benchmarks/*.json`) stays.
- One-off review scripts (`scripts/test-item{4,5,7,8}-*.ts`, `scripts/test-live-*.ts`), the old `scripts/test-sandbox.sh`
  (it could not reach Vertex) and the dead `runMcpServer`. Provider keys are no longer read from any other repository.
- The `julia`, `laya`, `k2`, `bev` and `lumma` verification engines (all rejected in the benchmarks), their Python workers, the
  OpenRouter chat benchmark engine and the old runner's non-Decision-2.0 engines. `verification.engine` now accepts `eos`,
  `eos-onnx`, `openrouter`, `llama-cpp` and `vela`. Superseded plans, reviews and per-run benchmark reports were archived outside the repository.

## [0.2.0] - 2026-10-05

### Added
- Unified stdio MCP server (`src/mcp/server.ts`) exposing the five tools with TypeBox schemas and typed refusals, under bare or
  host-namespaced names; `uktub-scholar mcp [dir]` and `mcp install --host <claude|pi|agy|codex|cursor|opencode>`, which
  merge `.mcp.json`, `.agents/mcp_config.json`, `.cursor/mcp.json`, `opencode.json` or `.codex/config.toml`.

### Changed
- The Pi adapter only registers the MCP server; `@earendil-works/pi-coding-agent` is an optional peer dependency.

### Removed
- The orphaned in-process guard and tool-extension code.

## [0.1.0] - 2026-10-04

### Added
- Managed llama.cpp runtime (`embed status | install --yes`): six platforms, sha256-pinned, safe archive extraction, supervised
  on loopback; first-party EmbeddingGemma GGUF (0.9997 mean cosine against the reference).
- Resident Decision 2.0 Eos verifier, the default engine at the 0.99 bar.
- Hybrid passage search (`search_passages`): FTS5 BM25 plus exact cosine, RRF k = 60, excerpts of at most 1,500 characters and
  25 % of a paper per call.
- Section-aware chunking (512 tokens, exact reconstruction) with schema v4/v5 migrations.
- `paper_registry` (register, remove, read, attach_source, sync_bibliography) and `compile_document` (Tectonic, structured
  diagnostics).

### Fixed
- GROBID TEI wrapped in HTML now parses; SSRF defense across redirects (loopback, RFC 1918, link-local, metadata, ULA,
  IPv4-mapped, NAT64); parameterized SQL and sanitized FTS5 queries; the `llama-server` child ends with its parent.

### Verified
- Independent review against 14 real PDFs and live providers (2026-10-04, 2026-10-05; the reports are in git history). Its 95.0 % Eos
  recall was not reproducible; the re-measurement is in the [handoff](docs/handoff.md).
