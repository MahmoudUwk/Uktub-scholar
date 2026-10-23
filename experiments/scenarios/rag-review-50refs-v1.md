# Retrieval-augmented generation review, built from scratch (up to 50 references)

Scenario version: 1 (owner request 2026-10-18: one full session that generates a complete document from scratch with up to
50 references). A stress smoke of the whole workflow, not part of the measured acceptance batch. The scripted user sends
only the exact texts in `## Request`, `## Revision` and `## Nudge`.

## Prompt

Write a literature review in LaTeX, with a compiled PDF, on retrieval-augmented generation (RAG) for large language models: how retrieval is integrated with generation, how retrievers are trained, how RAG systems are evaluated, and the main open problems. About 2,500–3,500 words, organized by ideas in at least five sections plus an introduction and a conclusion, not as a list of paper summaries.

Build the bibliography from scratch: find, register and cite between 30 and 50 relevant papers (never more than 50). Start from RAG (arxiv:2005.11401), REALM (arxiv:2002.08909), Dense Passage Retrieval (arxiv:2004.04906), RETRO (arxiv:2112.04426) and Self-RAG (arxiv:2310.11511). Include one comparison table of representative systems. Distinguish reported measurements from design descriptions, and do not carry a reported result over to another model, task or dataset without evidence. Every statement that relies on a paper must cite it; if a source could not be acquired or checked, say so.

Deliver the source and PDF and tell me the remaining limits.

## Success

- A coherent review (introduction, at least five idea-organized sections, conclusion) and one comparison table exist, citing 30–50 registered citable papers including the five named ones, or explicitly explaining any missing coverage.
- Reported measurements and design descriptions have distinct roles; no unsupported numerical claim or cross-setting generalization is presented as established.
- After the first complete draft, request one revision: a short subsection on how RAG systems fail, grounded in the registered papers, and a comparison table that marks reported measurements versus design descriptions. Do not report success before that revision is delivered with a current PDF.
- Final artifacts reflect that revision and compilation succeeds after the last relevant edit.

## Entry

manuscript/main.tex

## Request

```text
Write a literature review in LaTeX, with a compiled PDF, on retrieval-augmented generation (RAG) for large language models: how retrieval is integrated with generation, how retrievers are trained, how RAG systems are evaluated, and the main open problems. About 2,500–3,500 words, organized by ideas in at least five sections plus an introduction and a conclusion, not as a list of paper summaries.

Build the bibliography from scratch: find, register and cite between 30 and 50 relevant papers (never more than 50). Start from RAG (arxiv:2005.11401), REALM (arxiv:2002.08909), Dense Passage Retrieval (arxiv:2004.04906), RETRO (arxiv:2112.04426) and Self-RAG (arxiv:2310.11511). Include one comparison table of representative systems. Distinguish reported measurements from design descriptions, and do not carry a reported result over to another model, task or dataset without evidence. Every statement that relies on a paper must cite it; if a source could not be acquired or checked, say so.

Deliver the source and PDF and tell me the remaining limits.
```

## Revision

```text
Please revise the review: add a short subsection on how RAG systems fail (for example irrelevant or conflicting retrieved passages), grounded in the papers you registered, and make the comparison table say which entries are reported measurements and which are design descriptions. Recompile so the PDF is current after the revision, and tell me the remaining limits.
```

## Nudge

```text
Please continue until the review is complete and compiled. I have no further input.
```
