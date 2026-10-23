/**
 * Schema v6 `claim_ledger`: durable verified evidence. A row is written
 * exactly when a `claim_evidence` row is released to the agent, lives as long
 * as its paper and revision, and never expires by time. Provenance takes
 * `verified` only from this table.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { ChunkTextConfig } from "../src/core/chunk.ts";
import { createRegistry, deregisterPapers, registerPaper } from "../src/core/registry.ts";
import { auditProvenance } from "../src/core/provenance/audit.ts";
import { readProvenanceInputs } from "../src/core/provenance/read.ts";
import { linesFromString, parsePaper } from "../src/core/review/latex.ts";
import {
  RUN_TTL_MS,
  claimHashOf,
  createRun,
  markDelivered,
  publishSource,
  saveEvidence,
} from "../src/core/verify/store.ts";

const NOW = new Date("2026-10-04T00:00:00Z");
const CFG: ChunkTextConfig = { chunk_tokens: 300, overlap_tokens: 0, chars_per_token: 1, boundary: "paragraph" };
const LORA = "10.48550/arxiv.2106.09685";
const DORA = "10.48550/arxiv.2402.09353";
const CLAIM = "LoRA can reduce the number of trainable parameters by 10,000 times.";

let root: string;
let db: DatabaseSync;
let revisions: Record<string, string>;
let keys: Record<string, string>;

function setupPaper(doi: string, title: string, text: string): void {
  registerPaper(db, { doi, title, authors: [] }, { now: () => NOW });
  revisions[doi] = publishSource(
    db,
    doi,
    { kind: "local-file", ref: "x.pdf", license: null, digest: doi.slice(-4).padEnd(64, "a"), extraction: "t@1", text, pageStarts: null },
    CFG,
    NOW,
  )!.revision;
  keys[doi] = (db.prepare("SELECT citekey FROM papers WHERE doi = ?").get(doi) as { citekey: string }).citekey;
}

/** A run whose evidence was judged, then the page delivered (released) to the agent. */
function releasedRun(claim: string, doi: string, when: Date, pTrue = 0.995): string {
  const runId = `run-${doi.length}-${when.getTime()}-${pTrue}`;
  createRun(
    db,
    runId,
    claim,
    { mode: "query", query: null, requested: "all", papers: [{ doi, revision: revisions[doi]!, policy: "p" }], scopeKey: "all", selected: 1, candidateIds: null, selection: [] } as never,
    { unavailable: [], unresolved: [], staleDropped: 0 },
    when,
  );
  saveEvidence(
    db,
    runId,
    [{ doi, revision: revisions[doi]!, start: 0, end: 60, page: null, chunkId: "c1", model: "m", protocol: "p", minConfidence: 0.99, pTrue }],
    when,
  );
  markDelivered(
    db,
    runId,
    [{ doi, revision: revisions[doi]!, start: 0, end: 60, released: 42 }],
    { claim, now: when },
  );
  return runId;
}

