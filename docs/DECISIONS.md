# Decision log

Dated rationale and benchmark decisions, newest first; preserve superseded
entries as history, not current instructions. [README](../README.md) owns
current behavior; [BACKLOG](BACKLOG.md) owns deferred work; raw benchmark
evidence lives in [benchmarks/](benchmarks/). Reopen rejected proposals only
with new evidence. Benchmark rejection does not remove selectable adapters.

Current engine choice: Decision 2.0 Eos (local, owner decision 2026-10-04), score bar 0.99 (a cut on the engine's raw output, not a calibrated probability).
Canonical measurement: [claim-verification-v1, 135 claims, Policy A paragraph](benchmarks/decision2-eos+chunks-policyA-paragraph-claim-verification-v1-2026-10-04.md):
AUC 0.968, 38 supports at 0.99 (37 true, 1 false), precision 0.97, recall 0.50. Other engines stay selectable; OpenRouter Mercury Decide is the best
measured hosted option and K2 a local alternative; Vela 2.0 (0.3B and 0.8B) was tested and not adopted, and the verifier-model search is closed (2026-10-08).
Entries marked *superseded* below are history. Recorded live and benchmark runs are historical; the latest Mercury CLI attempt was quota-blocked,
not a new successful live verification.

## 2026-10-08 (Vela 2.0, 0.3B and 0.8B, tested as a replacement for Eos: not adopted)

Owner instruction: test `vllm-sr/Vela-2.0-0.3B` instead of Eos; if it works, remove Eos and adopt it. It does not work well enough, so Eos stays the default and nothing was removed. Measured on `claim-verification-v1` (135 claims, 14 papers) with exactly the Eos Policy A paragraph settings (43 chunks, 416 judgments, bar 0.99), model revision `d6f03aa9baca`, ONNX fp32 on CPU, [report](benchmarks/vela-0.3B+chunks-policyA-paragraph-claim-verification-v1-2026-10-08.md):

| | Vela 2.0 0.3B | Eos 0.8B ([report](benchmarks/decision2-eos+chunks-policyA-paragraph-claim-verification-v1-2026-10-04.md)) |
|---|---|---|
| AUC (tie-corrected) | 0.866 | 0.968 |
| Supported at 0.99 / true / false | 5 / 5 / 0 | 38 / 37 / 1 |
| Support recall at 0.99 | 0.07 | 0.50 |
| AUC on finding / method claims | 0.792 / 0.763 | 0.939 / 0.952 |
| At one false support: bar and true supports | bar 0.90, 25 true | bar 0.99, 37 true |
| Wall time | 2092 s CPU | 355 s GPU (not the same hardware) |

Even with the bar moved until both engines make one false support, Vela returns about two thirds of what Eos returns.

**Vela 2.0 0.8B (follow-up the same day, after an external consultant pointed out the 0.3B result does not carry over):** fine-tuned from the Eos 0.8B family, torch only, 16,384-token limit, run on the GPU with the identical settings ([report](benchmarks/vela-0.8B+chunks-policyA-paragraph-claim-verification-v1-2026-10-08.md), revision `326b01d81f61`, 370 s). AUC 0.884 (Eos 0.968); **0 supports at the 0.99 bar** (Eos 38); precision 0.94 at recall 0.59 (bar 0.85), where Eos has recall 0.85 at precision 0.94 (bar 0.95). One thing in its favour: at zero false supports it returns 32 true claims (bar 0.90) against 23 for Eos (bar 0.995), a nine-claim difference on 135 claims, not enough to matter next to the AUC gap. AUC by kind: method 0.963 (Eos 0.952), numeric 0.892, finding 0.853 (Eos 0.939), dataset 0.731 (Eos 0.969). Not adopted; Eos stays. Why it was a long shot: Vela is a routing, safety and hallucination-span encoder fine-tuned from the Kai trunk, and Kai also scored below Eos here (supports nothing at 0.99). It is not much smaller on disk either (fp16 ONNX 623 MB, fp32 1.24 GB; Eos 8-bit ONNX 717 MB). Smoke test on the 0.3B: it separated a wrong number and an off-topic claim from a supported one but did not flag a negated claim. Its tokenizer carries the Gemma Terms of Use (record in `NOTICE.md` if ever adopted). Limits of this evidence: one protocol was tested (the model's trained hallucination question, claim as the answer, P(supported) = 1 minus the highest unsupported-word probability); a yes/no question was not (another 35 minutes on CPU); one benchmark, 135 claims. The adapter (`vela`, `scripts/vela_decide.py`, test-first) stays selectable, as with the other rejected adapters; remove it if you do not want the maintenance.

## 2026-10-07 (Embedding model: EmbeddingGemma 2 Q4_K_XL, llama.cpp b11476)

Owner decision, after measurements: "the fastest model that is CPU friendly on normal modest researcher laptops and easy packaging; just use the Gemma embedding Q4"; no older model families (an earlier suggestion of BGE-small, a 2023 model, was withdrawn). Pinned: `unsloth/embeddinggemma-2-GGUF` at commit `031f0d4b…`, `embeddinggemma-2-UD-Q4_K_XL.gguf` (175,673,856 bytes, sha256 `ea905fd0…9493`, Apache-2.0), with llama.cpp `b11476` (all six platform archives digest-checked and their layout inspected). Why this and not the first-party Q8: Q8_0 embeds 41 % slower than the old model; Q4_K_XL is about as fast (176 against 162 ms per passage here) and half the disk. What it costs, measured on this repository's benchmark and accepted by the owner: hybrid all-papers recall @10 84.7 % to 80.2 % and own-paper 93.7 % to 91.9 %; the file is a third-party conversion (the first-party repository has only Q8_0 and BF16) with parity top-1 agreement 0.75 on 20 sentences. What it gains: Apache-2.0 instead of the Gemma terms (no terms acceptance), half the download. What Qdrant's post does not give us: its footprint figures are 1-bit and Matryoshka vector quantization at 10 million vectors; at our 698 passages vectors are 2 MB and the scan takes 3 ms. Peak memory of the embedding server (about 1.3 GB after embedding) is not set by the micro-batch (`-ub` 1024 gives the same, 512 or less rejects long passages), the prompt cache, the context size, or allocator settings (all tested); it needs a smaller model to change, which was not pursued. Vectors re-embed automatically on first use (the embedder identity changes); the old model's rows stay in `passage_vectors` until pruned.

## 2026-10-07 (Registration starts acquisition; typed source status)

Owner request: when a paper is registered, a hook should try to download it if it is open access, so that by the time the main agent summarizes and writes, sources are ready. Built as: `ToolContext.afterRegister` (called after the commit with the DOIs newly registered or refreshed and not yet ready), wired only in the MCP server, the one long-lived process; the CLI exits after one command and cannot hold a background task, so it keeps the explicit `paper_registry acquire` action. Acquisition moved to `src/core/verify/acquire.ts` with an in-process in-flight map keyed by (project, DOI): a hook, an `acquire` call and a `verify_claim` can overlap without repeating a download. A negative answer is cached for an hour (`no_open_copy`) or a day (`failed`), shorter for the first because it can mean only that a provider was busy. The hook never blocks `register`, never uses the request's cancellation signal, and a throwing hook cannot fail a committed registration. Found live: acquisition for an arXiv DOI depended on OpenAlex knowing the work, and tectonic's file names for `\input` files are relative to the entry folder without extension; both fixed.

## 2026-10-07 (Bibliography is read-only on disk)

Owner request: the agent must not be able to fabricate references in `refs/references.bib`. The file is rendered from the registry through a staged file and an atomic rename, so the render writes the file with mode 0444. No host's edit or write tool can then append or replace content (the write fails with EACCES), and the next registry write still replaces the file because a rename needs the directory, not the file. The human stays trusted and can `chmod` it. This is host-neutral enforcement without a hook (a Claude Code hook, as OpenResearch does for its own files, would have contradicted the stance that enforcement lives above the package). An agent with shell access could still `chmod` or delete the file; the Pi shell confirm dialog covers that on Pi, and `sync_bibliography` restores the file from the registry in any case. Tests that simulate a human editing the file now make it writable first.

## 2026-10-07 (Source acquisition: any lawful open-access copy a provider record names)

Owner decision: "I don't mind getting PDFs from any source" — use the open-access URL fields the providers return. Evidence: in the keyed experiment `iter-12`, three registered papers ended `no_open_copy` although a copy existed (a gold-OA IEEE Open Journal paper whose OpenAlex and Semantic Scholar records give only a `doi.org` landing page; an arXiv paper whose OpenAlex record has no `pdf_url`; a closed IEEE Letters paper with an arXiv preprint named by Semantic Scholar's `externalIds.ArXiv`).

- **What changed.** Acquisition tries, in order: OpenAlex `pdf_url` candidates; the arXiv PDF built from an arXiv identifier that the paper's own DOI (`10.48550/arXiv.<id>`) or an open OpenAlex location carries; `open_access.oa_url`; the Content API (key); and last, only if nothing produced a source, Semantic Scholar's `openAccessPdf.url` and the arXiv preprint of its `externalIds.ArXiv`. Semantic Scholar is asked last so a run that already has its source spends no quota there.
- **What stays.** HTTPS-only public addresses re-checked per redirect, byte and time bounds, the identity check on the extracted text, credential scoping, no landing-page scraping (a `doi.org` link is never fetched as a PDF; `oa_url` or `openAccessPdf.url` that answers HTML fails the document check), no URL built from a title, no Unpaywall (deprecated into OpenAlex), no paywall circumvention. `citation_pdf_url` scraping of publisher pages was considered and not built: IEEE answers scripted clients with an empty bot-challenge page.
- **Preprints are disclosed.** An arXiv copy of a work registered under another DOI is stored as `arxiv-preprint-pdf`, and `verify_claim` prints `preprint: <citekeys>` with the warning that the text may differ from the published version. Reading an arXiv preprint for local analysis, with no redistribution, is within arXiv's terms (non-exclusive licence; storing e-prints for personal or research purposes is allowed).
- **arXiv politeness.** One request at a time, at least 3 seconds apart (its API terms for programmatic access; `robots.txt` asks crawlers for 15 s, and this tool fetches the few papers a user named).
- **Europe PMC and PubMed Central (added the same day, found live).** The first Europe PMC design fetched the `fullTextUrlList` PDF links; against the real service `https://europepmc.org/articles/PMC…?pdf=render` and `/backend/ptpmcrender.fcgi` both answer scripted clients with a Cloudflare challenge (HTTP 403, `cf-mitigated: challenge`), and getting around a bot challenge is circumvention, not acquisition. The route that works is the PubMed Central open-data bucket (`pmc-oa-opendata.s3.amazonaws.com`, built for programmatic access): Europe PMC gives the PMCID for a DOI, the bucket lists versions, the newest version's JSON must carry the same DOI and a `pdf_url` under the same version folder, and the PDF is fetched over HTTPS (its md5 matched the JSON's). Kind `pmc-pdf`, licence from `license_code`. Asked after the OpenAlex tier and before Semantic Scholar, because an open-access publisher or author-manuscript copy is better than a preprint. The studies had dismissed this route as a duplicate; the live run showed it is the working one.
- **arXiv cooldown.** An HTTP 429 or 403 from arXiv skips arXiv candidates for 60 s, doubling to 10 min while it keeps refusing (arXiv treats ignored 403s as abuse).
- **Why not a library.** No maintained JS library resolves a DOI across OpenAlex, Semantic Scholar and arXiv; paperscraper is Python and Zotero's resolver depends on Unpaywall. The resolver is a few dozen lines over fields the providers document.

## 2026-10-05 (Unified Stdio MCP Server & Multi-Host Architecture)

Owner request: elevate `uktub-scholar` from a single-host Pi extension to a universal scholarly tools suite accessible across all modern AI coding agents (Claude Code, Pi, Cursor, Codex, OpenCode, Antigravity) and human CLI workflows.

- **Unified Stdio MCP Server (`src/mcp/server.ts`)** — Implemented a standards-compliant Model Context Protocol server over stdio using `@modelcontextprotocol/sdk`. Exposes all five canonical scholarly tools (`search_papers`, `paper_registry`, `compile_document`, `verify_claim`, `search_passages`) with strict TypeBox JSON Schema input definitions, structured JSON outputs, and typed refusal error reporting.
- **Streamlined Pi Adapter (`src/pi/index.ts`)** — Replaced in-process tool registrations (`src/pi/extension.ts`) and custom TUI widgets (`src/pi/registry-widget.ts`) with an 8-line hook delegating to `pi.registerMcpServer("uktub-scholar", { command: "uktub-scholar", args: ["mcp"] })`. Decoupled `@earendil-works/pi-coding-agent` to an optional peer dependency, ensuring the package installs and runs cleanly in non-Pi environments.
- **Host Tool Name Normalization** — Different MCP hosts invoke tools under varied namespaced identifiers (e.g. `mcp__uktub_scholar__search_papers` in Claude Code / OpenCode, `uktub-scholar/search_papers`, or bare `search_papers`). Implemented robust regex normalization in `src/mcp/server.ts` to map any namespaced variant to the canonical tool implementation.
- **Declarative Host Configuration Generator (`uktub-scholar mcp install`)** — Created CLI command supporting `--host <claude|pi|agy|codex|cursor|opencode>`. Safely reads existing config files (`.mcp.json`, `.agents/mcp_config.json`, `.cursor/mcp.json`, `opencode.json`, `.codex/config.toml`), merges the server definition, and writes formatted output without clobbering other configured MCP servers.
- **Protocol & OS Stdio Verification** — Comprehensive unit and integration coverage in `tests/mcp-server.spec.ts` and `tests/cli.spec.ts`. Verified in-memory client-server sessions, schema validation, and real OS subprocess stdio execution with `StdioClientTransport`.
- **Pruning Dead In-Process Extension Code & Refusals** — Removed orphaned `src/core/guard.ts`, its test suite `tests/guard.spec.ts`, and the unused `PI_EXTENSION_API_UNAVAILABLE` refusal code. In the unified MCP architecture, client confinement is enforced at the MCP server and tool context boundaries (`validateContext`, `validateTargetDir`, `resolveProjectFile`), rather than trying to intercept external host tools in-process. All 611 tests passing cleanly across 141 suites.

## 2026-10-04 (section chunking and passage search)

Owner request: chunk by the document's own structure, one set of chunks for retrieval and claim
verification, with a very reliable, well-tested splitter; add RAG; a small llama.cpp runtime for
EmbeddingGemma was asked about.

- **Splitter (`src/core/sections.ts`)** — pure `splitBySections(text, marks, {maxChars, minChars})`. A section
  that fits stays whole; a larger one splits into pieces of at most the cap at sentence boundaries, balanced
  (the final cut is chosen in the feasible range near the middle so no piece is a sliver); a heading line is
  never cut and never left alone at the end of a chunk; tiny whole sections merge into a neighbour only while
  the result fits. Verified by fixed cases and seeded property tests over 3,000 random documents (tiling,
  cap, determinism, heading integrity, parts bookkeeping, no sliver pieces, "tiny only if a neighbour
  cannot absorb it", "a fitting section is never fragmented") plus mutation checks (each injected bug is
  caught; the one surviving mutant is equivalent). The property run found two real defects in the first
  implementation (a sliver tail piece; a short piece before an unbroken run).
- **Structure** — TEI `<head>` offsets (exact); PDF heading lines (`src/core/source/headings.ts`) detected
  from the text itself, because `unpdf` keeps the page's hard-wrapped lines: canonical section names and
  numbered headings (roman, arabic with depth, lettered subsections after a roman section), with rejections for
  titles, units ("10 MHz"), pseudocode lines (math symbols), table rows, dates, figure panels, wrapped
  sentences and everything after the References heading. Measured on the 14 real PDFs: about 300 headings,
  **7 known false positives (≈ 2 %)** — three pseudocode lines, one affiliation, two list items, one notes
  line — recorded in BACKLOG. A wrong mark can only mislabel or shift a boundary, never break a pointer (the
  splitter tiles the text whatever the marks are). A font-based pass over `pdf.js` items was not built: the
  text-level detector is already measured and the residue is small; revisit if real sessions show harm.
- **Adoption** — default `boundary: section`, 512 tokens, no overlap
  ([evidence](benchmarks/evidence-chunking-sections-2026-10-04.md)): pooled support recall 90 % against 80 % for
  fixed 1,024 on 50 claims in two disjoint samples (6 gains, 1 loss; not conclusive, not worse), 5.0 judgments
  per claim with a locator, and every chunk inside the excerpt limit. Fixed policies keep their identities.
  Schema v4 stores the marks (`paper_sources.sections_json`) and the label (`chunks.section`); a PDF source stored
  before marks existed derives them from its text on the next rechunk.
- **Passage search** — hybrid FTS5/BM25 + exact-cosine vector ranking fused with RRF (k = 60), lexical when no
  embedder is configured or it fails (stated, never hidden). Vectors are a content-keyed compute cache
  (schema v5, `passage_vectors`, key = passage content + served-model identity). Measured on the 74 TRUE claims
  ([report](benchmarks/rag-search-section-512-2026-10-04.md)), recall@5 over all 14 papers: claim-text queries
  — BM25 98.6 %, vector 85.1 %, hybrid 94.6 %; independent paraphrases — 70.3 / 71.6 / 73.0 %; independent
  natural-language questions — **41.9 / 68.9 / 60.8 %**. Reading: BM25 is the floor and is hard to beat when the
  query reuses the paper's words; the vector leg is what finds passages for questions and paraphrases; unweighted
  RRF never fails badly across styles but trails the better single leg on each extreme (a weighted or reranked
  fusion is a possible later measurement). Cost: embedding the 697 passages takes 20 s once on CPU, a search 30 ms.
- **Embedding model provenance (a measured trap & first-party resolution)** — the `ggml-org/embeddinggemma-300m-qat-q8_0-GGUF` file the
  owner originally named had no dense-module tensors (314 tensors): its vectors had cosine ≈ 0.01 with the reference model. A third-party
  GGUF converted with `--sentence-transformers-dense-modules` (`cduk/embeddinggemma-300m-GGUF-with-dense-modules`, 316 tensors) matched the
  reference at mean cosine 0.990. During the independent review on 2026-10-04, ggml-org's newer first-party, ungated repository
  `ggml-org/embeddinggemma-300M-GGUF` was discovered: its `embeddinggemma-300M-Q8_0.gguf` carries all 316 tensors (including `dense_2.weight`
  and `dense_3.weight`), requires no HF authorization token, and achieves near-perfect parity against sentence-transformers (mean cosine 0.9997,
  pairwise Pearson correlation 0.9999, top-1 agreement 1.00). It was pinned in `models.lock.json`. llama-server also needs `-b/-ub` ≥ the chunk size (default 512 rejects a
  570-token chunk). Both are in the README; the embedder fails closed (typed error, lexical fallback).
- **Runtime packaging (owner decision, 2026-10-04)** — a pinned official `llama-server` build fetched on first use
  and supervised as a child process (not bundled in the package: a CUDA build is ≈ 370 MB; not an in-process
  binding: a native crash or a CPU-bound batch must not take the agent host down), plus the first-party ungated
  `ggml-org/embeddinggemma-300M-GGUF` (Q8_0) pinned by sha256. Facts found while building it: the research report's advice to pin the
  semver tag `v0.5.0` does not hold — that release has **no binary assets**; binaries exist only under the `b…`
  build tags, so a `b…` tag is pinned (first `b11160`, then, on the owner's request for the latest build, `b11398`; the digest
  published by GitHub equals the downloaded file's, and each pin re-ran the parity gate). The pinned pair was re-measured end to end (mean cosine 0.9997 against sentence-transformers).
  Install is an explicit CLI step with the Gemma terms shown and `--yes` required; a search never downloads. The
  live install found a defect the unit tests could not: the real archive carries chains of same-directory library
  symlinks that node-tar's strict mode rejects in some orders, so symlinks are validated (plain sibling names,
  nothing absolute or `..`) and recreated by the package while files and directories still go through `tar`'s strict
  extraction. The CPU build is used everywhere (700 passages embed in ≈ 20 s). Owner request (2026-10-04): runnable on every system — pinned for linux/darwin/win32 × x64/arm64 (six builds; Windows ships `.zip` with the files at the archive root, extracted with `fflate` under per-entry name validation and a declared-size cap checked before inflating). Only linux-x64 was run; the other five were downloaded with their digests verified and extracted by the real code path, and each yields the right executable type. `scripts/embed-parity.py` is the committed gate: it failed the older `ggml-org/embeddinggemma-300m-qat-q8_0-GGUF` at mean cosine 0.013, passed the interim `cduk` conversion at 0.990, and passes the pinned first-party `ggml-org/embeddinggemma-300M-GGUF` at 0.9997.
- **Independent system review (fresh agent, zero mocks, real papers, 10-area evaluation; report in `docs/review-2026-10-04.md`)**:
  - *TEI parsing defects discovered and fixed*: OpenAlex Content API returns GROBID TEI wrapped inside `<html><body><tei...>` with lowercase XML tags and leading direct text under `<div>`. Root detection was made case-insensitive, XML tag search relaxed, and long direct text (> 200 chars) inside `<div>` is now preserved as body text rather than silently discarded, preventing document truncation or spurious `no_text_layer` refusals.
  - *Managed runtime process lifecycle*: In `src/core/embed/runtime.ts`, attached active process listeners for termination signals (`SIGTERM`, `SIGINT`, `SIGHUP`), ensuring the child `llama-server` process is actively killed on parent exit rather than orphaned.
  - *Embedding GGUF parity resolved*: Pinned first-party, ungated `ggml-org/embeddinggemma-300M-GGUF` (Q8_0, 316 tensors, sha256 `b5ce9d77a3fc...`) with 0.9997 mean cosine parity and 0.9999 Pearson correlation against reference `sentence-transformers`.
  - *Eos Decision 2.0 verified*: Verified 40 TRUE claims (95.0% recall) and 30 FALSE claims (96.7% specificity, 97.4% precision) on CUDA GPU; 100% pointer resolution; exact 25% source-share containment compliance. (The 95.0 / 96.7 / 97.4% figures are not reproducible: the measuring script divided by hard-coded counts; the re-measurement is 90.5% recall, 95.2% specificity, 95.0% precision, docs/review-2026-10-05.md.)
  - *Test-suite isolation*: Isolated `UKTUB_CACHE_DIR` across test runs, eliminating test pollution from developer cache state.
- **Earlier independent review (12 verified findings, all fixed with regression tests)** — high: a TEI `<head>`
  with no length cap left the source through the `section` label past output containment (labels are now clipped to
  200 characters in the splitter and the tool, and over-long TEI heads are text, not marks); medium: the error-echo guard
  failed when a passage had runs of whitespace; search hydrated ranked hits by `chunk_index` after awaits (now by
  content-addressed chunk id, one retry when the corpus changed mid-call); a heading-only section dangled as the trailing
  line of the previous chunk (now goes forward with its section); stale PDF heading marks survived a detector change
  (PDF marks are re-derived at every rechunk); the splitter could cut a surrogate pair at a forced cut (and a tiny-cap
  fuzz exposed an empty and an oversize piece introduced by the first fix); a busy-database error and a dimension
  mismatch were mislabelled as embedding failures (now propagated and self-healed); low: orphan vectors were never
  pruned, an embedder's identity fingerprint came from the first model a multi-model server listed, extreme float
  components overflowed to NaN/Infinity and dimensions were unbounded, a cold index embedded without bound and twice under
  concurrency, and overlapping hits were mislabelled `whole_source`.
- Bug found by the live work: `containEvidence` spends the release budget in reading order (right for paged
  verification); search needs it spent on the best-ranked passages, so it takes an explicit `releaseOrder`.

## 2026-10-04 (paper registry and supporting evidence)

Measured choices; numbers live in the dated reports in [benchmarks/](benchmarks/).
Plan: [the unified plan](plans/2026-10-04-0746-feat-paper-registry-evidence-plan.md).

- **Two tools, one claim.** `paper_registry` replaces register/list; `verify_claim` replaces
  the claim-array tool. The agent never loads papers or writes chunks, receives only supporting
  passages with exact pointers, and no response says a claim is false ("no support found" is
  not refutation; the two-sided verdict helpers were deleted).
- **PDF parser: `unpdf`, not `pdftotext`.** On the 8 of 14 benchmark papers whose PDFs match the
  dataset names, `pdftotext` recovers 75/75 gold quotes verbatim and `unpdf` 60/75 (73/75 once
  line-end hyphenation is undone). The quotes were authored from `pdftotext` output, so the
  comparison favors it; every `unpdf` miss was hyphenation, not lost text. `unpdf` wins on being
  pure JS (no system binary in the sandbox image) and on grounded per-page text. All 14 real PDFs
  extract in 21–239 ms. `unpdf` yields one "paragraph" per page, so sentence-aware cuts, not
  paragraph boundaries, do the real chunking work. No OCR: image-only PDFs are refused.
- **TEI: `fast-xml-parser`** (maintained, MIT) with entity processing off and DOCTYPE/ENTITY
  refused before parsing; gzip bodies are bounded while decoding.
- **Provenance.** One captured text per ready paper; revision = H(source digest, extraction
  identity, text). Pointers are `doi@revision#start-end` in zero-based, end-exclusive UTF-16
  offsets. A replaced source gets a new revision and old pointers resolve as stale. Evidence is
  stored with its own decision (model identity, protocol, bar) so it survives cache loss, and is
  freshness-checked inside the write transaction. Chunk ids are bound to the paper (a
  live-smoke finding: one document can back two registered papers).
- **Judgment reuse needs an effective identity.** Key = claim, passage, model identity, protocol;
  the bar is applied on read. Hosted: the model slug. Local endpoints: whatever `/v1/models`
  reports, else no reuse unless declared with `UKTUB_VERIFY_MODEL_ID`. A URL is never an identity.
- **Two-stage judgment.** A stage-1 chunk (engine window) that supports the claim is localized into
  ≈1,200-character passages, each re-judged by the engine; only passages that themselves pass the
  bar are returned. Unfinished localization is continuable work, never a vague pointer.
- **Containment (client policies, per output).** Excerpt ≤ 1,500 characters; withheld when it is
  ≥ 50 % of its source; ≤ 25 % of one source released across a run (paged runs count earlier
  pages); pointers always kept. Delivery is exactly-once and stored with the run.
- **Identity of an acquired document** must be attested on the first page (≈ 6,000 characters): the
  DOI, an arXiv stamp, or the registered title as an ORDERED near-contiguous phrase (≥ 85 %).
  Unordered title-word overlap and identifiers in reference lists both admitted a wrong paper in
  the live CLI smoke (a same-authors paper citing the other).
- **Acquisition reality (live, free-tier).** OpenAlex records for a gold-OA paper and an arXiv
  preprint had landing pages only; a J-STAGE record with a `pdf_url` downloaded, parsed and passed
  the identity check; a JBC download was refused by the publisher. Landing pages are not scraped, so
  key-less coverage is partial by design (see BACKLOG).
- **Retrieval.** SQLite FTS5/BM25 (porter + unicode61), query reduced to quoted words; 5 candidates
  per paper. Claim-as-locator recall ([report](benchmarks/evidence-retrieval-2026-10-04.md)): with
  1,024-token windows K=5 gives 97.3 % candidate recall on both source-split halves at 19–34 % of
  the chunks; with the default 8,192-token windows a paper has 3–4 chunks, K=5 selects 93–100 % of
  them and a locator saves nothing.
- **Chunk window — measured with Eos 0.8B at bar 0.99** ([full runs](benchmarks/evidence-quality-end-to-end-2026-10-04.md),
  [window sweep](benchmarks/evidence-window-sweep-2026-10-04.md)). Full runs, tuning → held-out: 8,192 tokens recall
  45.9 % → 64.9 %; 2,048 tokens 67.6 % → 78.4 % (about 40 % fewer judgments with a locator). Sweep on one fixed
  subset (25 true, 21 false claims): 8,192 → 52 %, 2,048 → 76 %, **1,024 → 84 %**, 512 → 84 %; own-paper false
  supports 0/21 at 8,192 and 2/21 at every smaller window; with a locator 1,024 needs 7.9 judgments/claim
  (0.9 s) against 30.5 exhaustive. **Decision (owner delegated, 2026-10-04): the default is 1,024 tokens, overlap
  16.** Recall stops improving below it, and the research agent's literature check agrees (retrieval units of
  256–512 tokens, verification windows of about 1,024; one size does not serve both jobs well). Samples are
  small; the direction is consistent across both experiments. The previous default (8,192) was the engine window,
  not a measured optimum.
- **Default engine: Decision 2.0 Eos (owner decision 2026-10-04).** Implemented as an in-package resident worker
  (`eos`, pinned reviewed revision, one worker shared per process, never keeps the host process alive while idle
  but is waited for while a request is in flight). Two defects found while dogfooding it: the CLI hung for the
  full timeout because the worker held the event loop, and unref'ing it naively made the CLI exit silently on the
  second engine call. Both have regression tests. Mercury stays selectable and remains the best measured engine
  (54 supports, 0 false) — Eos is the local, free, offline choice (37 supports, 1 false in the benchmark).
- **Research notes (Hermes agent, 2026-10-04; claims to be re-verified before relying on them).**
  LiteParse: do not switch from `unpdf` (native Rust/PDFium addon with a process-global lock, OCR on by default,
  no character offsets, equations score 0, heavy churn); optional scanned-PDF fallback only. Window: a two-level
  scheme (small retrieval units, ~1,024-token verification windows expanded at query time, no index-time overlap)
  is the norm; its warning that 37-claim cells are noisy is right, which is why conclusions here are framed as
  direction, not significance.
- **`whatisit-nl2sh` is not a retrieval or entailment tool** (natural language → shell commands with a fine-tuned
  Qwen2.5-Coder-1.5B on llama.cpp). Not adopted. The owner's `GRC_Agent` borrowed its llama.cpp runtime manager to
  serve an embedding model; that pattern is recorded in BACKLOG for a future RAG vector leg.
- **Independent evidence review** ([report](benchmarks/evidence-review-2026-10-04.md)): a fresh Claude
  reviewer, blind to scores, gold and mode, rated 94 returned excerpts (an LLM review, not a human one).
  Excerpts overlapping the gold quote: 45/45 support. Other returned support in the same paper: 26 support,
  18 partial, 0 unsupported. Support returned for FALSE (fabricated) claims: 5 excerpts, 1 a genuine statement
  elsewhere, 4 not supporting — the real false-support events (≈ 3 % of 122 FALSE-claim runs). Precision
  of what is returned is therefore high; the limitation is recall (0.65–0.78) and the rare false support.

- **Decision 2.0 (Kai 0.6B, Eos 0.8B) on `claim-verification-v1`**, pinned revisions, local GPU
  ([status](benchmarks/decision2-evaluation-status-2026-10-04.md)): chunked tie-correct AUC Kai
  0.955, Eos 0.968 (difference not significant). At the 0.99 bar Kai supports nothing (its
  probabilities never exceed 0.931); Eos supports 38 claims, 37 true, precision 0.97, recall 0.50.
  Neither is adopted and no default changed; Eos runs behind the existing `llama-cpp` path via
  `scripts/system-one-server.ts`. Runner defects fixed first: AUC without tie correction, cached and
  fresh scores misaligned by chunk position, empty fresh batches crashing, sweeps reusing stale verdicts.
- **Defaults.** `chars_per_token` default is the calibrated 2.8 (it was 4.0, which makes an
  "8,192-token" window overflow real text). Config resolves on one path with or without YAML;
  `max_judgments` 120 per call is a client policy (≈ 7 minutes on the free hosted tier).
- **Schema v3.** v1/v2 migrate explicitly; v2's unsourced chunk/verdict/pointer rows are dropped after a
  `.v2.bak` copy because they cannot be evidence. Foreign and newer files are refused without being opened
  for writing; `init` initialises only an empty database.
- **Found by independent review and fixed:** output paging that skipped or duplicated evidence after a
  work continuation; a direct pointer path that could read arbitrary spans; continuations that forgot the
  first call's limitations or accepted a different id list; recomputed BM25 candidates drifting when another
  paper was registered; a migration race; signed redirect URLs persisted as references; a failed local attach
  throttling acquisition; unbounded source preparation. Each has a regression test.

## 2026-10-03 (bev-decider / Lumma-fev)

- **bev-decider-0.4B** (2048-token chunk arm, its documented limit): AUC
  0.671 — below K2's 0.814 — but zero-FP at 0.99 (3/3) and it is the first
  LOCAL engine to correctly reject the numeric fabrication pair (0.338 on
  "2,400 vs 240"). Never refutes. CC-BY-NC-4.0: benchmark-only.
- **Lumma-fev-0.6b REJECTED**: AUC 0.449 whole / 0.456 chunked — below
  chance in both modes; the card's own calibration warning confirmed on our
  distribution. The 4B sibling remains untested.

## 2026-10-03 (engine usage audit — Laya / Julia-1)

- **Independent surgical audit of both rejected local engines** (10 failing
  cases, chunks only, card + package-source ground truth). Laya: usage
  EXONERATED (card-correct, nothing truncated, ±0.0005 reproduction); root
  cause is length-dependent claim-blindness — noul collapses to a
  claim-blind "true" prior beyond ~2k chars (unrelated-claim control scores
  0.71-0.94 on full chunks, 0.013 on a trivial sentence). Julia-1: our
  prompt wording was outside its training distribution (fixing lifts
  direction-correct 1/10 to 6/10) but even in-distribution short states
  miss numeric contradictions (2,400 vs 240 → pTrue 0.57-0.99) — the 144M
  encoder rejection stands regardless of usage. Both addenda live in their
  benchmark reports.

## 2026-10-03 (OpenRouter hosted decision models)

- **Mercury Decide (inception/mercury-decide:free, System One decisions
  API) is the new primary verification engine** *(superseded: Eos has been the default since 2026-10-04)*: chunked AUC 0.998, and at
  the owner's 0.99 bar it decides 109/135 claims with 108 correct,
  ZERO false positives (99.1% decided accuracy) — fixes the numeric-
  fabrication blind spot all local models share. Free tier, 20 req/min
  (client-policy throttle in the adapter). ~typesafe/jev-latest (jev-1.13)
  is the precision specialist (0 FP everywhere, AUC 0.998 chunked, sparse
  at 0.99); span-01(-lite) is a refuter, not a verifier; K2 stays the
  local offline fallback. Chunking lifts every serious decision model —
  substrate validated. Full table: docs/benchmarks/openrouter-decision-
  models-2026-10-03.md.

## 2026-10-03 (Laya engine)

- **Laya-multilingual REJECTED for claim verification** (zero-shot, model-card
  usage: Router mode, max_len=8192): chunked AUC 0.528, over-confident
  (TRUE .858 / FALSE .850), dangerous verdicts at every reachable bar, max
  best-p 0.9745. Matches the checkpoint's own invalid-calibration-temperatures
  warning. Adapter kept (scripts/laya_decide.py, resident Router worker with
  clean sentinel retirement + drain); engine remains selectable for
  re-benchmarking fine-tuned checkpoints (laya-typed-decisions is the
  documented candidate).

## 2026-10-03 (K2-Type engine)

- **K2-Type-0.9B (jev decision server, GPU) ADOPTED as primary verification
  engine; chunked AUC 0.814 vs Julia-1 0.529/0.461.** Safe knee at 0.95:
  18 confirmations, 18/18 correct, 0 dangerous, never refutes. Default bar
  stays 0.99 pending owner call (0.95 knee documented in the benchmark
  report). Residual blind spot: numeric fabrications score high — treat
  K2 confirmations as evidence, not proof, for quantity-bearing claims.

## 2026-10-02 (goal sweep III)

- **Chunked re-benchmark (owner architecture) -- Julia-1 still fails: AUC
  0.461 chunked vs 0.529 whole-paper; fabricated claims outscore true ones
  (0.697 vs 0.666) under chunk+query too.** The chunking/pointer/cache
  subsystem is ADOPTED and kept (config/chunking.yaml + src/core/chunk.ts +
  verify/store.ts + verify/pipeline.ts + `uktub-scholar trace`;
  tokenizer-calibrated chars_per_token 2.8; registry schema v2 with additive
  v1-to-v2 migration). It is the substrate every Stage-D engine plugs into;
  the Julia-1 rejection is final under both input architectures.

- **Corrected-usage retests + external audit — rejections STAND; Stage-D
  primary candidate switched to MiniCheck** *(superseded: MiniCheck was never benchmarked and was dropped as too old on 2026-10-08)*. External best-practices study
  (HF cards, package sources, commit history, independent evals) surfaced
  two usage concerns; both retested: Julia-1 at its EVALUATED operating
  point (max_length=1024, head_length=512, abstract context) collapsed to
  P(true) ≈ 0.005 for ALL claims — but that retest also changed the
  formulation ("Passage:" prefix added), so the collapse is partly a prompt
  artifact; the STANDING evidence for Julia-1 is the auditor-validated
  24k-char benchmark (AUC 0.529 — settings, polarity, metrics, and dataset
  all verified by an independent reviewer). GLiNER condition-A (4000-char)
  was struck as invalid by the same audit (claim beyond the 512-token
  window in 135/135 rows); its rejection survives on three valid
  configurations: 1800-char run (0.533), claim-first (all-supported), and
  the DOCUMENTED schema-builder format with few-shot examples ("supported"
  at 0.93–0.996 for entailments, contradictions, and unrelated alike).
  Audit's architectural finding: neither model was trained for NLI — we
  evaluated routers on an entailment task.
  Purpose-trained tool class: **MiniCheck** (LLM-AggreFact fact-verification;
  RoBERTa-large 355M = 72.7 BAcc, Flan-T5-large 770M = 74.7, CPU-feasible) —
  primary Stage-D candidate, must pass the same 135-claim benchmark
  (AUC ≥ 0.80, decided-acc ≥ 0.90 bars in benchmarks/README.md).

- **GLiNER2.5-Decide (340M, Apache-2.0) — measured and REJECTED for claim
  verification.** Same 135-claim benchmark, best of 3 input encodings:
  accuracy 0.541 (4000-char window) / 0.533 (1800-char chunk) — at or below
  the majority baseline (0.548); it answers "supported" to 120/135 claims
  including 54 of 61 fabricated ones. Addendum in the benchmark doc. With
  Julia-1's AUC 0.529, the two-model sweep yields a finding: sub-1B
  decision/classifier encoders cannot verify scientific claims. Stage-D
  engine candidates narrowed to (a) NLI/FEVER-trained models (DeBERTa-v3
  FEVER-class, ~400 MB — fact verification is their native task, primary
  candidate) or (b) 0.5–1B instruct via llama.cpp; both rerun the benchmark.
- **AstaBrief-8B (allenai, Apache-2.0, Qwen3-8B) — ADOPTED as the
  host-side "Writer" companion for report synthesis (roadmap; not bundled).**
  Single-pass cited scientific reports from a query + tagged excerpts;
  distilled from the multi-step Asta ScholarQA pipeline (86.3 vs 87.6 avg on
  ScholarQA-CS2 — near-pipeline quality at one pass). Caveats recorded:
  citation precision 55% (its own eval) — our registry-first workflow
  (citations only from registered papers) is the corrective; ~5 GB Q4 and
  minutes per report on CPU — fine for a writer, wrong for verdicts (the
  fast-model constraint applies to claim verification only). Trigger: first
  report-writing session; integration = our search/register tools feed
  tagged excerpts, AstaBrief drafts, our compile tool finalizes.
- **ScholarQA (Asta) — the pipeline pattern is prior art** for the future
  report workflow (retrieve → group → write → cite); AstaBrief is its
  single-pass distillation. No code adopted.

## 2026-10-02 (goal sweep II)

- **Julia-1 — FINAL after the comprehensive 135-claim benchmark
  (docs/benchmarks/claim-verification-julia1-2026-10-02.md): REJECTED, AUC
  0.529.** Independent subagent authored 135 ground-truthed claims (74
  TRUE / 61 FALSE) from 14 real papers in `test_papers/`; orchestrator
  verified every evidence quote verbatim (135/135 passed); all claims run
  through 6 resident Julia-1 processes over 24k-char paper contexts. Mean
  P(true): TRUE 0.505 vs FALSE 0.487 — no discrimination (coin flip) on
  real research claims. At the owner's 0.99 bar: 132/135 unverified, 3
  correct refutations, 0 dangerous. At any lower bar: decided accuracy
  0.42–0.54 with up to 62 dangerous errors. Rejected as verdict engine
  AND as triage/ranking filter (AUC 0.53 kills ranking too). ClaimGen +
  the harness are reusable: any Stage-D engine (llama.cpp small generative,
  0.5–1B Q4) reruns the same benchmark for a like-for-like comparison
  before adoption.

- **Local decision model — DEFERRAL LIFTED, ADOPT NOW (owner directive,
  staged build). Stages A+B SHIPPED; Stage C/D measured: JULIA-1 REJECTED
  as verdict engine — confirmed with the owner's context hypothesis TESTED.**
  Engine-agnostic core shipped (`src/core/verify/claim.ts`):
  `verifyClaim`/`verifyClaims` over one resident engine process, verdict
  mapping at `VERIFY_MIN_CONFIDENCE` (default 0.99), `VERIFY_ENGINE_MISSING`
  refusal, `scripts/julia_decide.py` resident runner. Engine facts: Julia-1
  (Apache-2.0, 144.3M encoder, no GGUF — llama.cpp cannot run it; own
  Python/torch package, host-side).

  **Measurements (all live, 2026-10-02):**
  - *Context sweep (real SIMP paper, 3 formulations × 4 context sizes × 4
    claims):* context is the single biggest factor — title-only chunks gave
    separation −0.03 to +0.07 (the Stage C chunk was a measurement flaw;
    owner hypothesis confirmed); real abstract/full context with the
    F1 formulation (claim in instructions, explicit entailment criteria)
    gave +0.50/+0.54. Formulation matters as much: F2 (claim in criteria)
    collapses on real context; F3 (minimal) says "true" to everything.
  - *Real-paper verification with real OpenAlex abstracts:* TRUE claims
    P(true) 0.761–0.904; a FABRICATED claim scored **0.975** — above both
    true claims. Distributions overlap; no threshold separates them (0.99
    bar → everything unverified; any lower bar → the fabricated claim is
    confirmed).
  - *Whole-paper cost:* the encoder truncates at its window — 6000 chars
    cost the same as the abstract (≈340 ms per 4-question call, ~25–95 ms
    per verdict). The SPEED goal is met; the QUALITY goal is not.
  - *Contrastive calibration (own passage vs decoy passage):* a TRUE claim
    scored HIGHER on the decoy (margin −0.143) while the fabricated claim
    scored +0.543 on one paper and −0.543 on the other — scores are a
    lexical-overlap prior, not source-bound entailment. No absolute
    threshold, margin rule, or mix reaches 99% precision from this signal.

  **Final verdict: Julia-1 is a fast lexical triage signal (usable for
  ranking chunks), not a claim verifier. The ClaimEngine interface,
  resident-batch design, and refusal path survive; the verdict-engine seat
  is open.** Stage D candidate respecting the fast/small constraint: a
  0.5–1B instruct model via llama.cpp (Q4 GGUF ≈ 400–800 MB, far below the
  rejected 1.9 GB; ~1–3 s per CPU verdict at 24 cores) — measured against
  the same 4-pair real-paper benchmark before any adoption. The
  doc-workflow reviewer agent stays deferred until a passing engine exists.

- **academic-pptx-skill (MIT, 1.1k★) — ADOPTED as the content-discipline
  template for slide deliverables.** Action titles (takeaway sentences),
  situation→complication→resolution argument structure, ghost-deck test,
  one-exhibit-per-results-slide, citation standards on every borrowed figure,
  Q&A-ending conclusions slide. Complements open-slide (runtime) — this is
  the "what slides must say" layer. Recorded in BACKLOG's slides entry;
  MIT, NOTICE-attribute when ported.
- **WeKnora (Tencent, 31.8k★, MIT+exceptions, Go platform) — NOT adopted as
  a component; recorded as prior art for the deferred evidence-retrieval
  design.** It is a self-hosted RAG platform (documents → queryable RAG +
  reasoning agent + wiki) — adopting it would add a second service plane to
  a single-folder local package. Our minimal path stays SQLite-FTS5-first;
  the WeKnora-inspired pattern (chunk retrieval → cheap relevance filter →
  claim-vs-passage verification) is the design sketch for when evidence
  retrieval unrolls, with a local CPU-class decision model (owner proposal:
  Julia-1) as the chunk filter / claim checker. **Decision model DEFERRED**
  by owner instruction; model choice re-evaluated at build time.
- **OpenMed v2.3.0 — still not adoptable (clinical SDK), one transferable
  idea already embodied.** The release (253 commits) is a local-first
  healthcare SDK across Python/JS/Swift/Android: redaction, clinical
  evidence tables, abstention, GGUF/TensorRT runtimes. Domain remains
  clinical-informatics; the transferable concept — typed abstention (a
  typed "I don't know" outcome instead of a guess) — is exactly our
  refusal/warning discipline, already shipped. Revisit only if a
  biomedical-research session type appears.
- **karpathy/autoresearch (97k★, NO LICENSE) — PATTERN ADOPTED, CODE NOT
  ADOPTABLE.** It is an autonomous LLM-training experiment loop (agent edits
  `train.py`, 5-minute fixed budget, keep-or-discard by val_bpb; human owns
  `program.md`), not a general simulation/coding harness, and it ships
  without a license — redistributing its code into this AGPL repo is not
  permitted. What we adopt is the pattern, which joins our RRSI-derived
  discipline: budget-bounded keep-or-discard experiment loops with a single
  metric, and human-owned instruction files over agent-edited code.
  Simulation/coding capabilities themselves come from the OpenScience
  library (physics, quantum, coding categories), ported per BACKLOG
  triggers — recorded there as the computational-experiments entry.

## 2026-10-02

- **Slide deliverable runtimes surveyed — open-slide stays primary, Slidev
  noted as the Markdown-flavoured alternative.** slideblocks-skill (MIT, 71★)
  wraps Slidev but has been dormant since its creation month; recorded in
  BACKLOG as an alternative runtime, chosen per session (React-canvas vs
  Markdown decks).
- **Paper Office (paperinstruments.com, MIT-skilled Python packages) —
  recorded as the evidence-backed alternative for office deliverables.**
  Benchmark: 92.5% task pass vs 80.7% upstream python-docx/pptx/openpyxl and
  69.5% Anthropic office skills. Companion-tier like GenOffice; choice per
  session (interactive suite vs agent-scripted manipulation). Python
  host-side only — our runtime stays zero-Python.
- **LiteParse (run-llama, 12.8k★, Apache-2.0, Rust with npm/wasm) —
  appropriate as the host-side companion for document INGESTION** (parsing
  the user's own PDFs/docs the agent must read), not for manipulation; its
  official skill ships via `npx skills add run-llama/llamaparse-agent-skills
  --skill liteparse`. Trigger recorded in BACKLOG; never bundled (would break
  the zero-dependency runtime).
- **figures4papers (ChenLiu-1996, 7.9k★) — reference-only for
  `paper-figures`.** Publication-figure patterns (bar comparisons,
  composition breakdowns) are exactly the target quality bar, but the
  license is NOASSERTION (custom cite terms) — read for patterns, port
  nothing without permission. Noted in BACKLOG with the caveat.
- **Registry guard + project-conventions snippet — SHIPPED (owner-authorized,
  pulled ahead of the backlog triggers).** `pi.on("tool_call")` guard makes
  `.registry/**` package-owned (no agent tool, read or write) and `refs/**`
  agent-read-only against the host's own tools; pure classification in
  `src/core/guard.ts`, honest bash-scan limits documented. Optional
  `AGENTS.md`/`SYSTEM.md` snippet documented in README (never auto-written
  by `init`). Verified: 124 offline specs + live sandbox (blocked
  `sqlite3 .registry/...` verbatim; benign bash passed).
- **open-slide (MIT, Vercel OSS) — deferred to backlog as the slides
  runtime.** Agent-native React deck framework (fixed 1920×1080 canvas,
  present mode, ships its own authoring skills). Not bundled: no slide
  sessions yet, and a generated deck is its own project, not package
  surface. Trigger + pattern recorded in `docs/BACKLOG.md`; content-guidance
  template when triggered: OpenScience `writing/scientific-slides`.
- **Backlog consolidated** — all deferred capabilities now live in
  `docs/BACKLOG.md` with trigger conditions (companions: open-slide,
  GenOffice, evident-charts; package capabilities: Europe PMC,
  paper-figures, grants, host adapters; owner-gated: PDF acquisition,
  evidence retrieval, UI workbench; long arc: RRSI-style evolution).

- **First skill folds — ADOPTED (owner-authorized).** `uktub-research` gains
  "Running a review" (mode agreement, bounded loop, dedup, load-bearing
  reading, provenance marking) and the claim-source rule, adapted from
  OpenScience `core/literature-review` + `core/sources` (ideas, not text;
  NOTICE updated). This opens the evidence gate by owner instruction; future
  folds still wait on real sessions.
- **GenOffice (genspark-ai, Apache-2.0) — NOT our UI; recommended companion
  for office-format deliverables.** It is an AI office-document suite
  (.docx/.xlsx/.pptx/PDF editors with an agent panel + CLI/skill/MCP), not a
  research workbench — no registry/bibliography/project concept, so adopting
  it as the package UI would be the wrong shape. Our future UI stays the
  dedicated thin workbench (VISION). When grant/collaboration sessions need
  .docx/.pptx deliverables for co-authors, recommend GenOffice host-side
  (same pattern as evident-charts). Reopen as embedded UI only if it gains a
  project/workspace concept.
- **OpenScience (synthetic-sciences, Apache-2.0 repo / MIT skills) — THE
  adoption library for the widened scope.** ~400 skills by domain; ours to
  port piecemeal with NOTICE attribution as capabilities earn their place:
  - Fits current surface (candidate skill folds, awaiting the real-session
    evidence gate): `core/literature-review` (fixed-budget retrieval loop,
    dedup, load-bearing-paper reading, PRISMA escalation),
    `core/sources` (claim→source audit, provenance table),
    `core/citations` (fabricated/mismatched .bib audits — mostly covered by
    register + sync-bib).
  - Roadmap templates: `research/research-grants` (NSF/NIH/DOE/DARPA
    proposals — the grant direction), `core/figures` + `scientific-visualization`
    (paper-figures skill, alongside evident-charts), `core/peer-review`,
    `core/paper-writing`, `writing/latex-posters`, `writing/scientific-slides`,
    `research/statistical-power`, `research/experimental-design`.
  - Later (connector patterns): `databases/*` for the Europe PMC era.
  - Never: cloud-compute, ml-training/inference, llm-tools, quantum,
    biology/chemistry domains — specialist capability, not harness.
- **Scope: all research kinds — ADOPTED as direction.** The package is not a
  literature-review tool; figures, data analysis, and grant-proposal support
  are in-arc, adopted one capability at a time as real sessions demand them.
- **evident-charts (rhiever, MIT) — RECOMMENDED COMPANION, not bundled.** One
  week old and evolving fast; vendoring would freeze it and bloat the
  package. Users install it host-side (`npx skills add rhiever/evident-charts`)
  when they need charts. Reopen vendoring (or write our own
  `paper-figures` skill) when figure sessions accumulate — its rule
  structure (code-checkable first, vision review where code can't) is the
  template.

- **Sandbox-by-default for agent sessions — REJECTED.** Opt-in stays. Evidence:
  Gemini CLI, Aider, and Pi all default sandbox off; default-on frameworks
  (Codex, OpenHands) pair it with approval ladders that belong to the host
  (Pi), not to a package. Reopen only if a real session shows unisolated
  agents harming users at scale.
- **Parallel/persistent wrapper session store — REJECTED as a *new* store;
  KEPT as a bind of Pi's store.** Pi owns sessions (cwd-keyed); the sandbox
  mounts a host directory for Pi's own store so transcripts survive container
  exits. Dropping it would destroy researcher transcripts — more restriction,
  not less. Reopen only if Pi changes its session model.
- **Global project index — REJECTED.** Filesystem scan is the maintained
  pattern (DVC up-scan, Quarto marker); global-DB registries couple projects
  (Zotero's lesson). Nested projects are refused by `init`.
- **Two-way references.bib sync — REJECTED, permanently.** A .bib carries no
  merge semantics; the registry is the source of truth, `sync-bib` renders
  one-way (Better BibTeX maintainer's argument applies verbatim). Reopen only
  if a maintained standard adds merge metadata to BibTeX.
- **Bundling a LaTeX engine — REJECTED.** The engine is the user's (PATH or
  `UKTUB_TECTONIC_BIN`); the package owns detection, invocation, outdir, and
  diagnostics. The sandbox image pins Tectonic 0.15.0 for zero-install
  sandbox use. Reopen only if optionalDependencies distribution proves
  painless and users ask for it.
- **Trust model — ADOPTED.** The CLI/TUI user is technical and trusted;
  conventions over enforcement; a future UI layer may enforce more for
  non-technical users, above the package, never inside it.
