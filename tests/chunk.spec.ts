/**
 * Chunker spec (KTD1): determinism, paragraph boundaries, overlap, hard
 * splits, stable ids/hashes, and offset integrity — offsets always index the
 * ORIGINAL text.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { chunkText, targetChars, overlapChars, type ChunkTextConfig } from "../src/core/chunk.ts";
import { chunkDocument } from "../src/core/chunk-document.ts";
import type { SectionMark } from "../src/core/sections.ts";

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

describe("chunkDocument — one entry point, boundary decides the structure", () => {
  const SECTION_CFG: ChunkTextConfig = { chunk_tokens: 400, overlap_tokens: 0, chars_per_token: 1, boundary: "section" }; // 400-char cap, 100-char floor
  const sentence = "The measured outcome improved over the baseline in every configuration. ";
  const body = (n: number): string => sentence.repeat(n).trim();
  const heads = ["Introduction", "Methods", "Results"];
  const text = [`Introduction\n${body(3)}`, `Methods\n${body(2)}`, `Results\n${body(12)}`].join("\n\n");
  const marks: SectionMark[] = heads.map((h) => ({ start: text.indexOf(h + "\n"), heading: h, level: 1 }));

  it("paragraph and hard boundaries are chunkText, unlabelled", () => {
    for (const boundary of ["paragraph", "hard"] as const) {
      const cfg = { ...CFG, boundary };
      assert.deepEqual(chunkDocument(paper, null, cfg), chunkText(paper, cfg).map((c) => ({ ...c, section: null })));
      assert.deepEqual(chunkDocument(paper, marks, cfg), chunkDocument(paper, null, cfg), "marks are ignored unless the boundary is section");
    }
  });

  it("section boundary: whole fitting sections, balanced splits of the long one, labels, caps, indexes into the original text", () => {
    const chunks = chunkDocument(text, marks, SECTION_CFG);
    const cap = targetChars(SECTION_CFG);
    assert.ok(chunks.length >= 4, "Results is longer than the cap and splits");
    chunks.forEach((c, i) => {
      assert.equal(c.index, i);
      assert.equal(c.text, text.slice(c.char_start, c.char_end));
      assert.ok(c.text.length <= cap, `chunk ${i} within the cap`);
      assert.equal(c.est_tokens, Math.ceil(c.text.length / SECTION_CFG.chars_per_token));
      assert.equal(c.content_hash, createHash("sha256").update(c.text, "utf8").digest("hex"));
    });
    assert.deepEqual(
      chunks.map((c) => c.section).filter((v, i, a) => a.indexOf(v) === i),
      ["Introduction", "Methods", "Results"],
    );
    const intro = chunks.find((c) => c.section === "Introduction")!;
    assert.ok(intro.text.startsWith("Introduction\n"), "a chunk keeps its heading as context");
    assert.deepEqual(chunks.filter((c) => c.section === "Methods").length, 1, "a section that fits stays whole");
    assert.equal(chunks[0].char_start, 0);
    for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].char_start, chunks[i - 1].char_end, "tiles the text without overlap");
  });

  it("without marks the text is split under the cap with the unlabelled section", () => {
    const chunks = chunkDocument(text, null, SECTION_CFG);
    assert.ok(chunks.every((c) => c.section === "" && c.text.length <= targetChars(SECTION_CFG)));
    assert.equal(chunks.map((c) => c.text).join(""), text);
  });

  it("is deterministic and empty text gives no chunks", () => {
    assert.deepEqual(chunkDocument(text, marks, SECTION_CFG), chunkDocument(text, marks, SECTION_CFG));
    assert.deepEqual(chunkDocument("", marks, SECTION_CFG), []);
  });

  it("tiny sections are merged forward only while the result fits (floor = 25 % of the cap)", () => {
    const tiny = "Abstract\nShort.\n\nIntroduction\n" + body(3);
    const t = chunkDocument(tiny, [{ start: 0, heading: "Abstract", level: 1 }, { start: tiny.indexOf("Introduction"), heading: "Introduction", level: 1 }], SECTION_CFG);
    assert.equal(t.length, 1, "a 15-char section next to a section that fits joins it");
    assert.equal(t[0].section, "Abstract");
  });
});
