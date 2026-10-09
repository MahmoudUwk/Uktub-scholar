---
name: uktub-diagrams
description: "Draw conceptual figures for a LaTeX paper as vector TikZ diagrams: system and architecture block diagrams, pipelines and flowcharts, with energy or data flows, grouped parts and a legend, compiled with the project's own LaTeX engine and checked by looking at the rendered image. Use when the user asks for a diagram, system model, architecture figure, flowchart or pipeline figure for a paper or thesis. Do not use for plots of data (use the figures skill), for photographs or AI-generated illustrations, or for slides."
compatibility: "Needs a LaTeX engine (the compile tool) and, for the visual check, a PDF-to-PNG converter such as pdftoppm."
---

# Diagrams for a paper

A diagram earns its place by showing structure a paragraph cannot: what the parts are, what connects to what, and what flows along each
connection. It is drawn in TikZ so it stays vector, uses the paper's fonts, and compiles with the same engine as the manuscript.

## Rules

1. **TikZ only.** No raster images, no AI-generated art. Every label is real text inside the PDF.
2. **Every part the user named, under the user's name for it, and nothing they did not mention** except a legend. Do not invent a connection:
   if you do not know whether X connects to Y, leave it unconnected and say so in your answer, or ask. A part carries its name and no more:
   no subtitle, algorithm, standard or capability the user did not state (a controller the user calls "a reinforcement-learning agent" is
   not captioned "DQN / PPO / SAC", an EV is not "V2G capable"). Detail belongs in the caption you offer, marked as yours to confirm.
3. **One idea per diagram.** About fifteen nodes at most; group related parts in a labelled box; put the central part in the middle.
4. **Two kinds of flow, two encodings, and a legend.** Separate them by colour and by line style so the figure survives greyscale
   (energy: solid, `#D55E00`; information: dashed, `#0072B2`), with arrowheads on every line and a legend inside the figure.
5. **Build at the printed width** (single column 3.25 in, text width 5.5 in, two columns 6.75 in) with text of about 7 to 8 pt. Do not
   draw big and rescale.
6. **No overlap, no crossing where avoidable.** Place nodes by `positioning` or a coordinate grid, route lines orthogonally
   (`|-`, `-|`), end every arrow on a node border.

## Process

1. List the parts, the groups and each flow (from, to, kind). If something is ambiguous, say what you assumed.
2. Write `manuscript/figures/<name>.tex`, a standalone document (skeleton below).
3. Compile it with the compile tool (entry `manuscript/figures/<name>.tex`); the PDF lands in `build/<name>.pdf`. Copy it to
   `manuscript/figures/<name>.pdf`. Fix every error; do not leave a stale PDF.
4. **Look at it.** Render a PNG and read it with the file read tool (it is shown to you as an image):
   `pdftoppm -png -r 150 -singlefile build/<name>.pdf build/<name>`, then read `build/<name>.png`. If no converter exists, say that the
   visual check could not be done.
5. Check: `pdftotext build/<name>.pdf -` lists every part you were asked for; nothing overlaps or is clipped; each arrow joins the right
   things; the legend matches the lines. **The width:** `pdfinfo build/<name>.pdf` shows `Page size: W x H pts`; W must not exceed the target
   (two columns 486 pt, text width 396 pt, one column 234 pt). A wider drawing is rescaled by `\includegraphics` and its text shrinks below
   legibility: narrow the drawing (fewer words per node, smaller gaps), do not accept it. Fix and recompile, at most three rounds.
6. Tell the user: the files, which parts and flows the diagram shows, what each colour means, every assumption, and the LaTeX line
   `\includegraphics[width=\linewidth]{figures/<name>.pdf}` with a caption that states the claim.

## Skeleton

```latex
\documentclass[tikz,border=2pt]{standalone}
\usetikzlibrary{positioning,arrows.meta,fit,backgrounds}
\definecolor{cEnergy}{HTML}{D55E00}\definecolor{cInfo}{HTML}{0072B2}
\tikzset{
  box/.style={draw, rounded corners=1.5pt, align=center, font=\scriptsize, minimum height=6mm, inner sep=2pt, fill=white},
  hub/.style={box, fill=gray!15, very thick},
  energy/.style={-{Stealth[length=1.6mm]}, cEnergy, thick},
  info/.style={-{Stealth[length=1.6mm]}, cInfo, thick, dashed},
  group/.style={draw=gray, dashed, rounded corners=2pt, inner sep=3pt, font=\scriptsize\itshape}
}
\begin{document}
\begin{tikzpicture}[node distance=7mm and 10mm]
  \node[hub] (ctl) {Controller};
  \node[box, left=of ctl] (src) {Source};
  \node[box, right=of ctl] (load) {Load};
  \draw[energy] (src) -- (load);          % energy flow, solid
  \draw[info] (ctl) -- (src);             % information flow, dashed
  \begin{scope}[shift={(0,-1.4)}]         % legend
    \draw[energy] (0,0) -- ++(0.6,0) node[right, font=\scriptsize] {Energy};
    \draw[info] (1.8,0) -- ++(0.6,0) node[right, font=\scriptsize] {Information};
  \end{scope}
\end{tikzpicture}
\end{document}
```
