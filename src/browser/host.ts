/**
 * Browser worker host: the layer that actually RUNS the five tools in the
 * dedicated worker (task 2).
 *
 * RPC ops (wired by `src/browser/worker.ts`):
 * - `init({ projectId, env?, providerConfig?, fetchRoutes?, downloads?, nowIso? })`:
 *   validate `projectId`, acquire the project lock (`src/browser/lock.ts`,
 *   `ifAvailable`), install the project's own sahpool pool (OPFS directory
 *   `uktub/projects/<projectId>/`, so projects are invisible to each other),
 *   open the project file store, create the project root `/proj` (and its
 *   registry, idempotently — `createRegistry` re-opens and re-validates).
 *   The open project still appears at `/proj`: every path below is unchanged.
 * - `callTool(name, args)`: run one of the five tools
 *   (`registry`, `passages`, `search`, `verify`, `compile`) with the host-built
 *   `ToolContext` and return the result unchanged (never reformatted).
 *   A tool exception becomes a typed error envelope, not a crash.
 * - `exportProject()`: zip bytes of the file store (fflate) plus the registry
 *   DB bytes, as `{ files: [...], zip: Uint8Array, registry: Uint8Array | null }`.
 * - `deleteProjectStorage({ projectId })`: destroy one project's OPFS
 *   directory (its pool, registry and files). Refused while that project is
 *   open in this worker or locked by another tab.
 * - `close()`: drop the file-store connection, pause the project's pool
 *   (releases its SAHs so a fresh worker can open the project), and release
 *   the project lock.
 * - `compilePrepare({ entry? })` / `compileFinish({ entry, engineLabel,
 *   code, timedOut, log, pdf? })`: the agent-compile prologue/epilogue —
 *   core entry resolution plus the engine-neutral finish over the page-run
 *   BusyTeX result (same result shape as the Node tool).
 * - `agentSurface()`: `{ rules, tools, keyNames }` for the web agent panel
 *   (all MCP definitions, including `compile` since Phase 7 — the worker
 *   owns its entry resolution and finish, the page the BusyTeX run).
 * - `setEnv({ env })`: replace the env later tool calls see (keys stay in
 *   worker memory only, never echoed in any result, error or progress).
 *
 * The `ToolContext` is built from: root `/proj`; a `fetch` (default
 * `createBrowserFetch()` over the worker's fetch; tests inject a canned one by
 * passing serializable `fetchRoutes` — the payloads cross the postMessage
 * boundary as data); `env` from `init` (provider keys live in memory only,
 * never written to a file); `now` (fixed `nowIso` in tests); the core's own
 * `WriteQueue`; `download` (`createBrowserDownloader()`, or a canned
 * transport from `downloads`); no `signal` (cancellation is a later seam).
 *
 * Refusals and structured results come back unchanged. `callTool` before
 * `init` still runs the tool against `/proj` with an unopened store, so the
 * core's own REGISTRY_NOT_INITIALIZED refusal (with the browser `cliCommand`
 * wording) is what the caller sees.
 */

import { unzipSync, zipSync } from "fflate";

