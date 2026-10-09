# Decision log

Why things are the way they are, grouped by area, newest first within each. [README](../README.md) owns current behavior,
[BACKLOG](BACKLOG.md) owns open work, raw evidence lives in [docs/benchmarks/](benchmarks/) and [docs/reviews/](reviews/).
Entries marked *superseded* are history. Reopen a rejected proposal only with new evidence. A benchmark rejection does not
remove a selectable adapter.

**Current verifier:** Decision 2.0 Eos 0.8B, local (owner, 2026-10-04), score bar 0.99 (a cut on the engine's raw output, not
a calibrated probability). Canonical measurement, [claim-verification-v1, 135 claims, Policy A paragraph](benchmarks/decision2-eos+chunks-policyA-paragraph-claim-verification-v1-2026-10-04.md):
AUC 0.968, 38 supports at 0.99 (37 true, 1 false), precision 0.97, recall 0.50. The verifier-model search is closed (2026-10-08).

## Verification engines

**2026-10-08. Vela 2.0 (0.3B and 0.8B) tested as an Eos replacement: not adopted.** Owner: test `vllm-sr/Vela-2.0-0.3B`; if it
works, remove Eos. It does not, so Eos stays and nothing was removed. Same Policy A paragraph settings as the Eos run (43 chunks,
416 judgments, bar 0.99).

| | Vela 0.3B (ONNX, CPU, rev `d6f03aa9baca`) | Vela 0.8B (torch, GPU, rev `326b01d81f61`) | Eos 0.8B |
|---|---|---|---|
| AUC (tie-corrected) | 0.866 | 0.884 | 0.968 |
| Supports at 0.99 (true / false) | 5 (5 / 0) | 0 | 38 (37 / 1) |
| Recall at 0.99 | 0.07 | 0 | 0.50 |
| Wall time | 2092 s CPU | 370 s GPU | 355 s GPU |

With the bar moved until each makes one false support, the 0.3B returns about two thirds of what Eos returns. The 0.8B reaches
precision 0.94 at recall 0.59 (bar 0.85) where Eos has recall 0.85 at precision 0.94; at zero false supports it returns 32
true claims against Eos's 23, too small a difference to matter next to the AUC gap. It is a routing and hallucination-span
encoder fine-tuned from the Kai trunk (Kai also scored below Eos) and is not much smaller on disk (fp16 ONNX 623 MB, fp32
1.24 GB; Eos 8-bit ONNX 717 MB). Limits: one protocol (the trained hallucination question, claim as the answer, P(supported) =
1 minus the highest unsupported-word probability), one benchmark. Its tokenizer carries the Gemma Terms of Use (record in
`NOTICE.md` if ever adopted). The `vela` adapter (`scripts/vela_decide.py`) stays selectable; removing it is about ten minutes.
Reports: [0.3B](benchmarks/vela-0.3B+chunks-policyA-paragraph-claim-verification-v1-2026-10-08.md),
[0.8B](benchmarks/vela-0.8B+chunks-policyA-paragraph-claim-verification-v1-2026-10-08.md). Also not run: Intern-Decision-0.8B and
Kev-0.8b (the Eos card ranks both below it); MiniCheck was dropped as too old (owner, "no older model families").

**2026-10-04. Eos is the default engine (owner).** An in-package resident worker on a pinned reviewed revision, one worker per
process, never keeping the host alive while idle but awaited while a request is in flight (two dogfooding defects, a CLI hang
and a silent exit on the second call, have regression tests). Decision 2.0 on claim-verification-v1 ([status](benchmarks/decision2-evaluation-status-2026-10-04.md)):
chunked AUC Kai 0.955, Eos 0.968 (difference not significant); Kai supports nothing at 0.99 (probabilities never exceed
0.931). Eos also runs behind the `llama-cpp` path via `scripts/system-one-server.ts`. `eos-onnx` (8-bit, no PyTorch) matches the
torch worker on 450 judgments at the bar; 4-bit exports are not viable ([parity](benchmarks/eos-onnx-parity-2026-10-05.md)).
OpenRouter Mercury Decide stays selectable and is the best measured hosted option (chunked AUC 0.998; 109 of 135 decided, 108
correct, zero false positives at 0.99; free tier throttled at 20 requests per minute).
~typesafe/jev-latest is a precision specialist, span-01 a refuter, K2 a local alternative. *Superseded entries:* Mercury as
"new primary" (2026-10-03), K2-Type adopted as primary (2026-10-03, AUC 0.814, safe knee at 0.95, numeric fabrications score
high).

