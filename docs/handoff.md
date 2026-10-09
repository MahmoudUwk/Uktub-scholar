---
artifact_contract: "ce-handoff/v1"
created_at: "2026-10-09T00:30:00Z"
title: "Uktub-scholar: current state, last verification, open owner decisions"
summary: "Five MCP tools plus a Pi extension, a Docker-isolated live harness and a user-simulation loop, all green on Pi 1.1.0. Eos stays the verifier (Vela 0.3B and 0.8B tested and not adopted). Open items are owner decisions, not harness work."
keywords: ["uktub-scholar", "pi", "mcp", "live-testing", "eos", "vela", "evidence"]
cwd: "/home/mahmoud/Desktop/AI_Projects/UktubAI/Uktub-scholar"
repository: "Uktub-scholar"
branch: "main"
head: "decd5fe"
resume_focus: "Keep the existing tools working: rerun the live tiers after any product change and act only on evidence. Owner decisions are in docs/BACKLOG.md."
---

# Current state

All work is committed and pushed to `origin/main` (HEAD above). Owner directives apply: work stays on existing functionality, the harness and real testing; no delivery or sharing action without an explicit request; stage reviewed paths only ([AGENTS.md](../AGENTS.md)).

- **Provider keys** for the live harness come from the shell or a gitignored `.env` in this repository (`scripts/live/keys.ts`). The product repository `UktubAI_Agentic` was archived to `../archive/UktubAI_Agentic`; nothing here reads from it. Without keys a run is keyless and says so in its manifest.
- Verifier: `eos` (default). Vela 2.0 0.3B and 0.8B are selectable and not adopted; the model search is closed ([DECISIONS](DECISIONS.md), 2026-10-08).

## Last verification (the one place that records counts)

| Layer | Command | Result |
|---|---|---|
| Offline | `pnpm test` and `pnpm exec tsc --noEmit --noUnusedLocals --noUnusedParameters` | 877 tests, 874 pass, 0 fail, 3 env-gated skips; typecheck clean |
| Boundary probe | `pnpm live:probe` | 35 as expected, 2 documented exposures (ADC readable; host services on all interfaces via the Docker gateway), 0 failures |
| Live direct | `pnpm live:direct` | 38 PASS, 0 FAIL, 0 BLOCKED, 0 NOT_RUN |
| Live agent (`google-vertex/gemini-3.8-flash`, no fallback) | `pnpm live:agent` | 10 PASS, 0 FAIL, 0 BLOCKED, 0 NOT_RUN |

The direct and agent runs (2026-10-08, Pi 1.1.0, keyed) are `experiments/runs/acceptance/{direct-2026-10-08T19-03-28-803Z,agent-2026-10-08T19-07-27-667Z}`; they staged the package before the `vela` engine and the key-loader change, and the MCP tools have not changed since, so rerun them only if a tool, a rule or the extension changes. The probe was rerun on the final tree: `probe-20261008T185552`. Testing details: [docs/testing.md](testing.md).

## Open owner decisions

- **Exposed provider keys:** OpenAlex and Semantic Scholar key values reached 13 evidence files (redacted in place, `NOTE.md` in each run) and, because an agent printed its environment, the model provider's context ([BACKLOG §7](BACKLOG.md)). Owner decision 2026-10-09: no rotation.
- **Put the keys in `.env`** in this repository, or the live tiers run keyless.
- **Host adapters** (installer: `add-mcp` or own writer; `paper_registry` approval cost; MCP SDK v1 or v2; whether ChatGPT is in scope), **codemode**, **web client** and **embedding candidates**: [BACKLOG §12](BACKLOG.md).
- **Vela adapter:** kept selectable per the decision-log rule that a benchmark rejection does not remove an adapter; removal is about ten minutes if wanted.
- **Workspace `../AGENTS.md`** (outside this repository, no `.git` at the root): still names `UktubAI_Agentic/` as the product repository at its old path and says acquisition is OpenAlex-only.
- **Evolve loop:** a content-scoring check is an evaluator change, which only the owner may make ([experiments/README.md](../experiments/README.md)).

## Next step

Writing workflow ([plan](plans/2026-10-07-document-writing-workflow-plan.md), [BACKLOG §11](BACKLOG.md)): Phase 0 is built; engine decided (in-process Pi SDK sessions). Before Phase 1, a live spike must show four concurrent sessions in one process and what `prompt()` does after an abort (Pi 1.1.0 adds an `aborted` flag to `agent_settled`). It spends Vertex quota, so run it after the live tiers.

## Limits and cautions

- Live runs spend Vertex quota; an agent experiment turn takes 25–45 minutes and `gemini-3.8-flash` intermittently stalls or answers `Resource exhausted`. A run blocked by provider capacity is neither a success nor a product failure.
- The evolve loop's nine checks are structural (citations in the registry, compile after the last edit, pointer provenance, …); none scores content, the noise delta of 0 comes from three identical baseline scores, and the held-out run scored 8/9, so only the development scenario is saturated.
- The factual quality of the free-form review is not auto-graded.
- Runners refuse a stale `dist`; run `pnpm build` after any source change, and do not edit `src/` while a run is loading fresh processes.
- Not covered live: GPU Eos in the sandbox (the host has no NVIDIA container runtime), macOS and Windows, and the agent reading a user-owned PDF with its own file tools (the guard is advisory). The authenticated Semantic Scholar case reports NOT_RUN without `SEMANTIC_SCHOLAR_API_KEY`.
