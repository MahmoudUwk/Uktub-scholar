/** The audit of a whole project directory: manuscript files, the registry's papers and its verify ledger. */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { ChunkTextConfig } from "../src/core/chunk.ts";
import { createRegistry, registerPaper } from "../src/core/registry.ts";
import { createRun, markDelivered, publishSource, saveEvidence } from "../src/core/verify/store.ts";
import { runProvenance } from "../src/core/provenance/run.ts";

const NOW = new Date("2026-10-04T00:00:00Z");
const CFG: ChunkTextConfig = { chunk_tokens: 300, overlap_tokens: 0, chars_per_token: 1, boundary: "paragraph" };
const LORA = "10.48550/arxiv.2106.09685";
const DORA = "10.48550/arxiv.2402.09353";

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-provrun-"));
  db = createRegistry(root);
  const revisions: Record<string, string> = {};
  for (const [doi, title, text] of [[LORA, "LoRA", "LoRA can reduce the number of trainable parameters by 10,000 times."], [DORA, "DoRA", "DoRA reduces training memory by 24.4% on LLaMA."]] as const) {
    registerPaper(db, { doi, title, authors: [{ family: "Hu", given: "E" }], year: 2021 } as never, { now: () => NOW });
    revisions[doi] = publishSource(db, doi, { kind: "local-file", ref: "x.pdf", license: null, digest: doi.slice(-4).padEnd(64, "a"), extraction: "t@1", text, pageStarts: null }, CFG, NOW)!.revision;
  }
  createRun(db, "r1", "LoRA can reduce the number of trainable parameters by 10,000 times.", { mode: "query", query: null, requested: "all", papers: [], scopeKey: "all", selected: 1, candidateIds: null, selection: [] } as never, { unavailable: [], unresolved: [], staleDropped: 0 }, NOW);
  saveEvidence(db, "r1", [{ doi: LORA, revision: revisions[LORA]!, start: 0, end: 60, page: null, chunkId: "c", model: "m", protocol: "p", minConfidence: 0.99, pTrue: 0.999 }], NOW);
  markDelivered(db, "r1", [{ doi: LORA, revision: revisions[LORA]!, start: 0, end: 60, released: 60 }], { claim: "LoRA can reduce the number of trainable parameters by 10,000 times.", now: NOW });
  const key = (doi: string) => (db.prepare("SELECT citekey FROM papers WHERE doi = ?").get(doi) as { citekey: string }).citekey;
  mkdirSync(join(root, "manuscript"), { recursive: true });
  writeFileSync(
    join(root, "manuscript/main.tex"),
    String.raw`\begin{document}
\input{sec}
\end{document}
`,
  );
  writeFileSync(
    join(root, "manuscript/sec.tex"),
    String.raw`\section{Results}
LoRA can reduce the number of trainable parameters by 10,000 times~\cite{${key(LORA)}}. DoRA ran on an A100~\cite{${key(DORA)}}.
`,
  );
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("runProvenance", () => {
  it("reads the entry and its \\input files, the registry's texts and its ledger", () => {
    db.close();
    const out = runProvenance({ root, now: () => NOW });
    db = createRegistry(root);
    assert.ok(out.ok, out.ok ? "" : out.message);
    if (!out.ok) return;
    assert.equal(out.entry, "manuscript/main.tex");
    assert.equal(out.audit.summary.verified, 1, "the sentence verify supported word for word");
    const open = out.audit.items.filter((i) => i.severity === "open");
    assert.deepEqual(open.map((i) => i.token), ["A100"]);
    assert.equal(open[0]!.file, "manuscript/sec.tex");
  });
  it("says why it cannot run, without throwing: no registry, no manuscript", () => {
    const bare = mkdtempSync(join(tmpdir(), "uktub-provrun-bare-"));
    try {
      const a = runProvenance({ root: bare, now: () => NOW });
      assert.equal(a.ok, false);
      mkdirSync(join(bare, ".registry"), { recursive: true });
      const b = runProvenance({ root: bare, now: () => NOW });
      assert.equal(b.ok, false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
