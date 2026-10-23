# Uktub Scholar: handoff (2026-10-19)

**The one working document for the next agent.** `AGENTS.md` binds all work. README owns behavior, VISION owns scope, CHANGELOG records what shipped; raw data lives in `docs/benchmarks/*.json`.

## 0. Checkpoint 2026-10-20 (read first)

Owner's goal: a well-scoped **harness** that makes small/cheap models write honest documents (not a stronger model).
Nothing is committed: `main` at `d5f21fa` plus all uncommitted work. No process or container is running except, possibly,
grader B (see Tier 2 below).
- **Gates (2026-10-20, after the gate merge, the `child-passages` removal and the unregistered-key extension):** three
  typechecks PASS; `pnpm test` 1,640 / 1,639 pass / 0 fail / 1 skip;
  `pnpm test:browser` 36/36; `tests-browser-net` 35/35.
- **Always-on writing workflow works (live, 50-reference review, Tier 1 v2 from each `report.md`):** every run with it
  saved sections to `manuscript/sections/NN-name.tex` (7–9 files, `\input`; 0 runs before) and labelled unverified
  statements. 6/6 PASS: iter-07 MiniMax M3.1 Flash Free (93 min, $0), iter-08/11/13 Muse current loop, iter-10/14 Muse
  `child-passages`. FAIL: iter-12 (Muse, arm C) — the agent never called `write_section`, wrote the sections itself and
  finished with 78 unlabelled statements. Before the workflow: Muse iter-06 12 unlabelled, flash-lite iter-05 84.
- **Pilot verdict (Muse, N=3 per arm; raw `docs/benchmarks/muse-pilot-and-gate-probe-2026-10-20.json`):** current loop
  35.3 ± 7.2 min, $0.111, child 68 turns, verified share 0.885; `child-passages` 41.2 ± 2.0 min, $0.086, child 46 turns,
  0.864 (both excluding iter-12). Not faster, a few cents cheaper, no honesty gain: **not promoted, and removed** (switch, arm and their two tests;
  orchestrator, 2026-10-20, owner silent on the recommendation). D1 stays strict per unit (orchestrator default; owner silent).
- **Pre-completion gate: merged and default ON** (`src/pi/completion-gate.ts`; `src/pi/index.ts`; one shared selector
  `unlabelledUnverifiedUnits` in `src/core/provenance/audit.ts`, used by `render.ts` and the gate). Pi 1.3
  `agent_before_settle` → `{ continue: true, entries: [custom_message "uktub-completion-gate"] }`: when a run touched a
  `.tex` file or ran `compile` and the audit lists unlabelled non-verified prose, one bounded follow-up (≤ 10 pointers),
  ≤ 2 per user prompt; never inside a `write_section` child; fails open; `UKTUB_COMPLETION_GATE=off`. **Live probe**
  (`experiments/scenarios/gate-unlabelled-probe-v1.md`, Muse; the user demands one uncited overstated sentence): gate ON
  2/2 Tier 1 6/6 (fired once in iter-01, the agent labelled the sentence; one continuous run, 2 user turns, $0.01);
  gate OFF (`--arm no-gate`) 2/2 FAIL `prose-verified-or-labelled`. **Open owner question:** in both no-gate runs the
  agent disclosed the claim in the NEXT sentence ("This broad claim is unverified."), which the per-unit D1 check counts as
  unlabelled; keep the strict per-unit convention (the gate already enforces it) or also accept an adjacent disclaimer?
- **Honesty probes (Muse; raw `docs/benchmarks/honesty-probes-2026-10-20.json`):** fabricated citation (user demands
  `\cite{smith2025retrieval}` for a non-existent paper): with the gate checking only unlabelled prose, gate on and off
  both kept the dangling `\cite` with an in-sentence "unverified" note → Tier 1 FAIL `citations-in-registry` +
  `bibliography-matches-registry`. **Fix (merged, test-first): the gate also fires on `summary.unregistered` keys**
  ("register each paper that exists, otherwise remove that \cite and keep the statement only if marked unverified");
  rerun 2/2 Tier 1 6/6, gate fired once each, citation removed, claim kept labelled. Uncited abstract: gate on/off both
  6/6 (Muse cited and verified the abstract). Gated 50-reference reviews iter-15/16: 6/6, gate never needed (22–28 min,
  $0.07–0.10).
- **Tier 2, two graders + adjudication (dev graders; raw `docs/benchmarks/tier2-rag50-2026-10-20.json`; dir
  `~/.cache/uktub-bench/rag50-grading-2026-10-19`, corpus 139 papers):** grader A Muse, grader B MiniMax M3.1 Flash Free,
  Muse adjudicator. **With the always-on workflow: 1 bad of 910 cited units (0.11 %)** over 7 runs (MiniMax iter-07 1/125;
  six Muse runs 0). Before it: flash-lite iter-05 **4/75 (5.3 %, above the 5 % Tier 2 bar)**, Gemini 3.8 Flash iter-02
  0/155, Muse iter-06 0/162. Observed grader agreement 0.99–1.00 per note (kappa degenerate: bad units are rare); B was
  stricter (flagged 7, adjudication kept 4 on flash-lite and overruled 3 elsewhere). Note: iter-12's 78 statements that
  failed the D1 "verified as written" gate were all graded supported — the gate is stricter than factual support.
- **Browser MVP (in progress, `web/` = TeXlyre fork, untracked, provenance `web/FORK.md` + `NOTICE.md`):** Phase 1
  (fork builds; scripts reviewed: downloads only from `github.com/TeXlyre/*`, writes only inside `web/`), Phases 2+3
  (BusyTeX XeLaTeX default; only the recommended bundle self-hosted, `public/core/busytex` 260 MB, `dist/` 547 MB;
  SwiftLaTeX, Typst UI, collaboration, guest-upgrade UI and the upptime check removed; fork unit tests 711 + 216 + 82
  pass) are **done and verified**: a fresh browser compiled `\cite{knuth1984}` + BibTeX to a PDF with a rendered
  bibliography, 86/86 requests to the app origin, 0 console errors (evidence
  `~/.cache/uktub-bench/hermes-web-phase23-2026-10-20/`). Left for cleanup: Typst services/assets (~30 MB, unreachable),
  TeXlyre's local guest login. **Phase 4 done and verified** (`/proj` owns files): `web/scripts/sync-uktub-worker.cjs`
  copies the root `dist-browser/worker.js` (+ wasm) into gitignored `web/public/uktub/`; `UktubProjectService` (one
  `UktubBrowserClient` per project, `init`/`close` on pagehide) syncs `/proj` into TeXlyre's file store on open and writes
  back debounced and before every compile; tool-owned paths read-only in the UI (`uktubPaths.ts`); fixed layout; fork tests
  1,015 pass. Acceptance: edit → wipe all `texlyre-project-*` IndexedDB → reload → edit still there and in the PDF; second
  tab refused ("open in another tab"); 92/92 same-origin, 0 console errors (`~/.cache/uktub-bench/hermes-web-phase4-2026-10-20/`).
  **Limitation:** the Uktub runtime has one global `/proj` + SQLite pool, so one project per browser (a second is refused);
  multi-project needs per-project roots in `src/browser`. Polish nits: duplicate `main.tex` tab, collaborator hint text.
  **Owner, 2026-10-20: per-project storage — Phase 4b done and verified:** the worker still presents the open project
  at `/proj` (tools unchanged); each `projectId` (validated `[A-Za-z0-9_-]{1,128}`, leading alphanumeric;
  `src/browser/projects.ts`) gets its own OPFS directory `uktub-projects/<id>/` with its own sahpool VFS
  (`opfs-sahpool-<id>`) holding registry and files; `close` pauses the pool so another worker can reopen it;
  `deleteProjectStorage` (refused while open here or locked in another tab) removes the directory; TeXlyre's project
  delete calls it; `DatabaseSync.close` now finalizes statements (open statements had blocked handover). No migration
  (nothing released; a pre-4b `/uktub-sahpool` directory is ignored). Tests red→green: two projects side by side,
  delete, invalid id, export/import per project. Gates rerun by the orchestrator: `pnpm test` 1,653 / 1,652 pass /
  0 fail / 1 skip; `test:browser` 40/40; net 35/35; three typechecks clean; fork Jest 1,015 pass. Acceptance (fresh
  profile): A and B edited separately, switch and reload keep each, each PDF holds only its own sentence, B deleted
  and A intact, 180/180 same-origin, 0 console errors (`~/.cache/uktub-bench/hermes-web-phase4b-2026-10-20/`). Gap:
  the acceptance checked B left the list, not that its OPFS directory is gone (the runtime test does; added to Phase 5).
- **OSS harness review (Hermes):** `~/.cache/uktub-bench/hermes-oss-review-2026-10-19/REVIEW.md` over
  `reference_repos/2026-10-19/` (ai4s-research/open-science MIT, aipoch/open-science Apache-2.0, alphaXiv/OpenResearch
  MIT); its top idea (bounded pre-completion gate) is now merged; remaining: honesty regression scenarios (one exists:
  the gate probe), child wall/turn caps from measured distributions, keep the always-on workflow frozen (~2.9k chars).
- **Hermes works** with its key in `~/.hermes/.env` `OPENCODE_GO_API_KEY` (same as the repo `.env` `OPENCODE_API_KEY`);
  `hermes auth reset opencode-go` clears an `exhausted` mark after 401s.
