/**
 * Paper units (V1): whole sections are the judging unit; bibliography entries
 * are never judged. Units tile the text, each is at most the cap, and a unit
 * is flagged when its section is a References/Bibliography section.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { splitBySections } from "../src/core/sections.ts";
import { REFERENCES } from "../src/core/source/headings.ts";
import { chunkPolicyOf, passageHashOf } from "../src/core/verify/store.ts";
import { paperUnits, SECTION_UNIT_MAX_CHARS } from "../src/core/verify/paper-units.ts";
import type { ChunkTextConfig } from "../src/core/chunk.ts";

const sentence = "The measured outcome improved over the baseline in every configuration we tried. ";
const para = (tag: string, n: number): string => `${tag} ` + sentence.repeat(n).trim();

const docWithRefs = (): { text: string; marks: { start: number; heading: string; level: number }[] } => {
  const intro = `1. Introduction\n${para("i", 6)}`;
  const refs = `References\n[1] A. Author, A title, Venue, 2024.\n[2] B. Author, Another title, Venue, 2025.`;
  const app = `A Parallel Decoding Scheme\n${para("a", 6)}`;
  const text = [intro, refs, app].join("\n\n");
  const marks = ["1. Introduction", "References", "A Parallel Decoding Scheme"].map((h) => ({ start: text.indexOf(h), heading: h, level: 1 }));
  return { text, marks };
};

describe("paperUnits — tiling and cap", () => {
  it("units tile the text with no gap or overlap and each is at most the cap", () => {
    const { text, marks } = docWithRefs();
    const units = paperUnits(text, marks, 4000);
    assert.ok(units.length >= 3);
    let at = 0;
    for (const u of units) {
      assert.equal(u.start, at, `gap/overlap before ${u.start}`);
      assert.ok(u.end > u.start);
      assert.ok(u.end - u.start <= 4000);
      assert.equal(u.text, text.slice(u.start, u.end));
      at = u.end;
    }
    assert.equal(at, text.length);
  });

  it("matches splitBySections with minChars 0, plus text, hash and references flag", () => {
    const { text, marks } = docWithRefs();
    const units = paperUnits(text, marks, 4000);
    const chunks = splitBySections(text, marks, { maxChars: 4000, minChars: 0 });
    assert.equal(units.length, chunks.length);
    units.forEach((u, i) => {
      assert.equal(u.start, chunks[i].start);
      assert.equal(u.end, chunks[i].end);
      assert.equal(u.section, chunks[i].section);
      assert.equal(u.hash, passageHashOf(u.text));
    });
  });

  it("no heading marks gives whole-text pieces at most the cap, all unflagged", () => {
    const text = Array.from({ length: 60 }, (_, i) => para(`p${i}`, 8)).join("\n\n");
    assert.ok(text.length > SECTION_UNIT_MAX_CHARS);
    const units = paperUnits(text, []);
    let at = 0;
    for (const u of units) {
      assert.equal(u.start, at);
      assert.ok(u.end - u.start <= SECTION_UNIT_MAX_CHARS);
      assert.equal(u.section, "");
      assert.equal(u.references, false);
      at = u.end;
    }
    assert.equal(at, text.length);
  });
});

describe("paperUnits — references flag", () => {
  it("units under References or Bibliography are flagged; appendix units are not", () => {
    const { text, marks } = docWithRefs();
    const units = paperUnits(text, marks, 4000);
    const refs = units.filter((u) => u.section === "References");
    assert.ok(refs.length >= 1);
    assert.ok(refs.every((u) => u.references));
    const app = units.filter((u) => u.section === "A Parallel Decoding Scheme");
    assert.ok(app.length >= 1);
    assert.ok(app.every((u) => !u.references));
    const intro = units.filter((u) => u.section === "1. Introduction");
    assert.ok(intro.every((u) => !u.references));
  });

  it("the Bibliography spelling flags too", () => {
    const text = `1. Introduction\n${para("i", 2)}\n\nBibliography\n[1] A. Author, A title, Venue, 2024.`;
    const marks = ["1. Introduction", "Bibliography"].map((h) => ({ start: text.indexOf(h), heading: h, level: 1 }));
    const units = paperUnits(text, marks, 4000);
    assert.ok(units.some((u) => u.section === "Bibliography" && u.references));
  });

  it("the shared References/Bibliography matcher is the detector's own regex", () => {
    assert.ok(REFERENCES.test("References") && REFERENCES.test("Bibliography") && REFERENCES.test("REFERENCES"));
    assert.ok(!REFERENCES.test("Appendix") && !REFERENCES.test("A Parallel Decoding Scheme") && !REFERENCES.test(""));
  });
});

describe("paperUnits — oversize sections", () => {
  it("a 40,000-char section is cut at sentence ends into pieces at most the cap", () => {
    const body = sentence.repeat(500).trim(); // 40,000+ chars of uniform sentences
    const text = `3. Results\n${body}\n\nReferences\n[1] A. Author, A title, Venue, 2024.`;
    assert.ok(text.indexOf("References") - text.indexOf("3. Results") > 40000);
    const marks = ["3. Results", "References"].map((h) => ({ start: text.indexOf(h), heading: h, level: 1 }));
    const units = paperUnits(text, marks);
    const results = units.filter((u) => u.section === "3. Results");
    assert.ok(results.length > 1);
    let at = 0;
    for (const u of units) {
      assert.equal(u.start, at);
      assert.ok(u.end - u.start <= SECTION_UNIT_MAX_CHARS);
      at = u.end;
    }
    assert.equal(at, text.length);
    for (const u of results.slice(0, -1)) assert.match(u.text.trimEnd(), /[.!?]$/, "cut at a sentence end");
  });

  it("golden: the 40,000-char section splits at these exact offsets", () => {
    const body = sentence.repeat(500).trim();
    const text = `3. Results\n${body}\n\nReferences\n[1] A. Author, A title, Venue, 2024.`;
    const marks = ["3. Results", "References"].map((h) => ({ start: text.indexOf(h), heading: h, level: 1 }));
    const units = paperUnits(text, marks);
    assert.deepEqual(units.map((u) => [u.start, u.end]), [[0, 15968], [15968, 28280], [28280, 40512], [40512, 40559]]);
    assert.deepEqual(units.map((u) => u.section), ["3. Results", "3. Results", "3. Results", "References"]);
    assert.ok(units.every((u) => u.end - u.start <= SECTION_UNIT_MAX_CHARS));
  });
});

describe("paperUnits — policy and cap identity", () => {
  it("the default cap is 16,000 chars", () => {
    assert.equal(SECTION_UNIT_MAX_CHARS, 16_000);
  });

  it("a section longer than the default cap splits without an explicit cap", () => {
    const text = `3. Results\n${sentence.repeat(300).trim()}`;
    const units = paperUnits(text, [{ start: 0, heading: "3. Results", level: 1 }]);
    assert.ok(units.length > 1);
    assert.ok(units.every((u) => u.end - u.start <= 16_000));
  });

  it("the section chunk policy carries the structure version; fixed-window policies do not", () => {
    const section: ChunkTextConfig = { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 1, boundary: "section" };
    assert.notEqual(chunkPolicyOf(section), chunkPolicyOf({ ...section, boundary: "paragraph" }));
    assert.equal(chunkPolicyOf(section), chunkPolicyOf({ ...section }));
    assert.equal(chunkPolicyOf({ ...section, boundary: "paragraph" }), chunkPolicyOf({ chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 1, boundary: "paragraph" }));
  });
});
