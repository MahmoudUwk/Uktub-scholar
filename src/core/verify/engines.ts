/**
 * Configured verification-engine registry (KTD6): maps
 * `verification.engine` from config/chunking.yaml to a ClaimEngine, with
 * `mercury-decide:free` (OpenRouter System One) as the default and a local
 * llama.cpp System One endpoint as the offline path. Every knob is a named
 * env; the engine itself never reads ambient state.
 */

import { readEosOnnxLock, withManagedEosOnnx } from "./eos-onnx.ts";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  EOS_MODEL,
  EOS_REVISION,
  bevEngine,
  eosEngine,
  eosOnnxEngine,
  juliaEngine,
  k2Engine,
  layaEngine,
  lummaEngine,
  openrouterDecisionsEngine,
  systemoneEndpointEngine,
  type ClaimEngine,
} from "./claim.ts";

/** Default hosted decision model: free tier, measured best in class
 * (docs/benchmarks/openrouter-decision-models-2026-10-03.md). */
export const DEFAULT_OPENROUTER_MODEL = "inception/mercury-decide:free";
/** Local llama.cpp System One endpoint (`llama-server` default port). */
export const DEFAULT_LLAMA_CPP_URL = "http://127.0.0.1:8080";

export const VERIFICATION_ENGINES = [
  "eos",
  "eos-onnx",
  "openrouter",
  "llama-cpp",
  "k2",
  "bev",
  "lumma",
  "julia",
  "laya",
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
  k2: SYSTEMONE_PROTOCOL,
  bev: SYSTEMONE_PROTOCOL,
  lumma: SYSTEMONE_PROTOCOL,
  julia: "julia-v1",
  laya: "laya-router-v1",
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

/** Ask an OpenAI-style `/v1/models` listing which model the endpoint serves. */
async function probeServedModel(baseUrl: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/models`, { signal: AbortSignal.timeout(5_000) }); // client policy: identity probe must not stall a call
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
    case "llama-cpp":
    case "k2":
    case "bev":
    case "lumma": {
      const url = {
        "llama-cpp": env.UKTUB_VERIFY_URL ?? DEFAULT_LLAMA_CPP_URL,
        k2: env.UKTUB_K2_URL ?? "http://127.0.0.1:8000",
        bev: env.UKTUB_BEV_URL ?? "http://127.0.0.1:8009",
        lumma: env.UKTUB_LUMMA_URL ?? "http://127.0.0.1:8010",
      }[engine];
      const served = await probeServedModel(url, fetchImpl);
      return served === null ? null : { model: `${engine}:${served}`, protocol: SYSTEMONE_PROTOCOL };
    }
    case "julia":
      return { model: `julia:${localModelRef(env.UKTUB_JULIA_MODEL ?? "SupersonicLabs/Julia-1")}`, protocol: "julia-v1" };
    case "laya":
      return { model: `laya:${localModelRef("convaiinnovations/laya-multilingual")}`, protocol: "laya-router-v1" };
    default:
      throw new Error(`unknown verification engine: ${engine}`);
  }
}

/** Resident worker engines (a model loaded into GPU memory) are shared per process and
 *  configuration, so a long-lived host does not reload the model for every call. */
const resident = new Map<string, ClaimEngine>();
const RESIDENT_ENGINES = new Set(["eos", "eos-onnx", "julia", "laya"]);

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
        url: (env.UKTUB_VERIFY_URL ?? DEFAULT_LLAMA_CPP_URL).replace(/\/+$/, "") + "/v1/systemone",
        label: "llama-cpp",
      });
    case "k2":
      return k2Engine({ env });
    case "bev":
      return bevEngine({ env });
    case "lumma":
      return lummaEngine({ env });
    case "julia":
      return juliaEngine({ env });
    case "laya":
      return layaEngine({ env });
    default:
      throw new Error(
        `unknown verification.engine "${engine}" (known: ${VERIFICATION_ENGINES.join(", ")})`,
      );
  }
}