import { WriteQueue } from "../core/queue.ts";
import { AGENT_RULES } from "../core/agent-rules.ts";
import { writingWorkflowSection } from "../agent/workflow.ts";
import { createCompletionGate, type CompletionGate } from "../agent/completion-gate.ts";
import { minConfidenceFromEnv } from "../core/verify/claim.ts";
import { TOOL_DEFINITIONS } from "../core/tools/definitions.ts";
import { RESEARCH_SERVICE_KEY_NAMES } from "../core/tools/doctor.ts";
import { VERIFICATION_ENGINES } from "../core/verify/engines.ts";
import type { ToolContext } from "../core/tools/context.ts";
import type { FetchLike, ProviderConfig } from "../core/providers/types.ts";
import type { DownloadLike } from "../core/source/download.ts";
import { paperRegistryTool, type PaperRegistryArgs } from "../core/tools/registry.ts";
import { searchPassagesTool, type SearchPassagesArgs } from "../core/tools/passages.ts";
import { searchPapersTool, type SearchPapersArgs } from "../core/tools/search.ts";
import { verifyClaimTool, type VerifyArgs } from "../core/tools/verify.ts";
import { compileDocumentTool, compileToolResult, type CompileDocumentArgs } from "../core/tools/compile.ts";
import { refusalResult } from "../core/tools/context.ts";
import { renderRefusal, type RefusalCode } from "../core/refusals.ts";
import { BROWSER_REFUSAL_NEXT } from "./refusal-next.ts";
import { resolveEntry, timeoutMsFromEnv } from "../core/compile/run.ts";
import { DEFAULT_COMPILE_TIMEOUT_MS, finishCompile } from "../core/compile/finish.ts";
import { parseTexLog } from "../core/compile/tex-log.ts";
import { doctorTool, type DoctorArgs } from "../core/tools/doctor.ts";
import { runProvenance, type ProvenanceOutcome } from "../core/provenance/run.ts";
import { MAX_SOURCE_BYTES } from "../core/source/extract.ts";
import { createRegistry } from "../core/registry.ts";
import {
  buildCannedDownload,
  buildCannedFetch,
  type CannedDownload,
  type CannedRoute,
} from "../../tests-browser/scenarios/tools.ts";
import { ensureBooted, ensurePoolInstalled, pauseActivePool, removeProjectPool, sahpoolFileBytes, sahpoolImportDb, sahpoolUnlink } from "./shims/sqlite.ts";
import {
  chmodSync,
  closeProjectFiles,
  existsSync,
  mkdirSync,
  openProjectFiles,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "./shims/fs.ts";
import { dirname, resolve as posixResolve } from "./shims/path.ts";
import { acquireProjectLock } from "./lock.ts";
import { poolDirForProject, validateProjectId, vfsNameForProject } from "./projects.ts";
import { createBrowserFetch } from "./provider-fetch.ts";
import { createBrowserDownloader } from "./download.ts";

/** Project root inside the worker's virtual filesystem. */
export const PROJECT_ROOT = "/proj";

export interface InitArgs {
  projectId: string;
  env?: Record<string, string | undefined>;
  providerConfig?: Partial<ProviderConfig>;
  fetchRoutes?: CannedRoute[];
  downloads?: CannedDownload[];
  /** Test seam: fix the injected clock. */
  nowIso?: string;
}

export type ToolName = "registry" | "passages" | "papers" | "search" | "verify" | "compile" | "doctor";

export interface ExportedProject {
  files: { path: string; size: number }[];
  zip: Uint8Array;
  registry: Uint8Array | null;
}

interface HostState {
  projectId: string;
  env: Record<string, string | undefined>;
  gate: CompletionGate;
  providerConfig?: Partial<ProviderConfig>;
  fetchRoutes?: CannedRoute[];
  downloads?: CannedDownload[];
  nowIso?: string;
  queue: WriteQueue;
  releaseLock: (() => Promise<void>) | null;
  initialized: boolean;
}

let state: HostState | null = null;

/** One running tool call: its abort handle and the promise that settles with its reply. */
interface RunningCall {
  ac: AbortController;
  done: Promise<unknown>;
}
/** Every running call, with or without a callId: close aborts and awaits all of them. */
const running = new Set<RunningCall>();
/** The calls cancelTool can reach, keyed by RPC callId. */
const byCallId = new Map<string, RunningCall>();
/** Set for the duration of hostClose: new calls and imports are refused. */
let closing = false;

function buildContext(signal?: AbortSignal): ToolContext {
  const s = state;
  const env = s?.env ?? {};
  const nowIso = s?.nowIso;
  const now = nowIso !== undefined ? () => new Date(nowIso) : () => new Date();
  const fetch: FetchLike =
    s?.fetchRoutes !== undefined ? buildCannedFetch(s.fetchRoutes) : createBrowserFetch();
  const download: DownloadLike =
    s?.downloads !== undefined ? buildCannedDownload(s.downloads) : createBrowserDownloader();
  return {
    root: PROJECT_ROOT,
    fetch,
    env,
    now,
    queue: s?.queue ?? new WriteQueue(),
    ...(s?.providerConfig !== undefined ? { providerConfig: s.providerConfig } : {}),
    download,
    ...(signal !== undefined ? { signal } : {}),
    // The browser host's own `next` per code (Phase 9a); the core tools below
    // render with the Node table, so the boundary re-renders with this table.
    refusalNext: BROWSER_REFUSAL_NEXT,
  };
}

/**
 * Validate the id, acquire the project lock, install the project's own pool,
 * open the project file store, create the project root and its registry
 * (idempotent). Returns `{ alreadyOpen }` when this worker already holds the
 * project, or the typed second-tab refusal. The lock is taken BEFORE any
 * pool install, so a second tab on the same project is refused without ever
 * touching the shared pool directory.
 */
export async function hostInit(args: InitArgs): Promise<{ ok: true; alreadyOpen?: boolean } | { ok: false; reason: string }> {
  const projectId = validateProjectId(args?.projectId);
  if (state?.initialized === true && state.projectId === projectId) {
    return { ok: true, alreadyOpen: true };
  }
  if (state?.initialized === true) {
    throw new Error("init: this worker already holds another project (close it first)");
  }
  const lock = await acquireProjectLock(projectId, { ifAvailable: true });
  if (lock.held === false) return { ok: false, reason: "open-in-another-tab" };
  try {
    await ensureBooted();
    await ensurePoolInstalled({ poolDirectory: poolDirForProject(projectId), vfsName: vfsNameForProject(projectId) });
    openProjectFiles(PROJECT_ROOT);
    // Idempotent: re-opens and re-validates an existing registry, creates a fresh one.
    createRegistry(PROJECT_ROOT).close();
  } catch (err) {
    await lock.release();
    throw err;
  }
  state = {
    projectId: projectId,
    env: args.env ?? {},
    gate: createCompletionGate(),
    providerConfig: args.providerConfig,
    fetchRoutes: args.fetchRoutes,
    downloads: args.downloads,
    nowIso: args.nowIso,
    queue: new WriteQueue(),
    releaseLock: () => lock.release(),
    initialized: true,
  };
  return { ok: true };
}

/** Typed tool error envelope: refusals and thrown exceptions share this shape. */
function toolErrorEnvelope(name: string, message: string): unknown {
  return {
    content: [{ type: "text", text: `tool ${name} failed: ${message}` }],
    structuredContent: null,
    details: { thrown: true, tool: name, message },
  };
}

/**
 * Phase 9a boundary: the core tools render refusals with the Node table, so
 * a refusal whose code has a browser `next` is re-rendered with it before it
 * crosses to the page. Code, message and structured details stay the core's;
 * only the rendered `Next:` hint changes, and only for overridden codes.
 */
function applyBrowserRefusalNext(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return result;
  const r = result as {
    content?: { type: string; text: string }[];
    structuredContent?: unknown;
    details?: { refused?: { code: RefusalCode; message: string } };
  };
  const refused = r.details?.refused;
  if (refused === undefined || typeof refused.code !== "string" || typeof refused.message !== "string") return result;
  if (BROWSER_REFUSAL_NEXT[refused.code] === undefined) return result;
  if (!Array.isArray(r.content) || r.content.length === 0) return result;
  return {
    ...r,
    content: [{ type: "text", text: renderRefusal(refused, BROWSER_REFUSAL_NEXT) }],
  };
}

async function runTool(name: ToolName, toolArgs: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  try {
    switch (name) {
      case "registry":
        return await paperRegistryTool(ctx, toolArgs as unknown as PaperRegistryArgs);
      case "passages":
        return await searchPassagesTool(ctx, toolArgs as unknown as SearchPassagesArgs);
      case "papers":
      case "search":
        return await searchPapersTool(ctx, toolArgs as unknown as SearchPapersArgs);
      case "verify":
        return await verifyClaimTool(ctx, toolArgs as unknown as VerifyArgs);
      case "compile":
        return await compileDocumentTool(ctx, toolArgs as unknown as CompileDocumentArgs);
      case "doctor":
        return await doctorTool(ctx, toolArgs as unknown as DoctorArgs);
      default:
        throw new Error(`unknown tool: ${String(name)} (registry | passages | papers | search | verify | compile | doctor)`);
    }
  } catch (err) {
    // A tool exception becomes a typed error envelope, never a worker crash.
    return toolErrorEnvelope(String(name), err instanceof Error ? err.message : String(err));
  }
}

/** Run one tool call; refusals and structured results pass through unchanged. */
export async function hostCallTool(name: ToolName, toolArgs: Record<string, unknown>, callId?: string): Promise<unknown> {
  if (closing) return toolErrorEnvelope(String(name), "refused: the host is closing");
  const id = callId === undefined || callId === "" ? undefined : callId;
  if (id !== undefined && byCallId.has(id)) {
    return toolErrorEnvelope(String(name), `refused: callId ${id} is already in flight`);
  }
  const ac = new AbortController();
  const call: RunningCall = { ac, done: runTool(name, toolArgs, buildContext(ac.signal)).then(applyBrowserRefusalNext) };
  running.add(call);
  if (id !== undefined) byCallId.set(id, call);
  try {
    return await call.done;
  } finally {
    running.delete(call);
    // Delete only this call's own entry: a later call may not reuse the callId while this one runs.
    if (id !== undefined && byCallId.get(id) === call) byCallId.delete(id);
  }
}

/** Cancel an in-flight tool call by its RPC callId. */
export function hostCancelTool(callId: string): { cancelled: boolean } {
  const call = byCallId.get(callId);
  if (call === undefined) return { cancelled: false };
  call.ac.abort();
  return { cancelled: true };
}

/**
 * Agent surface for the web panel: the shared system-prompt rules, the
 * document-writing workflow section (same skill file Pi ships, bundled as a
 * read-only asset), the agent-callable tools (`{ name, description,
 * inputSchema }`, JSON-cloned so the panel can pass them straight to
 * pi-agent-core), and the research-service key names the panel's settings
 * section lists (hosted verify key first).
 *
 * `compile` is included since Phase 7: the worker runs entry resolution
 * (`compilePrepare`) and the engine-neutral finish (`compileFinish`) while
 * the page hosts the BusyTeX run in between. Keys stay in worker memory
 * only and are never echoed in any result, error or progress payload.
 */
export function hostAgentSurface(): {
  rules: readonly string[];
  /** The document-writing section of the shipped skill text (Pi appends the same section last). */
  workflow: string | null;
  tools: { name: string; description: string; inputSchema: unknown }[];
  keyNames: string[];
  /** Single source for the agent-compile budget (core client policy): the page must not copy the number. */
  compileTimeoutMs: number;
  /** Verification engines the panel may offer, in preference order (default first). */
  verificationEngines: string[];
} {
  const tools = TOOL_DEFINITIONS.map((t) => ({
    name: t.name as string,
    description: t.description as string,
    inputSchema: JSON.parse(JSON.stringify(t.inputSchema)) as unknown,
  }));
  return {
    rules: AGENT_RULES,
    workflow: readBundledWorkflow(),
    tools,
    keyNames: [...RESEARCH_SERVICE_KEY_NAMES],
    compileTimeoutMs: DEFAULT_COMPILE_TIMEOUT_MS,
    verificationEngines: [...BROWSER_VERIFICATION_ENGINES],
  };
}

/**
 * Phase 8b verification engines that can run in a browser worker, Phase 9f
 * narrowed to `["openrouter"]`: `hosted` is CORS-blocked in pages
 * (measured 2026-10-22 from real Chromium: OPTIONS 405, no ACAO on the
 * 401, "Failed to fetch" for preflighted and simple POSTs), so no page
 * can reach it. `eos` spawns a Python child process, `eos-onnx` needs
 * local model files plus a native runtime, and `llama-cpp` points at a
 * loopback server the browser cannot reach — none can run here.
 * Membership is derived from core (an engine core removes disappears here
 * too; an unknown name can never be offered). `hosted` returns when its
 * server allows CORS (re-measure with a real Chromium fetch, not a stub).
 */
export const BROWSER_VERIFICATION_ENGINES: string[] = ["openrouter"].filter((e) =>
  (VERIFICATION_ENGINES as readonly string[]).includes(e),
);

/** Virtual path of the bundled skill text (see `tests-browser/assets-plugin.mjs`; same file Pi reads from disk). */
export const SKILL_VIRTUAL_PATH = "/__uktub__/skills/uktub-research/SKILL.md";

/** The document-writing section of the bundled skill text; null when absent (the on-demand skill still exists). */
function readBundledWorkflow(): string | null {
  try {
    return writingWorkflowSection(readFileSync(SKILL_VIRTUAL_PATH, "utf8") as unknown as string);
  } catch {
    return null;
  }
}

/**
 * Phase 8a pre-completion gate (always on in the browser; no env switch):
 * one `createCompletionGate()` per open project, driven by the page adapter.
 * `gateStartUserPrompt` starts a new budget; `gateToolEnded` records one
 * completed tool call; `gateSettle` runs `shouldAudit("completed")`, then the
 * core `runProvenance` on `/proj` exactly as the Pi adapter does, then
 * `followUp` — byte-identical texts to Pi. Audit errors fail open (null),
 * like Pi.
 */
export function hostGateStartUserPrompt(): { ok: true } {
  if (state?.initialized !== true) throw new Error("gateStartUserPrompt: host is not initialized (call init first)");
  state.gate.startUserPrompt();
  return { ok: true };
}

export function hostGateToolEnded(args: { toolName: string; args?: unknown; isError?: boolean }): { ok: true } {
  if (state?.initialized !== true) throw new Error("gateToolEnded: host is not initialized (call init first)");
  state.gate.toolEnded({ toolName: args.toolName, args: args.args, isError: args.isError === true });
  return { ok: true };
}

export function hostGateSettle(): { text: string | null } {
  if (state?.initialized !== true) throw new Error("gateSettle: host is not initialized (call init first)");
  if (!state.gate.shouldAudit("completed")) return { text: null };
  let result: ReturnType<typeof runProvenance>;
  try {
    const ctx = buildContext();
    result = runProvenance({
      root: ctx.root,
      now: ctx.now,
      env: ctx.env,
      minConfidence: minConfidenceFromEnv(ctx.env ?? {}),
    });
  } catch {
    return { text: null };
  }
  try {
    return { text: state.gate.followUp(result) };
  } catch {
    return { text: null };
  }
}

/**
 * Replace the env later tool calls see (research-service keys live in worker
 * memory only; they are never written to a file nor echoed in results).
 * Requires an open project: without `init` there is no project for tools to run against.
 */
export function hostSetEnv(args: { env?: Record<string, string | undefined> }): { ok: true } {
  if (state?.initialized !== true) throw new Error("setEnv: host is not initialized (call init first)");
  state.env = { ...(args.env ?? {}) };
  return { ok: true };
}

/** Client policy: cap on the BusyTeX log the worker parses (chars). Labelled; not a provider or OS limit. The page keeps the full log; the worker flags the cut with `outputOverflow` so the agent is told the streams are incomplete. */
export const BROWSER_COMPILE_LOG_CAP_CHARS = 1_000_000;

/**
 * Phase 7 agent-compile prologue: resolve the project-relative entry with
 * the core `resolveEntry` — same defaults and refusals as Node (notably
 * `COMPILE_NO_ENTRY`). The page compiles this entry with BusyTeX, then
 * closes the loop with `compileFinish`.
 */
export function hostCompilePrepare(args: { entry?: string } = {}): { ok: true; rel: string } | { ok: false; code: "COMPILE_NO_ENTRY"; message: string } {
  if (state?.initialized !== true) throw new Error("compilePrepare: host is not initialized (call init first)");
  const entry = resolveEntry(PROJECT_ROOT, args.entry);
  if (!entry.ok) return { ok: false, code: "COMPILE_NO_ENTRY", message: entry.message };
  return { ok: true, rel: entry.rel };
}

/**
 * Phase 7 agent-compile epilogue: parse the BusyTeX log with the core
 * TeX-log parser and finish through the engine-neutral core step — the same
 * result shape the Node/Tectonic tool returns (entry resolution, `build/`
 * output, errors-first cap, synthetic error, provenance block on success).
 * `engineLabel` is the full engine label (`busytex 1.4.1`); `pdf` carries
 * the engine-returned bytes (`null` when the engine returned nothing, so a
 * 0-exit failure still reports `errors`). Runs inside the project write
 * fence (KTD5): `build/` is a project write.
 */
export async function hostCompileFinish(args: {
  entry: string;
  engineLabel: string;
  code: number;
  timedOut: boolean;
  log: string;
  pdf?: Uint8Array | null;
}): Promise<unknown> {
  if (state?.initialized !== true) throw new Error("compileFinish: host is not initialized (call init first)");
  const entry = resolveEntry(PROJECT_ROOT, args.entry);
  if (!entry.ok) return refusalResult({ code: "COMPILE_NO_ENTRY", message: entry.message }, BROWSER_REFUSAL_NEXT);
  const nounSplit = args.engineLabel.indexOf(" ");
  const engineNoun = nounSplit === -1 ? args.engineLabel : args.engineLabel.slice(0, nounSplit);
  const engineVersion = nounSplit === -1 ? args.engineLabel : args.engineLabel.slice(nounSplit + 1);
  let log = args.log;
  let outputOverflow = false;
  if (log.length > BROWSER_COMPILE_LOG_CAP_CHARS) {
    // Client policy cap: parse the head (file-stack context survives) and
    // say the streams are incomplete instead of reporting a bare exit code.
    log = log.slice(0, BROWSER_COMPILE_LOG_CAP_CHARS);
    outputOverflow = true;
  }
  const parsed = parseTexLog(log);
  const outcome = await state.queue.runExclusive(() =>
    finishCompile({
      root: PROJECT_ROOT,
      entryRel: entry.rel,
      engineNoun,
      engineVersion,
      code: args.code,
      timedOut: args.timedOut,
      timeoutMs: timeoutMsFromEnv(state?.env ?? {}),
      outputCapBytes: BROWSER_COMPILE_LOG_CAP_CHARS,
      ...(outputOverflow ? { outputOverflow: true as const } : {}),
      pdf: args.pdf ?? null,
      diagnostics: parsed.diagnostics,
      truncated: parsed.truncated || outputOverflow,
    }),
  );
  if (outcome.kind === "refusal") return refusalResult({ code: outcome.code, message: outcome.message }, BROWSER_REFUSAL_NEXT);
  return compileToolResult(buildContext(), outcome, engineNoun);
}

/** Run the deterministic manuscript provenance audit in the browser worker. */
export function hostRunProvenance(args: { entry?: string } = {}): ProvenanceOutcome {
  if (state?.initialized !== true) throw new Error("provenance: host is not initialized (call init first)");
  const ctx = buildContext();
  return runProvenance({
    root: ctx.root,
    ...(args.entry !== undefined ? { entry: args.entry } : {}),
    now: ctx.now,
    env: ctx.env,
  });
}

function resolveUserProjectPath(rel: string, opts: { allowBibRead?: boolean } = {}): { abs: string; cleanRel: string } {
  if (typeof rel !== "string" || rel.trim() === "" || rel.includes("\0") || rel.split(/[\\/]/).includes("..")) {
    throw new Error(`invalid or escaping project path: ${JSON.stringify(rel)}`);
  }
  const abs = posixResolve(PROJECT_ROOT, rel);
  if (abs === PROJECT_ROOT || !abs.startsWith(`${PROJECT_ROOT}/`)) {
    throw new Error(`path outside project root: ${rel}`);
  }
  const cleanRel = abs.slice(PROJECT_ROOT.length + 1);
  const segments = cleanRel.split("/");
  if (segments.includes(".registry")) {
    throw new Error(`refused: .registry/ is tool-owned (${cleanRel})`);
  }
  if (segments.includes(".git")) {
    throw new Error(`refused: .git/ is protected (${cleanRel})`);
  }
  if (cleanRel.startsWith("refs/references.bib/") || (!opts.allowBibRead && cleanRel === "refs/references.bib")) {
    throw new Error("refused: refs/references.bib is tool-owned (use registry sync_bibliography)");
  }
  return { abs, cleanRel };
}

/** Write a researcher-owned file (PDF, TEI, .tex, results CSV/JSON) into `/proj`. */
export function hostWriteFile(args: {
  rel: string;
  base64?: string;
  text?: string;
  bytes?: Uint8Array;
}): { path: string; bytes: number } {
  if (state?.initialized !== true) throw new Error("writeFile: host is not initialized (call init first)");
  const { abs, cleanRel } = resolveUserProjectPath(args.rel);
  let data: Uint8Array;
  if (args.bytes instanceof Uint8Array) {
    data = args.bytes;
  } else if (typeof args.text === "string") {
    data = new TextEncoder().encode(args.text);
  } else if (typeof args.base64 === "string") {
    const bin = atob(args.base64);
    data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  } else {
    throw new Error("writeFile: supply one of text, base64, or bytes");
  }
  if (data.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(`writeFile: file exceeds MAX_SOURCE_BYTES (${MAX_SOURCE_BYTES} bytes)`);
  }
  const parent = dirname(abs);
  if (parent !== PROJECT_ROOT) mkdirSync(parent, { recursive: true });
  writeFileSync(abs, data);
  return { path: cleanRel, bytes: data.length };
}

/** Read a project file (including `refs/references.bib` read-only, never `.registry/*`, capped at `MAX_SOURCE_BYTES`). */
export function hostReadFile(args: {
  rel: string;
  encoding?: "utf8" | "base64";
}): { path: string; bytes: number; text?: string; base64?: string } {
  if (state?.initialized !== true) throw new Error("readFile: host is not initialized (call init first)");
  const { abs, cleanRel } = resolveUserProjectPath(args.rel, { allowBibRead: true });
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`readFile: not a regular file (${cleanRel})`);
  if (st.size > MAX_SOURCE_BYTES) {
    throw new Error(`readFile: file exceeds MAX_SOURCE_BYTES (${MAX_SOURCE_BYTES} bytes)`);
  }
  const raw = new Uint8Array(readFileSync(abs) as unknown as Uint8Array);
  const enc = args.encoding ?? "utf8";
  if (enc === "base64") {
    let bin = "";
    for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]!);
    return { path: cleanRel, bytes: raw.length, base64: btoa(bin) };
  }
  return { path: cleanRel, bytes: raw.length, text: new TextDecoder("utf-8").decode(raw) };
}

