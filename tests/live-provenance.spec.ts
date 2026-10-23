/**
 * Shared provenance helper: deterministic hashes and staged-package identity.
 * Offline; no providers, no docker, no network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureStagedProvenance, sha256File, sha256Text, tarballHash,
} from "../scripts/live/provenance.ts";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

describe("provenance fingerprints", () => {
  it("hashes text and files deterministically and changes when bytes change", () => {
    const root = mkdtempSync(join(tmpdir(), "uktub-prov-"));
    try {
      writeFileSync(join(root, "a.txt"), "hello");
      assert.equal(sha256Text("hello"), sha("hello"));
      assert.equal(sha256File(join(root, "a.txt")), sha("hello"));
      assert.equal(sha256File(join(root, "missing.txt")), null);
      writeFileSync(join(root, "a.txt"), "goodbye");
      assert.equal(sha256File(join(root, "a.txt")), sha("goodbye"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("uses the real stage dir shape (stage/tar), not the consumer subdir", () => {
    const root = mkdtempSync(join(tmpdir(), "uktub-prov-"));
    const stage = mkdtempSync(join(tmpdir(), "uktub-stage-"));
    try {
      mkdirSync(join(stage, "tar"), { recursive: true });
      mkdirSync(join(stage, "consumer"), { recursive: true });
      writeFileSync(join(stage, "tar", "uktub-scholar-0.2.0.tgz"), "fake-tarball");
      writeFileSync(join(root, "notes.txt"), "not code");
      assert.equal(captureStagedProvenance(root, stage).packageHash, sha("fake-tarball"));
      assert.equal(captureStagedProvenance(root, join(stage, "consumer")).packageHash, null, "the tarball lives in stage/tar, not in the consumer subdir");
      assert.equal(tarballHash(mkdtempSync(join(tmpdir(), "uktub-empty-"))), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    }
  });
  it("hashes every relevant untracked file with no size or count caps", () => {
    const root = mkdtempSync(join(tmpdir(), "uktub-prov-"));
    const stage = mkdtempSync(join(tmpdir(), "uktub-stage-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: root });
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "big.ts"), `x = "${"y".repeat(300 * 1024)}";\n`);
      for (let i = 0; i < 210; i++) writeFileSync(join(root, "src", `f${i}.ts`), `export const v${i} = ${i};\n`);
      const p = captureStagedProvenance(root, stage);
      assert.ok(p.untrackedSha256["src/big.ts"] !== undefined, "a 300KB code file is hashed, not skipped");
      assert.equal(Object.keys(p.untrackedSha256).length, 211, "all 211 code files are hashed, not capped at 200");
      assert.ok(!JSON.stringify(p).includes("y".repeat(64)), "hashes, never contents");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    }
  });
});

describe("large dirty diffs are hashed whole, never dropped", () => {
  it("the recorded hash equals the SHA-256 of the complete `git diff HEAD` output past 1.5 MB", () => {
    const repo = mkdtempSync(join(tmpdir(), "uktub-bigdiff-"));
    const stage = mkdtempSync(join(tmpdir(), "uktub-bigdiff-stage-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: repo });
      spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      spawnSync("git", ["config", "user.name", "test"], { cwd: repo });
      writeFileSync(join(repo, "seed.txt"), "seed\n");
      spawnSync("git", ["add", "seed.txt"], { cwd: repo });
      spawnSync("git", ["commit", "-qm", "seed"], { cwd: repo });
      writeFileSync(join(repo, "big.txt"), `${"dirty line of working-tree content\n".repeat(50000)}`); // ~1.7 MB of dirty diff
      spawnSync("git", ["add", "big.txt"], { cwd: repo }); // staged but uncommitted: still `git diff HEAD`, over the 1 MiB buffer
      const full = spawnSync("git", ["diff", "HEAD"], { cwd: repo, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
      assert.equal(full.status, 0);
      assert.ok((full.stdout as Buffer).length > 1.5 * 1024 * 1024, `fixture diff is ${(full.stdout as Buffer).length} bytes, need > 1.5 MB`);
      const expected = createHash("sha256").update(full.stdout as Buffer).digest("hex");
      const p = captureStagedProvenance(repo, stage);
      assert.match(p.workingTreeDiffSha256 ?? "", /^[0-9a-f]{64}$/, "a large diff must hash whole, not record an empty string");
      assert.equal(p.workingTreeDiffSha256, expected);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it("a diff that cannot be captured is an explicit null, never an empty string", () => {
    const repo = mkdtempSync(join(tmpdir(), "uktub-nogit-"));
    const stage = mkdtempSync(join(tmpdir(), "uktub-nogit-stage-"));
    try {
      const p = captureStagedProvenance(repo, stage);
      assert.equal(p.workingTreeDiffSha256, null);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    }
  });
});