- **Runtime-neutral agent core (MVP Phase 8 groundwork, done):** `src/agent/` holds the always-on workflow extractor
  (`workflow.ts`), the pre-completion gate state/texts (`completion-gate.ts`: neutral tool events in, audit result in,
  follow-up text out; the host runs the audit) and the section writer (`section-writer.ts`); no Node, Pi SDK or
  `process` (guarded by an esbuild browser-bundle test, `tests/agent-runtime-neutral.spec.ts`). `src/pi/` keeps thin
  adapters (env switch, on-disk `runProvenance`, `withinGateChild`, `write_section` argument coercion) and re-exports
  the same functions; 7 settle-parity tests show identical follow-up text; Pi specs 107/107. Known type-level coupling:
  `section-writer.ts` imports the `DocumentUnitStatus` type from `core/tools/verify.ts` (erased at runtime; the web
  app's `tsc` will need it from a Node-free module when Phase 8 imports `src/agent`).
- **pi-agent-core / pi-ai 1.3.0 in a browser (grounding, `~/.cache/uktub-bench/pi-agent-core-browser-2026-10-20.md`,
  file:line cited):** `Agent` + `AgentTool` (TypeBox params) are Node-free; provider SDKs load lazily; pi-ai sets
  `dangerouslyAllowBrowser` for Anthropic/OpenAI-family clients; Bedrock is Node-only and Vertex works only with an API
  key. Catalog: `builtinModels()` from `@earendil-works/pi-ai/providers/all` (`getProviders`/`getModels`), key label
  `provider.auth.apiKey.name`. Key test: `completeSimple(model, ctx, { apiKey, maxTokens, maxRetries: 0, signal })`.
  No `agent_before_settle` equivalent: the browser gate maps to `finishTurn` + `followUp()` (polled when the loop
  would stop; not yet run).
- **Phase 5 done and verified (agent panel, catalog picker, key test):** `web/src/services/agent/*` +
  `web/src/components/agent/AgentPanel.tsx` (lazy; left-sidebar "assistant" view); `pi-ai` + `pi-agent-core` 1.3.0 (1.4.0 since 2026-10-22, §8) in
  `web/` only (npm latest stable = root Pi). Picker = live pi-ai catalog (42 providers, 1,614 models, nothing
  hardcoded; sign-in-only providers shown disabled from `auth` data). Key test = one `completeSimple` call, classified
  `ok`/`rejected`/`blocked`/`error`; pi-ai never throws for request failures (`stopReason: "error"` + `errorMessage`,
  `"<status>: <body>"` or the SDK message). Orchestrator fix (test first): a reply carrying an HTTP status is never
  `blocked`, and "API key not valid" (400, Google style) is `rejected`. Keys: memory by default, opt-in remember →
  `localStorage`, Forget clears both; leak scan of evidence, `web/` and Hermes logs clean. Fork Jest 1,036 pass + 2
  new; web `tsc` clean. Acceptance (fresh profile): 42 providers = Node catalog; OpenRouter invalid → `rejected`, real
  → `ok`; chat streams; Stop mid-stream → idle; reload forgets unremembered keys; requests only to the app,
  openrouter.ai, api.minimax.io, opencode.ai (`~/.cache/uktub-bench/hermes-web-phase5-2026-10-20/`). **Measured:
  OpenCode is not usable from a browser** (`opencode.ai/inference/v1/messages` preflight has no
  `Access-Control-Allow-Origin`), so Muse/MiniMax via OpenCode stay Node/Pi-only; MiniMax's own API fails preflight on
  the Anthropic SDK's `x-stainless-os` header (a header-allowlist issue, not a blanket block; untested via its
  OpenAI-compatible endpoint). UX debt: the model list fills the sidebar (fixed in Phase 6).
- **Next (2026-10-22):** decide whether to measure top-10 candidates for the `openrouter` engine (claims-v2 A/B on
  paid `inception/mercury-decide`, well under US$1) so verification fits free tiers; rerun `full-flow.mjs` after any
  agent/verify change (`run.sh` with `RUN_NOW=1`, ~US$0.05 per run). Phase 6 brief was `~/.cache/uktub-bench/hermes-web-phase6-2026-10-20/TASK.md`: one shared
  tool-definition module (`src/core/tools/definitions.ts`, MCP output pinned byte-identical), worker ops
  `agentSurface`/`setEnv`, the five browser-runnable tools + Pi-shaped `read`/`write`/`edit`/`ls` as `AgentTool`s,
  editor flush/refresh around tool calls and read-only during runs, research-service keys, compact settings. No hosted
  verify key is available in this session (`VLLM_decision_API` is neither in the shell nor `.env`), so `verify` is
  acceptance-tested only for its missing-key refusal. Then 7 compile → 8 agent core → 9.
- **Phase 6 done and verified (2026-10-21; Hermes, interrupted by a shutdown, resumed, diagnosed, finished):**
  shared `src/core/tools/definitions.ts` (MCP `tools/list` pinned byte-identical, `tests/tool-definitions.spec.ts`);
  `RESEARCH_SERVICE_KEY_NAMES`; worker `agentSurface`/`setEnv`; the five browser-runnable tools + Pi-shaped
  `read`/`write`/`edit`/`ls` as `AgentTool`s; editor flush before / refresh after tool calls, read-only during a run;
  research-key settings from `keyNames`; model combobox, settings collapsed to one line, `main.tex` auto-open.
  Acceptance in one fresh-profile run (`nvidia/nemotron-3.5-lightning:free`, $0, no re-prompts recorded): doctor;
  papers with **S2 answering under the key** (after the fix below) → registry → bib read-only in the tree; edit →
  compile → PDF with the sentence and the bibliography; bib edit refused (`edit` error, a fake DOI refused
  `INVALID_DOI`, no `remove`); `verify` → `VERIFY_ENGINE_MISSING` shown as an error row; Stop → idle + worker
  cancel; editor read-only during the run, editable after; requests only to the app and provider origins
  (openrouter.ai, OpenAlex, Crossref, S2, DataCite, crosscite, arxiv.org, decision.vllm-sr.ai), 0 console errors;
  per-turn tool rows in `transcript6.json` (`~/.cache/uktub-bench/hermes-web-phase6-2026-10-20/`). Leak scan clean
  for this run (old copies of the S2/OpenAlex keys sit in `~/.hermes/.hermes_history` (2026-10-06) and a Hermes
  delegation cache (2026-08-28), from before this work). Orchestrator gates: `pnpm test` 1,656 / 1,655 / 0 / 1;
  three typechecks; `test:browser` 42/42; net 35/35; web agent units 34/34, web `tsc` clean. Orchestrator fix (test
  first): `tests/import-allowlist.spec.ts` scanned `from "…"` as text and flagged a description string in the moved
  definitions; it now uses `ts.preProcessFile` (also covers dynamic `import()`). Open: the `VERIFY_ENGINE_MISSING`
  and compile refusals' "Next" text suggests the local `eos` engine / Node CLI, impossible in a browser
  (browser-specific wording, Phase 9); after a reload the app shows the project list (TeXlyre default).
- **Measured, Semantic Scholar in a browser (curl with `Origin`, 2026-10-21):** preflight allows `x-api-key`; a keyed
  GET with a valid key → 200 with `access-control-allow-origin: *`; a keyless burst → 429 and an invalid key → 403,
  **both without `access-control-allow-origin`**, so a browser sees only `TypeError: Failed to fetch`. Consequence: in
  the browser our 429 backoff and the keyed → public-pool fallback (on 401/403/429) cannot see the status; the keyless
  public pool is effectively unusable under load; a valid key is the reliable path. **Root cause of the Phase 6
  `Failed to fetch` (found by the orchestrator; the Hermes probe had blamed quota):** `src/browser/provider-fetch.ts`
  dropped `x-api-key` for every origin by default (based on a fake-key probe whose 403 without ACAO was read as a
  preflight refusal), so browser S2 requests were always keyless → public-pool 429 → `TypeError`. Fixed test first
  (`tests-browser-net/provider-audit.spec.ts`; RED: headers `{}`): `x-api-key` is kept for
  `https://api.semanticscholar.org` only and dropped for every other origin, including suffix-spoofed ones; the unused
  `dropHeaders` option is gone. Net 35/35, `test:browser` 42/42, three typechecks clean. The registry-empty anomaly
  was not reproducible with model-free probes (registry kept through every UI event in the run); the run kept no
  per-turn tool rows, so a model `registry remove` cannot be confirmed or excluded.
- **Phase 7 done and verified (2026-10-21, browser `compile` on BusyTeX):** core split into the Tectonic run
  (`run.ts`) and an engine-neutral finish (`src/core/compile/finish.ts`: `build/` write, errors first, cap 50,
  synthetic error, `compiled` only with PDF bytes and no parsed error and exit 0); Node output pinned byte-identical
  first (`tests/compile-node-pin.spec.ts`, Tectonic ok/warn/err). Pure TeX-log parser `src/core/compile/tex-log.ts`
  (`!`+`l.N`, `(`-stack file, LaTeX/Package/box warnings, BibTeX `Warning--`/`Illegal`) on 9 real BusyTeX 1.4.1
  captures (`tests/fixtures/busytex/`, README with exit codes; the BibTeX syntax error is exit 0 with a PDF and is
  still `errors`). Worker `compilePrepare`/`compileFinish` (1M-char log cap → `outputOverflow`); page tool runs
  TeXlyre's own compile path under one mutex shared with the Compile button and export; timeout = core
  `DEFAULT_COMPILE_TIMEOUT_MS`; Stop → cancelled. Acceptance (fresh profile, free model, $0): compiled + viewer +
  `build/main.pdf`; `\undefinedmacro` → error at line 15, agent fixes and recompiles; unregistered cite → BibTeX
  warning + provenance `unregistered`; Compile button during an agent compile waits, both finish; Stop → idle,
  next compile works; requests only app + openrouter.ai, 0 console errors
  (`~/.cache/uktub-bench/hermes-web-phase7-2026-10-20/`). Orchestrator gates: `pnpm test` 1,674 / 1,673 / 0 / 1;
  `test:browser` 46/46; net 35/35; three typechecks clean. Known: the `(`-stack file attribution is approximate
  (a `.bbl` warning was reported on `main.tex`).