/** List visible project files (excluding `.registry/` and `.git/`). */
export function hostListFiles(): { files: { path: string; size: number }[] } {
  if (state?.initialized !== true) throw new Error("listFiles: host is not initialized (call init first)");
  const files: { path: string; size: number }[] = [];
  const walk = (dir: string): void => {
    const names = readdirSync(dir) as string[];
    for (const name of names) {
      if (name === ".registry" || name === ".git") continue;
      const abs = dir === "/" ? `/${name}` : `${dir}/${name}`;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) files.push({ path: abs.slice(PROJECT_ROOT.length + 1), size: st.size });
    }
  };
  walk(PROJECT_ROOT);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files };
}

/** Delete a researcher-owned file in `/proj` (never `.registry/*` or `refs/references.bib`). */
export function hostDeleteFile(args: { rel: string }): { deleted: boolean } {
  if (state?.initialized !== true) throw new Error("deleteFile: host is not initialized (call init first)");
  const { abs, cleanRel } = resolveUserProjectPath(args.rel);
  if (!existsSync(abs)) return { deleted: false };
  if (statSync(abs).isDirectory()) throw new Error(`refused: cannot delete directory: ${cleanRel}`);
  rmSync(abs);
  return { deleted: true };
}

/** Zip the visible file store (fflate) plus the standalone registry bytes. */
export async function hostExportProject(): Promise<ExportedProject> {
  if (state?.initialized !== true) throw new Error("exportProject: host is not initialized (call init first)");
  const files: { path: string; size: number }[] = [];
  const zipInput: Record<string, Uint8Array> = {};
  const walk = (dir: string): void => {
    const names = readdirSync(dir) as string[];
    for (const name of names) {
      if (name === ".git") continue;
      const abs = dir === "/" ? `/${name}` : `${dir}/${name}`;
      // The registry database is exported separately as `registry` bytes
      // (it is not reachable through fs by design); everything else zips.
      if (abs === `${PROJECT_ROOT}/.registry/registry.db`) continue;
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
      } else if (st.isFile()) {
        const bytes = readFileSync(abs) as unknown as Uint8Array;
        const copy = new Uint8Array(bytes);
        files.push({ path: abs.slice(PROJECT_ROOT.length + 1), size: copy.length });
        zipInput[abs.slice(PROJECT_ROOT.length + 1)] = copy;
      }
    }
  };
  walk(PROJECT_ROOT);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const zip = zipSync(zipInput);
  const registry = sahpoolFileBytes(`${PROJECT_ROOT}/.registry/registry.db`);
  return { files, zip: new Uint8Array(zip), registry: registry === null ? null : new Uint8Array(registry) };
}

