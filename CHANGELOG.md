# Changelog

All notable changes to the `uktub-scholar` package are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to Semantic Versioning.

## [Unreleased]

### Fixed
- **Pi package was inert after `pi install`**: the extension registered the bare command `uktub-scholar` (on no PATH) and the manifest never named the skills directory. It now registers `node <abs bin>`, loads the skill, and exposes the five tools directly.
- **`mcp install` wrote a command no host could spawn** (`uktub-scholar` is on no PATH for a checkout or project-local install): every host config now launches `node <abs bin> mcp`.
- **An npm-installed copy could not run** (Node refuses to type-strip files under `node_modules`): the package now ships compiled `dist/` (165 kB, was 925 kB with tests and docs); a checkout still runs `src/`.
- **Semantic Scholar was never reached in production** (base URL doubled `/graph/v1`); `mcp install` no longer overwrites a non-object server table; the SSRF guard blocks the IPv4-translated range; a tar cleanup race in `installRuntime` is closed.
- `search_papers` text now names each failing provider and folds a DOI-less duplicate into its DOI-bearing record; `VERIFY_ENGINE_MISSING` names the default engine's setup.

### Added
- `uktub-scholar tectonic status | install --yes`: a pinned (0.17.0), sha256-verified, self-checked LaTeX engine for users without TeX tooling; `compile_document` uses it after `UKTUB_TECTONIC_BIN` and PATH.
- Agent rules (`src/core/agent-rules.ts`) delivered in the MCP handshake and as Pi system-prompt guidelines; the Pi extension blocks agent `edit`/`write` on `refs/references.bib` and `.registry/`.
- Engine `eos-onnx` and `uktub-scholar eos status | install --yes [--gpu]`: Decision 2.0 Eos on ONNX Runtime without PyTorch (882 MB cold install against 8+ GB; 100% decision agreement with the torch worker at the 0.99 bar over 450 judgments; 4-bit exports refused). The default engine is unchanged.
- Pi "Tool notices" footer: refusals and warnings from uktub tools that the final answer leaves out are appended to it (`src/core/notices.ts`).
- MCP server version is read from `package.json`; `typescript` is a declared devDependency.

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
  - Verified live on 70 claims: 95.0% recall on TRUE claims, 96.7% specificity on FALSE claims, and 97.4% precision.
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
