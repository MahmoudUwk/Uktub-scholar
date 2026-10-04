# Changelog

All notable changes to the `uktub-scholar` package are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to Semantic Versioning.

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