export interface ImportSourceArgs {
  id: string;
  filename: string;
  base64?: string;
  text?: string;
  bytes?: Uint8Array | number[];
  format?: "pdf" | "tei" | "auto";
}

/**
 * Stage a researcher-supplied PDF or TEI XML under `/proj/papers/<filename>`
 * and attach it to the registered paper `id` in one guarded step. If `attach`
 * is refused or fails, any newly staged file is removed (or the prior file is
 * restored) so no orphan file remains in `/proj/papers/`.
 */
export async function hostImportSource(args: ImportSourceArgs): Promise<unknown> {
  if (state?.initialized !== true) throw new Error("importSource: host is not initialized (call init first)");
  if (typeof args.id !== "string" || args.id.trim() === "") {
    throw new Error("refused: importSource requires a non-empty citekey or DOI id");
  }
  const name = typeof args.filename === "string" ? args.filename.trim() : "";
  if (
    name === "" ||
    !/^[A-Za-z0-9._-]+$/.test(name) ||
    name === "." ||
    name === ".." ||
    !/\.(?:pdf|tei\.xml|xml)$/i.test(name)
  ) {
    throw new Error(`refused: invalid source filename "${args.filename}" (expected safe basename ending in .pdf, .tei.xml, or .xml)`);
  }
  const rel = `papers/${name}`;
  const { abs } = resolveUserProjectPath(rel);
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    throw new Error(`refused: source path "${rel}" is a directory`);
  }
  const existedBefore = existsSync(abs);
  const previousBytes = existedBefore ? new Uint8Array(readFileSync(abs) as unknown as Uint8Array) : null;
  hostWriteFile({
    rel,
    ...(args.base64 !== undefined ? { base64: args.base64 } : {}),
    ...(args.text !== undefined ? { text: args.text } : {}),
    ...(args.bytes !== undefined
      ? { bytes: args.bytes instanceof Uint8Array ? args.bytes : Uint8Array.from(args.bytes) }
      : {}),
  });
  const res = (await hostCallTool("registry", {
    action: "attach_source",
    attachments: [{ handle: args.id.trim(), path: rel }],
  })) as {
    structuredContent?: { outcomes?: { status?: string; refusalCode?: string | null; source?: { status?: string; chunks?: number } }[] };
    details?: { refused?: unknown; thrown?: boolean };
    [k: string]: unknown;
  };
  const outcome = res?.structuredContent?.outcomes?.[0];
  if (outcome?.status !== "attached" || res?.details?.refused !== undefined || res?.details?.thrown === true) {
    if (previousBytes !== null) {
      writeFileSync(abs, previousBytes);
    } else if (existsSync(abs)) {
      rmSync(abs);
    }
    return { ...res, stagedPath: null, outcome: outcome ?? null };
  }
  return { ...res, stagedPath: rel, outcome };
}

