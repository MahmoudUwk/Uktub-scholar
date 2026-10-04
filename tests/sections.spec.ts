/**
 * Section-aware splitter (roadmap step 1). The splitter decides only WHERE chunks
 * begin and what they are called; it must never be able to break provenance, so the
 * contract is structural and is checked both on fixed cases and, with seeded
 * generators, as properties over thousands of random documents:
 *
 *  - TILING: chunks cover the text exactly once, in order, with no gap or overlap;
 *  - CAP: no chunk is longer than maxChars;
 *  - a section that fits stays whole; a larger one is split at sentence/paragraph
 *    boundaries into balanced pieces; tiny sections merge into a neighbour only when
 *    the result still fits;
 *  - a heading is never cut and never left alone at the end of a chunk;
 *  - deterministic; invalid marks (out of range, unsorted, duplicate) cannot break any of it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { splitBySections, type SectionChunk, type SectionMark, type SplitOptions } from "../src/core/sections.ts";

const mk = (text: string, headings: string[]): SectionMark[] =>
  headings.map((h, i) => ({ start: text.indexOf(h, i === 0 ? 0 : 0), heading: h, level: 1 })).filter((m) => m.start >= 0);

const para = (tag: string, n: number): string => `${tag} ` + "Sentence about the experiment and its measured outcome. ".repeat(n).trim();

const OPTS: SplitOptions = { maxChars: 400, minChars: 100 };

function assertTiling(text: string, chunks: SectionChunk[], label = ""): void {
  assert.ok(chunks.length >= 1 || text.length === 0, `${label} some chunk for non-empty text`);
  let at = 0;
  for (const c of chunks) {
    assert.equal(c.start, at, `${label} gap/overlap before ${c.start}`);
    assert.ok(c.end > c.start, `${label} empty chunk`);
    at = c.end;
  }
  assert.equal(at, text.length, `${label} coverage ends at the text end`);
}

describe("splitBySections — fixed cases", () => {
  it("keeps sections that fit whole, labelled with their heading, tiling the text", () => {
    const text = [`ABSTRACT\n${para("a", 4)}`, `I. INTRODUCTION\n${para("b", 5)}`, `II. METHODS\n${para("c", 5)}`].join("\n\n");
    const chunks = splitBySections(text, mk(text, ["ABSTRACT", "I. INTRODUCTION", "II. METHODS"]), OPTS);
    assertTiling(text, chunks);
    assert.deepEqual(chunks.map((c) => c.section), ["ABSTRACT", "I. INTRODUCTION", "II. METHODS"]);
    assert.ok(chunks.every((c) => c.parts === 1 && c.sections === 1));
    assert.ok(text.slice(chunks[1].start, chunks[1].end).startsWith("I. INTRODUCTION"));
  });

  it("text before the first heading is its own unlabeled section", () => {
    const text = `Title of the paper and authors\n\nI. INTRO\n${para("x", 5)}`;
    const chunks = splitBySections(text, mk(text, ["I. INTRO"]), { maxChars: 400, minChars: 10 });
    assertTiling(text, chunks);
    assert.equal(chunks[0].section, "");
    assert.equal(chunks[1].section, "I. INTRO");
  });

  it("splits a section larger than the cap into balanced pieces at sentence boundaries, all under the cap", () => {
    const text = `I. LONG\n${para("L", 40)}\n\nII. NEXT\n${para("n", 5)}`;
    const chunks = splitBySections(text, mk(text, ["I. LONG", "II. NEXT"]), OPTS);
    assertTiling(text, chunks);
    const long = chunks.filter((c) => c.section === "I. LONG");
    assert.ok(long.length > 1 && long.every((c) => c.parts === long.length));
    assert.deepEqual(long.map((c) => c.part), long.map((_, i) => i));
    for (const c of long) {
      assert.ok(c.end - c.start <= OPTS.maxChars);
      assert.ok(c.end - c.start >= OPTS.minChars, "no tiny tail piece");
    }
    for (const c of long.slice(0, -1)) assert.match(text.slice(c.start, c.end).trimEnd(), /[.!?]$/, "cut at a sentence end");
  });

  it("merges tiny sections forward while the result fits, and the label is the first heading", () => {
    const text = [`A. ONE\nshort`, `B. TWO\nshort too`, `C. THREE\n${para("t", 5)}`].join("\n");
    const chunks = splitBySections(text, mk(text, ["A. ONE", "B. TWO", "C. THREE"]), { maxChars: 500, minChars: 100 });
    assertTiling(text, chunks);
    assert.equal(chunks[0].section, "A. ONE");
    assert.ok(chunks[0].sections >= 2, "the tiny sections were merged");
  });

  it("does not merge when the result would not fit; a lone tiny section may stay tiny", () => {
    const big = "w ".repeat(194); // "B. BIG\n" + 388 chars = 395: fits the cap of 400 alone, not beside the 10-char tiny section
    const text = `A. TINY\nx\n${`B. BIG\n${big}`}`;
    const chunks = splitBySections(text, mk(text, ["A. TINY", "B. BIG"]), { maxChars: 400, minChars: 100 });
    assertTiling(text, chunks);
    assert.equal(chunks.length, 2);
    for (const c of chunks) assert.ok(c.end - c.start <= 400);
  });

  it("a trailing tiny section merges backward; a heading is never left alone at the end of a chunk", () => {
    const text = `A. BODY\n${para("a", 6)}\nZ. END\nok`;
    const chunks = splitBySections(text, mk(text, ["A. BODY", "Z. END"]), { maxChars: 700, minChars: 100 });
    assertTiling(text, chunks);
    assert.equal(chunks.length, 1);
  });

  it("no marks: behaves as a plain paragraph/sentence splitter under the cap", () => {
    const text = Array.from({ length: 12 }, (_, i) => para(`p${i}`, 3)).join("\n\n");
    const chunks = splitBySections(text, [], OPTS);
    assertTiling(text, chunks);
    assert.ok(chunks.every((c) => c.section === "" && c.end - c.start <= OPTS.maxChars));
  });

  it("empty text gives no chunks", () => {
    assert.deepEqual(splitBySections("", [], OPTS), []);
  });

  it("invalid marks (out of range, unsorted, duplicate offsets) are ignored or normalised without breaking the contract", () => {
    const text = `H1\n${para("a", 4)}\n\nH2\n${para("b", 4)}`;
    const h2 = text.indexOf("H2");
    const marks: SectionMark[] = [
      { start: h2, heading: "H2", level: 1 },
      { start: 0, heading: "H1", level: 1 },
      { start: h2, heading: "H2 dup", level: 2 },
      { start: -5, heading: "neg", level: 1 },
      { start: text.length + 50, heading: "far", level: 1 },
      { start: 3.5, heading: "frac", level: 1 },
    ];
    const chunks = splitBySections(text, marks, OPTS);
    assertTiling(text, chunks);
    assert.deepEqual(chunks.map((c) => c.section), ["H1", "H2"]);
  });

  it("astral characters are never split; an unbreakable run longer than the cap is cut at the cap", () => {
    const text = `S\n${"😀".repeat(500)}`;
    for (const c of splitBySections(text, [{ start: 0, heading: "S", level: 1 }], { maxChars: 120, minChars: 20 })) {
      const t = text.slice(c.start, c.end);
      assert.ok(t.length <= 120);
      assert.ok(!/^[\uDC00-\uDFFF]/.test(t) && !/[\uD800-\uDBFF]$/.test(t), "lone surrogate");
    }
    const run = `S\n${"x".repeat(1000)}`;
    const chunks = splitBySections(run, [{ start: 0, heading: "S", level: 1 }], { maxChars: 120, minChars: 20 });
    assertTiling(run, chunks);
    assert.ok(chunks.every((c) => c.end - c.start <= 120));
  });

  it("a heading line with inner sentence ends or spaces never loses its body to the cut, in both split branches", () => {
    const heading = "3.2 " + "Heading sentence number one. ".repeat(10).trim(); // ≈ 290 chars, sentence ends inside the heading line
    const cases: [string, string][] = [
      ["final two-way split, prose body", para("b", 3)], // ≈ 470 chars in total, midpoint inside the heading
      ["far branch, unbroken body", "x".repeat(2000)], // the only whitespace left is inside the heading line
    ];
    for (const [label, body] of cases) {
      const text = `${heading}\n${body}`;
      const chunks = splitBySections(text, [{ start: 0, heading, level: 1 }], { maxChars: 400, minChars: 20 });
      assertTiling(text, chunks, label);
      const bodyAt = text.indexOf("\n") + 1;
      assert.ok(chunks.length > 1, `${label}: section is larger than the cap`);
      assert.ok(chunks[0].end > bodyAt, `${label}: first piece ends at ${chunks[0].end}, inside the heading line (body starts ${bodyAt})`);
    }
  });

  it("is deterministic", () => {
    const text = [`ABSTRACT\n${para("a", 4)}`, `I. X\n${para("b", 30)}`].join("\n\n");
    const marks = mk(text, ["ABSTRACT", "I. X"]);
    assert.deepEqual(splitBySections(text, marks, OPTS), splitBySections(text, marks, OPTS));
  });
});

// ── properties over seeded random documents ────────────────────────────────

/** Small deterministic PRNG (mulberry32): the property runs are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["cell", "signal", "model", "ΔT", "température", "電池", "😀x", "10.5", "results", "the", "of", "and", "Fig.", "e.g.", "0.99", "a"];

function randomDoc(r: () => number): { text: string; marks: SectionMark[]; headings: string[] } {
  const parts: string[] = [];
  const marks: SectionMark[] = [];
  const headings: string[] = [];
  let offset = 0;
  const push = (s: string) => {
    parts.push(s);
    offset += s.length;
  };
  const sections = Math.floor(r() * 9);
  if (r() < 0.5) push(`Preamble words ${"x ".repeat(Math.floor(r() * 30))}\n\n`);
  for (let i = 0; i < sections; i++) {
    const heading = `${["I", "II", "III", "A", "B", "1.2"][i % 6]}. HEADING ${i}`;
    marks.push({ start: offset, heading, level: 1 + (i % 2) });
    headings.push(heading);
    push(`${heading}\n`);
    const paras = Math.floor(r() * 4);
    for (let p = 0; p < paras; p++) {
      const sentences = 1 + Math.floor(r() * (r() < 0.2 ? 60 : 6));
      const body = Array.from({ length: sentences }, () => Array.from({ length: 3 + Math.floor(r() * 12) }, () => WORDS[Math.floor(r() * WORDS.length)]).join(" ") + ".").join(" ");
      push(body + (r() < 0.5 ? "\n\n" : "\n"));
    }
    if (r() < 0.15) push("x".repeat(Math.floor(r() * 900)) + "\n"); // an unbreakable run
  }
  return { text: parts.join(""), marks, headings };
}

describe("splitBySections — properties (seeded)", () => {
  it("tiling, cap, determinism, heading integrity and merge/split rules hold on 3,000 random documents", () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed);
      const { text, marks } = randomDoc(r);
      const maxChars = 64 + Math.floor(r() * 1500);
      const minChars = Math.floor(r() * (maxChars / 2));
      const opts = { maxChars, minChars };
      const chunks = splitBySections(text, marks, opts);
      const label = `seed ${seed}`;
      if (text.length === 0) {
        assert.deepEqual(chunks, [], label);
        continue;
      }
      assertTiling(text, chunks, label);
      assert.deepEqual(chunks, splitBySections(text, marks, opts), `${label} deterministic`);
      for (const c of chunks) assert.ok(c.end - c.start <= maxChars, `${label} cap ${c.end - c.start} > ${maxChars}`);

      // headings: never cut, never alone at the end of a chunk
      for (const m of marks) {
        const lineEnd = text.indexOf("\n", m.start);
        const headingEnd = lineEnd === -1 ? text.length : lineEnd;
        for (const c of chunks) {
          assert.ok(!(c.start > m.start && c.start <= headingEnd && c.start < text.length), `${label} boundary inside heading "${m.heading}"`);
        }
        const holder = chunks.find((c) => c.start <= m.start && m.start < c.end)!;
        const after = text.slice(Math.min(headingEnd + 1, holder.end), holder.end);
        const sectionHasBody = text.slice(headingEnd + 1).split(/\n/)[0] !== undefined && headingEnd + 1 < text.length;
        if (sectionHasBody && holder.end < text.length) {
          // an orphaned heading would have no content after its own line inside its chunk
          const nextMark = marks.find((n) => n.start > m.start);
          const bodyLen = (nextMark ? nextMark.start : text.length) - (headingEnd + 1);
          if (bodyLen > 0 && text.slice(headingEnd + 1, headingEnd + 1 + bodyLen).trim().length > 0) {
            assert.ok(after.trim().length > 0 || (nextMark !== undefined && holder.end > nextMark.start), `${label} heading "${m.heading}" orphaned at chunk end`);
          }
        }
      }

      // pieces of a split section are balanced: none is a sliver below minChars
      for (const c of chunks) if (c.parts > 1) assert.ok(c.end - c.start >= minChars, `${label} sliver piece ${c.end - c.start} < ${minChars}`);

      // parts bookkeeping
      const bySection = new Map<string, SectionChunk[]>();
      for (const c of chunks) if (c.parts > 1) (bySection.get(`${c.section}`) ?? bySection.set(`${c.section}`, []).get(`${c.section}`)!).push(c);
      for (const list of bySection.values()) {
        assert.deepEqual(list.map((c) => c.part), list.map((_, i) => i), `${label} part numbering`);
        assert.ok(list.every((c) => c.parts === list.length), `${label} parts count`);
      }

      // a chunk below minChars exists only when neither neighbour could absorb it within the cap
      chunks.forEach((c, i) => {
        const size = c.end - c.start;
        if (size >= minChars || chunks.length === 1 || c.parts > 1) return;
        const prev = chunks[i - 1];
        const next = chunks[i + 1];
        // split pieces are never merged by design, so only whole-section neighbours count
        const fitsPrev = prev !== undefined && prev.parts === 1 && prev.end - prev.start + size <= maxChars;
        const fitsNext = next !== undefined && next.parts === 1 && next.end - next.start + size <= maxChars;
        assert.ok(!fitsPrev && !fitsNext, `${label} chunk ${i} (${size} < ${minChars}) could have merged`);
      });
    }
  });

  it("a section that fits the cap is never split, whatever its neighbours are", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed * 7919);
      const { text, marks } = randomDoc(r);
      const maxChars = 200 + Math.floor(r() * 1200);
      const chunks = splitBySections(text, marks, { maxChars, minChars: 0 });
      const sorted = [...marks].sort((a, b) => a.start - b.start);
      sorted.forEach((m, i) => {
        const end = i + 1 < sorted.length ? sorted[i + 1].start : text.length;
        if (end - m.start <= maxChars) {
          const parts = chunks.filter((c) => c.start < end && c.end > m.start);
          // all chunks touching this section are boundary-aligned with it or are merges that contain it entirely
          assert.ok(parts.every((c) => (c.start <= m.start && c.end >= end) || (c.start >= m.start && c.end <= end)), `seed ${seed} split section ${m.heading}`);
          assert.ok(parts.length === 1 || parts.every((c) => c.start >= m.start && c.end <= end), `seed ${seed} section ${m.heading} fragmented`);
        }
      });
    }
  });
});