**Rejected engines (all kept as adapters).**
- **Julia-1** (144M encoder, Apache-2.0): AUC 0.529 whole-paper, 0.461 chunked on the 135-claim benchmark; fabricated claims
  outscore true ones. Fast lexical triage signal, not a verifier; rejected as verdict engine and as ranking filter. A usage audit
  found our prompt wording was outside its training distribution (fixing it lifts direction-correct 1 to 6 of 10), but numeric
  contradictions still pass, so the rejection stands. The chunking, pointer and cache substrate it forced was adopted.
- **GLiNER2.5-Decide** (340M): accuracy 0.541 and 0.533, at or below the majority baseline (0.548); "supported" for 120 of 135
  claims including 54 of 61 fabricated ones. Neither GLiNER nor Julia was trained for NLI; sub-1B routers cannot verify scientific claims.
- **Laya-multilingual**: chunked AUC 0.528, over-confident; usage exonerated (±0.0005 reproduction), the cause is claim-blindness beyond about 2k characters.
- **bev-decider-0.4B**: AUC 0.671, zero false positives at 0.99 (3 of 3), rejects the numeric fabrication pair; CC-BY-NC, benchmark only.
- **Lumma-fev-0.6b**: AUC 0.449 whole and 0.456 chunked, below chance.
- **Never a verdict that a claim is false.** The two-sided verdict helpers were deleted; "no support found" is not refutation.

## Evidence, provenance and containment (2026-10-04)

- **Two tools, one claim.** `paper_registry` replaces register/list; `verify_claim` replaces the claim-array tool. The agent never
  loads papers or writes chunks and receives only supporting passages with exact pointers.
- **Provenance.** One captured text per ready paper; revision = H(source digest, extraction identity, text). Pointers are
  `doi@revision#start-end` (zero-based, end-exclusive UTF-16 offsets); a replaced source gets a new revision and old pointers
  resolve as stale. Evidence is stored with the decision that produced it (model identity, protocol, bar) so it survives cache
  loss, and is freshness-checked inside the write transaction. Chunk ids are bound to the paper (one document can back two papers).
- **Judgment reuse needs an effective identity**: key = claim, passage, model identity, protocol (the bar is applied on read).
  Hosted: the model slug. Local: whatever `/v1/models` reports, else no reuse unless declared with `UKTUB_VERIFY_MODEL_ID`.
- **Two-stage judgment.** A stage-1 chunk that supports the claim is localized into passages of about 1,200 characters, each
  re-judged; only passages that pass the bar are returned. Unfinished localization is continuable work, never a vague pointer.
- **Containment (client policy per output).** Excerpt at most 1,500 characters; withheld when it is half of its source or more;
  at most 25 % of one source released across a run; pointers always kept; delivery exactly once.
- **Identity of an acquired document** must be attested on the first page (about 6,000 characters): the DOI, an arXiv stamp, or the
  registered title as an ordered near-contiguous phrase (at least 85 %). Unordered word overlap and identifiers in reference lists
  each admitted a wrong paper in a live smoke.
- **Parsers.** `unpdf` over `pdftotext`: `pdftotext` recovers 75/75 gold quotes on 8 papers and `unpdf` 60/75 (73/75 after
  undoing line-end hyphenation; the quotes were authored from `pdftotext`), but `unpdf` is pure JS and grounds per-page text.
  LiteParse is not a replacement (native addon with a process-global lock, OCR on by default, no character offsets). TEI uses
  `fast-xml-parser` with entities off and DOCTYPE refused. No OCR: image-only PDFs are refused.
