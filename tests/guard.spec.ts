/**
 * Registry guard spec: pure classification of (toolName, input) against the
 * package contract — .registry package-owned (no agent tool, read or write),
 * refs/ agent-read-only (writes refused, destructive bash refused, reads pass).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { guardToolCall } from "../src/core/guard.ts";

let root: string;
root = mkdtempSync(join(tmpdir(), "uktub-guard-"));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("registry guard", () => {
  it("blocks every tool targeting .registry, write and read alike", () => {
    for (const [tool, input] of [
      ["write", { path: join(root, ".registry", "registry.db"), content: "x" }],
      ["edit", { path: ".registry/registry.db", oldString: "a", newString: "b" }],
      ["read", { path: ".registry/registry.db" }],
      ["bash", { command: "sqlite3 .registry/registry.db 'DELETE FROM papers'" }],
      ["bash", { command: "ls -la .registry" }],
    ] as const) {
      const v = guardToolCall(root, tool, input);
      assert.equal(v.ok, false, `${tool} on .registry must be blocked`);
      assert.match(v.reason!, /package-owned/);
    }
  });

  it("blocks writes into refs/ and destructive bash against it; reads pass", () => {
    const w = guardToolCall(root, "write", { path: "refs/references.bib", content: "x" });
    assert.equal(w.ok, false);
    assert.match(w.reason!, /read-only for you/);

    for (const cmd of ["echo x > refs/references.bib", "rm refs/references.bib", "tee refs/references.bib < x"]) {
      const v = guardToolCall(root, "bash", { command: cmd });
      assert.equal(v.ok, false, `${cmd} must be blocked`);
    }
    assert.ok(guardToolCall(root, "bash", { command: "cat refs/references.bib" }).ok);
    assert.ok(guardToolCall(root, "read", { path: "refs/references.bib" }).ok);
  });

  it("passes everything outside the guarded surfaces", () => {
    assert.ok(guardToolCall(root, "write", { path: "manuscript/main.tex", content: "x" }).ok);
    assert.ok(guardToolCall(root, "bash", { command: "pdflatex --version" }).ok);
    // our own tools carry no path/command: they pass untouched
    assert.ok(guardToolCall(root, "register_papers", { dois: ["10.1234/a"] }).ok);
    assert.ok(guardToolCall(root, "compile_document", { entry: "manuscript/main.tex" }).ok);
    assert.ok(guardToolCall(root, "search_papers", { query: "wifi sensing" }).ok);
  });

  it("absorbs malformed inputs without throwing (fail-open by design)", () => {
    assert.ok(guardToolCall(root, "bash", {}).ok);
    assert.ok(guardToolCall(root, "write", null).ok);
    assert.ok(guardToolCall(root, "write", "junk").ok);
  });
});
