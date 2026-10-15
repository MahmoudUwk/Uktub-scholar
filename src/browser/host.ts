/**
 * Browser worker host: the layer that actually RUNS the five tools in the
 * dedicated worker (task 2).
 *
 * RPC ops (wired by `src/browser/worker.ts`):
 * - `init({ projectId, env?, providerConfig?, fetchRoutes?, downloads?, nowIso? })`:
 *   acquire the project lock (`src/browser/lock.ts`, `ifAvailable`), boot sqlite,
 *   open the project file store, create the project root `/proj` (and its
 *   registry, idempotently — `createRegistry` re-opens and re-validates).
 * - `callTool(name, args)`: run one of the five tools
 *   (`registry`, `passages`, `search`, `verify`, `compile`) with the host-built
 *   `ToolContext` and return the result unchanged (never reformatted).
 *   A tool exception becomes a typed error envelope, not a crash.
 * - `exportProject()`: zip bytes of the file store (fflate) plus the registry
 *   DB bytes, as `{ files: [...], zip: Uint8Array, registry: Uint8Array | null }`.
 * - `close()`: drop the file-store connection and release the project lock.
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

import { zipSync } from "fflate";

import { WriteQueue } from "../core/queue.ts";
import type { ToolContext } from "../core/tools/context.ts";
import type { FetchLike, ProviderConfig } from "../core/providers/types.ts";
import type { DownloadLike } from "../core/source/download.ts";
import { paperRegistryTool, type PaperRegistryArgs } from "../core/tools/registry.ts";
import { searchPassagesTool, type SearchPassagesArgs } from "../core/tools/passages.ts";
import { searchPapersTool, type SearchPapersArgs } from "../core/tools/search.ts";
import { verifyClaimTool, type VerifyArgs } from "../core/tools/verify.ts";
import { compileDocumentTool, type CompileDocumentArgs } from "../core/tools/compile.ts";
import { createRegistry } from "../core/registry.ts";
import {
  buildCannedDownload,
  buildCannedFetch,
  type CannedDownload,
  type CannedRoute,
} from "../../tests-browser/scenarios/tools.ts";
import { ensureBooted, ensurePoolInstalled, sahpoolFileBytes } from "./shims/sqlite.ts";
import {
  closeProjectFiles,
  openProjectFiles,
  readdirSync,
  readFileSync,
  statSync,
} from "./shims/fs.ts";
import { acquireProjectLock } from "./lock.ts";
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

export type ToolName = "registry" | "passages" | "search" | "verify" | "compile";

export interface ExportedProject {
  files: { path: string; size: number }[];
  zip: Uint8Array;
  registry: Uint8Array | null;
}

interface HostState {
  projectId: string;
  env: Record<string, string | undefined>;
  providerConfig?: Partial<ProviderConfig>;
  fetchRoutes?: CannedRoute[];
  downloads?: CannedDownload[];
  nowIso?: string;
  queue: WriteQueue;
  releaseLock: (() => Promise<void>) | null;
  initialized: boolean;
}

let state: HostState | null = null;

function buildContext(): ToolContext {
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
  };
}

/**
 * Acquire the project lock, boot sqlite, open the project file store, create
 * the project root and its registry (idempotent). Returns `{ alreadyOpen }`
 * when this worker already holds the project, or the typed second-tab refusal.
 */
export async function hostInit(args: InitArgs): Promise<{ ok: true; alreadyOpen?: boolean } | { ok: false; reason: string }> {
  if (typeof args.projectId !== "string" || args.projectId === "") {
    throw new TypeError("init: projectId must be a non-empty string");
  }
  if (state?.initialized === true && state.projectId === args.projectId) {
    return { ok: true, alreadyOpen: true };
  }
  if (state?.initialized === true) {
    throw new Error("init: this worker already holds another project (close it first)");
  }
  const lock = await acquireProjectLock(args.projectId, { ifAvailable: true });
  if (lock.held === false) return { ok: false, reason: "open-in-another-tab" };
  try {
    await ensureBooted();
    // The pool install may have failed at boot (a live second worker); now
    // that this worker holds the lock, retry it before any open.
    await ensurePoolInstalled();
    openProjectFiles(PROJECT_ROOT);
    // Idempotent: re-opens and re-validates an existing registry, creates a fresh one.
    createRegistry(PROJECT_ROOT).close();
  } catch (err) {
    await lock.release();
    throw err;
  }
  state = {
    projectId: args.projectId,
    env: args.env ?? {},
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

/** Run one tool call; refusals and structured results pass through unchanged. */
export async function hostCallTool(name: ToolName, toolArgs: Record<string, unknown>): Promise<unknown> {
  const ctx = buildContext();
  try {
    switch (name) {
      case "registry":
        return await paperRegistryTool(ctx, toolArgs as unknown as PaperRegistryArgs);
      case "passages":
        return await searchPassagesTool(ctx, toolArgs as unknown as SearchPassagesArgs);
      case "search":
        return await searchPapersTool(ctx, toolArgs as unknown as SearchPapersArgs);
      case "verify":
        return await verifyClaimTool(ctx, toolArgs as unknown as VerifyArgs);
      case "compile":
        return await compileDocumentTool(ctx, toolArgs as unknown as CompileDocumentArgs);
      default:
        throw new Error(`unknown tool: ${String(name)} (registry | passages | search | verify | compile)`);
    }
  } catch (err) {
    // A tool exception becomes a typed error envelope, never a worker crash.
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `tool ${String(name)} failed: ${message}` }],
      structuredContent: null,
      details: { thrown: true, tool: String(name), message },
    };
  }
}

/** Zip the visible file store (fflate) plus the standalone registry bytes. */
export async function hostExportProject(): Promise<ExportedProject> {
  if (state?.initialized !== true) throw new Error("exportProject: host is not initialized (call init first)");
  const files: { path: string; size: number }[] = [];
  const zipInput: Record<string, Uint8Array> = {};
  const walk = (dir: string): void => {
    const names = readdirSync(dir) as string[];
    for (const name of names) {
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

/** Drop the file-store connection and release the project lock. */
export async function hostClose(): Promise<{ ok: true }> {
  closeProjectFiles();
  const release = state?.releaseLock;
  state = null;
  if (release !== null && release !== undefined) await release();
  return { ok: true };
}

/** Test seam: read a bundled asset through `readFileSync` (task 1 proof). */
export function hostReadAsset(virtualPath: string): string {
  return readFileSync(virtualPath, "utf8") as unknown as string;
}
