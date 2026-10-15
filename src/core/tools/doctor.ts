/**
 * `doctor`: self-diagnose the setup and tell the model what is wrong and how
 * to fix it — mainly whether claim verification can run now. No arguments,
 * read-only: the hosted check makes ONE minimal authenticated judgment (10 s
 * budget); the local-engine checks reuse the existing discovery/self-check
 * helpers without loading any model; nothing is written and no key ever
 * appears in the output.
 */

import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";

import { ConfigError, loadChunkConfig } from "../config.ts";
import { resolveEngine, type EngineFs } from "../compile/engine.ts";
import { managedTectonicPath, readTectonicLock } from "../compile/managed.ts";
import { managedCacheDir } from "../embed/config.ts";
import { platformKey } from "../embed/runtime.ts";
import { listPapers, openRegistry, REGISTRY_SCHEMA_VERSION, RegistryError } from "../registry.ts";
import { HOSTED_KEY_URL, HOSTED_MODEL, HOSTED_URL, VERIFY_API_KEY_ENV } from "../verify/engines.ts";
import { withManagedEosOnnx } from "../verify/eos-onnx.ts";
import type { ToolContext, ToolResult } from "./context.ts";

export const DoctorParams = Type.Object({});
export type DoctorArgs = Static<typeof DoctorParams>;

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  name: "verification" | "registry" | "compile" | "providers";
  status: DoctorStatus;
  detail: string;
  fix: string;
}

export interface DoctorStructured {
  summary: string;
  checks: DoctorCheck[];
}

export const DoctorCheckOutput = Type.Object({
  name: Type.String(),
  status: Type.Union([Type.Literal("ok"), Type.Literal("warn"), Type.Literal("error")]),
  detail: Type.String(),
  fix: Type.String(),
});

export const DoctorOutput = Type.Object({
  summary: Type.String(),
  checks: Type.Array(DoctorCheckOutput),
});

