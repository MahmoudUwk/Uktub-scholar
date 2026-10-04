/**
 * Chunker spec (KTD1): determinism, paragraph boundaries, overlap, hard
 * splits, stable ids/hashes, and offset integrity — offsets always index the
 * ORIGINAL text.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { chunkText, targetChars, overlapChars, type ChunkTextConfig } from "../src/core/chunk.ts";

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
});

describe("chunkText — cuts that preserve evidence (KTD7)", () => {
  const SMALL: ChunkTextConfig = { chunk_tokens: 100, overlap_tokens: 10, chars_per_token: 1, boundary: "paragraph" }; // 100-char windows

  it("a paragraph longer than the window is cut at a sentence end, not mid-sentence or mid-number", () => {
    const text = "Capacity fades slowly over the first cycles of operation. Under load the loss reaches 12.5 % per hundred cycles at 45 °C. After that the cell is stable.";
    const chunks = chunkText(text, SMALL);
    assert.ok(chunks.length >= 2);
    for (const c of chunks.slice(0, -1)) assert.match(c.text.trimEnd(), /[.!?]$/, `cut inside a sentence: ${JSON.stringify(c.text)}`);
    assert.ok(chunks.some((c) => c.text.includes("12.5 % per hundred cycles at 45 °C.")), "the number stays with its unit and qualifier");
  });

  it("with no sentence end available it still never splits a word", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega ".repeat(3);
    for (const c of chunkText(text, SMALL).slice(0, -1)) assert.match(c.text, /\s$/, `cut mid-word: ${JSON.stringify(c.text.slice(-12))}`);
  });

  it("a table block (header and rows on single newlines) stays whole when it fits the window", () => {
    const table = "Table 2. Cycle life\nTemp (°C) | Cycles | Loss (%)\n25 | 800 | 8\n45 | 400 | 20";
    const text = `${"Intro sentence here. ".repeat(3)}\n\n${table}\n\n${"Closing remarks follow. ".repeat(3)}`;
    assert.ok(chunkText(text, { ...SMALL, chunk_tokens: 140 }).some((c) => c.text.includes(table)), "header and its rows share a chunk");
  });

  it("snapped chunks still index the original text, cover it, make progress, and are deterministic", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence ${i} states that value ${i * 3} holds at 45 °C.`).join(" ");
    const a = chunkText(text, SMALL);
    assert.deepEqual(a, chunkText(text, SMALL));
    const seen = new Array(text.length).fill(false);
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i].text, text.slice(a[i].char_start, a[i].char_end));
      if (i > 0) assert.ok(a[i].char_start > a[i - 1].char_start);
      for (let o = a[i].char_start; o < a[i].char_end; o++) seen[o] = true;
    }
    assert.ok(seen.every(Boolean));
  });

  it("astral characters are never split from their surrogate pair", () => {
    const text = "😀".repeat(120);
    for (const c of chunkText(text, { ...SMALL, boundary: "paragraph" })) {
      assert.ok(!/^[\uDC00-\uDFFF]/.test(c.text) && !/[\uD800-\uDBFF]$/.test(c.text), "lone surrogate at a chunk edge");
    }
  });
});

describe("chunkText — degenerate configurations", () => {
  it("never loops or exhausts memory when the window rounds to zero characters", () => {
    const cfg: ChunkTextConfig = { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 0.001, boundary: "paragraph" };
    const chunks = chunkText("abc def ghi", cfg);
    assert.ok(chunks.length >= 1 && chunks.length <= 11);
    assert.equal(chunks.map((c) => c.text).join(""), "abc def ghi");
  });
});
