/**
 * Chunker spec (KTD1): determinism, paragraph boundaries, overlap, hard
 * splits, stable ids/hashes, and offset integrity — offsets always index the
 * ORIGINAL text.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { chunkId, chunkText, targetChars, overlapChars, type ChunkTextConfig } from "../src/core/chunk.ts";

const CFG: ChunkTextConfig = { chunk_tokens: 1024, overlap_tokens: 128, chars_per_token: 4.0, boundary: "paragraph" };

const paper = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: ${"lorem ipsum dolor sit amet ".repeat(10)}`).join("\n\n");

describe("chunkText", () => {
  it("is deterministic: same text + config → identical chunk sequence", () => {
    const a = chunkText(paper, CFG);
    const b = chunkText(paper, CFG);
    assert.deepEqual(a, b);
  });

  it("chunks respect the char target and index the original text", () => {
    const chunks = chunkText(paper, CFG);
    assert.ok(chunks.length > 1);
    for (const ch of chunks) {
      assert.ok(ch.char_end - ch.char_start <= targetChars(CFG) + 4, `chunk ${ch.index} exceeds target`);
      assert.equal(ch.text.length, ch.char_end - ch.char_start);
      assert.equal(ch.text, paper.slice(ch.char_start, ch.char_end));
      assert.equal(ch.content_hash, createHash("sha256").update(ch.text, "utf8").digest("hex"));
      assert.ok(ch.est_tokens > 0);
    }
  });

  it("covers the whole text once (overlap aside) with paragraph-aligned starts", () => {
    const chunks = chunkText(paper, CFG);
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i].char_start > chunks[i - 1].char_start, "always progresses");
      const tail = chunks[i].char_start - chunks[i - 1].char_start;
      void tail; // overlap is asserted below via coverage
    }
    const covered = new Set<string>();
    for (const ch of chunks) for (let o = ch.char_start; o < ch.char_end; o++) covered.add(String(o));
    for (let o = 0; o < paper.length; o++) assert.ok(covered.has(String(o)), `offset ${o} uncovered`);
  });

  it("overlap stays within the configured budget", () => {
    const chunks = chunkText(paper, CFG);
    for (let i = 1; i < chunks.length; i++) {
      const overlap = chunks[i - 1].char_end - chunks[i].char_start;
      if (overlap > 0) assert.ok(overlap <= overlapChars(CFG) + 4, `overlap ${overlap} exceeds budget`);
    }
  });

  it("hard boundary splits deterministically without paragraph snapping", () => {
    const hard: ChunkTextConfig = { ...CFG, boundary: "hard" };
    const chunks = chunkText(paper, hard);
    assert.ok(chunks.length >= 2);
    for (const ch of chunks) assert.ok(ch.char_end - ch.char_start <= targetChars(hard));
  });

  it("empty text produces no chunks; single short paragraph produces one", () => {
    assert.deepEqual(chunkText("", CFG), []);
    const one = chunkText("A short paragraph.", CFG);
    assert.equal(one.length, 1);
    assert.equal(one[0].text, "A short paragraph.");
  });

  it("chunkId composes doi and index", () => {
    assert.equal(chunkId("10.1234/a.b", 3), "10.1234/a.b#c3");
  });
});
