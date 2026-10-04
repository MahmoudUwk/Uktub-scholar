/**
 * Source/chunk/evidence storage (KTD4–KTD5, KTD8–KTD9, R11, R16): one captured
 * text per ready paper, content-addressed derived chunks and index, versioned
 * pointers that go stale instead of repointing, judgments keyed by decision
 * identity, and evidence that survives cache loss. Offline, real SQLite.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createRegistry, deregisterPapers, generationOf, registerPaper } from "../src/core/registry.ts";
import type { ChunkTextConfig } from "../src/core/chunk.ts";
import type { PreparedSource } from "../src/core/source/prepare.ts";
import {
  cachedJudgments, chunkPolicyOf, chunksOf, claimHashOf, createRun, ensureChunks, evidenceOfRun, formatPointer, getRun, getSource, RUN_TTL_MS, setRunState,
  parsePointer, passageHashOf, publishSource, recordSourceFailure, resolvePointer, revisionOf, saveEvidence, saveJudgments,
} from "../src/core/verify/store.ts";

const DOI = "10.1234/cells";
const NOW = new Date("2026-10-04T10:00:00Z");
const CFG: ChunkTextConfig = { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 1, boundary: "paragraph" }; // 256-char chunks
const CFG2: ChunkTextConfig = { ...CFG, chunk_tokens: 128 };

const para = (n: number): string => `Paragraph ${n}: ` + "battery cells age faster at high temperature. ".repeat(3).trim();
const TEXT = [0, 1, 2, 3, 4, 5].map(para).join("\n\n") + "\n\nEmoji 😀 spans stay exact.";

function source(text: string, over: Partial<PreparedSource> = {}): PreparedSource {
  return { kind: "local-file", ref: "papers/cells.pdf", license: null, digest: "d".repeat(64), extraction: "unpdf@1.8.1/pages-v1", text, pageStarts: [0], ...over };
}

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-store-"));
  db = createRegistry(root);
  registerPaper(db, { doi: DOI, title: "Cycle Life of Cells", authors: ["A. Author"], year: 2026, bibtex: "@article{x,\n title={T},\n year={2026}\n}", bibtexSource: "crossref" }, { now: () => NOW });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const sourceText = (): string => (db.prepare("SELECT text FROM paper_sources WHERE doi = ?").get(DOI) as { text: string }).text;
const rowCount = (table: string): number => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

const CARRY = { unavailable: [], unresolved: [], staleDropped: 0 };
const SNAPSHOT = { mode: "registry" as const, query: null, requested: "all" as const, papers: [{ doi: DOI, revision: "x".repeat(16), policy: "p" }], scopeKey: "all", selected: 1, candidateIds: null, selection: [], engine: "k2", model: "declared:m", protocol: "p", minConfidence: 0.99 };
const startRun = (id: string): void => createRun(db, id, "c", SNAPSHOT, CARRY, NOW);
const ev = (o: Partial<{ revision: string; start: number; end: number }>) => ({ doi: DOI, revision: "0".repeat(16), start: 0, end: 30, page: 1, chunkId: "cid", model: ID.model, protocol: ID.protocol, minConfidence: 0.99, pTrue: 0.995, ...o });
const ID = { model: "openrouter:m1", protocol: "systemone-noul-v1" };

describe("identity helpers", () => {
  it("claim and passage hashes normalise whitespace; the revision binds digest, extraction and text", () => {
    assert.equal(claimHashOf("  a   claim "), claimHashOf("a claim"));
    assert.notEqual(claimHashOf("a claim"), claimHashOf("a claim."));
    assert.equal(passageHashOf("x"), passageHashOf("x"));
    const r = revisionOf("d1", "e1", "text");
    assert.match(r, /^[0-9a-f]{16}$/);
    assert.notEqual(r, revisionOf("d2", "e1", "text"));
    assert.notEqual(r, revisionOf("d1", "e2", "text"));
    assert.notEqual(r, revisionOf("d1", "e1", "text2"));
  });
  it("pointers round-trip, DOIs containing @ or # included, and malformed ones parse to null", () => {
    const p = formatPointer("10.1/a@b#c", "0123456789abcdef", 5, 90);
    assert.deepEqual(parsePointer(p), { doi: "10.1/a@b#c", revision: "0123456789abcdef", start: 5, end: 90 });
    for (const bad of ["", "10.1/a", "10.1/a@zz#1-2", "10.1/a@0123456789abcdef#9-3", "10.1/a@0123456789abcdef#-1-3"]) assert.equal(parsePointer(bad), null, bad);
  });
});

describe("publishSource", () => {
  it("captures the text and derives chunks whose spans slice back to their text exactly (astral included)", () => {
    const out = publishSource(db, DOI, source(TEXT), CFG, NOW);
    assert.ok(out && !out.reused && out.chunkCount > 1);
    const row = getSource(db, DOI)!;
    assert.equal(row.status, "ready");
    assert.equal(row.revision, out!.revision);
    assert.equal(row.revision, revisionOf(row.digest!, row.extraction!, TEXT));
    assert.equal(row.chunkPolicy, chunkPolicyOf(CFG));
    const chunks = chunksOf(db, DOI);
    assert.ok(chunks.every((c) => c.revision === row.revision && TEXT.slice(c.char_start, c.char_end) === c.text));
    assert.ok(chunks.some((c) => c.text.includes("😀")));
    assert.equal(new Set(chunks.map((c) => c.chunk_id)).size, chunks.length, "chunk ids are unique");
  });

  it("the same source and policy is reused: chunk rows untouched, generation not bumped again", () => {
    publishSource(db, DOI, source(TEXT), CFG, NOW);
    const before = db.prepare("SELECT rowid, chunk_id FROM chunks ORDER BY rowid").all();
    const gen = generationOf(db);
    const again = publishSource(db, DOI, source(TEXT), CFG, new Date("2026-10-05T00:00:00Z"));
    assert.equal(again!.reused, true);
    assert.deepEqual(db.prepare("SELECT rowid, chunk_id FROM chunks ORDER BY rowid").all(), before);
    assert.equal(generationOf(db), gen);
  });

  it("a changed source makes a new revision: old pointers go stale, old evidence is removed, caches survive", () => {
    const first = publishSource(db, DOI, source(TEXT), CFG, NOW)!;
    const pointer = formatPointer(DOI, first.revision, 0, 20);
    startRun("run1");
    saveEvidence(db, "run1", [ev({ revision: first.revision, end: 20 })], NOW);
    saveJudgments(db, "c", { model: "m", protocol: "p" }, [{ passageHash: passageHashOf("pass"), pTrue: 0.9 }], NOW);

    const second = publishSource(db, DOI, source("A completely different extracted text about wireless models.\n\n" + "More text. ".repeat(20), { digest: "e".repeat(64) }), CFG, NOW)!;
    assert.notEqual(second.revision, first.revision);
    assert.deepEqual(resolvePointer(db, pointer), { status: "stale", doi: DOI, currentRevision: second.revision });
    assert.equal(evidenceOfRun(db, "run1").length, 0, "evidence for the old revision is gone");
    assert.equal(rowCount("claim_evidence"), 0);
    assert.equal(cachedJudgments(db, "c", { model: "m", protocol: "p" }, [passageHashOf("pass")]).size, 1, "content-addressed judgments are kept");
    assert.ok(chunksOf(db, DOI).every((c) => c.revision === second.revision));
  });

  it("the same bytes extracted differently are a new revision even with identical text length", () => {
    const a = publishSource(db, DOI, source(TEXT), CFG, NOW)!;
    const b = publishSource(db, DOI, source(TEXT, { extraction: "unpdf@9.9.9/pages-v1" }), CFG, NOW)!;
    assert.notEqual(a.revision, b.revision);
  });

  it("rechunking under a new policy changes chunk ids but keeps the source revision and pointers", () => {
    const first = publishSource(db, DOI, source(TEXT), CFG, NOW)!;
    const ids = chunksOf(db, DOI).map((c) => c.chunk_id);
    const pointer = formatPointer(DOI, first.revision, 0, 20);
    ensureChunks(db, DOI, CFG2);
    const after = chunksOf(db, DOI);
    assert.ok(after.length > ids.length);
    assert.ok(after.every((c) => !ids.includes(c.chunk_id)), "no chunk identity is reused across policies");
    assert.equal(getSource(db, DOI)!.revision, first.revision);
    assert.equal(resolvePointer(db, pointer).status, "current");
    ensureChunks(db, DOI, CFG2); // already current: no churn
    assert.deepEqual(chunksOf(db, DOI).map((c) => c.chunk_id), after.map((c) => c.chunk_id));
  });

  it("returns null and stores nothing when the paper was removed before publication", () => {
    deregisterPapers(db, [DOI]);
    assert.equal(publishSource(db, DOI, source(TEXT), CFG, NOW), null);
    assert.equal(rowCount("paper_sources"), 0);
    assert.equal(rowCount("chunks"), 0);
  });

  it("near-empty chunks are not stored as usable passages", () => {
    publishSource(db, DOI, source(TEXT + "\n\n   \n\n12"), CFG, NOW);
    assert.ok(chunksOf(db, DOI).every((c) => c.text.replace(/\s+/g, "").length >= 20));
  });
});

describe("section-aware chunk storage", () => {
  const SEC: ChunkTextConfig = { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 1, boundary: "section" }; // 256-char cap, 64-char floor
  const sentence = "Battery cells age faster at high temperature. ";
  const SECTIONED = [`1. Introduction\n${sentence.repeat(3)}`, `2. Methods\n${sentence.repeat(2)}`, `3. Results\n${sentence.repeat(12)}`].join("\n");
  const marks = ["1. Introduction", "2. Methods", "3. Results"].map((h) => ({ start: SECTIONED.indexOf(h), heading: h, level: 1 }));
  const sectionsOf = (): { start: number; heading: string }[] | null => {
    const r = db.prepare("SELECT sections_json FROM paper_sources WHERE doi = ?").get(DOI) as { sections_json: string | null };
    return r.sections_json === null ? null : JSON.parse(r.sections_json);
  };

  it("persists the marks with the source and labels each chunk with its section; spans still slice the text exactly", () => {
    const out = publishSource(db, DOI, source(SECTIONED, { sections: marks }), SEC, NOW)!;
    assert.ok(out.chunkCount >= 4, "Results is longer than the cap and splits");
    assert.deepEqual(sectionsOf(), marks);
    const chunks = chunksOf(db, DOI);
    for (const c of chunks) {
      assert.equal(SECTIONED.slice(c.char_start, c.char_end), c.text);
      assert.ok(c.text.length <= 256);
    }
    assert.deepEqual([...new Set(chunks.map((c) => c.section))], ["1. Introduction", "2. Methods", "3. Results"]);
    assert.equal(chunks.filter((c) => c.section === "2. Methods").length, 1, "a fitting section is one chunk");
  });

  it("fixed-window policies leave the label NULL", () => {
    publishSource(db, DOI, source(SECTIONED, { sections: marks }), CFG, NOW);
    assert.ok(chunksOf(db, DOI).every((c) => c.section === null));
  });

  it("the policy identity separates section from fixed windows and is stable", () => {
    assert.notEqual(chunkPolicyOf(SEC), chunkPolicyOf({ ...SEC, boundary: "paragraph" }));
    assert.equal(chunkPolicyOf(SEC), chunkPolicyOf({ ...SEC }));
    assert.equal(chunkPolicyOf({ ...SEC, boundary: "paragraph" }), chunkPolicyOf({ ...CFG, chunk_tokens: 256 }), "fixed-window policy identities are unchanged by structure support");
  });

  it("switching a stored source to the section policy rebuilds chunks from the stored marks, keeping revision and pointers", () => {
    const { revision } = publishSource(db, DOI, source(SECTIONED, { sections: marks }), CFG, NOW)!;
    const before = getSource(db, DOI)!.chunkPolicy;
    ensureChunks(db, DOI, SEC);
    assert.notEqual(getSource(db, DOI)!.chunkPolicy, before);
    assert.equal(getSource(db, DOI)!.revision, revision);
    assert.deepEqual([...new Set(chunksOf(db, DOI).map((c) => c.section))], ["1. Introduction", "2. Methods", "3. Results"]);
    ensureChunks(db, DOI, SEC); // idempotent
    assert.equal(rowCount("chunks"), chunksOf(db, DOI).length);
  });

  it("republishing the same revision with new marks updates them and rebuilds under the same policy", () => {
    publishSource(db, DOI, source(SECTIONED, { sections: marks.slice(0, 1) }), SEC, NOW);
    assert.equal(sectionsOf()!.length, 1);
    const out = publishSource(db, DOI, source(SECTIONED, { sections: marks }), SEC, NOW)!;
    assert.equal(sectionsOf()!.length, 3);
    assert.equal(out.reused, false);
    assert.ok(chunksOf(db, DOI).some((c) => c.section === "3. Results"));
  });

  it("a PDF source stored before marks existed (NULL) gets them derived from its text when rechunked", () => {
    publishSource(db, DOI, source(SECTIONED, { sections: null }), CFG, NOW);
    assert.equal(sectionsOf(), null);
    ensureChunks(db, DOI, SEC);
    assert.deepEqual(sectionsOf()?.map((m) => m.heading), ["1. Introduction", "2. Methods", "3. Results"], "pdf headings detected from the stored text");
    assert.ok(chunksOf(db, DOI).some((c) => c.section === "3. Results"));
  });

  it("a non-PDF source without marks stays unlabelled-by-heading (nothing is guessed from TEI-derived text)", () => {
    publishSource(db, DOI, source(SECTIONED, { sections: null, extraction: "grobid-tei@fxp5.11.2/body-v1" }), CFG, NOW);
    ensureChunks(db, DOI, SEC);
    assert.equal(sectionsOf(), null);
    assert.deepEqual([...new Set(chunksOf(db, DOI).map((c) => c.section))], [""]);
  });
});

describe("one source, two papers", () => {
  it("the same document can back two registered papers (preprint and published version) with distinct chunk identities", () => {
    registerPaper(db, { doi: "10.2222/other", title: "Published Version", authors: [] }, { now: () => NOW });
    const a = publishSource(db, DOI, source(TEXT), CFG, NOW)!;
    const b = publishSource(db, "10.2222/other", source(TEXT), CFG, NOW)!;
    assert.equal(a.revision, b.revision, "identical bytes and extraction give one revision");
    const ids = [...chunksOf(db, DOI), ...chunksOf(db, "10.2222/other")].map((c) => c.chunk_id);
    assert.equal(new Set(ids).size, ids.length, "chunk ids never collide across papers");
    assert.equal(resolvePointer(db, formatPointer("10.2222/other", b.revision, 0, 20)).status, "current");
    deregisterPapers(db, ["10.2222/other"]);
    assert.ok(chunksOf(db, DOI).length > 0, "removing one paper leaves the other's source intact");
  });
});

describe("failure readiness", () => {
  it("records unavailable/failed with a normalized code and no text", () => {
    recordSourceFailure(db, DOI, "unavailable", "no_open_copy", "OpenAlex lists no open-access copy", NOW);
    const row = getSource(db, DOI)!;
    assert.deepEqual([row.status, row.failureCode, row.revision, row.textLength], ["unavailable", "no_open_copy", null, null]);
    recordSourceFailure(db, DOI, "failed", "identity_mismatch", "…", NOW);
    assert.equal(getSource(db, DOI)!.status, "failed", "a later attempt replaces an earlier failure");
  });

  it("never clobbers a ready source, and a ready publish clears an earlier failure", () => {
    recordSourceFailure(db, DOI, "failed", "download_failed", "x", NOW);
    publishSource(db, DOI, source(TEXT), CFG, NOW);
    assert.equal(getSource(db, DOI)!.status, "ready");
    assert.equal(getSource(db, DOI)!.failureCode, null);
    recordSourceFailure(db, DOI, "failed", "download_failed", "later refresh failed", NOW);
    assert.equal(getSource(db, DOI)!.status, "ready");
  });

  it("failure on a removed paper is a no-op", () => {
    deregisterPapers(db, [DOI]);
    assert.doesNotThrow(() => recordSourceFailure(db, DOI, "failed", "download_failed", "x", NOW));
  });
});

describe("resolvePointer", () => {
  it("reconstructs the exact span (page grounded) for the current revision", () => {
    const { revision } = publishSource(db, DOI, source(TEXT, { pageStarts: [0, 100] }), CFG, NOW)!;
    const start = TEXT.indexOf("Emoji");
    const end = start + "Emoji 😀 spans stay exact.".length;
    const r = resolvePointer(db, formatPointer(DOI, revision, start, end));
    assert.deepEqual(r, { status: "current", doi: DOI, revision, start, end, text: "Emoji 😀 spans stay exact.", page: 2 });
  });
  it("is removed after paper removal, unavailable for metadata-only papers, invalid out of range", () => {
    const { revision } = publishSource(db, DOI, source(TEXT), CFG, NOW)!;
    assert.equal(resolvePointer(db, formatPointer(DOI, revision, 0, TEXT.length + 5)).status, "invalid");
    assert.equal(resolvePointer(db, "nonsense").status, "invalid");
    assert.equal(resolvePointer(db, formatPointer("10.9999/none", revision, 0, 5)).status, "removed");
    registerPaper(db, { doi: "10.1111/meta", title: "Only Metadata", authors: [] }, { now: () => NOW });
    assert.equal(resolvePointer(db, formatPointer("10.1111/meta", revision, 0, 5)).status, "unavailable");
    deregisterPapers(db, [DOI]);
    assert.equal(resolvePointer(db, formatPointer(DOI, revision, 0, 5)).status, "removed");
  });
});

describe("derived locator index", () => {
  const hits = (q: string): number => (db.prepare("SELECT COUNT(*) n FROM chunk_fts WHERE chunk_fts MATCH ?").get(q) as { n: number }).n;
  it("tracks publication, replacement and paper removal", () => {
    publishSource(db, DOI, source(TEXT), CFG, NOW);
    assert.ok(hits("temperature") > 0);
    publishSource(db, DOI, source("Wireless foundation models learn representations. ".repeat(10), { digest: "f".repeat(64) }), CFG, NOW);
    assert.equal(hits("temperature"), 0, "obsolete retrieval hits are gone after replacement");
    assert.ok(hits("wireless") > 0);
    deregisterPapers(db, [DOI]);
    assert.equal(hits("wireless"), 0, "and after removal");
    assert.equal(rowCount("chunks"), 0);
  });
});

describe("judgments and evidence (KTD8)", () => {
  it("reuses a judgment only under the same claim, passage, model identity and protocol", () => {
    const h = passageHashOf("some passage");
    saveJudgments(db, "the claim", ID, [{ passageHash: h, pTrue: 0.97 }], NOW);
    assert.equal(cachedJudgments(db, "the  claim", ID, [h]).get(h), 0.97);
    assert.equal(cachedJudgments(db, "another claim", ID, [h]).size, 0);
    assert.equal(cachedJudgments(db, "the claim", { ...ID, model: "openrouter:m2" }, [h]).size, 0, "model replaced");
    assert.equal(cachedJudgments(db, "the claim", { ...ID, protocol: "noul-v2" }, [h]).size, 0, "protocol changed");
    assert.equal(cachedJudgments(db, "the claim", ID, [passageHashOf("other")]).size, 0);
  });

  it("stored evidence is reconstructable with every judgment cache row deleted", () => {
    const { revision } = publishSource(db, DOI, source(TEXT), CFG, NOW)!;
    saveJudgments(db, "c", ID, [{ passageHash: passageHashOf("p"), pTrue: 0.995 }], NOW);
    startRun("r");
    saveEvidence(db, "r", [ev({ revision, end: 30 })], NOW);
    db.exec("DELETE FROM claim_judgments");
    const [e] = evidenceOfRun(db, "r");
    assert.deepEqual([e.model, e.protocol, e.minConfidence, e.pTrue], [ID.model, ID.protocol, 0.99, 0.995]);
    assert.equal(e.title, "Cycle Life of Cells");
    assert.equal((resolvePointer(db, formatPointer(DOI, e.revision, e.start, e.end)) as { text: string }).text, TEXT.slice(0, 30));
  });

  it("evidence is scoped to its run and returned in reading order", () => {
    const { revision } = publishSource(db, DOI, source(TEXT), CFG, NOW)!;
    startRun("a");
    startRun("b");
    saveEvidence(db, "a", [ev({ revision, start: 100, end: 160 }), ev({ revision, start: 0, end: 30 })], NOW);
    saveEvidence(db, "b", [ev({ revision, start: 50, end: 90 })], NOW);
    assert.deepEqual(evidenceOfRun(db, "a").map((e) => e.start), [0, 100]);
    assert.deepEqual(evidenceOfRun(db, "b").map((e) => e.start), [50]);
    assert.equal(evidenceOfRun(db, "none").length, 0);
  });

  it("evidence judged against a revision that was replaced meanwhile is dropped, not published", () => {
    const old = publishSource(db, DOI, source(TEXT), CFG, NOW)!;
    publishSource(db, DOI, source("Wholly new text about something else entirely, long enough to chunk. ".repeat(6), { digest: "9".repeat(64) }), CFG, NOW);
    startRun("r");
    assert.equal(saveEvidence(db, "r", [ev({ revision: old.revision })], NOW), 1, "one row dropped");
    assert.equal(rowCount("claim_evidence"), 0);
  });

  it("removing the paper removes its evidence; deleting the run removes its evidence", () => {
    const { revision } = publishSource(db, DOI, source(TEXT), CFG, NOW)!;
    startRun("r");
    saveEvidence(db, "r", [ev({ revision })], NOW);
    db.exec("DELETE FROM verify_runs");
    assert.equal(rowCount("claim_evidence"), 0, "run → evidence cascade");
    startRun("r2");
    saveEvidence(db, "r2", [ev({ revision })], NOW);
    deregisterPapers(db, [DOI]);
    assert.equal(rowCount("claim_evidence"), 0);
    assert.equal(rowCount("paper_sources"), 0);
  });

  it("runs capture a snapshot, track unfinished work, and expire", () => {
    startRun("r");
    assert.deepEqual(getRun(db, "r", NOW)!.snapshot.papers, [{ doi: DOI, revision: "x".repeat(16), policy: "p" }]);
    assert.equal(getRun(db, "r", NOW)!.nextWork, null);
    setRunState(db, "r", 7, CARRY);
    assert.equal(getRun(db, "r", NOW)!.nextWork, 7);
    assert.equal(getRun(db, "r", new Date(NOW.getTime() + RUN_TTL_MS + 1000)), null, "expired runs are refused");
    createRun(db, "later", "c", SNAPSHOT, CARRY, new Date(NOW.getTime() + RUN_TTL_MS + 5000));
    assert.equal(getRun(db, "r", NOW), null, "creating a run prunes expired ones");
  });

  it("registry mutations advance the generation counter", () => {
    const g0 = generationOf(db);
    registerPaper(db, { doi: "10.1111/two", title: "Second", authors: [] }, { now: () => NOW });
    const g1 = generationOf(db);
    assert.ok(g1 > g0);
    deregisterPapers(db, ["10.1111/two"]);
    assert.ok(generationOf(db) > g1);
    publishSource(db, DOI, source(TEXT), CFG, NOW);
    assert.ok(generationOf(db) > g1);
  });
});
