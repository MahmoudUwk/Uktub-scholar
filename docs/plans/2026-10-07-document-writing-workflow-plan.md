# Plan: a flexible, traceable document-writing workflow

Status: plan, revised 2026-10-07 after the owner's decisions and a Hermes research pass (see "Revision" below, which supersedes the engine choice, the model setting and the stance question further down). Nothing here is built. Three read-only investigations fed it: the retired Python backend's writing workflow, Pi/MCP/Vertex options for a writer subagent, and an audit of this package (pointer map, summaries, registration hook, what is left). File evidence is in those reports; the claims below cite code only where it decides something.


## Revision (owner decisions + Hermes research, 2026-10-07) - supersedes "writer engine" below

**Owner decisions.** The product is open source and the base of a later GUI, so it must run on Pi with any Pi provider (OpenRouter, Vertex, Anthropic, local); a direct-Vertex writer is rejected. Models are user-settable; the default is Flash Lite for summaries and Flash for sections. A tool writing `manuscript/sections/<name>.tex` on explicit request is accepted (AGENTS.md and VISION to be amended when it is built). A self-improving harness following `.agents/skills/harness_skill` is to be implemented for the harness and the user-simulated testing (separate plan: `docs/plans/2026-10-07-self-improving-harness-plan.md`).

**Owner decision 2026-10-08 (writer engine), supersedes recommendation (b) below.** Section writers and summarizers run as in-process Pi SDK sessions (`createAgentSession` from the pinned `@earendil-works/pi-coding-agent`, documented in its `docs/sdk.md`), not as `pi --mode json` child processes. No exception to the workspace rule "Pi must never shell out to `pi -p` workers" is needed, and the product contract "bounded in-process structured sub-runs allowed, standalone writer runtimes forbidden" holds. Documented and usable: a model from the user's Pi config (`ModelRuntime`, `models.json`), a tool allowlist with one custom `submit_*` tool (`defineTool`, TypeBox parameters), `SessionManager.inMemory()`. Not documented, so each needs a live spike before design depends on it: several concurrent sessions in one process (file-backed settings/auth use lockfiles; prefer `SettingsManager.inMemory()`), and whether `prompt()` rejects or resolves after `abort()` (the SDK has no timeout option; the host calls `abort()` on a timer). Also verify against 1.0.0, not the 1.0.4 manual: `bindExtensions()` before use, and isolate the child session from extension/skill/context discovery (`noExtensions`, `noSkills`, `noContextFiles` or a custom `ResourceLoader`).

**Hermes research (read the `pi-subagents` package pages, the Pi 1.0.4 manual excerpt and live docs; findings to verify when building):**
- `pi-subagents` (nicobailon, MIT, 0.76.1 on 2026-10-06, daily releases) is a full fleet: councils, missions, a background runner, a large tool schema paid every turn, loose pins churn. `pi-subagents-lite` (1.16.0, MIT) has three tools and a hard no-nesting block but is still a generic file/code agent without a citation allowlist or an atomic landing layer. `@tintinweb/pi-subagents` adds a workflow VM that duplicates our orchestrator. Pi's own `examples/extensions/subagent/` spawns `pi` child processes in JSON mode.
- Recommendation (b): **a small orchestration extension in uktub-scholar, not an MCP tool**, that spawns one `pi --mode json --no-session -nc` child per section (prompt on stdin, never argv; `-ne` plus an explicit `-e` for one packaged `submit_section` tool whose parameters are the output schema; no other tools; at most 4 children; per-writer timeout; process-group kill on abort). MCP stays the data plane (60 s request limit, no UI, no retries for calls that may have run); long writers inside a tool call would orphan processes.
- The parent resolves papers to cards inline and gives children no database handle; the child returns structured arguments through its one tool; the parent validates (schema, cite whitelist) and lands atomically. One retry carrying the validator message, then the section is reported failed; no guess-fixing.
- Roles are configured provider-neutrally in private user config (`roles: { summarizer, writer }`, each a Pi model pattern with optional thinking level, resolved by Pi's own resolver, falling back to the parent session's model, bounded by `enabledModels`); no provider or model string in code, prompts or the repo.
- Known traps to design around: print/JSON mode answers dialogs `false`; a duplicate tool name across extensions stops Pi at startup; `auth.json` login beats `models.json` keys; split JSONL on LF only; the manual describes Pi 1.0.4 while the repo pins 1.0.0 (verify imports and flags).

