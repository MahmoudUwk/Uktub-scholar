# Backlog — correctness risks and deferred capabilities

Open correctness risks and deferred work; current behavior is in [README](../README.md).
Each item names its trigger and source/template. Historical rationale lives in
[DECISIONS.md](DECISIONS.md); attribution rules in [NOTICE.md](../NOTICE.md).

## Roadmap — owner-directed, in build order (2026-10-04)

Every step is behavior-first: tests written and run red, implemented, then green, then verified on the
real corpus and recorded. Status is updated in place.

1. **Section-aware chunking — done (2026-10-04).** `splitBySections` (property- and mutation-tested), TEI heads
   and PDF heading detection, schema v4, default `boundary: section` at 512 tokens
   ([evidence](benchmarks/evidence-chunking-sections-2026-10-04.md); [decision](DECISIONS.md)). Open items:
   - PDF heading detector residue on the 14 real PDFs: ≈ 7 false positives in ≈ 300 headings (three pseudocode
     lines with a bare line number, one affiliation footnote, two numbered list items, one notes line). They
     add a wrong boundary/label, never break a pointer. A font-size/boldness pass over `pdf.js` text items
     (needs our own item-level extraction) would remove most; build it only if real sessions show harm.
   - TEI levels: GROBID's `n` attribute is dropped by the parser setting, so every TEI heading is level 1
     (levels are not consumed by chunking). Live TEI extraction is still unexercised (needs the OpenAlex key).
   - Scanned/multi-column layouts: a heading split across lines is not detected; headings are lost, text is not.
   - Exhaustive verification at 512 costs ≈ 1.7× the judgments of a 1,024 window; pass a `query` (5.0
     judgments per claim measured) for large corpora. Consider defaulting the locator to the claim.
2. **Local model runtime: llama.cpp for embeddings (and any GGUF decision model) — decision open.**
   The retrieval code is runtime-agnostic (any OpenAI-compatible `/v1/embeddings` server, configured with
   `UKTUB_EMBED_URL`); what is undecided is who provides the server. Researched (Hermes, 2026-10-04):
   (A) bundling a binary in the package is only viable for a CPU build (≈ 5 MB) — a CUDA build is ≈ 370 MB;
   (B) a pinned official `llama-server` release asset, fetched on first use with a checked sha256 into the user's
   data directory, supervised as a child process (crash isolation from the agent host), with the GGUF fetched
   the same way from a lock file (recommended); (C) the `node-llama-cpp` npm binding (single maintainer, install
   scripts, source-build fallback; opt-in in-process path for the CLI only); (D) a user-installed llama.cpp or
   Ollama as an explicit override. Decision-2.0 Eos is a custom Qwen backbone plus a trained head and is not a
   stock llama.cpp architecture; it stays on its Python worker (a logprob-of-"true" hack on the backbone GGUF is
   not the trained head and was not adopted). Model terms: EmbeddingGemma is under the Gemma terms (carry the
   terms and notice if redistributed), so the package should fetch rather than bundle the 334 MB file; the
   file named by the owner lacks the dense modules (see DECISIONS), so the pinned file needs a stated provenance
   (third-party conversion with a measured parity gate, or our own conversion from the gated Google weights).
3. **RAG (exploratory retrieval) — done at the code level (2026-10-04).** `search_passages` (Pi tool and CLI
   `search`), hybrid FTS5 + vector + RRF k = 60, lexical fallback, containment, schema v5 vector cache;
   measured ([report](benchmarks/rag-search-section-512-2026-10-04.md)). Open items: runtime packaging (item 2);
   weighted or reranked fusion if a later measurement shows it pays (equal-weight RRF trails the better single
   leg on the extremes); the Pi TUI widget is not launched; the vector leg has not been measured on a corpus
   larger than 14 papers (the exact scan is O(passages), 3 ms at 700 passages).
