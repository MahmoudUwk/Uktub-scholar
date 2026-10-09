# Codemode as a concept to build on: research and verified findings (2026-10-08)

Status: research record, not a decision. Question: Pi 1.1.0 ships `codemode` (the model writes a script that calls the other tools). Is it a concept worth building on for the host-neutral layer ([host-adapter research](2026-10-08-host-adapter-layer-research.md)) and the writing workflow? Method: the Pi 1.1.0 tarball (docs, changelog, dist source; read by a Haiku subagent, key lines re-checked), the Pi author's post, vendor docs for the API-level equivalents, local `codex features list`, one Hermes run (raw output below, claims marked).

## Verdict

- **Worth building on as a consumer, not as a provider.** Our five tools already meet most of what codemode needs (typed `outputSchema` plus `structuredContent`, small stable tool set). The cheap, host-neutral work is to prove they compose well under a host's own codemode, not to ship a script tool of our own.
- **A server-side script tool (Cloudflare-style `search()` + `execute()` inside our MCP server) is a real option, not the next step.** Both Hermes runs recommend it, because it is the only way to give Claude Code, ChatGPT and Codex-today scripting with zero client changes. Against it, for our case: (a) Cloudflare's pattern targets thousands of endpoints; we have five tools, so there is almost no tool-schema saving, only fan-out filtering; (b) our measured weak point on Codex is tool *choice* (0 of 3 neutral runs used `search_papers`), and a sixth tool does not fix that; (c) Pi's author says nested codemode confuses smaller models, so it must never be offered to Pi, only generated into adapters for hosts without native scripting; (d) OpenAI's guide keeps writes, approval-sensitive actions and citation flows on direct calls, which is most of `paper_registry` and `verify_claim`; (e) a sandbox is new attack surface for a package whose contract is "source text never leaves through a tool response" (Hermes cites 2026 QuickJS-binding escape CVEs and a Node permission-model bypass; not verified). Decision gate: build it only after a measured fan-out workload where Claude Code or Codex needs many turns that a script would collapse.
- **Our current Pi setting (`exposure: "direct"`) stays** until a live run shows codemode exposure works on `google-vertex/gemini-3.8-flash`; the Pi author states the pattern does not yet work well with smaller models.

## Verified

| Claim | Result | Source |
|---|---|---|
| Pi ships codemode since 0.99.0 (2026-09-29); 1.1.0 (2026-10-07) is the latest release | Confirmed (npm `latest` 1.1.0; CHANGELOG entries from 0.99.0). Installed in this repo: **1.0.0**, which already has codemode (an earlier grep missed it because pnpm symlinks) | npm; `CHANGELOG.md` in the 1.1.0 tarball |
| Off by default; turns on with `defaultTools: ["+codemode"]`, `--tools +codemode`, or automatically when an MCP server with `codemode` exposure connects (`autoEnableCodemode: false` disables) | Confirmed in docs and source | `docs/cli.md`, `docs/mcp.md`, `dist/extensions/mcp/index.js` |
| MCP exposure values `codemode` (default), `deferred`, `direct`, `hidden`; per-tool `toolExposure` map with `*` patterns | Confirmed | `docs/mcp.md`, `dist/core/mcp-servers.d.ts` |
| Script runs in QuickJS (`quickjs-wasi` 3.6.2) in a worker thread: 256 MiB heap, 512 KiB stack, no Node, file system, network or timers; tool calls cross by `postMessage` as JSON; no time limit unless `timeout_ms` is set | Confirmed (wrapper package `@earendil-works/pi-codemode`, source read only as a bundle) | `docs/codemode.md`, `dist/extensions/codemode/execute.js` |
| **Extension `tool_call` and `tool_result` handlers fire for calls a script makes**, with `parentToolCallId` set; `{ block: true }` makes `tools.x()` reject | Confirmed in source for 1.0.0 (`_beforeToolCall(..., parentToolCallId)` in `agent-session.js`, `nested-tool-calls.js`) and 1.1.0. **Not yet shown in a live session.** So our `.registry/` edit block, the destructive-bash confirmation and the notices footer are not bypassed by scripts | `dist/core/agent-session.js:314`, `docs/mcp.md:252` |
| MCP tools resolve to their `CallToolResult` including `structuredContent` and `isError`; a failed or blocked call rejects with the tool's error text | Confirmed | `docs/codemode.md` |
| Only the script's output reaches the model; `store`/`load` keep small JSON across calls (262144 chars per value, 1048576 total) | Confirmed | `docs/codemode.md` |
| Pi 1.1.0 adds `aborted` to `agent_settled` events ("so integrations can tell a cancelled run from a finished one") | Confirmed. Relevant to the open writing-workflow spike (what `prompt()` does after `abort()`) | `CHANGELOG.md` 1.1.0 |
| Pi's author: pattern does not yet work well with smaller models; MCP servers should return structured JSON (`outputSchema`), consistent shapes regardless of result size, large binary data and composable tool search | Confirmed | lucumr.pocoo.org/2026/10/6/codemode |
| Claude Code has no native equivalent | Hermes claim, not verified against Claude Code docs | unverified |
| Codex has one: `code_mode` is "under development" and **off by default** in 0.161.0; `code_mode_only` and `code_mode_host` also listed | Confirmed locally (`codex features list`). Exposure of MCP tools under its `tools` object: not measured | local |
| Codex `mcp_2026_07_28` flag exists, "under development" | Confirmed locally. Bears on the SDK 1.32.x vs v2 decision: the handshake change is coming to Codex | local |
| Anthropic programmatic tool calling: Python in a code-execution container, `allowed_callers` per tool, **tools provided by an MCP connector cannot be called programmatically**, `strict: true` tools unsupported, Haiku 4.5 unsupported, not available on Bedrock or Google Cloud | Confirmed. API-level only, so it never composes our MCP server | platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling |
| OpenAI programmatic tool calling: JavaScript in a hosted V8 runtime, `{"type": "programmatic_tool_calling"}` plus `allowed_callers`; `mcp` tools eligible; direct calls recommended for single lookups, adaptive search, writes and approval-sensitive actions, final citation validation, tools whose return shape is unknown; needs Zero Data Retention | Confirmed. API-level | developers.openai.com/api/docs/guides/tools-programmatic-tool-calling |
| Pi classifier models (`models.classify`) are the same category as our Decision 2.0 verification engine (typed questions in, probabilities out) but not the same product: Pi lists TypeSafe Jev, Cloudflare Clef, OpenAI GPT-6 Luna and llama.cpp-served models; Decision 2.0 (Kai, Eos) is the vLLM Semantic Router family | Category link confirmed; no source connects the two. Not a drop-in for `verify_claim`, which stays local | Pi `docs/models.md`; secondary sources only for Decision 2.0 |

