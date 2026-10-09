---
name: devin-subagent
description: Drive Devin CLI (Cognition) as a delegated coding subagent.
version: 1.0.0
author: Mahmoud Sallam (mahmoudsallam)
license: MIT
platforms: [linux, macos, windows]
metadata:
  internal: true
  tags: [devin, subagent, cli, orchestration, coding-agent, delegation]
---

# Devin CLI as a Subagent

Devin CLI is Cognition's local coding agent (Rust binary, `devin` on PATH). It runs against
local files and your shell, can hand off to Devin Cloud, and is drivable non-interactively,
which makes it usable as a delegated worker from an orchestrator agent. It is a different
product from cloud Devin: no Knowledge, Playbooks, or Secrets in the CLI.

Never confuse it with the unofficial `devin-cli` package on PyPI (different commands:
`devin configure`, `devin create-session`, API tokens). The official tool is documented at
https://docs.devin.ai/cli and authenticates with `devin auth login`.

## Install and Auth

```bash
curl -fsSL https://cli.devin.ai/install.sh | bash   # macOS / Linux / WSL
brew install --cask devin-cli                        # macOS alternative

devin auth login     # browser-based; add --force-manual-token-flow on headless/SSH
devin auth status    # verify before spending a run
```

## Model Rule (always SWE-2)

Every Devin invocation MUST pin `--model swe-2`. Verified via `devin models list --format json`:
family `swe-2` (label "SWE-2", alias `swe`; variants `swe-2-high`, `swe-2-medium`, `swe-2-max`).
Short names resolve to the latest in the family, so `swe-2` and `swe` are equivalent today;
write `swe-2` explicitly so a newer SWE-3 cannot silently take over.

- One-shot / scripts: `devin --model swe-2 -p "..."`
- Interactive (tmux): `/model swe-2` inside the session.
- Cloud: `/model` before the first message (or after `-r` resume) to confirm SWE-2.
- Persistent default (replaces per-run flags): `~/.config/devin/config.json` ->
  `{"agent": {"model": "swe-2"}}`. Env var equivalent: `DEVIN_MODEL=swe-2`.
- Never rely on the account default or Devin's internal model picker.

## Invocation Patterns

One-shot delegated task (default for subagent use; prints response, exits):

```bash
devin --model swe-2 -p "Summarize the public API surface of src/ and report inconsistencies"
devin --model swe-2 -p -- words that could look like a subcommand     # -- separator
devin --model swe-2 -p --prompt-file /tmp/task.md                     # long prompts from a file
```

Interactive session (steer live, from tmux when delegated):

```bash
tmux new-session -d -s devin-wk -x 200 -y 50 'devin --model swe-2'
tmux send-keys -t devin-wk 'fix the failing tests in auth and run the suite' Enter
tmux capture-pane -t devin-wk -p | tail -40
```

Resume and inspect (session IDs via `devin list --format json`):

```bash
devin -c                # continue most recent session in this directory
devin -r <session-id>   # resume specific session
devin list --format json
```

Cloud delegation (survives closed terminal; burns cloud ACUs):

```bash
devin --model swe-2 --cloud -p "migrate jest to vitest in packages/web"   # one-shot, prints response
devin --cloud -r <session-url-or-id>                        # resume later
devin ssh <session-id-or-url>                               # shell into the VM
```

Inside any session: `/handoff` moves local work to cloud, `/pickup` brings a cloud
branch back to a local session, `/open` shows it in the web app.

## Permission Modes (choose before firing)

Set per run with `--permission-mode <mode>` or `DEVIN_PERMISSION_MODE`; `Shift+Tab` cycles in-REPL.

