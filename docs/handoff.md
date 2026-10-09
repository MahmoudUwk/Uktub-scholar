---
artifact_contract: "ce-handoff/v1"
created_at: "2026-10-09T17:30:00Z"
title: "Uktub-scholar: current state, last verification, what is not fixed"
summary: "Five MCP tools, a Pi extension, six product skills (figures, diagrams, review, slides with .pptx, office, grants), a Docker-isolated live harness and a user-simulation loop, in one repository root. Skill acceptance: 8 of 9 live cases pass; the .pptx case fails on one unresolved question about which numbers count as the paper's. Nothing was fixed after the last run; every open item is below."
keywords: ["uktub-scholar", "open-source", "pi", "mcp", "skills", "live-testing", "eos", "evidence"]
cwd: "Uktub-scholar"
repository: "Uktub-scholar"
branch: "main"
resume_focus: "Decide the .pptx number question (below), then rerun that case and add its no-skill baseline. Open work is docs/BACKLOG.md."
---

# Current state

Uktub Scholar is open-source software ([VISION](VISION.md)); this repository is the whole codebase. Rules for contributors and agents: [AGENTS.md](../AGENTS.md).

- **Try it in a fresh Pi in Docker, not the host's Pi:** `pnpm sandbox` ([testing](testing.md)). The host's `~/.pi/agent/settings.json` still lists this repository as a package until `pi remove <path>` is run; nothing here edits it.
- **Provider keys** for the live harness and the sandbox come from the shell or a gitignored `.env` (`scripts/live/keys.ts`); without them runs are keyless and say so. Owner decision 2026-10-09: no key rotation.
- **Verifier:** `eos` (default). Vela 2.0 0.3B and 0.8B are selectable and not adopted; the model search is closed ([DECISIONS](DECISIONS.md)).
- **Local only, gitignored:** `test_papers/` (the owner's paper, with a `uktub-case.json` beside it; format in [testing](testing.md#skill-acceptance)), `docs/benchmarks/skills/private/` (evidence from runs on that paper, plus a findings note), `.sandbox/`, `experiments/runs/`. Nothing that quotes the owner's paper is committed; [own-paper-summary.md](benchmarks/skills/own-paper-summary.md) holds only verdict, time, cost and tool-call counts.

# Product skills (adopted 2026-10-09)

`skills/`: `uktub-figures`, `uktub-diagrams`, `uktub-review` (with `uktub-scholar review`), `uktub-slides` (Beamer, or `.pptx` through pandoc), `uktub-office`, `uktub-grants` ([README](../README.md#skills-for-the-agent)). Each was adopted test first against `google-vertex/gemini-3.8-flash` in Docker. Public evidence: [docs/benchmarks/skills](benchmarks/skills/README.md) (cases on synthetic fixtures, the no-skill baselines, one superseded run). Parity of the slop measures with the published benchmark: [review-parity-2026-10-09.md](benchmarks/review-parity-2026-10-09.md).

| Case | Last verdict | Note |
|---|---|---|
| `figures.plot-user-data`, `figures.no-data-no-invention` | PASS | no-skill baseline FAIL (skill not loaded) |
| `diagrams.smart-home` | PASS | no-skill baseline BLOCKED at the 20-minute case deadline; an earlier PASS was superseded (labels the user never gave) |
| `review.own-paper` | PASS | earlier run FAIL (reworded text inside quotation marks), then a verbatim-quote rule; no-skill baseline FAIL |
| `slides.own-paper` (Beamer) | PASS | |
| **`slides.pptx-from-paper`** | **FAIL** | see "Not fixed" 1; no no-skill baseline was run |
| `office.latex-to-docx` | PASS | 1092 s of the 1200 s deadline; an earlier run was BLOCKED at the deadline |
| `office.tracked-changes` | PASS | synthetic paper, public |
| `grants.specific-aims` | PASS | earlier runs found guessed printed table numbers and a mislabelled derived target; fixed in the skill and the check |

Two live runs make up this table: the full suite (case list `2026-10-10.1`: figures, no-data, slides, tracked-changes, grants) and a rerun of four cases after fixes (`2026-10-10.2`: review, diagrams, pptx, docx). Each case ran once per run.

# Not fixed (documented on purpose, nothing was changed after the last run)

1. **`.pptx` numbers.** The deck's results table states some values with more decimals than the published table does. The longer values are not invented: they are in an auxiliary results file in the paper's folder (specifics in the local `private/findings-on-own-paper.md`). The case's number check reads `.tex` files only and the skill says "every number comes from the paper". Decide: widen the check to the folder's text files, or require the paper's printed rounding. Then rerun `skill.slides.pptx-from-paper` and run its baseline (hide `skills/uktub-slides` for one run; the old wrapper script was lost).
2. **No visual check of a `.pptx`**: the sandbox image has no LibreOffice (the skill says to state that). The failed case's `.pptx` was over the 1.5 MB artifact cap and was not kept; its `talk.md` was.
3. **The docx export is close to the case deadline** (1092 s of 1200 s) and was BLOCKED once. It is not a product failure; it is a risk for the next run.
4. **One run per case, one model.** Variance is real: the review case passed, failed and passed across runs; the diagram once drew 7.29 in wide and accepted it. A pass is evidence, not a guarantee.
5. **The checks are deterministic and cannot judge meaning**: a wrong label ("95 % of the savings" for "cost within 5 %") passed every check once and was found by reading. `file:line` pointers in a grants page land within a few lines of the fact, not always on it.
6. **Evidence-gap measure** is not comparable to the published one (the benchmark's body text has no appendix); the other three measures rank like the published scores (Spearman 0.92 to 0.96).
7. **Scratch left on the machine, not in git:** `experiments/runs/acceptance/skills-*` (about ten run directories, some holding copies of the owner's paper outputs) and `/tmp/claude-1000/old-archives/` (superseded archive folders). Delete when no longer needed.

# Last verification (the one place that records counts)

| Layer | Command | Result |
|---|---|---|
| Offline | `pnpm test`, `pnpm exec tsc --noEmit --noUnusedLocals --noUnusedParameters`, link check, `npm pack --dry-run` test | 959 tests, 956 pass, 0 fail, 3 env-gated skips; typecheck clean; links ok; the package ships every skill, its helper scripts and `dist/core/review`, and nothing private |
| Boundary probe | `pnpm live:probe` | 35 as expected, 2 documented exposures (ADC readable; host services on all interfaces via the Docker gateway), 0 failures (`probe-20261009T051405`) |
| Live direct | `pnpm live:direct` | 38 PASS, 0 FAIL, 0 BLOCKED, 0 NOT_RUN (`direct-2026-10-08T19-03-28-803Z`) |
| Live agent (`gemini-3.8-flash`, no fallback) | `pnpm live:agent` | 10 PASS, 0 FAIL, 0 BLOCKED, 0 NOT_RUN (`agent-2026-10-08T19-07-27-667Z`) |
| Live skills (same model, no fallback) | `pnpm live:skills` | 8 of 9 cases PASS, 1 FAIL (above); see the table above |

Direct and agent runs: 2026-10-08, Pi 1.1.0, keyed, under `experiments/runs/acceptance/` (local). They staged the package before the skills and the `review` command; no MCP tool changed since, so rerun them only if a tool, a rule or the extension changes.

# Decisions

Decided 2026-10-09 (owner): `.pptx` adopted through pandoc; Paper Office `paper-docx` deferred to the end of the backlog ([BACKLOG §7](BACKLOG.md)); `.agents/skills/*` are `metadata.internal: true` (a test guards it); nothing quoting the owner's paper is committed; "ARS" is deferred (the owner does not know which repository it is).

Still open: **host adapters** (installer, approval cost of `paper_registry`, MCP SDK v1 or v2, ChatGPT in scope), **codemode**, **web client**, **embedding candidates** ([BACKLOG §5](BACKLOG.md), §2); the **Vela adapter** stays selectable (removal is about ten minutes); `NOTICE.md` records borrowed code only; a content-scoring check in the evolve loop is an evaluator change only the owner may make ([experiments/README.md](../experiments/README.md)).

# Next step

1. Resolve "Not fixed" 1, rerun the `.pptx` case and add its baseline.
2. Writing workflow ([plan](plans/2026-10-07-document-writing-workflow-plan.md), [BACKLOG §4](BACKLOG.md)): Phase 0 is built; engine decided (in-process Pi SDK sessions). Before Phase 1 a live spike must show four concurrent sessions in one process and what `prompt()` does after an abort. It spends Vertex quota, so run it after the live tiers.

# Limits and cautions

- Live runs spend Vertex quota; a full skills suite is about $4 and 70 minutes; an agent experiment turn takes 25–45 minutes and `gemini-3.8-flash` sometimes stalls or answers `Resource exhausted`. A run blocked by provider capacity is neither a success nor a product failure.
- Runners refuse a stale `dist`: run `pnpm build` after any source change, and do not edit `src/` or `skills/` while a run is staging.
- Not covered live: GPU Eos in the sandbox, macOS and Windows, the agent reading a user-owned PDF with its own file tools (the guard is advisory), the authenticated Semantic Scholar case without its key (NOT_RUN), and the cases that need a real paper on a machine without `test_papers/` (NOT_RUN).
