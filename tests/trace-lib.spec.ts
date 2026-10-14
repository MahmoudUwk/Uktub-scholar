/**
 * Cause-tracing pure core (scripts/live/trace-causes.ts): text normalization,
 * content-token extraction, unit-to-write matching, near-variant detection and
 * the mechanical cause classifier with tie-breaks. Fixture values only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyCause,
  contentTokens,
  matchWrite,
  nearVariant,
  normalizeText,
  tokenOccurs,
} from "../scripts/live/trace-lib.ts";

describe("normalizeText", () => {
  it("strips latex cites/commands and collapses whitespace", () => {
    assert.equal(normalizeText("LoRA cuts VRAM\\cite{hu2021lora} from 1.2TB  to\\n350GB."), "lora cuts vram from 1.2tb to 350gb.");
  });
  it("treats multiplication signs and dashes uniformly", () => {
    assert.equal(normalizeText("10,000\u00d7 drop -- 3\u00d7"), normalizeText("10000x drop - 3x"));
  });
});

describe("contentTokens", () => {
  it("extracts numbers-with-units, hardware names and distinctive terms", () => {
    const toks = contentTokens("LoRA cuts VRAM from 1.2TB to 350GB on a V100 cluster with gradient checkpointing.");
    const kinds = new Map(toks.map((t) => [t.token, t.kind]));
    assert.equal(kinds.get("1.2tb"), "number");
    assert.equal(kinds.get("350gb"), "number");
    assert.equal(kinds.get("v100"), "hardware");
    assert.ok((kinds.get("checkpointing") ?? "") === "term" || [...kinds.values()].includes("term"));
  });
  it("ignores stopwords and short words", () => {
    const toks = contentTokens("The model and the task are generic words.");
    assert.ok(toks.every((t) => t.token.length >= 5 || t.kind !== "term"));
    assert.ok(!toks.some((t) => t.token === "the" || t.token === "and"));
  });
  it("does not digit-substring-match bare numbers", () => {
    assert.equal(tokenOccurs("16", "16000 parameters and 2016 results"), false);
    assert.equal(tokenOccurs("16", "with 16 layers of context"), true);
  });
});

describe("matchWrite", () => {
  const unit = "On GPT-3 175B, LoRA reduces the VRAM consumption during training from 1.2TB to 350GB.";
  it("matches a write containing the unit text with different latex wrapping", () => {
    const write = "Some preamble. On GPT-3 175B, LoRA reduces the VRAM consumption during training from 1.2TB to 350GB.\\cite{hu2021lora} More text.";
    assert.equal(matchWrite(unit, "sentence", write).matched, true);
  });
  it("rejects an unrelated write", () => {
    assert.equal(matchWrite(unit, "sentence", "QLoRA finetunes models with NF4 quantization and paged optimizers.").matched, false);
  });
  it("matches table rows on row cells, not on single shared words", () => {
    const row = "LoRA | 16-bit Float | A, B matrices | Low-rank matrices | Yes | Zero runtime overhead";
    const good = "\\textbf{LoRA} & 16-bit Float & A, B matrices & Low-rank matrices & Yes & Zero runtime overhead \\\\";
    const bad = "LoRA is a popular method with low-rank matrices and many users.";
    assert.equal(matchWrite(row, "row", good).matched, true);
    assert.equal(matchWrite(row, "row", bad).matched, false);
  });
});

describe("nearVariant", () => {
  it("detects reworded verify claims", () => {
    assert.equal(
      nearVariant(
        "LoRA reduces VRAM consumption during training from 1.2TB to 350GB.",
        "On GPT-3 175B, LoRA reduces the VRAM consumption during training from 1.2TB to 350GB.",
      ),
      true,
    );
  });
  it("matches a table row against its verify-claim sentence variant", () => {
    assert.equal(
      nearVariant(
        "LoRA | GPT-3 175B | Multi-task NLU | V100 cluster | Cuts VRAM from 1.2TB to 350GB (3x drop); 10,000x param drop.",
        "On GPT-3 175B, LoRA reduces the VRAM consumption during training from 1.2TB to 350GB.",
      ),
      true,
    );
  });
  it("rejects unrelated claims", () => {
    assert.equal(nearVariant("BitFit trains only bias terms.", "QLoRA uses NF4 quantization on a 48GB GPU."), false);
  });
});

describe("classifyCause", () => {
  const base = {
    cited: true,
    isRow: false,
    columnDemanded: false,
    demandStrong: false,
    slotUnsupplied: false,
    revisionPhase: false,
    retrievalSinceRevision: false,
    priorPaperResults: 2,
    hitCount: 3,
    totalTokens: 5,
    missingNumberOrHardware: false,
  };
  it("labels uncited specific units UNCITED-KNOWLEDGE", () => {
    assert.equal(classifyCause({ ...base, cited: false }).primary, "UNCITED-KNOWLEDGE");
  });
  it("prefers SLOT-FILL for demanded table cells no result supplied", () => {
    const r = classifyCause({ ...base, isRow: true, columnDemanded: true, demandStrong: true, slotUnsupplied: true, priorPaperResults: 1, hitCount: 2, totalTokens: 4 });
    assert.equal(r.primary, "SLOT-FILL");
  });
  it("prefers REVISION-FILL over MEMORY for revision writes with no new retrieval", () => {
    const r = classifyCause({ ...base, revisionPhase: true, retrievalSinceRevision: false, priorPaperResults: 0, hitCount: 0, totalTokens: 4 });
    assert.equal(r.primary, "REVISION-FILL");
    assert.equal(r.secondary, "MEMORY");
  });
  it("labels no-prior-evidence writes MEMORY", () => {
    assert.equal(classifyCause({ ...base, priorPaperResults: 0, hitCount: 0, totalTokens: 4 }).primary, "MEMORY");
  });
  it("labels changed numbers/settings with partial hits MISREPORT", () => {
    const r = classifyCause({ ...base, hitCount: 3, totalTokens: 5, missingNumberOrHardware: true });
    assert.equal(r.primary, "MISREPORT");
  });
  it("labels fully-evidenced but transferred claims OVERREAD", () => {
    assert.equal(classifyCause({ ...base, hitCount: 5, totalTokens: 5 }).primary, "OVERREAD");
  });
  it("marks partial-evidence OVERREAD as borderline", () => {
    const r = classifyCause({ ...base, hitCount: 3, totalTokens: 5, missingNumberOrHardware: false });
    assert.equal(r.primary, "OVERREAD");
    assert.equal(r.borderline, true);
  });
});
