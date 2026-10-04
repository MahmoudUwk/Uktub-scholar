# Decision log

Dated rationale and benchmark decisions, newest first; preserve superseded
entries as history, not current instructions. [README](../README.md) owns
current behavior; [BACKLOG](BACKLOG.md) owns deferred work; raw benchmark
evidence lives in [benchmarks/](benchmarks/). Reopen rejected proposals only
with new evidence. Benchmark rejection does not remove selectable adapters.

Current engine choice: Decision 2.0 Eos (local, owner decision 2026-10-04), bar
0.99; OpenRouter Mercury Decide remains the best-measured hosted option; K2 a
local alternative. Earlier “primary” choices and Stage-D candidate lists below
are superseded. Recorded live/benchmark runs are historical; the latest
Mercury CLI attempt was quota-blocked, not a new successful live verification.

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
  API) is the new primary verification engine**: chunked AUC 0.998, and at
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
  primary candidate switched to MiniCheck.** External best-practices study
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
