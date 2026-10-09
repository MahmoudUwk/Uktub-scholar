# Testing

Four layers, each answering a different question. Keep them separate: an offline pass is never live evidence, and a live pass is never a quality benchmark.

| Layer | Question it answers | Real calls? | Command |
|---|---|---|---|
| Offline regression | Does the code still honor its contracts, deterministically? | No (no provider quota) | `pnpm test` |
| Boundary probe | Can the tested agent see anything it must not? | No provider calls (three unauthenticated HTTPS reachability GETs, no quota) | `pnpm live:probe` |
| Live acceptance | Does every current tool and action work against real providers, engines, files and processes — directly, and through a real Pi session? | Yes | `pnpm live:direct`, `pnpm live:agent` |
| User-simulation experiments | How does the agent do a real research task for a simulated user — where does it struggle, retry or waste work? | Yes | `pnpm experiment <scenario>` |

Offline tests follow the TDD rule in [AGENTS.md](../AGENTS.md); a live finding that is a product defect is reproduced there first.

## Isolation

Live runs use Pi's documented plain-Docker method (Pi's own `docs/containerization.md`, "Run Pi in plain Docker"): the whole Pi process runs in the `uktub-scholar-sandbox` image (Pi 1.1.0 pinned, Tectonic 0.15.0, `libgomp1` for the embedding server).

```sh
docker build -t uktub-scholar-sandbox -f docker/test-sandbox.Dockerfile .
```

The container sees only: a consumer-style install of the package (`pnpm pack` + `pnpm add`, so no `src`, tests, docs or scripts), one disposable project, a per-run Pi agent dir, the ADC file read-only, and the read-only Eos venv, model and embedding runtime. The controller, graders, expected answers and earlier results are not mounted; it runs as the host user with all capabilities dropped and a read-only root. `pnpm live:probe` proves this by attempting the forbidden accesses.

Known limits, reported by the probe rather than hidden: the agent can read the ADC file; the network is open (Vertex and the scholarly APIs need it) and host services listening on all interfaces are reachable through the Docker gateway; this host has no NVIDIA container runtime, so Eos runs on CPU (≈0.8 s per judgment instead of ≈49 ms on GPU); Linux only.

Provider keys (`OPENALEX_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY`, `CROSSREF_MAILTO`) are read from the shell, else from a gitignored `.env` in this repository (`scripts/live/keys.ts`; no other repository is read), and forwarded into the container by name only (never in an argv, log or manifest; manifests list names). A run with none of them is keyless, which changes provider and acquisition behavior: compare only like with like. The agent can read its own environment, like the ADC file, and an agent that prints it puts the key values in its transcript. So every evidence write (transcripts, turns, the subscription log, MCP logs and calls, experiment conversation and report) goes through `scripts/live/redact.ts`: credential shapes plus the exact values of the forwarded `*_KEY`/`*_TOKEN`/`*_SECRET` variables, written as `[REDACTED:NAME]` (`tests/live-redact.spec.ts`). The acceptance run directories are not git-ignored (only `runs/*/*/evidence/` is, `experiments/.gitignore`), so scan a run directory for the key values before relying on a claim that it is clean.

Needs: `pnpm build` first (the sandbox runs the packed `dist`; the runners refuse a stale build), working ADC (`gcloud auth application-default login`) and Vertex access. Live agents are `google-vertex/gemini-3.8-flash` through Pi's Vertex client — no Developer API and no implicit fallback; a response from any model the turn was not meant to run on fails the run. The one sanctioned fallback (owner decision 2026-10-07): when 3.8 is quota limited (HTTP 429 / `RESOURCE_EXHAUSTED`), that turn is rerun once on `google-vertex/gemini-3.5-flash-lite` (`FALLBACK_MODEL` in `scripts/live/agent.ts`), the next turn starts on 3.8 again, and every such case carries `ranOnFallbackModel` in `results.json` and a label in `summary.txt` (a pass there is evidence about a smaller model). A turn that continues an existing conversation (experiments, after turn 1) is not rerun: its half-finished messages are already in the session, so it stays BLOCKED. A smoke of this path with a simulated quota failure (`simulateQuotaOnce`) ran against the real Vertex models: turn 1 on the fallback, turn 2 back on 3.8. The new-session model reset it found (Pi starts every new session on the default model) is handled by selecting the model after `new_session`.