**Consequences for the architecture above.**
- The two new tools (`summarize_papers`, `write_sections`) are Pi-extension tools (`src/pi/`), implemented over `src/core` functions; the MCP server keeps `paper_registry`, which gets the ledger and acquisition actions. Two processes can then write the registry (the MCP server and the Pi extension). The registry already serializes cross-process writers with `BEGIN IMMEDIATE` plus a 5 s busy timeout; a live case must prove it with concurrent writers.
- Summaries are produced by Pi children on the summarizer role: per paper, the child receives the focus query, the agent's dynamic schema as the `submit_summary` tool parameters, and bounded passages retrieved by the package for each field (no retrieval tools for the child); each stated field must carry pointers, which the package resolves and judges before storing. Cards then carry those pointers, so a writer cites a card field and the ledger entry follows from the pointer.
- Writers get cards only (summary fields with pointers, else the abstract) and one tool, `submit_section`. After landing, the package verifies each returned claim against its cited paper's passages and records ledger rows; unsupported claims are reported to the main agent.
- Without Pi (Claude Code, Codex) these two tools do not exist; the MCP tools and the ledger still work. This is accepted.

**Defaults taken unless the owner says otherwise** (answering Hermes' open questions): concurrency 4; per-section wall clock 5 minutes; one repair retry; children get zero tools except their submit tool; section names `[a-z0-9][a-z0-9-]{0,40}`, destination fixed to `manuscript/sections/<name>.tex`; user-level config only (no project-local agent files); Pi version pinned exactly; an offline fake-child harness is the gate before any live spend; live tests on Vertex plus one OpenRouter model if a key is available.

## Progress

- **Phase 0 (foundations): built and verified live 2026-10-07.** Typed source status, `acquire` action, in-flight dedupe, the registration hook (MCP server), throttle for "no open copy", an arXiv DOI fetched without OpenAlex, project-relative compile diagnostics for included files, live cases for the hook and for multi-file compilation. Not started: phases 1 to 6.

## The goal in one paragraph

The main agent is the planner. It decides the outline, runs a topic-specific summarization of the registered papers, hands each section to a separate writer with only its papers and a prompt, reads what the writers produced, and writes the introduction, abstract and conclusion itself from those sections. Section text lands in `.tex` files automatically, every cited claim is traceable to a passage, and one writer failing does not kill the document.

## Answers to the three questions

**Do we have the pointer map from claims back to their refs? No.** Pointers (`doi@revision#start-end`) are issued by `verify_claim`, can be re-resolved internally, and carry bounded verbatim excerpts. But nothing durable ties a manuscript sentence to a citekey and pointer. Evidence rows expire after 24 hours or when a source revision changes, `search_passages` pointers are not even recorded as issued, no tool or CLI command resolves a pointer, and the experiment check `pointers-issued-by-tools` ignores the `.tex`. A claims ledger is the first thing to build (Phase 4).

**What is left** (ranked for this workflow):
- Blockers: the claims ledger and its write path; a pointer read-back that respects the excerpt bounds; explicit acquisition with a typed per-paper source status (agents wasted calls in iter-12, 13 and 14 on dummy `verify_claim` runs); and safe concurrency for several writers (the write queue is per process).
- Important: a manuscript audit (every `\cite` has a basis); proof that `\input` across files compiles (never tested); the cost of many claims (one claim per `verify_claim` call, about 0.8 s per judgment on CPU); engine margins (recall 90.5 %, so a ledger entry means "passed the 0.99 bar", not "true").
- Harness: no multi-section or parallel-writer scenario yet, no held-out scenario.
- Nice to have: abstract snippets in search results, an open-access flag, retraction flag, citation graph.

## What the old workflow teaches (ideas only, nothing ported)

Latest era: Summarizer → Planner → parallel Section Writers (plus a table writer) → Framer (abstract, introduction, conclusion) written last from the finished prose, over only the papers the sections cited. Carried over:
1. Plan **argument-shaped sections from evidence families**; section count is emergent, no template, no minimum.
2. A cheap **routing card** for planning (title, id, one evidence line) separate from the fuller **writer card**.
3. **Opaque ids and a per-section allowed-cite list**; unknown ids rejected, never silently stripped. This was the main anti-hallucination device.
4. A section's papers are a **pool, not a checklist**: reuse across sections is allowed, unassigned papers are reported, not fatal.
5. **Intro, abstract and conclusion last**, from completed section text; abstract citation-free; the conclusion must check the body before claiming "no study does X".
6. **Writer rules**: claim-first paragraphs, cite per claim, never invent bridging evidence (an unsupported claim becomes a stated gap), scope claims to the dataset or setting, no "best / consistently outperforms".
7. **Retry with the full error list, at most 1–2 times**; fail only on trust-boundary violations, quality problems warn.
8. **Null-when-absent extraction** ("not stated" is a valid value; the paper's own results kept apart from cited background).
Dropped: fixed document templates and exact section counts, whole-run failure on one section, the large repeated prompt-policy text, hard-coded metric lists, coverage-forcing planner hacks.
Not found in the old code, so not assumed to be the secret of its quality: any critic loop, embeddings, or word budgets. A cheap quality gain to add on top is an optional review pass over the assembled whole.

## Architecture

```
main agent (planner)                      MCP server (uktub-scholar), one process
 1 register papers ─────────────────────► register → registry row, abstract
                                           └─ background kick: acquire OA copy (bounded, deduped, typed status)
 2 summarize_papers{papers, schema, focus} ► per paper: acquire if missing → for each schema field retrieve
                                           passages → generate JSON with a pointer per stated field → check
                                           pointers + judge → store summary (keyed by source revision, schema
                                           hash, focus hash)
 3 write_sections{sections:[{name, prompt,
        papers[], schema?}]}              ► cards (summary else abstract) → pool ≤ N writers (generation client,
                                           response schema, optional in-process search_passages loop)
                                           → validate envelope + cite whitelist → ≤1 repair → render LaTeX →
                                           atomic write manuscript/sections/<name>.tex → verify claims against
                                           their cited papers → record claim ledger rows
 ◄ per-section report: status, path, words, cites, unsupported claims, usage (no section text)
 4 read sections, write intro/abstract/conclusion itself (host edit tools), compile_document
 5 paper_registry read_claim / audit: every \cite has a ledger basis; stale claims listed
```

- **Cards.** `buildCards`: the summary when one exists for the current source revision and the requested schema, else the abstract (truncated to the existing 1,500-character cap), else metadata only. A stale summary is labelled stale, never served as current. Papers with `citable: false` are excluded from the cite whitelist.
- **Dynamic summary schema.** The agent supplies a small bounded schema (field names plus a short description each, a cap on fields and name length, each cap labelled as a client policy) and a focus query. Each field is `{status: stated | not_stated, value, pointers[]}`; a stated field without a pointer is rejected; the package resolves each pointer, checks it is the same paper at the current revision, and runs the existing claim judge on (value, passage), marking the field `verified` or `unverified`. This keeps a model-written summary traceable instead of being a second, ungrounded source of truth.
- **Writer output.** A fixed minimal envelope the package can render and check: `{latex: string, claims: [{text, cites[]}]}`; the agent's optional `schema` adds structured side fields (for example an outline of subsections, key terms for the next section) that are returned in the report and not landed. LaTeX comes from the writer, escaped and checked deterministically: `\cite` keys must be in the section's whitelist, no preamble, no `\input` of other paths.
- **Landing.** `manuscript/sections/<name>.tex`, written atomically with a header line holding a request hash (idempotent re-runs, no new job store), never overwriting a file the tool did not write unless `replace: true`. The main agent includes them with `\input` (or the tool offers to append the `\input` lines). This amends the product stance (see decisions).
- **Claims ledger (schema v6).** One table, `claim_ledger(doc, claim_id, claim_text, doi, revision, char_start, char_end, page, model_id, protocol, min_confidence, p_true, recorded_at)`, populated only when a live verification of that exact claim text supported that exact span; decision fields are copied out so the 24-hour evidence prune cannot destroy them. Queries: list claims of a section; show the supporting passage through the existing containment (at most 1,500 characters and 25 % of the paper, verbatim and pointer-bound); flag a claim whose source revision changed (`stale`); flag a `\cite{key}` in a `.tex` with no ledger entry. Exposed as `paper_registry` actions, not a new tool. Rejected storage: a sidecar JSONL (the agent could forge it) and LaTeX comments (the writer rewrites lines freely).
- **Registration hook.** After `register`, a fire-and-forget acquisition inside the long-lived MCP process (concurrency 3, at most 20 per call, arXiv spacing and cooldown as now), a shared in-flight map so the hook and `verify_claim` never download the same paper twice, the 24-hour retry throttle extended to `no_open_copy`, and a typed `source` status in `register` and `read` (`metadata_only | acquiring | ready | unavailable`). An explicit `paper_registry acquire` action covers the CLI, where the process exits. The hook never blocks `register`.
- **Long calls.** Blocking call with the existing 15-second progress heartbeats and a wall-clock budget; when the budget ends it returns per-section status and a continuation, in-flight sections keep running and land on disk. No job-polling tool.
- **Concurrency.** Writers share one process, so the in-process write queue serializes registry writes; nothing spawns N MCP servers or N Eos workers. Cap writers at 4 and watch for Vertex 429s on 3.8 (the labelled fallback rule is for tests only, not for product behavior).

## Phases (each test-first, then a live case, then the suites rerun)

0. **Foundations.** Typed source status; `acquire` action; in-flight dedupe; the hook; throttle for `no_open_copy`; live case that compiles a `main.tex` with `\input{sections/x}` and reports errors with the right file and line.
1. **Generation client** (`src/core/generate/`): one request with a response schema, abort, bounded backoff, injected fake for offline tests, private env config. Depends on the engine decision below.
2. **`summarize_papers`** with the dynamic schema, `buildCards`, the `paper_summaries` table.
3. **`write_sections`**: pool, envelope validation, cite whitelist, repair turn, LaTeX render, atomic landing.
4. **Claims ledger**: schema v6 with a genuine v5 fixture migration test, `record`/`read_claim`/audit actions, the verification stage inside `write_sections`, `search_passages` recording issued pointers so read-back cannot scan arbitrary spans.
5. **Harness**: a fake generation model for `pnpm test`; live cases per tool and action (acceptance rule); a multi-section experiment scenario in a second domain (also the held-out scenario); experiment checks extended so pointers and cites in the `.tex` are checked against the ledger.
6. **Rules and skill**: the workflow as skill text (plan, summarize, write sections in parallel, read, write the framing sections, compile) plus agent rules for writer output; changed only after a real session shows a failure, per AGENTS.md.

Estimated cost of a 10-section document with Gemini 3.8 Flash: about 50k input and 40k output tokens, roughly $0.2–0.4, 2–4 minutes at concurrency 4. These are extrapolations from the keyed review runs ($0.60–$1.95 per whole review), not measurements; a live case will replace them.

## Contract changes this plan makes (each recorded in DECISIONS when built)

- The tool surface grows from five tools to seven (`summarize_papers`, `write_sections`), at the owner's request; the claims ledger stays inside `paper_registry`.
- `manuscript/sections/*.tex` becomes writable by a tool, on explicit request only. Today only `.registry/` and `refs/references.bib` are tool-owned and `docs/VISION.md` lists drafting tools as a non-goal; both change.
- The package gains a generative model dependency. Today its engines are entailment judges that return a probability.
- `VERSION`: schema v6 (`claim_ledger`, `paper_summaries`).
- The product-source-text rule is kept: summaries and sections are model output with pointer-bound claims; excerpts stay bounded, verbatim and pointer-bound, and extractive summary values are capped and charged to the per-source release budget.

## Decisions needed from the owner

1. **Writer engine. RESOLVED 2026-10-08: in-process Pi SDK sessions (see Revision); options below are kept as history.** (A) direct Vertex call from the MCP server with a response schema: host-neutral, minimal, fits the product rule "bounded in-process structured sub-runs allowed, standalone writer runtimes forbidden", needs `@google/genai` as a direct dependency (already in the lockfile through Pi) and an amended import allowlist; (B) a Pi child process per section, which is what you literally asked for, Pi-only, more moving parts, and needs an exception to the workspace rule "Pi must never shell out to `pi -p` workers" (written for development agents, but it names the pattern); (C) deterministic tools only (`prepare_brief`, `land_section`) with the host's own subagents doing the writing, no model in the package.
2. **Model** for summaries and sections, and whether summarization (many small calls) should use the cheaper Flash Lite while sections use 3.8.
