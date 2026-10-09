---
name: uktub-review
description: "Review the user's own LaTeX manuscript the way a careful referee would, grounded in file and line evidence: first a deterministic structural check (the scientific-slop measures: sections and figures no other section refers to, recycled sentences, citations that are listed rather than related, result tables with no example), then a read of the paper for claims the evidence does not carry. Use when the user asks for a review, critique, audit, pre-submission check or 'what would reviewers say' of a draft. Do not use to fix compile errors, to check one claim against the literature, or to rewrite the text. Read-only: never edits the manuscript and never gives an accept or reject verdict."
compatibility: "Needs node (the package's own CLI). The deterministic step uses no model and no network."
---

# Manuscript review

A review is useful when every finding can be checked: it points at a place, quotes what is there, and says why it matters. It is harmful
when it invents missing experiments, flatters, or sounds certain about novelty it did not check. Follow the rules, then the process.

## Rules

1. **Read-only.** Never edit, rename or delete the user's files. Findings go in your answer; the CLI writes its report to `reviews/`.
2. **Every finding has a pointer** (`file.tex:line`, or the section and label) and the words you are reacting to, quoted briefly. A finding
   without one is an opinion; leave it out. **Inside quotation marks, copy the manuscript's words exactly**: one clause from one place, never
   reworded, never two passages joined with "...", never a figure changed to a symbol. If you want to paraphrase, do it outside the marks.
3. **Major and minor are different.** Major: the conclusion is not supported, a method cannot be reproduced, a comparison is unfair, a
   claim contradicts a table. Minor: clarity, wording, presentation, a missing detail that does not change the conclusion.
4. **Never invent a missing experiment as a fault.** Offer it as an option for the authors ("an ablation on X would show whether Y").
5. **No verdict.** No accept, reject, score or "ready to submit". Say what is weakest and what to do about it.
6. **Do not game the numbers.** The deterministic measures are diagnostics. Never suggest deleting citations, labels or sentences to
   lower a count; suggest fixing the reasoning the count points at.
7. **Say what you did not check.** Novelty, correctness of derivations and related work you did not search for stay open questions.

## Process

1. Find the entry file (`manuscript/main.tex`, or the `.tex` with `\begin{document}`; ask if there are several).
2. **Run the deterministic review** from the project root:
   `node <skill directory>/../../bin/uktub-scholar.js review [entry.tex]` (`<skill directory>` is the folder of this file;
   `uktub-scholar review` works when the package is on the PATH). It prints a few lines and writes the full report to
   `reviews/<date>-slop.md`; it follows `\input`, so pointers name the included files.
3. **Read the report**, then open the flagged places in the manuscript. For each group decide: a real weakness, or a false positive (a
   labelled equation that needs no pointer; a citation that is fine on its own). A weak score (few units) is not evidence either way.
4. **Read the paper** for what counting cannot see: do the abstract and conclusion claim more than the tables show; are datasets, splits,
   hyperparameters, seeds and compute stated well enough to repeat; are baselines tuned like the proposed method; is variance or a
   confidence interval reported where results are close; do figures and tables stand alone; are limitations stated.
5. Optionally check one or two central claims about registered papers with `verify_claim`; report only what it returns.
6. **Write the review** (below) in your answer. Offer to save it to a file; do not save it unasked.

## Shape of the answer

- **What the paper does** (two or three sentences, in your words).
- **Deterministic diagnostics**: the four shares from the report, one line each, and what you made of them.
- **Strengths** (two or three, specific).
- **Major concerns**: numbered; each with the pointer, the quoted words, why it matters, and what would resolve it.
- **Minor concerns**: a short list, each with a pointer.
- **Questions for the authors** and **what was not checked**.

Keep it as long as the findings need and no longer.