- **Schema.** Version 3 migrates explicitly (v2's unsourced rows are dropped after a `.v2.bak` copy because they cannot be
  evidence); a foreign or newer file is refused without being opened for write. Current schema is 5.
- **Reviews.** The independent reviews fixed paging that skipped or duplicated evidence, a direct pointer path that could read
  arbitrary spans, continuations that forgot limitations, drifting candidates, a migration race, uncapped TEI heads leaking past
  containment, surrogate-pair cuts and more; each has a regression test ([review](reviews/review-2026-10-04.md),
  [re-measurement](reviews/review-2026-10-05.md)). An independent LLM review of 94 returned excerpts: 45/45 overlapping the gold
  quote support, 26 support and 18 partial elsewhere in the paper, 5 excerpts returned for 122 FALSE-claim runs (about 3 %),
  1 of them a genuine statement ([report](benchmarks/evidence-review-2026-10-04.md)). The first review's 95.0 % Eos recall was
  not reproducible (the script divided by hard-coded counts); the re-measurement is 90.5 % recall, 95.2 % specificity, 95.0 % precision.

## Chunking and retrieval

- **Section chunks are the default (2026-10-04)**: `boundary: section`, 512 tokens, no overlap
  ([evidence](benchmarks/evidence-chunking-sections-2026-10-04.md)): pooled support recall 90 % against 80 % for fixed 1,024 on 50
  claims in two disjoint samples, 5.0 judgments per claim with a locator, every chunk inside the excerpt limit. One chunk set
  serves `verify_claim` and `search_passages`. Splitter `splitBySections`: a fitting section stays whole, a larger one splits at
  sentence boundaries into balanced pieces, a heading is never cut or left last, tiny sections merge only while they fit; checked
  by seeded property tests over 3,000 random documents and mutation checks. Structure comes from TEI `<head>` offsets or PDF
  heading lines detected from the text (about 300 headings on the 14 papers, 7 known false positives, harmless to pointers).
  Schema v4 stores marks and labels; a pre-marks PDF source derives them on the next rechunk.
- **Earlier window decision (superseded by section chunks).** With Eos at the 0.99 bar, recall by window on one fixed subset:
  8,192 tokens 52 %, 2,048 76 %, 1,024 84 %, 512 84 %; a locator cut judgments from 30.5 to 7.9 per claim at 1,024
  ([window sweep](benchmarks/evidence-window-sweep-2026-10-04.md)). The earlier 8,192 default was the engine window, not an optimum.
- **Locator.** SQLite FTS5/BM25 (porter + unicode61), query reduced to quoted words, 5 candidates per paper; claim-as-locator
  recall 97.3 % at 19–34 % of the chunks with 1,024-token windows ([report](benchmarks/evidence-retrieval-2026-10-04.md)).
- **Passage search is hybrid**: FTS5 BM25 plus exact cosine fused with RRF (k = 60), lexical when no embedder is available or it
  fails (stated, never hidden). Vectors are a content-keyed cache (schema v5). Recall@5 over all 14 papers
  ([report](benchmarks/rag-search-section-512-2026-10-04.md)): claim-text queries BM25 98.6 %, vector 85.1 %, hybrid 94.6 %;
  paraphrases 70.3 / 71.6 / 73.0 %; natural-language questions 41.9 / 68.9 / 60.8 %. BM25 is the floor when the query reuses the
  paper's words; the vector leg finds passages for questions; unweighted RRF never fails badly. Embedding 697 passages takes 20 s once on CPU; a search 30 ms.
- **Defaults.** `chars_per_token` 2.8 (calibrated; 4.0 overflowed real text); `max_judgments` 120 per call is a client policy.

## Embeddings and runtime

- **2026-10-07. EmbeddingGemma 2 Q4_K_XL on llama.cpp `b11476` (owner)**: "the fastest model that is CPU friendly on normal
  modest researcher laptops and easy packaging; just use the Gemma embedding Q4"; no older model families. Pinned
  `unsloth/embeddinggemma-2-GGUF` at commit `031f0d4b…`, `embeddinggemma-2-UD-Q4_K_XL.gguf` (175,673,856 bytes, sha256
  `ea905fd0…9493`, Apache-2.0). Measured on this repository's benchmark (698 passages, i7-14650HX):

