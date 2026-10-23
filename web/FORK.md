# Fork provenance — TeXlyre app in `web/`

This directory is a fork of the TeXlyre editor app for Uktub Scholar's browser MVP.

- Upstream: https://github.com/TeXlyre/texlyre
- Base commit: `ccbe092` ("Updated texlyre-busytex and vulnerable dependencies", 2026-10-16)
- Upstream version: 0.13.3
- Licence: AGPL-3.0-or-later (see `LICENSE`; all upstream AGPL headers kept)
- Engine dependency: `texlyre-busytex` 1.4.1
  (upstream https://github.com/TeXlyre/texlyre-busytex, commit `61b83cd`;
  TeX/LaTeX WASM assets downloaded at build time from its pinned release,
  see `scripts/download-core-assets.cjs`)

Rule: Uktub changes are made on top of this tree and must stay diffable against
the base commit (`git diff` from a clean `git archive ccbe092` extraction, i.e.
this directory as copied). Do not rewrite history to hide the upstream base;
keep this file updated if the base commit changes.

Fork created: 2026-10-20. Owner decision: standalone package with its own lockfile
(not a pnpm workspace member of the repo root).

## Changes on top of the base (Phases 2+3, 2026-10-20)

Engine / assets (Phase 2):
- `busytex-xetex` (XeLaTeX, bibtex8 driver) is the default everywhere:
  `src/types/latex.ts` (engine list now BusyTeX-only), settings default,
  `LaTeXContext`, `LaTeXService`, compile/export buttons and properties,
  `GitBackupImportService` fallback, all four `userdata*.json`.
- Only the recommended TeX bundle ships: `BUSYTEX_BUNDLE_URLS/LABELS` expose
  just `texlive-recommended.js`; `BusyTeXService.setSelectedBundles` forces
  `['recommended']`; `download-core-assets.cjs` prunes `texlive-basic.*` /
  `texlive-extra.*` after unpacking (also pruned from `public/core/busytex`,
  686M -> 260M). No remote TeX endpoint: `latex-*-endpoint` settings and all
  `texliveEndpoint`/`remoteEndpoint` plumbing removed; BusyTeX compiles with
  `remoteEndpoint: undefined`. Assets served from app origin
  (`busytexBasePath = ${__BASE_PATH__}/core/busytex`, unchanged).

Strip (Phase 3):
- SwiftLaTeX removed: `src/extensions/swiftlatex/` deleted (6 files),
  `LaTeXService` is BusyTeX-only, engine pickers/optgroups/DVI-export paths
  removed, `public/core/swiftlatex/` payload deleted. `EngineType` is now just
  the three BusyTeX engines.
- Typst compile path removed: `internal:typst` registration, Typst settings
  (`registerTypstSettings.ts` deleted), header `TypstCompileButton` /
  `TypstExportButton` (files deleted; `TypstOutput` panel keeps rendering
  past output but its compile button is removed), `typst` Vite chunk and
  `optimizeDeps` entry, `copy-typst-assets` build step, typst entries in the
  template/URL-import dialogs. Kept (later phase): `TypstService`,
  `TypstContext`, editor typst-output layout state and typst packages, which
  the editor's output panels still reference; unreachable via UI since no
  typst project type can be created.
- Collaboration is local-only: `CollabWebrtc.ts` / `CollabWebsocket.ts`
  deleted, `CollabService.connect` always opens the IndexedDB-backed local
  Yjs doc (no providers, no signaling; `getAwareness` -> null), collab
  settings UI and `offline-force-collab-offline` toggle deleted, defaults
  blanked. Removed UI: `CollabStatusIndicator`, `CollaboratorAvatars` header
  block, `ShareProjectButton/Modal`, chat (`ChatPanel`, `ChatContext`,
  `useChat`, `types/chat`, `chatMessages` doc field). Yjs stays for open
  editors; `y-webrtc`/`y-websocket` packages remain installed (still imported
  by `src/chelys/`).
- Accounts: `GuestUpgradeBanner/Modal` deleted from Project/Editor apps and
  the `Upgrade Account` dropdown item removed; local login/guest sessions and
  locally stored projects unchanged.
- Upptime: `ServiceStatusBanner` deleted, `status-json-url`/`status-page-url`
  settings and defaults removed/blanked (no fetch to
  `raw.githubusercontent.com`).
- Tests: `tests/unit/engines/SwiftLaTeX.test.ts` and
  `tests/mocks/swiftlatex-engines.js` deleted (removed feature);
  `BusyTeX.test.ts` bundle cases updated to recommended-only behavior.

Verification 2026-10-20: `pnpm run build` green; `tsc --noEmit` clean;
unit 711 + services 216 + components 82 pass (integration: 3 suites skipped
upstream). Playwright vs `vite preview` (fresh profile, main.tex +
refs.bib): PDF contains "The TeXbook" with resolved "[1]" cite, engine
`busytex-xetex`, 86/86 requests to app origin, 0 console errors. Evidence in
`hermes-web-phase23-2026-10-20/` (notes dir, outside this repo).

## Changes on top of the base (Phase 4, 2026-10-20)

Uktub `/proj` (OPFS) owns all project files; TeXlyre's IndexedDB/Yjs is a
read-through view rebuilt from `/proj` on every project open.

Worker loading:
- `scripts/sync-uktub-worker.cjs` (wired into `build`/`build:local`) copies
  root `dist-browser/worker.js` + sibling `*.wasm` into `public/uktub/`
  (gitignored, served under `${base}/uktub/`).
- `src/services/UktubProjectService.ts` (new singleton): one
  `UktubBrowserClient` per opened project, imported via relative path from
  `src/browser/client.ts` (type-only host import, no Node modules in the web
  bundle); `init` with the TeXlyre project id; `close` on tab `pagehide`.
  Exposes a `window.__uktub` test seam (client/service/status).

Bridge (`/proj` owns files):
- Open: `FileTreeProvider` init opens the Uktub project first (lock refusal
  surfaces as a banner via new `uktubStatus` context field +
  `components/project/UktubStatusBanner.tsx`), then `syncDownToStore` wipes
  and re-imports `listFiles`/`readFile` (text + base64 binary), preserving
  FileNode ids/documentIds by path; empty `/proj` gets the fixed layout
  (`manuscript/main.tex` minimal XeLaTeX with
  `\bibliography{../refs/references}`, `manuscript/sections/` + `results/`
  placeholder dirs; `refs/references.bib` comes from the worker registry).
- Write-through: `fileStorageEventEmitter` subscription (debounced per-path
  push + structure reconcile); `LaTeXService.runCompile` flushes before every
  compile; delete/rename/move flow through `deleteFile`/`writeFile` diffs.
- Read-only: `services/uktubPaths.ts` (`isUktubToolOwned`,
  `isUktubProtectedPath`); enforced in FileTreeContext mutations, editor save
  paths, `DocumentFileSyncService`, zip import; editor gets `isViewOnly` +
  "generated from the registry" note banner.
- Compile: `manuscript/main.tex` preferred as main file; BusyTeX engine +
  service no longer flatten the main directory, so `../refs/references`
  resolves against the true layout.
- Per-project storage (Phase 4b): each TeXlyre project maps to its own
  Uktub `projectId` with its own OPFS-backed pool; the "foreign /proj
  owner" refusal is gone (see Phase 4b below).

Verification 2026-10-20: `pnpm run build` green; `tsc --noEmit` clean;
unit/services/components 1015 pass (8 skipped, 1 suite skipped upstream).
Playwright vs `vite preview` (fresh profile): create → fixed layout, edit →
`/proj` holds sentence, IDB wipe + reload → sentence persists, PDF contains
sentence, second tab lock refusal, same-origin requests, 0 console errors.
Evidence in `hermes-web-phase4-2026-10-20/` (notes dir, outside this repo).

Phase 4 follow-ups (acceptance-driven, same day):
- `EditorApp`: `FileDocumentController` mounts unconditionally (was gated on
  Yjs `doc.documents`, so a wiped Yjs cache hid the whole tree); Yjs project
  metadata rebuilds from the durable auth record; compile buttons fall back
  to the latex default when Yjs metadata is empty.
- `FileTreeContext`: reads resolve empty (no console errors) while the bridge
  is down (locked/foreign/closed); link/unlink use the project-scoped
  `initialize(docUrl)`.
- Acceptance tooling only (outside the repo): `accept.mjs` types the probe
  sentence into the document body (text after `\end{document}` is not
  typeset) and closes the FileStore connection before deleting
  `texlyre-project-*` IDBs (an open `idb` connection blocks deletion).

## Orchestrator review notes (Phase 5, 2026-10-20)

- `classifyKeyTest.ts`: a message that starts with an HTTP status (`401: …`, `401 {…}`, `Prefix (401): …`) reached
  the provider, so it is never `blocked`; "API key not valid" (Google-style 400) is `rejected`. Tests first in
  `tests/unit/agent/classifyKeyTest.test.ts` (2 new cases; RED: `blocked` for a 408 body, `error` for the 400 key text).

## Changes on top of the base (Phase 4b, 2026-10-20)

Per-project storage: several projects side by side, like Overleaf's project
list. Inside the worker the open project still appears at `/proj`, so tools,
registry path, `refs/references.bib`, provenance and export/import are
unchanged; only the backing storage is per project.

Runtime (repo root `src/browser/`, synced via `scripts/sync-uktub-worker.cjs`):
- `projects.ts` (new): `validateProjectId` (`[A-Za-z0-9_-]`, 1-128 chars,
  leading alphanumeric; `../x`, empty and 200-char ids refused at `init`),
  `poolDirForProject` (`/uktub-projects/<projectId>/`), `vfsNameForProject`.
- `shims/sqlite.ts`: one installed pool per OPFS directory + one active
  pool; `ensureBooted` loads WASM only (no pool at boot); `init` installs
  the project's pool after taking the lock; init-less scenario ops lazily
  install a `/uktub-scratch` pool; `DatabaseSync.close` finalizes prepared
  statements (unfinalized statements kept zombie VFS files open, blocking
  pool handover); `pauseActivePool` on `close`; `removeProjectPool`
  (`removeVfs`) for deletion. No migration: nothing was released, the old
  single-root pool is never installed.
- New `deleteProjectStorage` host op + worker op + `UktubBrowserClient`
  method (refused while the project is open here or locked in another tab).

Bridge:
- `UktubProjectService`: foreign-owner refusal and `OWNER_KEY` removed;
  `openProject` maps each TeXlyre id to its own Uktub `projectId`;
  new `deleteProjectStorage` (ephemeral worker; closes the live bridge
  first when it holds the project).
- `AuthService.deleteProject` also deletes the project's Uktub storage
  (best-effort warn; a project open in another tab refuses and orphans
  until the next delete retry).

Verification 2026-10-20: root `pnpm build:browser` green,
`pnpm test:browser` 40/40 (incl. 4 new `projects.spec.ts`), net specs
35/35, `tsc --noEmit` (+ `--noUnusedLocals --noUnusedParameters`) and
`typecheck:browser` clean; `pnpm run build` (web, incl. `tsc`) green;
jest 1015 pass / 16 skipped / 0 fail. Playwright (`accept.mjs`) vs
`vite preview` on a fresh profile: projects A and B created from the
list, each `manuscript/main.tex` edited differently, list-switch +
reload keeps each content (editor UI + Uktub `readFile`), each compiles
to a PDF containing only its own sentence, deleting B from the list
leaves A opening with its content, 180/180 requests same-origin,
0 console errors. OPFS backing check (Phase 5 run): after the delete,
`uktub-projects/` in the page's OPFS holds A's directory and not B's.
Evidence in `hermes-web-phase5-2026-10-20/` (notes dir, outside this
repo: `accept4b-ext.mjs` incl. the OPFS check, `p4b-*` screenshots,
`pdf-a.txt`, `pdf-b.txt`, `verdict.json`, `requests.json`,
`console-errors.json`).