4. **OCR fallback for scanned PDFs** (optional; LiteParse was reviewed and not adopted as the primary parser).
5. **Full-text download for open-access papers** (deferred by the owner): Content API with the existing key,
   other lawful routes.
6. **Citation node-like system — the very end.** Working reading, to confirm with the owner: a graph whose
   nodes are claims, supporting passages (pointers) and registered papers (citekeys), edges "supported by" /
   "cites", so each manuscript sentence is traceable to exact evidence.

## Owner-directed notes (2026-10-04)

- **Full-text download for open-access papers — deferred.** The working corpus is the owner's
  local library (`../test_papers`, attached with `paper_registry` `attach_source`). Complicated
  OpenAlex/OA acquisition (Content API with the key already in `UktubAI_Agentic/.env`, other
  lawful routes) waits until the owner re-opens it. Only direct `pdf_url` downloads work today.
- **Citation node-like system — build at the very end.** Owner wording: "a citation node-like
  system". Working reading (to confirm with the owner before building): a graph whose nodes are
  claims, supporting passages (the `doi@revision#start-end` pointers) and registered papers
  (citekeys), with edges for "supported by" and "cites", so every sentence of a manuscript is
  traceable to the exact evidence. The pointer and run tables already hold the raw material.
- **RAG (exploratory retrieval) — not implemented and not planned in this package's docs.**
  The retrieval half exists as a by-product: one `chunks` table with an external-content FTS5/BM25
  index, shared by claim verification. The owner's own `GRC_Agent` project shows the pattern to
  reuse: heading-chunked text, FTS5 plus `sqlite-vec` vectors, Reciprocal Rank Fusion (k = 60), a
  lexical fallback when no embedder is installed, and EmbeddingGemma-300m (GGUF) served by a
  `llama-server` over a private UNIX socket, whose provisioning code was itself ported from
  `whatisit-nl2sh`. Next step if wanted: add the vector leg beside FTS5 and measure it on held-out
  papers before adopting it.
- **Section-aware chunking shared by RAG and verification — design note, needs a very reliable
  splitter.** Idea: chunk by headings/sections, keep a section whole when it fits the engine's
  window, split only the oversize ones. Fits the data model (a chunk is already a span of captured
  text; add a section label). Sources of structure: GROBID TEI heads (already parsed, reliable),
  font-size/boldness from `pdf.js` text items (needs our own item-level pass; `unpdf` returns
  flat text), paragraphs as the fallback. Required tests: every character in exactly one chunk,
  offsets slice back exactly, deterministic, no chunk over the cap, headings never orphaned from
  their first paragraph, golden sections on real papers. Literature check (Hermes, 2026-10-04): a
  single size is not standard for both jobs — retrieval units of about 256–512 tokens, verification
  windows of about 1,024 tokens expanded around the hit at query time; our own sweep is in DECISIONS.
- **PDF parser: LiteParse (`run-llama/liteparse`) is not used.** Verdict from the research
  agent: do not switch. Native Rust/PDFium addon with a process-global lock, OCR on by default,
  no character offsets into its text (we would have to rebuild them), equations score 0, heavy
  version churn. Possible later as an optional scanned-PDF fallback only. `whatisit-nl2sh` is a
  natural-language-to-shell tool and is unrelated to retrieval or entailment.

## Evidence workflow — verified limits and next steps

Each item was observed (offline test, live smoke or benchmark), not assumed.

- **Key-less automatic acquisition mostly finds nothing.** Live OpenAlex records for a
  gold-OA paper (PeerJ) and an arXiv preprint carried landing pages only — no direct
  `pdf_url`, no Content API copy — so `verify_claim` reports `no_open_copy`. Papers whose
  record has a `pdf_url` work (a J-STAGE PDF downloaded, parsed and identity-checked live);
  some publishers refuse the download (`download_failed`). Everything else needs
  `paper_registry` `attach_source` or an `OPENALEX_API_KEY`. Landing-page scraping and
  synthesized URLs stay forbidden (workspace rule). Trigger to revisit: owner approves a
  further lawful route.
