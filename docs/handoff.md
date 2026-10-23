# Uktub Scholar: handoff (2026-10-23)

This is the only working document: role, direction, queue, measurements, how to test, pins, backlog. README owns behavior,
VISION owns scope, CHANGELOG records what shipped, `AGENTS.md` holds the binding rules. The previous handoff (665 lines) and the
per-phase notes of the browser fork are in git history (commit `c9972da`, 2026-10-23: `git show c9972da:docs/handoff.md`, `git show c9972da:web/FORK.md`).

## 0. Your role and how to work

You are the **system designer of the harness**. The owner's goal: "the overall goal is the harness, not the model writing
itself": a scoped harness (tools, workflow, verification, gates) that makes small, cheap models write honest, sourced scientific
documents. Fix mechanisms in code, not by adding prompt text.

- **Plan with subagents, research and build with Hermes, verify yourself.**
  - Planning: a Sonnet planning subagent (owner, 2026-10-23: "have a sonnet model plan the refactor"), fed with Hermes
    research reports.
  - Hermes (`.agents/skills/hermes-subagent/SKILL.md`): research, long builds, benchmarks and live runs. Each job gets a
    self-contained `TASK.md` naming its scope, allowed paths, acceptance checks and the workloads already running, and must
    write a `REPORT.md`.
    - Run Hermes detached: `setsid nohup hermes chat -Q -t terminal,file,web,browser --in <repo> --yolo --query-file
      TASK.md --run-budget <s> &`, plus a background `while kill -0 <pid>` waiter. Otherwise a session end kills it.
    - Hermes makes mistakes: a wrong repo, scoring over the wrong set, mislabelled numbers. Before you report anything,
      re-check every result against the raw data and the code.
- **TDD for every behavior change:** a requirement test, a red for the right reason, the smallest fix, green. Use small phases,
  each one attributable. Never edit `src/` while a benchmark or live run uses the tree.
- **Focus (owner, 2026-10-23):** keep the entire focus on the owner's explicit feedback on the harness flow (§1). For small side
  problems (example: the hosted d3-mini vs d3-turbo identity label, §2), "just use the fastest most recent" option and move on.
  Do not open side studies.
- **Communication:** the owner wants short answers ("tldr") and measured evidence, not argument. Ask (AskUserQuestion) only
  for real decisions; recommend one option. The owner corrects designs bluntly; take the correction literally.
- **Testing (owner, 2026-10-23):**
  - Local Node harness only: Pi, CLI, `scripts/live`, `scripts/bench-*`. No browser UI tests for this work.
  - Writer models: Vertex `google-vertex/gemini-3.8-flash` (user ADC) and OpenCode Go `opencode-go/minimax-m3.1-flash-free`.
  - Verifiers: hosted d3-mini (free key) and OpenRouter **free** models only. No paid OpenRouter spend.
- **Git:** commit or push only on an explicit owner request (`AGENTS.md`). The owner did ask on 2026-10-23, and that request
  covered that one push only.

## 1. Current direction (owner, 2026-10-23): verification and section-writer redesign

**Why:** one live document cost 1,800–4,200 verifier requests. Today each request is one claim against one 512-token chunk,
over every chunk of the cited paper (exhaustive on `openrouter`, top-10 on `hosted`). The owner called this "very very bad
design".

1. **Two uses of verification:**
   - free-style, when the agent checks claims about papers itself (`verify` claim mode stays);
   - automatically, only after a section is written.
2. **Judging unit = a whole paper section, not a chunk.**
   - Cap: 16,000 chars (client policy; the hosted limit is 32,000). Longer sections are split at sentence ends.
   - Ask all claims citing a paper in **one request**, as keyed questions.
   - A paper supports a claim iff **any** of its sections scores ≥ 0.99.
   - **Bibliography entries are excluded** and the exclusion is disclosed. Measured caution: appendix text often sits inside
     "References" sections (§2), so exclude entries, not whole sections.
   - `passages` keeps its 512-token chunks.
3. **A claim citing several papers is verified only if EVERY cited paper supports it.** This changes the provenance audit,
   which today needs one supporting cite.
