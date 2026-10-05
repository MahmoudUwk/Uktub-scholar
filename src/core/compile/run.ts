/**
 * Compile orchestration (KTD1, KTD6): locate the engine, resolve the entry
 * file, spawn tectonic once inside the caller's write fence, and parse its
 * streams. No globals: env, spawn, and fs seams are injected; the queue wraps
 * the call at the tool layer (build/ artifacts are project writes).
 *
 * Stream grammar and fixtures: src/core/compile/diagnostics.ts.
 */

import { mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { managedCacheDir } from "../embed/config.ts";
import { platformKey } from "../embed/runtime.ts";
import { resolveEngine } from "./engine.ts";
import { managedTectonicPath, readTectonicLock } from "./managed.ts";
import { parseTectonicStreams, type CompileDiagnostic } from "./diagnostics.ts";

/** Default single-compile budget — client policy (labelled; not a provider limit). */
export const DEFAULT_COMPILE_TIMEOUT_MS = 120_000;
/** Env override for the budget, in seconds — client policy (labelled). */
export const COMPILE_TIMEOUT_ENV = "UKTUB_COMPILE_TIMEOUT_S";
export const BUILD_DIR = "build";

/** The spawn seam: prod wires child_process, tests fake it. */
export type EngineSpawn = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }>;

export interface CompileInput {
  root: string;
  env: Record<string, string | undefined>;
  spawn: EngineSpawn;
  /** Engine-location fs seam (KTD6); prod default is the real filesystem. */
  fs?: Parameters<typeof resolveEngine>[2];
}

export type CompileOutcome =
  | {
      kind: "compiled";
      engineVersion: string;
      entry: string; // relative to root
      pdfPath: string | null; // relative to root
      pdfSizeBytes: number | null;
      diagnostics: CompileDiagnostic[];
      truncated: boolean;
    }
  | { kind: "errors"; engineVersion: string; entry: string; diagnostics: CompileDiagnostic[]; truncated: boolean }
  | { kind: "refusal"; code: "COMPILE_ENGINE_MISSING" | "COMPILE_NO_ENTRY" | "COMPILE_TIMEOUT"; message: string };

/** Deterministic human text the tool/CLI both render from an outcome. Refusals
 * are NOT rendered here — they go through renderRefusal/refusalResult so the
 * stable `next` hint comes from the one refusal table (KTD6). */
export function describeOutcome(outcome: Exclude<CompileOutcome, { kind: "refusal" }>): string {
  const d = outcome.diagnostics;
  const errors = d.filter((x) => x.severity === "error");
  const warnings = d.filter((x) => x.severity === "warning");
  const head =
    outcome.kind === "compiled"
      ? `Compiled ${outcome.entry} with tectonic ${outcome.engineVersion} → ${outcome.pdfPath} (${outcome.pdfSizeBytes} bytes). ${errors.length} error(s), ${warnings.length} warning(s).`
      : `Compile failed: ${outcome.entry} — ${errors.length} error(s), ${warnings.length} warning(s) from tectonic ${outcome.engineVersion}.`;
  const lines = d.map((x) => {
    const at = [x.file, x.line].filter((v) => v !== undefined).join(":");
    return `- ${x.severity}${at ? ` ${at}` : ""}: ${x.message}`;
  });
  if (outcome.truncated) lines.push(`- (diagnostics truncated at the ${d.length} shown)`);
  return [head, ...lines].join("\n");
}

/** Resolve the entry .tex: explicit param (confined) or the documented defaults. */
export function resolveEntry(root: string, entryParam?: string): { ok: true; abs: string; rel: string } | { ok: false; message: string } {
  if (entryParam !== undefined) {
    if (typeof entryParam !== "string" || entryParam.length === 0) {
      return { ok: false, message: "entry must be a non-empty path relative to the project root" };
    }
    if (isAbsolute(entryParam) || entryParam.split(/[\\/]/).includes("..")) {
      return { ok: false, message: `entry "${entryParam}" must stay inside the project (no absolute paths, no '..')` };
    }
    const abs = resolve(root, entryParam);
    if (!abs.startsWith(root + sep)) {
      return { ok: false, message: `entry "${entryParam}" resolves outside the project root` };
    }
    if (abs.split(sep).some((seg) => [".registry", ".git", BUILD_DIR].includes(seg))) {
      return { ok: false, message: `entry "${entryParam}" enters a protected/generated segment` };
    }
    if (!/\.(?:tex|ltx)$/.test(abs)) {
      return { ok: false, message: `entry "${entryParam}" is not a .tex file` };
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      return { ok: false, message: `entry "${entryParam}" does not exist in the project` };
    }
    return { ok: true, abs, rel: relative(root, abs) };
  }
  // Defaults, in order: the manuscript convention, then a lone root .tex.
  for (const candidate of ["manuscript/main.tex", "main.tex"]) {
    const abs = join(root, candidate);
    if (existsSync(abs)) return { ok: true, abs, rel: candidate };
  }
  const tops: string[] = [];
  for (const dir of ["manuscript", "."]) {
    const absDir = join(root, dir);
    if (!existsSync(absDir)) continue;
    for (const name of readdirSync(absDir)) {
      if (name.endsWith(".tex") && statSync(join(absDir, name)).isFile()) tops.push(join(dir, name));
    }
  }
  const unique = [...new Set(tops)].sort();
  if (unique.length === 1) return { ok: true, abs: join(root, unique[0]), rel: unique[0] };
  if (unique.length === 0) {
    return { ok: false, message: "no .tex entry found — create manuscript/main.tex or pass entry with the file to compile" };
  }
  return {
    ok: false,
    message: `multiple .tex entries (${unique.slice(0, 5).join(", ")}${unique.length > 5 ? ", …" : ""}) — pass entry naming the main file`,
  };
}

