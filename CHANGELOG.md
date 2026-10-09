# Changelog

All notable changes to `uktub-scholar`, in [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) form, versioned with
[Semantic Versioning](https://semver.org/). Rationale and measurements are in [docs/DECISIONS.md](docs/DECISIONS.md); open
work is in [docs/BACKLOG.md](docs/BACKLOG.md).

## [Unreleased]

### Added
- **Live test harness** ([docs/testing.md](docs/testing.md)): Docker-isolated acceptance of every tool and action against real
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

### Changed
- **One repository root**: skills (`.agents/skills/`), benchmark PDFs (`test_papers/`) and sandbox state (`.sandbox/`, both
  gitignored) now live here; dated reviews are in `docs/reviews/`; one `AGENTS.md`, one backlog, one handoff.
- **Embedding model**: EmbeddingGemma 2 Q4_K_XL (176 MB, Apache-2.0) on llama.cpp `b11476`, replacing EmbeddingGemma 300M Q8_0
  on `b11398`: half the download, same speed, about 4–5 points lower hybrid recall (accepted by the owner). Run
  `uktub-scholar embed install --yes` again.
- Pi pin 1.0.0 to 1.1.0. `refs/references.bib` is written read-only (mode 0444). Compile diagnostics name included files by
  project-relative path.

### Fixed
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
- One-off review scripts (`scripts/test-item{4,5,7,8}-*.ts`, `scripts/test-live-*.ts`), the old `scripts/test-sandbox.sh`
  (it could not reach Vertex) and the dead `runMcpServer`. Provider keys are no longer read from any other repository.

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
- Independent review against 14 real PDFs and live providers ([review](docs/reviews/review-2026-10-04.md)). Its 95.0 % Eos
  recall was not reproducible; the re-measurement is in the [follow-up review](docs/reviews/review-2026-10-05.md).
