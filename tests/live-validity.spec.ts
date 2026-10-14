/**
 * Run validity (PLAN §4.5, brief decided 5–6): every measured run is VALID, BLOCKED or INVALID.
 * A `budget` outcome is VALID; a provider/auth outage (incl. invalid_grant/invalid_rapt) is BLOCKED;
 * a harness error or any assistant turn off the configured model is INVALID.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyValidity,
  gitTreeHash,
  isProviderOutage,
  validityRecord,
} from "../scripts/live/validity.ts";

const MODEL = "google-vertex/gemini-3.8-flash";

describe("isProviderOutage", () => {
  it("matches auth and provider outage signals", () => {
    for (const t of [
      "blocked: invalid_grant",
      "blocked: invalid_rapt",
      "turn agent-2: provider/model error: fetch failed",
      "HTTP 429 RESOURCE_EXHAUSTED",
      "rate limit exceeded",
    ]) {
      assert.equal(isProviderOutage(t), true, t);
    }
  });

  it("does not match budget, success or harness-side stops", () => {
    for (const t of ["budget", "wall-clock budget", "success", "give_up", "simulator sent no message", ""]) {
      assert.equal(isProviderOutage(t), false, JSON.stringify(t));
    }
  });
});

describe("classifyValidity", () => {
  const base = { assistantModel: MODEL, turnModels: [MODEL, MODEL] };
  it("success, give_up and budget outcomes are VALID", () => {
    for (const stopReason of ["success", "give_up", "budget", "wall-clock budget"]) {
      assert.equal(classifyValidity({ ...base, stopReason }), "VALID", stopReason);
    }
  });

  it("an outage stop is BLOCKED", () => {
    assert.equal(classifyValidity({ ...base, stopReason: "blocked: turn agent-1: invalid_rapt" }), "BLOCKED");
    assert.equal(classifyValidity({ ...base, stopReason: "blocked: fetch failed" }), "BLOCKED");
  });

  it("a harness error is INVALID", () => {
    assert.equal(classifyValidity({ ...base, stopReason: "error: harness crashed" }), "INVALID");
    assert.equal(classifyValidity({ ...base, stopReason: "success", harnessError: "hook failed" }), "INVALID");
  });

  it("any assistant turn off the configured model is INVALID, even on a budget outcome", () => {
    assert.equal(
      classifyValidity({ ...base, stopReason: "success", turnModels: [MODEL, "google-vertex/gemini-3.5-flash-lite"] }),
      "INVALID",
    );
    assert.equal(classifyValidity({ ...base, stopReason: "budget", turnModels: ["other/model"] }), "INVALID");
  });

  it("no turns is no evidence of a mismatch", () => {
    assert.equal(classifyValidity({ ...base, stopReason: "success", turnModels: [] }), "VALID");
  });
});

describe("validityRecord", () => {
  it("carries the manifest fields decided for every run", () => {
    const rec = validityRecord({
      scenarioId: "adapter-literature-workflow-v2",
      scenarioSha256: "abc",
      assistantModel: MODEL,
      turnModels: [MODEL],
      adcCheckedAt: "2026-10-14T00:00:00.000Z",
      treeHash: "deadbeef",
      stopReason: "budget",
    });
    assert.equal(rec.validity, "VALID");
    assert.deepEqual(rec.manifest, {
      scenarioId: "adapter-literature-workflow-v2",
      scenarioSha256: "abc",
      assistantModel: MODEL,
      turnModels: [MODEL],
      adcCheckedAt: "2026-10-14T00:00:00.000Z",
      treeHash: "deadbeef",
      validity: "VALID",
    });
  });
});

describe("gitTreeHash", () => {
  const repoWith = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "live-tree-"));
    const git = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(dir, "tracked.txt"), "a");
    return dir;
  };

  it("returns a 40-hex tree id inside git and null outside git", () => {
    assert.match(gitTreeHash(repoWith()) ?? "", /^[0-9a-f]{40}$/);
    assert.equal(gitTreeHash(mkdtempSync(join(tmpdir(), "live-notgit-"))), null);
  });

  it("identifies the whole working tree: uncommitted and untracked edits change it, ignored files do not", () => {
    const dir = repoWith();
    const before = gitTreeHash(dir);
    writeFileSync(join(dir, "ignored.txt"), "noise");
    assert.equal(gitTreeHash(dir), before);
    writeFileSync(join(dir, "untracked-new.ts"), "x");
    const withUntracked = gitTreeHash(dir);
    assert.notEqual(withUntracked, before);
    writeFileSync(join(dir, "untracked-new.ts"), "y");
    assert.notEqual(gitTreeHash(dir), withUntracked);
  });

  it("never touches the real index", () => {
    const dir = repoWith();
    const status = () => spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout;
    const s0 = status();
    gitTreeHash(dir);
    assert.equal(status(), s0);
  });
});
