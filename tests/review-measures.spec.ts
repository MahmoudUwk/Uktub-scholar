/**
 * The four deterministic slop measures of the manuscript review, on small LaTeX documents with known answers. Definitions: Oh et al.,
 * "Science or Slop?" (arXiv 2610.00531), Appendix A, reimplemented from the paper (the authors' code carries no licence). Every flagged
 * unit carries the file and line it sits on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { linesFromString, parsePaper } from "../src/core/review/latex.ts";
import { measureCitationIsolation, measureCrossSectionRefs, measureEvidenceGap, measureMacroRedundancy } from "../src/core/review/measures.ts";

const paper = (tex: string) => parsePaper(linesFromString(tex));

const XSEC = String.raw`\documentclass{article}
\begin{document}
\begin{abstract} We study things. \end{abstract}
\section{Introduction}\label{sec:intro}
We present results in Section 3 and Table~\ref{tab:main}. See also Section~\ref{sec:method}.
\section{Method}\label{sec:method}
\begin{figure}\caption{Pipeline}\label{fig:pipe}\end{figure}
As Figure~\ref{fig:pipe} shows, the pipeline has two stages.
\begin{equation}\label{eq:loss} L = 1 \end{equation}
\section{Results}\label{sec:res}
\begin{table}\caption{Main}\label{tab:main}\begin{tabular}{lcc}A&1&2\\B&3&4\\\end{tabular}\end{table}
Equation~\eqref{eq:loss} defines the loss.
\section{Conclusion}
Done.
\end{document}
`;

describe("cross-section references", () => {
  it("flags sections and labelled objects no other section points to, by command or printed number", () => {
    const m = measureCrossSectionRefs(paper(XSEC));
    assert.equal(m.total, 7, "4 numbered sections + figure + equation + table");
    assert.equal(m.flagged, 3);
    assert.equal(m.rate, 3 / 7);
    assert.deepEqual(m.units.map((u) => u.excerpt).sort(), ["Conclusion", "Introduction", "fig:pipe"]);
    const fig = m.units.find((u) => u.excerpt === "fig:pipe");
    assert.deepEqual(fig?.where, { file: "main.tex", line: 7 });
    assert.equal(fig?.section, "Method");
  });

  it("does not count pointers inside the object's own section", () => {
    const m = measureCrossSectionRefs(paper(String.raw`\section{A}
\begin{figure}\label{f}\end{figure}
See Figure~\ref{f}.
\section{B}
Text.`));
    assert.ok(m.units.some((u) => u.excerpt === "f"), "a figure only its own section mentions is flagged");
  });

  it("ignores everything after the appendix, acknowledgements or bibliography", () => {
    const m = measureCrossSectionRefs(paper(String.raw`\section{A}
\begin{figure}\label{f}\end{figure}
\section{B}
Look at Figure~\ref{f}.
\appendix
\section{Extra}
\begin{figure}\label{g}\end{figure}`));
    assert.equal(m.total, 3, "two sections and one figure in the body; the appendix figure is not an object");
    assert.equal(m.units.some((u) => u.excerpt === "g"), false);
  });
});

describe("macro redundancy", () => {
  const SENT = "Large language models have transformed how researchers write and review scientific papers in many fields today.";
  it("flags a sentence whose tokens mostly sit in 8-grams an earlier section already used", () => {
    const m = measureMacroRedundancy(paper(`\\section{Introduction}\n${SENT} Short one.\n\\section{Method}\nWe describe the approach in detail here and then we apply it to the benchmark datasets in our study.\n\\section{Conclusion}\n${SENT}\nWe conclude that the approach works.\n`));
    assert.equal(m.total, 3, "only sentences of at least 8 tokens count");
    assert.equal(m.flagged, 1);
    assert.equal(m.units[0]?.section, "Conclusion");
  });

  it("does not count repetition within one section, nor a sentence where fewer than half its tokens are reused", () => {
    const tail = "and then everything else in this sentence is entirely new material that appears nowhere before at all";
    const m = measureMacroRedundancy(paper(`\\section{Introduction}\n${SENT}\n${SENT}\n\\section{Method}\n${SENT.split(" ").slice(0, 8).join(" ")} ${tail}.\n`));
    assert.equal(m.flagged, 0);
  });

  it("flags a 12-token sentence that shares an 8-gram (8 of 12 tokens)", () => {
    const eight = SENT.split(" ").slice(0, 8).join(" ");
    const m = measureMacroRedundancy(paper(`\\section{Introduction}\n${SENT}\n\\section{Method}\n${eight} plus four more words.\n`));
    assert.equal(m.flagged, 1);
  });
});

describe("citation isolation", () => {
  const DOC = String.raw`\section{Introduction}
Transformers were introduced by \citet{vaswani} for translation.
Earlier recurrent models \cite{a} were later replaced by attention \cite{b}.
Unlike \cite{c}, we train on raw spectrograms.
Methods such as \cite{d,e} rely on handcrafted features.
Smith et al. extended \cite{f} to larger corpora.
There is no citation in this sentence.
\section{Method}
We follow \cite{g}.
`;
  it("counts a citing sentence of the introduction or related work as isolated unless it weaves two works together", () => {
    const m = measureCitationIsolation(paper(DOC));
    assert.equal(m.total, 5);
    assert.equal(m.flagged, 2);
    assert.deepEqual(m.units.map((u) => u.where.line), [2, 4]);
  });
  it("marks the score weak under eight citing sentences", () => {
    assert.match(measureCitationIsolation(paper(DOC)).weak ?? "", /fewer than 8/);
  });
});

describe("evidence gap", () => {
  const TABLE = String.raw`\section{Results}
\begin{table}\caption{Accuracy}\begin{tabular}{lcc}Method & A & B\\ Ours & 0.91 & 0.88\\ Base & 0.85 & 0.80\\\end{tabular}\end{table}
`;
  it("flags a paper with a result table and no exhibit anywhere", () => {
    const m = measureEvidenceGap(paper(TABLE));
    assert.equal(m.rate, 1);
    assert.equal(m.flagged, 1);
    assert.equal(m.units[0]?.where.line, 2);
  });
  it("is closed by one exhibit anywhere, an appendix listing included", () => {
    const m = measureEvidenceGap(paper(`${TABLE}\\appendix\n\\section{Samples}\n\\begin{lstlisting}\nINPUT: a b c\nOUTPUT: d\n\\end{lstlisting}\n`));
    assert.equal(m.rate, 0);
  });
  it("is closed by a caption announcing an example or a failure case", () => {
    assert.equal(measureEvidenceGap(paper(`${TABLE}\\begin{figure}\\caption{Failure case on noisy input}\\end{figure}\n`)).rate, 0);
  });
  it("does not apply without a result table", () => {
    const m = measureEvidenceGap(paper("\\section{Intro}\nNo tables here.\n"));
    assert.equal(m.rate, null);
  });
});
