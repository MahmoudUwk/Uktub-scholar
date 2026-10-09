# Testing

Four layers; keep them separate. An offline pass is never live evidence, and a live pass is never a quality benchmark.

| Layer | Question | Real calls? | Command |
|---|---|---|---|
| Offline regression | Does the code still honor its contracts? | No (no provider quota) | `pnpm test` |
| Boundary probe | Can the tested agent see anything it must not? | No provider calls (three unauthenticated reachability GETs) | `pnpm live:probe` |
| Live acceptance | Does every tool and action work against real providers, engines, files and processes, directly and through a real Pi session? | Yes | `pnpm live:direct`, `pnpm live:agent` |
| User-simulation experiments | How does the agent do a real research task for a simulated user? | Yes | `pnpm experiment <scenario>` |

Offline tests follow the TDD rule in [AGENTS.md](../AGENTS.md); a live finding that is a product defect is reproduced there first.

## Isolation

Live runs use Pi's plain-Docker method: the whole Pi process runs in the `uktub-scholar-sandbox` image (Pi 1.1.0, Tectonic 0.15.0).
Build it once: `docker build -t uktub-scholar-sandbox -f docker/test-sandbox.Dockerfile .`

The container sees only a consumer-style install of the package (`pnpm pack`, no `src`, tests, docs or scripts), one disposable
project, a per-run Pi agent directory, the ADC file read-only, and the read-only Eos venv, model and embedding runtime. It runs
as the host user with all capabilities dropped and a read-only root. Graders, expected answers and earlier results are not
mounted; `pnpm live:probe` proves it by attempting the forbidden accesses. Limits the probe reports: the agent can read the
ADC file; the network is open and host services on all interfaces are reachable through the Docker gateway; no NVIDIA runtime
here, so Eos runs on CPU (about 0.8 s per judgment, 49 ms on GPU); Linux only.

**Needs:** `pnpm build` first (runners refuse a stale `dist`), working ADC (`gcloud auth application-default login`) and Vertex
access. Agents run `google-vertex/gemini-3.8-flash` through Pi's Vertex client: no Developer API, no implicit fallback. One
sanctioned fallback (owner, 2026-10-07): after HTTP 429 / `RESOURCE_EXHAUSTED` a turn is rerun once on
`google-vertex/gemini-3.5-flash-lite`; the case carries `ranOnFallbackModel` in `results.json` and a label in `summary.txt` (a
pass there is evidence about a smaller model). A turn that continues a conversation is not rerun and stays BLOCKED.

**Keys.** `OPENALEX_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY` and `CROSSREF_MAILTO` come from the shell, else a gitignored `.env` in
this repository (`scripts/live/keys.ts`), and are forwarded into the container by name only. A run without them is keyless and
says so in its manifest; compare only like with like. The agent can read its own environment, so every evidence write goes
through `scripts/live/redact.ts` (credential shapes plus the exact forwarded values, written `[REDACTED:NAME]`). Run output
under `experiments/runs/` is gitignored; still scan a run directory for key values before calling it clean.

## Interactive use

`pnpm sandbox` starts a fresh Pi in the same boundary, preconfigured: this package, `google-vertex/gemini-3.8-flash`
(`--model` changes it, Pi arguments go after `--`), read-only ADC, the Eos engine, keys by name. Project and sessions persist
in `.sandbox/{project,pi-agent}` as the host user (`--fresh` deletes them); Pi's retry is on, unlike the acceptance runs. The
host's own Pi is never read or written, so nothing needs installing there. As a one-line alias in `~/.bashrc`:

```sh
alias uktub-fresh='(cd /path/to/Uktub-scholar && pnpm -s build && pnpm -s sandbox --fresh)'
```

Needs Docker with the image, ADC and a built `dist` (the alias rebuilds it). Exit with `ctrl+d` on an empty prompt.

## Live acceptance

`scripts/live/cases.ts` (direct, stdio MCP) and `scripts/live/agent-cases.ts` (a real Pi session) are frozen, versioned case
lists; each case names the contract it holds the product to, and prompts describe user intent without naming the tool.

- **PASS**: every assertion held. **FAIL**: an assertion did not hold (a product defect or a wrong contract); never retried or
  weakened. **BLOCKED**: a valid attempt was impossible (outage, deadline, auth); not a pass. **NOT_RUN**: the path was not
  exercised, with the reason (missing key, failed prerequisite, unreachable state); not a pass.

Each run writes fresh evidence to `experiments/runs/acceptance/<suite>-<timestamp>/`: `results.json` with a manifest (commit,
working-tree digest, image id, case hashes, policy), `summary.txt`, the live event log, every controller MCP call, Pi
transcripts and per-turn summaries, stderr logs, `final-containers.txt` (leftover containers or `none`) and the `stage/`,
`project/`, `pi-agent/`, `run/` directories. The harness sets `verification.max_judgments: 20` (labelled harness policy; the
product default is 120) so continuation is exercised. Cases that need a failure create it on purpose: the provider-warning case
starts a second Pi session whose MCP server holds an invalid Semantic Scholar key (a real HTTP 403).

**Not covered live:** the GPU Eos path; macOS and Windows; the agent reading a user-owned PDF with its own file tools (the guard
is advisory); the factual quality of free-form prose; the authenticated Semantic Scholar case without its key (NOT_RUN).

## Self-improving harness

`pnpm evolve` (`scripts/live/evolve.ts`, rules in `evolution.ts`) applies the `harness_skill` discipline to the experiment layer:
measured baseline and noise, candidates with a hypothesis, leakage and protected-surface screening, noise- and cost-aware
promotion, rollback snapshots, and held-out and out-of-domain audits that print aggregates only. The rules and the controller are
tested offline (`tests/evolution.spec.ts`, `tests/evolve-cli.spec.ts`). See [experiments/README.md](../experiments/README.md)
and the [plan](plans/2026-10-07-self-improving-harness-plan.md).

## User-simulation experiments

A tool-less Pi session on the same model plays the user and converses with the real agent until it reports success or gives up;
the agent is then asked, as the developers, how its tools could serve it better, and the simulator writes an assessment. Each
iteration writes `report.md` with measured facts (tool use, refusals, retries, slow steps, tokens, cost, deterministic checks on
the written review) kept apart from the two model opinions. Scenario prompts are frozen in `experiments/scenarios/`; the loop
and its exit criteria are in [experiments/README.md](../experiments/README.md).
