/**
 * The registry side of the provenance audit: paper texts as captured, and the
 * durable verify ledger (`claim_ledger`), which the package writes itself when
 * evidence is released, so a statement's support never depends on a file the
 * agent authors.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { ChunkTextConfig } from "../src/core/chunk.ts";
import { createRegistry, registerPaper } from "../src/core/registry.ts";
import { createRun, formatPointer, markDelivered, publishSource, saveEvidence } from "../src/core/verify/store.ts";
import { readProvenanceInputs } from "../src/core/provenance/read.ts";
import { claimVariants } from "../src/core/provenance/audit.ts";

const NOW = new Date("2026-10-04T00:00:00Z");
const CFG: ChunkTextConfig = { chunk_tokens: 300, overlap_tokens: 0, chars_per_token: 1, boundary: "paragraph" };
const LORA = "10.48550/arxiv.2106.09685";
const DORA = "10.48550/arxiv.2402.09353";
const CLAIM = "LoRA can reduce the number of trainable parameters by 10,000 times.";

let root: string;
let db: DatabaseSync;
let revisions: Record<string, string>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-prov-"));
  db = createRegistry(root);
  revisions = {};
  for (const [doi, title, text] of [[LORA, "LoRA", "Intro paragraph.\n\nLoRA can reduce the number of trainable parameters by 10,000 times and memory by 3 times."], [DORA, "DoRA", "DoRA decomposes weights into magnitude and direction."]] as const) {
    registerPaper(db, { doi, title, authors: [] }, { now: () => NOW });
    revisions[doi] = publishSource(db, doi, { kind: "local-file", ref: "x.pdf", license: null, digest: doi.slice(-4).padEnd(64, "a"), extraction: "t@1", text, pageStarts: null }, CFG, NOW)!.revision;
  }
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function releasedRun(claim: string, doi: string, when: Date, pTrue = 0.995, start = 17, end = 90): string {
  const runId = `run-${claim.length}-${when.getTime()}-${pTrue}-${start}-${end}`;
  createRun(db, runId, claim, { mode: "query", query: null, requested: "all", papers: [{ doi, revision: revisions[doi]!, policy: "p" }], scopeKey: "all", selected: 1, candidateIds: null, selection: [] } as never, { unavailable: [], unresolved: [], staleDropped: 0 }, when);
  saveEvidence(db, runId, [{ doi, revision: revisions[doi]!, start, end, page: null, chunkId: "c1", model: "m", protocol: "p", minConfidence: 0.99, pTrue }], when);
  markDelivered(db, runId, [{ doi, revision: revisions[doi]!, start, end, released: 42 }], { claim, now: when });
  return runId;
}

describe("readProvenanceInputs", () => {
  it("returns every registered paper with its citekey, doi, title and captured text (null when no source is ready)", () => {
    db.prepare("DELETE FROM paper_sources WHERE doi = ?").run(DORA);
    const { papers } = readProvenanceInputs(db);
    assert.equal(papers.length, 2);
    const lora = papers.find((p) => p.doi === LORA)!;
    assert.ok(lora.citekey.length > 0);
    assert.match(lora.text ?? "", /10,000 times/);
    assert.equal(papers.find((p) => p.doi === DORA)!.text, null);
  });

  it("the ledger returns the pointers of released verify evidence for one of the statement's wordings", () => {
    releasedRun(CLAIM, LORA, NOW);
    const { ledger } = readProvenanceInputs(db);
    const hit = ledger(claimVariants(`In benchmarked evaluations: ${CLAIM}`));
    assert.deepEqual(hit?.dois, [LORA]);
    assert.deepEqual(hit?.pointers, [formatPointer(LORA, revisions[LORA]!, 17, 90)]);
    assert.equal(ledger(claimVariants("A statement nobody verified.")), null);
  });

  it("unreleased evidence is invisible, and evidence below the current bar is filtered on read", () => {
    createRun(db, "r-unrel", CLAIM, { mode: "query", query: null, requested: "all", papers: [], scopeKey: "all", selected: 1, candidateIds: null, selection: [] } as never, { unavailable: [], unresolved: [], staleDropped: 0 }, NOW);
    saveEvidence(db, "r-unrel", [{ doi: LORA, revision: revisions[LORA]!, start: 17, end: 90, page: null, chunkId: "c1", model: "m", protocol: "p", minConfidence: 0.99, pTrue: 0.999 }], NOW);
    assert.equal(readProvenanceInputs(db).ledger(claimVariants(CLAIM)), null, "judged but never delivered");
    releasedRun(CLAIM, LORA, NOW, 0.5, 0, 30);
    assert.equal(readProvenanceInputs(db).ledger(claimVariants(CLAIM)), null, "p_true below the current bar");
    releasedRun(CLAIM, LORA, NOW, 0.999);
    assert.ok(readProvenanceInputs(db).ledger(claimVariants(CLAIM)) !== null);
  });

  it("evidence of a replaced source revision is gone with the revision", () => {
    releasedRun(CLAIM, LORA, NOW);
    publishSource(db, LORA, { kind: "local-file", ref: "x.pdf", license: null, digest: "b".repeat(64), extraction: "t@1", text: "A different capture of the paper.", pageStarts: null }, CFG, NOW);
    assert.equal(readProvenanceInputs(db).ledger(claimVariants(CLAIM)), null, "the ledger row died with its revision");
  });
});
