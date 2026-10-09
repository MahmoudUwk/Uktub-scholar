# Host-adapter layer: research and verified findings (2026-10-08)

Status: research record, not a decision. Question: one general layer so the same capabilities reach Claude Code, Codex, ChatGPT and other coding agents through thin per-host wrappers. Method: seven Hermes research runs (web only, raw output in the appendix, **unverified**), then the load-bearing claims re-checked against official pages and the npm registry. "Verified" below means checked on an official page or the registry on 2026-10-08; everything else is Hermes' claim.

## Verdict

MCP stays the base. ACP and A2A are the wrong layer (we provide tools, we are neither editor nor agent); a CLI-plus-skill route cannot replace MCP (no progress, cancellation or structured output; useless in hosts without a shell) but can sit beside it. The stable triple is MCP (tools) + Agent Skills (procedure) + AGENTS.md (conventions), all under neutral stewardship. The work is not a new protocol; it is (1) moving host-neutral guarantees into the server, (2) generating every host's packaging from one manifest, (3) proving it per host in the live harness.

## Verified

| Claim | Result | Source |
|---|---|---|
| ChatGPT reaches MCP through a public HTTPS endpoint **or the Secure MCP Tunnel** (outbound-only, no inbound ports; "can reach its configured stdio or HTTP MCP server"; products: ChatGPT, Codex, Responses API) | Confirmed. Hermes' "cannot reach a local server" is too absolute | developers.openai.com/apps-sdk/deploy/connect-chatgpt; /api/docs/guides/secure-mcp-tunnels |
| ChatGPT plan tiers for full MCP with write actions | Unverified (help article returned 403); Hermes: Business/Enterprise/Edu beta, Pro read/fetch only | help.openai.com/en/articles/12584461 |
| Codex hooks: `permissionDecision: ask` unsupported (hook marked failed, call continues); PreToolUse covers Bash, apply_patch, MCP tools; project hooks only when trusted | Confirmed | learn.chatgpt.com/docs/hooks |
| Codex MCP defaults: `startup_timeout_sec` 10, `tool_timeout_sec` 60 | Confirmed. Whether progress resets the timeout, and elicitation support: not documented | learn.chatgpt.com/docs/extend/mcp; /config-file/config-reference |
| Claude Code: MCP tool timeout default about 28 h; per-server `timeout` is a hard wall-clock limit that progress notifications do not extend | Confirmed. `MCP_TIMEOUT` (startup) default not stated | code.claude.com/docs/en/mcp |
| Claude Code reads AGENTS.md natively from v2.1.277 (only when no CLAUDE.md exists above cwd by default; `/config` "Project instructions") | Confirmed | code.claude.com/docs/en/memory |
| Agent Plugins 1.0.0 (portable root `plugin.json` + `skills/` + `mcp.json`): open, vendor-neutral; steering committee from Amazon, Cursor, Microsoft, OpenAI, Vercel; Cursor loads it, Copilot in VS Code works with it; Codex documents it but its own scaffold still uses the Codex layout | Confirmed with caveats. Claude Code reading it: not shown | agent-plugins.org; github.com/agentplugins/agent-plugins-spec; cursor.com/docs/reference/plugins |
| MCP spec 2026-07-28 is **Current** (not draft or RC); `initialize` handshake removed; a legacy client against a modern-only server fails; servers MAY implement both | Confirmed. Modern client against a legacy-only server (our case): not found | modelcontextprotocol.io/specification/versioning, /2026-07-28/changelog, /2026-07-28/basic/versioning |
| `add-mcp` (neon-solutions, Apache-2.0, v2.4.1 on 2026-09-29, 311 stars, pushed 2026-10-03) writes config for 22 agents incl. Claude Code, Codex, Cursor, OpenCode, VS Code, Gemini CLI; SDK `upsertServer`; `--env`; `--timeout` is for **remote** servers only | Confirmed. It may not set stdio `tool_timeout_sec`; test before adopting | add-mcp.com/docs/cli/add; npm registry |
| `@modelcontextprotocol/sdk` latest 1.32.1 (we use ^1.32.0, installed 1.32.0); v2 split packages exist (`@modelcontextprotocol/server` 2.3.1) | Confirmed from the registry. Hermes said 1.30.0 and 2.0.0: outdated | npm |