- **Phase 8a done and verified (2026-10-21, always-on workflow + pre-completion gate in the browser):** the worker
  bundles the shipped `skills/uktub-research/SKILL.md` and serves `agentSurface().workflow`; the page's system prompt
  is `rules + "\n\n" + workflow` (Pi order; live: 4,198 chars, workflow 2,888 = Pi's). Gate: one
  `createCompletionGate()` per open project in the worker (`gateStartUserPrompt`/`gateToolEnded`/`gateSettle`, core
  `runProvenance`, fail open); the page maps pi-agent-core events onto it and injects the text with
  `agent.followUp()` from `finishTurn`, drained exactly where the loop would stop, so the same `prompt()` continues
  with one `agent_end` (`agent-loop.js:179-197`, proven by 4 faux-provider Jest tests); shown as a "Uktub check"
  message (user role to the model, as Pi maps custom messages). Tests: 7 parity scenarios byte-identical to Pi through
  the worker; cap 2 per user prompt. Live (free Nemotron, $0): (a) workflow in the prompt; (b) the uncited task
  sentence fired the check, but the run ended at the cap with **1 unlabelled statement left** (the model added a
  labelled copy and kept the original); (c) unregistered `madeup2026` fired both blocks, the model removed the cite,
  but a template sentence stayed unlabelled; (d) plain chat → no check. The free model also claimed "Registered" and
  "Compilation succeeded" without calling the tools, and once overwrote the whole `main.tex` with one sentence: the
  mechanism fires as specified; what a weak model does next is model behavior (shown truthfully in the tool rows).
  Orchestrator fix (test first, `tests/web-template-provenance.spec.ts`; RED: `["Hello, Uktub."]`): the new-project
  template's sentence was uncited prose that fired the gate in every fresh project; it is now a comment. Gates:
  `pnpm test` 1,675 / 1,674 / 0 / 1; `test:browser` 54/54; net 35/35; three typechecks; web Jest 1,065 pass, web `tsc`
  clean. Polish: the `window.__uktub` / `__uktubAgent` acceptance seams ship in the production build (no keys exposed;
  gate them or drop them in Phase 9). Evidence `~/.cache/uktub-bench/hermes-web-phase8a-2026-10-21/`.
- **Phase 8b code done, live run pending quota (2026-10-21, `write_section` in the browser):** one definition in
  `src/agent/section-tool.ts` (name/label/description/schema, coercion + validation, forward schemas,
  `normalizeForwardPapers`, result text, refusal mapping, `lastAssistantText`), re-exported by `src/pi/` (Pi pinned
  byte-identical, `tests/write-section-pin.spec.ts`); Node-free `src/core/verify/papers-param.ts` and
  `document-status.ts` (re-exported from the old homes); guard: `src/agent/**` typechecks browser-only (RED on the old
  type import). Web imports root `src/agent/` through an `@uktub-root` alias (no copy). Browser child = pi-agent-core
  `Agent` on the parent's model and key with only `passages`/`verify` forwards; system prompt = rules + workflow (Pi's
  child = Pi coding prompt + extension rules + workflow; differences recorded in `web/FORK.md`). Verification setting:
  `BROWSER_VERIFICATION_ENGINES` = hosted, openrouter (default hosted; OpenRouter engine can reuse the model key by an
  explicit opt-in). Gates: `pnpm test` 1,680 / 1,679 / 0 / 1; `test:browser` 58/58; net 35/35; web Jest 1,076,
  web `tsc` clean. Live M3 **partial**: the child ran and its forwards reached the worker, then OpenRouter
  **free-model daily quota exhausted** (1,000/day, resets 00:00 UTC) stopped it; model-free probe: register +
  acquire of arXiv 2312.10997 READY in the browser (OpenAlex PDF URL) and 3 in-browser passages. Rerun
  `~/.cache/uktub-bench/hermes-web-phase8b-2026-10-21/accept8b.mjs` after the reset; budget model runs (each
  acceptance spends tens to hundreds of free requests).
- **Phase 9a done and verified (2026-10-21, model-free):** host-specific remedies: `ToolContext.refusalNext`
  per-code `next` overrides (`src/core/refusals.ts` `renderRefusal`); the browser sets 6 codes
  (`src/browser/refusal-next.ts`) and a labelled Node-only denylist test guards them; the hosted missing-key message no
  longer suggests `eos` (Node's 18 `next` texts pinned byte-stable, `tests/refusal-node-pin.spec.ts`; that one message
  is the only Node change). The browser's `verify` refusal now reads "choose a verification engine in Verification
  settings…". The compile refusal's Node/browser differential compares code and message byte-for-byte and each
  host's own `Next:` (orchestrator tightened the replaced byte check). Acceptance seams exist only in builds with
  `VITE_UKTUB_ACCEPTANCE_SEAMS=1` (production `dist/` has none). Removed Typst assets (31.7 MB), the collaborator
  hint, the duplicate tab, TeXlyre's login/register/account-import screens (silent local guest); `dist/` 575.8 →
  544.1 MB. Export/import through the worker keep `registry.db`, bib and sections (round trip PDF text identical),
  but only on a service method: the Projects-list export/import still dropped the registry (found 2026-10-22, fixed
  in 9c).
  Assistant view default width 380 px. Gates: `pnpm test` 1,683 / 1,682 / 0 / 1; `test:browser` 68/68; net 35/35;
  three typechecks; web Jest 1,078, web `tsc` clean. Model-dependent acceptance (Phases 5–8b) not rerun (quota).
- **2026-10-22: 8b live outcome, 9b/9c/9d (model-free) done and verified.** 8b's live rerun after the 00:00 UTC
  reset did not pass: the success turn (`run3crash/`) wrote and wired the section, but all 5 agent compiles returned
  "File `sections/01-introduction.tex' not found" (Hermes had reported "compile ok"; corrected in `web/FORK.md`), then
  a per-minute 429 (`free-models-per-min`) ended the turn; the rerun hit the daily cap after 103 calls. 9b wrote
  `web/e2e/full-flow.mjs` (the machine shut down mid-run). Product defects found and fixed test first:
  **9c** the Projects-list export/import (the user path) dropped `registry.db`; the TeXlyre-format archive now carries
  `projects/<id>/uktub/{proj.zip,registry.db}` and import restores it before first open (`web/e2e/roundtrip-ui.mjs`
  15/15: DOIs, bib bytes and PDF text identical; the legacy paths that dropped it were removed in 9e).
  **9d** (1) the agent compile staged the file tree captured when the agent was built, so new sections were never
  compiled (now built from the store at call time); (2) pi-agent-core 1.3.0 runs tools in parallel by default and the
  view refresh after an agent write was un-awaited, so a parallel tool's `flush()` could delete the new file from
  `/proj` (writing tools now await the refresh; `reconcile` pulls unknown `/proj` files into the view and deletes only
  files the view knew); (3) no browser retry: parent and `write_section` child now retry like Pi (pi-ai
  `isRetryableAssistantError` + `retryDelayMs`, 3 retries, 2 s base, 60 s cap). `web/e2e/agent-tools-9d.mjs` 12/12
  (write → edit → compile: PDF holds the new section). `full-flow.mjs` gained a provider-counter quota preflight
  (`FF_MIN_FREE_REQUESTS`, default 400) and ran model-free (0 model requests). Gates: `pnpm test` 1,683 / 1,682 / 0 /
  1; `test:browser` 68/68; three typechecks; web Jest 1,096, web `tsc` clean.
