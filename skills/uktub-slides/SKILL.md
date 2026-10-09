---
name: uktub-slides
description: "Turn the user's paper into a conference talk, seminar or defence deck: Beamer slides compiled with the project's own LaTeX engine, or an editable PowerPoint .pptx built with pandoc when the user asks for PowerPoint. A sentence-length title that states the takeaway on every slide, one exhibit per results slide, the paper's own figures and numbers, citations from the paper's bibliography. Use when the user asks for slides, a talk, a presentation, a PowerPoint or a defence deck from their paper or research. Do not use for posters, for editing an existing .pptx, or for new figures for a paper."
compatibility: "Beamer: a LaTeX engine (the compile tool) with Beamer and the Metropolis theme. PowerPoint: pandoc (a separate program the user installs). A PDF-to-PNG converter such as pdftoppm for figures and the visual check."
---

# Slides from a paper

A talk is not the paper read aloud. Each slide makes one point the audience can take in within about a minute, and the point is the slide's
title. The slides say only what the paper says.

## Rules

1. **Everything comes from the paper.** Every number, claim, figure and table on a slide is in the manuscript. Do not add a result, a
   comparison or a citation the paper does not have. If a slide the user wants needs something the paper lacks, say so.
2. **Action titles.** Every content slide is titled with the takeaway as a sentence ("The new method cuts the error by 1 %"), not a topic
   ("Results"). Two lines at most.
3. **One idea, one exhibit.** A results slide shows one figure or one table and at most a few short lines. No wall of text; at most about six
   lines on any slide.
4. **Length by the clock.** About one slide a minute: ten minutes is eight to ten content slides. Typical shape: the problem and the gap,
   the idea in one sentence, how it works (one or two slides), the setup, the results (three or four), what it does not do, the take-away.
5. **Reuse the paper's own figures** by their files; do not redraw. A figure in a format the engine cannot include (EPS) is used through its PDF
   or PNG version. Put a small source line under every borrowed figure or table ("Fig. 4 of the paper").
6. **Cite from the paper's bibliography file** with `\cite`, and end with a references slide holding only the works cited on slides.
7. No claims of novelty, speed or significance beyond what the paper's numbers support, and no invented speaker anecdotes.

## Process

1. Read the manuscript (follow its `\input` files), the figure files and the bibliography file. Note the title, the contribution sentence, the
   key numbers and which figures carry them.
2. Say the outline first, in your answer: one line per slide, the title being the takeaway, and the exhibit it uses.
3. Write `manuscript/slides/talk.tex` (skeleton below). Paths to the paper's figures and `.bib` are relative to that file (`../fig.png`).
4. Compile it with the compile tool (entry `manuscript/slides/talk.tex`). Fix every error. Treat `Overfull \vbox` as a slide with too much on it.
5. **Look at it.** Render a few slides and read the images: `pdftoppm -png -r 60 -f 1 -l 12 build/talk.pdf build/talk`, then read at
   least the title slide, a figure slide and a results slide. Check legibility, nothing cut off, the figure matches its title.
6. Tell the user: where the PDF and source are, the slide titles in order, anything you left out because the paper has no support for it,
   and what you would add if they give you more (a backup slide, a demo).

## PowerPoint (.pptx)

Beamer is the default. When the user asks for PowerPoint or a `.pptx` (co-authors or a conference that works in it), keep rules 1 to 7 and build it with pandoc
instead; say that the result is plainer than the Beamer deck and that equations and citations become Word-style objects and text.

1. `pandoc --version`; if it is missing, tell the user to install it and stop. Ask whether they have a template; if so use it as `--reference-doc`.
2. Write `manuscript/slides/talk.md` (pandoc markdown): a title block (`title`, `author`), then one `## <takeaway sentence>` per slide, bullets or one
   figure `![caption](../fig.png){width=80%}` or one pipe table, `$...$` equations, and the talking points of each slide in `::: notes` ... `:::`.
   Figures must be PNG or JPG (a PDF figure: `pdftoppm -png -r 200 -singlefile in.pdf out`; EPS: use its PDF version first). End with `## References`
   and an empty `::: {#refs}` ... `:::` block.
3. From the project root: `pandoc manuscript/slides/talk.md -o manuscript/slides/talk.pptx --slide-level=2 --citeproc --bibliography=<the .bib>
   --resource-path=manuscript/slides [--reference-doc=<template.pptx>]`. Each warning is a defect (missing figure, unresolved citation).
4. **Read it back, do not trust the command:** `python3 <skill directory>/scripts/pptx_outline.py manuscript/slides/talk.pptx` lists every slide with its
   title, text, pictures, tables, equations and notes. Compare with your outline: every slide titled with a sentence, one exhibit each, every figure present,
   the numbers equal to the paper's, no text left as raw `\cite` or `[?]`. If `soffice` exists, render it (`soffice --headless --convert-to pdf`) and look at
   a few pages with `pdftoppm`; otherwise say the visual check was not done.
5. Tell the user the file, the slide titles, what was checked, and what the format cannot do (no animations, default look, figures at fixed sizes).

## Skeleton (Beamer)

```latex
\documentclass[aspectratio=169]{beamer}
\usetheme{metropolis}
\title{Paper title}
\author{Author}
\date{}
\begin{document}
\maketitle
\begin{frame}{The takeaway of this slide as a sentence}
  \centering
  \includegraphics[height=0.62\textheight]{../figure.png}\\[1mm]
  {\footnotesize Source: Fig. 1 of the paper}
\end{frame}
\begin{frame}[allowframebreaks]{References}
  \footnotesize
  \bibliographystyle{plain}
  \bibliography{../refs}
\end{frame}
\end{document}
```

(The skeleton's `\includegraphics` and `\bibliography` need real files; replace them with the paper's.)
