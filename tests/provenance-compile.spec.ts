/** The compile tool's provenance block: additive, best effort, switchable. */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { ChunkTextConfig } from "../src/core/chunk.ts";
import { createRegistry, registerPaper } from "../src/core/registry.ts";
import { publishSource } from "../src/core/verify/store.ts";
import { provenanceBlock } from "../src/core/tools/compile.ts";
import type { ToolContext } from "../src/core/tools/context.ts";

const NOW = new Date("2026-10-04T00:00:00Z");
const CFG: ChunkTextConfig = { chunk_tokens: 300, overlap_tokens: 0, chars_per_token: 1, boundary: "paragraph" };
const DORA = "10.48550/arxiv.2402.09353";

let root: string;
let db: DatabaseSync;
const ctx = (env: Record<string, string | undefined> = {}): ToolContext => ({ root, env, now: () => NOW }) as unknown as ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-provcomp-"));
  db = createRegistry(root);
  registerPaper(db, { doi: DORA, title: "DoRA", authors: [] }, { now: () => NOW });
  publishSource(db, DORA, { kind: "local-file", ref: "x.pdf", license: null, digest: "a".repeat(64), extraction: "t@1", text: "DoRA reduces memory by 24.4% on LLaMA.", pageStarts: null }, CFG, NOW);
  const key = (db.prepare("SELECT citekey FROM papers WHERE doi = ?").get(DORA) as { citekey: string }).citekey;
  mkdirSync(join(root, "manuscript"), { recursive: true });
  writeFileSync(join(root, "manuscript/main.tex"), String.raw`\begin{document}\section{R}DoRA cuts memory by 24.4\% on an A100~\cite{${key}}. Extra words follow here for the count.\end{document}`);
  db.close();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("provenanceBlock", () => {
  it("returns the summary lines and a structured summary with the open items", () => {
    const b = provenanceBlock(ctx(), "manuscript/main.tex");
    assert.ok(b !== null);
    assert.match(b!.lines.join("\n"), /^provenance: 2 statements/m, "the uncited sentence is audited too (D1)");
    assert.match(b!.lines.join("\n"), /^UNLABELLED L\d+ \[sentence\]/m, "and it is listed as unlabelled and not verified");
    assert.match(b!.lines.join("\n"), /OPEN L\d+ \[sentence\] A100 — not found in /);
    assert.equal(b!.structured.figures.open, 1);
    assert.deepEqual(b!.structured.items.map((i) => i.token), ["A100"]);
    assert.ok(b!.structured.words > 5);
  });
  it("is switched off by UKTUB_PROVENANCE=off, and absent without a registry or a manuscript", () => {
    assert.equal(provenanceBlock(ctx({ UKTUB_PROVENANCE: "off" }), "manuscript/main.tex"), null);
    assert.equal(provenanceBlock(ctx(), "manuscript/missing.tex"), null);
    rmSync(join(root, ".registry"), { recursive: true, force: true });
    assert.equal(provenanceBlock(ctx(), "manuscript/main.tex"), null);
  });
});
