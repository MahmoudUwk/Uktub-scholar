/**
 * Engine-neutral compile finish step (Phase 7): turns one engine run into
 * the tool outcome. Owns entry-dir mapping, the `build/` output write, the
 * timeout refusal text, the output-cap and synthetic errors, the
 * errors-vs-compiled decision, and the result shape — identically for the
 * Node/Tectonic run (`run.ts`) and the browser/BusyTeX run (`src/browser/`).
 *
 * Engine-specific parts stay out: locating/spawning Tectonic (`run.ts`), the
 * Tectonic stream grammar (`diagnostics.ts`), the TeX-log grammar
 * (`tex-log.ts`), and running BusyTeX in the page (`web/`, `src/browser/`).
 * The `node:fs`/`node:path` use below is covered by the browser build's
 * shims (`tests-browser/build.mjs` ALIAS_TABLE), as with `run.ts`.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";

import type { CompileOutcome } from "./run.ts";
import { capDiagnostics, type CompileDiagnostic } from "./diagnostics.ts";

/** Default single-compile budget — client policy (labelled; not a provider limit). */
export const DEFAULT_COMPILE_TIMEOUT_MS = 120_000;
/** Env override for the budget, in seconds — client policy (labelled). */
export const COMPILE_TIMEOUT_ENV = "UKTUB_COMPILE_TIMEOUT_S";
export const BUILD_DIR = "build";

/** Client policy: the cap on engine stdout/stderr (child_process maxBuffer). Labelled; not a provider or OS limit. */
export const ENGINE_OUTPUT_CAP_BYTES = 16 * 1024 * 1024;

/** Timeout budget: env override (seconds) wins, else the client-policy default. */
export function timeoutMsFromEnv(env: Record<string, string | undefined>): number {
  const raw = env[COMPILE_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return DEFAULT_COMPILE_TIMEOUT_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 5) return DEFAULT_COMPILE_TIMEOUT_MS;
  return Math.round(seconds * 1000);
}

/** A diagnostic's file as a project-relative path with its extension, when it resolves to a file inside the project; otherwise as printed. */
export function projectPathOf(root: string, entryDir: string, printed: string): string {
  for (const name of [printed, `${printed}.tex`]) {
    const abs = resolve(entryDir, name);
    if (abs.startsWith(root + sep) && existsSync(abs) && statSync(abs).isFile()) return relative(root, abs);
  }
  return printed;
}

/**
 * One finished engine run, whichever engine produced it. `pdf` carries the
 * engine-returned bytes (browser/BusyTeX); `undefined` selects the legacy
 * Node/Tectonic path where the engine wrote the PDF itself and reported it
 * via `wrotePdf`. `null`/empty bytes mean the engine returned nothing.
 */
export interface FinishedRun {
  root: string;
  /** Project-relative entry, already validated by `resolveEntry`. */
  entryRel: string;
  /** Labels the timeout/overflow/synthetic messages: "tectonic" (Node) or "busytex" (browser). */
  engineNoun: string;
  engineVersion: string;
  /** Engine exit code. */
  code: number;
  timedOut: boolean;
  timeoutMs: number;
  /** Set when the engine output was cut by a cap (Node: 16 MiB maxBuffer; browser: worker log cap). */
  outputOverflow?: boolean;
  /** Names the cap in the overflow message (Node: ENGINE_OUTPUT_CAP_BYTES). */
  outputCapBytes: number;
  pdf?: Uint8Array | null;
  /** Tectonic `note: Writing ...` path (Node only). */
  wrotePdf?: string | null;
  diagnostics: CompileDiagnostic[];
  truncated: boolean;
}

