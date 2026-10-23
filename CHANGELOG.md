# Changelog

All notable changes to `uktub-scholar`, in [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) form, versioned with
[Semantic Versioning](https://semver.org/). Rationale, measurements and open work are in [docs/handoff.md](docs/handoff.md);
the full entries before 2026-10-23 are in git history (`git show c9972da:CHANGELOG.md`).

## [Unreleased]

Checkpoint 2026-10-23 (late): `pnpm test` 1,886 / 1,885 pass / 0 fail / 1 skip; both `tsc` runs and `typecheck:browser` clean
(web `tsc` not rerun: no `web/` change).

### Added
- Browser app (MVP, `web/`, TeXlyre fork): XeLaTeX in the browser (BusyTeX), per-project storage with its own registry,
  an assistant panel on pi-agent-core with the six tools, `write_section` and `compile`, export/import that keeps the registry.
- `doctor` tool (sixth tool) and `verify` document mode (checks text as written; table rows get a figure check).
- Pi `write_section` section writer, always-on writing workflow, and a pre-completion gate: prose must be verified as
  written or labelled "unverified" (D1); sections are saved to `manuscript/sections/` (D2).
- Hosted verifier (`vllm-sr/d3-mini`, free key) with top-10 candidates; durable verify evidence (`claim_ledger`, schema v6);
  provenance audit of statements, table rows and computed figures.
- Live measurement harness (`scripts/live/`, `pnpm experiment`), benchmarks in `docs/benchmarks/`, product skills.
- Section-unit verification (opt-in via `UKTUB_VERIFY_STRATEGY=units` until the A/B decides): whole paper sections are
  the judging unit; bibliography sections are excluded and disclosed; a claim's questions are packed per paper; continuation
  token v4.
- `write_section` in Pi: at most 20 assigned papers, each with full text, checked before the sub-session starts. The
  sub-session's `passages`, `registry` (read) and `verify` reach only those papers.
- `write_section` in Pi marks each claim `% cN` and lists its stated sources. The check judges stated sources first,
  then the rest of each cited paper; the result has a claim table, repairs are by `cN`, and annotated checks are capped at
  4 calls per run. The workflow now writes the abstract, introduction and conclusion last, from the saved sections.

### Changed
- Default verification engine is `hosted`; questions use the criteria wording; shared 429 backoff.
- Hosted requests carry keyed question packs, up to 20 questions and 9 states (protocol `systemone-noul-criteria-v2`, so
  v1 cache rows are not reused). 5xx and network errors are retried twice. A failed question fails only its own claims.
- Heading detection finds appendix headings after References (`sections-v2`; stored PDF marks re-derive on next use).
- Provenance: a statement is verified only when EVERY paper it cites supports that wording.
- Live harness: OpenCode Go writer and grader B use `minimax-m3.1-flash`; the `-free` id was deprecated upstream.
- Short core prompt; tool mechanics live in tool descriptions. Pi 1.3.0 (root), pi-ai/pi-agent-core 1.4.0 (browser).

### Fixed
- Hosted engine identity took the first model of `/v1/models` (now d3-turbo); it is the configured d3-mini, or no cache reuse.
- Citations after the full stop escaped the registry check; continuation resumes the same candidates; Semantic Scholar key
  fallback; browser compile, deletion race and settings-reset defects; lifecycle and cancellation hardening.

### Removed
- Rejected engines (`vela`, `julia`, `laya`, `k2`, `bev`, `lumma`), `pnpm evolve`, TeXlyre's account/backup/collaboration
  layer in the browser app, narrative docs, and superseded raw data from the claim-verification-v1 era (in git history).

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