4. **Section writers** are agentic children that read full text through the **normal tools**: `passages`, `registry` read and
   the `verify` forward. No new reading tool.
   - The parent assigns the papers, at most **20 full-text papers** per section.
   - **Code** limits the child's registry view to them, not the prompt: other papers are refused, and so is a listed paper
     without full text, before the child is created.
   - The child marks each claim with a trailing LaTeX comment `% cN`. A comment is neutral to the provenance audit
     (reproduced); a macro marker leaks into the claim text.
   - It then lists the sources, 1–4 per claim: `cN | citekey | section=<heading>` or `cN | citekey | ptr=<pointer>`.
   - Verification checks the stated sources first, then the rest of that paper, and labels where support was found.
   - A stated source the child never opened is reported as `unread-source` with a repair hint; the verdict does not change.
5. **No summaries, no paper cards, no summarizer model.** The registry abstract stays a triage field.
6. **The parent writes abstract, introduction and conclusion last**, from the written sections, and never reads full text
   for them. They are verified like any prose: the verifier reads the papers, not the agent.
7. The browser keeps today's verification until the Node path passes. Then port it.

Full plan with phases, red tests and limits (orchestrator-checked against the code):
`~/.cache/uktub-bench/plan-section-verify-v3-2026-10-23.md`. Research behind it:
`~/.cache/uktub-bench/hermes-research-verify-{api,arch}-2026-10-23/REPORT.md`.

## 2. Queue (in order)

1. **W0, running at handoff:** Hermes PID 109866. Baseline traces of today's `write_section`: 3 runs each on Vertex and
   OpenCode Go, scenario `adapter-literature-workflow-v2`, hosted verifier.
   - Notes: `~/.cache/uktub-bench/hermes-w0-writer-baselines-2026-10-23/`. Run dirs:
     `experiments/runs/adapter-literature-workflow-v2/iter-NN/`.
   - When it ends, read `REPORT.md` and re-check it against the traces.
   - If it died, rerun only what is missing.
   - Do not edit `src/` while it runs.
2. **Hosted model and identity (side issue; owner: use the fastest most recent).**
   - `resolveEngineIdentity("hosted")` takes `data[0]` of `GET /v1/models` (`src/core/verify/engines.ts`, `probeServedModel`).
     The host now lists `vllm-sr/d3-turbo` first, so d3-mini judgments are cached under a d3-turbo id.
   - Pick the hosted model per the owner's rule (latency and model list: https://decision.vllm-sr.ai/docs).
   - One small TDD fix: the identity is the configured model when the listing contains it, else no cache reuse.
   - If the model changes, rerun the A0 baseline on it (about 4 min, free) before any B arm.
3. **Track V (verification core):**
   - V1 paper units, with bibliography entries excluded. First measure how much "References" text is appendix. Decide
     between an appendix-heading detector (a splitter change: property/golden tests and a `SECTION_CHUNKING_VERSION` bump) and
     splitting at the end of the bibliography (no splitter change).
   - V2 keyed adapters:
     - pack ≤ 20 questions, hosted byte estimate ≤ 120,000 per request;
     - an invalid question is answered in place, so treat it as a failed pair;
     - split a request only on `request_too_long`;
     - retry 5xx and network errors twice;
     - protocol `systemone-noul-criteria-v2`.
   - V3 grid judge:
     - OR over a paper's units;
     - every cited paper must support;
     - a failed pair marks only its claims `incomplete`, where today one failure stops every lane (`src/core/verify/judge.ts`);
     - no schema change.
   - V4 claim mode on units (continuation token v4).
   - V5 document mode bundled per paper.
   - V6 the pre-registered A/B.
   - V7 flip the default and delete the per-chunk path, `strategy.ts` and `UKTUB_VERIFY_STRATEGY`. Amend AGENTS.md
     ("verify and passages share section chunks").