## Gaps in our server (read from `src/mcp/server.ts` before this session's slice)

- ~~No tool annotations or titles.~~ Done 2026-10-08 (see below).
- ~~No record of which protocol version a host negotiates.~~ Done: `UKTUB_MCP_TRACE=1` writes one `handshake` line to stderr.
- Notices (failures, partial verification, refusals) are delivered only by the Pi extension. Measured: not needed on Claude Code or Codex (see "Measured on real hosts"); not added to tool results.
- `paper_registry` mixes read and destructive actions in one tool, so one annotation cannot be accurate for both; its measured cost is in "Measured on real hosts" (owner decision, not taken).
- `instructions` is set, but Codex does not put it in the model's context (measured); treat as advisory.
- Tool selection: nothing tells a host to prefer these tools over its own web search (Codex: 0 of 3 without a nudge).
- Generated configs: absolute `node` path, no env, no timeout, no cwd, no steering text.

## Built in this slice

- Titles and all four hints on every tool (`src/mcp/server.ts`, `tests/mcp-server.spec.ts`), set from a side-effect audit of the code: `search_papers` read-only/open-world; `paper_registry` destructive/open-world (union of its actions); `compile_document` non-destructive, idempotent, closed-world; `verify_claim` non-idempotent, open-world; `search_passages` non-read-only (builds a derived index), idempotent, closed-world.
- `UKTUB_MCP_TRACE=1`: one stderr line per handshake with client, requested and negotiated revision (`src/mcp/trace.ts`, `tests/mcp-trace.spec.ts`, `tests/cli.spec.ts`); off by default.
- Not built, with reasons: embedded notices (no evidence of need on these hosts); a tool-choice rule in the shared rules (tried, shipped as instructions, no effect on Codex, reverted).

## Per-host requirements that follow

