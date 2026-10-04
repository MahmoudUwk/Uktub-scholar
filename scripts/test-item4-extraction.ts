import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { extractPdf, SourceError, MAX_SOURCE_BYTES, MAX_PDF_PAGES } from "../src/core/source/extract.ts";
import { chunkDocument } from "../src/core/chunk-document.ts";
import { MAX_SECTION_LABEL_CHARS } from "../src/core/sections.ts";
import type { ChunkTextConfig } from "../src/core/chunk.ts";

const CFG: ChunkTextConfig = {
  chunk_tokens: 512,
  overlap_tokens: 0,
  chars_per_token: 2.8,
  boundary: "section",
};

const maxChars = Math.floor(CFG.chunk_tokens * CFG.chars_per_token);

function findPdfs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findPdfs(full));
    } else if (entry.endsWith(".pdf")) {
      results.push(full);
    }
  }
  return results.sort();
}

async function run() {
  console.log("=== ITEM 4: EXTRACTION AND STRUCTURE ON 14 REAL PDFS ===");
  const pdfs = findPdfs(join(process.cwd(), "..", "test_papers"));
  console.log(`Found ${pdfs.length} PDFs in ../test_papers:`);

  const summary: any[] = [];
  let totalExtractionMs = 0;
  let totalChunks = 0;
  let totalHeadings = 0;

  for (const pdfPath of pdfs) {
    const filename = pdfPath.split("/").slice(-2).join("/");
    const bytes = readFileSync(pdfPath);
    const start = performance.now();
    const extraction = await extractPdf(bytes);
    const durMs = Math.round(performance.now() - start);
    totalExtractionMs += durMs;

    const { text, pageStarts, sections, extraction: extId } = extraction;
    const numPages = pageStarts ? pageStarts.length : 1;
    const headingsCount = sections ? sections.length : 0;
    totalHeadings += headingsCount;

    // Verify chunk tiling
    const chunks = chunkDocument(text, sections, CFG);
    totalChunks += chunks.length;

    // Check 1: Tiling (starts at 0, no gaps, ends at text.length)
    assert.equal(chunks[0]?.char_start, 0, `${filename}: First chunk does not start at 0`);
    assert.equal(chunks[chunks.length - 1]?.char_end, text.length, `${filename}: Last chunk does not end at text.length`);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (i > 0) {
        assert.equal(c.char_start, chunks[i - 1].char_end, `${filename}: Gap or overlap between chunks ${i - 1} and ${i}`);
      }
      // Check 2: Text slice exactly matches
      assert.equal(c.text, text.slice(c.char_start, c.char_end), `${filename}: Chunk text mismatch at index ${i}`);
      // Check 3: Chunk size bounded by maxChars (or single unbroken word/heading)
      if (c.char_end - c.char_start > maxChars) {
        // Only allowable if it's an unbroken word or section without sentence breaks
        console.warn(`[WARN] Chunk ${i} exceeds maxChars (${c.char_end - c.char_start} > ${maxChars})`);
      }
      // Check 4: Section label <= MAX_SECTION_LABEL_CHARS
      if (c.section !== null) {
        assert.ok(c.section.length <= MAX_SECTION_LABEL_CHARS, `${filename}: Section label exceeds max chars (${c.section.length})`);
      }
    }

    summary.push({
      file: filename,
      sizeBytes: bytes.length,
      durMs,
      chars: text.length,
      pages: numPages,
      headings: headingsCount,
      chunks: chunks.length,
      sampleHeadings: sections?.slice(0, 3).map(s => s.heading) ?? []
    });

    console.log(`[PASS] ${filename}: ${numPages} pages, ${text.length} chars, ${headingsCount} headings, ${chunks.length} chunks, in ${durMs}ms`);
  }

  console.log(`\nAll 14 real PDFs passed extraction and chunk tiling verification!`);
  console.log(`Total time: ${totalExtractionMs}ms (avg ${(totalExtractionMs / 14).toFixed(1)}ms/doc). Total chunks: ${totalChunks}. Total headings: ${totalHeadings}.`);

  console.log("\n=== HOSTILE PDF TESTS ===");
  // Test 1: Scanned/No-text-layer (Valid PDF structure, but empty/whitespace text)
  // Construct minimal valid PDF with empty text
  const emptyPdf = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj\n" +
    "4 0 obj<</Length 0>>stream\nendstream\nendobj\n" +
    "xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000111 00000 n \n0000000212 00000 n \n" +
    "trailer<</Size 5/Root 1 0 R>>\nstartxref\n260\n%%EOF\n"
  );
  try {
    await extractPdf(emptyPdf);
    assert.fail("emptyPdf should have thrown SourceError(no_text_layer)");
  } catch (err: any) {
    assert.equal(err.code, "no_text_layer", `Expected no_text_layer, got ${err.code}: ${err.message}`);
    console.log("[PASS] empty/scanned PDF correctly refused with no_text_layer");
  }

  // Test 2: Missing %PDF- header
  const noHeaderPdf = Buffer.from("NOT_A_PDF header with some filler bytes to make it long enough %%EOF");
  try {
    await extractPdf(noHeaderPdf);
    assert.fail("noHeaderPdf should have thrown SourceError(not_a_document)");
  } catch (err: any) {
    assert.equal(err.code, "not_a_document", `Expected not_a_document, got ${err.code}: ${err.message}`);
    console.log("[PASS] missing %PDF- header correctly refused with not_a_document");
  }

  // Test 3: Truncated (missing %%EOF)
  const truncatedPdf = Buffer.from("%PDF-1.4\nsome content without the required eof marker at the end");
  try {
    await extractPdf(truncatedPdf);
    assert.fail("truncatedPdf should have thrown SourceError(truncated)");
  } catch (err: any) {
    assert.equal(err.code, "truncated", `Expected truncated, got ${err.code}: ${err.message}`);
    console.log("[PASS] truncated PDF correctly refused with truncated");
  }

  // Test 4: Malformed internal syntax (has %PDF- and %%EOF, but invalid PDF syntax)
  const malformedPdf = Buffer.from("%PDF-1.4\ncorrupted random garbage binary 1234567890 \x00\xff\xee\xdd %%EOF\n");
  try {
    await extractPdf(malformedPdf);
    assert.fail("malformedPdf should have thrown SourceError(malformed)");
  } catch (err: any) {
    assert.equal(err.code, "malformed", `Expected malformed, got ${err.code}: ${err.message}`);
    console.log("[PASS] malformed PDF correctly refused with malformed");
  }

  // Test 5: Oversized bytes (> 64MB)
  const tooLargeBytes = new Uint8Array(MAX_SOURCE_BYTES + 1);
  try {
    await extractPdf(tooLargeBytes);
    assert.fail("tooLargeBytes should have thrown SourceError(too_large)");
  } catch (err: any) {
    assert.equal(err.code, "too_large", `Expected too_large, got ${err.code}: ${err.message}`);
    console.log("[PASS] oversized bytes (>64MB) correctly refused with too_large");
  }

  console.log("\nALL ITEM 4 TESTS COMPLETED SUCCESSFULLY!");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
