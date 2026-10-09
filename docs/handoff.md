---
artifact_contract: "ce-handoff/v1"
created_at: "2026-10-09T09:00:00Z"
title: "Uktub-scholar: current state, last verification, open owner decisions"
summary: "Five MCP tools, a Pi extension, a Docker-isolated live harness and a user-simulation loop, all green on Pi 1.1.0, in one repository root. Eos stays the verifier. Open items are owner decisions and the writing workflow, not harness work."
keywords: ["uktub-scholar", "open-source", "pi", "mcp", "live-testing", "eos", "evidence"]
cwd: "Uktub-scholar"
repository: "Uktub-scholar"
branch: "main"
resume_focus: "Keep the existing tools working: rerun the live tiers after any product change and act only on evidence. Open work is docs/BACKLOG.md."
---

# Current state

Uktub Scholar is open-source software ([VISION](VISION.md)); this repository is the whole codebase (skills, benchmark PDFs and sandbox
state live in it, the last two gitignored). Rules for contributors and agents: [AGENTS.md](../AGENTS.md).

- **Try it in a fresh Pi in Docker, not the host's Pi:** `pnpm sandbox` ([testing](testing.md), with a one-line alias). The host's
  `~/.pi/agent/settings.json` still lists this repository as a package until `pi remove <path>` is run; nothing here edits it.
- **Provider keys** for the live harness and the sandbox come from the shell or a gitignored `.env` in this repository
  (`scripts/live/keys.ts`); without them runs are keyless and say so. Owner decision 2026-10-09: no key rotation.
- **Verifier:** `eos` (default). Vela 2.0 0.3B and 0.8B are selectable and not adopted; the model search is closed ([DECISIONS](DECISIONS.md)).

## Last verification (the one place that records counts)

| Layer | Command | Result |
|---|---|---|
| Offline | `pnpm test` and `pnpm exec tsc --noEmit --noUnusedLocals --noUnusedParameters` | 879 tests, 876 pass, 0 fail, 3 env-gated skips; typecheck clean |
| Boundary probe | `pnpm live:probe` | 35 as expected, 2 documented exposures (ADC readable; host services on all interfaces via the Docker gateway), 0 failures (`probe-20261009T051405`) |
| Live direct | `pnpm live:direct` | 38 PASS, 0 FAIL, 0 BLOCKED, 0 NOT_RUN (`direct-2026-10-08T19-03-28-803Z`) |
| Live agent (`google-vertex/gemini-3.8-flash`, no fallback) | `pnpm live:agent` | 10 PASS, 0 FAIL, 0 BLOCKED, 0 NOT_RUN (`agent-2026-10-08T19-07-27-667Z`) |

Direct and agent runs: 2026-10-08, Pi 1.1.0, keyed, under `experiments/runs/acceptance/` (local, gitignored). They staged the package
before the `vela` engine and the key-loader change; the MCP tools have not changed since, so rerun them only if a tool, a rule or the
extension changes.

## Open owner decisions

- **Host adapters** (installer: `add-mcp` or own writer; `paper_registry` approval cost; MCP SDK v1 or v2; whether ChatGPT is in scope),
  **codemode**, **web client**, **embedding candidates**: [BACKLOG §5](BACKLOG.md) and §2.
- **Vela adapter:** kept selectable (a benchmark rejection does not remove an adapter); removal takes about ten minutes.
- **`NOTICE.md`** records borrowed code only; licences of the downloaded components (llama.cpp, EmbeddingGemma 2, the Eos export) are
  named in the README, not in `NOTICE.md`.
- **Skill sources:** which repository "ARS" is ([BACKLOG §7](BACKLOG.md)).
- **Evolve loop:** a content-scoring check is an evaluator change, which only the owner may make ([experiments/README.md](../experiments/README.md)).

## Next step

Writing workflow ([plan](plans/2026-10-07-document-writing-workflow-plan.md), [BACKLOG §4](BACKLOG.md)): Phase 0 is built; engine decided
(in-process Pi SDK sessions). Before Phase 1 a live spike must show four concurrent sessions in one process and what `prompt()` does
after an abort (Pi 1.1.0 adds `aborted` to `agent_settled`). It spends Vertex quota, so run it after the live tiers.

## Limits and cautions

- Live runs spend Vertex quota; an agent experiment turn takes 25–45 minutes and `gemini-3.8-flash` sometimes stalls or answers
  `Resource exhausted`. A run blocked by provider capacity is neither a success nor a product failure.
- The evolve loop's nine checks are structural and none scores content; the factual quality of the free-form review is not auto-graded.
- Runners refuse a stale `dist`: run `pnpm build` after any source change, and do not edit `src/` while a run loads fresh processes.
- Not covered live: GPU Eos in the sandbox, macOS and Windows, and the agent reading a user-owned PDF with its own file tools (the guard
  is advisory). The authenticated Semantic Scholar case reports NOT_RUN without `SEMANTIC_SCHOLAR_API_KEY`.
