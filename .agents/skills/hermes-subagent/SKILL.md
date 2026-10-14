---
name: hermes-subagent
description: Delegate any task to Hermes Agent as a general subagent. Online research (packages, features, system design), and also coding, documentation, running commands, downloads and installs, data work, or anything else the task needs, with whatever toolsets it needs.
version: 3.0.0
author: Mahmoud Sallam (mahmoudsallam)
license: MIT
platforms: [linux, macos, windows]
metadata:
  internal: true
  tags: [hermes, subagent, research, coding, cli, orchestration, system-design]
---

# Hermes as a General Subagent

Main agents may delegate to Hermes any task it can do, not only research: online research, writing code and tests, writing documentation, running commands and tests, downloading and installing what a task needs, reading and transforming data, and bounded edits to files. Its usage allowance is far larger than a native subagent's, so prefer it for long, token-heavy or parallel work. Give it the toolsets the task needs. (Owner decision, 2026-10-11 and widened the same day: "allow doing anything needed".)

Two modes share one CLI. Pick by the task, not by habit.

## Mode 1: Research (default for questions)

For current package versions and features, library comparisons, design patterns, "is this approach outdated?". Web only, nothing local.

```bash
{ cat /path/to/.agents/skills/hermes-subagent/research-persona.md
  echo; echo "TASK: <your research question>"; } > /tmp/q.md
hermes chat -Q -t web,browser --query-file /tmp/q.md --run-budget 600
```

- `-Q` quiet mode: stdout is ONLY the final answer (parse programmatically).
- `--query-file` is shell-safe: quotes, `$(...)`, backticks pass verbatim. One-line form: `hermes chat -Q -t web,browser -q "<persona summary>. Research: <task>. Cite URLs. Reply concisely."`.
- Put ALL context in the query; it knows nothing of your conversation. Typical research runs 2 to 10 minutes: cap with `--max-turns 40 --run-budget 300` or set a timeout of 600 s.
- The research persona (below) never writes code; it is for judgement, not for work.

## Mode 2: Work (coding, docs, commands, downloads, data, anything else)

Write a self-contained brief (`worker-brief.md` next to this file is the template) and run Hermes in a working directory with the toolsets the job needs.

```bash
hermes chat -Q -t terminal,file,web,browser --in <workdir> --yolo \
  --query-file <workdir>/TASK.md --run-budget 1800 > <workdir>/hermes-out.md 2> <workdir>/hermes-err.log
```

- `-t terminal,file` lets it run commands and edit files; add `web,browser` when it needs the web (docs, downloads); drop what it does not need.
- `--in <workdir>` sets where it starts. `--yolo` skips the approval prompts that would otherwise stall a one-shot run; it removes the safety net, so the brief must say what is in bounds (paths, what may be installed or downloaded, whether the GPU or network is free).
- Prefer a scratch working directory of its own (a copy of what it needs, plus the pinned inputs). It is not a limit on Hermes, it makes review a plain read: a task that must edit this repository or touch other paths may do so when the brief names them.
- Long jobs run in the background (`run_in_background`) with `--run-budget` as the cap; several Hermes jobs may run at once when the machine and the GPU allow it.
- It may install packages, create virtual environments, download models and data, run the GPU and run long commands when the task needs them. Say so in the brief and say what is already running on the machine (a benchmark whose timings must stay clean, GPU memory in use).

## Reviewing what it returns

Hermes output is a claim, not a fact. Before anything it wrote counts:

1. Read the files it produced and the report it printed; a clean "all tests pass" is not review.
2. Re-run the authoritative checks yourself (the project's tests, typecheck, a real smoke) and fix the integration, which is usually the part it could not see.
3. For code that runs third-party code (a model's own Python, a package's install script), read that code first or have the brief demand a written review of it before anything is run.
4. For research, cross-check critical claims (versions, benchmarks, licences) with a second query or the primary source.

## What stays reserved (not a limit on Hermes, a rule of this repository)

These come from `AGENTS.md` and bind every agent, including Hermes: commits, pushes, releases, publishing and anything outward-facing (sending, posting, deploying, spending) need an explicit owner request; git operations stay with the orchestrator, which stages reviewed paths only; credentials of retired repositories are never read or passed on; secrets are never put in a brief. Put "do not commit or push" in every work brief.

## When Hermes asks back

The research persona forbids assumptions. One-shot mode cannot get an answer back, so:

1. Read the output: if it contains clarifying questions instead of findings, answer them.
2. Resume the same session: `hermes chat -Q -t web,browser -r <session-id> -q "<answers>"` (use the same toolsets and `--in` as the first call).
3. The session ID is printed at the end of `-Q` output; with tmux, just `send-keys` the answer.

## Long / steered work (tmux)

```bash
tmux new-session -d -s hermes -x 120 -y 40 'hermes -t terminal,file,web,browser --in <workdir>'
tmux send-keys -t hermes 'Compare queue options for our pipeline; call out outdated choices' Enter
tmux capture-pane -t hermes -p | tail -40
tmux kill-session -t hermes
```

## Interactive decision points

The research persona stops before committing to a framework, library or model. Two options:
- Pre-decide in the query: "We chose X because Y; evaluate it, do not re-litigate."
- Let it ask, then resume per the pattern above.

A work brief should pre-decide everything the task depends on (pinned revisions, file names, protocol, wording) so it does not stop to ask.

## Persona (research mode, verbatim, prepend to every research call)

The subagent runs as a senior system designer: never writes code, focuses on high-level architecture, flow, and robustness. Replies are concise, fluff-free, grounded in the most recent packages/features/approaches. It must catch and call out outdated approaches or bad logic, without bias, based on grounded searches; ask for more details when needed and never assume; reject ad-hoc logic that adds redundancy, cost, latency, or worse performance; be bold, objective, grounded; lean toward simplification; stop and ask questions before major decisions (framework, library, model choice). Use Context7 MCP for library syntax (versions are very new). Always cite sources (URLs) for claims.

Full persona text lives in `research-persona.md` next to this file. Work mode has no persona: the brief is the specification.

## Context7 MCP (one-time setup)

Not configured by default. To let the subagent verify brand-new library syntax:

```bash
hermes mcp add context7 --url https://mcp.context7.com/mcp
```

Then add `context7` MCP tools to calls that need API syntax. Skip it if the task needs none.

## Rules

- Any task Hermes can do is allowed: research, code, docs, commands, downloads, installs, data work, bounded file edits; choose the toolsets the task needs and say what is in bounds in the brief.
- Verify before acting: review what it wrote and re-run the checks yourself; subagent claims are not facts.
- Recurring or scheduled work goes to a cron job, not a persistent Hermes process.
