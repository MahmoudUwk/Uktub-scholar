/**
 * Shared staged-package provenance for the live harness (one helper, two consumers).
 *
 * The acceptance/experiment runner (env.ts) captures the package identity at
 * staging/start via `captureStagedProvenance`; the record (in every run
 * manifest) identifies the bytes the run actually used. Per-run whole-tree
 * identity now comes from `gitTreeHash` (scripts/live/validity.ts), recorded
 * in the experiment manifest alongside this record.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, mkdtempSync, openSync, readSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Untracked files whose contents establish package identity: versioned code
 * only. Evidence, run outputs and experiment products are excluded because
 * they are products of a run, not inputs to it (a run must not certify its
 * own output as its input).
 */
const RELEVANT_UNTRACKED_PREFIXES = ["src/", "scripts/", "skills/", "config/", "tests/", "bin/"];

export const sha256Text = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Chunked file hash (1 MiB reads): no size cap, constant memory. Null when unreadable. */
export function sha256File(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    try {
      const h = createHash("sha256");
      const buf = Buffer.alloc(1024 * 1024);
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        h.update(buf.subarray(0, n));
      }
      return h.digest("hex");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** A shell capture that never throws: null when the command fails (e.g. no git, no docker). */
function capture(repo: string, cmd: string, args: string[]): string | null {
  try {
    const r = spawnSync(cmd, args, { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) return null;
    const out = String(r.stdout ?? "").trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/**
 * SHA-256 of the complete `git diff HEAD` output, of any size. `git diff` is
 * streamed to a temp file and hashed in chunks: a buffered capture truncates
 * past 1 MiB (ENOBUFS, status null) and silently loses the dirty tree. Null
 * when the diff cannot be captured (no git, no HEAD): an explicit failure
 * state, never an empty string (a clean tree hashes to the SHA-256 of empty
 * input, so empty never means "no change").
 */
function diffHash(repo: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "uktub-diff-"));
  const file = join(dir, "diff");
  try {
    const fd = openSync(file, "w");
    try {
      const r = spawnSync("git", ["diff", "HEAD"], { cwd: repo, stdio: ["ignore", fd, "ignore"] });
      if (r.status !== 0) return null;
    } finally {
      closeSync(fd);
    }
    return sha256File(file);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Sha256 of the staged consumer tarball (`pnpm pack` output under `<stage>/tar`), null when absent. */
export function tarballHash(stageDir: string): string | null {
  try {
    const tar = join(stageDir, "tar");
    if (!existsSync(tar)) return null;
    const tgz = readdirSync(tar).filter((f) => f.endsWith(".tgz")).sort();
    if (tgz.length === 0) return null;
    const h = createHash("sha256");
    const buf = Buffer.alloc(1024 * 1024);
    for (const f of tgz) {
      const fd = openSync(join(tar, f), "r");
      try {
        for (;;) {
          const n = readSync(fd, buf, 0, buf.length, null);
          if (n === 0) break;
          h.update(buf.subarray(0, n));
        }
      } finally {
        closeSync(fd);
      }
    }
    return h.digest("hex");
  } catch {
    return null;
  }
}

export interface StagedProvenance {
  commit: string;
  /** SHA-256 of the complete `git diff HEAD` output; null when the diff could not be captured (explicit failure, never ""). */
  workingTreeDiffSha256: string | null;
  /** Repo-relative untracked paths (names only, as before). */
  untracked: string[];
  /** Content hashes of the relevant untracked code (all of it, chunked; evidence and runs excluded). */
  untrackedSha256: Record<string, string>;
  /** Actual staged package hash (the tarball the sandbox installs), null when unstaged. */
  packageHash: string | null;
  /** Captured once at staging/start, never recomputed at report time. */
  capturedAt: string;
}

/**
 * Capture the package identity at staging/start. Existing consumers keep their
 * shape (`commit`, `workingTreeDiffSha256`, `untracked`); the content hashes
 * and the staged tarball hash are added, never credential values. `stageDir`
 * is the stage root (`<out>/stage`, holding `tar/` and `consumer/`), not the
 * consumer subdir.
 */
export function captureStagedProvenance(repo: string, stageDir: string): StagedProvenance {
  const commit = capture(repo, "git", ["rev-parse", "HEAD"]) ?? "";
  const diff = diffHash(repo);
  const names = (capture(repo, "git", ["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  const untrackedSha256: Record<string, string> = {};
  for (const name of names) {
    if (!RELEVANT_UNTRACKED_PREFIXES.some((p) => name.startsWith(p))) continue;
    const sha = sha256File(join(repo, name));
    if (sha !== null) untrackedSha256[name] = sha;
  }
  return {
    commit,
    workingTreeDiffSha256: diff,
    untracked: names,
    untrackedSha256,
    packageHash: tarballHash(stageDir),
    capturedAt: new Date().toISOString(),
  };
}