4. **Track W (writer contract):**
   - W1 code-scoped registry for the child, ≤ 20 full-text papers, refused up front.
   - W2 `% cN` + SOURCES parser.
   - W3 source trace and `unread-source`.
   - W4 annotated verification (needs V3 and V5).
   - W5 `write_section` assembly: claim table, repair by cN.
   - W6 parent rule and skill: abstract, introduction and conclusion last. The texts are `SECTION_WRITER_RULE` in
     `src/pi/index.ts` and the writing steps in `skills/uktub-research/SKILL.md`; regenerate the pins first.
   - W7 live pilot on `rag-review-50refs-v1`: current writer vs new contract, both models, N=3.
5. **Benchmark gate (pre-registered):** `docs/benchmarks/section-verify-ab-2026-10-23.json`. It holds the design, the A0
   results and three amendments: the every-cited-paper rule, bibliography vs appendix, and the identity caveat.
   - Arms: A0 current, B1 section units with 1 question per request, B2 keyed bundles (the product path), B3 at an 8k cap.
   - d3-mini runs all arms. `mercury-decide:free` runs B2 only, at ≤ 900 requests per UTC day.
   - Adopt per engine only if all hold: false supports ≤ A0 + 1 and ≤ 1/278; no doc promotion that A0 lacks unless a human
     accepts it; true supports ≥ A0 − 2 points; recall@2%FP ≥ A0 − 1 point; B2 vs B1 gives 0 new false supports;
     doc requests ≤ 1/5 of A0.

## 3. Key measurements (raw data in `docs/benchmarks/`; scratch evidence in `~/.cache/uktub-bench/`)

- **d3-mini A0, current product, 2026-10-23, identical to 2026-10-15** (`section-verify-ab-2026-10-23.json`):
  - claim-verification-v2: 197/269 true and 0/278 false supported at 0.99; recall@2%FP 0.978; 5,470 requests; 220 s.
  - 18 notes: 1,155 units, 184/345 cited supported, 10,040 requests.
  - 13 true supports rest on "References" chunks that are really appendix text.
- **d3-mini limits, measured:**
  - state ≤ 32,000 chars (32,001 → 400 `state_too_long`);
  - a 32k state fits only **3** questions (byte estimate ≤ 131,072, counted per question);
  - an invalid question is answered in place, with no 422;
  - 1,260 requests/min, 756k/day, 16 in flight;
  - **browser blocked**: no CORS on `/v1/systemone`.
- **OpenRouter `inception/mercury-decide`, 2026-10-22, paid** (`openrouter-mercury-verify-ab-2026-10-22.json`):
  - 0/278 false supports both exhaustive and top-10. True supports 166 vs 180 of 269, but the exhaustive run lost 43 claims
    to engine failures. Requests 24,671 vs 5,469.
  - Batching on 512-token passages failed the rule: max drift 0.246, 6 flips.
  - Section-scale probe (2026-10-23, one paper): 40 questions per request accepted; a supporting sentence found at every
    position up to 31k tokens; multi- vs single-question drift ≤ 0.001.
  - Context 65,536 tokens; browser reachable. Free tier: 1,000 requests per UTC day account-wide, 20/min.
- **Paper sections, claims-v2:** 1,018 sections in 48 papers. Non-reference sections: median ~2.0k chars, p90 ~6.3k,
  max 33.9k. "References" is 25 % of text and often includes appendices.
- **Writer, older live runs (2026-10-18/20, 50-reference review):**
  - one child section took 73 turns and 45 min, for $0.60;
  - children verified claim by claim (514 child `verify` calls);
  - cheap models skipped the on-demand skill, which is why the writing workflow is now always on;
  - D1 gate failures came from unlabelled prose.
- **Browser MVP full flow** (2026-10-22, `web/e2e/full-flow.mjs`): passes 30/30 with paid OpenRouter (US$0.044–0.068 per run).
  Prompt cache read 77 % of input tokens with a stable session id.

## 4. Product state

- **Node** (package `uktub-scholar` 0.2.0, not published to npm, plus unreleased work):
  - MCP server with six tools: `papers`, `registry`, `passages`, `verify`, `compile`, `doctor`. Also a CLI and a Pi package.
  - The Pi package adds `write_section`, the always-on writing workflow and the pre-completion gate (D1).
  - Verification engines: `hosted` (default), `openrouter`, `eos`, `eos-onnx`, `llama-cpp`. Registry schema v6.
