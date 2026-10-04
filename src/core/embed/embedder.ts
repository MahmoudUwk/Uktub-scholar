/**
 * Embedding client for passage search. One OpenAI-compatible `POST /v1/embeddings` client serves any
 * local server (llama-server, Ollama, vLLM, …): this module owns what must not depend on the server —
 * task prefixes, batching, response validation, L2 normalisation, input-order restoration, and the
 * identity that keys stored vectors. A malformed vector is never returned: it would silently corrupt
 * retrieval, which is worse than failing (the caller falls back to lexical search).
 */
import type { FetchLike } from "../providers/types.ts";
import { agentSafeDetail } from "../safe-detail.ts";

export class EmbedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedError";
  }
}

/** Task prefixes of one embedding model family. A different profile is a different vector space. */
export interface EmbedProfile {
  name: string;
  queryPrefix: string;
  documentPrefix: string;
}

export const EMBED_PROFILES = {
  /** EmbeddingGemma's documented retrieval prompts (model card; sentence-transformers `prompts`). */
  embeddinggemma: { name: "embeddinggemma", queryPrefix: "task: search result | query: ", documentPrefix: "title: none | text: " },
  none: { name: "none", queryPrefix: "", documentPrefix: "" },
} as const satisfies Record<string, EmbedProfile>;

export interface Embedder {
  /** Identity of the vector space (model + profile): stored vectors are valid only under the same id. */
  readonly id: string;
  embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array>;
  embedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

/** Client policy: texts per request. Small enough that one request fits a local server's slot, large
 *  enough to amortise the round trip (a paper is ≈15–150 chunks). */
export const EMBED_BATCH_SIZE = 16;
/** Client policy: the widest embedding vector accepted. Real embedding models are 128–4096 wide; a server claiming more is
 *  broken or hostile, and a stored vector costs 4 bytes per dimension. */
export const MAX_EMBED_DIM = 8192;
/** Client policy: one request may take this long (local cold start, CPU inference of a batch). */
export const EMBED_TIMEOUT_MS = 120_000;

export function createHttpEmbedder(o: {
  url: string;
  /** Model name sent in the request. */
  model: string;
  /** Identity of the served model when it differs from the request name (e.g. fingerprinted); defaults to `model`. */
  identity?: string;
  profile: EmbedProfile;
  fetch: FetchLike;
  batchSize?: number;
  timeoutMs?: number;
}): Embedder {
  let base: URL;
  try {
    base = new URL(o.url);
  } catch {
    throw new EmbedError("the embedding URL is not a valid URL");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new EmbedError("the embedding URL must be http or https");
  const endpoint = `${base.origin}${base.pathname.replace(/\/+$/, "")}/v1/embeddings`;
  const batchSize = Math.max(1, Math.floor(o.batchSize ?? EMBED_BATCH_SIZE));
  const timeoutMs = o.timeoutMs ?? EMBED_TIMEOUT_MS;
  let dimension: number | null = null;

  async function request(inputs: string[], signal: AbortSignal | undefined): Promise<Float32Array[]> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await o.fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: o.model, input: inputs }),
        signal: signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw new EmbedError("the embedding request was cancelled or timed out");
      throw new EmbedError(`the embedding server is unreachable (${agentSafeDetail(err, inputs)})`);
    }
    if (res.status < 200 || res.status >= 300) {
      const body = await res.text().catch(() => "");
      throw new EmbedError(`the embedding server answered HTTP ${res.status}: ${agentSafeDetail(body, inputs)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(await res.text());
    } catch {
      throw new EmbedError("the embedding server did not return JSON");
    }
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data) || data.length !== inputs.length) {
      throw new EmbedError(`invalid embedding output: expected ${inputs.length} vector(s), got ${Array.isArray(data) ? data.length : typeof data}`);
    }
    const slots: (Float32Array | undefined)[] = new Array(inputs.length).fill(undefined);
    data.forEach((item, position) => {
      const index = typeof (item as { index?: unknown })?.index === "number" ? (item as { index: number }).index : position;
      const raw = (item as { embedding?: unknown })?.embedding;
      if (!Number.isInteger(index) || index < 0 || index >= inputs.length || slots[index] !== undefined) throw new EmbedError("invalid embedding output: bad or repeated index");
      if (!Array.isArray(raw) || raw.length === 0) throw new EmbedError("invalid embedding output: empty vector");
      if (raw.length > MAX_EMBED_DIM) throw new EmbedError(`invalid embedding output: dimension ${raw.length} exceeds the limit of ${MAX_EMBED_DIM}`);
      let peak = 0;
      for (let i = 0; i < raw.length; i++) {
        const x = raw[i];
        if (typeof x !== "number" || !Number.isFinite(x)) throw new EmbedError("invalid embedding output: a component is not a finite number");
        peak = Math.max(peak, Math.abs(x));
      }
      if (peak === 0) throw new EmbedError("invalid embedding output: a zero vector");
      // scale by the largest component first: squaring extreme but finite components would overflow or underflow
      let sum = 0;
      for (let i = 0; i < raw.length; i++) sum += ((raw[i] as number) / peak) ** 2;
      const n = Math.sqrt(sum);
      const v = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) v[i] = (raw[i] as number) / peak / n;
      slots[index] = v;
    });
    const out = slots as Float32Array[];
    const dim = out[0].length;
    if (out.some((v) => v.length !== dim)) throw new EmbedError("invalid embedding output: vectors of different dimensions");
    if (dimension !== null && dim !== dimension) throw new EmbedError(`the embedding dimension changed from ${dimension} to ${dim} (a different model is serving this URL)`);
    dimension = dim;
    return out;
  }

  async function embed(texts: string[], prefix: string, signal: AbortSignal | undefined): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += batchSize) out.push(...(await request(texts.slice(i, i + batchSize).map((t) => prefix + t), signal)));
    return out;
  }

  return {
    id: `${o.identity ?? o.model}|${o.profile.name}`,
    async embedQuery(text, signal) {
      return (await embed([text], o.profile.queryPrefix, signal))[0];
    },
    embedDocuments: (texts, signal) => embed(texts, o.profile.documentPrefix, signal),
  };
}
