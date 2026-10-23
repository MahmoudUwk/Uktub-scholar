/**
 * Project result files for the computed-results audit: a figure in a
 * statement or table row that cites no registered paper is searched here
 * with the same matching rules as paper figures. Read-only and confined:
 * every file goes through `resolveProjectFile`, so paths outside the root,
 * symlink escapes, protected segments and oversize files are ignored, never
 * read. Directories are never followed through symlinks.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizePaperText } from "./figures.ts";
import { resolveProjectFile } from "../tools/context.ts";
import type { ResultLine } from "./audit.ts";

/** Client policy: largest result file read (a CSV/JSON/TXT/LOG past this is truncated output, not evidence). */
export const MAX_RESULT_FILE_BYTES = 1_000_000;
/** Client policy: most result files read per audit (one project run rarely writes more). */
export const MAX_RESULT_FILES = 100;

/** Directories the walk never descends into (the tool-owned store and VCS metadata). */
const SKIP_DIRS = new Set([".git", ".registry"]);

function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (m === null) return [pattern];
  const head = pattern.slice(0, m.index);
  const tail = pattern.slice(m.index + m[0].length);
  return m[1]!.split(",").flatMap((alt) => expandBraces(`${head}${alt}${tail}`));
}

function segmentToRegExp(seg: string): RegExp {
  let out = "";
  for (const c of seg) {
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** A glob over `/`-separated segments: `*` and `?` stay inside one segment, `**` crosses segments. */
function matchSegments(pats: string[], parts: string[]): boolean {
  if (pats.length === 0) return parts.length === 0;
  if (pats[0] === "**") {
    for (let k = 0; k <= parts.length; k++) {
      if (matchSegments(pats.slice(1), parts.slice(k))) return true;
    }
    return false;
  }
  return parts.length > 0 && segmentToRegExp(pats[0]!).test(parts[0]!) && matchSegments(pats.slice(1), parts.slice(1));
}

/**
 * Every non-empty normalized line of every result file, in `file, line`
 * order: `file` is the project-relative path, `line` its 1-based line
 * number, `text` the line prepared with the paper-figure normalization so
 * `matchFigure` applies unchanged.
 */
export function collectResultLines(root: string, glob: string): ResultLine[] {
  const patterns = expandBraces(glob).map((p) => p.split("/"));
  const rels: string[] = [];
  const walk = (dirRel: string): void => {
    let entries;
    try {
      entries = readdirSync(dirRel === "" ? root : join(root, dirRel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = dirRel === "" ? e.name : `${dirRel}/${e.name}`;
      // isDirectory/isFile are lstat-based: a symlink is neither, so linked trees are never descended into.
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(rel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (patterns.some((p) => matchSegments(p, rel.split("/")))) rels.push(rel);
      }
    }
  };
  walk("");
  rels.sort();
  const out: ResultLine[] = [];
  for (const rel of rels.slice(0, MAX_RESULT_FILES)) {
    // Confinement, symlink-escape refusal and the byte cap in one check.
    if (!resolveProjectFile(root, rel, MAX_RESULT_FILE_BYTES).ok) continue;
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const norm = normalizePaperText(lines[i]!);
      if (norm !== "") out.push({ file: rel, line: i + 1, text: norm });
    }
  }
  return out;
}
