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
import {
  BUILD_DIR,
  ENGINE_OUTPUT_CAP_BYTES,
  finishCompile,
  timeoutMsFromEnv,
} from "./finish.ts";

export {
  BUILD_DIR,
  COMPILE_TIMEOUT_ENV,
  DEFAULT_COMPILE_TIMEOUT_MS,
  ENGINE_OUTPUT_CAP_BYTES,
  projectPathOf,
  timeoutMsFromEnv,
} from "./finish.ts";

/** Default single-compile budget — client policy (labelled; not a provider limit). Moved to finish.ts; re-exported here so existing imports keep working. */

/** The spawn seam: prod wires child_process, tests fake it. An abort on `signal` kills the child and rejects with the abort reason. */
export type EngineSpawn = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean; outputOverflow?: boolean }>;

export interface CompileInput {
  root: string;
  env: Record<string, string | undefined>;
  spawn: EngineSpawn;
  /** Host cancellation: reaches the engine child; an abort rejects the compile with the abort reason. */
  signal?: AbortSignal;
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
  | { kind: "errors"; engineVersion: string; entry: string; diagnostics: CompileDiagnostic[]; truncated: boolean; wrotePdf?: string | null }
  | { kind: "refusal"; code: "COMPILE_ENGINE_MISSING" | "COMPILE_NO_ENTRY" | "COMPILE_TIMEOUT"; message: string };

/** Deterministic human text the tool/CLI both render from an outcome. Refusals
 * are NOT rendered here — they go through renderRefusal/refusalResult so the
 * stable `next` hint comes from the one refusal table (KTD6). */
/**
 * Tectonic runs BibTeX, not biber, and it cannot hand `../` paths to an external tool. The layout this package creates keeps the
 * bibliography at refs/references.bib beside manuscript/, so a biblatex setup fails with an error that is precise but not actionable.
 */
const BIBTEX_HINT = "Tectonic runs BibTeX, not biber, so biblatex with \\addbibresource cannot read the bibliography through `../`. From manuscript/ use `\\bibliographystyle{plain}` and `\\bibliography{../refs/references}` (no biblatex), cite with \\cite{citekey}, and do not copy or edit refs/references.bib.";
const EPS_HINT = "Tectonic cannot include EPS figures (its PDF driver reads PDF, PNG and JPEG). Convert each .eps to PDF (`epstopdf fig.eps`, or Inkscape) or use its PNG, then point \\includegraphics at that file; a folder compiled before with pdfLaTeX often already holds `name-eps-converted-to.pdf`.";
const HINTS: { test: RegExp; text: string }[] = [
  { test: /relative parent paths are not supported for the external tool/i, text: BIBTEX_HINT },
  { test: /biber\b.*(not found|no such file)|(not found|no such file).*biber\b/i, text: BIBTEX_HINT },
  { test: /image inclusion failed for "[^"]+\.e?ps"/i, text: EPS_HINT },
];

/** The two warnings Tectonic 0.15.0 prints on every bibliography build (README: spurious; 0.17.0 does not print them). */
const TECTONIC_015_BBL_WARNINGS = [/internal consistency problem when checking if main\.bbl changed/i, /TeX rerun seems needed, but stopping at \d+ passes/i];
const KNOWN_BBL_NOTE = "note: the main.bbl / TeX rerun warnings above are Tectonic 0.15.0 behavior on every bibliography build (0.17.0 does not print them); they are not caused by the document, so editing it or changing the bibliography style will not clear them.";

export function describeOutcome(outcome: Exclude<CompileOutcome, { kind: "refusal" }>, engineNoun = "tectonic"): string {
  const d = outcome.diagnostics;
  const errors = d.filter((x) => x.severity === "error");
  const warnings = d.filter((x) => x.severity === "warning");
  const head =
    outcome.kind === "compiled"
      ? `Compiled ${outcome.entry} with ${engineNoun} ${outcome.engineVersion} → ${outcome.pdfPath} (${outcome.pdfSizeBytes} bytes). ${errors.length} error(s), ${warnings.length} warning(s).`
      : `Compile failed: ${outcome.entry} — ${errors.length} error(s), ${warnings.length} warning(s) from ${engineNoun} ${outcome.engineVersion}.`;
  // Errors first: a real manuscript prints dozens of warnings, and the cause of a failure must be the first line read (each group keeps engine order).
  const lines = [...errors, ...warnings].map((x) => {
    const at = [x.file, x.line].filter((v) => v !== undefined).join(":");
    return `- ${x.severity}${at ? ` ${at}` : ""}: ${x.message}`;
  });
  if (outcome.truncated) lines.push(`- (diagnostics truncated at the ${d.length} shown)`);
  const hint = [...new Set(HINTS.filter((h) => errors.some((x) => h.test.test(x.message))).map((h) => h.text))].map((t) => `hint: ${t}`);
  const known = outcome.kind === "compiled" && outcome.engineVersion.startsWith("0.15") && warnings.some((x) => TECTONIC_015_BBL_WARNINGS.some((re) => re.test(x.message))) ? [KNOWN_BBL_NOTE] : [];
  return [head, ...lines, ...hint, ...known].join("\n");
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

/** Prod spawn: child_process.execFile with a hard timeout and the caller's signal. Outcomes are told apart in this order:
 * an abort rejects with the abort reason (Node also kills the child; it is never a timeout); a maxBuffer overflow is
 * ERR_CHILD_PROCESS_STDIO_MAXBUFFER (outputOverflow); the timeout kills with killSignal, which sets `killed` and `signal`
 * (timedOut); anything else is a nonzero exit as code, and the engine's failure text still travels. */
export const prodSpawn: EngineSpawn = async (file, args, opts) => {
  const { execFile } = await import("node:child_process");
  const execFileAsync = promisify(execFile);
  try {
    const r = await execFileAsync(file, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: ENGINE_OUTPUT_CAP_BYTES,
      signal: opts.signal,
    });
    return { stdout: r.stdout, stderr: r.stderr, code: 0, timedOut: false };
  } catch (err) {
    const e = err as { code?: number | string; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
    if (opts.signal?.aborted === true) throw opts.signal.reason ?? err;
    if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: 1, timedOut: false, outputOverflow: true };
    }
    if (e.killed === true && e.signal === "SIGKILL") {
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
  // A cancelled call ends with the caller's reason (the convention scholarly.ts follows), never a refusal or an engine failure.
  input.signal?.throwIfAborted();
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
    signal: input.signal,
  });

  const parsed = parseTectonicStreams(run.stdout, run.stderr);
  // Engine-neutral finish: timeout refusal, file mapping, cap/synthetic
  // errors, errors-vs-compiled, and the `build/` PDF write. Node passes the
  // "tectonic" noun so every message stays byte-identical (pinned).
  return finishCompile({
    root: input.root,
    entryRel: entry.rel,
    engineNoun: "tectonic",
    engineVersion: engine.engine.version,
    code: run.code,
    timedOut: run.timedOut,
    timeoutMs,
    outputCapBytes: ENGINE_OUTPUT_CAP_BYTES,
    ...(run.outputOverflow === true ? { outputOverflow: true as const } : {}),
    wrotePdf: parsed.wrotePdf,
    diagnostics: parsed.diagnostics,
    truncated: parsed.truncated,
  });
}

/** Adapt the EngineSpawn seam into the version-probe shape resolveEngine takes. */
function spawnVersionProbe(spawn: EngineSpawn) {
  return async (file: string, args: string[]) => {
    const r = await spawn(file, args, { cwd: ".", timeoutMs: 10_000 });
    return { stdout: r.stdout, stderr: r.stderr };
  };
}
