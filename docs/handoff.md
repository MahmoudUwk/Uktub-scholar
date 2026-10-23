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
  problems (example: the hosted model choice, settled 2026-10-23), "just use the fastest most recent" option and move on.
  Do not open side studies.
- **Communication:** the owner wants short answers ("tldr") and measured evidence, not argument. Ask (AskUserQuestion) only
  for real decisions; recommend one option. The owner corrects designs bluntly; take the correction literally.
- **Testing (owner, 2026-10-23):**
  - Local Node harness only: Pi, CLI, `scripts/live`, `scripts/bench-*`. No browser UI tests for this work.
  - Writer models: Vertex `google-vertex/gemini-3.8-flash` (user ADC) and OpenCode Go `opencode-go/minimax-m3.1-flash`. The
    `-free` variant answers 410 `ModelDeprecated` since 2026-10-23; the harness entry and grader B moved to the same model without
    the suffix (its price is not published, so the harness's dollar figure for it is unknown, not zero).
  - Verifiers: hosted d3-mini (free key) and OpenRouter **free** models only. No paid OpenRouter spend.
- **Git:** commit or push only on an explicit owner request (`AGENTS.md`). Each request covers that one push only (two so far,
  both 2026-10-23).
- **Worktrees:** while a live run or benchmark uses a tree, build in detached worktrees (`~/.cache/uktub-bench/wt-*`) and merge
  only each worktree's own base-vs-worktree delta.

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
   - **Bibliography entries are excluded** and the exclusion is disclosed. Appendix text often sits inside "References"
     sections (§3), so exclude entries, not whole sections.
   - `passages` keeps its 512-token chunks.
3. **A claim citing several papers is verified only if EVERY cited paper supports it**, in verify and in the provenance audit.
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

**Done 2026-10-23 and pushed:** every part of §1 except the browser port.
- V1 paper units with bibliography entries excluded (an appendix-heading detector after References, `sections-v2`).
- V2/V2b keyed packs: ≤ 20 questions, ≤ 9 states, byte estimate ≤ 120,000, protocol `systemone-noul-criteria-v2`, 5xx retry.
- V3 grid judge: OR over units, every cited paper must support, a failed pair marks only its own claims incomplete.
- V4 claim mode on units and V5 document mode per paper, both opt-in via `UKTUB_VERIFY_STRATEGY=units`. V5b: the provenance
  audit needs every cited paper.
- W1 child scoped to ≤ 20 full-text papers. W2 `% cN` parser. W3 source trace.
- W4 annotated check: stated sources first, then elsewhere. It always uses units, and the section scope replaces "all".
- W5 `write_section` contract and claim table (always on in Pi). W6 front matter written last.
- The hosted identity fix (P0). The hosted model stays `vllm-sr/d3-mini` (owner: "pick like 4B models").
- Plans per phase: `~/.cache/uktub-bench/plan-*-2026-10-23.md`. Measurements: §3.

1. **V6, the pre-registered A/B, running at handoff** (Hermes, notes
   `~/.cache/uktub-bench/hermes-v6-ab-d3mini-2026-10-23/`, frozen tree `wt-final-2026-10-23`).
   - Arms on d3-mini: B1, B2, B3, against the recorded A0. The design is in
     `docs/benchmarks/section-verify-ab-2026-10-23.json` (5 amendments, the last being multi-state packing).
   - Preliminary B2 claims: 232/269 true and 0/278 false at 0.99; r2 0.989 (A0: 197/269, 0/278, 0.978).
   - **Open, root cause first:** B2's first pass lost every cell of 25 papers (280 claims). A refill pass cleared them.
     The cause is unknown: the logs hold no status codes. Hypothesis: the per-key token limit (750k tokens/min), since unit
     arms send about 3.6× A0's characters. Run a probe that logs status codes before accepting V6.
   - S2 needs a human to read every unit B2 promotes that A0 did not.
   - The mercury-decide:free arms (B2 only, ≤ 900 requests per UTC day) are not run.
2. **W7 live pilot** (plan `~/.cache/uktub-bench/plan-w4-w6-build-2026-10-23.md`, W7 section).
   - `rag-review-50refs-v1`: C0 = the pre-redesign writer (commit `86e909b`, `--verify-engine hosted`) vs C1 = current with
     `--verify-engine hosted-units`.
   - Models: MiniMax and Vertex, N = 3. Gates: marker compliance ≥ 90 %, requests per section ≤ 250, parent `passages`
     after the last section = 0, Tier 1 6/6, blind Tier 2 bad rate ≤ 5 %.
   - A first C1 smoke (MiniMax, `adapter-literature-workflow-v2`) was running at handoff:
     `~/.cache/uktub-bench/c1-smoke-2026-10-23/`, tree `wt-c1-2026-10-23`.
3. **V7** (after V6 and W7 pass): make units the default, delete the per-chunk path, `strategy.ts` and
   `UKTUB_VERIFY_STRATEGY`, and amend AGENTS.md ("verify and passages share section chunks").
4. **Browser port** (backlog §7) after V7.

## 3. Key measurements (raw data in `docs/benchmarks/`; scratch evidence in `~/.cache/uktub-bench/`)

- **Redesign build, 2026-10-23** (all orchestrator-verified):
  - Live CLI smokes on hosted d3-mini over a copy of the claims-v2 registry:
    - claim 2610.00717-04: the unit path judged 34 sections and 13 windows in 7 POSTs and found the appendix support. The
      chunk path, top 10 of 95 chunks in 2 POSTs, found none.
    - document mode: a sentence with one supporting cite is `supported`; the same sentence with a second, unrelated cite is
      `cited-unsupported — not supported by: <key>` (9 POSTs, 4.6 s).
  - Hosted request limits, measured: the top-level state plus up to 8 `states` entries per request (9 extra → 400
    `too_many_states`); `q1..qn` keys are answered per key.
  - V5b Tier 1 replay (offline, 5 runs): one unit flips, iter-21 u17 from verified to cited (hu2021lora never supported it);
    the control run is byte-identical. V2b packing also changes the request shape of the default chunk path, whose scores
    were not re-measured.
  - Heading rule on 66 held-out PDFs: 29 cuts after References, all real headings, 0 false cuts.
  - Fixes found in review, each test-first:
    - `primePage` now prepares sources and re-derives stale marks;
    - `supportWhere` labels supporting papers only;
    - the harness forwards the hosted key for `hosted-units`;
    - `S1 Title` supplement headings are detected.
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
- **W0, today's `write_section` before the redesign, 2026-10-23** (scenario `adapter-literature-workflow-v2`, hosted
  verifier; analysis `~/.cache/uktub-bench/hermes-w0-analysis-2026-10-23/REPORT.md`, orchestrator spot-checked):
  - MiniMax `minimax-m3.1-flash`, 3 valid runs (iter-31, 32, 35), medians (range):
    - wall 3,009 s (2,042–3,627); 5 `write_section` calls (4–5); 54 cited sentences; 1,194 words; 12 unresolved;
    - supported: 50 % in the first draft, 81 % final;
    - child calls: 129 `verify` (125–192, one claim per call), 42 `passages`; 0 cited-never-read;
    - 2,887 judgment pairs per run (2,580–4,533), 599 verify runs; Tier 1 6/6 in all three.
  - Vertex `gemini-3.8-flash`: no valid run in 4 attempts. iter-27, 28 and 34 fell back to flash-lite after 429; iter-36
    was blocked by "fetch failed". Treat it as untested today.
  - Seen failure modes: a 429 inside the child (iter-27); a repair that returned drafting chatter as the section
    (iter-27); an experiment-design section whose setup claims have no source by construction (iter-32).
