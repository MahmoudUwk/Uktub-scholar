/**
 * claim-verification-v2 fetch: downloads exactly the papers corpus.json lists and checks each file against the manifest, so anyone can
 * rebuild the paper texts the claims were written against. The decisions (what to download, whether a file is the right one) are offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { planFetch, verifyPdf } from "../scripts/bench-v2-fetch.ts";

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const bytes = new TextEncoder().encode("%PDF-1.7 pretend paper");
const paper = (id: string, over: Partial<{ sha256: string; bytes: number }> = {}) => ({ id, sha256: sha(bytes), bytes: bytes.length, pdfUrl: `https://arxiv.org/pdf/${id}`, ...over });

describe("verifying a downloaded PDF against the manifest", () => {
  it("accepts the file whose sha256 and size are the recorded ones", () => {
    assert.deepEqual(verifyPdf(bytes, paper("2610.00001v1")), { ok: true });
  });
  it("rejects a file with another hash, and says the hashes it saw", () => {
    const other = new TextEncoder().encode("%PDF-1.7 a different file!");
    const r = verifyPdf(other, paper("2610.00001v1", { bytes: other.length }));
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /sha256/);
  });
  it("rejects a file of the wrong size even before hashing it", () => {
    const r = verifyPdf(bytes, paper("2610.00001v1", { bytes: bytes.length + 1 }));
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /size/);
  });
});

describe("what to download", () => {
  const papers = [paper("a"), paper("b"), paper("c")];
  it("skips a paper already on disk with the right hash, downloads a missing one, and flags one on disk with the wrong hash", () => {
    const plan = planFetch(papers, new Map([["a", sha(bytes)], ["c", "0".repeat(64)]]));
    assert.deepEqual(plan.have, ["a"]);
    assert.deepEqual(plan.download, ["b"]);
    assert.deepEqual(plan.mismatch, ["c"]);
  });
  it("downloads everything into an empty directory, in manifest order", () => {
    assert.deepEqual(planFetch(papers, new Map()).download, ["a", "b", "c"]);
  });
});
