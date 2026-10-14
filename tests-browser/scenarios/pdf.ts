/**
 * Differential scenario: PDF text extraction (`extractPdf`) and the section
 * chunks built from it. The SAME function runs in Node and in the worker;
 * results are normalized to JSON so the two environments compare exactly.
 *
 * Bundle-safe AND Node-safe: the only imports are core modules and `node:crypto`
 * (aliased to the browser shim in the bundle).
 */
import { createHash } from "node:crypto";
import { extractPdf, SourceError } from "../../src/core/source/extract.ts";
import { splitBySections } from "../../src/core/sections.ts";
import type { Norm } from "./norm.ts";

export interface PdfFixture {
  name: string;
  bytes: Uint8Array;
}

/** Test-fixed split options (the product reads `config/chunking.yaml`; the point here is that equal text and marks give equal chunks). */
const SPLIT = { maxChars: Math.floor(512 * 2.8), minChars: 400 };

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export async function runPdfScenario(fixtures: PdfFixture[]): Promise<Record<string, Norm>> {
  const out: Record<string, Norm> = {};
  for (const f of fixtures) {
    try {
      const ex = await extractPdf(f.bytes);
      const chunks = splitBySections(ex.text, ex.sections ?? [], SPLIT);
      out[f.name] = {
        ok: true,
        extraction: ex.extraction,
        textLength: ex.text.length,
        textSha256: sha256(ex.text),
        textHead: ex.text.slice(0, 160),
        pageStarts: ex.pageStarts,
        sections: (ex.sections ?? []) as unknown as Norm,
        chunkCount: chunks.length,
        chunks: chunks as unknown as Norm,
      };
    } catch (err) {
      out[f.name] = err instanceof SourceError ? { ok: false, code: err.code, message: err.message } : { ok: false, code: "UNTYPED", message: String(err) };
    }
  }
  return out;
}