## Unverified or not reproduced

- Hermes' Cloudflare figure (1.17M tokens to about 1,000, 99.9%), Anthropic's "+11% performance, 24% fewer input tokens" and CodeAct's "up to 20% higher success" were not re-checked against the primary pages. Do not cite them as ours.
- No 2026 evaluation of code-mode accuracy on Flash-class models was found. The claim about small models rests on the Pi author's statement and on structure, not on a benchmark.
- Hermes' Codex source link (`code-mode/src/description.rs`) returned 404; the Codex behavior above comes from local flags only.
- Pi's wrapper package source (`@earendil-works/pi-codemode`) was not read, only its bundled output.

## What this means for our tools (checked against `src/mcp/server.ts`)

- Already codemode-ready: all five tools declare `outputSchema` and return `structuredContent` on success; titles and the four hints are set.
- Gaps to audit before any live comparison: refusals carry no `structuredContent` (a script gets text only on those paths); `verify_claim` can return a continuation token that a script would have to loop on; the CLI has no `search_papers` command and no JSON output, so on hosts without codemode a Bash script cannot compose our tools either.

## Options, smallest first

1. **Codemode-readiness contract plus a live measurement on Pi.** Audit shape stability (success, partial, refusal, truncation) for the five tools, test-first; then run three fan-out tasks (verify N claims, search then register, passage search over several papers) on `gemini-3.8-flash` with exposure `direct` and with `codemode`, count turns and tokens, and check that the registry block and notices footer still fire for script calls. Spends Vertex quota. Decides whether the Pi adapter default changes.
2. **Codex probe with `-c features.code_mode=true`** (n=3, as in the earlier host probe): do our tools appear under `tools.*`, and does the approval behavior for `paper_registry` change inside a script? Spends Codex quota.
3. **Writing workflow:** borrow, do not adopt. Bounded concurrency (Pi caps classifier and image calls at four per script), small-JSON `store` for resumable state and the `aborted` flag are ideas for the in-process Pi SDK design; the engine decision (in-process Pi SDK sessions) is unchanged.
4. **Server-side script tool:** gated on a measured fan-out workload (see Verdict); if built, generated only into adapters for hosts without native scripting, never into Pi.

## Provenance

One Hermes run, two copies of which raced on one output file (the surviving text recommended a server-side script tool; the other leaned the same way); checked against the Pi tarball, vendor documentation and local flags. Raw model output (untrusted, partly refuted above) is kept outside the repository: `~/.cache/uktub-bench/hermes-raw-2026-10-08/codemode-raw.md`.