- **Content API tier and TEI path are unexercised live.** Offline fixtures cover them; a live
  run costs about $0.01 per download and needs the owner's key. Run once before relying on it.
- **Identity check can refuse a legitimate file.** The registered title must appear as an
  ordered phrase on the first page (or the DOI / arXiv stamp must). A published title that
  differs a lot from the PDF's title is refused, and there is no override. Trigger: the first
  real refusal of a correct file.
- **Extraction is flat.** `unpdf` text has one "paragraph" per page, flattens tables, and has
  no OCR; two-column order and tables were checked on 14 papers only. A scanned PDF is refused.
- **Locator is lexical.** FTS5/BM25 over claim words; recall was measured with the claim itself
  as the locator, which flatters real agent queries. With the default 8,192-token window there
  are 3–4 chunks per paper, so a locator prunes nothing (see the retrieval report). Dense or
  hybrid retrieval only after held-out evidence shows a recall gap that matters.
- **Engines.** Decision 2.0 Eos is measured and usable behind the `llama-cpp` path
  (`scripts/system-one-server.ts`) but is not an in-package adapter: that adapter would need
  per-row refusal semantics (`workerEngine` fails a whole batch on one refused row). Kai never
  exceeds P 0.931, so it supports nothing at the 0.99 bar. Neither is adopted.
- **Judgment cache has no eviction.** `claim_judgments` grows with use (rows are small).
  `verify_runs` and their evidence expire after 24 hours.
- **Pointer-only support.** When the engine supports a whole chunk but no excerpt-sized passage
  does, the exact chunk span is returned without text. Frequency in real use is unmeasured.
- **Low-severity findings of the independent code review, accepted for now.** A hardlink to
  `registry.db` inside the project passes path confinement (its bytes then fail as
  `not_a_document`, nothing leaks); the file-size check and the read are not atomic (TOCTOU);
  model identity from `/v1/models` has no size or hash, so replacing weights under the same
  name reuses cached judgments (declare `UKTUB_VERIFY_MODEL_ID` to control it); the engine-error
  echo guard needs 24 contiguous characters of passage text to trigger. Revisit if a real
  session or threat model makes any of them matter.
- **Skill discovery.** Package metadata declares extensions but not `skills/uktub-research`;
  check Pi package discovery before assuming the skill installs with the extension.

## Deliverable companions (host-side, never bundled)

- **Slides — open-slide runtime** (MIT, github.com/open-slide/open-slide).
  Agent-written React decks on a fixed 1920×1080 canvas with present mode;
  ships `/create-slide` + `/slide-authoring` skills. Alternative runtime:
  **Slidev** (Markdown decks) via slideblocks-skill (MIT) — dormant upstream,
  prefer per session: React-canvas polish vs Markdown simplicity. For
  .pptx-flavoured academic decks, **academic-pptx-skill** (MIT,
  Gabberflast/academic-pptx-skill) is the content-discipline template:
  action titles, argument structure, ghost-deck test, exhibit/citation
  standards. Trigger: a real session asks for a talk/deck from a registered
  paper set. Content guidance template: OpenScience
  `writing/scientific-slides`.
- **Office deliverables — GenOffice** (Apache-2.0, genspark-ai/genoffice) for
  interactive editing; **Paper Office** (paperinstruments.com, paper-docx/
  paper-pptx/paper-xlsx + skills) for agent-scripted manipulation —
  benchmarked 92.5% vs 80.7% upstream / 69.5% Anthropic skills. Trigger:
  grant/collaboration sessions need real .docx/.pptx. Not our UI (DECISIONS).
- **Charts — evident-charts** (MIT, rhiever/evident-charts). Trigger: chart
  sessions. Already documented in README.
