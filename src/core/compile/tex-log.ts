/**
 * Pure BusyTeX/XeTeX log parser (Phase 7): turns the `logcat` log the
 * BusyTeX pipeline returns into engine-neutral diagnostics. Fixtures under
 * tests/fixtures/busytex/ are genuine captures from this app's own compile
 * path (see that directory's README); the grammar below is pinned to them.
 *
 * Log shape: one `$ <cmd> / EXITCODE: <n> / TEXMFLOG: / MISSFONTLOG: /
 * LOG: / STDOUT: / STDERR:` block per pipeline pass (`======` separators).
 * Only the last TeX pass log is kept in full; the bibtex8 LOG and STDOUT
 * sections duplicate each other (deduped by the `seen` key).
 *
 * Rules:
 * - `! <message>` starts an error (the first line only); a following
 *   `l.<n>` line (same block, within a few lines) gives the line, and the
 *   innermost open file from the `(`-stack gives the file where
 *   determinable. A bare `! Emergency stop.` is skipped: it always follows
 *   the real error in batchmode logs (and the finish step adds a synthetic
 *   error if a failing run somehow has no error line at all).
 * - `LaTeX Warning:`, `LaTeX Font Warning:` and `Package <name> Warning:`
 *   lines become warnings; ` on input line <n>` gives the line;
 *   `(package)`-style continuation lines join the message. `Info:` lines
 *   are noise and ignored.
 * - `Overfull`/`Underfull` box warnings become warnings with the paragraph
 *   end line (`lines A--B` reports B, matching the Tectonic line convention).
 * - BibTeX lines: `Warning--<msg>` becomes a warning; `Illegal ...---line
 *   <n> of file <f>` becomes an error with file and line; `I found no ...`
 *   and `(There w... ...)` count lines are benign bookkeeping and skipped.
 * - Errors-first cap via the shared `capDiagnostics` (same bound as Tectonic).
 */

import { capDiagnostics, type CompileDiagnostic } from "./diagnostics.ts";

export interface ParsedTexLog {
  diagnostics: CompileDiagnostic[];
  truncated: boolean;
}

const ERROR_START = /^!\s+(.*\S)\s*$/;
const ERROR_LINE = /^l\.(\d+)\b/;
const LATEX_WARNING = /^LaTeX(?:\s+Font)?\s+Warning:\s+(.*\S)\s*$/;
const PACKAGE_WARNING = /^Package\s+(\S+)\s+Warning:\s+(.*\S)\s*$/;
const INPUT_LINE = /\bon input line (\d+)\b/;
const BOX_WARNING = /^(Overfull|Underfull).*\b(?:lines \d+--(\d+)|line (\d+))\b/;
const BIBTEX_WARNING = /^\s*Warning--(.*\S)\s*$/;
const BIBTEX_ERROR = /^\s*Illegal .*?---line (\d+) of file (\S+?)\.?$/;
/** A token that looks like a source file being opened: contains a slash or carries a TeX-ish extension. */
const FILE_OPEN_TOKEN = /^[A-Za-z0-9_.\/+~:@-]+\.(tex|sty|cls|bib|bst|aux|def|cfg|clo|out|toc|idx|ind|glo|pdf|png|jpe?g|eps)$|^[A-Za-z0-9_~:@-]+(\/[A-Za-z0-9_.\-+~:@-]+)+$/;

