/**
 * claim-verification-v2 is immutable once published: the corpus builder rebuilds corpus.json from arXiv's listing, so it must never overwrite
 * a manifest that exists unless asked to, and must say so before it touches the network. Offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("the corpus builder", () => {
  const dir = mkdtempSync(join(tmpdir(), "v2-guard-"));
  const manifest = join(dir, "corpus.json");
  writeFileSync(manifest, '{"keep":"me"}');
  const run = (...extra: string[]) => spawnSync(process.execPath, ["scripts/bench-v2-corpus.ts", "--out", join(dir, "out"), "--manifest", manifest, ...extra], { encoding: "utf8", timeout: 20_000 });

  it("refuses to overwrite an existing manifest, before it makes any request or file", () => {
    const r = run();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /already exists/);
    assert.match(r.stderr, /--rebuild/);
    assert.equal(readFileSync(manifest, "utf8"), '{"keep":"me"}', "the manifest is untouched");
    assert.equal(existsSync(join(dir, "out")), false, "nothing was created");
  });
});
