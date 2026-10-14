/** The files of a run's project folder as a user sees them. */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Paths of the regular files under `dir` (and links to regular files), relative to it. The registry and `node_modules` are not part of
 * what a user sees. A link to a directory or to nothing is skipped and never followed: the agent can create `manuscript/refs -> ../refs`,
 * which is not a file to copy or to list, and a link back up would loop.
 */
export function walkFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === ".registry" || e.name === "node_modules") return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return walkFiles(p, base);
    if (e.isSymbolicLink()) return statSync(p, { throwIfNoEntry: false })?.isFile() ? [relative(base, p)] : [];
    return [relative(base, p)];
  });
}
