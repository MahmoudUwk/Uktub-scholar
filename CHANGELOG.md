# Changelog

All notable changes to the `uktub-scholar` package are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to Semantic Versioning.

## [Unreleased]

### Added
- **MCP host contract.** Every tool has a title and all four annotation hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), set from a side-effect audit: `search_papers` read-only and open-world; `paper_registry` destructive and open-world (the union of its actions); `compile_document` non-destructive, idempotent, closed-world; `verify_claim` non-idempotent and open-world; `search_passages` non-read-only (it builds a derived index) and idempotent. Hosts read a missing hint as destructive and open-world. `UKTUB_MCP_TRACE=1` makes `uktub-scholar mcp` write one stderr line per handshake (client, requested and negotiated revision). Host measurements: [docs/plans/2026-10-08-host-adapter-layer-research.md](docs/plans/2026-10-08-host-adapter-layer-research.md).
- **Long tool calls survive host timeouts**: `notifications/progress` heartbeats every 15 s when the client asked for them (a CPU-engine verification, a first compile or a large attach no longer hits Pi's 60 s request timeout).
- **Agent guard rails.** Agent rules (`src/core/agent-rules.ts`) are delivered in the MCP handshake and as Pi system-prompt guidelines. The Pi extension blocks agent `edit`/`write` on `refs/references.bib` and `.registry/`, asks the human before a destructive shell command touches them (blocked when there is no UI; an explicit repeat request asks again), and appends a "Tool notices" footer with refusals, warnings, interrupted or failed tool results that the final answer left out (`src/core/notices.ts`).
- **Source acquisition**: `paper_registry acquire` with a typed status per paper (`metadata_only | acquiring | ready | unavailable | failed`); a registration hook starts acquisition in the background (`UKTUB_ACQUIRE_ON_REGISTER=0` disables it); one acquisition per paper at a time; "no open copy" is not looked up again for an hour. Any lawful open-access copy a provider record names (owner decision 2026-10-07, [DECISIONS](docs/DECISIONS.md)): OpenAlex `pdf_url` and `oa_url`, the arXiv PDF of an arXiv identifier the record or DOI carries (`arxiv-pdf`, `arxiv-preprint-pdf`), PubMed Central through Europe PMC (`pmc-pdf`, `epmc-pdf`), then Semantic Scholar `openAccessPdf` and its arXiv preprint. Guards unchanged (HTTPS, public addresses, byte and time bounds, identity check, no landing-page scraping; `doi.org` and `europepmc.org` render links are never fetched; arXiv requests spaced 3 s with a cooldown after 429/403). `verify_claim` discloses a source taken from a preprint (`preprint:` line, `coverage.sources.preprint`).
- **Engines and tools without a toolchain**: `eos-onnx` and `uktub-scholar eos status | install --yes [--gpu]` (Decision 2.0 Eos on ONNX Runtime, no PyTorch; 100% decision agreement with the torch worker at the 0.99 bar over 450 judgments; 4-bit exports refused); `uktub-scholar tectonic status | install --yes` (pinned 0.17.0, sha256-verified; `compile_document` uses it after `UKTUB_TECTONIC_BIN` and PATH).
- **`vela` verification engine (experimental, not adopted).** Runs Vela 2.0 0.3B (ONNX Runtime) or any Vela 2.0 size on PyTorch (`UKTUB_VELA_BACKEND=torch`, `UKTUB_VELA_DEVICE=cuda`) through `scripts/vela_decide.py`; the worker refuses weights or inference code that differ from the pinned sha256 values. Selectable only; the default stays `eos`. Benchmarked: 0.3B AUC 0.866 and 0.8B AUC 0.884 against Eos 0.968 ([DECISIONS](docs/DECISIONS.md), 2026-10-08).
- **Live test harness** ([docs/testing.md](docs/testing.md)): Docker-isolated acceptance of every tool and action against real providers and engines, directly over stdio MCP (`pnpm live:direct`) and through a real Pi session on `google-vertex/gemini-3.8-flash` (`pnpm live:agent`, with a labelled one-time rerun on `gemini-3.5-flash-lite` after an HTTP 429); a boundary probe (`pnpm live:probe`); a user-simulation experiment loop (`pnpm experiment <scenario>`); and a self-improving loop with protected held-out and out-of-domain scenarios (`pnpm evolve`, `experiments/harness/`, [plan](docs/plans/2026-10-07-self-improving-harness-plan.md)). Verdicts are PASS / FAIL / BLOCKED / NOT_RUN; every run writes evidence with a manifest, and a partial run is never reported as full coverage. Provider keys (`OPENALEX_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY`, `CROSSREF_MAILTO`) are forwarded by name from the shell or a gitignored `.env` in this repository; a keyless run is labelled as such.

### Changed
- Embedding model: EmbeddingGemma 2 Q4_K_XL (176 MB, Apache-2.0, no terms acceptance) on llama.cpp `b11476`, replacing EmbeddingGemma 300M Q8_0 (334 MB, Gemma terms) on `b11398`: same CPU speed, half the download, about 4–5 points lower hybrid recall on this repository's benchmark (accepted by the owner). Run `uktub-scholar embed install --yes` again; passages re-embed on first use.
- Development and sandbox-image Pi pin: 1.0.0 to 1.1.0. The MCP server version is read from `package.json`; `typescript` is a declared devDependency; the sandbox image adds `libgomp1` (embedding server).
- `refs/references.bib` is written read-only (mode 0444) so no editor or agent write can add an invented entry; the next registry write replaces it by rename, and the human may `chmod` it.
- Compile diagnostics name included files as project-relative paths with their extension (`manuscript/multi/sections/intro.tex`); an arXiv DOI is fetched from arXiv even when OpenAlex does not know the work; `no_open_copy` text reports what was searched instead of "OpenAlex lists no …".

### Fixed
- **Install and launch**: the Pi package was inert after `pi install` (it registered a bare `uktub-scholar` command on no PATH and the manifest never named the skills directory); `mcp install` wrote a command no host could spawn, so every host config now launches `node <abs bin> mcp`; an npm-installed copy could not run (Node refuses to type-strip files under `node_modules`), so the package ships compiled `dist/` (165 kB, was 925 kB).
- **Providers and safety**: Semantic Scholar was never reached in production (doubled `/graph/v1`); the SSRF guard blocks the IPv4-translated range; `mcp install` no longer overwrites a non-object server table; a tar cleanup race in `installRuntime` is closed.
- **Fixes from live user-simulation evidence** (`experiments/`, [BACKLOG §7](docs/BACKLOG.md)): `search_papers` puts a DOI-shaped query's register hint in the text the model reads and names each failing provider; `search_passages` says how to get a source when there is none (`verify_claim` acquires on demand with a narrow `query`; `paper_registry attach_source`); `verify_claim` states that an exhaustive check takes minutes on long papers (agent tool time 1296 s before, 101–204 s after); `compile_document` explains the two Tectonic 0.15.0 `main.bbl` warnings as engine behavior and no longer lets the 50-diagnostic cap crowd errors out behind `Overfull \hbox` warnings (errors first, truncation disclosed, a silent non-zero exit reports one synthetic error).
- **Notices**: an interruption notice is keyed to its originating `verify_claim` run and clears only when that run completes; per-item `paper_registry` refusals and registry warnings reach the footer; a malformed `paper_registry read` cursor is refused as `CONTINUATION_INVALID`.
- CLI: `--help`/`-h`/`help`; `register`/`attach` exit 1 when every item was refused; `mcp install` accepts a zero-byte config and says when the codex entry already exists. Agent rules: follow the continuation until `work:` reads complete; no bibliographic data from memory; no files for a paper that was not found unless a stub is requested.
- **Live harness evidence leaked provider keys.** An agent that printed its environment put forwarded OpenAlex and Semantic Scholar key values into run transcripts, because the harness redacted only credential shapes and several writers did not redact at all. All evidence writes now go through `scripts/live/redact.ts`, which also replaces the exact values of forwarded `*_KEY`/`*_TOKEN`/`*_SECRET` variables with `[REDACTED:NAME]` (`tests/live-redact.spec.ts`; confirmed live). The 13 affected files in six earlier runs were redacted in place, each run directory carries a `NOTE.md`; the earlier claim that a scan found no key value was wrong ([BACKLOG §7](docs/BACKLOG.md)).

### Removed
- Provider keys are no longer read from a sibling repository: the harness uses the shell or a gitignored `.env` in this repository (`scripts/live/keys.ts`).
- One-off review harnesses `scripts/test-item{4,5,7,8}-*.ts` and `scripts/test-live-{registration,search,tei}.ts` (superseded by the offline suite and `scripts/live/`; they remain in git history and are named in the dated reviews), and the unused `runMcpServer`.

## [0.2.0] - 2026-10-05

### Added
- **Unified Stdio MCP Server (`src/mcp/server.ts`)**:
  - Implemented standard Model Context Protocol server over stdio via `@modelcontextprotocol/sdk`.
  - Exposes all five canonical scholarly tools (`search_papers`, `paper_registry`, `compile_document`, `verify_claim`, `search_passages`) with strict TypeBox JSON Schema input definitions, structured JSON outputs, and typed refusal error reporting.
  - CLI subcommands `uktub-scholar mcp [dir]` and `uktub-scholar mcp install [--host <claude|pi|agy|codex|cursor|opencode>]`.
  - Declarative host config generator safely creating or merging `.mcp.json`, `.agents/mcp_config.json`, `.cursor/mcp.json`, `opencode.json`, and `.codex/config.toml`.
  - Bidirectional tool name normalization in `normalizeToolName()`, supporting both bare tool names and host-namespaced identifiers (e.g. `mcp__uktub_scholar__search_papers` or `uktub-scholar/search_papers`).
- **Test Suite Expansion**:
  - Added `tests/mcp-server.spec.ts` covering in-memory JSON-RPC sessions and real OS stdio subprocess transports.
  - Added `tests/cli.spec.ts` covering MCP CLI commands, host configuration generation, and path confinement. All 611 tests passing across 141 suites.

### Changed
- **Streamlined Host Adapters**:
  - Pruned in-process tool extension (`src/pi/extension.ts`) and custom widget (`src/pi/registry-widget.ts`), replacing them with an 8-line `registerMcpServer` hook in `src/pi/index.ts`.
  - Decoupled `@earendil-works/pi-coding-agent` into an optional peer dependency in `package.json`.
  - Updated documentation across `README.md`, `docs/DECISIONS.md`, and `docs/BACKLOG.md` to reflect universal MCP-first architecture.

### Removed
- **Dead Code & Legacy In-Process Artifacts**:
  - Removed orphaned `src/core/guard.ts` and `tests/guard.spec.ts` (advisory in-process Pi tool interceptor).
  - Removed obsolete `PI_EXTENSION_API_UNAVAILABLE` refusal code and `REFUSALS` entry.
  - Removed stale references to advisory bash guards and TUI registry widgets in `README.md` and `docs/`.

## [0.1.0] - 2026-10-04

### Added
- **Managed `llama.cpp` Runtime**:
  - Supervised child-process management for `llama-server` on loopback.
  - CLI commands `uktub-scholar embed status` and `uktub-scholar embed install --yes` with interactive Gemma terms confirmation.
  - Multi-platform binary pinning for llama.cpp release `b11398` across 6 platforms (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64`).
  - Safe archive extraction supporting `.tar.gz` and `.zip` archives with path traversal, backslash, absolute path, and link escape defenses.
- **First-Party Embedding GGUF (`ggml-org`)**:
  - Pinned official first-party, ungated `ggml-org/embeddinggemma-300M-GGUF` (`embeddinggemma-300M-Q8_0.gguf`, 316 tensors, sha256 `b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63`).
  - Achieved **0.9997 mean cosine parity**, 0.9999 Pearson correlation, and 1.00 Top-1 retrieval agreement against reference `sentence-transformers` on the committed parity gate.
- **Resident Decision 2.0 Eos Verification Adapter**:
  - Resident local Python worker (`scripts/decision2_decide.py`) serving Eos 0.8B on PyTorch/CUDA.
  - Adopted as default verification engine at the 0.99 confidence bar.
  - Verified live on 70 claims: 95.0% recall on TRUE claims, 96.7% specificity on FALSE claims, and 97.4% precision. (Not reproducible: the measuring script divided by hard-coded counts; the re-measurement is 90.5% recall, 95.2% specificity, 95.0% precision, docs/review-2026-10-05.md.)
- **Hybrid Passage Search (`search_passages`)**:
  - Pi tool `search_passages` and CLI command `uktub-scholar search`.
  - Reciprocal Rank Fusion (RRF, k = 60) combining SQLite FTS5 (BM25) and exact-cosine dense vector search.
  - Schema v5 vector caching keyed by passage text and model identity.
  - Output containment enforcing 1,500-character maximum per excerpt and 25 % release budget per paper.
- **Section-Aware Chunking**:
  - Multi-strategy heading extraction (`pdf.js` font/layout heuristics and GROBID TEI section headers).
  - Deterministic splitting (`splitBySections`) defaulting to 512 tokens with zero gaps, zero overlaps, and exact source reconstruction.
  - Schema v4/v5 migration path preserving existing registry databases.
- **Unified Paper Registry (`paper_registry`)**:
  - Batch registration (`register`), removal (`remove`), projected reads (`read`), local PDF/TEI source attachment (`attach_source`), and one-way BibTeX bibliography sync (`sync_bibliography`).
- **LaTeX Compilation Tool (`compile_document`)**:
  - Tectonic integration with structured diagnostic parsing and PDF output to `build/`.

### Fixed
- **GROBID TEI Parsing & Extraction**:
  - Fixed handling of OpenAlex Content API responses wrapped in HTML (`<html><body><tei>`).
  - Added case-insensitive XML root detection (`/<tei[\s>]/i`) and relaxed tag matching.
  - Fixed data loss bug where direct text inside `<div>` exceeding 200 characters was discarded; long text is now preserved as body blocks, eliminating spurious `no_text_layer` refusals.
- **Managed Runtime Process Cleanup**:
  - Attached active handlers for `SIGTERM`, `SIGINT`, and `SIGHUP` in `src/core/embed/runtime.ts` to terminate child `llama-server` processes upon parent exit, preventing orphaned background processes.
- **Test-Suite Cache Isolation**:
  - Isolated `UKTUB_CACHE_DIR` across test specs using isolated temporary directories, preventing tests from being polluted by developer-installed cache assets.
- **Security & Confinement**:
  - Hardened SSRF defense blocking loopback, RFC1918, link-local, cloud metadata, IPv6 ULA, IPv4-mapped, and NAT64 addresses across all redirects.
  - Parameterized SQLite statements across all registry queries to eliminate SQL injection risks.
  - Sanitized FTS5 search queries against syntax injection.

### Verified
- **Independent Full-System Review (2026-10-04)**:
  - Zero-mock verification against 14 real scientific PDFs, live OpenAlex, Crossref, and Semantic Scholar APIs.
  - Full suite passes: 594 offline unit and regression tests passing cleanly.
  - Documented in [`docs/review-2026-10-04.md`](docs/review-2026-10-04.md).