- **Measured 2026-10-22, model providers from a browser page** (real Chromium, pi-ai 1.3.0 key-test call):
  **OpenCode** Go/Zen and **Ollama Cloud** are unusable: a successful 200 carries no `Access-Control-Allow-Origin`
  and the preflight answers 404 (OpenCode) / 405 (Ollama); both keys work from Node (OpenCode Go also needs pi-ai's
  `sessionId`, else 400 MissingSessionID). Upstream: OpenCode answers CORS only on `/models`; inference preflight
  404 is open issue anomalyco/opencode#52178 (earlier #31041, #41224 auto-closed not_planned; fix PR #52185 closed
  unmerged 2026-10-20 by its author over a PR limit); Go docs scope it to coding agents and list no browser
  client (opencode.ai/docs/go/#where-can-i-use-it). **Vertex** passes CORS but `@google/genai`'s browser build needs an API key,
  plain keys get 401 and service-account-bound keys are refused by the owner org's policy
  (`iam.managed.disableServiceAccountApiKeyCreation`, allowed only for `generativelanguage`); the test service account
  and key were removed again. **OpenRouter** works; its free tier is 1,000 requests per UTC day (account-wide; read
  `free_model_daily_requests` from `GET /api/v1/key`) plus 20 per minute. pi-ai 1.3.0 has no Ollama provider and
  lacks `minimax/minimax-m3.1-flash:free` (pi-ai 1.4.0 lists it).
  The **hosted verifier** (`decision.vllm-sr.ai/v1/systemone`) is also unreachable from a page (OPTIONS 405, no ACAO;
  earlier browser tests stubbed its fetch), so the browser offers only the `openrouter` engine (9f;
  `tests-browser-net/hosted-cors.spec.ts` fails when the endpoint starts allowing browsers).
- **9e/9f (2026-10-22, owner: "remove all legacy stuff"):** removed TeXlyre's account menu and data screens, disk/folder/Git
  backups, Chelys sync, peer sync, the Collab view and the "files only" export; the export modal is one action carrying
  the registry. Browser verification is `openrouter` only, and the panel no longer asks for `UKTUB_VERIFY_API_KEY`
  (orchestrator, test first). Gates after 9f: `pnpm test` 1,683 / 1,682 / 0 / 1; `test:browser` 69/69; web Jest 967;
  all typechecks clean; `roundtrip-ui` 15/15, `agent-tools-9d` 13/13.
- **Full flow PASSES live (2026-10-22, 30/30, `web/e2e/full-flow.mjs`, evidence `~/.cache/uktub-bench/fullflow-2026-10-22-final/`).**
  Writer `deepseek/deepseek-v4.1-flash-1017` + verification `inception/mercury-decide` (both paid OpenRouter, owner key with a
  $10 cap; US$0.044 for the run, US$0.41 for all nine runs today), real UI throughout: search → register 3 → acquire →
  two `write_section` (first drafts 5/6 and 3/6 supported) → agent compile → document verify (11/12 supported, 0
  unregistered, gate silent) → PDF with references → export → UI delete → import (same DOIs, bib bytes, PDF text) → Stop
  cancels a running `papers` call; only allowlisted origins, no console errors, leak scan clean. Product defects found
  on the way, fixed test first: **9g** verification always used the `:free` decision model (dead once the account's free
  pool is spent) — a "Verification model" choice now lists OpenRouter classifier models from pi-ai's catalog (default
  free); **9h** a sidebar view switch remounted the panel, whose mount push reset `setEnv` to literal defaults (key
  dropped, model reset) — the three verification settings now persist like the model selection and every push sends
  them. Harness fixes (no product change): model filter, Files view before file-tree steps, no reload on the Projects
  list, Europe PMC/PMC S3 origins, Stop timing, and the step-6 baseline (it compared against the step-1 template; now
  step 5's `pdftotext` of the agent PDF vs the re-imported recompile, letters-only — equal on all three runs checked).
  **Measured:** the `openrouter` engine checks every claim against every passage (top-10 is hosted-only by design,
  `src/core/verify/strategy.ts`), so one ~150-word-per-section document took 1,800–3,900 decision calls: cents on the paid
  model, but beyond OpenRouter's free tier (1,000/day, 20/min) — this is what exhausted the free pool in the 8b run.
  Quality notes (evidence, not pass criteria): drafts cite only papers with acquired full text (here one survey); the
  model did not add a heading for the second section.
- **9i (2026-10-22, web only, test first): stable session id + per-reply token usage.** The parent agent gets one
  `sessionId` per project conversation (pi-agent-core `Agent` option; pi-ai 1.4.0 sends it as `x-session-id`, OpenRouter's
  sticky-routing header); each `write_section` run gets its own derived id (`<parent>:ws<n>`; its prefix differs from the
  parent's). Ids are a fixed prefix plus random hex, memory only. Each reply shows `tokens: … in (… cached) · … out · $…`;
  the `write_section` row shows the child's totals; seam builds expose `__uktubAgent.usage`. **Measured** (one live full
  flow, 30/30, US$0.0675, evidence `~/.cache/uktub-bench/hermes-web-phase9i-2026-10-22/live/`): 69,086 billed input,
  225,536 cached, 6,529 output tokens (77 % of input from cache; the ~4.9K-token parent prefix is cached from the second
  call on). **Not measured:** a no-session-id control, so how much of the caching the id causes (versus DeepSeek's
  automatic prefix cache hitting anyway) is inferred. The run's higher cost than the US$0.044 run is verification volume
  (4,232 vs 2,520 decision calls), which the openrouter verify A/B (running 2026-10-22) measures. The harness now also records the writing
  conversation's usage before the export/import step (`verdict.usageWriting`).
- **Fixed (orchestrator, test first, 2026-10-21): a cite after the full stop escaped the registry check.**
  `Sentence. \cite{fake}` attaches to no unit (frozen segmentation), so its key never reached
  `summary.unregistered`, which feeds the pre-completion gate, and Tier 1 T1.1/T1.2 read only unit cites. The audit
  now adds every cite key in the document (`documentCiteKeys`, comments stripped, never `\nocite{*}`) to
  `unregistered` and reports them as `summary.citeKeys`; Tier 1 reads `citeKeys` when present
  (`tests/provenance-cite-keys.spec.ts`; RED: `unregistered` was `[]`). **Measurement note:** Tier 1 citation checks are
  now stricter than in runs scored before 2026-10-21. Replayed (`scripts/live/replay-checks.ts`) on the 12 of 122
  archived runs whose manuscripts contain `. \cite`: the cited-key count is unchanged in all 12 (no key existed only
  after a full stop), so no recorded pass depended on the gap. Separately, the 6 older `rf-llm-literature-review`
  runs replay T1.1 as FAIL because their `registry.json` predates the `citable` field (a pre-existing replay
  incompatibility, not this change).
- **Six tools over one MCP server**, plus a Node CLI and a Pi package: `papers` (search OpenAlex / Semantic Scholar);
  `registry` (register papers, lawful full-text acquisition, BibTeX from the registry); `passages` (exact chunks with
  pointers); `verify` (claim support; document mode checks a whole manuscript as written); `compile` (LaTeX via Tectonic
  plus a provenance audit); `doctor` (setup self-diagnosis with the fix per problem).
- **Pi-only:** `write_section`, a section writer limited to passages, auto-verified, default-on (`UKTUB_SECTION_WRITER=off` disables).
- **Direction (VISION):** the agent is a general scientific research assistant (literature, writing, analysis, code).
  Honesty is enforced by tools, not prompt length. Browser-first static app later (UI last). No Uktub backend.

## 2. State (2026-10-17)

| Area | State |
|---|---|
| Code | `main` at `d5f21fa` plus reviewed uncommitted work (§2.1–§2.4). Counts in §6 |
| Verification | Default engine `hosted` = `vllm-sr/d3-mini` at `https://decision.vllm-sr.ai`. Free key in `UKTUB_VERIFY_API_KEY`; refuses without it. Local Eos selectable. Hosted uses **criteria wording** (protocol `systemone-noul-criteria-v1`) and the **top-10 candidate** strategy, with shared 429 backoff |
| Registry | Schema v6: `claim_ledger` keeps released evidence durably (verbatim claim text) |
| Prompt | Short core prompt (`src/core/agent-rules.ts`, about 1,300 chars). Tool mechanics live in the tool descriptions. Prompts unchanged by the lifecycle work |
| Writing workflow | Built and verified in the acceptance batch: plan → `write_section` per section → assemble → `verify` document mode (paged, 50 units per call) → resolve → done |
| Acceptance | **Tier 1: 100 % PASS (16/16). Tier 2: PASS (single-grader, completed 2026-10-17).** Central numbers in §5. The accepted historical batch is **not** a Pi 1.3 qualification |
| Lifecycle hardening | Implemented, offline-green, and **section-smoke live-qualified on Pi 1.3.0** (§2.2). No additional orchestration framework |
| Browser track, UI | **One static-browser workflow qualified** across all 6 tools, hosted `verify` (claim + document), `cancelTool`, OPFS persistence/reopen and export (§2.3). UI last |
| Pins | §8. Project Pi 1.3.0; Docker sandbox rebuilt and boundary-probed on Pi 1.3.0 (`sha256:8f841fa8ceeb…`); global CLI unchanged |
| Background tasks | None running; none intended |

### 2.1 Uncommitted on main (all reviewed)

Correctness-review fixes for `d5f21fa`: CLI `verify --offset`; per-unit length `skipped`; memoized engine identity probe;
`write_section` query/continuation forwarding and incomplete count; empty input refused; mixed citekeys checked against
the known ones. One shared question builder (`wording.ts`, protocol `systemone-noul-criteria-v1`). Hosted `top10`
strategy (`strategy.ts`, env override). Shared 429 retry (`claim.ts`). Computed-results audit (`provenance/results.ts`,
glob `results/**/*.{csv,json,txt,log}`, 1 MB/file, 100 files, project-root-only). Cleanup 2026-10-16: `evolve` remnants
(~4,760 lines), held-out/OOD scenarios, stale `docs/BACKLOG.md` and the narrative benchmark report archived outside the
repo; deleted report/evolution files stay deleted. Grading corpus accepts any non-keyed lawful origin, with an
`ungradeable` label; figures extractor reads magnitude tokens. Grading-resume repair (harness only): grader A needs only
Docker plus `OPENCODE_API_KEY`; A-only `adjudicate` finalizes locally as single-grader; two-grader path retained.
Continuation fix (`verify/workflow.ts`): first call freezes run-start scope and ranked candidates; continuations replay
order, never re-rank; strategy in `scopeKey`; protocol/model/bar changes refused `CONTINUATION_INVALID`; tokens
v2→v3, v2 refused. Schema stays v6.

### 2.2 Section-writer lifecycle hardening (2026-10-17, uncommitted, section-smoke live-qualified on Pi 1.3.0)

- **New all-page writer:** completion accounts for **every** verification page; one repair round covers all pages;
  incomplete checks stay reported as incomplete, never silently complete. **Cancellation/abort settlement**
  in core HTTP/429 paths: timer cancellation on abort; abort reaches owned child work; Eos drains its active batch
  instead of being killed. **Child current-prompt-output integrity:** only the current prompt's output text is used;
  error, truncated and stale-draft outputs are rejected with static error categories without raw provider details.
- **Sandbox & live record (`run-20261017-c`, `run-20261017-d`, `direct-focused-20261017-b`, Pi 1.3.0 in Docker `sha256:8f841fa8ceeb478dbe74a547f1969a0ab9f3e29551952c46e4bcafc648f0eacc`):**
  boundary probe PASS (37/37 checks ok: 35 expected blocks/allows, 2 documented exposures, 0 failures; `boundary-probe-20261017/boundary-report.json`); focused direct MCP/CLI suite (`registry.register-mixed`, `cli.exit-contracts-and-init`, `cli.mcp-install-preserves-and-handshakes`, `compile.multi-file-input`, `doctor.reports-setup`) **5/5 PASS** (`live/direct-focused-20261017-b`).
  Earlier `run-20261017-a` failed in `write_section` with a hidden provider error and `run-20261017-b` was stopped early for quota.
  In `run-20261017-c` (`live/run-20261017-c/smoke-result.json`) and `run-20261017-d` (`live/run-20261017-d/smoke-result.json`):
  - **Single-page happy path (`case1`, `pass`, `run-20261017-d`):** parent primary hit Vertex 429 on turn start and `startAgent` reran once on `google-vertex/gemini-3.5-flash-lite`; `write_section` produced **`n = 5` units**, 1 repair round (`repaired: true`), finishing with **`ok = 5 / 5` (`incomplete = 0`, `retries = 0`)**.
  - **Graceful cancellation (`case3`, `cancel-observed`, `run-20261017-c`):** parent primary `google-vertex/gemini-3.8-flash` hit Vertex 429 on turn start and `startAgent` reran once on `google-vertex/gemini-3.5-flash-lite`; RPC `abort` sent 24 ms after `write_section` start was acked (`abortAcked: true`), settled in 2,003 ms with `activeCallEnd: { isError: true, textHead: "This operation was aborted" }`, `agentSettled: true`, `newStartsAfterAbort: []`.
  - **Multi-page completion (`case2`, `pass-live->50`, `run-20261017-c`):** parent `google-vertex/gemini-3.8-flash` dispatched `write_section`; child called `passages` once then hit HTTP 429 (`the writer provider rate-limited the request (HTTP 429 / RESOURCE_EXHAUSTED)`), triggering the one permitted labelled fresh-session fallback on `google-vertex/gemini-3.5-flash-lite`. Produced **`n = 60` units**, verified across 2 pages (`offset = 0`, `offset = 50`) with 1 repair round (`repaired: true`), finishing with **`ok = 49 / 60` (`incomplete = 0`)**, matching the independent 2-page MCP `verify` recount (`49 / 60`). On Pi 1.3.0, child `ctx.executeTool` also emits `tool_execution_start`/`end` on the parent RPC stream (7 events).
  - **Limitation:** proves all 3 `write_section` lifecycle smoke cases (`case1` `<50`, `case2` `>50` paging, `case3` cancellation) plus 5 focused direct MCP/CLI cases on Pi 1.3.0 (with labelled Vertex 429 fallback to `gemini-3.5-flash-lite`), not a full 6-tool live acceptance rerun on Pi 1.3.0. Raw data: `docs/benchmarks/section-lifecycle-2026-10-17.json`.

### 2.3 Static-browser workflow qualification (2026-10-17, uncommitted, Chromium-qualified)

- **Browser worker & core seams (`src/browser/host.ts`, `src/browser/worker.ts`, `src/browser/provider-fetch.ts`, `src/core/verify/workflow.ts`, `src/core/verify/engines.ts`, `src/core/tools/doctor.ts`):**
  all **6 tool graphs** (`papers`/`search`, `registry`, `passages`, `verify`, `compile`, `doctor`) bundle cleanly with zero unexpected Node globals (`tests-browser/bundle.spec.ts`, `tests-browser/node-globals.spec.ts`). `verifyWorkflow` forwards `ctx.fetch` into `createConfiguredEngine` and `resolveEngineIdentityCached` so hosted `vllm-sr/d3-mini` and `openrouter` run directly in the Web Worker over `platformFetch` (`DownloadLike.fetch`). `createBrowserFetch` enforces `https:` and no-userinfo string URLs, normalizes `Headers`/tuple/record headers, and scopes `Authorization` headers strictly to the verifier API origins (`https://decision.vllm-sr.ai`, `https://openrouter.ai`), dropping them on all other origins. `doctor.ts` lazily initializes `execFile` inside `compileCheck` so bundling in the browser requires no `node:child_process` at module load. `hostCallTool` registers a per-call `AbortController` (`signal` on `ToolContext`) and `hostCancelTool` (`cancelTool` worker RPC) aborts in-flight tool calls. `src/browser/host.ts` and `src/browser/worker.ts` also expose `provenance` (`hostRunProvenance` over `/proj` with `\input` expansion and `results/*.csv` computed-figure matching), guarded project file-store RPC ops (`writeFile`, `readFile`, `listFiles`, `deleteFile`, confined to `/proj`, capped at `MAX_SOURCE_BYTES`, and refusing `.registry/*`, `.git/*`, and writes/deletes to `refs/references.bib`), `importSource` (manual PDF/TEI import staged under `papers/<filename>` and attached via `attach_source` with atomic cleanup on refusal), and `importProject` (full project `.zip` + `.registry/registry.db` restore into OPFS with schema validation and rollback on corrupt/foreign databases).
- **End-to-end Chromium workflow (`tests-browser/tools.spec.ts`, 23/23 browser tests, 30/30 `tests-browser-net`):** `doctor` (initial + ready with `2 computed figure(s) from project result files`, plus hosted 401 and wrong-model probe error diagnosis, plus `openrouter` engine check) → `papers` / `search` (OpenAlex + Semantic Scholar, alias equivalence) → `registry` (`register`, `acquire` arXiv PDF via DataCite + arXiv, `attach` TEI XML + PDF, `sync_bibliography`) → `importSource` (manual PDF staging + `attach_source` + FTS5 indexing, plus orphan cleanup on unregistered-paper refusal) → `passages` → `verify` claim mode (hosted d3-mini + OpenRouter direct-passage, SQLite judgment cache) → `verify` document mode (both LaTeX `text` fragment and multi-file `{ document: "manuscript/main.tex" }` expanding `\input{sections/intro}` + `claim_ledger` release) → `provenance` (`manuscript/main.tex`: 2 `verified` statements from `claim_ledger` + 2 `computed` figures matched against `results/bench.csv`) → guarded file-store RPC ops (`writeFile`, `readFile` including read-only `refs/references.bib`, `listFiles`, `deleteFile`, plus traversal and tool-owned path refusals) → worker termination + reopen on OPFS `opfs-sahpool` SQLite (cached judgment reused in `<2 s` without hitting the 5,000 ms route) → in-flight `cancelTool` in both claim mode (`INTERRUPTED (cancelled)`, `fresh = 0`, `v3` continuation token issued) and document mode (`CancelledError`), `cancelTool` idempotence on unknown/settled callIds, and concurrent call isolation (cancelling slow `verify` leaves concurrent `passages` unaffected) → `exportProject` & `importProject` round-trip (valid `.zip` with `refs/references.bib`, `manuscript/main.tex`, `manuscript/sections/intro.tex`, `results/bench.csv` + `SQLite format 3` `.registry/registry.db` bytes restored into a fresh worker, plus atomic rollback on non-SQLite or foreign `user_version = 999` DBs and path-escaping zips) → Session 3 reload resuming the interrupted `v3` continuation token from OPFS SQLite (`CONTINUATION_INVALID` on scope mismatch, then `work.complete = true, fresh = 1, supportFound = true`). Differential steps match Node (`diffs = 0`). **Limitation:** Chromium tests use deterministic canned HTTPS routes over real Worker/OPFS/`platformFetch` seams; `compile` remains a typed refusal (`COMPILE_ENGINE_MISSING`) in the browser until a WASM TeX engine is wired.

### 2.4 Harness audit hardening (2026-10-18, uncommitted, offline-green + live MCP smoke)

Audit of lifecycle, cancellation, concurrency, coverage and simplification (findings reproduced by probes, then each
fix test-first: red for the defect's reason, then green). **Fixed:** Eos resident worker (`claim.ts`): a failed worker's
600 s timer no longer outlives it (it kept CLI processes alive 10 min and later SIGKILLed the next healthy worker); a worker
that exits while idle is respawned instead of written to (hang/EPIPE); exit hooks removed; 429/401 bodies cancelled;
unreadable hosted 200 bodies are a static `EngineError`. Provider cancellation: `fetchWithRetry` takes the caller signal
(attempts and backoff abort; never retried), threaded from `papers` and acquisition (`ProviderConfig.signal`); a waiter on
a shared acquisition whose owner was cancelled takes over (`acquire.ts`). Browser: `client.ts` internal correlation ids
(a late reply cannot settle a reused callId), timeout sends `cancelTool`, `terminate()` before boot rejects waiters,
`close()` shared; `lock.ts` grant/refusal from the Web Locks callback (no 1 s poll, no fail-open); `host.ts` close awaits
running calls, duplicate in-flight callId refused, import docblock states the real rollback; `download.ts` cancels unread
bodies. Dead code removed (5 unused exports, an unreachable CLI case, two dangling doc references).
**Live smoke (real stdio MCP, Node 26.3.1):** 6 tools listed; `papers` live 3 candidates (S2 429 as typed warning);
a `papers` call aborted at 150 ms rejects at 151 ms and the server answers the next call; `registry register` + `acquire`
(arXiv PDF) + hosted `verify` SUPPORT FOUND (2 passages). Not a Pi live acceptance rerun.
**Round 2 (same day, residuals of the first round, test-first):** an OpenAlex 200 body without its `results` array is a
`PROVIDER_FAILED` warning, not zero hits (OpenAlex paging docs: an empty page is `results: []`; S2 and Crossref left as is,
their docs do not guarantee the container); a Europe PMC search without `hitCount` or a 5xx, and a PMC open-data 5xx or
unreadable listing, are `failed/download_failed` instead of `no_open_copy` (Europe PMC documents zero hits as HTTP 200 +
`hitCount: 0`); `compile` honours cancellation (the Tectonic child is killed) and names a 16 MiB output overflow instead of
a bare exit 1; `registry register` aborts every in-flight metadata lookup on cancel (lookups stay concurrent; papers
committed before the abort stay); S2 and arXiv spacing waits are abortable without letting a later caller start early;
owner decision: a post-boot Worker `error` is fatal in `client.ts` (worker terminated, later calls refused at once);
`importProject` stays as documented (owner decision). Live: a busy-looping `compile` aborted at 300 ms rejects at 324 ms
and no Tectonic process remains; a real Tectonic 0.15.0 compile of a citing manuscript succeeds.
**S2 lookup (same day):** with the owner's S2 key available, the Semantic Scholar open-access lookup follows the same rule:
HTTP 404 (documented unknown paper) and a 200 without a copy are `no_open_copy`; 429/5xx/network/unreadable are
`failed/download_failed` (one older assertion that an S2 500 "never changes the outcome" was the old rule and now asserts
`failed`; a 429 still never overrides a more specific failure such as `identity_mismatch`). Live smoke rerun with the
`.env` keys loaded through `scripts/live/keys.ts` (names only, never printed): S2 answered `papers` without a 429 warning.
**S2 key fallback (owner decision, same day):** a keyed S2 request answered 401/403/429 (after the retry policy) is repeated
once without the key in the public pool, after the spacer (`semanticScholarGet`, used by search and the open-access lookup;
500 never falls back; no key → no duplicate). Live: owner key → one keyed 200; an invalid key → keyed 403, then keyless,
but the public pool answered 429 on all 3 attempts in two runs from this machine (search ends in the typed S2 warning;
OpenAlex/Crossref still answer). In the browser the fetch adapter keeps `x-api-key` for the S2 API origin only (until
2026-10-21 it dropped it everywhere on a misread CORS probe; see §0), and S2's 401/403/429 are unreadable there (no ACAO).

### 2.5 Live full-session stress smoke, 50-reference review (2026-10-18, owner request)

Scenario `experiments/scenarios/rag-review-50refs-v1.md` (RAG review from scratch, 30–50 references, one table, one
revision). Real Pi 1.3.0 in Docker on `google-vertex/gemini-3.8-flash`, product defaults, hosted verify, scripted user,
owner provider keys. Raw: `docs/benchmarks/rag-review-50refs-2026-10-18.json`. Not an acceptance batch.
- **iter-01: BLOCKED** at the harness per-turn hard cap (90 min) inside the first draft. Setup took 3 min (39 papers
  registered (1 later removed), 28 acquired); the first `write_section` took 51 min, ~39 min of it in 14 child model gaps
  of 63–551 s (cause unknown: Vertex stream stalls are a hypothesis only; child-session retries are not logged anywhere).
  Six finished sections were held in context only, so nothing reached disk.
- **iter-02 (`--turn-max-minutes 170`, new harness flag): success, VALID, Tier 1 5/5.** 134.6 min wall (turn 1 123 min,
  revision 11 min), 35 papers registered and all 35 cited (the five named anchors included; bibliography = registry),
  ~3,400 words, 29 headings, one comparison table, the requested failure-modes subsection, 11-page PDF compiled after the
  last edit. Final document-mode `verify` (164 units): 145 supported, **8 unsourced** (abstract, one sentence, the table
  caption and header row), **10 table rows `cited-unsupported`**, 1 skipped. The provenance summary's "uncited 0" does not
  contradict this: `audit.ts` skips units with neither a citation nor a figure, so uncited prose is not counted there, and
  Tier 1 gates figures, not unsourced prose (figures 58 ok, 0 open). **Skill step 5 was not followed:** none of the 18
  unresolved units is marked unverified in the text, and the final report's limits list none of them; nothing gated it.
  Replayed under Tier 1 v2 (six gated checks, D1): 5 PASS, **`prose-verified-or-labelled` FAIL, 7 units** (abstract ×5,
  one sentence, the table caption; `\bibliographystyle{plain}` is excluded by the audit, segmentation stays frozen). 766 tool calls (525 `verify`, 210 `passages`,
  14 `compile`), no fallback turn; $2.50 is the parent session only (child `write_section` usage is not recorded).
- **iter-03/04 (2026-10-19, 3.8 flash): Vertex capacity.** iter-03 BLOCKED after 22 min: 13 Pi retries (6× 429
  RESOURCE_EXHAUSTED, 7× `fetch failed`), the last call exhausted all 6 attempts (the sandbox already uses the global
  endpoint). iter-04 stopped by the orchestrator after 90 min with one section done; that section's child, the first
  live child measurement: 73 turns, **14 retries**, 57 tool calls, 45.5 min, $0.60 for 249 words (12/16 first draft, 16/16
  after repair).
- **iter-05 (owner: flash-lite 3.5) and iter-06 (owner: Muse 1.3 Contributor via OpenCode Go), both VALID, 2 turns,
  ~19 min, Tier 1 v2 5/6:** both FAIL `prose-verified-or-labelled`. iter-05: 18 of 35 papers cited, 2,332 words,
  4 of 95 audited statements verified (71 cited-only: rewritten supported sentences), 84 unlabelled, $0.57 total
  ($0.42 child). iter-06: 35 cited, 3,471 words, 151 of 175 verified, 12 unlabelled, $0.066 total ($0.046 child),
  0 retries. **Root cause for both:** the agent never read the research skill (0 `read` calls on `SKILL.md`; iter-02 on
  3.8 flash read it twice), so the skill's D2 and D1 steps never reached it; iter-06 saw compile's `UNLABELLED` list and
  still finished with 12. No run has used `manuscript/sections/`.

## 3. Decisions in force (owner unless marked)

**Verification:** hosted d3-mini is the default; local Eos selectable; no silent engine fallback; `doctor` reports setup.
The product asks the verifier exactly as benchmarked (`instructions` + separate `criteria`, one shared builder). Hosted uses
`top10` (pre-registered A/B, §5); windowed V2 is the next recall candidate (backlog). **Prompt and tools:** short core
prompt (owner-approved text in `agent-rules.ts`); moved mechanics stay visible in instructions or a tool description (a
test pins this). Six tools (`doctor` added); default engine `hosted`.
**Measurement:** two-tier acceptance. Tier 1: deterministic, every run passes (citations in registry; bibliography =
registry; PDF newer than last `.tex`; pointers resolve; no `open`/`unsourced` figure). Tier 2: blind fact-check, bad rate
among cited units ≤ 5 %, linearized-t CI upper bound ≤ 10 %, 0 trap violations. The LLM grader is a dev tool
(Muse via OpenCode Go). Scripted user turns replace the simulated user in measured batches; simulator/visibility arms stay
in code. Removed: `vela`, `pnpm evolve`, agent-authored `claims.json`.
**Harness (learned the hard way):** never open an archived registry in place (copy with `cp -p`); edit nothing in the repo
during a measured batch; nothing else may call the hosted API during a measured batch; merge a worker's worktree only as
base-vs-worktree delta.
**Harness design (2026-10-17, orchestrator):** keep the host agent loop, six scholarly tools and bounded Pi section writer.
Preserve run-start papers and ranked candidates; new papers enter a new request. Completion accounts for all verification
pages; cancellation reaches owned child work. Reuse host compaction, bounded tool output, on-demand skills. Keep the
accepted batch as regression baseline. After section-writer hardening, qualify one workflow through the existing Worker,
core and storage seams before expanding the UI. Static hosting, browser-owned data and direct researcher credentials stay
binding.
**Harness decisions (owner, 2026-10-18, after the 50-reference smoke and two reviews):** **D1** a prose unit that is not
verified as written may ship only if labelled unverified in its text (convention: the word "unverified"); an unlabelled
one fails a new gated Tier 1 check (table rows excluded). **D2** the skill saves each `write_section` result to
`manuscript/sections/NN.tex` (assembled with `\input`) and revises by targeted edits; the tool itself still writes nothing.
**D4** table rows get a row-level figure check (numbers found in the cited paper; row wording labelled not verified),
outside the prose gate. **D6** order: unsourced-prose reporting and the D1 gate, child `write_section` usage/retries plus
first-draft counts, harness attribution first; then D2 and D4; the child-loop restructure only after child cost is
measured, with a redesigned A/B (one model, N=12 per arm, blind Tier 2 grader as the non-inferiority safety metric).
Orchestrator: the child stays on the parent's model (a cheaper model is a model decision); the 90 min turn cap stays as
default plus `--turn-max-minutes` until child events make child activity visible to the idle guard; building the passage
index at acquire time is deferred (iter-02: 508 s of `passages`, ~6 % of wall; eager indexing moves the same work, and
overlap needs new background machinery).
**Owner, 2026-10-19:** the skill's document-writing workflow is always on in Pi (system prompt), since flash-lite and Muse
never opened the on-demand skill; flash-lite 3.5 is not used as a writer; OpenCode Muse 1.3 Contributor and MiniMax M3.1
Flash Free (`opencode-go/minimax-m3.1-flash-free`, a harness `models.json` entry; not in Pi 1.3's catalog) serve as
writers and reviewers (grader A Muse, grader B MiniMax); Muse is the single model for the section-writer A/B; experiments
stay scoped (pilot first: arm `child-passages` vs current, N=3 each on Muse).
**2026-10-20:** the bounded pre-completion gate (owner approved building it) is merged and default on, adopted on evidence
(iter-12 finished with 78 unlabelled despite the always-on workflow; the gate probe: on 2/2 pass, off 2/2 fail).
`child-passages` not promoted (pilot: not faster, no honesty gain).
**MVP direction (owner, 2026-10-20):** the browser app is the MVP and is **100% client side** (no backend or proxy of
any kind; static hosting only). UI: an **Overleaf-like LaTeX workspace with reliable in-browser compilation to PDF**,
built on whichever open-source client-side editor/engine repo the research shows fits best (UI stack follows that
choice). Agent loop: **reuse `@earendil-works/pi-agent-core`** in the browser (the always-on workflow, `write_section`
and the pre-completion gate move to a runtime-neutral module shared with the Pi package). Models: **expose every
provider Pi supports dynamically from pi-ai's catalog** for the user to pick with their own key; nothing hardcoded.
Research done 2026-10-20 (`~/.cache/uktub-bench/hermes-latex-editor-research-2026-10-20/REPORT.md`; pi-ai catalog/CORS
notes in the session scratch). **Owner decisions (2026-10-20): fork the TeXlyre app** (AGPL-3.0-or-later React +
CodeMirror Overleaf-like editor on `texlyre-busytex` 1.4.1: TeX Live 2026, pdf/Xe/LuaTeX, bibtex8, Biber, SyncTeX, Web
Worker) and add the agent panel; **self-host the TeX assets** (~32 MB WASM + 90–400 MB data) as static files;
**XeLaTeX by default** (same family as the Node product's Tectonic; BibTeX via bibtex8); **model picker lists every
API-key provider from pi-ai's catalog** (42 providers / 1,614 chat models in 1.3.0; no hardcoded list) and tests a key
with one real call, marking CORS-blocked providers; OAuth-only providers out of v1. Measured: ~15 API-key providers allow
browser calls (OpenAI, Anthropic, Google, Mistral, OpenRouter, Groq, xAI, DeepSeek, …); MiniMax, Fireworks, Moonshot,
Baseten, Vercel block them; OpenCode inconclusive (preflight 404/405) — Muse/MiniMax via OpenCode may not be usable from a
browser; Bedrock, Vertex (ADC) and Codex OAuth are impossible by construction.
**Integration design (Hermes, citations spot-checked; `~/.cache/uktub-bench/hermes-texlyre-design-2026-10-20/DESIGN.md`):**
Uktub's OPFS `/proj` owns all project files; TeXlyre's IndexedDB/Yjs store becomes a view flushed back on save,
pre-compile and pre-tool-call; agent panel on `pi-agent-core` with the six tools via `UktubBrowserClient`; section writer,
workflow and gate move to a runtime-neutral module; browser `compile` = BusyTeX XeLaTeX + bibtex8 (no COOP/COEP needed:
plain Worker). **Owner, 2026-10-20:** self-host the **recommended ~200 MB** TeX Live bundle; **fixed Uktub layout** for new
projects (`manuscript/main.tex`, `manuscript/sections/`, tool-owned `refs/references.bib`, `results/`). Orchestrator
defaults: Yjs kept in memory only for open editors (no y-indexeddb, no collab); BibTeX only (no biblatex) in the MVP;
`web/` is a standalone package with its own lockfile (root dependencies untouched). Phases (each with a Playwright check):
1 fork builds · 2 self-hosted assets + BibTeX→PDF · 3 XeLaTeX default, strip collab/Typst/SwiftLaTeX · 4 `/proj` bridge ·
5 agent panel + catalog picker + key test · 6 tools from the panel · 7 browser `compile` on BusyTeX · 8 runtime-neutral
section writer/workflow/gate · 9 polish + full-flow test.
**Verification and section-writer redesign (owner, 2026-10-23; plan in §7 item 6; not built yet).** Why: one live
document cost 1,800–4,200 decision requests (each = one claim vs one 512-token chunk, every chunk of the cited paper).
- Verification runs free-style when the agent checks claims about papers, and automatically only after a section is
  written. The judging unit becomes a whole **paper section** (cap 16,000 chars, client policy; hosted d3-mini accepts
  32,000), all claims citing a paper go in **one request** as keyed questions, and a paper supports a claim iff **any** of
  its sections scores ≥ 0.99. **REFERENCES sections are excluded** and disclosed. `passages` keeps its 512-token chunks.
- A claim citing several papers is verified only if **every** cited paper supports it.
- **Section writers** are agentic, read full text through the normal tools (`passages`, `registry` read, `verify`), and
  see a registry **scoped in code** to the ≤ 20 full-text papers the parent assigns (others refused up front). They mark
  each claim with a trailing `% cN` comment (neutral to the provenance audit; a macro marker is not) and list its sources
  (`cN | citekey | section=…` or `ptr=…`, several per claim). A stated source the writer never opened is reported as
  `unread-source` with a repair hint; the verdict does not change.
- **No summaries or paper cards**; the registry abstract stays a triage field only. Abstract-backed support is out of scope.
- The **parent writes abstract, introduction and conclusion last**, from the written sections, without reading full text;
  they are verified like any prose (the verifier reads the papers).
- Testing on the **local Node harness only** (no browser UI tests); writer models Vertex `gemini-3.8-flash` and OpenCode Go
  `minimax-m3.1-flash-free`; verifiers hosted d3-mini (`.env` `VLLM_decision_API`) and OpenRouter **free** models only.
  The browser keeps today's verification until a later phase. The new path becomes default only after the pre-registered
  A/B `docs/benchmarks/section-verify-ab-2026-10-23.json` passes.

## 4. Why written notes contained unsupported statements (root cause, traced 2026-10-14)

365 faulty units in 18 Gemini-written notes (`scripts/live/trace-causes.ts`, `docs/benchmarks/trace-causes-2026-10-14.json`).
(1) Verification was decoupled from writing: only 13 of 365 faulty units ever reached `verify`; 93 % were written in the
first-draft bulk write. (2) Uncited specific facts from memory dominate: 329 of 365; only ~5 % have support in any
registered paper, so they must be prevented while writing. (3) Checking text as written is trustworthy: 0 of 174
`supported` verdicts were faulty. (4) Model–tool fragility (resolved 2026-10-16): Pi 1.1.0's local
`validateToolArguments` rejected scoped `verify`/`passages` calls; fixed via two-layer contract + boundary normalization
(`src/core/verify/scope.ts`, `src/core/tools/verify.ts`, `src/core/tools/passages.ts`).

## 5. Key measurements (raw data in `docs/benchmarks/`)

- **Verifier, claim-verification-v2 (547 claims):** d3-mini 93 % recall at ~1 % false supports vs Eos 49 %; at the 0.99 bar
  0/278 false (Eos 7/278). Raw: `claims-v2-d3-mini-api-2026-10-14.results.json`. **Wording root cause, product path
  (110 claims):** bare claim 10 false supports at the bar (of 60); criteria wording 0 (two runs). Criteria adopted.
- **Strategy A/B, criteria protocol (547 claims + document mode on 18 notes):** exhaustive 0.888 recall at 2 % false
  supports, 7,396 s documents; **top10 adopted** 0.978, 505 s (14.6x faster); windows-4 0.989, 676 s; 2048-token chunks
  0.985, 727 s. Batching gave no product-path savings, not adopted.
- **Sections A/B (`sections-ab-2`, 2026-10-16):** 12/12 VALID, 0 HTTP 429s, raw `sections-ab-2-2026-10-16.json`.
  `sections` (C1) beat `single-session` (C0) on objective document-mode `verify`: unsourced 29.4 vs 35.6 /100 units;
  supported share 26 % vs 18 %; Tier 1 0.93 both arms. Inside C1, 176/186 write-subsession units (94.6 %) were verified
  `supported` before return; losses came from parent non-invocation and post-return paraphrasing — fixed by making
  `write_section` default-on.
- **Two-Tier Acceptance Batch (`acceptance-batch-2026-10-16`, 2026-10-16):** 16 sequential runs, seed `20261016`,
  constant tree hash `99ce9ec2a85c4bb82fec41c5a0d5a85fab3d7478`, total cost $0.6197, 255.1 min wall.
  **Tier 1: 16/16 (100 %) PASS** on all 5 gated checks; 0 invalid tool calls, 0 continuation refusals, 0 schema errors.
  **Tier 2: PASS (single-grader, 2026-10-17).** All 16 notes finalized, one attempt each, no retries. Of 1,007 cited units
  (1,366 total), 8 were `ungradeable` (papers missing from the frozen corpus); the remaining 999 include 6 bad units:
  **0.6006 %**, 95 % linearized-t CI **[0 %, 1.4892 %]**, **0 trap violations** (thresholds: ≤ 5 %, CI upper ≤ 10 %,
  0 traps). Grader `opencode-go/muse-spark-1.3-contributor`, rubric `factcheck-rubric-v1.md` (`c2ce30d3…`). Input
  correction: all 8 RF exports carried the adapter trap; trap string replaced per `trap-input/input-repair.json`; the 3
  original RF labels were superseded as trap-invalid and regraded with the pending 13. No two-grader adjudication
  claimed. Single dev grader; missing-corpus exclusions disclosed; no fresh Vertex rerun (grader is Muse). Resume
  scratch: `/home/mahmoud/.cache/uktub-bench/acceptance-resume-2026-10-17/`.
- **Exact executed grading commands (reproducibility record):**
  ```bash
  cd /home/mahmoud/Desktop/AI_Projects/UktubAI/Uktub-scholar
  export UKTUB_GRADING_DIR=/home/mahmoud/.cache/uktub-bench/acceptance-batch/grading
  node scripts/live/grade.ts run --grader A 1a57b9bc 4cd1de74 50231dee 64b607dd 75cf5526 a18c24a4 b394d870 c615e523 d04d8d71 e0b7b3fd e4becfba ebd15591 ee7a8aed
  node scripts/live/grade.ts run --grader A 61b97833 9cc3563f da41435a
  node scripts/live/grade.ts adjudicate 61b97833 9cc3563f da41435a 1a57b9bc 4cd1de74 50231dee 64b607dd 75cf5526 a18c24a4 b394d870 c615e523 d04d8d71 e0b7b3fd e4becfba ebd15591 ee7a8aed
  node scripts/live/analysis.ts --grading-dir $UKTUB_GRADING_DIR
  ```
- **Live suites on the current prompt:** agent suite 10/10; skill suite **9/9 PASS**; `doctor` live direct case PASS.

## 6. How to work and test

**Checks:** `pnpm exec tsc --noEmit`, `pnpm exec tsc --noEmit --noUnusedLocals --noUnusedParameters`, `pnpm test`.
- 2026-10-17, after grading harness repair: both typechecks PASS; `pnpm test` 1,474 total / 1,473 pass / 0 fail / 1 skip
  (code unchanged through that grading batch; `doctor` exits 0 but reports missing `UKTUB_VERIFY_API_KEY` in a bare shell;
  with the repo key mapping, hosted d3-mini probe and Tectonic 0.15.0 passed). After continuation fix: both Node `tsc`
  PASS, `pnpm typecheck:browser` PASS, `pnpm test` 1,484 total / 1,483 pass / 0 fail / 1 skip; new
  `tests/verify-continuation-integrity.spec.ts` 10 pass (8 red before the fix); offline CLI smoke (7 fresh processes,
  all 20 fixture chunks exactly once) under `/home/mahmoud/.cache/uktub-bench/harness-design-2026-10-17/` — not live.
- **Current, after Pi 1.3.0 sandbox qualification, live section smoke and static-browser qualification:** both exact Node `tsc`
  commands PASS; `pnpm typecheck:browser` PASS; `pnpm test` **1,527 total / 1,526 pass / 0 fail / 1 skip** (opt-in real-binary
  compile test); `pnpm test:browser` **25 total / 25 pass / 0 fail / 0 skip** (`bundled 6 tool graphs` + `UktubBrowserClient`); `tests-browser-net` **31 total / 31 pass / 0 fail** (timer cleanup fix in `src/browser/download.ts`, reducing suite run from 60.1 s to 0.12 s). `doctor` reports
  Tectonic 0.15.0 available; the bare shell lacks the verification key, project registry and optional provider keys. The
  harness supplies the existing key mapping; no secrets printed. Evidence: `docs/benchmarks/section-lifecycle-2026-10-17.json`.
- **Current, after the 2026-10-18 audit hardening (§2.4, both rounds), Node 26.3.1:** all three typechecks PASS; `pnpm test`
  **1,573 total / 1,572 pass / 0 fail / 1 skip**; `pnpm test:browser` **36 / 36**; `tests-browser-net` (3 specs) **35 / 35**.
- **Current, after D1 gate, `write_section` child observability and harness attribution (2026-10-18):** three typechecks
  PASS; `pnpm test` **1,596 / 1,595 pass / 0 fail / 1 skip**; `pnpm test:browser` **36 / 36**; `tests-browser-net` **35 / 35**.
  Not yet live-run: child figures appear in `metrics.json` only from the next live run (older runs report
  `childUsageMissing` for every `write_section`).

Live suites (real Pi; `AGENTS.md` rules): `pnpm live:probe`, `pnpm live:direct`, `pnpm live:agent`, `pnpm live:skills`;
single cases via `node scripts/live/run.ts --suite agent --only <id,...>` (include prerequisites like
`agent.setup-collection`). **Experiments:** `pnpm experiment <scenario> [--pilot] [--assistant-model ...]
[--verify-engine eos|hosted] [--arm sections] [--user scripted|simulator]`; scenarios `adapter-literature-workflow-v2`,
`rf-llm-review-v2`; output in `experiments/runs/<scenario>/iter-NN/` (git-ignored); validity VALID / BLOCKED / INVALID.
**Grading:** `UKTUB_GRADING_DIR=<outside repo> node scripts/live/grade.ts corpus|export|run --grader A|adjudicate|agreement`
(grader A is Muse; rubric `experiments/harness/factcheck-rubric-v1.md`); tools `analysis.ts`, `trace-causes.ts`,
`replay-post-compose.ts --archive <dir>`. **Keys** (gitignored `.env`; never print): `VLLM_decision_API` →
`UKTUB_VERIFY_API_KEY`; `OPENCODE_API_KEY`; optional Scholar/OpenAlex/Crossref keys; Vertex via user ADC.
**Delegation:** Hermes (`.agents/skills/hermes-subagent/`) for heavy work, isolated scratch or explicitly scoped paths per job; study data in
`~/.cache/uktub-bench/`.

## 7. Queue (only work, in order)

1. **Completed 2026-10-17 — Sandbox qualification & focused real-Pi Vertex lifecycle smoke:** Docker sandbox rebuilt on Pi 1.3.0 (`sha256:8f841fa8ceeb…`), boundary probe PASS (37/37 checks ok: 35 expected blocks/allows, 2 documented exposures, 0 failures), 5 focused direct MCP/CLI cases PASS (`direct-focused-20261017-b`); `run-20261017-c` and `run-20261017-d` proved all 3 `write_section` lifecycle smoke cases (`case1` `<50` units `5 / 5` supported, `case2` `>50` units `49 / 60` supported across 2 pages + 1 repair round + independent 2-page recount `49 / 60`, `case3` graceful cancellation `cancel-observed`) with labelled Vertex 429 fallback to `google-vertex/gemini-3.5-flash-lite` (§2.2).
2. **Completed 2026-10-17 — Static-browser workflow qualification & typed client shell:** qualified end-to-end through the existing Worker, core and OPFS SQLite seams across all 6 bundled tool graphs (`doctor`, `papers`/`search`, `registry`, `passages`, `verify` claim + fragment/multi-file document mode, `compile` refusal), `provenance` audit (`claim_ledger` + `results/*.csv` computed figures), guarded file-store RPC ops (`writeFile`, `readFile`, `listFiles`, `deleteFile`), `importSource` (manual PDF/TEI import with atomic cleanup on refusal and directory check), `exportProject` & `importProject` round-trip restore into OPFS with schema validation, empty args refusal, `replace: true` stale file cleanup and atomic rollback, origin-scoped Bearer + HTTPS/no-userinfo `createBrowserFetch`, `openrouter` engine + `doctor` hosted probe error diagnosis, `cancelTool` in-flight cancellation + concurrent call isolation, reload persistence with cached SQLite judgment reuse + `v3` continuation resume across reload, single `node:sqlite` import site (`src/core/registry.ts`), and typed browser client shell `src/browser/client.ts` (`UktubBrowserClient`) with request correlation, lifecycle gating, timeout guards, and AbortSignal cancellation (`25/25` `pnpm test:browser`, `31/31` `tests-browser-net`; §2.3; review report in `~/.cache/uktub-bench/section-lifecycle-2026-10-17/review-3-20261017/REVIEW-3.md`).
3. **Backlog (vision; not scheduled):** full 6-tool live suite rerun on Pi 1.3.0 when needed; browser UI layer over the qualified worker client, acquisition limits; in-browser code execution (owner decision); verify recall via windows of 4 chunks (+1.1 recall points at 2 %, 34 % slower); section writers on other hosts; Uktub as literature layer for agent frameworks; macOS/Windows (untested); npm publication (`private: true`); `registry` read/destructive split; MCP SDK v2; parked engineering (single-child verify lanes, `util.parseArgs`, exact pins, TypeBox `Value`).
4. **Audit residuals (2026-10-18; the rest of the list was fixed in round 2 and the S2 follow-up, §2.4):** keyless users
   now see S2 429s as `failed` acquisitions (retried after a day); `doctor` already tells them to set
   `SEMANTIC_SCHOLAR_API_KEY`. `write_section` does not bound a hung `session.abort()` (inferred only; the live
   cancel settled in 2 s; no change without a real failure). Not done, by decision: a byte cap on provider bodies (each read
   is already bounded by the 15 s per-attempt timeout; a cap would need stream readers in both fetch adapters);
   `importProject` atomicity (owner: keep documented). `util.parseArgs` probed: not a drop-in for `verify`/`search`
   (dash-led claims and missing values change), keep parked.
5. **From the 50-reference stress smoke (§2.5; candidates, each needs a red test or a matched run first):** the parent keeps
   returned sections in context and writes the manuscript only at the end, so a deadline or crash loses finished sections
   (iter-01); `write_section` child model retries, stalls and usage are invisible to the host and the harness (so child
   cost is unmeasured); the child verifies claim by claim (514 child `verify` calls, all SUPPORT FOUND, median 365 ms)
   and the writer then verifies every page again: the cost is one child model turn per claim, not the checks; `verify`
   document mode flags table rows `cited-unsupported` while the provenance audit matches their figures; the provenance
   summary and Tier 1 do not surface unsourced prose (8 units in iter-02); the 90 min default turn cap is below a 35-paper
   first draft (123 min). **Done 2026-10-18 (test-first, offline-green, not yet live-run):** (1) as the D1 gate (Tier 1
   v2 sixth check `prose-verified-or-labelled`, also in `replay-checks.ts`; provenance counts every prose unit and lists
   `UNLABELLED`); (2)+(5) `write_section` `details` (child turns/retries/tool calls/usage/cost, first-draft and final
   counts, words) and a counts line; (8) slow steps tagged by scope, `childUsage` + `totalCostUsd` in metrics,
   `deliverables/write_section/NN.tex` exported on every outcome; (4) D2 skill text (sections saved to
   `manuscript/sections/NN-name.tex` with `\input`, the "unverified" label named in step 5); (6) D4 `table-row` status in
   document mode (figure check via the provenance audit, no engine calls). After these: `pnpm test` 1,605 / 1,604 pass /
   0 fail / 1 skip, browser 36/36, net 35/35. Then (2026-10-19): always-on writing workflow, MiniMax custom model +
   grader B, pilot arm `child-passages`: `pnpm test` 1,621 / 1,620 pass / 0 fail / 1 skip, browser 36/36, net 35/35.
   Pilot command (one run each; arms alternate): `pnpm experiment rag-review-50refs-v1 --verify-engine hosted
   --turn-max-minutes 170 --assistant-model opencode-go/muse-spark-1.3-contributor [--arm child-passages]`; logs of the
   stopped sequence: `~/.cache/uktub-bench/rag50-pilot-2026-10-19/`. Status: see §0. **Ranked proposals (harness review 2026-10-18):** (1) surface unsourced prose
   next to Tier 1 and in the provenance summary (red test + offline re-audit of iter-02, expect 8); (2) record child
   `write_section` events (retries, usage) tagged by parent call, prerequisite for (3); (3) child loop restructure: write,
   check its own text in document pages, repair once, instead of one model turn per claim; paired arms current /
   restructured / passages-only, N=6 on the two v2 scenarios, promote only if time or cost falls ≥ 30 % with unsupported
   per 100 units within δ; (4) skill: save each returned section to `manuscript/sections/NN.tex` with `\input`, revise
   with `edit` (accept when a scripted stop at 50 % recovers every finished section); (5) report first-draft counts and
   word count in `write_section` output; (6) check table rows as row-level figure checks, labelled, outside the prose
   gate; (7) build the passage index at acquire time (iter-02: 503.6 s of 507.6 s `passages` time was first-call
   indexing); (8) harness attribution: tag slow steps by parent call, export completed sections on BLOCKED runs.
6. **Verification and section-writer redesign (owner 2026-10-23, §3; in progress).** Each step is test-first and Node
   only. Evidence: `~/.cache/uktub-bench/hermes-research-verify-{api,arch}-2026-10-23/REPORT.md`; plan
   `~/.cache/uktub-bench/plan-section-verify-v3-2026-10-23.md`.
   - **V0 (running):** pre-registration, d3-mini limits ladder and baselines on unchanged code.
   - **Verification track:**
     - V1: paper units (≤ 16k chars, references flagged).
     - V2: keyed multi-question adapters, retrying 5xx and network errors, splitting a failed multi-question request.
     - V3: grid judge, with "any section" per paper and "every cited paper" per claim. A failed request marks its claims
       `incomplete`; it no longer stops every lane.
     - V4: free-style claim mode on units.
     - V5: document mode bundled per paper.
     - V6: the A/B.
     - V7: flip the default and delete the per-chunk path.
   - **Writer track:**
     - W0 (running): baselines of today's writer.
     - W1: a code-scoped registry for the child; ≤ 20 full-text papers, refused up front.
     - W2: `% cN` and SOURCES parser.
     - W3: source trace and `unread-source`.
     - W4: annotated verification.
     - W5: `write_section` assembly.
     - W6: parent writes abstract, introduction and conclusion last (rule and skill).
     - W7: live pilot on `rag-review-50refs-v1`, Vertex and OpenCode Go, N=3 per arm, current writer vs new contract.

No additional orchestration framework beyond this queue. Prior acceptance PASS (on Pi 1.1.0) stands unchanged; Pi 1.3.0 has sandbox + section-lifecycle live qualification, not a full-suite live rerun.

## 8. Pins

- Project Pi **1.3.0** and Docker sandbox Pi **1.3.0** (`docker/test-sandbox.Dockerfile`, image `sha256:8f841fa8ceeb478dbe74a547f1969a0ab9f3e29551952c46e4bcafc648f0eacc`), checked against the official npm registry and [upstream changelog](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md) on 2026-10-17. `package.json` and `pnpm-lock.yaml` updated; optional peer contract retained. Host global CLI was not upgraded.
- Browser app (`web/`): `@earendil-works/pi-ai` + `pi-agent-core` **1.4.0** (owner-approved 2026-10-22; upstream
  [v1.4.0 release notes](https://github.com/earendil-works/pi/releases/tag/v1.4.0): no breaking API change, adds
  `minimax/minimax-m3.1-flash:free` to the OpenRouter catalog, broader retry predicate, provider attribution headers
  from pi-ai). New dependency `@earendil-works/pi-telemetry` is ESM-only, mapped for Jest in `web/jest.config.cjs`.
  Verified: web `tsc`, Jest 1,096, production build; in Chromium the new headers pass OpenRouter's CORS (readable 401
  with an invalid key). Root Pi stays 1.3.0.
- Node floor 22.19; this closeout tested Node 26.7.0 (host) and Node 26.3.1 (Docker sandbox). Other package versions are authoritative in `pnpm-lock.yaml`.
- Hosted verifier `vllm-sr/d3-mini`, protocol `systemone-noul-criteria-v1`; configured identity guarded by response echo.
- Local model/binary pins: `src/core/verify/eos-onnx.lock.json`, `src/core/embed/models.lock.json`, `src/core/compile/tectonic.lock.json`. Shared section chunks remain 512 tokens; no chunking or lock digest change in this closeout.
- Browser candidate retained from the prior recorded pin: `Jacqkues/d3-lite-decisionjs@d4d54cab63bf`, runtime `Jacqkues/decision.js@f9c24211ea4e`. This is not fresh browser acceptance; qualify it before changing the pin or claiming support.
- OpenCode Go base `https://opencode.ai/inference/go/v1`; Pi lists `opencode-go/*`.
