/**
 * Build the configured embedder from the environment the host injected. Nothing here reads
 * `process.env`: the host passes `env` and `fetch` (core imports no globals).
 *
 *   UKTUB_EMBED_URL      base URL of an OpenAI-compatible embedding server; unset = no vector search
 *   UKTUB_EMBED_MODEL    optional declared model name (default: whatever the server reports)
 *   UKTUB_EMBED_PROFILE  prompt profile: embeddinggemma (default) | none
 *
 * The identity that keys stored vectors is the served model (probed from `/v1/models`, with its size
 * and quantisation as a fingerprint) plus the profile — a server restarted with another model must not
 * be served vectors computed by the old one.
 */
import { ConfigError } from "../config.ts";
import type { FetchLike } from "../providers/types.ts";
import { EMBED_PROFILES, EmbedError, createHttpEmbedder, type EmbedProfile, type Embedder } from "./embedder.ts";

/** Client policy: the identity probe of a local server answers at once or not at all. */
const PROBE_TIMEOUT_MS = 5_000;

interface Served {
  id: string;
  fingerprint: string;
}

async function probeServedModel(base: string, fetchImpl: FetchLike, signal: AbortSignal | undefined): Promise<Served | null> {
  try {
    const res = await fetchImpl(`${base.replace(/\/+$/, "")}/v1/models`, {
      signal: signal === undefined ? AbortSignal.timeout(PROBE_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
    });
    if (res.status < 200 || res.status >= 300) return null;
    const first = (JSON.parse(await res.text()) as { data?: { id?: unknown; meta?: Record<string, unknown> }[] }).data?.[0];
    if (typeof first?.id !== "string" || first.id.length === 0) return null;
    const m = first.meta ?? {};
    const fingerprint = ["n_embd", "size", "ftype"].map((k) => (m[k] === undefined ? "" : String(m[k]))).join(":");
    return { id: first.id, fingerprint: fingerprint === "::" ? "" : fingerprint };
  } catch {
    return null;
  }
}

/** The configured embedder, or null when no embedding server is configured. Throws ConfigError for an unknown profile
 *  and EmbedError when the model cannot be identified (the caller degrades to lexical search and says so). */
export async function embedderFromEnv(env: Record<string, string | undefined>, fetchImpl: FetchLike, signal?: AbortSignal): Promise<Embedder | null> {
  const url = env.UKTUB_EMBED_URL?.trim();
  if (url === undefined || url.length === 0) return null;
  const profileName = env.UKTUB_EMBED_PROFILE?.trim() || "embeddinggemma";
  if (!Object.hasOwn(EMBED_PROFILES, profileName)) {
    throw new ConfigError(`UKTUB_EMBED_PROFILE must be one of ${Object.keys(EMBED_PROFILES).join(", ")}; got "${profileName}"`);
  }
  const profile: EmbedProfile = EMBED_PROFILES[profileName as keyof typeof EMBED_PROFILES];
  const declared = env.UKTUB_EMBED_MODEL?.trim() || null;
  const served = await probeServedModel(url, fetchImpl, signal);
  if (declared === null && served === null) {
    throw new EmbedError("the embedding model cannot be identified: the server did not answer /v1/models and UKTUB_EMBED_MODEL is not set");
  }
  const name = declared ?? served!.id;
  const base = declared ?? (served!.id.split("/").pop() ?? served!.id);
  const identity = served !== null && served.fingerprint.length > 0 ? `${base}~${served.fingerprint}` : base;
  return createHttpEmbedder({ url, model: name, identity, profile, fetch: fetchImpl });
}
