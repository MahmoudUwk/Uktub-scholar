# Decision log

Verdicts on design proposals, newest first. A falsified proposal is never
re-proposed without new evidence (RRSI discipline: the edit history exists so
dead hypotheses are not redrawn). Entries record the verdict, the reason, and
the evidence that would reopen the question.

## 2026-10-02 (goal sweep III)

- **Corrected-usage retests + external audit — rejections STAND; Stage-D
  primary candidate switched to MiniCheck.** External best-practices study
  (HF cards, package sources, commit history, independent evals) surfaced
  two usage concerns; both retested: Julia-1 at its EVALUATED operating
  point (max_length=1024, head_length=512, abstract context) collapses to
  P(true) ≈ 0.005 for ALL claims (worse than at 8192; our snapshot already
  includes the criteria-preservation fix a85b1273 and our 24k-char inputs
  fit the native 8192 window, so no truncation bug); GLiNER claim-first
  with 300-word passages says "supported" to all four probes (positive-label
  bias confirmed in every encoding). Audit's architectural finding: neither
  model was trained for NLI — we evaluated routers on an entailment task.
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
