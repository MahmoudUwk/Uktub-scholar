# Backlog — correctness risks and deferred capabilities

Open correctness risks and deferred work; current behavior is in [README](../README.md).
Historical rationale lives in [DECISIONS.md](DECISIONS.md); attribution rules in [NOTICE.md](../NOTICE.md);
independent review evidence in [review-2026-10-04.md](review-2026-10-04.md).

## Completed Milestones & Resolved Debt (2026-10-04)

Every milestone was developed behavior-first (TDD) and verified with zero-mock tests against real papers and live services:

- [x] **Section-aware chunking**: `splitBySections` with heading detection (`pdf.js` text items and GROBID TEI), schema v4, default `boundary: section` at 512 tokens. Tiling verified with zero gaps, zero overlaps, and exact verbatim slice recovery across 14 real papers ([evidence](benchmarks/evidence-chunking-sections-2026-10-04.md); [decision](DECISIONS.md)).
- [x] **Managed llama.cpp embedding runtime**: Pinned official `llama-server` `b11398` fetched on explicit `embed install --yes` into shared cache (`UKTUB_CACHE_DIR`), verified by sha256, safely extracted, and supervised as a resident child process on loopback. Safe symlink reconstruction and `.zip` archive inflation ([decision](DECISIONS.md)).
- [x] **First-party ungated embedding GGUF pin**: Discovered and pinned official `ggml-org/embeddinggemma-300M-GGUF` (`embeddinggemma-300M-Q8_0.gguf`, 316 tensors, ungated HTTP 200), replacing third-party conversions. Measured at **0.9997 mean cosine parity**, 0.9999 Pearson correlation, and 1.00 Top-1 agreement against reference `sentence-transformers` on the parity gate ([decision](DECISIONS.md)).
- [x] **RAG hybrid passage search**: `search_passages` Pi tool and CLI `uktub-scholar search`. Combines lexical FTS5 (BM25) and exact-cosine vector search fused with Reciprocal Rank Fusion (k = 60). Schema v5 vector cache, automatic fallback to lexical search on missing runtime, and strict full-text output containment (max 1,500 chars, max 25 % of paper). 100% pointer resolution verified across 30 diverse domain queries ([report](benchmarks/rag-search-section-512-2026-10-04.md)).
- [x] **Resident Decision 2.0 Eos verification adapter**: In-package resident Python worker (`scripts/decision2_decide.py`) serving Eos 0.8B on PyTorch/CUDA as the default verification engine at the 0.99 confidence bar. Evaluated live on 70 claims: 95.0% recall on TRUE claims, 96.7% specificity on FALSE claims, 97.4% precision ([review report](review-2026-10-04.md)).
- [x] **GROBID TEI extraction hardening**: Exercised OpenAlex Content API live on real papers. Resolved two critical parser bugs: made XML root detection case-insensitive (`/<tei[\s>]/i`) to handle wrapped HTML (`<html><body><tei>`), and preserved long direct `<div>` body text (> 200 chars) as body blocks rather than silently discarding it.
- [x] **Child process lifecycle cleanup**: Attached active listeners for `SIGTERM`, `SIGINT`, and `SIGHUP` in `src/core/embed/runtime.ts` so that terminating the parent Node process immediately and cleanly kills the supervised child `llama-server` process, eliminating orphaned server processes.
- [x] **Test-suite cache isolation**: Isolated `UKTUB_CACHE_DIR` across test runs with temporary directories, eliminating state leaks between developer environments and automated test suites.
- [x] **Cross-platform asset validation**: Verified all 6 platform archives (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64`) against GitHub `b11398` releases for sha256 checksums, byte sizes, and safe archive extraction.

---

## Active Backlog & Correctness Risks

### 1. Platform Runtime Execution (macOS & Windows)
- **Status:** Pinned for 6 platforms; executed on Linux x64 only.
- **Details:** The managed `llama-server` binary and GGUF model are pinned and verified for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, and `win32-arm64`. While archive digests and extraction formats have been verified across all six, actual execution of the server process has only been validated on `linux-x64`.
- **Remaining risk:** macOS Gatekeeper/quarantine flags on downloaded binaries; macOS Metal GPU selection vs CPU fallback; Windows child-process termination and `.exe` path separators.
- **Trigger:** First developer or CI session running on macOS or Windows.

### 2. Document Parser & Structure Enhancements
- **PDF heading detector residue:** On the 14 test papers, ≈ 7 false positives were identified out of ≈ 300 headings (e.g. bare line numbers in algorithm pseudocode, affiliation footnotes, numbered lists). They create a harmless section boundary but never break text continuity or pointers. A font-size/weight pass over `pdf.js` text items would eliminate them if sessions show need.
- **TEI heading hierarchy:** GROBID's `n` attribute is dropped by current parser settings, causing all TEI headings to be treated as level 1 (chunking boundaries are unaffected).
- **OCR fallback for scanned PDFs:** Scanned PDFs lacking a text layer fail-closed with `no_text_layer`. An optional OCR fallback (e.g. via LiteParse or Tesseract) remains deferred.

### 3. Retrieval & Evidence Scaling
- **Vector index scaling:** Exact cosine distance scan in SQLite is currently $O(N)$ (takes ≈ 3 ms for 700 passages). For corpora exceeding 10,000 passages, integrating an indexed vector store (such as `sqlite-vec`) should be evaluated.
- **Retrieval fusion tuning:** Reciprocal Rank Fusion uses equal weighting (k = 60). A weighted or cross-encoder reranked pass could improve question-style query recall if future benchmarks warrant it.
- **Judgment cache eviction:** The `claim_judgments` table stores verified claim results without an LRU eviction policy (records are small). While runs and evidence expire after 24 hours, persistent cache growth should be bounded for multi-month projects.

### 4. Roadmap Items (Owner-Gated)
- **Open-access full-text acquisition:** Direct `pdf_url` downloading and OpenAlex Content API TEI/PDF fetching are fully supported. Expanding to additional lawful repositories remains deferred by the owner until required.
- **Citation graph exploration ("PaperRabbit / ResearchRabbit"):** An interactive topological graph over registered papers (citekeys), claims, and supporting passages (`doi@revision#start-end`), with citation edges ("cites / cited by" via OpenAlex) and semantic edges ("similar to" via passage vectors). Deferred as the final capability on the long arc.

---

## Deliverable Companions (Host-Side, Never Bundled)

- **Slides — open-slide runtime** (MIT, github.com/open-slide/open-slide): Agent-written React decks on a fixed 1920×1080 canvas. Alternative: **Slidev** via slideblocks-skill (MIT). Content discipline template: OpenScience `writing/scientific-slides` and `academic-pptx-skill`.
- **Office deliverables — GenOffice** (Apache-2.0, genspark-ai/genoffice) for interactive editing; **Paper Office** (paperinstruments.com) for scripted `.docx`/`.pptx` manipulation.
- **Charts — evident-charts** (MIT, rhiever/evident-charts): Publication-grade charting.
- **Document ingestion — LiteParse** (Apache-2.0, run-llama/liteparse): Rust-based parser for reading user drafts and supplementary PDFs outside LaTeX.

## Computational Experiments & Research Skills

- **Autonomous experiment loops**: Budget-bounded keep-or-discard iterations against a single metric (`program.md` instructions, agent-edited script, logged verdicts).
- **Domain skill extensions (as needed)**:
  - `europepmc`: PubMed/biomedical metadata and OA retrieval.
  - `paper-figures`: Publication-grade LaTeX/vector figures.
  - `grant-proposals`: NSF/NIH/DOE proposal structure and review criteria.
  - `host-adapters`: MCP wrapper around `src/core` for non-Pi hosts (Claude Code, Codex).