| Model | File | ms per passage | Hybrid all-papers @10 / MRR | Hybrid own-paper @10 |
|---|---|---|---|---|
| 300M Q8_0 (previous pin) | 334 MB | 162 | 84.7 % / 0.635 | 93.7 % |
| EG2 Q8_0 (ggml-org) | 310 MB | 230 | 79.7 % / 0.619 | 91.0 % |
| **EG2 Q4_K_XL (pinned)** | 176 MB | 176 | 80.2 % / 0.619 | 91.9 % |

  Cost, accepted by the owner: about 4–5 points of hybrid recall, and a third-party conversion (parity top-1 agreement 0.75 on 20
  sentences; mean cosine 0.995). Gain: Apache-2.0 instead of the Gemma terms (no terms acceptance), half the download. Quality does
  not improve at 768 dimensions; Matryoshka 256 saves 65 % of vector bytes for about 0.02 MRR. Qdrant's footprint claims concern
  1-bit quantization at 10 million vectors; at 698 passages vectors are 2 MB and the scan 3 ms. The server's 1.3 GB peak memory
  is not set by micro-batch, prompt cache, context or allocator. Vectors re-embed on first use (the embedder identity changes).
- **2026-10-04. Runtime packaging (owner)**: a pinned official `llama-server` fetched by an explicit install step and supervised as a
  child process, not bundled (a CUDA build is about 370 MB) and not an in-process binding (a native crash must not take the host
  down). Binaries exist only under `b…` build tags (the semver tag had none). Install shows the licence and requires `--yes`; a search
  never downloads. Pinned for linux, darwin and win32 on x64 and arm64 (Windows `.zip` extracted with `fflate`); only linux-x64 has
  run. Archives validate symlinks and path escapes. The CPU build is used everywhere.
- **Embedding provenance trap.** `ggml-org/embeddinggemma-300m-qat-q8_0-GGUF` omits the dense-module tensors (cosine about 0.01
  against the reference); a third-party conversion with them reached 0.990; ggml-org's first-party `embeddinggemma-300M-GGUF`
  reached 0.9997. `scripts/embed-parity.py` is the committed gate; `llama-server` needs `-b/-ub` at least the chunk size.

## Acquisition and the bibliography

- **2026-10-07. Any lawful open-access copy a provider record names (owner: "I don't mind getting PDFs from any source").**
  Evidence: three papers in a keyed run ended `no_open_copy` although a copy existed. Order: OpenAlex `pdf_url`; the arXiv PDF from
  an arXiv identifier the DOI or an open location carries; `oa_url`; the Content API (key); then PubMed Central through Europe PMC
  and Europe PMC's non-bot-gated PDF links; last, Semantic Scholar `openAccessPdf` and its arXiv preprint (so a run that has its
  source spends no quota there). Stays: HTTPS-only public addresses re-checked per redirect, byte and time bounds, the identity
  check, credential scoping, no landing-page scraping, no title-built URLs, no Unpaywall, no paywall circumvention; scraping
  `citation_pdf_url` was not built (IEEE answers scripted clients with a bot challenge). A preprint of a work under another DOI
  is stored as `arxiv-preprint-pdf` and disclosed by `verify_claim`. arXiv: one request at a time, 3 s apart, a 60 s cooldown
  doubling to 10 min after a 429 or 403. Europe PMC's own `?pdf=render` links answer a Cloudflare challenge, so the route that
  works is the PubMed Central open-data bucket (the JSON must carry the same DOI; kind `pmc-pdf`). No JS library resolves a DOI
  across these providers, so the resolver is a few dozen lines over documented fields.
