/**
 * D1 "label or fail" (owner decision, 2026-10-18): a non-verified prose statement may ship only if it is labelled
 * "unverified". The audit now reaches uncited prose; table rows are outside this gate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { linesFromString, parsePaper } from "../src/core/review/latex.ts";
import { auditProvenance, type Ledger } from "../src/core/provenance/audit.ts";
import { renderFull, renderSummary } from "../src/core/provenance/render.ts";

const body = (lines: string): string => String.raw`\documentclass{article}
\begin{document}
\section{Results}
${lines}
\bibliography{refs}
\end{document}
`;
const auditOf = (lines: string, ledger: Ledger = () => null) => {
  const tex = body(lines);
  return auditProvenance({ paper: parsePaper(linesFromString(tex)), tex, papers: [], ledger });
};

describe("D1: uncited prose is audited", () => {
  it("an uncited prose sentence with no figure is audited as uncited and counted as unlabelled and not verified", () => {
    const a = auditOf("Fine-tuning strictly requires a GPU.");
    const u = a.units.find((x) => /strictly requires/.test(x.unit.plain));
    assert.ok(u, "the sentence is an audited unit");
    assert.equal(u.status, "uncited");
    assert.equal(u.labelledUnverified, false);
    assert.equal(a.summary.unlabelledUnverified, 1);
    assert.equal(a.summary.labelledUnverified, 0);
  });

  it("the same sentence with the word unverified is labelled: it is not counted as unlabelled", () => {
    const a = auditOf("Fine-tuning strictly requires a GPU (unverified).");
    assert.equal(a.units.find((x) => /strictly requires/.test(x.unit.plain))!.labelledUnverified, true);
    assert.equal(a.summary.unlabelledUnverified, 0);
    assert.equal(a.summary.labelledUnverified, 1);
  });

  it("a cited sentence whose wording is not in the ledger and is not labelled is unlabelled and not verified", () => {
    const tex = body("LoRA cuts trainable parameters by 10,000 times~\\cite{hu2021lora}.");
    const a = auditProvenance({ paper: parsePaper(linesFromString(tex)), tex, papers: [{ citekey: "hu2021lora", doi: "10.1/hu", title: "LoRA", text: null }], ledger: () => null });
    assert.equal(a.units.length, 1);
    assert.equal(a.units[0]!.status, "cited");
    assert.equal(a.summary.unlabelledUnverified, 1);
  });

  it("a verified sentence is never counted, labelled or not", () => {
    const ledger: Ledger = (variants) => (variants.includes("LoRA cuts trainable parameters by 10,000 times.") ? { pointers: ["10.1/hu@r#1-9"], dois: ["10.1/hu"] } : null);
    const tex = body("LoRA cuts trainable parameters by 10,000 times~\\cite{hu2021lora}.");
    const a = auditProvenance({ paper: parsePaper(linesFromString(tex)), tex, papers: [{ citekey: "hu2021lora", doi: "10.1/hu", title: "LoRA", text: null }], ledger });
    assert.equal(a.units[0]!.status, "verified");
    assert.equal(a.summary.unlabelledUnverified, 0);
  });

  it("table rows never count toward the gate, cited or not", () => {
    const a = auditOf("\\begin{tabular}{ll}\nDoRA \\cite{liu2024dora} & A100 (80GB) \\\\\nFull FT & GPUs \\\\\n\\end{tabular}");
    assert.ok(a.units.some((u) => u.unit.kind === "row"), "the rows are audited when they cite or state a figure");
    assert.equal(a.summary.unlabelledUnverified, 0);
    assert.equal(a.summary.labelledUnverified, 0);
  });
});

describe("D1: render shows the gate", () => {
  it("the summary states the unlabelled count and lists each unlabelled unit by its line", () => {
    const a = auditOf("Fine-tuning strictly requires a GPU.\n\nIt also needs more memory.");
    const text = renderSummary(a).join("\n");
    assert.match(text, /2 unlabelled/);
    assert.match(text, /UNLABELLED L\d+ \[sentence\] — .*not verified/);
  });

  it("the full view has a section listing the unlabelled statements", () => {
    const md = renderFull(auditOf("Fine-tuning strictly requires a GPU."));
    assert.match(md, /## Unlabelled, not verified statements \(1\)/);
    assert.match(md, /- L\d+ \[sentence\] "Fine-tuning strictly requires a GPU\."/);
  });
});

describe("bibliography commands are not prose", () => {
  it("\\bibliographystyle and \\bibliography arguments never become audited statements", () => {
    // iter-02 (2026-10-18): `\bibliographystyle{plain}` was audited as the uncited sentence "plain" and failed the D1 gate.
    const tex = String.raw`\documentclass{article}
\begin{document}
\section{Results}
Retrieval is combined with generation.

\bibliographystyle{plain}
\bibliography{../refs/references}
\end{document}
`;
    const a = auditProvenance({ paper: parsePaper(linesFromString(tex)), tex, papers: [], ledger: () => null });
    assert.deepEqual(a.units.map((u) => u.unit.plain).filter((p) => /plain|references/.test(p)), []);
    assert.equal(a.summary.unlabelledUnverified, 1, "only the real sentence is counted");
  });
});