/** Timeout budget: env override (seconds) wins, else the client-policy default. */
export function timeoutMsFromEnv(env: Record<string, string | undefined>): number {
  const raw = env[COMPILE_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return DEFAULT_COMPILE_TIMEOUT_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 5) return DEFAULT_COMPILE_TIMEOUT_MS;
  return Math.round(seconds * 1000);
}

/** Prod spawn: child_process.execFile with a hard timeout; a kill surfaces as
 * timedOut, a nonzero exit as code — the engine's failure text still travels. */
export const prodSpawn: EngineSpawn = async (file, args, opts) => {
  const { execFile } = await import("node:child_process");
  const execFileAsync = promisify(execFile);
  try {
    const r = await execFileAsync(file, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: r.stdout, stderr: r.stderr, code: 0, timedOut: false };
  } catch (err) {
    const e = err as { code?: number | string; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
    if (e.killed || e.signal === "SIGKILL") {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: 1, timedOut: true };
    }
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: typeof e.code === "number" ? e.code : 1,
      timedOut: false,
    };
  }
};

export async function compileDocument(input: CompileInput, entryParam?: string): Promise<CompileOutcome> {
  const managed = managedTectonicPath(readTectonicLock(), managedCacheDir(input.env), platformKey());
  const engine = await resolveEngine(input.env, spawnVersionProbe(input.spawn), input.fs, managed);
  if (!engine.ok) {
    return {
      kind: "refusal",
      code: "COMPILE_ENGINE_MISSING",
      message: engine.detail,
    };
  }

  const entry = resolveEntry(input.root, entryParam);
  if (!entry.ok) return { kind: "refusal", code: "COMPILE_NO_ENTRY", message: entry.message };

  // Real tectonic quirk (0.15.0): --outdir must already exist.
  const outdir = join(input.root, BUILD_DIR);
  mkdirSync(outdir, { recursive: true });

  const timeoutMs = timeoutMsFromEnv(input.env);
  const run = await input.spawn(engine.engine.path, ["-X", "compile", entry.abs, "--outdir", outdir], {
    cwd: dirname(entry.abs),
    timeoutMs,
  });
  if (run.timedOut) {
    return {
      kind: "refusal",
      code: "COMPILE_TIMEOUT",
      message: `tectonic exceeded the ${Math.round(timeoutMs / 1000)}s budget (${COMPILE_TIMEOUT_ENV} overrides it in seconds)`,
    };
  }

  const parsed = parseTectonicStreams(run.stdout, run.stderr);
  const hasErrors = parsed.diagnostics.some((x) => x.severity === "error") || run.code !== 0;
  if (hasErrors) {
    return { kind: "errors", engineVersion: engine.engine.version, entry: entry.rel, ...parsed };
  }
  const pdfAbs = parsed.wrotePdf ? resolve(dirname(entry.abs), parsed.wrotePdf) : null;
  const pdfRel = pdfAbs && pdfAbs.startsWith(input.root + sep) ? relative(input.root, pdfAbs) : null;
  const size = pdfAbs && existsSync(pdfAbs) ? statSync(pdfAbs).size : null;
  return {
    kind: "compiled",
    engineVersion: engine.engine.version,
    entry: entry.rel,
    pdfPath: pdfRel,
    pdfSizeBytes: size,
    diagnostics: parsed.diagnostics,
    truncated: parsed.truncated,
  };
}

/** Adapt the EngineSpawn seam into the version-probe shape resolveEngine takes. */
function spawnVersionProbe(spawn: EngineSpawn) {
  return async (file: string, args: string[]) => {
    const r = await spawn(file, args, { cwd: ".", timeoutMs: 10_000 });
    return { stdout: r.stdout, stderr: r.stderr };
  };
}