/** Track the `(`-stack: push file-looking tokens, pop on a bare `)`. */
function trackFile(line: string, stack: string[]): void {
  const t = line.trim();
  if (t === ")") {
    stack.pop();
    return;
  }
  if (!t.startsWith("(")) return;
  const token = t.slice(1).split(/[\s(){}[\]"'`]/, 1)[0] ?? "";
  if (FILE_OPEN_TOKEN.test(token)) stack.push(token.replace(/^\.\//, ""));
}

function packageContinuation(line: string, pkg: string): string | null {
  const m = new RegExp(`^\\(${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)\\s+(.*\\S)\\s*$`).exec(line);
  return m ? (m[1] as string) : null;
}

/** Parse one BusyTeX `logcat` log into engine-neutral diagnostics. */
export function parseTexLog(log: string): ParsedTexLog {
  const all: CompileDiagnostic[] = [];
  const seen = new Set<string>();
  const push = (d: CompileDiagnostic): void => {
    const key = `${d.severity}|${d.file ?? ""}|${d.line ?? ""}|${d.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    all.push(d);
  };

  const stack: string[] = [];
  const lines = log.split("\n");
  const currentFile = (): string | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]!.endsWith(".tex")) return stack[i];
    }
    return undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    trackFile(line, stack);

    const err = ERROR_START.exec(line);
    if (err) {
      const message = err[1] as string;
      // The follow-on halt line is not a second error (fixtures:
      // missing-input, unknown-package always pair it with the real error).
      if (message === "Emergency stop.") continue;
      // The `l.<n>` context can sit past the interactive prompts and the
      // follow-on halt line (fixtures: missing-input, unknown-package):
      // accept it only across skippable lines, never past other content.
      let lineNo: number | undefined;
      for (let j = i + 1; j < Math.min(i + 13, lines.length); j++) {
        const next = lines[j]!;
        const lm = ERROR_LINE.exec(next);
        if (lm) {
          lineNo = Number(lm[1]);
          break;
        }
        const t = next.trim();
        if (
          t !== "" &&
          next !== "! Emergency stop." &&
          !t.startsWith("Type X to quit") &&
          !t.startsWith("or enter new name") &&
          !t.startsWith("Enter file name:") &&
          !t.startsWith("<read")
        ) {
          break;
        }
      }
      const file = currentFile();
      push({
        severity: "error",
        ...(file !== undefined ? { file } : {}),
        ...(lineNo !== undefined ? { line: lineNo } : {}),
        message,
      });
      continue;
    }

    const lw = LATEX_WARNING.exec(line) ?? PACKAGE_WARNING.exec(line);
    if (lw) {
      const isPackage = PACKAGE_WARNING.test(line);
      let message = (isPackage ? lw[2] : lw[1]) as string;
      // Join `(pkg)`-style or `(Name)` continuation lines (fixture: pkg-warn).
      if (isPackage) {
        const pkg = lw[1] as string;
        for (let j = i + 1; j < lines.length; j++) {
          const cont = packageContinuation(lines[j]!, pkg);
          if (cont === null) break;
          message += ` ${cont}`;
          i = j;
        }
      }
      const lm = INPUT_LINE.exec(message);
      const lineNo = lm ? Number(lm[1]) : undefined;
      const file = currentFile();
      push({
        severity: "warning",
        ...(file !== undefined ? { file } : {}),
        ...(lineNo !== undefined ? { line: lineNo } : {}),
        message,
      });
      continue;
    }

    const box = BOX_WARNING.exec(line);
    if (box) {
      const lineNo = Number(box[2] ?? box[3]);
      const file = currentFile();
      push({
        severity: "warning",
        ...(file !== undefined ? { file } : {}),
        line: lineNo,
        message: line.trim(),
      });
      continue;
    }

    const bw = BIBTEX_WARNING.exec(line);
    if (bw) {
      push({ severity: "warning", message: bw[1] as string });
      continue;
    }
    const be = BIBTEX_ERROR.exec(line);
    if (be) {
      push({ severity: "error", file: be[2] as string, line: Number(be[1]), message: line.trim() });
      continue;
    }
    // Anything else (bibtex count lines like `(There were 3 error
    // messages)`, `I found no ...` bookkeeping, `I'm skipping ...`,
    // `(Error may have been on previous line)`, bare `: ` continuations,
    // Emscripten STDERR noise) matches no rule and is ignored.
  }
  return capDiagnostics(all);
}
