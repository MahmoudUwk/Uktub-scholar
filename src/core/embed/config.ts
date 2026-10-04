/**
 * Build the configured embedder from the environment the host injected. Nothing here reads
 * `process.env`: the host passes `env` and `fetch` (core imports no globals).
 *
 *   UKTUB_EMBED_URL      base URL of an OpenAI-compatible embedding server; unset = the managed runtime if installed
 *                        (`uktub-scholar embed install`), else no vector search
 *   UKTUB_EMBED_MODEL    optional declared model name (default: whatever the server reports)
 *   UKTUB_EMBED_PROFILE  prompt profile: embeddinggemma (default) | none
 *   UKTUB_CACHE_DIR      where the managed runtime and model live (default ~/.cache/uktub-scholar)
 *
 * The identity that keys stored vectors is the served model (probed from `/v1/models`, with its size
 * and quantisation as a fingerprint) plus the profile — a server restarted with another model must not
 * be served vectors computed by the old one.
 */
import { ConfigError } from "../config.ts";
import type { FetchLike } from "../providers/types.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { EMBED_PROFILES, EmbedError, createHttpEmbedder, type EmbedProfile, type Embedder } from "./embedder.ts";
import { ensureServer, installedPaths, platformKey, readLock, type RuntimeLock } from "./runtime.ts";

/** Client policy: the identity probe of a local server answers at once or not at all. */
const PROBE_TIMEOUT_MS = 5_000;

interface Served {
  id: string;
  fingerprint: string;
}

const basename = (id: string): string => id.split("/").pop() ?? id;

/** The served model's id and fingerprint from `/v1/models`: the entry the user declared (matched by id or file name) or,
 *  without a declaration, the first one. A declared model the server does not list gets no borrowed fingerprint. */
async function probeServedModel(base: string, fetchImpl: FetchLike, declared: string | null, signal: AbortSignal | undefined): Promise<Served | null> {
  try {
    const res = await fetchImpl(`${base.replace(/\/+$/, "")}/v1/models`, {
      signal: signal === undefined ? AbortSignal.timeout(PROBE_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
    });
    if (res.status < 200 || res.status >= 300) return null;
    const entries = ((JSON.parse(await res.text()) as { data?: { id?: unknown; meta?: Record<string, unknown> }[] }).data ?? []).filter((e) => typeof e?.id === "string" && (e.id as string).length > 0);
    const entry = declared === null ? entries[0] : entries.find((e) => e.id === declared || basename(e.id as string) === basename(declared));
    if (entry === undefined) return null;
    const m = entry.meta ?? {};
    const fingerprint = ["n_embd", "size", "ftype"].map((k) => (m[k] === undefined ? "" : String(m[k]))).join(":");
    return { id: entry.id as string, fingerprint: fingerprint === "::" ? "" : fingerprint };
  } catch {
    return null;
  }
}

/** Shared cache for model weights and the runtime (not project state): UKTUB_CACHE_DIR, else $XDG_CACHE_HOME, else ~/.cache. */
export function managedCacheDir(env: Record<string, string | undefined>): string {
  if (env.UKTUB_CACHE_DIR !== undefined && env.UKTUB_CACHE_DIR.length > 0) return env.UKTUB_CACHE_DIR;
  const base = env.XDG_CACHE_HOME !== undefined && env.XDG_CACHE_HOME.length > 0 ? env.XDG_CACHE_HOME : join(env.HOME ?? homedir(), ".cache");
  return join(base, "uktub-scholar");
}

/** The configured embedder, or null when none is configured. An explicit UKTUB_EMBED_URL wins; otherwise an INSTALLED managed
 *  runtime is started on demand (a search never downloads anything). Throws ConfigError for an unknown profile and EmbedError
 *  when the model cannot be identified or the managed server cannot start (the caller degrades to keyword search and says so). */
export async function embedderFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
  deps: { lock?: RuntimeLock; platform?: string } = {},
): Promise<Embedder | null> {
  const url = env.UKTUB_EMBED_URL?.trim();
  if (url === undefined || url.length === 0) return managedEmbedder(env, fetchImpl, deps);
  const profileName = env.UKTUB_EMBED_PROFILE?.trim() || "embeddinggemma";
  if (!Object.hasOwn(EMBED_PROFILES, profileName)) {
    throw new ConfigError(`UKTUB_EMBED_PROFILE must be one of ${Object.keys(EMBED_PROFILES).join(", ")}; got "${profileName}"`);
  }
  const profile: EmbedProfile = EMBED_PROFILES[profileName as keyof typeof EMBED_PROFILES];
  const declared = env.UKTUB_EMBED_MODEL?.trim() || null;
  const served = await probeServedModel(url, fetchImpl, declared, signal);
  if (declared === null && served === null) {
    throw new EmbedError("the embedding model cannot be identified: the server did not answer /v1/models and UKTUB_EMBED_MODEL is not set");
  }
  const name = declared ?? served!.id;
  const base = declared ?? (served!.id.split("/").pop() ?? served!.id);
  const identity = served !== null && served.fingerprint.length > 0 ? `${base}~${served.fingerprint}` : base;
  return createHttpEmbedder({ url, model: name, identity, profile, fetch: fetchImpl });
}

async function managedEmbedder(env: Record<string, string | undefined>, fetchImpl: FetchLike, deps: { lock?: RuntimeLock; platform?: string }): Promise<Embedder | null> {
  const lock = deps.lock ?? readLock();
  const cacheDir = managedCacheDir(env);
  const paths = installedPaths(lock, cacheDir, deps.platform ?? platformKey());
  if (paths === null) return null;
  if (!Object.hasOwn(EMBED_PROFILES, lock.embedding.profile)) throw new ConfigError(`the pinned embedding profile "${lock.embedding.profile}" is unknown`);
  let server;
  try {
    server = await ensureServer({ paths, lock, cacheDir });
  } catch (err) {
    throw new EmbedError(`the managed embedding server could not start (${err instanceof Error ? err.message : String(err)})`);
  }
  return createHttpEmbedder({
    url: server.url,
    model: lock.embedding.id,
    identity: `${lock.embedding.id}~${lock.embedding.sha256.slice(0, 12)}`,
    profile: EMBED_PROFILES[lock.embedding.profile as keyof typeof EMBED_PROFILES],
    fetch: fetchImpl,
  });
}