const ledgerRows = (): Record<string, string | number | null>[] =>
  (db.prepare("SELECT claim_hash, claim_text, doi, revision, char_start, char_end, page, chunk_id, model_id, protocol, min_confidence, p_true FROM claim_ledger ORDER BY doi, char_start").all() as Record<string, string | number | null>[]).map((r) => ({ ...r }));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-ledger-"));
  db = createRegistry(root);
  revisions = {};
  keys = {};
  setupPaper(LORA, "LoRA", "Intro paragraph.\n\nLoRA can reduce the number of trainable parameters by 10,000 times and memory by 3 times.");
  setupPaper(DORA, "DoRA", "DoRA decomposes weights into magnitude and direction.");
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("claim_ledger", () => {
  it("inserts a row carrying the verbatim claim exactly when evidence is released", () => {
    releasedRun(CLAIM, LORA, NOW);
    assert.deepEqual(ledgerRows(), [{
      claim_hash: claimHashOf(CLAIM),
      claim_text: CLAIM,
      doi: LORA,
      revision: revisions[LORA],
      char_start: 0,
      char_end: 60,
      page: null,
      chunk_id: "c1",
      model_id: "m",
      protocol: "p",
      min_confidence: 0.99,
      p_true: 0.995,
    }]);
  });

  it("unreleased evidence never enters the ledger", () => {
    createRun(db, "r-unrel", CLAIM, { mode: "query", query: null, requested: "all", papers: [], scopeKey: "all", selected: 1, candidateIds: null, selection: [] } as never, { unavailable: [], unresolved: [], staleDropped: 0 }, NOW);
    saveEvidence(db, "r-unrel", [{ doi: LORA, revision: revisions[LORA]!, start: 0, end: 60, page: null, chunkId: "c1", model: "m", protocol: "p", minConfidence: 0.99, pTrue: 0.999 }], NOW);
    assert.equal(ledgerRows().length, 0);
    assert.equal(readProvenanceInputs(db).ledger([CLAIM]), null);
  });

  it("released evidence survives the 24 h sweep that prunes runs and claim_evidence", () => {
    releasedRun(CLAIM, LORA, NOW);
    const later = new Date(NOW.getTime() + RUN_TTL_MS + 60_000);
    createRun(db, "fresh", "another claim", { mode: "query", query: null, requested: "all", papers: [], scopeKey: "all", selected: 0, candidateIds: null, selection: [] } as never, { unavailable: [], unresolved: [], staleDropped: 0 }, later);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM verify_runs WHERE run_id LIKE 'run-%'").get() as { n: number }).n, 0, "the old run was pruned");
    assert.equal((db.prepare("SELECT COUNT(*) n FROM claim_evidence").get() as { n: number }).n, 0, "its evidence went with it");
    assert.equal(ledgerRows().length, 1, "the ledger row survives: it never expires by time");
    assert.ok(readProvenanceInputs(db).ledger([CLAIM]) !== null);
  });

  it("removing a paper deletes its ledger rows", () => {
    releasedRun(CLAIM, LORA, NOW);
    deregisterPapers(db, [LORA]);
    assert.equal(ledgerRows().length, 0);
  });

  it("a revision change deletes the ledger rows bound to the old revision", () => {
    releasedRun(CLAIM, LORA, NOW);
    publishSource(db, LORA, { kind: "local-file", ref: "x.pdf", license: null, digest: "b".repeat(64), extraction: "t@1", text: "A different capture of the paper.", pageStarts: null }, CFG, NOW);
    assert.equal(ledgerRows().length, 0);
    assert.equal(readProvenanceInputs(db).ledger([CLAIM]), null);
  });

  it("identical wording citing a different paper is cited, not verified", () => {
    releasedRun(CLAIM, LORA, NOW);
    const tex = `\\begin{document}${CLAIM}~\\cite{${keys[DORA]}}.\\end{document}`;
    const { papers, ledger } = readProvenanceInputs(db);
    const audit = auditProvenance({ paper: parsePaper(linesFromString(tex)), tex, papers, ledger });
    assert.equal(audit.units.length, 1);
    assert.equal(audit.units[0]!.status, "cited", "the ledger row names LoRA, the unit cites DoRA");
    const tex2 = `\\begin{document}${CLAIM}~\\cite{${keys[LORA]}}.\\end{document}`;
    const audit2 = auditProvenance({ paper: parsePaper(linesFromString(tex2)), tex: tex2, papers, ledger });
    assert.equal(audit2.units[0]!.status, "verified", "control: citing the evidenced paper verifies");
  });

  it("A3 every cited paper must be evidenced: one release -> cited with the other listed, both -> verified", async () => {
    releasedRun(CLAIM, LORA, NOW);
    const tex = `\\begin{document}${CLAIM}~\\cite{${keys[LORA]}, ${keys[DORA]}}.\\end{document}`;
    const { papers, ledger } = readProvenanceInputs(db);
    const audit = auditProvenance({ paper: parsePaper(linesFromString(tex)), tex, papers, ledger });
    assert.equal(audit.units[0]!.status, "cited");
    assert.deepEqual(audit.units[0]!.unsupportedCites, [keys[DORA]]);
    releasedRun(CLAIM, DORA, new Date(NOW.getTime() + 1000));
    const second = readProvenanceInputs(db);
    const audit2 = auditProvenance({ paper: parsePaper(linesFromString(tex)), tex, papers: second.papers, ledger: second.ledger });
    assert.equal(audit2.units[0]!.status, "verified");
    assert.deepEqual(audit2.units[0]!.unsupportedCites, []);
  });

  it("raising the bar demotes a unit to cited", async () => {
    releasedRun(CLAIM, LORA, NOW, 0.995);
    const tex = `\\begin{document}${CLAIM}~\\cite{${keys[LORA]}}.\\end{document}`;
    const { papers } = readProvenanceInputs(db);
    const atDefault = auditProvenance({ paper: parsePaper(linesFromString(tex)), tex, papers, ledger: readProvenanceInputs(db).ledger });
    assert.equal(atDefault.units[0]!.status, "verified");
    const raised = auditProvenance({ paper: parsePaper(linesFromString(tex)), tex, papers, ledger: readProvenanceInputs(db, 0.999).ledger });
    assert.equal(raised.units[0]!.status, "cited", "p_true 0.995 is below the raised bar 0.999");
  });
});