- **Browser MVP** (`web/`, TeXlyre fork, `web/FORK.md`):
  - static app, no backend;
  - pi-agent-core 1.4.0 agent with any API-key provider;
  - per-project OPFS registry, BusyTeX XeLaTeX, export/import with the registry;
  - verification on `openrouter` only, because hosted has no CORS.
  - Paused for testing by the owner's decision; the code is current.
- **Owner decisions in force:**
  - D1 label or fail: unverified prose carries the word "unverified", and the gate enforces it.
  - D2 sections go to `manuscript/sections/NN-name.tex`.
  - D4 table rows get a figure check.
  - The writing workflow is always on.
  - Plus §1.

## 5. How to test

- **Gates:** `pnpm exec tsc --noEmit`, `pnpm exec tsc --noEmit --noUnusedLocals --noUnusedParameters`,
  `pnpm typecheck:browser`, `pnpm test` (2026-10-23 counts in the CHANGELOG checkpoint). Browser suites (`pnpm test:browser`,
  web Jest) only when browser code changes.
- **Live runs** (real Pi, `AGENTS.md` rules):
  - `pnpm experiment <scenario> --verify-engine hosted [--assistant-model …] [--turn-max-minutes N]`;
  - scenarios in `experiments/scenarios/`; output in `experiments/runs/<scenario>/iter-NN/` (git-ignored);
  - suites `pnpm live:direct|agent|skills|probe`;
  - grading `scripts/live/grade.ts`, analysis `scripts/live/{analysis,trace-causes,replay-checks}.ts`.
- **Benchmarks:** `scripts/bench-claims-v2*.ts`, `scripts/bench-openrouter-ab-2026-10-22.ts`, `scripts/bench-section-a0-2026-10-23.ts`.
  Datasets are in `benchmarks/`. Pre-register in `docs/benchmarks/*.json` before any request.
- **Keys** (gitignored `.env`; never print them):
  - `VLLM_decision_API` → `UKTUB_VERIFY_API_KEY` (mixed-case name; `scripts/live/keys.ts`);
  - `OPENROUTER_API_KEY` (free models only);
  - `OPENCODE_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY`, `OPENALEX_API_KEY`;
  - Vertex via user ADC.
- **Machine rules:** kill processes by PID only; never touch Docker `roku_server_media` (container, image, volumes, alpine);
  `reference_repos/` is read-only and untrusted.

## 6. Pins

- Root Pi `@earendil-works/pi-coding-agent` 1.3.0 (and the Docker sandbox). Browser `pi-ai` + `pi-agent-core` 1.4.0.
- Node 26.12.1 on this host, 26.3.1 in the Docker sandbox (floor 22.19); pnpm 10.30.
- BusyTeX 1.4.1 with TeX Live 2026 recommended. Tectonic `src/core/compile/tectonic.lock.json`.
- Eos ONNX `src/core/verify/eos-onnx.lock.json`. Embeddings `src/core/embed/models.lock.json` (EmbeddingGemma 2, llama.cpp b11476).
- Hosted verifier `vllm-sr/d3-mini` (see queue item 2). Protocol `systemone-noul-criteria-v1`, until V2 makes it v2.
- Chunks are 512 tokens with section boundaries (`config/chunking.yaml`); `passages` keeps them.

## 7. Backlog (not scheduled)

- Port the redesign to the browser after V7/W7. Hosted d3-mini stays unreachable from a page (no CORS); OpenRouter's free
  pool is 1,000 requests a day.
- OpenCode Go and Ollama Cloud block browser CORS (upstream issue anomalyco/opencode#52178). Vertex browser keys are blocked
  by org policy.
- The full 6-tool live suite has not been rerun on Pi 1.3.0. Not supported yet: macOS/Windows, npm publication
  (`private: true`).
- Build the passage index at acquire time: first-call indexing dominated `passages` time in a 50-reference run.
- Parked: a `registry` read/destructive split, MCP SDK v2, `util.parseArgs`.
