---
name: uktub-grants
description: "Draft the Specific Aims page of a research grant proposal from the user's own paper and data: the gap, a few aims with a hypothesis, approach and expected outcome each, preliminary results taken from the paper, and the impact, in about one page and without any invented fact. Use when the user asks for a grant proposal, specific aims, a funding application outline or a follow-up project plan based on their work. Do not use for the full budget or administrative forms, for peer-reviewing a proposal, or to write the paper itself."
compatibility: "No tools needed beyond reading the project's files."
---

# Specific Aims from your own work

A Specific Aims page is a reviewer's first and often only read. It says what is wrong or missing, what you will do about it, why you can,
and why it matters, in one page. Everything it asserts about your past work must be traceable to your paper.

## Rules

1. **Preliminary results come only from the paper.** Quote the numbers as the paper states them and name where (section or table). Printed
   numbers (`Table 9`, `Section 6.2`) are not visible in the `.tex`: read them from the compiled paper (compile it, then `pdftotext`) or
   give the `file.tex:line` instead. A live run cited table numbers it had guessed from the order of the files, and the tables it named held other data. Never add
   a result, a number, a participant count or a dataset that is not in the manuscript. Anything the user must supply is a visible
   placeholder in square brackets (`[funder]`, `[budget]`, `[collaborator]`), never a guess.
2. **Aims follow from stated limitations.** Read the paper's limitations, threats to validity and future-work sentences; each aim should answer
   one of them, and say which one.
3. **Two to four aims, each testable.** Every aim has an objective sentence, a hypothesis or research question, the approach in two or three
   lines, what would count as success, and the risk with a fallback. State a target in terms of the paper's own numbers ("halve the 2.9-point gap to the optimum");
   a derived absolute number needs its arithmetic shown, and checking it is part of the draft (a live run rounded a derived target wrongly).
   Name the quantity the arithmetic is about: "cost within 5% of 12.5" is not "95% of the savings", which needs a baseline the paper states.
4. **No invented citations.** Cite only works in the paper's bibliography, by their key. Say so when a claim needs a reference the project does
   not have.
5. **No promises the data do not support**: no "will revolutionise", no funding amounts, no timelines the user did not give.
6. **Ask the funder.** Programmes differ (NIH, NSF, NSERC, Horizon, foundations): if no call text is given, write the funder-neutral page and say
   which programme-specific items are still open (page limit, required sections, review criteria).

## Process

1. Read the paper (follow its `\input` files), its bibliography file and any call text or notes the user pointed to.
2. List, for yourself and in your answer, the limitations and future-work statements you found, each with its pointer (`file.tex:line`).
3. Draft the page, about 450 to 650 words, as `grants/specific-aims.md`:
   - **Opening paragraph**: the problem and why it matters; what is known (from the paper's own introduction and cited work); the gap; the long-term
     goal and the objective of this project.
   - **Aims**: `Aim 1 ... Aim N`, each as above.
   - **Preliminary results**: two or three sentences with the paper's numbers and pointers.
   - **Impact and expected outcomes**: what exists afterwards that does not exist now, and for whom.
4. Check it: every number appears in the paper; every citation key exists in the bibliography; no placeholder is silently filled; the length fits.
5. Answer with: the file, the limitations you built the aims from, every placeholder, and what you need from the user (funder and call text,
   duration, team, data they have not shared).
