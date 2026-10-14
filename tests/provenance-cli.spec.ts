/** `uktub-scholar provenance`: the document's provenance view as a CLI command, for people. */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/main.ts";
import type { ChunkTextConfig } from "../src/core/chunk.ts";
import { createRegistry, registerPaper } from "../src/core/registry.ts";
import { publishSource } from "../src/core/verify/store.ts";

const NOW = new Date("2026-10-04T00:00:00Z");
const CFG: ChunkTextConfig = { chunk_tokens: 300, overlap_tokens: 0, chars_per_token: 1, boundary: "paragraph" };
let root: string;

async function provenance(args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["provenance", ...args], { cwd: root, out: (l) => out.push(l), err: (l) => err.push(l), now: () => NOW, env: {} });
  return { code, out, err };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prov-cli-"));
  const db = createRegistry(root);
  registerPaper(db, { doi: "10.1000/dora", title: "DoRA", authors: [] }, { now: () => NOW });
  publishSource(db, "10.1000/dora", { kind: "local-file", ref: "x.pdf", license: null, digest: "a".repeat(64), extraction: "t@1", text: "DoRA reduces memory by 24.4%.", pageStarts: null }, CFG, NOW);
  const key = (db.prepare("SELECT citekey FROM papers").get() as { citekey: string }).citekey;
  db.close();
  mkdirSync(join(root, "manuscript"), { recursive: true });
  writeFileSync(join(root, "manuscript/main.tex"), String.raw`\begin{document}DoRA cuts memory by 24.4\% on an A100~\cite{${key}}.\end{document}`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("provenance command", () => {
  it("prints the full view and exits 0 even when figures are open (it describes, it does not gate)", async () => {
    const r = await provenance([]);
    assert.equal(r.code, 0, r.err.join("\n"));
    const text = r.out.join("\n");
    assert.match(text, /# Provenance view/);
    assert.match(text, /A100/);
  });
  it("--json prints the audit as JSON", async () => {
    const r = await provenance(["--json"]);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.out.join("\n")) as { summary: { figures: { open: number } } };
    assert.equal(j.summary.figures.open, 1);
  });
  it("exits 1 with a reason when there is nothing to audit", async () => {
    const r = await provenance(["manuscript/nope.tex"]);
    assert.equal(r.code, 1);
    assert.match(r.err.join("\n"), /error:/);
  });
});