- **Document ingestion — LiteParse** (Apache-2.0, run-llama/liteparse; npm
  `@llamaindex/liteparse`). Rust parser (PDF/docs → text/markdown) for
  reading the USER'S OWN documents the agent must consume (drafts,
  supplementary PDFs); official skill:
  `npx skills add run-llama/llamaparse-agent-skills --skill liteparse`.
  Trigger: sessions where the agent must read non-LaTeX documents in the
  project. Ingestion only — not manipulation; never bundled (zero-dependency
  runtime stays).

## Package capabilities (build here when triggered)

- **Europe PMC source** — trigger: sessions need PubMed/biomedical coverage.
  Patterns: OpenScience `databases/pubmed-database`, workspace `europepmc`
  skill; Unpaywall is forbidden (workspace rule) — OA via OpenAlex only.
- **`paper-figures` skill** — publication-grade figures. Trigger: figure
  sessions accumulate. Templates: evident-charts (rule structure) + OpenScience
  `core/figures`/`scientific-visualization` (LaTeX/vector specifics ours).
  Reference-only (NOASSERTION license — patterns, not code):
  github.com/ChenLiu-1996/figures4papers.
- **Grant-proposal support** — trigger: proposal sessions. Template:
  OpenScience `research/research-grants` (NSF/NIH/DOE/DARPA structure,
  review criteria, broader impacts).
- **Host adapters (Claude Code, Codex)** — MCP wrapper around `src/core`.
  Trigger: a second host user community appears; core stays host-agnostic
  until then (import-allowlist test already enforces the boundary).

## Owner-gated (separate approval required)

- **Evidence-quality adoption of a local engine** — Eos is the first local model measured
  with usable support precision at the 0.99 bar (see
  [benchmarks](../benchmarks/README.md) and the dated evidence reports). Making it a default
  or an in-package adapter needs an owner decision on coverage (recall 0.50 at 0.99), cost and
  license review. Rejected engines remain selectable for experiments.
- **Report writer (companion, roadmap)** — AstaBrief-8B (allenai,
  Apache-2.0, Qwen3-8B): single-pass cited reports from query + tagged
  excerpts, distilled from Asta ScholarQA (86.3 vs 87.6 avg on CS2 —
  near-pipeline quality in one pass). Host-side via llama.cpp (~5 GB Q4;
  minutes/report on CPU — fine for a writer, wrong for verdicts). Caveat
  from its own eval: citation precision 55% — our registry-first citation
  rule is the corrective. Trigger: first report-writing session; flow =
  our search/register tools feed tagged excerpts → AstaBrief drafts →
  compile_document finalizes. Pipeline prior art: Asta ScholarQA.

- **Evidence retrieval beyond FTS5** — dense/hybrid/reranking only when held-out evidence
  shows lexical recall is the bottleneck. WeKnora (Tencent, MIT+exceptions) is prior art /
  optional self-hosted service, never a package component.
- **UI workbench for non-technical users** — thin layer ABOVE the package;
  enforcement lives there, never inside. Trigger: non-technical user demand.

## Computational experiments (simulation & coding sessions)

- **Pattern (adopted): autoresearch-style autonomous experiment loops** —
  budget-bounded keep-or-discard iterations against one metric; human-owned
  `program.md` instructions, agent-edited code file; every experiment logged
  with its verdict (joins the RRSI discipline in `docs/DECISIONS.md`). The
  source repo carries NO license — pattern only, no code.
- **Capabilities (build here when triggered):** port from the OpenScience
  library per demand — `physics` (pde-solver, uncertainty-and-units,
  symbolic-regression), `quantum` (qiskit, pennylane), `coding`
  (exploratory-data-analysis, statistical-analysis, scikit-learn, sympy).
  Trigger: the first session asking the package to run or verify a
  simulation / computational analysis; each capability lands as its own
  skill with NOTICE attribution.

## Research infrastructure (long arc)

- **RRSI-style harness evolution** — trigger: a corpus of real user sessions
  large enough to evolve against without overfitting (paper:
  arxiv.org/abs/2609.24972). Until then the decision log + evidence gates are
  the manual version of it.
