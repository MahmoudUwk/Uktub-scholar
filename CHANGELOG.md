# Changelog

All notable changes to `uktub-scholar`, in [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) form, versioned with
[Semantic Versioning](https://semver.org/). Rationale, measurements and open
work are in [docs/handoff.md](docs/handoff.md).

## [Unreleased]

### Changed
- **Browser assistant reuses the provider's prompt cache and shows token usage (MVP app):** each project conversation sends one stable, random session id (`x-session-id` on OpenRouter, for sticky routing) and each `write_section` run its own; every reply shows input, cached and output tokens and cost, and the `write_section` row shows the section writer's totals. Usage is kept for the session only. One live full flow read 77 % of its input tokens from cache.
- **Browser app: choose the verification model.** With the `openrouter` engine, Verification settings list OpenRouter's decision models from pi-ai's catalog with their price (default `inception/mercury-decide:free`); the paid `inception/mercury-decide` keeps verification working after the account's free daily pool is spent.
- **Browser app verification runs on `openrouter` only:** the hosted d3-mini endpoint answers no browser preflight (OPTIONS 405, no `Access-Control-Allow-Origin`), so a page cannot reach it; the browser no longer offers `hosted` or asks for its key, and a network test fails the day the endpoint allows browsers. Node keeps `hosted` as the default.
- **Browser app uses pi-ai / pi-agent-core 1.4.0** (adds `minimax/minimax-m3.1-flash:free` to the OpenRouter catalog).
- **Default verification engine is now `hosted`** (`vllm-sr/d3-mini` at `https://decision.vllm-sr.ai`, owner decision 2026-10-15; free key at https://decision.vllm-sr.ai/ in `UKTUB_VERIFY_API_KEY`): 93 % recall at about 1 % false supports on claim-verification-v2 (Eos 49 %), 0/278 false at the 0.99 bar (Eos 7/278). Explicit `eos` / `eos-onnx` / `openrouter` / `llama-cpp` keep working.
- **Hosted verify engine now checks the top-10 retrieval candidates per claim by default** (adopted strategy V1 from the wording + strategy A/B: recall at 2 % false supports 0.978 vs 0.888 exhaustive, 0/278 false at the 0.99 bar, 14.6x faster on documents, identical document promotion; `UKTUB_VERIFY_STRATEGY=exhaustive` restores the exhaustive pass on hosted for benchmark/study runs). Every other engine stays exhaustive. Coverage for top-10 checks reads candidate-limited, never exhaustive. Batching (`UKTUB_VERIFY_BATCH`) and the study variants are removed: batching never grouped on the product path.
- **Shared HTTP 429 backoff for the hosted and OpenRouter engines** (one helper in `claim.ts`): honors `Retry-After` / rate-limit reset headers when present, else bounded exponential backoff (at most 3 retries, ~2 min total wait — client policy); other statuses are never retried; giving up is a clear engine error naming 429 and the wait, never the key.
- **The product asks the verifier exactly as benchmarked**: `instructions` plus a separate `criteria` object, built by one function shared by product and benchmark (`src/core/verify/wording.ts`); protocol identity `systemone-noul-criteria-v1`, so judgments made with the old bare-claim wording are never reused. The bare wording produced 10 false supports at the 0.99 bar on the product path; the criteria wording 0 (`docs/benchmarks/verify-wording-and-strategy-2026-10-15.json`).
- **Core prompt shortened** to a research-assistant identity and seven rules (`src/core/agent-rules.ts`); tool-specific mechanics (pointer format, continuation, source restrictions, placeholders, unverified claims) moved into the tool descriptions; a test pins that every mechanic stays visible to the model.
- The coding-agent skills in `.agents/skills/` carry `metadata.internal: true`, so `npx skills add` does not offer them to users.
- `compile_document` lists errors before warnings (a real 23-page paper printed 49 warnings above its one error) and explains EPS figures, which Tectonic cannot include.
- **One repository root**: skills (`.agents/skills/`), benchmark PDFs (`test_papers/`) and sandbox state (`.sandbox/`, both
  gitignored) now live here; one `AGENTS.md`, `docs/VISION.md` and one handoff (decisions, backlog, testing, plans and reviews were folded into the handoff on 2026-10-14).
- **Embedding model**: EmbeddingGemma 2 Q4_K_XL (176 MB, Apache-2.0) on llama.cpp `b11476`, replacing EmbeddingGemma 300M Q8_0
  on `b11398`: half the download, same speed, about 4–5 points lower hybrid recall (accepted by the owner). Run
  `uktub-scholar embed install --yes` again.
- Project Pi dependency and Docker sandbox image updated to 1.3.0 (latest stable checked 2026-10-17; boundary probe passed); host global CLI was not updated. `refs/references.bib` is written read-only (mode 0444). Compile diagnostics name included files by
  project-relative path.

### Added
- **Browser `compile` (MVP app):** the agent's `compile` tool runs the app's BusyTeX XeLaTeX compile and returns the same result shape as the Node tool; the core's compile is split into the engine run and an engine-neutral finish step (Node output unchanged, pinned by tests), with a TeX-log parser tested on real BusyTeX logs.
- **Host-specific refusal remedies:** a host can supply its own `Next:` hint per refusal code (`ToolContext.refusalNext`); the browser app uses it so no hint names a Node-only remedy. The hosted verifier's missing-key message no longer suggests the local engine (the hint lists the alternatives).
- **Browser project export/import keeps the registry (MVP app):** the Projects-list export (TeXlyre format) now carries each project's registry database and project files; import restores them before the project first opens. If a project's registry cannot be exported (for example it is open in another tab), the export fails and names the project instead of writing an archive without it. "Files only" exports and Backup to disk/folder still carry files only.
- **Browser assistant retries like Pi (MVP app):** retryable provider errors (rate limits, overload) are retried with Pi's own predicate and defaults (up to 3 retries, 2 s doubling, 60 s cap) in the chat and in `write_section`; each retry is shown, Stop cancels the wait, failed attempts are not sent back to the model.
- **Browser `write_section` (MVP app):** the section writer runs in the browser from the same definition as Pi (`src/agent/section-tool.ts`); the browser offers the engines that run in a page (hosted, OpenRouter).
- **Runtime-neutral agent core `src/agent/`** (for the browser app): the always-on writing workflow extractor, the pre-completion gate's state and follow-up texts (the host supplies tool events and the audit result), and the section writer, with no Node, Pi SDK or `process` dependency (checked by a browser-bundle test). The Pi package uses it through thin adapters; its behavior is unchanged.
- **Pre-completion gate in Pi (default on):** when a run wrote or edited a `.tex` file or ran `compile` and the provenance audit still lists prose that is neither verified as written nor labelled "unverified", or citation keys the registry does not hold, the agent gets one bounded follow-up listing those statements (at most 10 pointers, at most 2 follow-ups per user prompt) before it can finish; never inside a `write_section` child; `UKTUB_COMPLETION_GATE=off` disables it. Live probes: with the gate 2/2 runs ended labelled and 2/2 fabricated-citation runs removed the dangling `\cite`; without it neither did.
- **Live harness:** arm `no-gate` (gate ablation) and honesty probe scenarios `gate-unlabelled-probe-v1` (the user demands one uncited, overstated sentence), `fabricated-citation-probe-v1` (the user demands a citation to a non-existent paper) and `uncited-abstract-probe-v1`.
- **Always-on writing workflow in Pi (owner decision 2026-10-19):** the Pi package appends the research skill's document-writing section (read from the shipped skill, about 2,900 characters) to every session's system prompt, because cheaper models never opened the on-demand skill.
- **Live harness models:** Pi agent dirs get a `models.json` with OpenCode Go `minimax-m3.1-flash-free` (MiniMax M3.1 Flash Free), usable as `--assistant-model opencode-go/minimax-m3.1-flash-free`; fact-check grader B is now that model (grader A and the adjudicator stay Muse); a pilot arm that gave the `write_section` child only `passages` was measured (not faster, no honesty gain) and removed.
- **Table rows in `verify` document mode (owner decision D4):** a row gets status `table-row` with a figure check against its cited papers (the provenance audit's own rules) instead of a sentence verdict, costs no engine checks, and is unresolved only when a figure is missing.
- **Research skill saves sections as they are written (owner decision D2):** each section goes to `manuscript/sections/NN-name.tex`, included with `\input`, and is revised by targeted edits; an unverified statement is marked with the word "unverified", which `compile` recognizes.
- **Unverified prose is gated (owner decision D1, 2026-10-18):** the provenance summary now counts every prose statement and caption and lists each one that is neither verified as written nor labelled "unverified" (`UNLABELLED`); live Tier 1 gains a sixth gated check, `prose-verified-or-labelled` (also in `replay-checks.ts`).
- **`write_section` observability:** its result reports first-draft and final supported counts and the word count, and its `details` carry the child session's turns, retries, tool calls, tokens and cost; the live harness adds them to run metrics (`childUsage`, `totalCostUsd`), tags slow steps by parent or child, and exports every returned section to `deliverables/write_section/`.
- **Live harness:** `pnpm experiment <scenario> --turn-max-minutes N` raises the per-turn hard cap for long documents (default 90 min, capped at the 3 h iteration wall clock); new stress scenario `rag-review-50refs-v1` (a review from scratch with up to 50 references).
- **`doctor` tool** (sixth tool: MCP, `uktub-scholar doctor [--json]`, Pi via MCP): no arguments, read-only. Returns `doctor: all checks passed` or `doctor: N problem(s)` with one check each for `verification` (configured engine and whether it can run now — hosted: one minimal authenticated probe judgment, 10 s; `eos`/`eos-onnx`: prerequisites via the existing discovery/self-check helpers, never loading the model), `registry` (present, schema version, paper and ready-source counts), `compile` (the Tectonic the product would use) and `providers` (which optional keys are set; missing is a warn). Every error carries its fix; the model-facing text says to tell the user the fix. Live case `doctor.reports-setup`.
- **`verify` document mode** (`{document: project-relative .tex path}` or `{text: LaTeX fragment}`, exclusive with the claim modes): checks the text as written, one product-extracted unit at a time (cited units against their own papers, uncited units against all papers), with per-unit `supported` | `cited-unsupported` | `missing-citation` (with suggested citekeys) | `unsourced` | `unregistered`. Supported evidence is released through the existing path so the ledger records the exact unit text. Pages of 50 units per call (client policy; `offset`, also `--offset` on the CLI); units outside the claim-length bounds are `skipped`; a unit citing known and unknown citekeys is checked against the known ones and lists the unknown ones.
- **Pi-only `write_section` tool** (registered by default by the Pi extension; set `UKTUB_SECTION_WRITER=off` to disable): a same-model sub-session (`createAgentSession`, `SessionManager.inMemory()`, tools restricted to the Uktub `passages` and `verify` tools) writes one LaTeX section only from the listed papers' passages, then the text is checked with `verify` document mode with one repair round. `papers` accepts `"all"` (for `verify`/`passages`), a whitespace- or comma-separated string of citekeys, a JSON-encoded string array, or a string array (shared parser in `src/core/verify/scope.ts`). It never writes files; the parent session pastes the returned LaTeX verbatim into the manuscript.
- **Writing workflow** (`skills/uktub-research/SKILL.md`): outline per section, write each section with `write_section` (or from passages + `verify` with `text`), assemble verbatim, `compile`, `verify` with `document`, resolve every non-`supported` unit before reporting done.
- **Experiment arm `sections`** (`pnpm experiment <scenario> --arm sections`): used in the `sections-ab-2` study (`docs/benchmarks/sections-ab-2-2026-10-16.json`, where `sections` lowered unsourced units from 35.6 to 29.4 / 100 and raised supported share from 18% to 26% across `n=6/arm`, making `write_section` default-on); reviewer channel is B1's; recorded in metrics/manifest/index.
- **Hosted verify engine** (`verification.engine: hosted`): `vllm-sr/d3-mini` on `https://decision.vllm-sr.ai` with a free key from [decision.vllm-sr.ai](https://decision.vllm-sr.ai/) (`UKTUB_VERIFY_API_KEY`); without a key it refuses with that link and never switches engine. The System One engine also accepts `UKTUB_VERIFY_API_KEY`/`UKTUB_VERIFY_MODEL` (key sent only to the configured HTTPS origin).
- **Durable verify evidence** (registry schema v6, `claim_ledger`): released evidence with its verbatim claim text survives the 24 h continuation sweep; it is deleted only with its paper or source revision. v5 registries migrate (table starts empty). Provenance reads `verified` only from the ledger.
- **`provenance --json`** adds `document_digest` and `units` (every extracted unit with id, kind, location, text, cites, status, pointers).
- **Computed-results audit**: a figure in a statement or table row that cites no registered paper is searched in project result files (client-policy default `results/**/*.{csv,json,txt,log}`, overridable by `provenance.results_glob`; at most 1 MB per file and 100 files, never outside the project root) with the paper-figure matching rules: a strong match is `computed` with a `file:line` pointer (Tier 1 T1.5 treats it like `ok`), a weak-only match is `check`, no match leaves it `uncited`/`unsourced`. Reported in the summary counts, the full view, `compile` and `doctor` (only when > 0).
- **Figure extraction reads magnitude tokens** (`8k`, `7B`, `1.5M`); they match a paper only as the same number with the same suffix. On archived notes this caught two unsupported model-size figures.
- **Measurement harness** (`scripts/live/`): scripted user (`--user scripted`, default) with scenario v2 files (`## Request/Revision/Nudge`); model settings (`--assistant-model`, `--verify-engine eos|hosted`, `--pilot`); run validity (VALID/BLOCKED/INVALID) and a whole-working-tree hash in the manifest; five-check Tier 1 evaluator computed from the provenance JSON (replaces the 13 regex checks); blind grading pipeline (`pnpm grade`, frozen source corpus, rubric v1); analysis/simulation (`analysis.ts`); root-cause trace (`trace-causes.ts`); post-composition replay (`replay-post-compose.ts`). Scenario `rf-llm-review-v2`. Grading accepts any recorded non-keyed lawful origin and has an `ungradeable` label (excluded from Tier 2 counts).
- **Provenance view** (`src/core/provenance/`, [handoff](docs/handoff.md)): a deterministic, read-only audit of a manuscript against the registry, no model: per statement, table row and caption whether `verify` supported that exact wording (from the package's own ledger), only cites a registered paper, or cites nothing; per figure whether the cited paper's text contains it (`OPEN`, `CHECK`); the reader-visible word count. Surfaces: the `compile` result (`provenance` summary, additive, `UKTUB_PROVENANCE=off` removes it) and `uktub-scholar provenance [entry.tex] [--json]`.
- **Visibility A/B harness** (`pnpm experiment <scenario> --arm A|B1|B2`, design and results in handoff V1, git history): the simulated user gets an exact, stated observation channel (A: as before; B: the whole manuscript, the evidence table, an activity digest of the assistant's reply, the provenance view), a detailed spec (`experiments/simulator-v2.md`, used only with `--arm`) and an auditable `<review>` block per turn. Pure parts in `scripts/live/sim-view.ts`.
- **Agent rule for figures** (`src/core/agent-rules.ts`): a number, size, speed or hardware limit is a reported result only if a registered paper the agent read
  states it and it cites that paper; its own inference is labelled an estimate or omitted ([handoff](docs/handoff.md)). Not shown to work: iteration 7 still invented a hardware column.
- **Browser core seams (`src/browser/`, `tests-browser/`, `tests-browser-net/`; not part of the published package):** shims that let the unchanged,
  synchronous core run in one dedicated worker, each proven by differential tests that run the same scenario against the real Node module and in
  Chromium (`pnpm test:browser`, `pnpm typecheck:browser`): `node:sqlite` over official SQLite WASM on `opfs-sahpool`, `node:fs`/`node:os` over a
  SQLite-backed project store, `crypto` (`createHash`), `zlib`, `path`, `url`, `Buffer` and `process`, a `navigator.locks` project lock, a Node-global audit
  of the tool import graph, and a page-side `DownloadLike` with a provider-request audit. Dev dependencies added: `esbuild`, `playwright-core`,
  `@sqlite.org/sqlite-wasm`, `@noble/hashes`. A worker host (`src/browser/host.ts`: init, tool call, `cancelTool`, project export, close) runs all
  six real tools (`papers`, `registry`, `passages`, `verify`, `compile`, `doctor`) in Chromium over bundled core assets (`schema.sql` and the engine locks);
  hosted `verify` (claim and document modes) runs directly in the worker over `platformFetch` (`ctx.fetch`), and an end-to-end static-browser workflow
  (`doctor`, `search`, `register`, `acquire`, `attach`, `sync-bib`, `passages`, hosted `verify` claim + document, in-flight `cancelTool`, reload persistence
  with cached SQLite judgment reuse, and zip + SQLite registry export) matches Node in Chromium (`tests-browser/tools.spec.ts`); `compile_document` refuses
  with `COMPILE_ENGINE_MISSING` until a WASM TeX engine is wired. `unpdf` runs unstubbed in the worker: text, page starts, section marks, section chunks and
  refusal codes match Node exactly on 24 real PDFs plus synthetic and refused inputs (`tests-browser/pdf.spec.ts`); a PDF attaches through the registry tool and `passages` finds it, and `acquire` of an arXiv DOI (DataCite registration, canned arXiv PDF download) matches Node end to end.
  **Per-project storage:** each project id (validated) gets its own OPFS directory and SQLite pool, so several projects live side by side in one browser; the open project still appears at `/proj`; `close` releases the pool for another tab; `deleteProjectStorage` removes a closed project's storage.
  **Fixed:** the browser fetch adapter dropped the Semantic Scholar `x-api-key` header for every origin, so browser searches always ran keyless and failed on the public pool's rate limit; the key is now sent to `api.semanticscholar.org` only (its preflight allows it) and never to another origin.
- **`scripts/provider-access-probe/`**: a static, dependency-free page that probes direct model-provider access with the researcher's
  own credentials (OpenRouter PKCE or a pasted key; models and free/paid classification, streaming, a tool round trip, cancellation,
  truthful 401/402/429 handling, never switching model); 27 tests against a local mock, which prove client logic only. No keyed
  provider call has been made (see the handoff).
- **Live test harness** (handoff V1, git history, plus the current handoff): Docker-isolated acceptance of every tool and action against real
  providers and engines, directly over stdio MCP (`pnpm live:direct`) and through a real Pi session on
  `google-vertex/gemini-3.8-flash` (`pnpm live:agent`, one labelled rerun on `gemini-3.5-flash-lite` after an HTTP 429); a
  boundary probe (`pnpm live:probe`); user-simulation experiments (`pnpm experiment`). Verdicts are PASS / FAIL / BLOCKED / NOT_RUN with evidence and a manifest per run;
  provider keys are forwarded by name from the shell or a gitignored `.env`.
- **`pnpm sandbox`**: a fresh Pi in Docker, preconfigured with this package, Vertex AI (read-only ADC), the Eos engine and
  provider keys; the host's own Pi is untouched; state lives in `.sandbox/`.
- **Source acquisition**: `paper_registry acquire` with a typed status per paper (`metadata_only | acquiring | ready |
  unavailable | failed`) and background acquisition after registration (`UKTUB_ACQUIRE_ON_REGISTER=0` disables it). Routes: OpenAlex
  `pdf_url` and `oa_url`, arXiv, PubMed Central through Europe PMC, Semantic Scholar `openAccessPdf` and its arXiv preprint, the
  OpenAlex Content API with a key. Guards unchanged; evidence taken from a preprint is disclosed.
- **MCP host contract**: a title and all four annotation hints per tool (from a side-effect audit), progress heartbeats every
  15 s so long calls survive host timeouts, `UKTUB_MCP_TRACE=1` to log the negotiated protocol revision.
- **Agent guard rails**: rules delivered in the MCP handshake and the Pi system prompt; the Pi extension blocks agent
  `edit`/`write` on `refs/references.bib` and `.registry/`, confirms destructive shell commands, and appends a "Tool notices"
  footer with refusals and warnings the final answer left out.
- **Engines and tools without a toolchain**: `eos-onnx` (`uktub-scholar eos status | install --yes [--gpu]`, no PyTorch) and
  `uktub-scholar tectonic status | install --yes` (pinned 0.17.0).
- **Product skills** ([README](README.md#skills-for-the-agent)): `uktub-figures` (page-width vector plots from the user's data with a style helper, an audit and a record of the plotted
  numbers), `uktub-diagrams` (TikZ system diagrams), `uktub-review`, `uktub-slides` (Beamer from a paper, or an editable PowerPoint `.pptx` through pandoc, read back with a stdlib script), `uktub-office` (LaTeX to `.docx`; a reader for a co-author's
  tracked changes and comments) and `uktub-grants` (Specific Aims). Each was adopted test first against a real model (`pnpm live:skills`); the evidence is in
  `docs/benchmarks/skills`. The `.pptx` route is built and proven.
- **`uktub-scholar review [entry.tex]`**: the four deterministic scientific-slop measures (cross-section references, macro redundancy, citation isolation, evidence gap),
  reimplemented from arXiv 2610.00531, with a full report of file:line evidence in `reviews/<date>-slop.md`. On the paper's own benchmark they rank papers like the published
  scores (Spearman 0.92 to 0.96; raw result `docs/benchmarks/review-parity-2026-10-09.results.json`).

### Fixed
- **Browser app: switching the sidebar view reset verification.** Returning to the assistant re-sent default settings to the worker, dropping the OpenRouter key and the chosen verification model, so `write_section` and `verify` failed; the settings now persist and every update sends them.
- **Browser app: the assistant's `compile` could not see files it had created.** It compiled the file list captured when the assistant started, so every new section was "not found"; it now compiles the project as it is at that moment.
- **Browser app: a file the assistant had just written could be deleted.** Tools run in parallel, and a sync started by another tool removed project files the editor view had not yet seen; such files are now added to the view, never deleted, and writing tools return only after the view is updated.
- **A citation placed after the full stop (`Sentence. \cite{key}`) escaped the registry check.** The provenance audit only saw cites attached to a statement, so such a key was never reported unregistered and the pre-completion gate could not catch an invented citation there. The audit now checks every cite in the document and lists them as `citeKeys`.
- **Lifecycle and cancellation hardening (audit 2026-10-18, test first):** the local Eos worker no longer leaves a 600 s timer behind after a failure (it kept the process alive and later killed the next worker) and respawns after an idle exit instead of hanging; cancelling `papers` or a source acquisition now aborts provider requests and retry waits; a cancelled caller no longer fails another caller sharing the same acquisition; rate-limited and unauthorized verifier responses release their connections; an unreadable verifier response is a clear engine error. Browser: a late worker reply can no longer answer a different call, a timed-out call is cancelled in the worker, `terminate()` during boot no longer hangs, the project lock no longer waits 1 s per open or reports a refused lock as held, and closing the worker waits for running calls; a worker error after boot is fatal (the worker is terminated and later calls fail at once).
- **Semantic Scholar key fallback:** when a configured `SEMANTIC_SCHOLAR_API_KEY` is rejected (HTTP 401/403) or rate-limited (429), the same request is repeated once without the key in the public pool; a server error never falls back, and without a key nothing changes.
- **Honest provider and engine outcomes (audit round 2, test first):** an OpenAlex response without its results list is reported as a provider failure instead of zero hits; a Europe PMC, PMC open-data or Semantic Scholar outage (including a rate limit) is reported as a failed acquisition instead of "no open copy"; cancelling `compile` stops Tectonic, and output over the 16 MiB cap is named instead of a bare exit code; cancelling `registry register` aborts its metadata lookups; Semantic Scholar and arXiv spacing waits end at cancellation without letting another request start early.
- **Section-writer completion and cancellation:** verify every page before and after at most one repair; keep incomplete units unresolved and refuse malformed pagination. Propagate host cancellation through the child, verification transport and retry waits; settle before disposal. Reject failed/truncated writer turns and prevent earlier-draft reuse. Qualified in real Pi 1.3.0 (`>50` units + in-flight cancellation, `docs/benchmarks/section-lifecycle-2026-10-17.json`); see the handoff.
- **Continuation keeps the run-start candidate order**: repeating a `verify` claim with its continuation token resumes the same frozen candidates. Changes to captured sources, the requested scope, applicable strategy, model, protocol or bar are refused with `CONTINUATION_INVALID` instead of skipping chunks and reporting complete. Older continuation tokens must restart without a token; released evidence is retained.
- **Correctness review of the section workflow** (test first): an empty `text` is refused instead of a vacuous pass; the engine identity probe runs once per process and configuration instead of once per unit; `write_section` forwards `query`/`continuation` and reports incomplete checks.
- **Evidence-table association ignored the TeX tie** (test first): `layer~\cite{k}.` normalized to `layer~.` and never matched the plain claim `layer.`,
  so all 12 verified rows of iteration 6 failed `evidence-table-valid` on a manuscript that contained every claim. A tie in the manuscript is now whitespace.
- **Live-harness defects from the October 13 checkpoint and code review** (test first; evidence summarized in the handoff): the install case
  reads the installer's `uktub` key; run provenance hashes the complete `git diff HEAD` (a 1.4 MB dirty diff was lost to `ENOBUFS`),
  recording a failed capture as an explicit failure instead of an empty string; `no-unrequested-removal` is a non-compensatory check and
  the evidence-table checks are critical wherever a scenario declares them; `metrics.json` is bound to its run manifest by digest and by
  scenario and iteration; model profiles are compared exactly (no substring match) and fallback turns must be labelled; a compile with no
  readable PDF never yields a trusted snapshot; a registry row without `citable: true` fails the citation check. The evidence-table check
  no longer fails a sentence because `\cite{}` leaves a space before its period, no longer cuts a claim at a `%` (which also passed
  claims vacuously), folds TeX escapes such as `\%`, and reports the total number of failing rows. Replaying the preserved iteration 1
  through the fixed check associates all 13 verified rows; no live iteration has been rerun since, and the recorded iteration stays a FAIL.
- From a live skill-acceptance run: the slides skill says a figure converted for the deck (EPS or PDF to PNG) is written into
  `manuscript/slides/`, the only part of the manuscript a deck writes (a deck wrote one into the manuscript folder); the
  invented-number check reads the paper folder's text files (`.txt`, `.md`, `.csv` beside `.tex`/`.bib`), not `.tex` only
  ([handoff](docs/handoff.md)).
- The skill-acceptance quote counter also counts prose quoted in backticks (a real review quoted 22 verbatim passages that way), still checked against the manuscript.
- The published package no longer ships Python bytecode (`__pycache__`) from the skills' helper scripts; a test lists what `npm pack` would ship.
- **Grading-resume harness repair:** grader A runs without Vertex/ADC (grader B keeps ADC checks); A-only adjudication finalizes locally as single-grader; `analysis --grading-dir` validates complete bound outputs against current labels.
- The Pi package was inert after `pi install` and `mcp install` wrote a command no host could spawn; every host config now
  launches `node <absolute bin> mcp`, and installed copies ship compiled `dist/`.
- Semantic Scholar was never reached (doubled `/graph/v1`); the SSRF guard covers the IPv4-translated range; `mcp install` no
  longer overwrites a non-object server table.
- From live user-simulation runs: `search_papers` names each failing provider and gives a DOI-shaped query its register hint;
  `search_passages` says how to get a source; `verify_claim` states what an exhaustive check costs; compile output explains the
  two Tectonic 0.15.0 `main.bbl` warnings and lists errors before warnings.
- Interruption notices are tied to their run, per-item refusals reach the footer, a malformed `read` cursor is refused as
  `CONTINUATION_INVALID`; `register` and `attach` exit non-zero when every item was refused.
- Live evidence leaked provider key values an agent printed; every evidence write now redacts them
  (`scripts/live/redact.ts`) and the affected earlier runs were redacted in place.

### Removed
- **Browser app: TeXlyre's legacy account, backup and collaboration layer** (owner decision 2026-10-22): the user menu with profile, storage management, "Clear all data", account export/import and account deletion; Backup to disk/folder, the folder mirror and Git backup (GitHub/GitLab/Gitea/Forgejo); Chelys account sync; peer file sync; the "Collab" sidebar view; the "files only" export. One export remains: the project archive with its registry.
- The agent-authored `evidence/claims.json` deliverable and its checks (`evidence-table-present/valid`), `sourced-numerics` and the evaluator's regex document model.
- **Two evaluator checks** `length-within-request` and `sourced-numerics` and the regex document model (the five-check Tier 1 evaluator replaces them).
- **Narrative documents (2026-10-14):** `docs/{DECISIONS,BACKLOG,testing}.md`, the dated plans, reviews and benchmark/skill-acceptance reports,
  the script READMEs and the generated `REMAINING-NODE-IMPORTS.md` (`tests-browser/bundle.spec.ts` no longer writes it). Their content that still
  matters is in `docs/handoff.md` (`docs/VISION.md` stays); the files are archived outside the repository. Raw benchmark data (`docs/benchmarks/*.json`) stays.
- One-off review scripts (`scripts/test-item{4,5,7,8}-*.ts`, `scripts/test-live-*.ts`), the old `scripts/test-sandbox.sh`
  (it could not reach Vertex) and the dead `runMcpServer`. Provider keys are no longer read from any other repository.
- The `julia`, `laya`, `k2`, `bev` and `lumma` verification engines (all rejected in the benchmarks), their Python workers, the
  OpenRouter chat benchmark engine and the old runner's non-Decision-2.0 engines. `verification.engine` now accepts `eos`,
  `eos-onnx`, `openrouter`, `llama-cpp` and `hosted`. Superseded plans, reviews and per-run benchmark reports were archived outside the repository.
- **Rejected `vela` verify engine and `pnpm evolve`** with everything only they used: `velaEngine`, `UKTUB_VELA_*`, `scripts/vela_decide.py`, `scripts/live/evolve.ts`, `scripts/live/evolution.ts`, the editable/protected surface model and run-set policies in `scripts/live/provenance.ts`, `experiments/harness/{manifest.yaml,evolution-log.jsonl,snapshots/}` and the held-out/out-of-domain scenarios. The package ships only `scripts/decision2_decide.py` and `scripts/decision2_onnx.py`.
- Verify-strategy study variants (windows, 2048-token chunks, request batching) and the stale `docs/BACKLOG.md` and benchmark narrative report (archived outside the repository).

## [0.2.0] - 2026-10-05

### Added
- Unified stdio MCP server (`src/mcp/server.ts`) exposing the five tools with TypeBox schemas and typed refusals, under bare or
  host-namespaced names; `uktub-scholar mcp [dir]` and `mcp install --host <claude|pi|agy|codex|cursor|opencode>`, which
  merge `.mcp.json`, `.agents/mcp_config.json`, `.cursor/mcp.json`, `opencode.json` or `.codex/config.toml`.

### Changed
- The Pi adapter only registers the MCP server; `@earendil-works/pi-coding-agent` is an optional peer dependency.

### Removed
- The orphaned in-process guard and tool-extension code.

## [0.1.0] - 2026-10-04

### Added
- Managed llama.cpp runtime (`embed status | install --yes`): six platforms, sha256-pinned, safe archive extraction, supervised
  on loopback; first-party EmbeddingGemma GGUF (0.9997 mean cosine against the reference).
- Resident Decision 2.0 Eos verifier, the default engine at the 0.99 bar.
- Hybrid passage search (`search_passages`): FTS5 BM25 plus exact cosine, RRF k = 60, excerpts of at most 1,500 characters and
  25 % of a paper per call.
- Section-aware chunking (512 tokens, exact reconstruction) with schema v4/v5 migrations.
- `paper_registry` (register, remove, read, attach_source, sync_bibliography) and `compile_document` (Tectonic, structured
  diagnostics).

### Fixed
- GROBID TEI wrapped in HTML now parses; SSRF defense across redirects (loopback, RFC 1918, link-local, metadata, ULA,
  IPv4-mapped, NAT64); parameterized SQL and sanitized FTS5 queries; the `llama-server` child ends with its parent.

### Verified
- Independent review against 14 real PDFs and live providers (2026-10-04, 2026-10-05; the reports are in git history). Its 95.0 % Eos
  recall was not reproducible; the re-measurement is in the [handoff](docs/handoff.md).