/** Test seams (KTD6): the host injects nothing new — fs and exec probes only. */
export interface DoctorDeps {
  fs?: EngineFs;
  execProbe?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

const realFs: EngineFs = {
  exists: (p) => existsSync(p),
  executable: (p) => {
    try {
      accessSync(p, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

const execFileAsync = promisify(execFile);

/** Client policy: the hosted probe must not stall a diagnosis. */
const HOSTED_PROBE_TIMEOUT_MS = 10_000;

/** The one minimal judgment the hosted check runs: a fixed tiny passage/claim. */
const PROBE_STATE = "Water boils at 100 degrees Celsius at sea level.";
const PROBE_INSTRUCTIONS = "The passage states the claim.";

const HOSTED_NO_KEY_FIX =
  `Get a free key in one click at ${HOSTED_KEY_URL} and set ${VERIFY_API_KEY_ENV}, ` +
  `or use the local engine: set verification.engine: eos (slower, needs Python/the Eos model; lower recall: 49 % vs 93 %)`;
const LOCAL_ENGINE_FIX = "run `uktub-scholar eos install --yes` and set verification.engine: eos-onnx (or use the default hosted engine)";

function findOnPath(env: Record<string, string | undefined>, name: string, fs: EngineFs): string | null {
  if (name.includes("/") || name.includes("\\")) return fs.exists(name) ? name : null;
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = (env.PATH ?? env.Path ?? "").split(sep).filter((p) => p.length > 0);
  const base = process.platform === "win32" ? `${name}.exe` : name;
  return dirs.map((d) => `${d}/${base}`).find((p) => fs.exists(p)) ?? null;
}

async function verificationCheck(ctx: ToolContext, deps: DoctorDeps): Promise<DoctorCheck> {
  const name = "verification" as const;
  let engine: string;
  try {
    engine = loadChunkConfig(ctx.root, { env: ctx.env }).verification.engine;
  } catch (err) {
    if (err instanceof ConfigError) {
      return { name, status: "error", detail: `invalid verification configuration: ${err.message}`, fix: "fix verification.* in config/chunking.yaml (engine, min_confidence, workers, max_judgments)" };
    }
    throw err;
  }
  const fs = deps.fs ?? realFs;
  switch (engine) {
    case "hosted": {
      const key = ctx.env[VERIFY_API_KEY_ENV]?.trim();
      if (!key) {
        return {
          name,
          status: "error",
          detail: `engine hosted (${HOSTED_MODEL} at ${HOSTED_URL}) has no key in ${VERIFY_API_KEY_ENV}, so verify cannot run`,
          fix: HOSTED_NO_KEY_FIX,
        };
      }
      let res: Response;
      try {
        res = (await ctx.fetch(`${HOSTED_URL}/v1/systemone`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: HOSTED_MODEL, state: PROBE_STATE, questions: { c: { type: "noul", instructions: PROBE_INSTRUCTIONS } } }),
          signal: AbortSignal.timeout(HOSTED_PROBE_TIMEOUT_MS),
        })) as unknown as Response;
      } catch (e) {
        return {
          name,
          status: "error",
          detail: `engine hosted: the endpoint is unreachable (${e instanceof Error ? e.message : String(e)})`,
          fix: `check network access to ${HOSTED_URL}, or use the local engine: set verification.engine: eos`,
        };
      }
      if (!res.ok) {
        return {
          name,
          status: "error",
          detail:
            res.status === 401
              ? `engine hosted: the endpoint answered HTTP 401 (unauthorized) — the key was rejected`
              : `engine hosted: the endpoint answered HTTP ${res.status}`,
          fix:
            res.status === 401
              ? `get a fresh free key at ${HOSTED_KEY_URL} and set ${VERIFY_API_KEY_ENV}`
              : `retry later, or use the local engine: set verification.engine: eos`,
        };
      }
      const parsed = (await res.json()) as { answers?: { c?: { noul?: unknown } }; model?: unknown };
      const p = parsed.answers?.c?.noul;
      if (typeof p !== "number") {
        return { name, status: "error", detail: "engine hosted: the probe response carried no judgment", fix: "retry later, or use the local engine: set verification.engine: eos" };
      }
      if (parsed.model !== undefined && parsed.model !== HOSTED_MODEL) {
        return {
          name,
          status: "error",
          detail: `engine hosted: the server reports model ${JSON.stringify(String(parsed.model)).slice(0, 120)}, not ${HOSTED_MODEL}`,
          fix: "retry later — the endpoint is serving other weights",
        };
      }
      return { name, status: "ok", detail: `engine hosted (${HOSTED_MODEL}) answered one probe judgment`, fix: "" };
    }
    case "eos": {
      const bin = ctx.env.UKTUB_EOS_PYTHON ?? "python3";
      const found = findOnPath(ctx.env, bin, fs);
      if (found === null) {
        return {
          name,
          status: "error",
          detail: `engine eos: no Python interpreter named "${bin}" on PATH (torch and transformers>=5.17 load on first verify)`,
          fix: `set UKTUB_EOS_PYTHON to a Python with torch and transformers>=5.17, or ${LOCAL_ENGINE_FIX}`,
        };
      }
      if (!fs.executable(found)) {
        return { name, status: "error", detail: `engine eos: ${found} is not executable`, fix: `point UKTUB_EOS_PYTHON at an executable Python, or ${LOCAL_ENGINE_FIX}` };
      }
      return { name, status: "ok", detail: `engine eos: Python at ${found} (torch and the Eos model load on first verify)`, fix: "" };
    }
    case "eos-onnx": {
      const dir = withManagedEosOnnx(ctx.env).UKTUB_EOS_ONNX_DIR;
      if (dir !== undefined && dir !== "" && fs.exists(dir)) {
        return { name, status: "ok", detail: `engine eos-onnx: model at ${dir}`, fix: "" };
      }
      return {
        name,
        status: "error",
        detail: "engine eos-onnx: no model installed (and UKTUB_EOS_ONNX_DIR names nothing present)",
        fix: "run `uktub-scholar eos install --yes` (or set UKTUB_EOS_ONNX_DIR to an export directory)",
      };
    }
    case "openrouter": {
      if (!ctx.env.UKTUB_OPENROUTER_API_KEY?.trim()) {
        return { name, status: "error", detail: "engine openrouter: no key in UKTUB_OPENROUTER_API_KEY, so verify cannot run", fix: "set UKTUB_OPENROUTER_API_KEY (or use the default hosted engine)" };
      }
      return { name, status: "ok", detail: "engine openrouter: key present (doctor does not probe this engine)", fix: "" };
    }
    case "llama-cpp": {
      const url = ctx.env.UKTUB_VERIFY_URL ?? "http://127.0.0.1:8080";
      return { name, status: "ok", detail: `engine llama-cpp: configured at ${url} (doctor does not probe this engine)`, fix: "" };
    }
    default:
      return { name, status: "error", detail: `unknown verification engine "${engine}"`, fix: `set verification.engine to one of eos, eos-onnx, openrouter, llama-cpp, hosted` };
  }
}

function registryCheck(ctx: ToolContext): DoctorCheck {
  const name = "registry" as const;
  let db;
  try {
    db = openRegistry(ctx.root);
  } catch (err) {
    if (err instanceof RegistryError && err.code === "REGISTRY_NOT_INITIALIZED") {
      return { name, status: "warn", detail: `no registry at .registry/registry.db under ${ctx.root}`, fix: "register a paper with the registry tool (run `uktub-scholar init` in the project first)" };
    }
    if (err instanceof RegistryError) {
      return { name, status: "error", detail: err.message, fix: "see the detail — a foreign or newer registry is never migrated" };
    }
    throw err;
  }
  try {
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)?.user_version ?? 0;
    const papers = listPapers(db).length;
    const ready = (db.prepare("SELECT COUNT(*) AS n FROM paper_sources WHERE status = 'ready'").get() as { n: number } | undefined)?.n ?? 0;
    if (version !== REGISTRY_SCHEMA_VERSION) {
      return { name, status: "error", detail: `registry schema version ${version} is not version ${REGISTRY_SCHEMA_VERSION}`, fix: "see the detail — a foreign or newer registry is never migrated" };
    }
    return { name, status: "ok", detail: `registry present (schema version ${version} supported); ${papers} paper(s), ${ready} with a ready source`, fix: "" };
  } finally {
    db.close();
  }
}

async function compileCheck(ctx: ToolContext, deps: DoctorDeps): Promise<DoctorCheck> {
  const name = "compile" as const;
  const fs = deps.fs ?? realFs;
  const execProbe = deps.execProbe ?? (async (file: string, args: string[]) => {
    const r = await execFileAsync(file, args, { timeout: HOSTED_PROBE_TIMEOUT_MS });
    return { stdout: r.stdout, stderr: r.stderr };
  });
  const managed = managedTectonicPath(readTectonicLock(), managedCacheDir(ctx.env), platformKey());
  const engine = await resolveEngine(ctx.env, execProbe, fs, managed);
  if (!engine.ok) {
    return { name, status: "error", detail: `no LaTeX engine: ${engine.detail}`, fix: "run `uktub-scholar tectonic install --yes` (or put tectonic >= 0.15.0 on PATH, or set UKTUB_TECTONIC_BIN)" };
  }
  return { name, status: "ok", detail: `tectonic ${engine.engine.version} at ${engine.engine.path}`, fix: "" };
}

function providersCheck(ctx: ToolContext): DoctorCheck {
  const name = "providers" as const;
  const present = (v: string | undefined): boolean => v !== undefined && v.trim() !== "";
  const keys = ["SEMANTIC_SCHOLAR_API_KEY", "OPENALEX_API_KEY", "CROSSREF_MAILTO"] as const;
  const missing = keys.filter((k) => !present(ctx.env[k]));
  if (missing.length === 0) {
    return { name, status: "ok", detail: "all optional provider keys set (SEMANTIC_SCHOLAR_API_KEY, OPENALEX_API_KEY, CROSSREF_MAILTO)", fix: "" };
  }
  return {
    name,
    status: "warn",
    detail: `missing optional ${missing.join(", ")} (set: ${keys.filter((k) => !missing.includes(k)).join(", ") || "none"}; searches still run, at lower rate limits)`,
    fix: `set ${missing.join(", ")} for higher rate limits`,
  };
}

export async function doctorTool(ctx: ToolContext, args: DoctorArgs = {}, deps: DoctorDeps = {}): Promise<ToolResult<DoctorStructured>> {
  void args;
  const checks: DoctorCheck[] = [
    await verificationCheck(ctx, deps),
    registryCheck(ctx),
    await compileCheck(ctx, deps),
    providersCheck(ctx),
  ];
  const problems = checks.filter((c) => c.status !== "ok").length;
  const summary = problems === 0 ? "doctor: all checks passed" : `doctor: ${problems} problem(s)`;
  const lines = [summary, ...checks.map((c) => `- ${c.name}: ${c.status.toUpperCase()} — ${c.detail}${c.fix ? ` Fix: ${c.fix}` : ""}`)];
  if (checks.some((c) => c.status === "error")) {
    lines.push("For any check that reports an error, tell the user the fix.");
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { summary, checks },
    details: {},
  };
}