## Live acceptance

`scripts/live/cases.ts` (direct, stdio MCP) and `scripts/live/agent-cases.ts` (a real Pi session) are frozen case lists with a version; each case names the documented contract it holds the product to. Prompts describe user intent and never name the expected tool.

Verdicts, fixed before any run:

- **PASS** — every assertion held.
- **FAIL** — an assertion did not hold: a product defect or a wrong contract. Never retried, never weakened.
- **BLOCKED** — a valid attempt was impossible (provider outage, deadline, auth). Reported with its cause; not a pass.
- **NOT_RUN** — the path was not exercised, with the reason (missing key, a prerequisite case that did not pass, a path the run could not reach such as a verification that finished before it could be cancelled). Not a pass.

Each run writes fresh evidence under `experiments/runs/acceptance/<suite>-<timestamp>/` (never overwritten): `results.json` with a manifest (commit, working-tree digest, image id, case/driver hashes, policy), `subscription.log` (live event subscription with heartbeats), `mcp-calls.jsonl` (every call the controller makes; calls the Pi agent makes appear only in its transcript), `<label>-transcript.jsonl` and `<label>-turns.jsonl` (every Pi event and one summary per turn; labels `pi` and `pi-warn`), the MCP and Pi stderr logs, `final-containers.txt` (leftover containers, or `none`), `summary.txt`, and the working directories `stage/`, `project/`, `pi-agent/` and `run/` (engine logs, Tectonic cache copy). A direct and an agent run use separate fresh projects. The harness sets `verification.max_judgments: 20` (a labelled harness policy; the product default is 120) so continuation is actually exercised.

Deliberately not covered live (stated, not assumed): the authenticated Semantic Scholar path when no `SEMANTIC_SCHOLAR_API_KEY` is available (the case reports NOT_RUN without it); the GPU Eos path; macOS/Windows; the agent's ability to read a user-owned PDF with its own file tools (the guard is advisory, see README); the factual quality of free-form prose.

Cases that need a failure are made to fail on purpose rather than waiting for luck. A keyed provider does not 429 on demand, so `agent.provider-warning-disclosed` starts a second real Pi session whose MCP server holds a deliberately invalid Semantic Scholar key (the real provider answers HTTP 403) and checks that the final answer names the failing provider. A per-session `env` value overrides a forwarded secret of the same name (`scripts/live/env.ts`). `compile.ambiguous-entry-refusal` builds its own state in the one project (no `manuscript/main.tex`, several top-level `.tex` files) and needs no second project.

## Self-improving harness

`pnpm evolve` (`scripts/live/evolve.ts`, rules in `scripts/live/evolution.ts`) applies the self-improving-harness skill to the experiment layer: baseline and noise from repeated runs, candidates with an explicit hypothesis, leakage and protected-surface screening of the shipped diff, noise-aware and cost-aware promotion, rollback snapshots, pruning, and held-out and OOD audits that print aggregates only. The rules are unit-tested offline (`tests/evolution.spec.ts`) and the controller is tested end to end in a temporary repository (`tests/evolve-cli.spec.ts`); no provider is called. See [experiments/README.md](../experiments/README.md) and [plans/2026-10-07-self-improving-harness-plan.md](plans/2026-10-07-self-improving-harness-plan.md).

## User-simulation experiments

A simulated user (a tool-less Pi session on the same model) converses with the real agent until it reports success or gives up, then the agent is asked, as the developers, how its tools could serve it better, and the simulator writes an assessment. Every iteration produces `report.md` with measured facts (tool use, refusals, retries, slow steps, tokens and cost, deterministic checks on the written review) kept apart from the two model opinions. The scenario prompt is frozen in `experiments/scenarios/`. The improve-and-rerun loop and its exit criteria are in [experiments/README.md](../experiments/README.md).
