/**
 * The registry side of the provenance audit: paper texts as captured, and the verify ledger (`verify_runs` + `claim_evidence`),
 * which the package writes itself, so a statement's support never depends on a file the agent authors.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { ChunkTextConfig } from "../src/core/chunk.ts";
import { createRegistry, registerPaper } from "../src/core/registry.ts";
import { createRun, formatPointer, publishSource, saveEvidence, RUN_TTL_MS } from "../src/core/verify/store.ts";
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

function verifiedRun(claim: string, doi: string, when: Date, pTrue = 0.995): string {
  const runId = `run-${claim.length}-${when.getTime()}`;
  createRun(db, runId, claim, { mode: "query", query: null, requested: "all", papers: [{ doi, revision: revisions[doi]!, policy: "p" }], scopeKey: "all", selected: 1, candidateIds: null, selection: [] } as never, { unavailable: [], unresolved: [], staleDropped: 0 }, when);
  saveEvidence(db, runId, [{ doi, revision: revisions[doi]!, start: 17, end: 90, page: null, chunkId: "c1", model: "m", protocol: "p", minConfidence: 0.99, pTrue }], when);
  return runId;
}

describe("readProvenanceInputs", () => {
  it("returns every registered paper with its citekey, doi, title and captured text (null when no source is ready)", () => {
    db.prepare("DELETE FROM paper_sources WHERE doi = ?").run(DORA);
    const { papers } = readProvenanceInputs(db, NOW);
    assert.equal(papers.length, 2);
    const lora = papers.find((p) => p.doi === LORA)!;
    assert.ok(lora.citekey.length > 0);
    assert.match(lora.text ?? "", /10,000 times/);
    assert.equal(papers.find((p) => p.doi === DORA)!.text, null);
  });

  it("the ledger returns the pointers of a verify run whose claim is one of the statement's wordings", () => {
    verifiedRun(CLAIM, LORA, NOW);
    const { ledger } = readProvenanceInputs(db, NOW);
    const hit = ledger(claimVariants(`In benchmarked evaluations: ${CLAIM}`));
    assert.deepEqual(hit?.dois, [LORA]);
    assert.deepEqual(hit?.pointers, [formatPointer(LORA, revisions[LORA]!, 17, 90)]);
    assert.equal(ledger(claimVariants("A statement nobody verified.")), null);
  });

  it("ignores runs older than the retention window, evidence below its own bar, and evidence of a replaced source revision", () => {
    verifiedRun(CLAIM, LORA, new Date(NOW.getTime() - RUN_TTL_MS - 60_000));
    assert.equal(readProvenanceInputs(db, NOW).ledger(claimVariants(CLAIM)), null, "an expired run");
    const fresh = new Date(NOW.getTime() - 1000);
    verifiedRun(CLAIM, LORA, fresh, 0.5);
    assert.equal(readProvenanceInputs(db, NOW).ledger(claimVariants(CLAIM)), null, "p_true below the run's min_confidence");
    verifiedRun(CLAIM, LORA, new Date(NOW.getTime() - 500), 0.999);
    assert.ok(readProvenanceInputs(db, NOW).ledger(claimVariants(CLAIM)) !== null);
    publishSource(db, LORA, { kind: "local-file", ref: "x.pdf", license: null, digest: "b".repeat(64), extraction: "t@1", text: "A different capture of the paper.", pageStarts: null }, CFG, NOW);
    assert.equal(readProvenanceInputs(db, NOW).ledger(claimVariants(CLAIM)), null, "the pointer would resolve stale");
  });
});