- **References vs appendix, claims-v2, 2026-10-23** (`~/.cache/uktub-bench/hermes-v1-refs-appendix-2026-10-23/`;
  hand-read boundaries in `ground-truth.json`, orchestrator spot-checked):
  - 44 of 48 papers have a References-labelled span: 950,065 chars, 25 % of the text. 52.8 % of it is appendix, in 22 papers
    (median tail 19,927 chars, max 68,939). The other 4 papers have no References mark.
  - Prototype appendix-heading rule (tuned on the same papers, so in-sample): finds the appendix in 21/22, with 0 false cuts
    and 0 entry chars leaked. It drops 2,300 appendix chars. Miss: 2609.18631 (an unmarked appendix title).
  - Entry-density cut: keeps 10,350 entry chars and drops 9,688 appendix chars. Rejected.
  - All 13 A0 references-only true supports keep their evidence under both rules.
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
- Hosted verifier `vllm-sr/d3-mini` (owner, 2026-10-23), protocol `systemone-noul-criteria-v2`; `HOSTED_PACK` 20 questions,
  9 states, 120,000 bytes.
- Chunks are 512 tokens with section boundaries (`config/chunking.yaml`, `sections-v2`); `passages` keeps them. Judging units
  are whole sections ≤ 16,000 chars (`paper-units.ts`).

## 7. Backlog (not scheduled)

- Fix the import cycle between `core/tools/verify.ts` and `core/verify/document.ts` (a test imports in a set order).
- `frontmatter-new-cite` audit item: deferred until W7 shows front-matter new cites.
- Port the redesign to the browser after V7/W7. Hosted d3-mini stays unreachable from a page (no CORS); OpenRouter's free
  pool is 1,000 requests a day.
- OpenCode Go and Ollama Cloud block browser CORS (upstream issue anomalyco/opencode#52178). Vertex browser keys are blocked
  by org policy.
- The full 6-tool live suite has not been rerun on Pi 1.3.0. Not supported yet: macOS/Windows, npm publication
  (`private: true`).
- Build the passage index at acquire time: first-call indexing dominated `passages` time in a 50-reference run.
- Parked: a `registry` read/destructive split, MCP SDK v2, `util.parseArgs`.