## Changes on top of the base (Phase 5, 2026-10-20)

Research assistant panel (pi-ai 1.3.0 + pi-agent-core 1.3.0; 1.4.0 since 2026-10-22, see the
end of this file; exact pins in
`web/package.json` + `web/pnpm-lock.yaml`; root manifests untouched).

Placement decision: the panel lives in the editor's left sidebar as a new
`assistant` view (`EditorSidebarView` + toggle button next to
Files/Collab/Search/History), following the existing sidebar
view-toggle pattern. The chat/agent stack loads as a lazy chunk behind
`React.lazy(() => import('../agent/AgentPanel'))`, so the initial bundle
grows by <1KB (vite build 866,991 -> 867,784 bytes main) while the agent
chunk (`AgentPanel`, ~157KB) plus pi-ai's catalog (~1MB `all-*`) and
per-API lazy chunks (~2.2MB total) load only when the view opens.

- `src/services/agent/agentCatalog.ts`: picker view model from the live
  `Models` collection (`getProviders()` / `getModels(id)`). Every
  provider is shown (42 in pi-ai 1.3.0); the key label is
  `provider.auth.apiKey?.name`; a provider without `apiKey` auth
  (currently only `openai-codex`) renders disabled as "sign-in only —
  not in this version". Per model: name/id, context window and cost
  (`input`/`output` USD per M tokens; `free` when both are 0). Search
  box filters the selected provider's models (list renders max 200).
- `src/services/agent/agentKeyStore.ts`: keys in memory by default;
  per-provider "Remember on this device" (default OFF) mirrors to
  `localStorage` (`uktub.agent.key.<providerId>`); "Forget" clears
  both; selection (`uktub.agent.selection`) and per-provider status
  (`uktub.agent.status.<providerId>`) persist (not secret). No key ever
  reaches console output, error text, logs, URLs or screenshots.
- `src/services/agent/runKeyTest.ts` + `classifyKeyTest.ts`: one real
  call, `models.completeSimple(model, { messages: [{ role: 'user',
  content: 'Reply with OK.', timestamp: Date.now() }] }, { apiKey,
  maxTokens: 16, maxRetries: 0, timeoutMs: 30000, signal })`. pi-ai
  never throws for request failures: setup failures are encoded by
  `api/lazy.js` as `stopReason: 'error'` + `errorMessage`, and provider
  failures surface the same way via
  `formatProviderError(normalizeProviderError(sdkError))`
  (`utils/error-body.js`: `"<status>: <body>"` when the SDK message
  does not already carry the body). The classifier maps
  `40[13]`/auth words -> `rejected`; fetch/CORS/network words ->
  `blocked` ("blocked by the browser or unreachable (the provider may
  not allow browser calls)"); anything else -> `error` with the
  provider message (200 chars max, key-like tokens redacted).
- `src/components/agent/AgentPanel.tsx`: one `Agent` per open project
  (panel remounts per project via `key={docUrl}`), transcript in memory
  only, no tools. `new Agent({ initialState: { systemPrompt: 'You are
  the research writing assistant in Uktub Scholar.', model,
  thinkingLevel: 'off', tools: [], messages: [] }, streamFn:
  models.streamSimple.bind(models), getApiKey: (provider) =>
  keyFor(provider) })`; send via `prompt()`, streamed text from
  `message_update` (`text_delta`), Stop via `abort()` (abort is idle,
  not an error), errors bounded in the transcript. Switching the picker
  assigns `agent.state.model` so it applies to the next prompt.

Verification 2026-10-20: `tsc --noEmit` clean; jest unit 737 pass (54
suites, incl. 20 new agent tests); `pnpm run build` green. Playwright
(`accept5.mjs`, notes dir) vs `vite preview`, fresh profile: picker
count equals `builtinModels().getProviders().length`; OpenRouter
invalid key -> `rejected`, real key -> `ok` (memory-only); MiniMax
dummy key -> `blocked`; OpenCode outcome recorded live; short chat
streams a reply; long prompt stopped mid-stream -> idle, no error;
reload drops un-remembered keys and keeps remembered ones; Forget
clears storage; requests only to the app origin + tested providers;
console errors only the browser's own network messages. Evidence in
`hermes-web-phase5-2026-10-20/`.
Measured 2026-10-20: OpenCode Zen (`https://opencode.ai/inference/v1`,
Claude model listed) does NOT allow browser calls — preflight fails
with no `Access-Control-Allow-Origin`, classified `blocked`. So in v1
the providers that work from the browser are the CORS-open ones
(OpenRouter verified `ok`); MiniMax and OpenCode Zen are `blocked`.

## Changes on top of the base (Phase 6, 2026-10-20)

The agent gets Uktub's research tools and project file tools; the panel
UX is made usable. Root `src/browser/` serves the agent surface; the
panel builds pi-agent-core tools from it plus Pi-shaped file tools.

Root (Part A):
- `src/core/tools/definitions.ts` (new): the six agent-facing
  definitions moved verbatim from `src/mcp/server.ts` (`name`,
  `description`, `inputSchema`, `outputSchema`, `title`, `annotations`);
  `server.ts` imports and serves them unchanged. MCP `tools/list` output
  is byte-identical to the pre-move capture, pinned by
  `tests/tool-definitions.spec.ts` against
  `tests/fixtures/mcp-tools-list.json`; existing MCP specs stay green.
- `src/core/tools/doctor.ts`: `RESEARCH_SERVICE_KEY_NAMES`
  (`SEMANTIC_SCHOLAR_API_KEY`, `OPENALEX_API_KEY`, `CROSSREF_MAILTO`);
  the providers check uses the constant (doctor output unchanged).
