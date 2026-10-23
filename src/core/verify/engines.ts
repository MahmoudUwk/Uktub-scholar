/**
 * Configured verification-engine registry (KTD6): maps `verification.engine` from config/chunking.yaml to a ClaimEngine. The default
 * is `hosted` (owner decision 2026-10-15); local Eos (`eos`, `eos-onnx`) stays selectable, as do the other engines (OpenRouter Mercury Decide is
 * the best measured; rejected engines — Julia, Laya, K2, bev and Lumma removed 2026-10-12, vela removed 2026-10-15 — live in git
 * history, rationale in docs/handoff.md). Every knob is a named env; the engine itself never
 * reads ambient state.
 */

import { readEosOnnxLock, withManagedEosOnnx } from "./eos-onnx.ts";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  EOS_MODEL,
  EOS_REVISION,
  eosEngine,
  eosOnnxEngine,
  openrouterDecisionsEngine,
  systemoneEndpointEngine,
  type ClaimEngine,
  type PackLimits,
} from "./claim.ts";

/** Default hosted decision model: free tier, measured best in class
 * (docs/benchmarks/openrouter-decision-models-2026-10-03.md). */
export const DEFAULT_OPENROUTER_MODEL = "inception/mercury-decide:free";
/** Local llama.cpp System One endpoint (`llama-server` default port). */
export const DEFAULT_LLAMA_CPP_URL = "http://127.0.0.1:8080";
/** Hosted System One endpoint (d3-mini): the request URL, the model id it routes on, and its key. */
export const VERIFY_URL_ENV = "UKTUB_VERIFY_URL";
export const VERIFY_MODEL_ENV = "UKTUB_VERIFY_MODEL";
export const VERIFY_API_KEY_ENV = "UKTUB_VERIFY_API_KEY";
/** The `hosted` engine: d3-mini on the hosted System One endpoint; a free key is one click away at HOSTED_KEY_URL. */
export const HOSTED_URL = "https://decision.vllm-sr.ai";
export const HOSTED_MODEL = "vllm-sr/d3-mini";
export const HOSTED_KEY_URL = "https://decision.vllm-sr.ai/";

export const VERIFICATION_ENGINES = [
  "eos",
  "eos-onnx",
  "openrouter",
  "llama-cpp",
  "hosted",
] as const;

/** Decision protocol the System One engines speak: keyed `noul` question packs
 *  in the benchmarked Decision 2.0 criteria wording, answer P(true). Part of
 *  the judgment identity — a change in how rows are posed must not reuse old
 *  scores. The `-criteria` suffix retired every judgment cached under the
 *  bare-claim wording; `-v2` retires the v1 one-question-per-request rows
 *  (key `c`) in favour of keyed packs (a lone question keeps `c`, a pack of
 *  n >= 2 uses `q1..qn`). */
export const SYSTEMONE_PROTOCOL = "systemone-noul-criteria-v2";

/** Hosted pack: 20 questions (client policy; provider cap `max_questions` 64
 *  per GET /api/info), 120,000 bytes (client policy under the provider's
 *  131,072 `max_request_tokens` estimate, which counts state bytes once per
 *  question on every model except d3-turbo; V0 measured 4x32,000 chars as
 *  131,772), 9 inputs (provider limit: at most 8 extra states per request per
 *  GET /api/info plus the top-level state; measured 2026-10-23). */
export const HOSTED_PACK: PackLimits = { maxQuestions: 20, maxRequestBytes: 120_000, maxStates: 9 };
/** OpenRouter pack: 20 questions (client policy; 40 accepted in the
 *  2026-10-23 probe); no byte bound (the state is read once, context 65,536
 *  tokens). */
export const OPENROUTER_PACK: PackLimits = { maxQuestions: 20 };

/** Client policy: rows per `engine.run` call from the grid judge (D-batch):
 *  20 for hosted and openrouter (one request's question pack), 8 for
 *  eos, eos-onnx and llama-cpp. */
export function gridBatchSizeOf(engine: string): number {
  return engine === "hosted" || engine === "openrouter" ? 20 : 8;
}

const PROTOCOLS: Record<(typeof VERIFICATION_ENGINES)[number], string> = {
  eos: "decision2-noul-v1",
  "eos-onnx": "decision2-noul-v1",
  openrouter: SYSTEMONE_PROTOCOL,
  "llama-cpp": SYSTEMONE_PROTOCOL,
  hosted: SYSTEMONE_PROTOCOL,
};

export interface EngineIdentity {
  model: string;
  protocol: string;
}