| Mode           | Behavior                                                      | Use as subagent                    |
| -------------- | ------------------------------------------------------------- | ---------------------------------- |
| `normal`       | Default. Reads auto-approved in cwd; writes/exec prompt       | Only with a human or tmux steering |
| `accept-edits` | Auto-approves workspace edits; shell still prompts            | Guided implementation work         |
| `smart`        | Like accept-edits plus a fast model auto-approves safe shell/web/MCP; high-risk actions always prompt (rolling out gradually) | Guided work with fewer prompts |
| `bypass`       | Auto-approves ALL tool calls (aliases: `dangerous`, `yolo`)   | Fully unattended, trusted scope    |
| `autonomous`   | Like accept-edits plus sandboxed shell; requires `--sandbox`  | Unattended with OS containment     |

Admin-enforced Team Settings deny/ask rules always override `bypass`.

## Verification Contract

A subagent run is not done because stdout printed. Require evidence:

1. Launch with `--export out.json` (ATIF transcript) or parse the final stdout.
2. Prompt must state explicit completion criteria (tests to run, commands to pass).
3. Orchestrator re-verifies: run the declared check yourself
   (`terminal` for tests/builds, `read_file`/`search_files` for claimed edits).
4. Treat Devin's self-report like any subagent summary: verify before acting on it.

Example wrapper:

```bash
devin --model swe-2 --permission-mode accept-edits --export /tmp/devin-out.json -p --prompt-file /tmp/task.md
```

## Steering Devin's Own Subagents

Devin CLI spawns internal subagents for focused work. Two built-in profiles:
`subagent_explore` (read-only research, cheaper router-picked model) and
`subagent_general` (code changes, runs on your selected model, costs like a full extra session).
Subagents do not see the parent conversation; you see only their summarized results.

- In the prompt: "research how X works in an explore subagent" keeps cost down; asking for
  edits gets `subagent_general`.
- Custom profiles: markdown files in `.devin/agents/<name>.md` (or `.agents/agents/`) with
  frontmatter `name`, `description`, `model`, `allowed-tools`, `max-nesting`, body = system prompt.
  Pin `model: swe-2` there to keep custom subagents on SWE-2.
- Model note: the parent's `--model swe-2` propagates to `subagent_general` (it inherits the
  parent's model) but NOT to `subagent_explore` (router-picked) — no flag can change that.
  Pin a subagent's model via a custom profile's `model:` field, or a skill's frontmatter
  `model:` when the skill runs in a subagent.
- Foreground subagents prompt for tools; background subagents auto-DENY any unapproved tool.
  If a background subagent failed on permissions, resume it in the foreground.
- Disable entirely: `"subagents_enabled": false` in `~/.config/devin/config.json`.

## UktubAI Workspace Rules

- Delegated Devin runs are read-only (explore, plan, verify) unless the task explicitly
  grants write scope. Git operations stay with the orchestrator; never let Devin commit,
  push, or create branches. All work stays on `main`; no worktrees.
- Never pass secrets in prompts or env of a delegated run.
- Serialize overlapping edits with other workers; verify shared state after the run.

## Pitfalls

- `-p` fails in an untrusted directory (it cannot show the trust prompt). Add
  `--respect-workspace-trust false` in scripts/CI on a trusted path.
- `devin -- "prompt"` starts an interactive REPL with a preloaded prompt; only `-p` exits
  after the response. Check the flag, not the prompt text.
- `-r` resumes local sessions by ID; with `--cloud` it takes a cloud session ID or URL.
- Runs take minutes. Set generous timeouts (600s+) or run under tmux and poll.
- Cloud sessions consume ACUs; internal subagents multiply model spend. Delegate deliberately.
- The unofficial PyPI `devin-cli` shadows nothing but pollutes search results; its docs
  (`devin configure`, `apk_` tokens) do not apply to the official CLI.

## Sources

- Quickstart: https://docs.devin.ai/cli
- Essential commands and modes: https://docs.devin.ai/cli/essential-commands
- Subagents: https://docs.devin.ai/cli/subagents
- Commands and flags: https://docs.devin.ai/cli/reference/commands
- Cloud: https://docs.devin.ai/cli/cloud
