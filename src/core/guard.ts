/**
 * Registry guard (KTD1, R16): make the package contract enforceable against
 * the HOST's own tools, not just ours. Pure classification — the Pi adapter
 * turns a verdict into a `tool_call` block. Rules, deterministic by design:
 *
 *  - `.registry/**` is package-owned: NO agent tool touches it, read or write.
 *    Reads are covered by `list_papers`; the threat is arbitrary SQLite writes
 *    (e.g. `sqlite3` via bash), which no allow-list can characterize.
 *  - `refs/**` is registry-rendered and read-only for the agent: write tools
 *    are refused outright; bash only when destructive intent is present
 *    (redirects, rm/mv/tee/sed -i/truncate/chmod) — plain `cat`/`grep` pass.
 *
 * Honest limits (documented, not hidden): the bash rule is a scan of the
 * command text, not a shell parse. Quoted or obfuscated references can slip a
 * read through; writes into `.registry` via an indirect path (symlink,
 * `$(...)`) are out of scope by design — the sandbox is the hard boundary,
 * this guard is the seatbelt.
 */

import { isAbsolute, resolve, sep } from "node:path";

export const REGISTRY_SEGMENT = ".registry";
export const REFS_SEGMENT = "refs";

export interface GuardVerdict {
  ok: boolean;
  reason?: string;
}

const REFSDestructiveRe =
  /(>>|>|\btee\b|\brm\b|\bmv\b|\btruncate\b|\bchmod\b|\bchown\b|\bsed\b[^|]*-i\b|\bdd\b)/;

/** True when `target` (agent-nominated path) sits under `dir` inside `root`. */
function underRoot(root: string, dir: string, target: string): boolean {
  const abs = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const guardDir = resolve(root, dir) + sep;
  return abs.startsWith(guardDir);
}

function inRegistry(root: string, target: string): boolean {
  return underRoot(root, REGISTRY_SEGMENT, target) || target.split(/[\\/]/).includes(REGISTRY_SEGMENT);
}

function inRefs(root: string, target: string): boolean {
  return underRoot(root, REFS_SEGMENT, target);
}

export function guardToolCall(root: string, toolName: string, input: unknown): GuardVerdict {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const pathLike = typeof args.path === "string" ? (args.path as string) : undefined;
  const command = typeof args.command === "string" ? (args.command as string) : undefined;

  if (command !== undefined) {
    if (command.includes(REGISTRY_SEGMENT)) {
      return {
        ok: false,
        reason:
          "the .registry/ directory is package-owned (uktub-scholar); use the search_papers, " +
          "register_papers and list_papers tools for papers and the uktub-scholar CLI for administration",
      };
    }
    if (command.includes(`${REFS_SEGMENT}/`) && REFSDestructiveRe.test(command)) {
      return {
        ok: false,
        reason:
          "refs/references.bib is rendered by the registry and read-only for you; change it by " +
          "registering or deregistering papers, or run `uktub-scholar sync-bib` (human CLI) to re-render",
      };
    }
    return { ok: true };
  }

  if (pathLike !== undefined) {
    if (inRegistry(root, pathLike)) {
      return {
        ok: false,
        reason:
          "the .registry/ directory is package-owned (uktub-scholar); use the search_papers, " +
          "register_papers and list_papers tools for papers",
      };
    }
    const writeLike = toolName === "write" || toolName === "edit";
    if (writeLike && inRefs(root, pathLike)) {
      return {
        ok: false,
        reason:
          "refs/references.bib is rendered by the registry and read-only for you; change it by " +
          "registering or deregistering papers",
      };
    }
  }
  return { ok: true };
}
