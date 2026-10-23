/**
 * W2: the `% cN` + SOURCES annotation parser (pure, invented text throughout;
 * invented DOIs with real pointer syntax, never paper text).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import {
  MAX_CLAIM_MARKERS,
  MAX_SOURCES_PER_CLAIM,
  parseAnnotatedOutput,
  SOURCES_DELIMITER,
  type AnnotatedClaim,
  type ParsedAnnotations,
} from "../src/core/verify/annotations.ts";
import { extractUnits } from "../src/core/provenance/units.ts";
import { linesFromString, parsePaper, stripComment } from "../src/core/review/latex.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PTR = "10.5555/calib1@cf7fcb9436071d8b#100-200";

const claimByMarker = (p: ParsedAnnotations, marker: number): AnnotatedClaim => {
  const c = p.claims.find((k) => k.marker === marker);
  assert.ok(c !== undefined, `claim c${marker} binds`);
  return c;
};

describe("parseAnnotatedOutput", () => {
  it("2.1 a well-formed output binds claims and sources and strips markers", () => {
    const output = [
      "Invented steady cultures divide \\cite{calib2024} at a constant rate. % c1",
      "Invented lamp light shifts the growth curve \\cite{calib2024} upward and sideways \\cite{aux2023}. % c2",
      SOURCES_DELIMITER,
      "c1 | calib2024 | section=Growth conditions",
      `c1 | calib2024 | ptr=${PTR}`,
      "c2 | calib2024 | section=Lamp effects",
      "c2 | aux2023 | section=Auxiliary notes",
    ].join("\n");
    const p = parseAnnotatedOutput(output);
    assert.equal(p.mode, "annotated");
    assert.deepEqual(p.problems, []);
    assert.equal(p.claims.length, 2);
    const c1 = claimByMarker(p, 1);
    assert.equal(c1.unitId, "u1");
    assert.equal(c1.plain, "Invented steady cultures divide at a constant rate.");
    assert.deepEqual(c1.cites, ["calib2024"]);
    assert.equal(c1.sources.length, 2);
    assert.deepEqual(c1.sources[0], { citekey: "calib2024", ref: { kind: "section", heading: "Growth conditions" }, line: 4 });
    assert.deepEqual(c1.sources[1], {
      citekey: "calib2024",
      ref: { kind: "pointer", pointer: PTR, doi: "10.5555/calib1", revision: "cf7fcb9436071d8b", start: 100, end: 200 },
      line: 5,
    });
    const c2 = claimByMarker(p, 2);
    assert.equal(c2.unitId, "u2");
    assert.deepEqual(c2.cites, ["calib2024", "aux2023"]);
    assert.equal(c2.sources.length, 2);
    assert.doesNotMatch(p.latex, /% ?c\d/);
    assert.doesNotMatch(p.latex, /---SOURCES---/);
  });

  it("2.2 marker removal keeps the line count and leaves other comments alone", () => {
    const output = [
      "Alpha holds \\cite{k1} steady. % c1",
      "Beta \\% escaped fully.",
      "% note",
      "Gamma drifts \\cite{k1} slowly.",
    ].join("\n");
    const p = parseAnnotatedOutput(output);
    assert.equal(p.latex.split("\n").length, 4, "no line is ever removed");
    assert.equal(p.latex.split("\n")[0], "Alpha holds \\cite{k1} steady.");
    assert.ok(p.latex.includes("% note"), "an ordinary comment stays");
    assert.ok(p.latex.includes("\\%"), "an escaped percent stays");
    assert.doesNotMatch(p.latex, /% ?c\d/);
    assert.equal(p.claims.length, 1);
    assert.equal(p.claims[0]!.unitId, "u1");
  });

  it("2.3 property over the golden corpus: marked text parses to the frozen units", () => {
    const dir = `${ROOT}tests/fixtures/provenance-units-golden/`;
    const iters = readdirSync(dir, { withFileTypes: true }).filter((f) => f.isDirectory() && f.name.startsWith("iter-")).map((f) => f.name);
    assert.ok(iters.length > 0, "golden iters exist");
    const proj = (u: { id: string; kind: string; line: number; section: string; plain: string; cites: string[] }) =>
      ({ id: u.id, kind: u.kind, line: u.line, section: u.section, plain: u.plain, cites: u.cites });
    for (const iter of iters) {
      const main = readFileSync(`${dir}${iter}/main.tex`, "utf8");
      const golden = JSON.parse(readFileSync(`${dir}${iter}.units.json`, "utf8")) as Array<Record<string, unknown>>;
      const marked = main
        .split("\n")
        .map((l, i) => (stripComment(l) !== l ? l : `${l} % c${1 + (i % 20)}`))
        .join("\n");
      const p = parseAnnotatedOutput(marked);
      assert.deepEqual(p.units.map(proj), golden.map((g) => ({ id: g.id, kind: g.kind, line: g.line, section: g.section, plain: g.text, cites: g.cites })), iter);
      const direct = extractUnits(parsePaper(linesFromString(marked, "fragment.tex"))).map(proj);
      assert.deepEqual(p.units.map(proj), direct, `${iter}: same units as the unmarked parse`);
      const norm = (s: string): string => s.split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n");
      assert.deepEqual(p.units.map((u) => norm(u.raw)), extractUnits(parsePaper(linesFromString(marked, "fragment.tex"))).map((u) => norm(u.raw)), `${iter}: raw equal modulo trailing spaces`);
    }
  });

  it("2.4 seeded property: marker spacing and case do not matter", () => {
    let a = 0x9e3779b9;
    const rng = (): number => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const spacings = ["", " ", "   "];
    for (let s = 0; s < 12; s++) {
      const sp = spacings[Math.floor(rng() * spacings.length)]!;
      const n = 1 + Math.floor(rng() * 3);
      const lines = [
        `Invented alpha finding holds \\cite{ka} here.${sp}% c${n}`,
        `Invented beta finding follows \\cite{kb} there.${sp}% C${n + 1}`,
      ];
      const p = parseAnnotatedOutput(lines.join("\n"));
      assert.equal(p.mode, "annotated", `seed ${s}`);
      assert.equal(p.claims.length, 2, `seed ${s}`);
      assert.deepEqual(p.claims.map((c) => c.marker).sort((x, y) => x - y), [n, n + 1].sort((x, y) => x - y), `seed ${s}`);
      assert.doesNotMatch(p.latex, /% ?[cC]\d/, `seed ${s}`);
    }
  });

  it("2.5 a marker binds the last unit ending on its line; headings, blanks and marker-only lines bind nothing", () => {
    const output = [
      "First invented claim \\cite{ka} here. Second invented claim \\cite{ka} there. % c1",
      "First invented line \\cite{ka}",
      "continues here. % c2",
      "\\section{Findings} % c3",
      "A later invented claim \\cite{ka} stands. % c4",
      "% c5",
    ].join("\n");
    const p = parseAnnotatedOutput(output);
    assert.equal(claimByMarker(p, 1).unitId, "u2", "two sentences on one line: the marker binds the second");
    assert.equal(claimByMarker(p, 2).unitId, "u3", "a marker on the last line of a two-line sentence binds it");
    assert.equal(claimByMarker(p, 4).plain, "A later invented claim stands.");
    for (const m of [3, 5]) {
      const prob = p.problems.find((x) => x.code === "unmapped-marker" && x.marker === m);
      assert.ok(prob !== undefined, `c${m} is unmapped`);
    }
    assert.ok(!p.claims.some((c) => c.marker === 3 || c.marker === 5));
  });

  it("2.6 duplicates bind once and out-of-range markers are flagged", () => {
    const output = [
      "First claim \\cite{ka} here. % c1",
      "Second claim \\cite{ka} there. % c1",
      "Third claim \\cite{ka} away. % c0",
      "Fourth claim \\cite{ka} far. % c21",
      "Fifth claim \\cite{ka} beyond. % c999999",
      "Sixth claim \\cite{ka} kept. % c1000000",
      "No marker here \\cite{ka} plain.",
      SOURCES_DELIMITER,
      "c1 | ka | section=Intro",
    ].join("\n");
    const p = parseAnnotatedOutput(output);
    assert.equal(p.claims.length, 1, "only the first c1 binds");
    assert.equal(p.claims[0]!.unitId, "u1");
    assert.equal(p.claims[0]!.sources.length, 1, "c1 sources attach to the first-bound claim");
    const dups = p.problems.filter((x) => x.code === "duplicate-marker");
    assert.equal(dups.length, 1);
    assert.equal(dups[0]!.marker, 1);
    assert.deepEqual(p.problems.filter((x) => x.code === "marker-out-of-range").map((x) => x.marker).sort((x, y) => x! - y!), [0, 21, 999999]);
    assert.ok(!p.claims.some((c) => c.marker === 0 || c.marker === 21 || c.marker === 999999));
    assert.ok(p.latex.includes("c1000000"), "a seven-digit comment is not marker-shaped and the line stays");
    assert.equal(MAX_CLAIM_MARKERS, 20);
  });

  it("2.7 a cited key with no line is source-missing; a line for an uncited key is ref-not-cited", () => {
    const output = [
      "First claim \\cite{ka} here and second \\cite{kb} there. % c1",
      SOURCES_DELIMITER,
      "c1 | ka | section=Intro",
      "c1 | kc | section=Elsewhere",
    ].join("\n");
    const p = parseAnnotatedOutput(output);
    const c1 = claimByMarker(p, 1);
    assert.equal(c1.sources.length, 1, "the uncited key is not attached");
    const missing = p.problems.find((x) => x.code === "source-missing");
    assert.deepEqual([missing!.marker, missing!.citekey], [1, "kb"]);
    const ref = p.problems.find((x) => x.code === "ref-not-cited");
    assert.deepEqual([ref!.marker, ref!.citekey], [1, "kc"]);
  });

  it("2.8 bad pointers and bad source lines are flagged; a valid pointer parses", () => {
    const output = [
      "Claim \\cite{ka} here. % c1",
      SOURCES_DELIMITER,
      "c1 | ka | ptr=garbage",
      "c1 | ka | ptr=10.5555/x@0123456789abcde#1-2",
      "c1 | ka | ptr=10.5555/x@0123456789abcdef#50-10",
      "c1 | ka",
      "c1 | ka | foo=bar",
      `c1 | ka | ptr=${PTR}`,
    ].join("\n");
    const p = parseAnnotatedOutput(output);
    assert.equal(p.problems.filter((x) => x.code === "bad-pointer").length, 3, "garbage, 15-hex revision and start >= end");
    assert.equal(p.problems.filter((x) => x.code === "bad-source-line").length, 2, "two parts and foo=");
    const c1 = claimByMarker(p, 1);
    assert.equal(c1.sources.length, 1);
    assert.deepEqual(c1.sources[0]!.ref, { kind: "pointer", pointer: PTR, doi: "10.5555/calib1", revision: "cf7fcb9436071d8b", start: 100, end: 200 });
  });

  it("2.9 four sources attach; the fifth reports too-many-sources and identical lines dedupe", () => {
    const five = ["A", "B", "A", "C", "D", "E"].map((h) => `c1 | ka | section=${h}`).join("\n");
    const p = parseAnnotatedOutput(`Claim \\cite{ka} here. % c1\n${SOURCES_DELIMITER}\n${five}`);
    const c1 = claimByMarker(p, 1);
    assert.deepEqual(c1.sources.map((s) => (s.ref as { heading: string }).heading), ["A", "B", "C", "D"]);
    const many = p.problems.filter((x) => x.code === "too-many-sources");
    assert.equal(many.length, 1);
    assert.equal(many[0]!.marker, 1);
    const four = ["A", "B", "C", "D"].map((h) => `c1 | ka | section=${h}`).join("\n");
    const ok = parseAnnotatedOutput(`Claim \\cite{ka} here. % c1\n${SOURCES_DELIMITER}\n${four}`);
    assert.deepEqual(ok.problems, []);
    assert.equal(ok.claims[0]!.sources.length, 4);
    assert.equal(MAX_SOURCES_PER_CLAIM, 4);
  });

  it("2.10 no markers means fallback: claims stay empty, units cover the cut text", () => {
    const output = ["First claim \\cite{ka} here.", "Second claim \\cite{kb} there.", SOURCES_DELIMITER, "c1 | ka | section=X"].join("\n");
    const p = parseAnnotatedOutput(output);
    assert.equal(p.mode, "fallback");
    assert.deepEqual(p.claims, []);
    assert.deepEqual(p.problems, []);
    assert.equal(p.latex, "First claim \\cite{ka} here.\nSecond claim \\cite{kb} there.");
    assert.equal(p.units.length, 2);
  });

  it("2.11 markers without a delimiter leave every cited key source-missing", () => {
    const output = ["First claim \\cite{ka} here. % c1", "Second claim \\cite{kb} there. % c2"].join("\n");
    const p = parseAnnotatedOutput(output);
    assert.equal(p.mode, "annotated");
    assert.equal(p.claims.length, 2);
    assert.deepEqual(p.problems.map((x) => [x.code, x.marker, x.citekey]), [["source-missing", 1, "ka"], ["source-missing", 2, "kb"]]);
  });

  it("2.12 an esbuild browser bundle of annotations.ts has no node: import (pin: green on the stub by design)", async () => {
    const result = await build({
      entryPoints: [`${ROOT}src/core/verify/annotations.ts`],
      bundle: true,
      platform: "browser",
      format: "esm",
      outdir: `${ROOT}node_modules/.cache/annotations-bundle-check`,
      write: false,
      logLevel: "silent",
      absWorkingDir: ROOT,
    });
    assert.equal(result.errors.length, 0, `bundle errors: ${result.errors.map((e) => e.text).join("; ")}`);
    assert.equal(result.warnings.length, 0, `bundle warnings: ${result.warnings.map((w) => w.text).join("; ")}`);
    const out = result.outputFiles.map((f) => f.text).join("\n");
    assert.doesNotMatch(out, /from\s+["']node:/, "no node: import survives the bundle");
  });
});
