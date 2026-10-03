/**
 * Pure parser for Tectonic's version-2 CLI stream output (KTD1: node:* only,
 * no I/O). Fixtures under tests/fixtures/tectonic/ are genuine captures from
 * tectonic 0.15.0 (x86_64-linux-musl); the grammar below is pinned to them:
 *
 *   note:    "version 2" Tectonic command-line interface activated
 *   note:    Writing `build/main.pdf` (3.79 KiB)
 *   error:   main.tex:3: Undefined control sequence
 *   error:   halted on potentially-recoverable error as specified
 *   warning: main.tex:5: Overfull \hbox (87.45758pt too wide) ...
 *   warning: warnings were issued by the TeX engine; ...
 *
 * Errors and warnings carry `file:line:` when the engine attributes them to a
 * source location; engine-level lines (halt notice, summary) do not. Notes on
 * stdout carry the written-PDF path, which the parser extracts so callers
 * never guess artifact locations.
 */

export const MAX_DIAGNOSTICS = 50; // client policy: bounds a single tool result

export interface CompileDiagnostic {
  severity: "error" | "warning";
  /** Engine-attributed source file, relative as tectonic printed it; engine-level lines omit it. */
  file?: string;
  line?: number;
  message: string;
}

export interface ParsedStreams {
  diagnostics: CompileDiagnostic[];
  /** Truncated because of MAX_DIAGNOSTICS (client policy). */
  truncated: boolean;
  /** Path tectonic reported writing (`note: Writing \`...\``), if any. */
  wrotePdf: string | null;
}

const DIAG_LINE = /^(error|warning):\s+(?:(.+?):(\d+):\s+)?(.+)$/;

export function parseTectonicStreams(stdout: string, stderr: string): ParsedStreams {
  const diagnostics: CompileDiagnostic[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let wrotePdf: string | null = null;

  for (const line of `${stdout}\n${stderr}`.split("\n")) {
    const pdf = /^note:\s+Writing `(.+?)`/.exec(line);
    if (pdf) {
      wrotePdf = pdf[1];
      continue;
    }
    const m = DIAG_LINE.exec(line);
    if (!m) continue;
    const severity = m[1] as CompileDiagnostic["severity"];
    const file = m[2];
    const lineNo = m[3] ? Number(m[3]) : undefined;
    const message = m[4];
    const key = `${severity}|${file ?? ""}|${lineNo ?? ""}|${message}`;
    // Tectonic reprints identical warnings on its automatic rerun; one
    // diagnostic per distinct (severity, location, message) keeps results
    // deterministic (client policy).
    if (seen.has(key)) continue;
    seen.add(key);
    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      truncated = true;
      continue;
    }
    diagnostics.push({
      severity,
      ...(file !== undefined ? { file } : {}),
      ...(lineNo !== undefined ? { line: lineNo } : {}),
      message,
    });
  }
  return { diagnostics, truncated, wrotePdf };
}
