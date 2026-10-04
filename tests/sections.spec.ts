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

import { MAX_SECTION_LABEL_CHARS, splitBySections, type SectionChunk, type SectionMark, type SplitOptions } from "../src/core/sections.ts";

const mk = (text: string, headings: string[]): SectionMark[] =>
  headings.map((h, i) => ({ start: text.indexOf(h, i === 0 ? 0 : 0), heading: h, level: 1 })).filter((m) => m.start >= 0);

const para = (tag: string, n: number): string => `${tag} ` + "Sentence about the experiment and its measured outcome. ".repeat(n).trim();
const body = (n: number): string => "The measured outcome improved over the baseline in every configuration. ".repeat(n).trim();

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

  it("a heading-only section goes forward with the section after it, never backward as the trailing line of the previous chunk (review finding)", () => {
    const text = `2. Related Work\n${body(8)}\n3. Methods\n3.1 Data\n${body(14)}\n3.2 Model\n${body(5)}\n`;
    const marks = ["2. Related Work", "3. Methods", "3.1 Data", "3.2 Model"].map((h) => ({ start: text.indexOf(h + "\n"), heading: h, level: 1 }));
    const chunks = splitBySections(text, marks, { maxChars: 1433, minChars: 359 });
    assertTiling(text, chunks);
    const methods = text.indexOf("3. Methods");
    const holder = chunks.find((c) => c.start <= methods && methods < c.end)!;
    assert.ok(text.slice(methods, holder.end).includes("3.1 Data"), "the heading shares a chunk with the section that follows it");
    assert.ok(!chunks.some((c) => c.start < methods && c.end > methods && text.slice(c.start, c.end).trimEnd().endsWith("3. Methods")), "no earlier chunk ends with the dangling heading");
    // a heading-only section that cannot go forward (the next one is full) stands alone rather than dangling
    const full = `1. A\n${body(3)}\n2. Only a heading\n3. B\n${"x".repeat(3000)}`;
    const m2 = ["1. A", "2. Only a heading", "3. B"].map((h) => ({ start: full.indexOf(h + "\n"), heading: h, level: 1 }));
    const out = splitBySections(full, m2, { maxChars: 400, minChars: 100 });
    const at = full.indexOf("2. Only a heading");
    const h = out.find((c) => c.start <= at && at < c.end)!;
    assert.ok(h.start === at || full.slice(at, h.end).includes("3. B"), "alone, or forward with its section");
  });

  it("an unbroken run of astral characters is never cut between a surrogate pair, with or without a heading (review finding)", () => {
    const bad = (t: string, cs: SectionChunk[]): boolean => cs.some((c) => c.start > 0 && t.charCodeAt(c.start - 1) >= 0xd800 && t.charCodeAt(c.start - 1) <= 0xdbff && t.charCodeAt(c.start) >= 0xdc00 && t.charCodeAt(c.start) <= 0xdfff);
    for (const max of [100, 101, 1433]) {
      for (const total of [150, 199, 201, 301, 2866, 2867, 5000]) {
        for (const pre of [0, 1, 5]) {
          const t = "x".repeat(pre) + "😀".repeat(Math.ceil(total / 2));
          const cs = splitBySections(t, [], { maxChars: max, minChars: Math.ceil(max * 0.25) });
          assertTiling(t, cs);
          assert.ok(!bad(t, cs), `no marks: max ${max} total ${t.length} pre ${pre}`);
          const h = "1. Intro\n" + t;
          const hs = splitBySections(h, [{ start: 0, heading: "1. Intro", level: 1 }], { maxChars: max, minChars: Math.ceil(max * 0.25) });
          assertTiling(h, hs);
          assert.ok(!bad(h, hs), `heading: max ${max} total ${t.length} pre ${pre}`);
          assert.ok(hs.every((c) => c.end - c.start <= max + 1), "the cap holds up to one code unit (an astral character is two)");
        }
      }
    }
  });

  it("a very long heading is labelled with a bounded clip: the label travels with search results and must not carry text out (review finding)", () => {
    const long = "Secret ".repeat(800); // 5,600 characters of "heading"
    const text = `${long}\nBody text that follows the heading and is long enough to be a passage.`;
    const chunks = splitBySections(text, [{ start: 0, heading: long, level: 1 }], { maxChars: 9000, minChars: 0 });
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].section.length <= MAX_SECTION_LABEL_CHARS, `label ${chunks[0].section.length} characters`);
    assert.ok(chunks[0].section.endsWith("…"));
    assert.ok(long.startsWith(chunks[0].section.slice(0, -1)), "the clip is a prefix of the heading");
    assert.equal(splitBySections("1. Intro\nbody", [{ start: 0, heading: "1. Intro", level: 1 }], { maxChars: 100, minChars: 0 })[0].section, "1. Intro", "short labels are untouched");
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
        // a heading is never the trailing line of a chunk that also holds earlier content (the last chunk of the text excepted):
        // a heading with nothing after it either stands alone in its chunk or goes forward with its section
        const holder = chunks.find((c) => c.start <= m.start && m.start < c.end)!;
        const after = text.slice(Math.min(headingEnd + 1, holder.end), holder.end);
        if (after.trim().length === 0 && holder.end < text.length) {
          // allowed only when the chunk is nothing but stranded headings (no earlier content to be cut off from)
          const headings = new Set(marks.map((x) => x.heading.trim()));
          const lines = text.slice(holder.start, holder.end).split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
          assert.ok(lines.every((l) => headings.has(l)), `${label} heading "${m.heading}" dangles at the end of a chunk that holds earlier content`);
        }
      }

      // no boundary falls between the two halves of a surrogate pair (the stored text would diverge from the pointer slice)
      for (const c of chunks.slice(1)) {
        const high = text.charCodeAt(c.start - 1);
        const low = text.charCodeAt(c.start);
        assert.ok(!(high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff), `${label} chunk boundary ${c.start} splits a surrogate pair`);
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
        const headingSet = new Set(marks.map((m) => m.heading.trim()));
        const headOnly = (x: SectionChunk | undefined): boolean => {
          if (x === undefined || x.parts !== 1) return false;
          const lines = text.slice(x.start, x.end).split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
          return lines.length > 0 && lines.every((l) => headingSet.has(l)); // nothing but (a chain of) stranded headings
        };
        // a heading-only chunk deliberately refuses to merge backward, and nothing merges onto its heading from before
        // (either would leave a heading as the trailing line of earlier content)
        if (headOnly(c)) return;
        const prev = chunks[i - 1];
        const next = chunks[i + 1];
        // split pieces are never merged by design, so only whole-section neighbours count
        const fitsPrev = prev !== undefined && prev.parts === 1 && prev.end - prev.start + size <= maxChars;
        const fitsNext = next !== undefined && (!headOnly(next) || i + 1 === chunks.length - 1) && next.parts === 1 && next.end - next.start + size <= maxChars;
        assert.ok(!fitsPrev && !fitsNext, `${label} chunk ${i} (${size} < ${minChars}) could have merged`);
      });
    }
  });

  it("hostile text with tiny caps (astral characters, CR/LF, tabs, duplicate marks, headings longer than the cap) still tiles, never yields an empty or oversize chunk, never splits a pair (review fuzz)", () => {
    const atoms = ["word", "Intro", ". ", "\n", "\r\n", "\t", " ", "😀", "a😀b", "  ", "\n\n", "x.", "Hello. World", "!", "?\"", "123", "é"];
    const r = rng(20261004);
    for (let iter = 0; iter < 6000; iter++) {
      let t = "";
      const n = Math.floor(r() * 60);
      for (let i = 0; i < n; i++) t += atoms[Math.floor(r() * atoms.length)] + (r() < 0.5 ? " " : "");
      const lineStarts = [0, ...[...t.matchAll(/\n/g)].map((m) => (m.index as number) + 1)];
      const marks = Array.from({ length: Math.floor(r() * 6) }, (_, i) => ({ start: lineStarts[Math.floor(r() * lineStarts.length)], heading: `H${i}`, level: 1 }));
      const maxChars = 4 + Math.floor(r() * (r() < 0.5 ? 20 : 120));
      const minChars = Math.max(0, Math.floor(r() * (r() < 0.3 ? 200 : maxChars + 1)));
      const chunks = splitBySections(t, marks, { maxChars, minChars });
      const label = `iter ${iter} ${JSON.stringify({ t, maxChars, minChars })}`;
      if (t.length === 0) {
        assert.deepEqual(chunks, [], label);
        continue;
      }
      assertTiling(t, chunks, label);
      for (const c of chunks) {
        assert.ok(c.end > c.start, `${label} empty chunk`);
        assert.ok(c.end - c.start <= maxChars, `${label} chunk ${c.end - c.start} over the cap`);
      }
      for (const c of chunks.slice(1)) {
        const high = t.charCodeAt(c.start - 1);
        assert.ok(!(high >= 0xd800 && high <= 0xdbff && t.charCodeAt(c.start) >= 0xdc00 && t.charCodeAt(c.start) <= 0xdfff), `${label} splits a pair at ${c.start}`);
      }
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
