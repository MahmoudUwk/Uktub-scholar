/**
 * Heading detection for PDF text (roadmap step 1b). The extracted PDF text keeps the
 * page's hard-wrapped lines, so a heading is a short standalone line that is either a
 * canonical section name or carries a section number. Detection is deliberately strict:
 * a missed heading only makes a chunk larger or smaller, a false one only adds a boundary,
 * and neither can break provenance (the splitter tiles the text whatever the marks are) —
 * but false positives such as titles, table rows and reference entries are measured here
 * because they would put wrong labels on evidence.
 *
 * Contract: marks are strictly increasing, each at the start of a line inside the text,
 * `heading` is that line trimmed, and the function is deterministic and total
 * (any string in, no exception).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectHeadings } from "../src/core/source/headings.ts";

const body = "The measured outcome improved over the baseline in every configuration we tried.";
const doc = (...lines: string[]): string => lines.join("\n");
const headingsOf = (text: string): string[] => detectHeadings(text).map((m) => m.heading);

describe("detectHeadings — recognised headings", () => {
  it("IEEE style: roman numerals with a period, lettered subsections, canonical names", () => {
    const text = doc("Abstract—We study things.", body, "Index Terms—foo, bar", "I. INTRODUCTION", body, "A. Dataset", body, "II. RELATED WORK", body, "REFERENCES", "[1] A. Smith, B. Jones, Title, 2020.");
    assert.deepEqual(headingsOf(text), ["I. INTRODUCTION", "A. Dataset", "II. RELATED WORK", "REFERENCES"]);
  });

  it("MDPI/Springer style: arabic numbers with or without a trailing period, nested depth", () => {
    const text = doc("1. Introduction", body, "2 Materials and Methods", body, "2.1. Smart Home Energy", body, "2.1.3 Edge cases", body, "5. Conclusions", body);
    const marks = detectHeadings(text);
    assert.deepEqual(marks.map((m) => m.heading), ["1. Introduction", "2 Materials and Methods", "2.1. Smart Home Energy", "2.1.3 Edge cases", "5. Conclusions"]);
    assert.deepEqual(marks.map((m) => m.level), [1, 1, 2, 3, 1]);
  });

  it("canonical unnumbered names, any case, with an optional colon-free line", () => {
    const text = doc("Abstract", body, "Introduction", body, "Acknowledgments", body, "CONCLUSION", body, "Related Works", body, "Appendix A", body);
    assert.deepEqual(headingsOf(text), ["Abstract", "Introduction", "Acknowledgments", "CONCLUSION", "Related Works", "Appendix A"]);
  });

  it("marks sit exactly at line starts and the heading is the trimmed line (CRLF-safe)", () => {
    const text = "Title words here\r\n  2. Methods  \r\n" + body + "\r\n";
    const marks = detectHeadings(text);
    assert.equal(marks.length, 1);
    assert.equal(marks[0].heading, "2. Methods");
    assert.ok(text.slice(marks[0].start).trimStart().startsWith("2. Methods"));
    assert.ok(marks[0].start === 0 || text[marks[0].start - 1] === "\n");
  });

  it("a heading on the very first or very last line is found", () => {
    assert.deepEqual(headingsOf("1. Introduction\n" + body), ["1. Introduction"]);
    assert.deepEqual(headingsOf(body + "\nReferences"), ["References"]);
  });
});

describe("detectHeadings — things that are not headings", () => {
  it("title lines, author lines and a capital letter without a period", () => {
    const text = doc("1", "6G WavesFM:", "A Foundation Model for Sensing,", "Communication, and Localization", "Ahmed Aboulfotouh, Elsayed Mohammed, and Hatem Abou-Zeid", "Department of Electrical Engineering, University of Calgary, Canada", "A. Krizhevsky, I. Sutskever, and G. Hinton");
    assert.deepEqual(headingsOf(text), []);
  });

  it("table rows, numeric lines and wrapped sentence fragments that start with a number", () => {
    const text = doc("5 0.99 0.98 0.97", "2.4 GHz and 5 GHz bands are both used in the", "6 Hz and the", "10 Training samples were drawn at random from the full set.", "3.5", "12", "1 2 3 4");
    assert.deepEqual(headingsOf(text), []);
  });

  it("sentences, captions and reference entries", () => {
    const text = doc(
      "Fig. 3. Accuracy of the model against the number of training rounds.",
      "Table 2. Results on the held-out split.",
      "Figure 1: System overview",
      "[12] A. Smith, B. Jones, Deep things, in Proc. IEEE, 2020.",
      "1. Smith, J.; Doe, A. A study of things. Sensors 2020, 20, 1–10.",
      "2. Li, X., Wang, Y.: Another study (2019)",
      "3. We then trained the model for ten epochs on the data.",
    );
    assert.deepEqual(headingsOf(text), []);
  });

  it("regressions from the real PDFs: algorithm listings, units, figure panels, dates, wrapped lines", () => {
    const text = doc(
      "3 Initialize the loss value: L ← 0", // pseudocode (arrow)
      "5 Map X into a sequence of P × P flattened", // pseudocode (math sign)
      "2 Imask (𝑛, 𝑖, 𝑗)", // math italic letters
      "16 Optimize f, g to minimize L via", // cut mid-sentence
      "10 MHz and 60 MHz), and duration, typically averaging around", // a quantity
      "10 MSps across three outdoor sessions under realistic multi-", // a quantity, hyphen-wrapped
      "1 Mod 60.48 14.27 99.67", // table row
      "26 August 2021", // a date
      "26 August 2021 (b) Microwaves20:00 20:30 21:00 21:30", // figure panel
      "0.11 USD/day. WDOA load scheduler shows a similar peak load in restricted, mul-", // hyphen-wrapped
    );
    assert.deepEqual(headingsOf(text), []);
  });

  it("headings that merely contain numbers or symbols still count", () => {
    const text = doc("3 5G Network Slicing", "4.2 Phase 2 Evaluation", "5. Comparison with Prior Work (2020 Baselines)", "6 Q&A and Discussion");
    assert.deepEqual(headingsOf(text), ["3 5G Network Slicing", "4.2 Phase 2 Evaluation", "5. Comparison with Prior Work (2020 Baselines)", "6 Q&A and Discussion"]);
  });

  it("over-long lines and lines ending like a sentence are never headings", () => {
    const long = "1. " + "Introduction to a very long and rambling line that is clearly a paragraph and not a heading at all ".repeat(3);
    assert.deepEqual(headingsOf(long), []);
    assert.deepEqual(headingsOf("2. Methods are described here."), []);
    assert.deepEqual(headingsOf("Introduction to the problem of learning"), []); // a canonical word starts a longer phrase
  });

  it("a canonical name inside running text is not a heading", () => {
    assert.deepEqual(headingsOf(doc("as described in the introduction", "References are listed below.", "Results of the study are shown")), []);
  });
});

describe("detectHeadings — total and well-formed on hostile input", () => {
  it("empty, whitespace-only, no newline, and only newlines", () => {
    assert.deepEqual(detectHeadings(""), []);
    assert.deepEqual(detectHeadings("   \n\n  \t\n"), []);
    assert.deepEqual(detectHeadings("x".repeat(100_000)), []);
    assert.deepEqual(detectHeadings("\n".repeat(1000)), []);
  });

  it("is deterministic and does not mutate or depend on prior calls", () => {
    const text = doc("I. INTRODUCTION", body, "II. METHODS", body);
    assert.deepEqual(detectHeadings(text), detectHeadings(text));
  });

  it("property: on random line soup, marks are increasing, line-aligned, in range, and trimmed", () => {
    const pieces = ["I. INTRODUCTION", "1. Methods", "2.1. Results", "A. Dataset", "Abstract", "References", body, "5 0.99", "", "   ", "[3] A. B, C.", "Fig. 2.", "😀 1. Emoji", "1 Nbsp heading", "x".repeat(300), "II.  SPACED   OUT", "3 Conclusions\t"];
    let a = 12345;
    const rnd = (): number => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let n = 0; n < 500; n++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => pieces[Math.floor(rnd() * pieces.length)]);
      const text = lines.join(rnd() < 0.3 ? "\r\n" : "\n");
      const marks = detectHeadings(text);
      let prev = -1;
      for (const m of marks) {
        assert.ok(m.start > prev && m.start < text.length, `increasing and in range (doc ${n})`);
        assert.ok(m.start === 0 || text[m.start - 1] === "\n", `line start (doc ${n})`);
        assert.equal(m.heading, m.heading.trim());
        assert.ok(m.heading.length > 0 && m.level >= 1);
        assert.ok(text.slice(m.start).trimStart().startsWith(m.heading) || text.slice(m.start).startsWith(m.heading), `heading text matches (doc ${n})`);
        prev = m.start;
      }
    }
  });
});