/** Fingerprint of a local model path so replacing weights in place changes the identity: a
 *  file's size + mtime, or for a snapshot directory the name/size/mtime of every file in it
 *  (a directory's own mtime does not move when a file inside is rewritten). A plain HF id
 *  names no local file and is used as written. */
function localModelRef(ref: string): string {
  try {
    const st = statSync(ref);
    if (!st.isDirectory()) return `${ref}@${st.size}:${Math.trunc(st.mtimeMs)}`;
    const entries = readdirSync(ref)
      .sort()
      .map((name) => {
        const f = statSync(join(ref, name));
        return `${name}:${f.size}:${Math.trunc(f.mtimeMs)}`;
      });
    return `${ref}@${createHash("sha256").update(entries.join("|")).digest("hex").slice(0, 12)}`;
  } catch {
    return ref;
  }
}

/** List every model id an OpenAI-style `/v1/models` listing serves, in order;
 *  null when the endpoint says nothing usable (non-OK, throw, timeout, an
 *  empty or id-less list). With a key for an HTTPS origin the probe
 *  authenticates the same way a judgment request does (the key is scoped to
 *  that origin and never logged); otherwise it asks anonymously, as before. */
async function probeServedModels(baseUrl: string, fetchImpl: typeof fetch, apiKey?: string): Promise<string[] | null> {
  try {
    let https = false;
    try {
      https = new URL(baseUrl).protocol === "https:";
    } catch {
      https = false;
    }
    const headers: Record<string, string> = apiKey !== undefined && apiKey !== "" && https ? { authorization: `Bearer ${apiKey}` } : {};
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/models`, { headers, signal: AbortSignal.timeout(5_000) }); // client policy: identity probe must not stall a call
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    if (!Array.isArray(body.data) || body.data.length === 0) return null;
    const ids = body.data.map((d) => d?.id).filter((id): id is string => typeof id === "string" && id.length > 0);
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

/**
 * The effective decision identity a judgment is valid under (KTD8), or null
 * when none can be established — then reuse is disabled, because a URL alone
 * does not say which weights answer. `UKTUB_VERIFY_MODEL_ID` lets the user
 * declare the identity of whatever answers, for any engine (their assertion,
 * recorded as `declared:<id>`).
 */
export async function resolveEngineIdentity(
  env: Record<string, string | undefined>,
  engine: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<EngineIdentity | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const declared = env.UKTUB_VERIFY_MODEL_ID?.trim();
  if (declared && (VERIFICATION_ENGINES as readonly string[]).includes(engine)) {
    return { model: `declared:${declared}`, protocol: PROTOCOLS[engine as (typeof VERIFICATION_ENGINES)[number]] };
  }
  switch (engine) {
    case "eos":
      return { model: `eos:${localModelRef(env.UKTUB_EOS_MODEL ?? EOS_MODEL)}@${(env.UKTUB_EOS_REVISION ?? EOS_REVISION).slice(0, 12)}`, protocol: "decision2-noul-v1" };
    case "eos-onnx": {
      // Under the pinned digest the worker refuses any other weights, so the pin IS the identity (and moving the cache keeps cached
      // judgments). A user-overridden digest or revision drops that guarantee: fingerprint the directory instead.
      const lock = readEosOnnxLock();
      const revision = (env.UKTUB_EOS_ONNX_REVISION ?? lock.model.revision).slice(0, 12);
      const overridden = env.UKTUB_EOS_ONNX_SHA256 !== undefined || env.UKTUB_EOS_ONNX_REVISION !== undefined;
      const dir = withManagedEosOnnx(env).UKTUB_EOS_ONNX_DIR;
      return { model: `eos-onnx:${overridden && dir !== undefined ? localModelRef(dir) : lock.model.id}@${revision}`, protocol: "decision2-noul-v1" };
    }
    case "openrouter":
      return { model: `openrouter:${env.UKTUB_OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL}`, protocol: SYSTEMONE_PROTOCOL };
    case "llama-cpp": {
      const base = env[VERIFY_URL_ENV] ?? DEFAULT_LLAMA_CPP_URL;
      const listing = await probeServedModels(base, fetchImpl, env[VERIFY_API_KEY_ENV]);
      const configured = env[VERIFY_MODEL_ENV]?.trim() || undefined;
      if (listing !== null) {
        // A configured model is the identity only when the listing serves it;
        // otherwise the weights behind the id are unknown and reuse stays disabled.
        if (configured !== undefined) return listing.includes(configured) ? { model: `llama-cpp:${configured}`, protocol: SYSTEMONE_PROTOCOL } : null;
        return { model: `llama-cpp:${listing[0]}`, protocol: SYSTEMONE_PROTOCOL };
      }
      // A hosted endpoint may serve no models listing (404): the configured model id stands in. It is the id the
      // server echoes back in every judgment response, and the engine refuses an echo naming another model,
      // so reuse under it stays sound. With neither, there is no identity and reuse stays disabled.
      return configured ? { model: `llama-cpp:${configured}`, protocol: SYSTEMONE_PROTOCOL } : null;
    }
    case "hosted": {
      const listing = await probeServedModels(HOSTED_URL, fetchImpl, env[VERIFY_API_KEY_ENV]);
      // The hosted model is the identity only when the listing serves it;
      // without a listing the requested model stands in, guarded by the per-response echo check.
      if (listing !== null && !listing.includes(HOSTED_MODEL)) return null;
      return { model: `hosted:${HOSTED_MODEL}`, protocol: SYSTEMONE_PROTOCOL };
    }
    default:
      throw new Error(`unknown verification engine: ${engine}`);
  }
}

/** Resident worker engines (a model loaded into GPU memory) are shared per process and
 *  configuration, so a long-lived host does not reload the model for every call. */
const resident = new Map<string, ClaimEngine>();
const RESIDENT_ENGINES = new Set(["eos", "eos-onnx"]);

function residentKey(env: Record<string, string | undefined>, engine: string): string {
  return `${engine}|${Object.entries(env).filter(([k, v]) => v !== undefined && k.startsWith("UKTUB_")).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&")}`;
}

/**
 * Engine-identity probes memoized per process and engine configuration (the
 * same key style as the resident-engine map), keyed additionally by the fetch
 * implementation so test seams never share production entries. A document call
 * checks dozens of units through one shared workflow path, so without this
 * every unit would spend its own `/v1/models` probe (each up to 5 s).
 */
const identityCache = new WeakMap<object, Map<string, Promise<EngineIdentity | null>>>();

export function resolveEngineIdentityCached(
  env: Record<string, string | undefined>,
  engine: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<EngineIdentity | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let byConfig = identityCache.get(fetchImpl);
  if (byConfig === undefined) {
    byConfig = new Map();
    identityCache.set(fetchImpl, byConfig);
  }
  const key = residentKey(env, engine);
  const have = byConfig.get(key);
  if (have !== undefined) return have;
  const pending = resolveEngineIdentity(env, engine, { fetchImpl });
  byConfig.set(key, pending);
  return pending;
}

/** Build the engine named by config. Unknown names throw an Error. */
export function createConfiguredEngine(
  env: Record<string, string | undefined>,
  engine: string,
  deps: { fetchImpl?: typeof fetch } = {},
): ClaimEngine {
  if (RESIDENT_ENGINES.has(engine)) {
    const key = residentKey(env, engine);
    const have = resident.get(key);
    if (have !== undefined) return have;
    const made = buildEngine(env, engine, deps.fetchImpl);
    resident.set(key, made);
    return made;
  }
  return buildEngine(env, engine, deps.fetchImpl);
}

function buildEngine(env: Record<string, string | undefined>, engine: string, fetchImpl?: typeof fetch): ClaimEngine {
  switch (engine) {
    case "eos":
      return eosEngine({ env });
    case "eos-onnx":
      return eosOnnxEngine({ env });
    case "openrouter":
      return openrouterDecisionsEngine({ env, model: env.UKTUB_OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL, fetchImpl, pack: OPENROUTER_PACK });
    case "llama-cpp":
      return systemoneEndpointEngine({
        env,
        fetchImpl,
        url: (env[VERIFY_URL_ENV] ?? DEFAULT_LLAMA_CPP_URL).replace(/\/+$/, "") + "/v1/systemone",
        label: "llama-cpp",
        apiKey: env[VERIFY_API_KEY_ENV],
        model: env[VERIFY_MODEL_ENV],
      });
    case "hosted": {
      const apiKey = env[VERIFY_API_KEY_ENV]?.trim();
      if (!apiKey) {
        throw new Error(`the hosted verifier needs a free key: get one at ${HOSTED_KEY_URL} and set ${VERIFY_API_KEY_ENV}`);
      }
      return systemoneEndpointEngine({ env, fetchImpl, url: `${HOSTED_URL}/v1/systemone`, label: "hosted", apiKey, model: HOSTED_MODEL, pack: HOSTED_PACK });
    }
    default:
      throw new Error(
        `unknown verification.engine "${engine}" (known: ${VERIFICATION_ENGINES.join(", ")})`,
      );
  }
}