export interface ImportProjectArgs {
  zip?: Uint8Array | number[] | Record<string, number> | string;
  registry?: Uint8Array | number[] | Record<string, number> | string | null;
  replace?: boolean;
}

function coerceBinaryInput(input: Uint8Array | number[] | Record<string, number> | string, label: string): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (Array.isArray(input)) return Uint8Array.from(input);
  if (typeof input === "string") return Uint8Array.from(atob(input), (c) => c.charCodeAt(0));
  if (input !== null && typeof input === "object") return Uint8Array.from(Object.values(input));
  throw new Error(`refused: invalid ${label} byte payload`);
}

/**
 * Restore an exported project (`.zip` of visible files + `.registry/registry.db`
 * SQLite bytes) into `/proj`. The zip entry paths and sizes are validated before
 * anything is written, so a refused archive changes nothing. The registry is
 * imported and its SQLite schema verified; if that check fails, the previous
 * `.registry/registry.db` bytes are restored (the only rollback). The registry
 * commit is not undone by later steps: `replace` deletes the existing files and
 * the staged files are then written one by one, so a failure in that step leaves
 * earlier writes and the imported registry in place.
 */
export async function hostImportProject(
  args: ImportProjectArgs,
): Promise<{ ok: true; filesImported: number; registryImported: boolean }> {
  if (state?.initialized !== true) throw new Error("importProject: host is not initialized (call init first)");
  if (args.zip === undefined && (args.registry === undefined || args.registry === null)) {
    throw new Error("refused: importProject requires at least one of zip or registry");
  }
  if (closing) throw new Error("refused: the host is closing");
  // No tool call can start between this check and the import: with no call running, only
  // synchronous queue sections can be ahead of it, so no worker message is handled meanwhile.
  if (running.size > 0) throw new Error("refused: cannot import project while tool calls are in flight");
  return await state.queue.runExclusive(async () => {
    const stagedFiles: { abs: string; data: Uint8Array }[] = [];
    if (args.zip !== undefined) {
      const zipBytes = coerceBinaryInput(args.zip, "zip");
      if (zipBytes.byteLength > MAX_SOURCE_BYTES) {
        throw new Error(`refused: zip archive exceeds maximum size (${zipBytes.byteLength} > ${MAX_SOURCE_BYTES})`);
      }
      let unzipped: Record<string, Uint8Array>;
      try {
        unzipped = unzipSync(zipBytes);
      } catch (err) {
        throw new Error(`refused: invalid zip archive: ${err instanceof Error ? err.message : String(err)}`);
      }
      let totalBytes = 0;
      for (const [rawRel, data] of Object.entries(unzipped)) {
        if (rawRel.endsWith("/")) continue;
        // Allow refs/references.bib from an exported project archive while still blocking .., .registry/*, .git/*.
        const { abs } = resolveUserProjectPath(rawRel, { allowBibRead: true });
        if (data.byteLength > MAX_SOURCE_BYTES) {
          throw new Error(`refused: archive entry ${rawRel} exceeds maximum size (${data.byteLength} > ${MAX_SOURCE_BYTES})`);
        }
        totalBytes += data.byteLength;
        if (totalBytes > MAX_SOURCE_BYTES) {
          throw new Error(`refused: uncompressed archive exceeds maximum size (${totalBytes} > ${MAX_SOURCE_BYTES})`);
        }
        stagedFiles.push({ abs, data });
      }
    }

    let registryImported = false;
    if (args.registry !== undefined && args.registry !== null) {
      const regBytes = coerceBinaryInput(args.registry, "registry");
      if (regBytes.byteLength < 100 || regBytes.byteLength > MAX_SOURCE_BYTES) {
        throw new Error("refused: invalid SQLite registry database size");
      }
      const header = new TextDecoder("ascii").decode(regBytes.subarray(0, 15));
      if (header !== "SQLite format 3") {
        throw new Error("refused: registry payload does not have a valid SQLite format 3 header");
      }
      const regPath = `${PROJECT_ROOT}/.registry/registry.db`;
      const prevBytes = sahpoolFileBytes(regPath);
      try {
        await sahpoolImportDb(regPath, regBytes);
        createRegistry(PROJECT_ROOT).close();
      } catch (err) {
        if (prevBytes !== null) {
          await sahpoolImportDb(regPath, prevBytes);
        } else {
          sahpoolUnlink(regPath);
        }
        throw new Error(`refused: incompatible or corrupt SQLite registry: ${err instanceof Error ? err.message : String(err)}`);
      }
      registryImported = true;
    }

    if (args.replace === true) {
      const existing = hostListFiles().files;
      for (const f of existing) {
        const abs = `${PROJECT_ROOT}/${f.path}`;
        if (existsSync(abs)) {
          if (abs === `${PROJECT_ROOT}/refs/references.bib`) {
            chmodSync(abs, 0o644);
          }
          rmSync(abs);
        }
      }
    }

    for (const { abs, data } of stagedFiles) {
      mkdirSync(dirname(abs), { recursive: true });
      const isBib = abs === `${PROJECT_ROOT}/refs/references.bib`;
      if (isBib && existsSync(abs)) chmodSync(abs, 0o644);
      writeFileSync(abs, data);
      if (isBib) chmodSync(abs, 0o444);
    }
    return { ok: true, filesImported: stagedFiles.length, registryImported };
  });
}

