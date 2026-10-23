/**
 * Every citation in the document counts for the registry check, not only citations the segmenter attached to a statement:
 * `Sentence. \cite{k}` (a cite after the full stop) belongs to no unit, yet a fabricated key there must still be reported
 * unregistered (the pre-completion gate and Tier 1 read this list). Found 2026-10-21: such a key was silently dropped.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { linesFromString, parsePaper } from "../src/core/review/latex.ts";
import { auditProvenance } from "../src/core/provenance/audit.ts";
import { provenanceCitedKeys, type TierProvenanceDoc } from "../scripts/live/deliverable-checks.ts";

const auditOf = (body: string, registered: string[] = []) => {
  const tex = String.raw`\documentclass{article}
\begin{document}
${body}
\bibliography{refs}
\end{document}
`;
  const papers = registered.map((citekey) => ({ citekey, doi: `10.1000/${citekey}`, text: null }));
  return auditProvenance({ paper: parsePaper(linesFromString(tex)), tex, papers: papers as never, ledger: () => null });
};

describe("document-wide citation keys", () => {
  it("a cite after the full stop is reported unregistered and listed among the document's cite keys", () => {
    const a = auditOf(String.raw`Retrieval improves factuality in large language models. \cite{fake2026b}`);
    assert.deepEqual(a.summary.unregistered, ["fake2026b"]);
    assert.deepEqual(a.summary.citeKeys, ["fake2026b"]);
  });

  it("lists every cite command's keys once, sorted, including multi-key and starred forms, and never the nocite wildcard", () => {
    const a = auditOf(String.raw`One claim.~\citep[p.~2]{b2024, a2023}

Another claim \citet*{c2022}. \nocite{*}`, ["a2023"]);
    assert.deepEqual(a.summary.citeKeys, ["a2023", "b2024", "c2022"]);
    assert.deepEqual(a.summary.unregistered, ["b2024", "c2022"]);
  });

  it("a commented-out cite is not a citation", () => {
    const a = auditOf(String.raw`A claim.~\cite{real2024} % \cite{ghost2020}`, ["real2024"]);
    assert.deepEqual(a.summary.citeKeys, ["real2024"]);
    assert.deepEqual(a.summary.unregistered, []);
  });

  it("Tier 1 reads the document-wide keys when the audit provides them", () => {
    const doc = { entry: "main.tex", summary: { citeKeys: ["fake2026b", "x2024"] }, items: [], document_digest: "", units: [{ cites: ["x2024"] }] } as unknown as TierProvenanceDoc;
    assert.deepEqual(provenanceCitedKeys(doc), ["fake2026b", "x2024"]);
  });
});