- **2026-10-07. Registration starts acquisition; typed source status (owner).** `ToolContext.afterRegister` runs after the commit,
  wired only in the MCP server (the CLI cannot hold a background task, so it keeps `paper_registry acquire`). One in-flight map
  keyed by (project, DOI) lets the hook, `acquire` and `verify_claim` overlap without repeating a download. A "no open copy"
  answer is cached an hour, a failure a day. The hook never blocks `register` or fails a committed registration.
- **2026-10-07. The bibliography is read-only on disk (owner).** The file is rendered through a staged file and an atomic rename
  with mode 0444, so no host's edit tool can append an invented entry (EACCES); the next registry write still replaces it.
  Host-neutral enforcement without a hook; a shell-capable agent could still `chmod` it (the Pi confirm dialog covers that, and
  `sync_bibliography` restores it).
- **2026-10-04. Acquisition reality (free tier).** Landing pages are not scraped, so key-less coverage is partial by design; a
  J-STAGE record with a `pdf_url` downloaded and passed the identity check, a JBC download was refused by the publisher.

## Hosts and architecture

- **2026-10-05. One stdio MCP server, many hosts (owner).** `src/mcp/server.ts` (`@modelcontextprotocol/sdk`) exposes the five
  tools with TypeBox schemas and typed refusals; any host-namespaced tool name maps to the canonical one; `mcp install --host
  <claude|pi|agy|codex|cursor|opencode>` merges the server into each host's config without clobbering others. The Pi adapter is a
  few lines that register the server; `@earendil-works/pi-coding-agent` is an optional peer dependency. Confinement is enforced at
  the server boundary (`validateContext`, `resolveProjectFile`); the in-process guard code was removed, and enforcement against a
  host's own tools lives in the Pi extension.
- **Trust model.** The CLI/TUI user is technical and trusted; conventions over enforcement; stricter enforcement belongs to a UI
  layer above the package.
- **Rejected:** sandbox-by-default (Gemini CLI, Aider and Pi default it off; approval ladders belong to the host); a new wrapper
  session store (Pi owns sessions; the sandbox only binds Pi's store so transcripts survive); a global project index (a filesystem
  scan is the maintained pattern; nested projects are refused); two-way `references.bib` sync (no merge semantics in BibTeX);
  bundling a LaTeX engine (the user's, or the pinned managed Tectonic).
- **Research records** (not decisions): [host adapters](plans/2026-10-08-host-adapter-layer-research.md),
  [codemode](plans/2026-10-08-codemode-concept-research.md),
  [web client and general layer](plans/2026-10-08-web-client-and-general-layer-decision.md).

## Scope, skills and companions

- **Scope is all research output (adopted as direction, 2026-10-02).** Figures, data analysis and grant proposals are in the long
  arc, adopted one capability at a time as real sessions demand them. The OpenScience skill library is "the adoption library":
  ported piecemeal as our own text with `NOTICE.md` attribution. First folds (owner-authorized): "Running a review" and the
  claim-source rule in `uktub-research`, adapted from `core/literature-review` and `core/sources`. Never: cloud compute, model
  training or inference, quantum, biology and chemistry domains. Sources and status: [BACKLOG](BACKLOG.md#7-skill-sources-and-companions).
- **Companions, host-side and never bundled:** evident-charts (charts; one week old and fast-moving), GenOffice (office documents;
  not a research workbench), Paper Office (scripted `.docx`/`.pptx`; 92.5 % task pass against 80.7 % upstream), open-slide with
  Slidev as alternative (slides), `academic-pptx-skill` (slide content discipline), LiteParse (ingestion of the user's own
  documents; not a replacement for `unpdf`).
- **Reference only, nothing ported:** figures4papers (licence not usable), WeKnora (a second service plane; its retrieval, filter,
  verify pattern is the design sketch), OpenMed (clinical SDK; its typed abstention is our refusal discipline), karpathy
  autoresearch (no licence; the budget-bounded keep-or-discard loop is adopted as `pnpm experiment` and `pnpm evolve`),
  ScholarQA and AstaBrief-8B (prior art and a host-side writer companion for a future report workflow), `whatisit-nl2sh`
  (not a retrieval tool).
