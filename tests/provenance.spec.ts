/**
 * Provenance audit: the document-level view the product lacked. Fixtures are the real failure cases of the workflow experiment
 * (iterations 2, 4, 6, 7 of adapter-literature-workflow-v1): a hardware name no paper states, a percentage that exists only in
 * another paper, a table row that cites nothing, table values whose unit lives in the column header, and a clause of a sentence
 * that verify supported word for word.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { linesFromString, parsePaper } from "../src/core/review/latex.ts";
import { countBodyWords, extractUnits } from "../src/core/provenance/units.ts";
import { figuresOf, matchFigure, normalizePaperText } from "../src/core/provenance/figures.ts";
import { auditProvenance, claimVariants, type Ledger, type PaperInput } from "../src/core/provenance/audit.ts";

const TEX = String.raw`\documentclass{article}
\begin{document}
\section{Methods}
LoRA freezes the pre-trained model weights and injects trainable rank decomposition matrices~\cite{hu2021lora}. In benchmarked evaluations: Compared to GPT-3 175B fine-tuned with Adam, LoRA can reduce the number of trainable parameters by 10,000 times~\cite{hu2021lora}. We expect gains of 12.5\% on our setup. Prior work (e.g. Smith et al. 2020) is similar.
\begin{table}
\caption{Reported results from the literature.}
\begin{tabular}{lll}
\toprule
Method & Setting & Result \\
\midrule
DoRA \cite{liu2024dora} & A100 (80GB) & cuts VRAM by 24.4\% (37.3GB $\to$ 28.2GB) \\
BitFit \cite{zaken2022bitfit} & BERT & matches $\sim$95\%+ of full fine-tuning \\
Full FT & GPUs & OOM on single 24\,GB/48\,GB GPUs \\
\bottomrule
\end{tabular}
\end{table}
\bibliography{refs}
\end{document}
`;

const paperOf = (tex: string) => parsePaper(linesFromString(tex));

const PAPERS: PaperInput[] = [
  { citekey: "hu2021lora", doi: "10.48550/arxiv.2106.09685", title: "LoRA", text: "LoRA can reduce the number of trainable parameters by 10,000 times and the GPU memory requirement by 3 times. GPT-3 175B was fine-tuned with Adam." },
  { citekey: "liu2024dora", doi: "10.48550/arxiv.2402.09353", title: "DoRA", text: "a training memory reduction of approximately 24.4% in fine-tuning LLaMA. GPU Memory Cost (GB) DoRA w/o modification 37.3 DoRA 28.2 (-24.4%) with batch size 80 and 16 accumulation steps." },
  { citekey: "zaken2022bitfit", doi: "10.18653/v1/2022.acl-short.1", title: "BitFit", text: "BitFit modifies less than 0.1% of the parameters and retains competitive scores on GLUE with BERT." },
];

const noLedger: Ledger = () => null;

describe("extractUnits", () => {
  const units = extractUnits(paperOf(TEX));
  it("splits prose into statements, keeps table rows and captions, and stops at the bibliography", () => {
    const kinds = units.map((u) => u.kind);
    assert.deepEqual(kinds.filter((k) => k === "sentence").length, 4, "four prose sentences (the abbreviations e.g. and et al. do not split)");
    assert.deepEqual(kinds.filter((k) => k === "caption").length, 1);
    assert.deepEqual(kinds.filter((k) => k === "row").length >= 3, true, "the three data rows");
    assert.ok(!units.some((u) => /refs/.test(u.raw)), "the bibliography command is outside the body");
  });
  it("records the citation keys, plain text (no cite command, tie or escape) and the source line", () => {
    const s1 = units[0]!;
    assert.deepEqual(s1.cites, ["hu2021lora"]);
    assert.equal(s1.plain, "LoRA freezes the pre-trained model weights and injects trainable rank decomposition matrices.");
    assert.equal(s1.line, 4);
    assert.equal(s1.section, "Methods");
    const dora = units.find((u) => u.kind === "row" && u.raw.includes("A100"))!;
    assert.deepEqual(dora.cites, ["liu2024dora"]);
    assert.match(dora.plain, /A100 \(80GB\)/);
    assert.match(dora.plain, /24\.4%/);
    assert.ok(dora.line >= 11, "row line is where the row starts");
  });
});

describe("figuresOf", () => {
  it("finds numbers with units, decimals and hardware names; ignores bare small integers, years and section references", () => {
    const f = (s: string) => figuresOf(s).map((x) => x.token);
    assert.deepEqual(f("cuts VRAM by 24.4% (37.3GB → 28.2GB) on an A100"), ["24.4%", "37.3GB", "28.2GB", "A100"]);
    assert.deepEqual(f("GPT-3 175B with 10,000 times fewer parameters"), ["175B", "10000 times"]);
    assert.deepEqual(f("single 24 GB/48 GB GPUs"), ["24 GB", "48 GB"]);
    assert.deepEqual(f("We use 16 steps in 2024, see Section 4.1 and Table 2"), []);
    assert.deepEqual(f("RTX 4090 and TITAN Xp"), ["RTX 4090", "TITAN Xp"]);
    assert.deepEqual(f("3× faster"), [], "a single-digit multiplier is too generic to audit");
  });
  it("matches by number first and unit second: a decimal found without its unit is a table value, a round integer is not", () => {
    const dora = normalizePaperText(PAPERS[1]!.text!);
    const one = (s: string) => matchFigure(figuresOf(s)[0]!, dora);
    assert.equal(one("24.4%"), "exact");
    assert.equal(one("37.3GB"), "number-only");
    assert.equal(one("80GB"), "number-only", "80 exists (a batch size) but never as 80 GB");
    assert.equal(one("A100"), "absent");
    assert.equal(one("95%"), "absent");
  });
  it("normalises thousands separators in the paper text", () => {
    const hu = normalizePaperText(PAPERS[0]!.text!);
    assert.equal(matchFigure(figuresOf("10,000×")[0]!, hu), "exact");
  });
});

describe("auditProvenance", () => {
  const paper = paperOf(TEX);
  const audit = auditProvenance({ paper, tex: TEX, papers: PAPERS, ledger: noLedger });
  const figs = (pred: (u: string) => boolean) => audit.units.filter((u) => pred(u.unit.raw)).flatMap((u) => u.figures);
  const status = (list: ReturnType<typeof figs>, token: string) => list.find((f) => f.token === token)?.status;

  it("flags a hardware name the cited paper never states, and a number found only in another paper (BitFit 95%)", () => {
    const dora = figs((r) => r.includes("A100"));
    assert.equal(status(dora, "A100"), "open");
    assert.equal(status(dora, "24.4%"), "ok");
    assert.equal(status(dora, "37.3GB"), "ok", "a decimal found without its unit is accepted: the unit is in the column header");
    assert.equal(status(dora, "80GB"), "check", "a round integer without its unit is only a weak match");
    const bitfit = figs((r) => r.includes("BitFit"));
    assert.equal(status(bitfit, "95%"), "open");
  });
  it("flags every figure of a table row that cites no paper, and lists uncited prose figures as information", () => {
    const row = figs((r) => r.includes("Full FT"));
    assert.deepEqual(row.map((f) => f.status), ["unsourced", "unsourced"]);
    const prose = figs((r) => r.includes("12.5"));
    assert.deepEqual(prose.map((f) => f.status), ["uncited"]);
  });
  it("summarises: counts, open items with their line and a reason, and the word count", () => {
    const s = audit.summary;
    assert.equal(s.figures.open, 4, "A100, 95%, 24 GB, 48 GB");
    assert.equal(s.figures.check, 1, "80GB");
    assert.equal(s.figures.info, 1, "12.5%");
    assert.ok(s.words > 40);
    const open = audit.items.filter((i) => i.severity === "open");
    assert.equal(open.length, 4);
    assert.ok(open.every((i) => i.line > 0 && i.why.length > 0 && i.excerpt.length > 0));
    assert.deepEqual(audit.items.map((i) => i.severity), [...audit.items.map((i) => i.severity)].sort((a, b) => ["open", "check", "info"].indexOf(a) - ["open", "check", "info"].indexOf(b)), "most severe first");
  });
  it("reports a citation key that is not registered, and an unavailable paper text as unchecked, not as a failure", () => {
    const missing = auditProvenance({ paper, tex: TEX, papers: PAPERS.filter((p) => p.citekey !== "zaken2022bitfit"), ledger: noLedger });
    assert.deepEqual(missing.summary.unregistered, ["zaken2022bitfit"]);
    const noText = auditProvenance({ paper, tex: TEX, papers: PAPERS.map((p) => (p.citekey === "liu2024dora" ? { ...p, text: null } : p)), ledger: noLedger });
    const dora = noText.units.find((u) => u.unit.raw.includes("A100"))!;
    assert.ok(dora.figures.every((f) => f.status === "unavailable"));
  });
});

describe("the verify ledger", () => {
  it("claim variants cover the sentence, its clauses and a trailing period", () => {
    const v = claimVariants("In benchmarked evaluations: Compared to GPT-3 175B, LoRA can reduce the number of trainable parameters by 10,000 times.");
    assert.ok(v.includes("Compared to GPT-3 175B, LoRA can reduce the number of trainable parameters by 10,000 times."));
    assert.ok(v.includes("Compared to GPT-3 175B, LoRA can reduce the number of trainable parameters by 10,000 times"));
    assert.ok(v.includes("In benchmarked evaluations: Compared to GPT-3 175B, LoRA can reduce the number of trainable parameters by 10,000 times."));
    assert.ok(v.length <= 24);
  });
  it("a statement is verified only when the ledger holds support for one of its variants from a paper it cites", () => {
    const paper = paperOf(TEX);
    const hit = { pointers: ["10.48550/arxiv.2106.09685@abc#10-90"], dois: ["10.48550/arxiv.2106.09685"] };
    const ledger: Ledger = (variants) => (variants.includes("Compared to GPT-3 175B fine-tuned with Adam, LoRA can reduce the number of trainable parameters by 10,000 times.") ? hit : null);
    const a = auditProvenance({ paper, tex: TEX, papers: PAPERS, ledger });
    const s2 = a.units.find((u) => u.unit.raw.includes("In benchmarked evaluations"))!;
    assert.equal(s2.status, "verified");
    assert.deepEqual(s2.ledger?.pointers, hit.pointers);
    assert.equal(a.units.find((u) => u.unit.raw.includes("freezes"))!.status, "cited", "cited, wording never verified");
    const wrongPaper: Ledger = () => ({ pointers: ["x@r#1-2"], dois: ["10.18653/v1/2022.acl-short.1"] });
    const b = auditProvenance({ paper, tex: TEX, papers: PAPERS, ledger: wrongPaper });
    assert.equal(b.units.find((u) => u.unit.raw.includes("freezes"))!.status, "cited", "support from a paper the statement does not cite does not verify it");
  });
});

describe("countBodyWords", () => {
  it("is the only word counter: tables and captions in, math and citations out", () => {
    assert.equal(countBodyWords(TEX), 83);
    assert.ok(countBodyWords(TEX) > 40);
  });
});