- **Claude Code:** stdio fine; long calls fine by default; allow rule for `mcp__<server>__*`; hooks can `ask`; plugin can bundle MCP + skills + hooks.
- **Codex:** raise `tool_timeout_sec` and `startup_timeout_sec`; default sandbox has network off (Hermes, from the official sandbox page, not re-checked); whether a stdio MCP child inherits that sandbox is ambiguous in the docs; hooks can only deny; cloud tasks cannot run a local-first toolkit; open issue (openai/codex #10334) says text content may be dropped when `structuredContent` is present.
- **ChatGPT:** remote or tunnel only; deep research needs exactly `search`/`fetch`; arbitrary tools only in developer mode; progress notifications reportedly not working (community report, unverified); no hooks, so guarantees must live in the server.
- **Cursor, VS Code, opencode, Gemini CLI:** each has hooks and its own config file; Gemini `timeout` default 10 min; Zed has no hooks at all.

## Proposed shape (for the owner to accept or change)

1. **Server contract** (done where evidence supported it): annotations and titles, handshake trace, path confinement, refusals as `isError`, progress at most every 20-30 s, cancellation. Embedded notices only if a host is shown to drop warnings.
2. **One manifest, generated adapters**: canonical MCP entry (command, env names, cwd, timeouts per host), SKILL.md (open subset only), an AGENTS.md block with the tool-choice line (the only channel that steered Codex), and an Agent Plugins portable plugin; per-host files generated, never hand-edited. Pi becomes one more adapter.
3. **Per-host live acceptance** in the harness (Claude Code and Codex headless first, as measured here, then promoted into `scripts/live`), logging the protocol version each host negotiates. The runner used for this research was a throwaway; the harness needs `codex exec` with stdin closed (`< /dev/null`) and a forced-403 key.
4. **Later, only on evidence**: streamable HTTP + bearer token bound to 127.0.0.1 for the tunnel route; MCP Tasks for long calls once a host negotiates 2026-07-28; guard hooks per host.

## Open decisions (owner)

- Installer: keep our six-host writer or adopt `add-mcp` as a library (check timeout support first).
- SDK: stay on 1.32.x or move to v2 for dual-stack 2026-07-28; needs the protocol-version measurement first.
- ChatGPT: out of scope, tunnel route, or hosted; plan availability unverified.
- `paper_registry`: keep one truthful tool and let the generated Codex config set `tools.paper_registry.approval_mode` (opt-in), split read from destructive actions (changes the five-tool contract), or soften the annotation (no longer truthful). Measured: the destructive hint blocks it headless on Codex, even for `read`.

## Measured on real hosts (2026-10-08)

Method: headless runs of Claude Code 2.1.294 and Codex 0.161.0 against the real stdio server in a fresh temp project, with `UKTUB_MCP_TRACE=1` and a deliberately invalid Semantic Scholar key so a real provider answers HTTP 403 (no real key is ever passed to a host's model). Scoring rule fixed in advance: an answer "discloses" the failure if it names Semantic Scholar and uses a failure word. Throwaway runner and raw outputs were kept in the session scratchpad, not in the repo. Sample sizes are small (3 per cell): they show direction and rule out gross failure, they do not give rates; zero drops in 8 tool-using runs bounds the true drop rate at roughly 37% (95%, rule of three).

| Question | Claude Code 2.1.294 | Codex 0.161.0 |
|---|---|---|
| Handshake | `initialize`, requested and negotiated `2025-11-25` | `initialize`, requested and negotiated `2025-06-18` (client `codex-mcp-client`) |
| Tools visible | yes, `mcp__uktub-scholar__*` | yes, `mcp__uktub_scholar__*` (asked to list them: all five) |
| Stdio server under the host sandbox | n/a | `workspace-write` sandbox: the server reached OpenAlex and Crossref and returned results |
| Uses `search_papers` for "search the literature" with no nudge | 3 of 3 | **0 of 3** (built-in web search every time) |
| Failure disclosed when the tool was used, no footer | 4 of 4 (3 neutral, 1 control) | 4 of 4 (3 explicit, 1 control) |
| One-line project `AGENTS.md` ("use search_papers instead of web search") | not needed | 0 of 3 -> **3 of 3** tool use; failure disclosed 3 of 3 |
| Same rule shipped as MCP `instructions` only | not tested | **0 of 3**; asked, the model reports it has no server instructions in context ("none", 2 of 2) |
| Default approvals, headless (`approval policy never`) | not tested | `search_papers` (readOnly) ran; `compile_document` and `search_passages` (not read-only, not destructive) ran; **`paper_registry` (destructive) blocked**: "MCP tool call requires approval, but approval policy is never", even for `action: read` |

What follows:

- The Pi-style notices footer is not needed on these two frontier hosts (the models surface the warning, and also flagged unverified claims). Keep it for Pi and small models. Embedding notices in tool results is not justified by this evidence.
- No host forces the 2026-07-28 question yet: both still open with `initialize` on an older revision. Staying on SDK 1.32.x is safe today; re-run the handshake trace when either host updates.
- Tool selection is the real cross-host gap, and MCP `instructions` do not reach Codex's model (the rule I tried there, and reverted, had no effect). The steering text must ship as a project/user `AGENTS.md` block (Codex, Cursor, Copilot, Claude Code >= 2.1.277) and in the skill, generated by the adapter layer.
- Annotation cost is confined to `paper_registry`: a destructive hint blocks it headless on Codex (including `read`), and prompts interactively. Choices: keep one truthful tool and let the generated Codex config set `tools.paper_registry.approval_mode` for users who opt in; or split read from destructive actions (changes the five-tool contract); or soften the annotation (no longer truthful: `remove` deletes rows). Claude Code and ChatGPT friction not measured.

## Still unverified

ChatGPT plan availability, limits, progress and tool behavior; Cursor, Gemini, opencode, Windsurf behavior; Claude Code reading Agent Plugins `plugin.json`; whether progress notifications reset Codex's `tool_timeout_sec` (needs a call longer than 60 s); Codex `structuredContent` handling (our results arrived intact in these runs); `add-mcp` stdio timeout support; tool-name length caps per host; Claude Code approval behavior for the destructive annotation.

## Provenance

Seven Hermes research runs plus our own verification; every claim in the tables above was checked against a primary source or measured. Raw model output (untrusted, partly refuted above) is kept outside the repository: `~/.cache/uktub-bench/hermes-raw-2026-10-08/host-adapter-raw.md`.
