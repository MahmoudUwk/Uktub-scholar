/**
 * Configured verification-engine registry (KTD6): maps `verification.engine` from config/chunking.yaml to a ClaimEngine. The default
 * is `eos` (a local resident worker, owner decision 2026-10-04); every other engine is selectable only (OpenRouter Mercury Decide is
 * the best measured; `vela` was benchmarked and not adopted, docs/DECISIONS.md; Julia, Laya, K2, bev and Lumma were removed 2026-10-12). Every knob is a named env; the engine itself never
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
  velaEngine,
  VELA_MODEL,
  VELA_REVISION,
  type ClaimEngine,
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
  "vela",
  "hosted",
] as const;

/** Decision protocol the System One engines speak: one `noul` question per
 *  (passage, claim) row, answer P(true). Part of the judgment identity — a
 *  change in how rows are posed must not reuse old scores. */
export const SYSTEMONE_PROTOCOL = "systemone-noul-v1";

const PROTOCOLS: Record<(typeof VERIFICATION_ENGINES)[number], string> = {
  eos: "decision2-noul-v1",
  "eos-onnx": "decision2-noul-v1",
  openrouter: SYSTEMONE_PROTOCOL,
  "llama-cpp": SYSTEMONE_PROTOCOL,
  vela: "vela2-halu-v1",
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

/** Ask an OpenAI-style `/v1/models` listing which model the endpoint serves. With a key for an HTTPS origin the probe
 *  authenticates the same way a judgment request does (the key is scoped to that origin and never logged); otherwise it
 *  asks anonymously, as before. */
async function probeServedModel(baseUrl: string, fetchImpl: typeof fetch, apiKey?: string): Promise<string | null> {
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
    const id = body.data?.[0]?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
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
      const served = await probeServedModel(base, fetchImpl, env[VERIFY_API_KEY_ENV]);
      if (served !== null) return { model: `llama-cpp:${served}`, protocol: SYSTEMONE_PROTOCOL };
      // A hosted endpoint may serve no models listing (404): the configured model id stands in. It is the id the
      // server echoes back in every judgment response, and the engine refuses an echo naming another model,
      // so reuse under it stays sound. With neither, there is no identity and reuse stays disabled.
      const configured = env[VERIFY_MODEL_ENV]?.trim();
      return configured ? { model: `llama-cpp:${configured}`, protocol: SYSTEMONE_PROTOCOL } : null;
    }
    case "hosted": {
      const served = await probeServedModel(HOSTED_URL, fetchImpl, env[VERIFY_API_KEY_ENV]);
      // The host serves no models listing today: the requested model stands in, guarded by the per-response echo check.
      return { model: `hosted:${served ?? HOSTED_MODEL}`, protocol: SYSTEMONE_PROTOCOL };
    }
    case "vela": {
      // Same rule as eos-onnx: under the pinned digests the worker refuses any other weights or inference code, so the pin IS the
      // identity (and moving the snapshot keeps cached judgments). An override of the revision, a digest or the export drops that
      // guarantee: fingerprint the directory instead.
      const revision = (env.UKTUB_VELA_REVISION ?? VELA_REVISION).slice(0, 12);
      const overridden = ["UKTUB_VELA_REVISION", "UKTUB_VELA_WEIGHTS_SHA256", "UKTUB_VELA_INFERENCE_SHA256", "UKTUB_VELA_WEIGHTS_FILE", "UKTUB_VELA_BACKEND"].some((k) => env[k] !== undefined);
      const dir = env.UKTUB_VELA_DIR;
      return { model: `vela:${overridden && dir !== undefined && dir !== "" ? localModelRef(dir) : VELA_MODEL}@${revision}`, protocol: "vela2-halu-v1" };
    }
    default:
      throw new Error(`unknown verification engine: ${engine}`);
  }
}

/** Resident worker engines (a model loaded into GPU memory) are shared per process and
 *  configuration, so a long-lived host does not reload the model for every call. */
const resident = new Map<string, ClaimEngine>();
const RESIDENT_ENGINES = new Set(["eos", "eos-onnx", "vela"]);

function residentKey(env: Record<string, string | undefined>, engine: string): string {
  return `${engine}|${Object.entries(env).filter(([k, v]) => v !== undefined && k.startsWith("UKTUB_")).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&")}`;
}

/** Build the engine named by config. Unknown names throw an Error. */
export function createConfiguredEngine(env: Record<string, string | undefined>, engine: string): ClaimEngine {
  if (RESIDENT_ENGINES.has(engine)) {
    const key = residentKey(env, engine);
    const have = resident.get(key);
    if (have !== undefined) return have;
    const made = buildEngine(env, engine);
    resident.set(key, made);
    return made;
  }
  return buildEngine(env, engine);
}

function buildEngine(env: Record<string, string | undefined>, engine: string): ClaimEngine {
  switch (engine) {
    case "eos":
      return eosEngine({ env });
    case "eos-onnx":
      return eosOnnxEngine({ env });
    case "openrouter":
      return openrouterDecisionsEngine({ env, model: env.UKTUB_OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL });
    case "llama-cpp":
      return systemoneEndpointEngine({
        env,
        url: (env[VERIFY_URL_ENV] ?? DEFAULT_LLAMA_CPP_URL).replace(/\/+$/, "") + "/v1/systemone",
        label: "llama-cpp",
        apiKey: env[VERIFY_API_KEY_ENV],
        model: env[VERIFY_MODEL_ENV],
      });
    case "hosted": {
      const apiKey = env[VERIFY_API_KEY_ENV]?.trim();
      if (!apiKey) {
        throw new Error(`the hosted verifier needs a free key: get one at ${HOSTED_KEY_URL} and set ${VERIFY_API_KEY_ENV} (or use the local engine "eos")`);
      }
      return systemoneEndpointEngine({ env, url: `${HOSTED_URL}/v1/systemone`, label: "hosted", apiKey, model: HOSTED_MODEL });
    }
    case "vela":
      return velaEngine({ env });
    default:
      throw new Error(
        `unknown verification.engine "${engine}" (known: ${VERIFICATION_ENGINES.join(", ")})`,
      );
  }
}

