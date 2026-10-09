---
name: uktub-figures
description: "Make publication-quality figures from the user's own data for a LaTeX manuscript, with matplotlib: scaling and learning curves, method comparisons, ablations, heatmaps, multi-panel figures. Use when the user asks for a figure, plot or chart for a paper, thesis or report, or says a figure looks unpolished, blurry or unreadable in print. Do not use for conceptual or architecture diagrams, for slides, or when there is no data to plot (ask for the file; never invent numbers)."
compatibility: "Needs python3 with matplotlib (numpy comes with it). The skill installs nothing."
---

# Figures for a paper

A figure makes one claim, and a reader who skips the prose should still get it. Default plots are sized for a screen, titled where the
caption belongs, coloured from a cycle that collapses in greyscale and rasterized where the document wants vector. This skill avoids those.

## Rules

1. **Every number comes from the user's data.** Read the data file in the plotting script. Never plot a remembered, rounded or plausible
   number, and never leave demo data in a script. No data file: ask for it, or for the paper it comes from, and stop.
2. **Build at the printed size.** `COLUMN` 3.25 in, `TEXT` 5.5 in, `WIDE` 6.75 in (a two-column spread). Include it with
   `width=\linewidth`. Never build big and rescale: 11 pt labels become 4 pt.
3. **Vector PDF goes in the paper.** The PNG is a preview for looking at the result; include it only for genuinely raster content.
4. **The caption is the title.** No axes title. Name the parts of a multi-panel figure with panel letters.
5. **Show the uncertainty, or say there is none.** Plot mean with sd or a 95 % interval across seeds and state n and what the band means
   in the caption. A single run is "single run".
6. **Axis labels carry units** ("Training-set size (examples)", not "n"). Say when an axis is logarithmic.
7. **Colour-blind and greyscale safe.** Use `PALETTE`, never jet or rainbow, and also separate series by marker or line style. Baselines,
   chance levels and guides are `GREY`.
8. **Honest axes:** bars start at zero, no dual axes, no truncated axis unless the caption says so.
9. **Say only what the numbers show.** Recompute every statement about the data (a gap, a crossover, "matches", "outperforms", "X with 500 where the other needs 5,000") from `<name>.plotdata.json` and quote the numbers. A comparison that does not hold in them is not made, in the caption or in your answer.

## Process

1. Check the prerequisite: `python3 -c "import matplotlib"`. If it fails, tell the user what to install and stop; do not install packages
   system-wide.
2. Look at the data (`head`), decide the one claim the figure makes and write it down in a sentence.
3. Copy the helper next to the figure scripts, from this skill's directory:
   `mkdir -p manuscript/figures && cp <skill directory>/scripts/figstyle.py manuscript/figures/`.
   It gives `COLUMN, TEXT, WIDE, PALETTE, GREY, use_style, figure, figure_grid, panel_labels, save`.
4. Write `manuscript/figures/<name>.py`, run from the project root, that reads the file and saves:

   ```python
   import csv, sys; from collections import defaultdict
   import numpy as np
   sys.path.insert(0, "manuscript/figures")
   from figstyle import TEXT, PALETTE, use_style, figure, save
   rows = list(csv.DictReader(open("data/results.csv")))      # the user's file, never typed-in numbers
   ...                                                          # group, then mean and sd per group
   use_style(); fig, ax = figure(width=TEXT)
   ax.errorbar(x, mean, yerr=sd, color=PALETTE["blue"], marker="o", label="ours")
   ax.set_xlabel("Training-set size (examples)"); ax.set_ylabel("Accuracy (fraction correct)"); ax.legend()
   save(fig, "manuscript/figures/<name>")
   ```

5. Run it. The output ends with `audit: clean` or lists defects (width, a title, a missing axis label, text under 5 pt, text off the
   canvas). Every listed defect is a defect to fix. `save` also writes `<name>.plotdata.json`, the numbers the picture shows.
6. **Look at the figure.** Read `manuscript/figures/<name>.png` with the file read tool: it is shown to you as an image. Check that labels
   are legible at print size, nothing overlaps, the legend hides no data, the series are distinguishable and the claim is visible. Fix
   and rerun, at most three rounds, then report what remains.
7. Tell the user: where the PDF and the script are, in one sentence what the figure shows, the seed count and what the band means,
   and a LaTeX snippet with a proposed caption (the finding first, then the method facts), after checking each claim in them against
   `<name>.plotdata.json` (rule 9). Do not edit the manuscript unless asked.

```latex
\begin{figure}[t]
  \centering
  \includegraphics[width=\linewidth]{figures/<name>.pdf}
  \caption{\textbf{Finding stated as a claim.} What is plotted; mean of 3 seeds, bars are one standard deviation.}
  \label{fig:<name>}
\end{figure}
```

`\includegraphics` paths are relative to the `.tex` file (`manuscript/main.tex`), hence `figures/<name>.pdf`.

## Choosing the plot

| The figure answers | Plot |
|---|---|
| How does a metric change with scale or training? | lines with a band, logarithmic x when the range spans decades |
| Which method wins, or which ablated part mattered? | dots or bars with intervals, one baseline in grey |
| What trades off against what? | scatter of the frontier, direction of "better" in the label |
| What does a 2-D grid or confusion matrix look like? | heatmap with a perceptually uniform colormap such as viridis and a labelled colour bar |
| Several panels of one story? | `figure_grid` with shared axes where they share a quantity, `panel_labels`, one legend |

## Not for

Conceptual or architecture diagrams, interactive charts, and AI-generated images. Say so and offer TikZ for a diagram.