/** `bytes` rendered the way the old inline message did ("16 MiB", "1.0 MB"). */
function capLabel(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return Number.isInteger(mib) ? `${mib} MiB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function syntheticError(noun: string, code: number): CompileDiagnostic {
  return {
    severity: "error",
    message: `${noun} exited with code ${code} without printing an error line (see the warnings above, if any)`,
  };
}

/**
 * Finish one engine run: timeout refusal, file mapping, cap/synthetic
 * errors, errors-vs-compiled, and the `build/` PDF write. Node behavior is
 * pinned byte-identical by `tests/compile-node-pin.spec.ts` — keep the
 * "tectonic" noun path unchanged.
 */
export function finishCompile(run: FinishedRun): CompileOutcome {
  // A cancelled call ends with the caller's reason (the convention
  // scholarly.ts follows), never a refusal or an engine failure — enforced
  // by the caller throwing on abort before reaching here.
  if (run.timedOut) {
    return {
      kind: "refusal",
      code: "COMPILE_TIMEOUT",
      message: `${run.engineNoun} exceeded the ${Math.round(run.timeoutMs / 1000)}s budget (${COMPILE_TIMEOUT_ENV} overrides it in seconds)`,
    };
  }

  const entryDir = dirname(resolve(run.root, run.entryRel));
  // The engine names files as written in the source (`sections/intro`,
  // relative to the entry's folder, no extension): give the agent a path it
  // can open, relative to the project root, whenever that file exists.
  const diagnostics = run.diagnostics.map((d) =>
    d.file === undefined ? d : { ...d, file: projectPathOf(run.root, entryDir, d.file) },
  );
  if (run.outputOverflow === true) {
    // Client policy cap: the output was cut off, so the streams cannot be trusted to be complete; say so instead of a bare exit code.
    diagnostics.push({
      severity: "error",
      message: `${run.engineNoun}'s output exceeded the ${capLabel(run.outputCapBytes)} output cap (client policy) and was cut off, so the build log is incomplete; reduce the log volume (for example the number of warnings) and compile again`,
    });
  }
  const hasErrors = diagnostics.some((x) => x.severity === "error") || run.code !== 0 || run.outputOverflow === true;
  if (hasErrors) {
    // A failure must say why: a non-zero exit with no parsed error line gets one synthetic error instead of a bare "0 error(s)".
    if (!diagnostics.some((x) => x.severity === "error")) {
      diagnostics.push(syntheticError(run.engineNoun, run.code));
    }
    return { kind: "errors", engineVersion: run.engineVersion, entry: run.entryRel, diagnostics, truncated: run.truncated, wrotePdf: run.wrotePdf ?? null };
  }
  if (run.pdf !== undefined) {
    // Browser/BusyTeX path: the engine returned the bytes (or nothing).
    // Compiled only when PDF bytes exist AND no error line was parsed (the
    // hasErrors check above) — this guards BusyTeX's exit-0-after-failure
    // mapping, where a failed run still reports exit code 0.
    if (run.pdf === null || run.pdf.length === 0) {
      return {
        kind: "errors", engineVersion: run.engineVersion, entry: run.entryRel,
        diagnostics: [...diagnostics, syntheticError(run.engineNoun, run.code)], truncated: run.truncated, wrotePdf: null,
      };
    }
    const base = basename(run.entryRel, extname(run.entryRel));
    const abs = resolve(run.root, BUILD_DIR, `${base}.pdf`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, run.pdf);
    return {
      kind: "compiled", engineVersion: run.engineVersion, entry: run.entryRel,
      pdfPath: `${BUILD_DIR}/${base}.pdf`, pdfSizeBytes: run.pdf.length, diagnostics, truncated: run.truncated,
    };
  }
  const pdfAbs = run.wrotePdf !== undefined && run.wrotePdf !== null ? resolve(entryDir, run.wrotePdf) : null;
  const pdfRel = pdfAbs !== null && pdfAbs.startsWith(run.root + sep) ? relative(run.root, pdfAbs) : null;
  const size = pdfAbs !== null && existsSync(pdfAbs) ? statSync(pdfAbs).size : null;
  return {
    kind: "compiled",
    engineVersion: run.engineVersion,
    entry: run.entryRel,
    pdfPath: pdfRel,
    pdfSizeBytes: size,
    diagnostics,
    truncated: run.truncated,
  };
}

/** Re-exported so both engine grammars cap errors-first alike. */
export { capDiagnostics };