- `src/browser/host.ts`: `hostAgentSurface()` returns the shared rules
  (`AGENT_RULES`), the tools as `{ name, description, inputSchema }`
  (all MCP definitions minus `compile` — `compile` stays out until
  Phase 7 because it refuses `COMPILE_ENGINE_MISSING` in the browser,
  where TeXlyre's own BusyTeX button owns compiling), and `keyNames`
  (`VERIFY_API_KEY_ENV`, then the research-service names).
  `hostSetEnv({ env })` replaces the env later tool calls see; keys stay
  in worker memory only and are never echoed in any result, error or
  progress payload. Wired through `worker.ts` ops + `UktubBrowserClient`
  methods. Covered by `tests-browser/agent-surface.spec.ts` (real
  Chromium worker): surface deep-equals the definitions minus `compile`;
  `setEnv` flips doctor's providers check with the key in no payload.

Web (Part B):
- `src/services/agent/agentUktubTools.ts`: `toAgentToolResult`
  (core result -> pi-agent-core result; `details.refused`/`details.thrown`
  become `isError`); `buildUktubAgentTools(client, surfaceTools)`
  (`parameters: Type.Unsafe(inputSchema)`, `execute` -> `client.callTool`
  with the abort signal wired to the client's cancellation);
  `buildFileTools(client)` — `read`/`write`/`edit`/`ls`, named and shaped
  like Pi's built-in file tools (parameter schemas, property descriptions
  and tool descriptions mirror
  `@earendil-works/pi-coding-agent` 1.3.0 `dist/core/tools/`: `read.js:11-13`
  + description `read.js:53` (truncate 2000 lines / 50KB,
  `truncate.js:10-11`); `write.js:9-10` + description `write.js:25`;
  `edit.js:12,14` + path `edit.js:17` + edits array `edit.js:19` +
  description `edit.js:85`; `ls.js:9-10` + description `ls.js:27`, cap 500
  `ls.js:16`). Only the operations differ: project client instead of the
  local filesystem, project-relative paths, tool-owned paths
  (`refs/references.bib`, `.registry/**`) refused for `write`/`edit`,
  text files only (no image payloads), sequential exact-match edits
  (zero or multiple matches without `replace_all` is an error, as in Pi),
  no shell.
- `src/services/agent/agentResearchKeys.ts`: one settings row per worker
  `keyNames` (no names hardcoded in web), same store rules as Phase 5
  (memory default, opt-in remember, Forget); every change is pushed via
  `setEnv`.
- `src/services/agent/agentRunLock.ts` (new): run-active flag + agent
  file-change emitter. `useEditorNavigation`: open editors are read-only
  while a run is active (OR of the tool-owned mechanism) with the
  tool-owned banner path reused in `FileDocumentController`
  (`agent-run-note`); on agent file changes the open file reloads and the
  `Editor` remounts on the new content.
- `UktubProjectService.refreshAgentPaths(rels)`: re-imports `/proj` bytes
  into the FileStore view (update in place, create new files with parent
  dirs, pull the tool-owned bib, `lastPushed` digests so the bridge does
  not push back), then announces the change.
- `AgentPanel`: system prompt is `agentSurface().rules`; research +
  file tools attached at creation; `beforeToolCall` flushes open editor
  buffers into the project (Phase 4 write-back); after `write`/`edit`
  the touched path is refreshed, after `registry` the bib plus staged
  files are refreshed; run lock set/reset around the turn; tool calls
  render as collapsible rows (name, args summary, running/ok/error/
  stopped, first lines of the bounded result). Settings: provider select
  + model combobox (search box + bounded dropdown, cap 12, closes on
  selection — options keep the Phase 5 `agent-model-option`/
  `data-model-id` contract) + provider key row; once the key test is
  `ok` the settings collapse to one header line ("`<provider> ·
  <model> · key ok · change`"); the transcript fills the panel;
  left-sidebar placement kept.
- `useEditorNavigation`: when a project opens with no file open (fresh
  project, no restored tabs, no URL target), `manuscript/main.tex` is
  opened once per project (guarded ref keyed by docUrl; skipped when
  tabs exist or a target is requested).
- Jest: `@earendil-works/pi-ai` is ESM-only (its exports map has `import`
  conditions only, so ts-jest/CommonJS cannot require it — same reason
  the Phase 5 catalog test fakes its source). `tests/mocks/pi-ai.js`
  (a `Type` stub) stands in under `moduleNameMapper`; the vite bundle
  uses the real package (same TypeBox instance as pi-ai's runtime
  `validateToolArguments`, which also accepts plain JSON schemas via its
  `coerceWithJsonSchema` fallback).

Verification status 2026-10-22 (M3 PASS, one fresh-profile run):
root `tsc --noEmit` (+ `--noUnusedLocals --noUnusedParameters`),
`typecheck:browser`, `test:browser` 42/42, `build:browser` green; web
`tsc --noEmit` clean, jest unit 967 pass (73 suites) + components 82
pass, `pnpm run build` green; Phase 4b-ext and Phase 5 acceptance
reruns green (rerun scripts live in `hermes-web-phase6-2026-10-20/`;
the Phase 5 rerun allowlist covers the scholarly origins the
tool-using agent now legitimately reaches). Phase 6 run (`accept6.mjs`,
fresh profile, `vite preview`, rebuilt bundle incl. the orchestrator's
`provider-fetch` fix, `nvidia/nemotron-3.5-lightning:free`, US$0.00
spend, zero nudges): (a) doctor row ok; (b) papers row ok with S2
answering under the entered key (no `semantic-scholar —
PROVIDER_FAILED` warning) + registry row ok
(`10.48550/arXiv.2312.10997`), bib re-rendered with 1 entry and
opened read-only; (c) edit row ok, editor shows the sentence
post-run, TeXlyre compile -> PDF has the sentence and the
bibliography entry; (d) bib edit refused twice by the tools
(`edit` -> tool-owned refusal pointing at `sync_bibliography`;
`registry register doi:10.fake/2026abc` -> INVALID_DOI refusal)
plus a text refusal, no `remove` call anywhere
(`registry_remove_seen: []`), registry still held 1 paper at (e)
time so no re-register was needed; (e) verify row `error` +
missing-key engine outcome ("engine hosted ... has no key in
UKTUB_VERIFY_API_KEY"), never support; (f) Stop -> idle with no new
errors, 1 stopped row, worker `cancelTool` proof
(`{cancelled, aborted}`); (g) typed input mid-run never reaches
`/proj` (banner + tool-owned note show), editor editable after with
byte-identical restore; (h) requests only to the app origin,
openrouter.ai and the provider origins (openalex, crossref,
semanticscholar, datacite, data.crosscite.org, arxiv.org,
decision.vllm-sr.ai — the last three are DOI resolution, arXiv
acquisition and the hosted-engine handshake), console errors none.
Per-turn tool rows + assistant text in `transcript6.json` (9 rows,
8 turns, 0 nudges). Evidence in `hermes-web-phase6-2026-10-20/`
(`s6-01..s6-11.png`, `accept6.mjs`, `accept6-out.log`,
`transcript6.json`, redacted `s6-requests.json` /
`s6-console-errors.json`, `s6-verdict.json`, `p6-verdict.json`,
`pdf6.txt`).
Measured 2026-10-21/22: the free model needs explicit handling — it
hallucinates plausible DOIs from memory instead of copying tool
output (acceptance prefers preview DOIs, which are ground truth), it
answers "Registered" in prose with fabricated `[ERROR: ...]` lines
instead of calling (acceptance demands the tool call each round), and
`contenteditable` stays `"true"` by design (a hardcoded
`contentAttributes` override beats the readOnly facet), so the
read-only proof is behavioral, not DOM-attribute. Diagnosis
(interim): S2 failures with the key set were fetch-time 429s, root
cause the dropped `x-api-key` header (fixed upstream of this fork
day); the "empty registry at verify" never reproduced in probes —
all deterministic events preserve it, and the green run shows the
(d) turn refusing cleanly without touching the registry.

## Changes on top of the base (Phase 7, 2026-10-21)

The agent gets a `compile` tool on BusyTeX that returns the SAME result
shape as the Node/Tectonic tool. Root core split (`src/core/compile/`,
`src/core/tools/compile.ts` — the fork consumes these through the worker
bundle, they are not fork files): `run.ts` keeps the Tectonic engine run
(locate/spawn/Tectonic grammar/hints); new `finish.ts` owns the
engine-neutral finish (entry-dir mapping, `build/` write, errors-first
cap-50, synthetic error, timeout/overflow texts, `COMPILE_TIMEOUT`); new
`tex-log.ts` parses BusyTeX `logcat` (`! ` errors with `l.<n>` + `(`-stack
file, `LaTeX[` Font]` Warning:` / `Package … Warning:`, Overfull/Underfull
with the paragraph end line, bibtex8 `Warning--` / `Illegal …---line N of
file F`); `diagnostics.ts` shares `capDiagnostics`; `compile.ts` shares
`compileToolResult` (engine label + provenance). Node behavior pinned
byte-identical by `tests/compile-node-pin.spec.ts` (ok/warn/err outcomes,
`describeOutcome`, timeout/overflow/synthetic texts); existing
`tests/compile-*.spec.ts` green unchanged; `tests/tex-log.spec.ts` (9 real
BusyTeX fixtures in `tests/fixtures/busytex/`, see its README) green.

Browser worker (root `src/browser/`): `compilePrepare({entry?})` (core
`resolveEntry`, same `COMPILE_NO_ENTRY` refusals as Node) and
`compileFinish({entry, engineLabel, code, timedOut, log, pdf?})` (TeX-log
parse in the worker, log capped at the labelled client-policy
`BROWSER_COMPILE_LOG_CAP_CHARS = 1_000_000` chars with `outputOverflow`,
finish inside the project write fence, provenance block on success);
`agentSurface()` now includes `compile` (core definition unchanged) plus
`compileTimeoutMs` (the core `DEFAULT_COMPILE_TIMEOUT_MS`, single source —
the page never copies the number). Covered by
`tests-browser/compile.spec.ts` (real Chromium worker).

Web (this fork):
- `src/services/compileMutex.ts` (new): page-wide promise-chain mutex shared
  by the agent compile, the Compile button, clear-cache compile and export
  (a second request waits; the button shows "compiling" meanwhile; always
  releases on error/timeout/stop; abort-while-waiting skips).
- `src/services/compileEngineError.ts` (new): `EngineMissingError` +
  browser-only wording (never mentions the Node CLI). `src/services/agent/
  agentCompile.ts` (new): `executeAgentCompile` (prepare → flush →
  page run under the mutex with the core timeout → worker finish; timeout
  stops the engine and reports the worker `COMPILE_TIMEOUT`; agent Stop
  throws abort-flavored so the row shows `stopped`); `BUSYTEX_ENGINE_LABEL
  = 'busytex 1.4.1'` (Jest-pinned to the installed `texlyre-busytex`
  version).
- `src/contexts/LaTeXContext.tsx`: `compileDocument` / `compileWithClear-
  Cache` run under the mutex (stale-request guards kept); shared
  `applyCompileResult` (viewer/log/popout updates identical for button and
  agent); new `compileForAgent(entryRel, signal?)` returning the
  `CompileResult` (same `compileLaTeX` path as the button, default XeLaTeX;
  BusyTeX load failure throws `EngineMissingError`; signal stops the
  engine); `exportDocument` waits on the same mutex. `LaTeXContextType`
  gains `compileForAgent`.
- `src/services/agent/agentUktubTools.ts`: `buildUktubAgentTools` takes an
  optional `compile` hook (used when the surface lists `compile`); other
  tools still go through `client.callTool`. `AgentPanel`: passes the hook
  (`client.compilePrepare/compileFinish`, `compileForAgent`, core timeout
  from the surface), refreshes `build/<pdf>` into the file tree after a
  compile row, and stores `compileTimeoutMs` from the surface.
- `src/services/LaTeXService.ts`: unchanged (a temporary T1 fixture-capture
  observer seam was added, used, and removed before this landed).

Decisions: `compiled` only when PDF bytes exist AND no error line was parsed
(guards BusyTeX's exit-0-after-failure mapping; `bib-syntax` fixture proves
it); `Emergency stop.` is never a second error (the triggering `! ` line
carries the cause); bibtex `I found no …` / count lines are benign
bookkeeping; the log cap parses the head (file-stack survives) and says the
streams are incomplete; the timeout message/`Next:` reuse the core table
(`COMPILE_TIMEOUT` text is engine-neutral).

Verification 2026-10-21: root `tsc --noEmit` (+ `--noUnusedLocals`
`--noUnusedParameters`), `typecheck:browser`, `test:browser` 46/46,
`build:browser` green; web `tsc --noEmit` clean, jest unit/services/
components 1061 pass (85 suites, 1 skipped upstream) incl. 12 new
tests (5 mutex + 7 execute-mapping), `pnpm run build` green; Phase 4b-ext and Phase 5
acceptance reruns green. Phase 7 run (`accept7.mjs`, fresh profile,
`vite preview`, `nvidia/nemotron-3.5-lightning:free`, US$0.00 spend): (a)
agent compile row `compiled` with `busytex 1.4.1`, viewer shows the PDF,
`build/main.pdf` in the project; (b) agent-inserted `\undefinedmacro` →
`errors` with the line and no `build/main.pdf`, fix → `compiled`; (c)
unregistered `\cite{missing2026}` → warning in diagnostics, provenance
`not registered: missing2026`; (d) Compile button during an agent compile
waits, no crash, both finish; (e) Stop → idle + `stopped` row, engine
stopped, next compile works; (f) requests only to the app origin +
openrouter.ai, console errors none. Evidence in
`hermes-web-phase7-2026-10-20/` (`s7-*.png`, `accept7.mjs`,
`accept7-out.log`, `transcript7.json`, redacted `s7-requests.json` /
`s7-console-errors.json`, `p7-verdict.json`, `t1-fixtures/` capture logs).

## Changes on top of the base (Phase 8a, 2026-10-21)

The two Pi honesty mechanisms the browser lacked, with IDENTICAL behavior:
the always-on writing workflow and the pre-completion gate. All Uktub logic
stays in the worker bundle.

Root (Part A, `src/browser/`):
- `agentSurface()` additionally returns `workflow`:
  `writingWorkflowSection(<SKILL.md text>)` (the same `skills/uktub-research/SKILL.md`
  Pi ships, no copy). The skill text is bundled into the worker at build time
  through the existing asset mechanism: `tests-browser/assets-plugin.mjs` now
  also embeds the skill file as `/__uktub__/skills/uktub-research/SKILL.md`
  (`SKILL_VIRTUAL_PATH`, served read-only by `src/browser/shims/fs.ts` like
  every other bundled asset). Covered by
  `tests-browser/gate-parity.spec.ts`: `agentSurface().workflow` equals
  `writingWorkflowSection(readFileSync("skills/uktub-research/SKILL.md"))`.
- Gate ops backed by ONE `createCompletionGate()` per open project in the host
  state (created at `init`, dropped at `close`): `gateStartUserPrompt()`,
  `gateToolEnded({ toolName, args, isError })`, `gateSettle()` →
  `{ text: string | null }`. `gateSettle` runs `shouldAudit("completed")`,
  then the core `runProvenance` on `/proj` exactly as the Pi adapter does
  (`root`, `now`, `env`, `minConfidenceFromEnv(env)`), then `followUp`; audit
  errors fail open (null), like Pi. No env switch in the browser: the gate is
  always on. Wired through `src/browser/worker.ts` ops +
  `UktubBrowserClient` methods (`gateStartUserPrompt/gateToolEnded/gateSettle`).
  Covered by `tests-browser/gate-parity.spec.ts` (real Chromium worker): the 7
  settle-parity scenarios from `tests/agent-runtime-neutral.spec.ts`
  (unlabelled only, unregistered only, both, >10 pointers, >10 keys, cap of 2,
  untouched → none) produce byte-identical texts through the worker ops on real
  `/proj` documents and a real registry.

Web (Part B, this fork):
- System prompt: `surface.rules.join('\n') + '\n\n' + surface.workflow`
  (workflow last). Pi composition order (`src/pi/index.ts`): `AGENT_RULES`,
  `SECTION_WRITER_RULE`, then the workflow section appended last, so the
  browser matches Pi (workflow rides last; the MCP one-liner and the section
  rule have no browser equivalent). Asserted live from the page seam
  (`systemPromptHasWorkflow`, never from model output).
- New `src/services/agent/agentCompletionGate.ts` (pure, no pi-agent-core
  runtime import): `rememberToolStart` (args by `toolCallId`, since
  `tool_execution_end` carries none), `recordToolEnd` (forwards
  `{toolName, args, isError}`), `startUserPrompt`, and `finishTurn`.
  At the would-finish point `finishTurn` runs the worker `gateSettle`; a
  non-null text is rendered as a distinct "Uktub check" transcript row
  (`agent-msg-check`, never as the user's words) and injected via
  `agent.followUp()` as one `user`-role message, so the SAME `prompt()` run
  continues. Only pure-text completed turns are candidates (tool-call,
  error and aborted turns are skipped); settle failures fail open.
- `AgentPanel`: creates one adapter per agent (the panel remounts per
  project, matching the worker's one gate per open project), passes
  `finishTurn` to the `Agent`, forwards tool start/end events, calls
  `gateStartUserPrompt` on every user send (gate continuations never reset the
  budget), and stores `surface.workflow`.
- Jest: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai` and the
  ESM-only transitive deps they pull (`typebox`, `partial-json`) now load for
  real (`jest.config.cjs`: dist mappings + `mjs` transform + pnpm-aware
  `transformIgnorePatterns`); the pre-8a `tests/mocks/pi-ai.js` Type stub is
  retired (deleted; the vite bundle always used the real package).
  `tests/unit/agent/agentCompletionGate.test.ts` proves the mechanism against
  the REAL loop with the pi-ai faux provider (no network): (a) a tex edit
  followed by an answer continues exactly once with the gate text in the same
  run (one `agent_end`); (b) a second finding continues once more, a third
  does not, and the next user prompt resets; (c) an untouched run is never
  continued; (d) Stop during the continued turn ends the run cleanly.

Decisions:
- Mechanism: `finishTurn` + `agent.followUp()`. `agent_before_settle` does not
  exist in pi-agent-core; `finishTurn` cannot append a message itself (it
  returns only `{action:"continue"} | {action:"end"}`), and `prepareNextTurn`
  runs only when the loop will continue. `finishTurn` runs after the assistant
  turn and its tool results, before `turn_end` (`agent-loop.js:179-180`); a
  message queued with `followUp()` (`agent.js:188-189`) is polled by
  `getFollowUpMessages()` (`agent.js:338`, the follow-up queue drain) exactly
  when the loop would otherwise stop (`agent-loop.js:192-197`), and the SAME
  `prompt()` run continues with it — no `agent_end` in between (`:207`).
  Deterministic proof: the (a)–(d) faux-provider tests (one `agent_end` with
  continued turns). `prepareNextTurn` and `agent_end` listeners were rejected:
  the former never fires at the stop point, the latter fires after the run.
- Injection shape: plain `user`-role message carrying the worker's
  byte-identical gate text. Pi's `custom` gate entry is likewise converted to
  a user message for the LLM (`convertToLlm`, `core/messages.js`), so the
  LLM-visible behavior matches; the panel keeps the UI distinction with the
  `agent-msg-check` row. The default `convertToLlm` already passes `user`
  messages, so no conversion override was needed.
- Bounding: the 2-per-prompt cap lives in the worker gate (proven by the
  cap-of-2 parity scenario); the page adds no cap of its own and resets only
  on user sends. Mid-run pure-text pauses may also trigger a settle (Pi fires
  only at settle); the cap bounds the effect and the message is still part of
  the same run.
- Rerun adaptations (single-key constraint: only `OPENROUTER_API_KEY` is read
  from `.env`): Phase 5 rerun uses a dummy OpenCode key (browser-blocked
  provider; the recorded outcome stands); Phase 6 rerun leaves research keys
  empty and treats keyless S2 `PROVIDER_FAILED` as expected, not a defect;
  Phase 7 rerun tolerates the gate's own continuation after the clean compile
  (the old assertion assumed the run ends at compile) and restores the Hello
  sentence through the client seam when the model resolves the finding by
  deleting it.

Verification 2026-10-21: root `tsc --noEmit` (+ `--noUnusedLocals`
`--noUnusedParameters`), `typecheck:browser`, `test:browser` 54/54 (incl. 8
new gate-parity tests), `build:browser` green; web `tsc --noEmit` clean, jest
1065 pass (90 suites, 4 skipped upstream, incl. 4 new gate-adapter tests with
the real loop + faux provider), `pnpm run build` green. Reruns, all green:
Phase 4b/4b-ext and Phase 5 (single-key adaptations recorded above), Phase 6
(keyless; two early runs failed only on the PDF bib-entry assertion through
free-model variance — a mangled citekey in one, an unresolved `[?]` in the
other — third run clean), Phase 7 (gate-aware adaptations recorded above:
(a) Hello restored via the client seam after a correct gate deletion,
(b) error+fix rows across one run, (c) warning row plus provenance,
(d) mutex double-finish, (e) stopped row + next compile ok, (f) scholarly
origins allowlisted; console errors only two 429 resource-load messages from
free-tier OpenRouter POSTs). Live probes (`accept8a.mjs`, fresh profile,
`vite preview`, `nvidia/nemotron-3.5-lightning:free`, US$0.00 spend): (a) the
system prompt carries the workflow (`systemPromptHasWorkflow: true`, 4198
chars, workflow 2888 — the exact count Pi ships); (b) the task sentence was
refused once (no touch, correctly silent), then complied: the gate fired one
`Uktub check` row with the L3 pointer, the model marked it `(unverified)`;
(c) prose-registration fell back to the client seam, the model prose-refused
the fake cite, the user-seam edit + agent compile fired the gate with BOTH
blocks (unlabelled pointer plus `these citation keys are not in the registry:
madeup2026`), the model removed the cite and labelled the sentence;
(d) plain chat: one answer, zero doc rows, zero gate messages. Final
provenances recorded in `transcript8a.json`; requests only to the app origin,
openrouter.ai and scholarly APIs (one 429 resource message); leak scan clean
(the key appears in no evidence file). Evidence in
`hermes-web-phase8a-2026-10-21/` (`accept8a.mjs`, `transcript8a.json`,
`p8a-verdict.json` — recomputed offline from the saved live evidence after a
one-entry allowlist fix, no new model calls — redacted `s8a-requests.json` /
`s8a-console-errors.json`, `s8a-*.png`, rerun scripts + logs).

## Changes on top of the base (Phase 8b, 2026-10-21)

`write_section` in the browser, from ONE shared definition with Pi
(`src/agent/` is the single home; `src/pi/` re-exports, Pi behavior
byte-identical).

Root (Part A):
- New `src/agent/section-tool.ts`: the tool identity (`WRITE_SECTION_`
  `NAME/LABEL/DESCRIPTION`), the TypeBox `WriteSectionParams` /
  `ForwardPassagesParams` / `ForwardVerifyParams` schemas, `coerceSectionArgs`
  / `toSectionParams`, `normalizeForwardPapers`, `unresolvedBlock`,
  `sectionCountsLine` / `composeSectionResultText` (LaTeX + `---` + summary
  + counts + unresolved), `lastAssistantText`, and the shared
  `verifyRefusalText` / `VERIFY_MALFORMED_TEXT` mapping. No SDK, no Node
  builtin, no process reference.
- New Node-free core modules: `src/core/verify/papers-param.ts`
  (`parsePapersParam`, re-exported from `scope.ts`) and
  `src/core/verify/document-status.ts` (`DocumentUnitStatus`, re-exported
  from `document.ts`; `core/tools/verify.ts` keeps re-exporting both names).
  `src/agent/section-writer.ts` now imports the status from the Node-free
  module; `src/pi/write-section.ts` is re-exports only; `src/pi/index.ts`
  keeps `makeSectionWriterTool` / `sectionWriterTool` / seams and now
  composes result text and refusal/malformed errors through the shared
  helpers (byte-identical strings).
- Pin: `tests/write-section-pin.spec.ts` + fixture
  `tests/fixtures/write-section-tool-pin.json` capture the tool definition
  JSON and one seamed run's result text (green before and after).
- Guard: `tests/agent-runtime-neutral.spec.ts` asserts the moved functions
  are the very objects Pi re-exports, and that `src/agent/**` typechecks
  under a browser-only config (lib DOM, `types: []`, no Node shims) — RED
  with the old `core/tools/verify.ts` import (verified by temporary
  restore), green after.

Browser worker (root `src/browser/`):
- `BROWSER_VERIFICATION_ENGINES` (`host.ts`, exported): `["hosted",
  "openrouter"]` filtered by membership in core `VERIFICATION_ENGINES`
  (single source; order is the browser default first). Only these two judge
  over `ctx.fetch` alone: `eos` spawns Python (`claim.ts`
  `node:child_process`), `eos-onnx` needs local model files plus a native
  runtime, `llama-cpp` targets loopback. Served as
  `agentSurface().verificationEngines` through `worker.ts` (pass-through)
  and `UktubBrowserClient` (typed). Covered by
  `tests-browser/verify-engine.spec.ts` (real Chromium worker): the list is
  exactly `["hosted","openrouter"]` and inside `VERIFICATION_ENGINES`;
  `UKTUB_VERIFY_ENGINE=openrouter` without a key makes `verify` refuse
  `VERIFY_ENGINE_MISSING` with the engine's own missing-key text and makes
  doctor report `engine openrouter: no key in UKTUB_OPENROUTER_API_KEY`;
  with a key doctor reports `engine openrouter: key present` (no probe, no
  network); `verify` with `{ text, offset }` returns a well-formed result.
- `setEnv` REPLACES the worker env (`state.env = {...}`), so research keys
  and verify settings must travel in ONE push (the panel now always sends
  the merged object; the pre-8b research-only push would have wiped the
  engine choice and vice versa).

Web (this fork):
- Import: `@uktub-root` alias (vite `resolve.alias` + `server.fs.allow`
  for the repo root), `paths` in `tsconfig.json` / `tsconfig.test.json`,
  `moduleNameMapper` in `jest.config.cjs` (plus `^typebox$` to the root
  copy the shared module imports). No copy of the definition anywhere.
- New `src/services/agent/agentWriteSection.ts`: `buildWriteSectionTool`
  (shared identity/schemas/coercion/validation/composition/extraction;
  foreign-TypeBox schemas validate through the runtime's JSON-schema
  fallback). Child = pi-agent-core `Agent` on the parent's current model
  (`agent.state.model` at call time) and key (same lookup), tools = only
  the `passages`/`verify` forwards (shared schemas, `normalizeForwardPapers`,
  plain-text results, abort rethrown), system prompt = the same surface
  composition as the parent (`rules + workflow`). `runWriter` prompts the
  child and reads `lastAssistantText(child.state, startIndex)` (empty →
  `the writer sub-session returned no text`); `verifyDocument` = worker
  `verify` `{ text, offset }` with the shared refusal/malformed mapping;
  `abortWriter` = child `abort()`; `disposeWriter` detaches the tally
  subscription (pi-agent-core has no session dispose). Parent abort cancels
  the child and any in-flight worker call (combined signals). Refusal text
  (`write_section refused: …`) matches Pi (plain result, no `isError`);
  run failures return the message as `isError` (abort rethrown).
- Child system-prompt composition vs Pi. Pi's child is a real
  `createAgentSession`: Pi's default coding-agent prompt (preamble + tools
  + rules + docs + cwd sections, `system-prompt.js`) PLUS our extension's
  `before_agent_start` rules (`AGENT_RULES`, `SECTION_WRITER_RULE`, the
  workflow — the child loads the same extensions from the same agentDir,
  verified in `sdk.js`/`agent-session.js`), with the gate silenced by
  `withinGateChild`. The browser child gets the closest surface equivalent:
  the same `rules + workflow` text as the parent (the workflow rides
  because Pi's child gets it). Differences: no Pi default
  preamble/tools/docs/cwd sections (pi-agent-core takes a literal
  systemPrompt), no `SECTION_WRITER_RULE` (no recursive section writer in
  the child), no MCP one-liner. The gate never acts on the child on either
  host (page adapter only sees the parent's events, as Pi's gate only sees
  the parent session's).
- Child tally (`createChildTally`) from the child's events: `message_end`
  with `role: assistant` → turn + `usage.{input,output,cacheRead,
  cacheWrite,cost.total}` (pi-ai `Usage` carries all five);
  `tool_execution_start` → tool call; pi-agent-core emits no
  `auto_retry_start`, so `retries` stays 0 (recorded difference; Pi counts
  real retries).
- Verification setting (`agentVerifyEngine.ts` + panel section): engine
  select from the surface list (default `hosted`, owner decision); for
  `openrouter`, an explicit checkbox "Use my OpenRouter key from the model
  settings" (default OFF) or a separate key field. Same store rules
  (memory default, opt-in remember, Forget via the shared `ResearchKeyRow`);
  the key goes only to the worker env, never into logs/errors/URLs.
  Core discrepancy (unchangeable here): the engine reads
  `OPENROUTER_API_KEY` (`core/verify/claim.ts`) while doctor checks
  `UKTUB_OPENROUTER_API_KEY` (`core/tools/doctor.ts`), so the panel pushes
  the key under BOTH names (the existing `tests-browser/tools.spec.ts`
  openrouter test already uses both).
- `write_section` row: `writeSectionChildSummary` leads the preview
  (`child: T turns, C tool calls, W words; first draft a/b supported;
  final c/d`, numbers only) with the bounded LaTeX after
  (`previewResult`: 3 lines / 300 chars). The parent pastes the returned
  LaTeX with `write` (the shared description says verbatim); no refresh
  hook (only `write`/`edit`/`registry`/`compile` refresh the view).
- Jest: `tests/unit/agent/agentWriteSection.test.ts` (real loop + faux
  provider, no network): child gets only passages/verify with normalized
  forwards; system prompt is rules + workflow; `prepareArguments` coerces
  array papers; result text equals `composeSectionResultText` of the
  rebuilt result; refusal and malformed map to the Pi texts as `isError`;
  pre-aborted signal creates no child; mid-run abort cancels child and
  worker call; engine-env helpers; row summary. Engine choice itself is not
  persisted across remounts (session state, like the transcript).

Verification 2026-10-21: root `tsc --noEmit` (+ `--noUnusedLocals`
`--noUnusedParameters`), `typecheck:browser`, `test:browser` 58/58 (incl.
4 new engine-setting tests), `build:browser` green; web `tsc --noEmit`
clean, jest unit 778 + services/components 298 pass (incl. 11 new
8b tests), `pnpm run build` green. Reruns, all green: agent-surface (2/2)
and Phase 8a gate-parity (8/8).

Live M3 2026-10-22 (Phase 9a tree, seam-flag build
`VITE_UKTUB_ACCEPTANCE_SEAMS=1`, fresh profile,
`nvidia/nemotron-3.5-lightning:free`, US$0.00 spend): engine `openrouter`
(model-key opt-in) + doctor `engine openrouter: key present`; seam
register of `10.48550/arXiv.2312.10997` (`gao2023retrieval`) + acquire
READY via `openalex-pdf-url` + 3 in-browser passages; `write_section` ok
(child 14 turns, 12 tool calls, 57 words; first draft 2/3 supported, final
2/3), the 57-word cited section saved byte-for-byte to
`manuscript/sections/01-introduction.tex`, `\input` wired from `main.tex`;
final provenance 0 unlabelled / 0 unregistered (gate correctly silent).
Orchestrator correction (2026-10-22): the agent compile did NOT succeed —
all 5 agent `compile` rows (status ok = a result, not a refusal) returned
"LaTeX Error: File `sections/01-introduction.tex' not found", although
`/proj` held the file. Root cause: the stale render-time `fileTree` in the
agent compile (Phase 9d D1, fixed); the turn then died on a per-minute
429 (`free-models-per-min`, no browser retry: Phase 9d D3, fixed). Repair/unresolved detail beyond the counts line was cut
by the row preview bound (3 lines / 300 chars). Request origins only the
app origin, openrouter.ai and scholarly/acquisition origins; console errors
only 429 resource-load noise; leak scan clean (no key in evidence).
Shortfalls, all recorded: the verdict block of the success run crashed on
a harness block-scoping bug (fixed afterwards, harness-only — no product
change); the clean rerun then met the spent free-model daily quota (105
model requests logged, honest FAIL verdict; quota resets 2026-10-23 00:00
UTC), so no PDF-bytes pull and no success-turn request log exist. Evidence
in `hermes-web-phase8b-2026-10-21/` (`run3crash/` success turn,
`p8b-verdict.json` FAIL, `seam8b*.json`, `transcript8b.json`, redacted
`s8b-requests.json` / `s8b-console-errors.json`).

## Changes on top of the base (Phase 9a, 2026-10-21)

First-user honesty and cleanup. Every check below is model-free.

Host-specific refusal remedies (root core + worker, no Node behavior change):
- `src/core/refusals.ts`: new `RefusalNextOverrides`
  (`Partial<Record<RefusalCode, string>>`); `renderRefusal` takes an
  optional overrides map (absent codes keep the table text, so
  single-argument calls render exactly as before).
- `src/core/tools/context.ts`: new optional `ToolContext.refusalNext`
  field; `refusalResult` takes optional overrides (or the context
  carrying them). No tool call site passes it, so Node output is
  unchanged.
- `src/core/verify/engines.ts`: the hosted missing-key message drops
  ` (or use the local engine "eos")` (the remedy already lives in
  Node's `VERIFY_ENGINE_MISSING` next); it keeps the key URL and env
  name. The one allowed Node message change, pinned by
  `tests/refusal-node-pin.spec.ts` (18 byte-stable nexts + the new
  message).
- `src/browser/refusal-next.ts` (new): `BROWSER_REFUSAL_NEXT` (6 codes
  whose Node `next` names a Node-only remedy: REGISTRY_NOT_INITIALIZED
  → reopen the project; REGISTRY_CORRUPT → delete + reopen;
  COMPILE_ENGINE_MISSING → reload the page; COMPILE_TIMEOUT →
  simplify; VERIFY_ENGINE_MISSING → Verification settings wording;
  CONFIG_INVALID → Verification settings) plus `NODE_ONLY_DENYLIST`
  (client-policy tokens: `uktub-scholar`, `UKTUB_EOS_PYTHON`,
  `UKTUB_TECTONIC_BIN`, `tectonic`, `chunking.yaml`,
  `UKTUB_CHUNK_CONFIG`, `UKTUB_COMPILE_TIMEOUT_S`, `UKTUB_VERIFY_URL`).
- `src/browser/host.ts`: the context carries the table; `callTool`
  results and `compileFinish` refusals are re-rendered with it (code,
  message and structured details stay the core's).
- `web/src/services/agent/agentCompile.ts`: the prepare `COMPILE_NO_ENTRY`
  rendering honors the same table.
- `tests-browser/refusal-next.spec.ts` (new): table test (non-empty,
  denylist-clean, complete vs the Node table) + live worker test
  (hosted verify without key, registry pre-init: browser wording, no
  denylist token). `tests-browser/tools.spec.ts`: `compileRefusal` is
  no longer byte-compared across hosts (same code+message,
  host-specific `Next:`), asserted explicitly instead.

Acceptance seams behind a flag:
- `window.__uktub` (`UktubProjectService.openProject`, was the
  top-level `exposeTestSeam`) and `window.__uktubAgent` (`AgentPanel`
  effect) are assigned only when
  `import.meta.env.VITE_UKTUB_ACCEPTANCE_SEAMS === '1'`; the production
  bundle drops both branches (verified by grep on real builds, both
  directions). `tests-browser/acceptance-seams.spec.ts` proves the
  mechanism per file via esbuild transform + minify.
- Acceptance scripts build the web app with the flag set.

TeXlyre leftovers removed:
- Static Typst assets `public/core/typst-ts-renderer` (1.4 MB) +
  `public/core/typst-ts-web-compiler` (30 MB) deleted (31.7 MB total;
  lazy-loaded only, no UI path creates a typst project, no precache or
  build step references them). Typst services/code stay: the editor
  still references them (output panels, source maps) and removal is a
  high-risk refactor for no further byte savings.
- Collaborator empty-state hint ("Linking files allows you to view the
  cursor positions…") deleted from `Editor.tsx` (collaboration is
  local-only); unused `Trans`/`LinkIcon` imports removed.
- Duplicate `main.tex` tab: `EditorTabsContext.openTab` used
  timestamped ids, so two opens from a stale closure (the auto-open
  racing a restore) minted twin tabs. Ids are now deterministic per
  file/document (`type-key`) with updater-level dedupe by id and by
  fileId/documentId (renames restored timestamped tabs, healing
  persisted twins). Covered by
  `tests/components/EditorTabsDedupe.test.tsx` (RED: 2 tabs with
  distinct timestamps, green after).
- Sign-in UI: `AuthApp`/`Login`/`Register`/`ImportAccount`/
  `GuestConsentModal` deleted; `AuthProvider` init silently creates a
  local guest session when none exists (no prompts); `AppRouter` no
  longer gates on auth (unreachable fallback is a plain local message).
  The guest identity stays local-only. `PasswordModal` (local secrets
  encryption) and the guest `UserDropdown` stay.
- `pnpm run build` `dist/`: 575,793,018 → 544,116,568 bytes
  (−31,676,450).

Export/import keep the registry:
- `UktubProjectService.exportProject()` / `.importProject()` (new):
  thin wrappers over the live worker client's `exportProject` /
  `importProject` (zip of `/proj` files + standalone registry DB
  bytes); import rebuilds the FileStore view afterwards.
- `tests-browser/export-roundtrip.spec.ts` (new, real Chromium worker,
  canned providers): register 2 papers, write entry/section/results,
  export → close → deleteProjectStorage → fresh init (0 papers) →
  import → registry `read` lists the same 2 DOIs, file list and
  entry/section/results/bib byte-identical, registry bytes carry a
  SQLite header.
- Known limitation (unchanged behavior, no regression): the
  project-list backup modals (`ProjectExportModal` /
  `ProjectImportModal` via `AccountExportService` /
  `ProjectImportService`) still use TeXlyre's multi-project IDB format
  without the registry; the registry-preserving round trip is the
  service/worker path above.

Assistant panel width:
- The sidebar was already a `ResizablePanel`; the assistant view now
  remembers its own width (`useEditorLayout`: `assistantWidth` /
  `handleAssistantResize`, persisted `sidebar-width-assistant` property,
  default 380 within the 500 max) instead of sharing the explorer's
  250. `FileDocumentController` switches width/handler by view. No
  other UX changes. Covered by
  `tests/unit/hooks/useEditorLayoutAssistant.test.ts`.

Also fixed (pre-existing in this tree, blocking `web` build): the
`beforeToolCall` hook in `AgentPanel.tsx` now returns `undefined`
explicitly (pi-agent-core's type requires
`Promise<BeforeToolCallResult | undefined>`).

## Changes on top of the base (Phase 9c, 2026-10-22)

The user-facing project export/import now keeps the registry (Phase 9a kept
it only on the worker seam path, and 9b proved the seam while wrongly
claiming no product UI existed).

Backup layout (`src/services/BackupLayoutService.ts`): new path helpers —
`getUktubDirPath` (`projects/<id>/uktub`), `getUktubFilesZipPath`
(`.../uktub/proj.zip`, the `/proj` files zip), `getUktubRegistryPath`
(`.../uktub/registry.db`, the standalone registry DB bytes). The extra
`uktub/` dir is ignored by old readers (metadata-driven `readFiles` /
`readDocuments` never list it).

Export (`AccountExportService`, used by the `ProjectExportModal` from the
Projects list and from the editor via `FileDocumentController`, in both
cases TeXlyre format by default): for every exported project in the
TeXlyre format the archive now also carries that project's Uktub worker
export at the path above. Obtained through `UktubProjectService`
(`exportUktubPayload`, new): the live client (after `flush()`) when that
project is the one open in this tab, otherwise an ephemeral worker exactly
like `deleteProjectStorage` (init with that project id → export → close →
terminate). A failed Uktub export for any selected project (e.g. open in
another tab: lock refused) or a null registry fails the whole export with
`Uktub export failed for project "<name>": <reason>` (thrown through, not
swallowed by the generic export error); no archive is written.
`files-only` stays a plain file zip. The TeXlyre-format card copy now
states the export includes the Uktub registry.

Import (`ProjectImportService.importFromZip`, the import modal path, and
`importFromBackup` for directory backups): when the archive project
carries the payload, after TeXlyre creates the project the payload is
imported into THAT new project's Uktub storage through an ephemeral
worker (`importUktubPayload`: init → `importProject({ zip, registry,
replace: true })` → close), before the project can be opened — so the
first open shows the registry, bib, sections and results. A failed Uktub
import fails that project's import visibly (per-project error entry) and
the created project is removed again (no half-imported project left
listed; follows the existing `result.errors` convention). Archives
without the payload import exactly as before. `importAccount` (account
modal) now carries the payload in its archive but does not restore it
(known gap, same as plain TeXlyre archives).

Tests (fork Jest; worker boundary only mocked):
`tests/services/AccountExportUktub.test.ts` — archive holds the exact
payload bytes at `projects/p1/uktub/proj.zip` + `/registry.db` (RED:
payload files missing); refused export rejects with `/P One/` and no
saveAs (RED: generic "Failed to export data"). Plus a realm-robust
`toBytes` in `archiveUtils.ts` (realm-local copy when the encoder comes
from another realm; zero-copy otherwise — the fork Jest setup swaps in
Node's TextEncoder, whose output fails JSZip's `instanceof` check).
`tests/services/ProjectImportUktub.test.ts` — payload imported into the
NEW id with exactly those bytes (RED: 0 calls); archive without payload
leaves the worker boundary untouched; failed import → error entry +
`deleteProject('src1')`, nothing imported (RED: imported held the id).
5/5 green; full web jest 1083 pass / 16 skipped (4 suites skipped
upstream), `tsc` clean, `pnpm run build` green, production `dist/` holds
no `window.__uktub`/`__uktubAgent` (`__uktub__` in the worker bundle is
the skills virtual path), root `tsc --noEmit` clean.

Acceptance, model-free, seam-flag build vs `vite preview` (scripts +
updated `web/e2e/README.md` in-repo):
`web/e2e/ui-roundtrip.mjs` (+ `run-roundtrip-ui.mjs` launcher; shared
steps in `web/e2e/ui-roundtrip.mjs`, also reused by `full-flow.mjs`):
fresh profile → create → seed 2 real DOIs via the seam (ONLY
seam-performed step, labelled; `10.48550/arXiv.1706.03762`,
`10.48550/arXiv.1406.2661`) → citekeys typed into `manuscript/main.tex`
through the editor → Compile button → export modal (TeXlyre format,
download event, payload entries asserted in the zip) → Projects-list
delete UI → import modal with the zip → open → registry `read` lists the
same DOIs, `refs/references.bib` byte-identical (1225 chars), Compile
button → byte-identical PDF text (413 chars, marker + numeric cites).
15/15 PASS, 0 openrouter.ai requests, console clean, leak scan clean.
`full-flow.mjs` fixes: `compileViaButton` passes `{ timeout, polling }`
as Playwright options (was the `arg`, so the 30 s default applied) and
waits for viewer text to differ from before the click and be non-empty
(or contain a marker) — the old `> 50` chars test could never hold for
the 44-char template PDF; step 6 now uses the UI helper (no
seam-performed export/import); model accounting from the provider's own
counter (`GET /api/v1/key`, only `free_model_daily_requests`
{used, limit, remaining} recorded); quota preflight
(`FF_MIN_FREE_REQUESTS`, default 400 — client policy: one 8b section
used ~105 requests, this flow writes two plus search/acquire/verify)
skips every model-dependent step including the key test. Run
2026-10-22 with counter 1025/1000/0: model steps "not run", steps 1, 6
(empty registry round-trips; bib 75 chars identical; PDF 44 chars
identical), 8 pass; request log + counter (1025→1025) prove zero model
requests. The model flow is NOT run here — the orchestrator runs it when
the quota allows.

Item-5 findings (REPORT only, unchanged): Disk/File-System backup
(`DiskBackupService` via editor `BackupModal`, per-card
`ProjectBackupControls` Export/Import, list `BackupDiscoveryModal`
import) and the `WorkspaceService` folder mirror all move the FileStore
view / unified layout only — no `uktub/` payload, so they drop the
registry. Git backup (`GitBackupService` + github/forgejo/gitlab/gitea
adapters) syncs the same view to a remote and restores into it — also
registry-less, and no component references it (effectively unreachable
from the current UI). All three ignore/drop the extra `uktub/` dir
harmlessly (metadata-driven reads).

## Orchestrator cleanup (2026-10-21)

- Removed the upstream `package-lock.json` and `yarn.lock`: this fork installs with pnpm (`packageManager`), and only
  `pnpm-lock.yaml` records the added `@earendil-works/pi-ai` / `pi-agent-core` 1.3.0; the other two were stale upstream
  copies (pristine versions in `reference_repos/2026-10-20/TeXlyre__texlyre/`).

## Changes on top of the base (Phase 9d, 2026-10-22)

Three defects from the Phase 8b live evidence (the agent wrote
`manuscript/sections/01-introduction.tex`, wired `\input` into `main.tex`,
and all 5 agent compiles missed the new file, then the turn died on a 429),
each re-verified in source before the fix.

D1 — stale tree in the agent compile. `ensureAgent` builds the `Agent` once
(`AgentPanel.tsx`); its compile hook called `compileForAgent`, which staged
the `fileTree` of the render that built the agent (`LaTeXContext.tsx`),
predating every agent-created file. Fix: `compileForAgent` builds the tree
at call time (`await fileStoreService.buildFileTree()`,
`src/contexts/LaTeXContext.tsx:337-339`), after the flush. The Compile
button path is unchanged.

D2 — view/worker race. pi-agent-core runs one message's tool calls in
parallel by default (`dist/agent.js:145`
`toolExecution ?? "parallel"`; the panel sets none). After a writing tool,
the listener started `void refreshAfterTool(...)` un-awaited while the next
tool's `beforeToolCall` flushed into `reconcile()`, whose orphan pass
(`UktubProjectService.ts`) deleted every `/proj` file in neither the view
nor tool-owned — including the just-written section. Fix, both halves:
(a) worker-writing tools refresh inside their own `execute`
(`buildFileTools` `hooks.afterWrite`, `buildUktubAgentTools`
`opts.afterRegistry` in `src/services/agent/agentUktubTools.ts:153-161,236,311,396-403,417-427`;
the panel passes `refreshAfterTool` as both,
`src/components/agent/AgentPanel.tsx:571-585`; the listener keeps only the
compile-PDF refresh); (b) `reconcile` never deletes a `/proj` file the view
never had — it pulls it INTO the view (`pullIntoView`,
`UktubProjectService.ts:509-545`, orphan pass `:460-486`), while deletions
of view-known files stay on the existing `lastPushed` loop.
`refreshAgentPaths` reuses `pullIntoView` (`:564`).

D3 — no auto-retry in the browser agent (host parity). Node Pi retries
retryable assistant errors (`_isRetryableError` →
`isRetryableAssistantError`, `_prepareRetry` with exponential `retryDelayMs`,
`dist/core/agent-session.js:3011-3090` in
`@earendil-works/pi-coding-agent` 1.3.0; defaults
`dist/core/settings-defaults.js:18-21`: enabled, maxRetries 3,
baseDelayMs 2000, maxAgentDelayMs `DEFAULT_MAX_AGENT_RETRY_DELAY_MS`
(60_000, `pi-ai/dist/utils/retry.js:98-99,193`));
pi-agent-core itself never retries (an error assistant message ends the turn
at once). Parity was possible on pi-agent-core/pi-ai public API, in a new
`src/services/agent/agentRetry.ts` (`withAgentRetry`, same predicate via
`isRetryableAssistantError`, same policy const, same exponential capped
delay, failed attempts omitted: events dropped, partial cut from the
context, backoff abortable by the run signal so Stop settles the turn as
aborted with no further request). Wired into the parent
(`AgentPanel.tsx:642-647`, one `agent-msg-retry` transcript row per retry:
`addRetryRow`, `:439-452`) and the `write_section` child
(`agentWriteSection.ts:199-203`; performed retries land in the existing
`details.child.retries`, `:270-282`; the panel shows a `write_section` row
per child retry, `AgentPanel.tsx:591`). The pre-completion gate is
untouched: failed attempts never reach `finishTurn`, so an error turn still
never consumes a gate follow-up (8a gate-parity specs green).

No root `src/agent/**` change: the shared section-writer is untouched (the
child tally still counts real `auto_retry_start` events, which pi-agent-core
never emits; the wrapper count is added beside it). `tests/write-section-pin.spec.ts` unaffected by construction.

Tests (fork Jest, all RED first on assertions, never on imports):
`tests/unit/agent/agentStaleCompile.test.tsx` (D1: section stored after the
render is staged — RED: staged `[]`, green after);
`tests/unit/agent/agentViewRace.test.ts` (D2: unknown `/proj` file pulled
not deleted — RED: deleted; known-and-dropped still deleted; write returns
only after the view has the file — RED: view content `undefined`; one
message with parallel write+compile through the real loop — RED: staged
`["/manuscript/main.tex"]`, green after);
`tests/unit/agent/agentRetry.test.ts` (D3 parent: policy values, 429-then-ok
retries once with one row and one completed turn, non-retryable never
retries, Stop mid-wait aborts with no second request, exhausted errors end
with no follow-up — the three retry cases RED: 0 retries observed);
`tests/unit/agent/agentWriteSection.test.ts` (+3 child cases: retry counted
in `details.child.retries`, non-retryable unretried, Stop mid-wait aborts).
Full web jest 1096 pass / 16 skipped (4 upstream-skipped suites), `tsc`
clean, production `dist/` holds no `__uktubAgent`/`window.__uktub`
(`__uktub__` in the worker bundle is the skills virtual path).

Acceptance, model-free, seam-flag build vs `vite preview`
(`web/e2e/agent-tools-9d.mjs`, new; drives the agent's own tool `execute`
path through the seam-flag `__uktubAgent.runTool`, labels every step):
create project → agent `write` of `manuscript/sections/01-x.tex` →
agent `edit` of `main.tex` adding `\input{sections/01-x}` → agent compile
→ `compiled: true`, PDF bytes from `/proj` (`build/main.pdf`, 10288 bytes)
contain the sentence, the section is still in `/proj`. 12/12 PASS,
0 openrouter.ai requests, console clean, leak scan clean. Evidence in
`hermes-web-phase9d-2026-10-22/` (`a9d-verdict.json`, `a9d-main.pdf`,
`a9d-pdf.txt`). Phase 9c `roundtrip-ui` rerun 15/15 PASS. Root
`tsc --noEmit` (+ `--noUnusedLocals --noUnusedParameters`),
`typecheck:browser`, `test:browser` 68/68 green. Root `src/agent/**`
untouched; no git operations.

## Orchestrator: pi-ai / pi-agent-core 1.4.0 (2026-10-22, owner-approved)

- `pnpm add @earendil-works/pi-ai@1.4.0 @earendil-works/pi-agent-core@1.4.0` (lockfile has no 1.3.0 copy left).
  Upstream v1.4.0 release notes: no breaking API change; OpenRouter catalog adds `minimax/minimax-m3.1-flash:free`.
- pi-ai 1.4.0 imports the new ESM-only `@earendil-works/pi-telemetry` (not hoisted by pnpm); `jest.config.cjs` maps
  it next to pi-ai's real location, like the existing pi-ai mapping. Web `tsc` clean, Jest 1,096 pass / 16 skipped,
  production build green. Chromium probe (pi-ai bundle, invalid key): OpenRouter answers a readable 401 with 1.4.0's
  request headers (new `x-session-id`), so CORS still passes; the new model resolves from the catalog.

## Changes on top of the base (Phase 9e, 2026-10-22)

Owner decision: remove TeXlyre's legacy account/data/backup layer. One
silent local guest identity, one storage of record per project (the Uktub
worker's OPFS `/proj` + `registry.db`).

Removed:
- Account/data UI: `UserDropdown` (header "Guest User" menu: Profile
  Settings, Storage, Export Account, Delete Account, End Session/Log out),
  `ProfileSettingsModal` + `ProfileAccountIdentitySection` /
  `ProfileBrowserStorageSection` / `ProfileLocalStorageDataSection` /
  `ProfileChelysConnectionSection`, `ExportAccountModal`,
  `DeleteAccountModal`. Headers (`EditorApp`, `ProjectApp`) keep only
  compile buttons + settings gear; logged-out prop threaded but unused.
- Disk backup: `BackupModal`, `BackupDiscoveryModal`,
  `BackupStatusIndicator`, `ProjectBackupControls`, `DiskBackupService`,
  `DiskBackupContext`/`useDiskBackup`, `WorkspaceService` (+ folder mirror
  in `FileExplorer`, `ProjectImportModal`, `useDiskFiles`),
  `WorkspaceActivityService`, `WorkspaceModal`/`WorkspaceStatusIndicator`,
  FilePizza peer sync (`PeerFileSyncService`, `PeerFileSyncContext`,
  `usePeerFileSync`, `FileSyncModal`, `FileSyncProvider` wrapper,
  `registerFileSyncSettings`, `registerFileSystemBackupSettings`) and the
  file-sync/file-sys-backup settings defaults + `userdata*.json` entries
  (incl. the `filepizza.*` server URLs). `DiskHandleStore` is kept: the
  kept `GitFileSystemService` uses it for its workspace-handle slot and
  `FileHandlerService` for `ensurePermission`.
- Git backup/remote: `GitBackupService`, `GitBackupSyncService`,
  `GitBackupImportService`, `GitSyncService`, `GitRemoteModal`,
  `GitCredentialSelect`, `GitRemoteStatusIndicator`, forge adapters
  (`extras/backup/{github,gitlab,gitea,forgejo}` + `backup:` config list),
  `types/gitRemote` + `types/gitBackup`, `utils/gitUtils` +
  `utils/gitBackupUtils`, `PluginRegistry.getGitRemoteProviders` /
  `BackupPlugin.gitRemote`. `GitHistoryPanel` keeps local history only
  (commit/restore/branches/diffs via `GitService` + `GitFileSystemService` +
  `MergeResolutionService`); pull/push/remote-modal wiring deleted.
- Account service paths: `AccountExportService.exportAccount` /
  `importAccount` (+ `importUser*/createProjectDirectly/authenticate*`,
  `includeAccount`/`includeUserData`, `writeFilesOnlyStructure`) and the
  export modal's `files-only` radio — one TeXlyre-format archive carrying
  the Phase 9c Uktub payload (`BackupLayoutService` helpers kept and used
  by `ProjectImportService`).
- Chelys account sync: `ChelysAccountSyncService` deleted; `ChelysService`
  (`persistRoom`/`clearRoom`) and `ChelysContext` keep local-only room
  state, no sync start/stop. `src/chelys` kept (local transports for
  `ExternalServiceBase` etc.).
- Deps: `pnpm remove filepizza-client y-websocket` (`y-webrtc` stays:
  reachable via `ExternalServiceBase` → `TransportFactory` →
  `WebrtcTransport`); jest `filepizza-client` mock mapping + mock file gone.

Kept for dependency (would break a KEEP item otherwise): `DiskHandleStore`
(`ensurePermission` for launch-handle sync in `FileHandlerService`);
`FileHandlerService` workspace-mirror branches (inert: `workspace` is
always null, no attach callers); local git history stack (KEEP "file
history"); `PeerDocumentTrackingService` (open-editor tracking via
`FileDocumentController`); `AuthService` login/register/upgrade methods
(no UI triggers left); file-sync sessionStorage mapping key in
`FileTreeContext` (editor file-document linking, unrelated to FilePizza).

Unclear (REPORT, not removed): `ShareTargetModal`/`ShareTargetService`
(inbound PWA share-target, local-only); `CollabModal`
(`components/collab`, never rendered — pre-existing dead); locale entries
in `translations/locales/*` for removed strings (inert i18n data);
`AuthService.logout` + guest expiry (no UI trigger left);
`pluginRegistry.getBackup()` API (no plugins registered).

Tests: deleted `GitBackup*` (3), `Git*Service` (4 incl. RemoteMerge),
`WorkspaceService`, `gitBackupUtils`, `gitUtils`, `extras/backup` (2),
`ProfileBrowserStorageSection`, and 5 workspace-only cases +
`workspaceService` mocks in `useFileHandler.test.ts`; remote/pull cases +
`GitSyncService`/`GitRemoteModal` mocks in `GitHistoryPanel.test.tsx`
(local-history cases kept). New requirement
`tests/components/Phase9eHeaderExport.test.tsx`: header has no
user/account menu components (fs absence check) and the export modal
renders exactly one `exportFormat` radio (RED before: 8 files present +
2 radios; green after). No other test weakened.

Verification 2026-10-22: web `tsc --noEmit` clean, web jest 82 suites /
961 pass / 16 skipped (4 suites skipped upstream), `pnpm run build` green;
production `dist/` 544,134,794 → 543,717,256 bytes (−417,538), no
`window.__uktub`/`__uktubAgent` (`__uktub__` in the worker bundle is the
skills virtual path); root `tsc --noEmit` clean. Seam-flag build +
`run-roundtrip-ui.mjs` 15/15 and `agent-tools-9d.mjs` 12/12 PASS (below).

## Changes on top of the base (Phase 9f, 2026-10-22)

Browser offers only engines a page can reach. The `hosted` verifier
(d3-mini at `https://decision.vllm-sr.ai/v1/systemone`) cannot be called
from a page or worker: measured 2026-10-22 from real Chromium, `OPTIONS`
returns 405, the 401 to a POST carries no `Access-Control-Allow-Origin`,
and both a preflighted and a simple POST report "Failed to fetch"
(shell curl confirms: OPTIONS 405, POST 401, no ACAO). Browser tests had
only ever exercised it with a stubbed fetch, and the browser
`VERIFY_ENGINE_MISSING` remedy pointed researchers at it.

- `src/browser/host.ts`: `BROWSER_VERIFICATION_ENGINES` is now
  `["openrouter"]` with a one-line comment citing the measurement and
  the return condition (`hosted` returns when its server allows CORS —
  re-measure with a real Chromium fetch, not a stub). Still derived
  from core `VERIFICATION_ENGINES`.
- Web Verification settings default to `openrouter`
  (`agentVerifyEngine.ts` `VERIFY_ENGINE_DEFAULT`; model-key opt-in
  behavior unchanged). New `resolveVerifyEngine(stored, engines)`
  helper: a stored `hosted` choice from an older session visibly falls
  back to the first offered engine; `AgentPanel` uses it for the select
  value, the summary line and every `setEnv` push.
- `src/browser/refusal-next.ts`: `VERIFY_ENGINE_MISSING` next now names
  only the OpenRouter engine; `NODE_ONLY_DENYLIST` gains
  `decision.vllm-sr.ai` / `hosted` as forbidden browser remedy tokens
  (label: client policy, measured CORS block). Node behavior unchanged;
  `tests/refusal-node-pin.spec.ts` untouched.
- New real-network tripwire `tests-browser-net/hosted-cors.spec.ts`
  (model-free, no key): a page `fetch` with an `authorization` header
  must reject as a CORS block. The day the provider enables CORS this
  test fails on the resolved response — that failure is the signal to
  re-add `hosted`.

Legacy UI leftovers (Phase 9e follow-up, same phase):

- Export modal (`components/project/ProjectExportModal.tsx`) is one
  plain action: copy reads "Exports the project with its Uktub registry
  (papers registry, bibliography, sections, results) for re-import into
  this app"; the TeXlyre text and the three include toggles are gone,
  the payload always carries the whole round-trip project
  (`includeDocuments: true, includeFiles: true`,
  `includeTemporaryFiles: false`). `web/e2e/ui-roundtrip.mjs` clicks the
  renamed "Uktub Format" card. Import still sniffs the payload, not the
  format string, so the round trip is unchanged.
- Editor sidebar Collab tab removed: the "Collab" toggle button and the
  `activeView === 'documents'` branch (`DocumentExplorer`) are gone; the
  sidebar is Files / Search / History / Assistant and a `documents`
  view falls back to the file tree. Kept: `DocumentFileSyncService`
  (used by `UktubProjectService.reconcile`), the Yjs document machinery,
  `FileDocumentController`, tabs and the `documents` navigation signal —
  document opening/editing flows are untouched.

Tests: updated `tests-browser/verify-engine.spec.ts` (surface is exactly
`["openrouter"]`) and `refusal-next.spec.ts` (new denylist-token test;
live verify test now pins the default openrouter no-key refusal);
`tests/refusal-node-pin.spec.ts` untouched. New requirement
`web/tests/components/Phase9fExportSidebar.test.tsx` (no TeXlyre copy /
checkboxes, Uktub-registry re-import copy, one-click full payload, no
Collab tab, documents view falls back to files; RED before, green after)
plus `resolveVerifyEngine` unit cases and the `openrouter` default in
`agentWriteSection.test.ts`.

Verification 2026-10-22: root `tsc --noEmit`
(+ `--noUnusedLocals --noUnusedParameters`) clean,
`typecheck:browser` clean, `pnpm test:browser` 69/69, net suite 36 pass
(live provider part skipped by design) incl. the new CORS tripwire,
`pnpm build:browser` green; web `tsc` clean, web jest 83 suites /
967 pass / 16 skipped (4 suites skipped upstream), `pnpm run build`
green; production `dist/` has no `window.__uktub`/`__uktubAgent`
(`__uktub__` only in `dist/uktub/worker.js`, the skills virtual path).
Seam-flag build + `run-roundtrip-ui.mjs` 15/15 and
`agent-tools-9d.mjs` 13/13 PASS.

## Orchestrator: browser key list follows the browser engines (2026-10-22, after Phase 9f)

- `agentSurface().keyNames` (`src/browser/host.ts`) no longer lists `UKTUB_VERIFY_API_KEY`: only the hosted/llama-cpp engines read it
  and the browser offers neither, so the panel showed a key row with no use. Test first: `tests-browser/agent-surface.spec.ts`
  (RED: actual `['UKTUB_VERIFY_API_KEY', 'SEMANTIC_SCHOLAR_API_KEY', 'OPENALEX_API_KEY', 'CROSSREF_MAILTO']`); green; `test:browser`
  69/69, root `tsc` (+unused) and `typecheck:browser` clean, web Jest 967.


## Changes on top of the base (Phase 9g, 2026-10-22)

Problem (orchestrator, measured 2026-10-22): the browser's only
verification engine (`openrouter`) always used the `:free` decision model.
OpenRouter's free pool is account-wide (1,000 requests per UTC day); once
spent, verification fails for every user, even one whose key has a paid
budget. The dry run below saw the spent pool live (`remaining: 0`).

Web only (`src/` untouched; the engine already reads the env var):

- `src/services/agent/agentVerifyEngine.ts`: new `VERIFY_MODEL_ENV`
  (`UKTUB_OPENROUTER_MODEL`), `VERIFY_MODEL_DEFAULT`
  (`inception/mercury-decide:free`, mirrors core
  `DEFAULT_OPENROUTER_MODEL` — the only hardcoded id),
  `listVerifyModels(models)` (pi-ai `getModelsOfType('classifier',
  'openrouter')`: entries marked `type: 'classifier'`, api
  `typesafe-system-one`, provider `openrouter`; 28 in pi-ai 1.4.0),
  `formatVerifyModelPrice` (catalog cost: `free`, else `$X/M input`),
  `resolveVerifyModel` (stored choice kept only when listed, else the
  core default). `buildVerifyEnv` pushes the model with the same
  merge/replace rules as the engine/key push. Doctor's verification line
  names no model, so nothing to reflect there.
- `src/components/agent/AgentPanel.tsx`: Verification settings gain a
  "Verification model" select (dynamic options with catalog prices,
  default the core default; visible fallback when the catalog drops a
  stored id), pushed via every `setEnv` merge; summary line and the
  `__uktubAgent` seam (`verifyModel`, `verifyModelCount`) expose it.
- Harness (`web/e2e/full-flow.mjs`, `README.md`): `FF_VERIFY_MODEL`
  (env, default the core default) is selected through the new UI control
  in step 2; the free-request preflight floor applies only when the
  writer (`FF_MODEL`) or the verification model ends in `:free`; the USD
  preflight (`FF_MIN_USD`) covers a paid writer or paid verification
  model. The verdict records `verifyModel`. Step 1 asserts model-free
  (no model call) that the control lists both mercury-decide variants,
  then restores the Files view (the open assistant hides the header
  export button step 6 needs).

Tests: new `web/tests/unit/agent/agentVerifyEngine.test.ts` (real pi-ai
1.4.0 data: `dist/.../data/openrouter.json` read through a real
`Models.getModelsOfType` — `providers/all` pulls ESM-only lazy modules
Jest cannot require; RED: unknown exports / dropped model key; green
after) and two `tests-browser/verify-engine.spec.ts` cases pinning the
worker contract via init `fetchRoutes` + `setEnv` (stubbed 500 names
`openrouter decisions (inception/mercury-decide): HTTP 500`, and the
free default without the env var).

Verification 2026-10-22: web `tsc` clean, web jest 84 suites /
971 pass / 16 skipped (4 suites skipped upstream), `pnpm run build`
green; root `tsc --noEmit`, `typecheck:browser` clean,
`test:browser` 71/71. Seam-flag build + `agent-tools-9d.mjs` 13/13 and
`run-roundtrip-ui.mjs` 0 fail. Model-free dry run
(`FF_MIN_FREE_REQUESTS=100000`, `dryrun/`): `step1-verify-model-control`
PASS (28 options incl. both mercury-decide variants), every model step
"not run", 0 openrouter.ai requests, USD 10/10 untouched, leak scan
clean. No git operations.

## Changes on top of the base (Phase 9h, 2026-10-22)

Problem (orchestrator, live evidence
`fullflow-2026-10-22-live3/ff-transcript.json`): after setup (engine
`openrouter`, "use the model key" ticked, verification model
`inception/mercury-decide`, doctor "key present"), both `write_section`
calls failed with "verify document mode refused (VERIFY_ENGINE_MISSING):
openrouter decisions engine: OPENROUTER_API_KEY is not set". Cause: the
worker's `setEnv` REPLACES its env, and the panel's surface-load effect ran
on every panel MOUNT pushing `pushEnv(surface.keyNames, initialEngine,
false, VERIFY_MODEL_DEFAULT)` (`AgentPanel.tsx` ~L802, literal defaults).
The assistant panel unmounts whenever the sidebar switches to another view
(Files, Search, History) and remounts on return, so any file-tree visit
silently dropped the OpenRouter key and reset the model to the free
default; `verifyUseModelKey` / `verifyModel` / engine are React state, so a
remount forgot them too. The previous live run never switched views, which
is why it passed.

Web only (`src/` untouched):

- `src/services/agent/agentKeyStore.ts`: new `VerifySelection`
  (`engine`, `useModelKey`, `model`) + `saveVerifySelection` /
  `loadVerifySelection` — the same localStorage-JSON pattern as
  `saveAgentSelection`, but a separate slot (no merge churn at the three
  existing call sites). Chose this over a module-level store because the
  requirement is exactly how provider/model selection already persists, and
  it additionally survives a reload; keys keep their memory-unless-remember
  rule untouched.
- `src/components/agent/AgentPanel.tsx`: the three settings lazy-init from
  storage on mount; all three verify handlers persist the next triple; the
  mount-time push sends the CURRENT settings (`initialEngine`,
  `verifyUseModelKey`, raw `verifyModel`). Raw, not resolved: catalog
  options may not be loaded yet at mount, and resolving against `[]` would
  fall back to the free default — the bug being fixed. Within the session
  the stored id is catalog-valid, so raw matches the pre-remount push. A
  fallback-resolved engine is written back to storage.
- Harness (`web/e2e/full-flow.mjs` step 7): Stop is clicked as soon as the
  agent is busy AND a tool row is running (bounded poll), replacing the
  fixed 3 s wait that raced fast models (live3 locator timeout). Pass rule:
  idle afterwards + the running call cancelled; a model that answers before
  any tool runs is recorded as "not exercised", not a pass.
- `jest.config.cjs`: the `ts-jest-mock-import-meta` replacement gains
  `env: {}` — the only component reading `import.meta.env` (AgentPanel's
  seam flag) previously crashed under Jest.

Tests: new `web/tests/unit/agent/agentVerifyRemount.test.tsx` (real
AgentPanel, fake worker client recording `setEnv`): configure openrouter +
model-key opt-in + paid model, unmount, remount → last `setEnv` still holds
`OPENROUTER_API_KEY` + `UKTUB_OPENROUTER_MODEL=inception/mercury-decide`.
RED before (line 156: key `undefined`), green after. 8b/9f/9g suites stay
green.

Verification 2026-10-22: web `tsc` clean, web jest 85 suites / 972 pass /
16 skipped (4 suites skipped upstream), `pnpm run build` green (plus the
seam-flag build); root `tsc --noEmit`, `typecheck:browser` clean,
`test:browser` 71/71; `agent-tools-9d.mjs` 13/13 and `run-roundtrip-ui.mjs`
15/15 PASS. Model-free dry run (`FF_MIN_FREE_REQUESTS=100000`, `dryrun/`):
step1 4/4 (verify-model control lists 28 incl. both mercury variants),
step6 6/6, step8 + leak-scan PASS, 0 openrouter.ai requests, USD
9.92/10 untouched, every model step "not run" by design. No git
operations.

## Orchestrator: live full flow PASSES (2026-10-22)

- `web/e2e/full-flow.mjs` 30/30 (exit 0) on `deepseek/deepseek-v4.1-flash-1017` + verification `inception/mercury-decide`,
  US$0.044; evidence `~/.cache/uktub-bench/fullflow-2026-10-22-final/`. Runner: `~/.cache/uktub-bench/fullflow-2026-10-23/run.sh`
  (`RUN_NOW=1`, `FF_RUN_OUT`, `FF_MODEL`, `FF_VERIFY_MODEL`; builds worker + seam web, serves by PID, kills it).
- Harness-only fixes on the way: model filter typed the chosen id (was a hardcoded old default); `UI.showFiles`
  before file-tree/export steps (the sidebar shows one view); `goToList` no longer reloads when already on the list
  (a reload drops memory-only keys); Europe PMC + PMC S3 origins allowlisted; Stop polls for a running tool row;
  paid-model USD preflight (`FF_MIN_USD`); step 6 compares the re-imported recompile (viewer, every page, each page
  once — the viewer renders text layers only near the visible page) with step 5's `pdftotext` of the agent PDF,
  letters-only after NFKC (equal on live6/7/8 data before the script used it).

## Changes on top of the base (Phase 9i, 2026-10-22)

Sticky routing + usage accounting (web only; `src/` untouched — the child
tally in root `src/agent/section-writer.ts` already collected usage, no
change needed there).

- `src/services/agent/agentSession.ts` (new): `getOrCreateSessionId`
  (module map keyed by project, `uktub-` + random hex, no keys/PII, well
  under OpenRouter's 256-char limit), `deriveChildSessionId`
  (`<parent>:ws<seq>`), `extractTurnUsage` (`message_end` assistant
  usage), `formatUsageLine` (`tokens: 4,210 in (3,800 cached) · 312 out ·
  $0.0004`), `sumUsage`, `formatChildUsageLine`.
- `AgentPanel.tsx`: parent `new Agent({ sessionId })` — the exact
  pi-agent-core option, forwarded to every stream call and sent by pi-ai
  1.4.0 as `x-session-id` for OpenRouter models. Stable per project
  conversation across sidebar remounts. Each `message_end` usage lands on
  its transcript entry and renders as a compact `agent-usage-line`; the
  seam (still seam-builds only) exposes `__uktubAgent.usage` (per-turn
  list + totals + `cachedShare`). Session-only, never stored.
- `agentWriteSection.ts`: the child gets its own stable id per run
  (derived from the parent's via `getSessionId`), and its usage totals
  ride the `write_section` row second line. Choice: separate child id,
  not the parent's — parent and child static prefixes differ (~4K vs
  ~1.1K), so each multi-turn conversation pins its own affinity slot
  instead of sharing one.
- Harness (`e2e/full-flow.mjs`): records `verdict.usage` (turns, totals,
  `cachedShare`) from the seam.

Tests (TDD, RED first): `agentSession9i` (helpers), child session id via
the real tool + recording stream wrapper (`parent-sid-9i:ws1`, stable
across the run's calls, `ws2` next run; RED: all `undefined`), parent id
+ usage lines via the real panel + faux provider (two sends, same
non-empty id; RED: `undefined`, no lines), child usage in the row
summary (RED: row had no usage).

Verification 2026-10-22: web `tsc` clean, web jest 88 suites / 982 pass,
`pnpm run build` green with no `__uktubAgent` in prod `dist/` (only
pre-existing `/__uktub__` virtual-asset paths in the synced worker);
root `tsc --noEmit`, `typecheck:browser` clean, `test:browser` 71/71;
`agent-tools-9d.mjs` 13/13 on the seam build. No git operations.

Live full flow 2026-10-22 (deepseek-v4.1-flash-1017 +
inception/mercury-decide): 30/30 PASS, US$0.0675 (key 0.4162 → 0.4837;
earlier runs US$0.036–0.076, final US$0.044). Parent run-wide
20 usage lines: 40,781 in (103,680 cached) · 3,288 out. Children from
their rows: 28,305 in (121,856 cached) · 3,241 out · $0.0066. Combined
69,086 in / 225,536 cached / 6,529 out — cached reads ~3× billed input,
i.e. the sticky session serves the static prefixes from cache turn after
turn. Evidence in `hermes-web-phase9i-2026-10-22/live/` (notes dir,
outside this repo).


Orchestrator review of 9i (2026-10-22): session ids confirmed as a fixed
prefix plus random hex in a module map (no storage, no keys); web `tsc`
clean, Jest 982 pass. Two corrections: the "sticky session serves the
prefixes" reading is inferred, not measured (no run without a session id;
DeepSeek's automatic prefix cache can hit without sticky routing). And
`verdict.usage` covered only the conversation after the step-6 re-import
(reopening the project starts a new conversation), so `e2e/full-flow.mjs`
now also records `verdict.usageWriting` before step 6.
