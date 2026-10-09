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

export function describeOutcome(outcome: Exclude<CompileOutcome, { kind: "refusal" }>): string {
  const d = outcome.diagnostics;
  const errors = d.filter((x) => x.severity === "error");
  const warnings = d.filter((x) => x.severity === "warning");
  const head =
    outcome.kind === "compiled"
      ? `Compiled ${outcome.entry} with tectonic ${outcome.engineVersion} → ${outcome.pdfPath} (${outcome.pdfSizeBytes} bytes). ${errors.length} error(s), ${warnings.length} warning(s).`
      : `Compile failed: ${outcome.entry} — ${errors.length} error(s), ${warnings.length} warning(s) from tectonic ${outcome.engineVersion}.`;
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

/** A diagnostic's file as a project-relative path with its extension, when it resolves to a file inside the project; otherwise as printed. */
export function projectPathOf(root: string, entryDir: string, printed: string): string {
  for (const name of [printed, `${printed}.tex`]) {
    const abs = resolve(entryDir, name);
    if (abs.startsWith(root + sep) && existsSync(abs) && statSync(abs).isFile()) return relative(root, abs);
  }
  return printed;
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
  // The engine names files as written in the source (`sections/intro`, relative to the entry's folder, no extension): give the agent a
  // path it can open, relative to the project root, whenever that file exists.
  for (const d of parsed.diagnostics) if (d.file !== undefined) d.file = projectPathOf(input.root, dirname(entry.abs), d.file);
  const hasErrors = parsed.diagnostics.some((x) => x.severity === "error") || run.code !== 0;
  if (hasErrors) {
    // A failure must say why: a non-zero exit with no parsed error line gets one synthetic error instead of a bare "0 error(s)".
    if (!parsed.diagnostics.some((x) => x.severity === "error")) {
      parsed.diagnostics.push({ severity: "error", message: `tectonic exited with code ${run.code} without printing an error line (see the warnings above, if any)` });
    }
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
