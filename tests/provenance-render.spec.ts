import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { linesFromString, parsePaper } from "../src/core/review/latex.ts";
import { auditProvenance, type PaperInput } from "../src/core/provenance/audit.ts";
import { renderFull, renderSummary } from "../src/core/provenance/render.ts";

const TEX = String.raw`\begin{document}
\section{Results}
LoRA cuts trainable parameters by 10,000 times~\cite{hu}. We expect 12.5\% on our setup.
\begin{tabular}{ll}
DoRA \cite{liu} & A100 (80GB), saves 24.4\% \\
BitFit \cite{zak} & matches 95\% of full tuning \\
Full FT & OOM on single 24\,GB/48\,GB GPUs \\
\end{tabular}
\bibliography{r}
\end{document}
`;
const PAPERS: PaperInput[] = [
  { citekey: "hu", doi: "10.1/hu", title: "LoRA", text: "10,000 times fewer" },
  { citekey: "liu", doi: "10.1/liu", title: "DoRA", text: "24.4% less memory, batch 80" },
  { citekey: "zak", doi: "10.1/zak", title: "BitFit", text: "bias terms only" },
];
const audit = auditProvenance({ paper: parsePaper(linesFromString(TEX)), tex: TEX, papers: PAPERS, ledger: (v) => (v.some((x) => x.startsWith("LoRA cuts")) ? { pointers: ["10.1/hu@r#1-9"], dois: ["10.1/hu"] } : null) });

describe("renderSummary", () => {
  const lines = renderSummary(audit);
  const text = lines.join("\n");
  it("states the counts, the word count and what each count means", () => {
    assert.match(text, /^provenance: \d+ statements/m);
    assert.match(text, /1 verified/);
    assert.match(text, /\d+ words/);
  });
  it("lists open and check items grouped by row, most severe first, with line, token and reason; uncited prose figures are only counted", () => {
    assert.match(text, /OPEN L\d+ \[row\] .*A100/);
    assert.match(text, /OPEN L\d+ \[row\] .*95%.*zak/);
    assert.match(text, /OPEN L\d+ \[row\] 24 GB, 48 GB.*cites no registered paper/);
    assert.match(text, /CHECK L\d+ \[row\] 80GB/);
    assert.ok(text.indexOf("OPEN") < text.indexOf("CHECK"));
    assert.ok(!/12\.5/.test(text), "an uncited prose figure is information, counted not listed");
    assert.match(text, /1 figure in statements that cite no paper/);
  });
  it("is bounded: at most the requested groups, with the remainder counted", () => {
    const small = renderSummary(audit, 1).join("\n");
    assert.equal((small.match(/^(?:OPEN|CHECK)/gm) ?? []).length, 1);
    assert.match(small, /\+\d+ more/);
  });
  it("is empty for a manuscript with nothing to audit", () => {
    const empty = auditProvenance({ paper: parsePaper(linesFromString("\\begin{document}\nNothing numeric here.\n\\end{document}")), tex: "x", papers: [], ledger: () => null });
    assert.deepEqual(renderSummary(empty), []);
  });
});

describe("renderFull", () => {
  const md = renderFull(audit);
  it("has a header that says what verified, cited and uncited mean, and lists statements with their pointers", () => {
    assert.match(md, /verified/i);
    assert.match(md, /10\.1\/hu@r#1-9/);
    assert.match(md, /not verified/i);
  });
  it("lists every open item with its reason and is bounded by the character budget", () => {
    assert.match(md, /A100/);
    const bounded = renderFull(audit, 700);
    assert.ok(bounded.length <= 760);
    assert.match(bounded, /truncated/i);
  });
});
