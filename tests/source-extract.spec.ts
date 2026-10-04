/**
 * Source extraction (KTD3–KTD5, R7, R11, R15): bytes → captured text with
 * grounded page offsets; unusable inputs fail with normalized codes and never
 * become text. Offline fixtures only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { FAST_XML_PARSER_VERSION, MAX_PDF_PAGES, UNPDF_VERSION, MAX_TEI_DECODED_BYTES, SourceError, extractPdf, extractTei, matchesPaperIdentity } from "../src/core/source/extract.ts";
import { makePdf, makeTei } from "./helpers/pdf.ts";

const rejects = async (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e) => e instanceof SourceError && e.code === code, `expected SourceError ${code}`);

describe("extraction identity", () => {
  it("names the installed parser versions (a dependency bump must change the pointer revision on purpose)", () => {
    const version = (pkg: string): string => (JSON.parse(readFileSync(new URL(`../node_modules/${pkg}/package.json`, import.meta.url), "utf8")) as { version: string }).version;
    assert.equal(UNPDF_VERSION, version("unpdf"));
    assert.equal(FAST_XML_PARSER_VERSION, version("fast-xml-parser"));
  });
});

describe("extractPdf", () => {
  it("captures text with page offsets that slice back to each page's text", async () => {
    const pages = [["Battery chemistry limits cycle life.", "Cells age faster at high temperature."], ["Second page about capacity fade."]];
    const out = await extractPdf(makePdf(pages));
    assert.ok(out.pageStarts !== null && out.pageStarts.length === 2);
    assert.equal(out.pageStarts[0], 0);
    assert.ok(out.text.slice(out.pageStarts[1]).startsWith("Second page about capacity fade."));
    assert.ok(out.text.includes("Cells age faster at high temperature."));
    assert.match(out.extraction, /^unpdf@\d+\.\d+\.\d+/, "extraction identity names the parser version");
  });

  it("is deterministic: identical bytes give identical text and identity", async () => {
    const bytes = makePdf([["Same bytes always give the same captured text and the same identity."]]);
    const a = await extractPdf(bytes);
    const b = await extractPdf(bytes);
    assert.deepEqual(a, b);
  });

  it("refuses an image-only PDF as no_text_layer (no OCR is implied)", async () => {
    await rejects(extractPdf(makePdf([[], []])), "no_text_layer");
  });

  it("refuses non-PDF bytes as not_a_document", async () => {
    await rejects(extractPdf(new TextEncoder().encode("<html><body>Please log in</body></html>")), "not_a_document");
  });

  it("refuses a malformed PDF body and a truncated PDF", async () => {
    const good = makePdf([["Some real sentence about batteries and their chemistry limits."]]);
    await rejects(extractPdf(good.slice(0, Math.floor(good.length * 0.6))), "truncated");
    const garbled = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Broken >>\nendobj\n%%EOF\n");
    await rejects(extractPdf(garbled), "malformed");
  });

  it("refuses a document over the page limit", async () => {
    const many = Array.from({ length: MAX_PDF_PAGES + 1 }, (_, i) => [`Page ${i} has some text content here.`]);
    await rejects(extractPdf(makePdf(many)), "too_large");
  });
});

describe("extractTei", () => {
  const tei = makeTei({
    title: "Cycle Life of Cells",
    sections: [
      { head: "Introduction", paragraphs: ["Cells age <ref type=\"bibr\">[1]</ref> faster at 45 &#176;C &amp; above.", "Second paragraph."] },
      { paragraphs: ["Emoji 😀 survive as astral code points."] },
    ],
  });

  it("builds paragraph-separated text from body heads and paragraphs, decoding entities and keeping inline text", () => {
    const out = extractTei(new TextEncoder().encode(tei));
    assert.ok(out.text.includes("Cells age [1] faster at 45 ° C & above.") || out.text.includes("Cells age [1] faster at 45 °C & above."), out.text);
    assert.ok(out.text.includes("Introduction"));
    assert.ok(out.text.split("\n\n").length >= 3, "paragraphs are blank-line separated for the chunker");
    assert.equal(out.pageStarts, null, "TEI carries no page grounding here");
    assert.match(out.extraction, /^grobid-tei@/);
  });

  it("astral characters keep UTF-16 spans exact", () => {
    const { text } = extractTei(new TextEncoder().encode(tei));
    const quote = "Emoji 😀 survive as astral code points.";
    const start = text.indexOf(quote);
    assert.ok(start >= 0);
    assert.equal(text.slice(start, start + quote.length), quote);
  });

  it("accepts gzip-compressed TEI (the Content API ships .grobid-xml gzipped)", () => {
    const out = extractTei(gzipSync(Buffer.from(tei)));
    assert.ok(out.text.includes("Second paragraph."));
  });

  it("refuses DOCTYPE/entity declarations (no external entity or resource resolution)", () => {
    const evil = makeTei({
      title: "x",
      sections: [{ paragraphs: ["&xxe;"] }],
      doctype: '<!DOCTYPE TEI [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
    });
    assert.throws(() => extractTei(new TextEncoder().encode(evil)), (e) => e instanceof SourceError && e.code === "unsupported_xml");
  });

  it("refuses a gzip bomb over the decoded limit and non-XML bodies", () => {
    const bomb = gzipSync(Buffer.alloc(MAX_TEI_DECODED_BYTES + 1024, "a"));
    assert.throws(() => extractTei(bomb), (e) => e instanceof SourceError && e.code === "too_large");
    assert.throws(() => extractTei(new TextEncoder().encode("<html>nope</html>")), (e) => e instanceof SourceError && e.code === "not_a_document");
  });

  it("refuses a TEI with an empty body as no_text_layer", () => {
    const empty = makeTei({ title: "t", sections: [] });
    assert.throws(() => extractTei(new TextEncoder().encode(empty)), (e) => e instanceof SourceError && e.code === "no_text_layer");
  });
});

describe("matchesPaperIdentity", () => {
  const paper = { doi: "10.1234/cells", title: "Cycle Life of Lithium Cells Under Thermal Stress" };
  it("accepts text carrying the title as a phrase, or the DOI", () => {
    assert.equal(matchesPaperIdentity("Cycle Life of Lithium Cells Under Thermal Stress\nAbstract ...", paper), true);
    assert.equal(matchesPaperIdentity("unrelated front matter. doi:10.1234/CELLS", paper), true);
  });
  it("tolerates line breaks, hyphenation, case and a mildly different title", () => {
    assert.equal(matchesPaperIdentity("CYCLE LIFE OF LITHIUM\nCELLS UNDER THERMAL\nSTRESS\nJ. Doe", paper), true);
    assert.equal(matchesPaperIdentity("Cycle Life of Lith- ium Cells Under Thermal Stress", paper), true);
    assert.equal(matchesPaperIdentity("Cycle life of lithium cells under thermal stress: a review", paper), true);
  });
  it("rejects another paper's text", () => {
    assert.equal(matchesPaperIdentity("Federated learning for wireless foundation models. We propose a novel encoder.", paper), false);
  });
  it("rejects a related paper that merely shares title words (found by the CLI smoke)", () => {
    const related = { doi: "10.48550/arxiv.2411.09996", title: "Building 6G Radio Foundation Models with Transformer Architectures" };
    const other = "6G WavesFM: A Foundation Model for Sensing, Communication, and Localization. Radio foundation models built with transformer architectures have been proposed; building on them we present a model with many tasks.";
    assert.equal(matchesPaperIdentity(other, related), false);
  });
  it("title words in the wrong order do not match", () => {
    assert.equal(matchesPaperIdentity("Stress Thermal Under Cells Lithium of Life Cycle", paper), false);
  });
  it("an arXiv DOI is attested by the arXiv identifier stamp the preprint carries", () => {
    const arx = { doi: "10.48550/arxiv.2411.09996", title: "A Quite Different Published Title For The Same Preprint" };
    assert.equal(matchesPaperIdentity("Some title.\narXiv:2411.09996v1 [eess.SP] 15 Nov 2024\nAbstract", arx), true);
    assert.equal(matchesPaperIdentity("Some title.\narXiv:2504.14100v1 [eess.SP]", arx), false);
  });
  it("an identifier that only appears deep in the document (a reference list) does not attest identity (found by the CLI smoke)", () => {
    const cited = { doi: "10.48550/arxiv.2411.09996", title: "Building 6G Radio Foundation Models with Transformer Architectures" };
    const body = "Wireless Foundation Model Study. ".repeat(400); // well past the first page
    const citing = `6G WavesFM: A Foundation Model for Sensing.\n${body}\nReferences\n[3] Aboulfotouh et al., arXiv:2411.09996v1, 2024. doi:10.48550/arxiv.2411.09996`;
    assert.equal(matchesPaperIdentity(citing, cited), false);
    const doiPaper = { doi: "10.1234/cells", title: "Cycle Life of Lithium Cells Under Thermal Stress" };
    assert.equal(matchesPaperIdentity(`Some other first page.\n${body}\n[9] see 10.1234/cells`, doiPaper), false);
    assert.equal(matchesPaperIdentity(`Journal header doi:10.1234/cells\n${body}`, doiPaper), true, "on the first page it still counts");
  });
  it("without usable title words only the DOI can attest identity", () => {
    assert.equal(matchesPaperIdentity("anything at all", { doi: "10.1/x", title: "" }), false);
    assert.equal(matchesPaperIdentity("see 10.1/x here", { doi: "10.1/x", title: "" }), true);
  });
});
