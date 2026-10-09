/** `uktub-scholar review`: expand the manuscript, run the four measures, write the report inside the project. */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { resolveEntry } from "../compile/run.ts";
import { resolveProjectFile } from "../tools/context.ts";
import { expandSource, parsePaper } from "./latex.ts";
import { reviewPaper, type Measure } from "./measures.ts";
import { renderReport, summaryLines } from "./report.ts";

export interface ReviewInput { root: string; entry?: string; out?: string; now: () => Date }
export type ReviewOutcome = { ok: true; entry: string; reportRel: string; measures: Measure[]; summary: string[] } | { ok: false; message: string };

const MAX_FILE_BYTES = 4_000_000;
const PROTECTED = [".registry", ".git", "build", "node_modules"];

/** The report path: an explicit one (confined, new, `.md`) or reviews/<date>-slop.md with a number when that exists. */
function reportPath(root: string, out: string | undefined, date: string): { ok: true; rel: string } | { ok: false; message: string } {
  if (out === undefined) {
    for (let n = 1; n < 1000; n++) {
      const rel = `reviews/${date}-slop${n === 1 ? "" : `-${n}`}.md`;
      if (!existsSync(resolve(root, rel))) return { ok: true, rel };
    }
    return { ok: false, message: "too many reports for one day in reviews/" };
  }
  if (out.length === 0 || isAbsolute(out) || out.split(/[\\/]/).includes("..")) return { ok: false, message: `--out "${out}" must be a path inside the project (no absolute paths, no '..')` };
  const abs = resolve(root, out);
  if (!abs.startsWith(root + sep)) return { ok: false, message: `--out "${out}" resolves outside the project` };
  if (abs.split(sep).some((seg) => PROTECTED.includes(seg))) return { ok: false, message: `--out "${out}" enters a protected or generated folder` };
  if (!/\.md$/.test(abs)) return { ok: false, message: `--out "${out}" must end in .md` };
  if (existsSync(abs)) return { ok: false, message: `--out "${out}" already exists; reports are never overwritten, pick another name` };
  return { ok: true, rel: relative(root, abs).split(sep).join("/") };
}

export function reviewManuscript(i: ReviewInput): ReviewOutcome {
  const entry = resolveEntry(i.root, i.entry);
  if (!entry.ok) return { ok: false, message: entry.message };
  const lines = expandSource((rel) => {
    const f = resolveProjectFile(i.root, rel, MAX_FILE_BYTES);
    return f.ok ? readFileSync(f.abs, "utf8") : undefined;
  }, entry.rel.split(sep).join("/"));
  if (lines.length === 0) return { ok: false, message: `${entry.rel} could not be read inside the project` };
  const measures = reviewPaper(parsePaper(lines));
  const date = i.now().toISOString().slice(0, 10);
  const target = reportPath(i.root, i.out, date);
  if (!target.ok) return target;
  const abs = resolve(i.root, target.rel);
  mkdirSync(dirname(abs), { recursive: true });
  if (!realpathSync(dirname(abs)).startsWith(realpathSync(i.root) + sep)) return { ok: false, message: `${dirname(target.rel)} leaves the project (symlink)` };
  const entryRel = entry.rel.split(sep).join("/");
  writeFileSync(abs, renderReport(entryRel, date, measures), { flag: "wx" });
  return { ok: true, entry: entryRel, reportRel: target.rel, measures, summary: summaryLines(entryRel, target.rel, measures) };
}
