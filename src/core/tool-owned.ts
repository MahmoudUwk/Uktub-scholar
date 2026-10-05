/**
 * The two tool-owned paths (AGENTS.md: agent read-only, human writable): `.registry/` and `refs/references.bib`. The bibliography is
 * rendered from the registry and overwritten on the next registry write, so an agent's hand edit is both lost and, worse, a source
 * of invented entries. A host adapter asks here before letting an agent write; the human is never blocked. Not a sandbox: a shell
 * can still reach the files, this stops the ordinary edit/write route.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/** The nearest directory at or above `cwd` that holds a `.registry/`, or null when `cwd` is not inside a project. */
function projectRootAt(cwd: string): string | null {
  let dir = resolve(cwd);
  const stop = parse(dir).root;
  while (true) {
    if (existsSync(join(dir, ".registry"))) return dir;
    if (dir === stop) return null;
    dir = dirname(dir);
  }
}

/** A refusal reason when an agent write to `path` (relative to `cwd`) would touch a tool-owned file, else null. */
export function toolOwnedViolation(cwd: string, path: string): string | null {
  const root = projectRootAt(cwd);
  if (root === null || path.trim().length === 0) return null;
  const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  const parts = rel.split(sep);
  if (parts[0] === ".registry") {
    return "`.registry/` belongs to the registry service. Do not write it or work around this; use the paper_registry tool, or ask the user.";
  }
  if (rel === join("refs", "references.bib")) {
    return "refs/references.bib is rendered from the registry and overwritten on the next registry write, so an agent edit is lost and cannot add a real paper. Register papers with paper_registry (needs a DOI or arXiv id from search_papers or the user); if the paper cannot be found, tell the user. Do not create or invent an entry or a claim about a paper you could not find; only if the user insists on a stub, write a marked placeholder with just the fields the user gave, in a separate .bib file.";
  }
  return null;
}

const REGISTRY = String.raw`(?:[^\s|;&"']*[/\\])?\.registry(?:[/\\][^\s|;&"']*)?`;
const BIB = String.raw`[^\s|;&"']*references\.bib`;
const TARGET = `(?:${REGISTRY}|${BIB})`;
const DESTRUCTIVE: RegExp[] = [
  // verbs that remove, move or empty their operands (the target anywhere in the same simple command)
  new RegExp(String.raw`(?:^|[\s;&|(])(?:rm|rmdir|unlink|shred|mv|truncate|dd)\b[^;&|\n]*${TARGET}`),
  new RegExp(String.raw`\bgit\s+clean\b[^;&|\n]*${TARGET}`),
  new RegExp(String.raw`\bfind\b[^;&|\n]*(?:\.registry|references\.bib)[^;&|\n]*-delete|\bfind\b[^;&|\n]*-delete[^;&|\n]*(?:\.registry|references\.bib)`),
  // writes onto the target: redirection, tee, in-place sed, cp with the target last
  new RegExp(String.raw`>>?\s*${TARGET}`),
  new RegExp(String.raw`\btee\b[^;&|\n]*${TARGET}`),
  new RegExp(String.raw`\bsed\s+-[a-zA-Z.]*i[^;&|\n]*${TARGET}`),
  new RegExp(String.raw`\bcp\b[^;&|\n]*\s${TARGET}\s*(?:$|[;&|])`),
];

/**
 * A reason to ask the human first when a shell command would remove, move, empty or overwrite the registry directory or the rendered
 * bibliography, else null. A heuristic over the command text for the common spellings (the edit/write route is blocked outright above);
 * a shell can always be spelled around it, so this is a speed bump for honest mistakes, not a sandbox.
 */
export function destructiveToolOwnedCommand(command: string): string | null {
  if (!DESTRUCTIVE.some((re) => re.test(command))) return null;
  const registry = new RegExp(REGISTRY).test(command);
  return registry
    ? "This command would delete or overwrite the project's `.registry/` (the paper registry, extracted sources and cached judgments). That cannot be undone, and refs/references.bib is rendered from it."
    : "This command would overwrite or delete refs/references.bib. It is rendered from the registry (`uktub-scholar sync-bib` or paper_registry sync_bibliography restores it), but the file is the project's bibliography.";
}