/**
 * Destroy one project's storage: its sahpool pool, registry and files
 * (its OPFS directory). Refused while that project is open in this worker
 * or locked by another tab. Never touches the open file store: this worker
 * holds no connections on the deleted pool (opening it would have set
 * `state`). Nothing has been released, so there is no legacy data to
 * migrate — the pre-4b single-root pool is simply never installed.
 */
export async function hostDeleteProjectStorage(args: { projectId: string }): Promise<{ deleted: boolean }> {
  const projectId = validateProjectId(args?.projectId);
  if (state?.initialized === true && state.projectId === projectId) {
    throw new Error("refused: cannot delete storage of the project open in this worker (close it first)");
  }
  if (closing) throw new Error("refused: the host is closing");
  const lock = await acquireProjectLock(projectId, { ifAvailable: true });
  if (lock.held === false) {
    throw new Error("refused: cannot delete storage while the project is open in another tab");
  }
  try {
    const deleted = await removeProjectPool(poolDirForProject(projectId), vfsNameForProject(projectId));
    return { deleted };
  } finally {
    await lock.release();
  }
}

/**
 * Drop the file-store connection, pause the project's pool (releases its
 * SAHs without destroying data, so a fresh worker can open the project)
 * and release the project lock. Running calls
 * are aborted and awaited to settle before the store closes; queued sections
 * (an import waiting behind them) drain first. Calls and imports arriving
 * meanwhile are refused.
 */
export async function hostClose(): Promise<{ ok: true }> {
  closing = true;
  try {
    const calls = [...running];
    for (const call of calls) call.ac.abort();
    await Promise.allSettled(calls.map((call) => call.done));
    await state?.queue.runExclusive(() => undefined);
    closeProjectFiles();
    await pauseActivePool();
    const release = state?.releaseLock;
    state = null;
    if (release !== null && release !== undefined) await release();
  } finally {
    closing = false;
  }
  return { ok: true };
}

/** Test seam: read a bundled asset through `readFileSync` (task 1 proof). */
export function hostReadAsset(virtualPath: string): string {
  return readFileSync(virtualPath, "utf8") as unknown as string;
}
