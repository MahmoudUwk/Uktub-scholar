---
name: uktub-office
description: "Move a LaTeX manuscript into Word and read what co-authors send back. Export the paper to a .docx for co-authors, a funder or a journal with its sections, figures, tables, equations and citations; and list every tracked change and comment in a .docx a co-author returned, flagging the ones that touch numbers, claims or citations. Use when the user asks for a Word or .docx version of their paper, or shares a .docx with tracked changes or comments. Do not use for PowerPoint, for editing a .docx in place, or for PDFs."
compatibility: "Export needs pandoc (a separate program the user installs). Reading changes needs only python3. A LibreOffice install lets you render the result to look at it."
---

# Word documents and co-author changes

LaTeX stays the source of truth. A `.docx` made from it is a copy for people who work in Word; what comes back in Word is read, summarised and
applied to the LaTeX by hand, with the user's say.

## Export a manuscript to .docx

Rules: never touch the user's `.tex` files; write only under `manuscript/docx/`. Say what the export loses (see the end). Never claim
the Word file is camera-ready.

1. Check the prerequisite: `pandoc --version`. If it is missing, tell the user to install it and stop.
2. Read the entry file and its `\input` files. A journal class (`elsarticle`, `IEEEtran`, `revtex`) is not understood by pandoc, so make a
   plain wrapper `manuscript/docx/export.tex` of your own: `\documentclass{article}`, the title and authors, the abstract, `\input{../<each
   section file>}`, the bibliography commands, and a `\newcommand` for every house macro the paper uses (for example `\rev{#1}` as `#1`).
   Leave the originals alone.
3. Figures: Word cannot show EPS and pandoc cannot embed PDF figures. Give every figure a PNG (`pdftoppm -png -r 200 -singlefile in.pdf out`
   for a PDF; the paper's own PNG as it is) and make the wrapper's copies point at the PNG files (a sibling folder `manuscript/docx/figs/`).
4. Run from the project root:
   `pandoc manuscript/docx/export.tex -f latex -o manuscript/docx/<name>.docx --citeproc --bibliography=<the .bib> --resource-path=manuscript:manuscript/docx --number-sections`
   Read pandoc's warnings; each unresolved reference or missing file is a defect to fix, not noise.
5. **Check the result by reading it back**, not by trusting the command: `pandoc <name>.docx -t plain` (text, headings, no raw `\cite` or `[?]`),
   `unzip -l <name>.docx` (figures under `word/media/`), and `unzip -p <name>.docx word/document.xml | grep -o '<m:oMath>' | wc -l`
   (equations became Word equations). Compare the counts with the source: sections, figures, tables, equations, references.
6. If LibreOffice exists (`soffice`), render it (`soffice --headless --convert-to pdf --outdir manuscript/docx manuscript/docx/<name>.docx`),
   then `pdftoppm` a page or two and look at them. Otherwise say the visual check was not done.
7. Report: the file, what was checked and the counts, and what did not survive. Typical losses: the journal's page layout and fonts,
   cross-reference numbers for equations the wrapper could not resolve, custom macros, algorithm environments and floats positioned by TeX.

## Read what a co-author returned

1. Run `python3 <skill directory>/scripts/docx_changes.py <file.docx>` (`<skill directory>` is the folder of this file). It prints the number
   of tracked changes and comments, then each insertion, deletion and formatting change with author, date and the paragraph as it reads
   with the changes accepted, then each comment with the passage it is attached to.
2. Group them for the user: **changes to numbers or results**, **changes to claims or conclusions**, **citations**, **wording**, **formatting**,
   and the comments that ask a question or request work. Quote each change exactly as the script printed it; do not paraphrase a number.
3. Flag a change that makes the text disagree with the paper's tables or the LaTeX source (find the sentence in the `.tex` and say so).
4. **Never silently accept everything and never edit the LaTeX unasked.** Offer the edits one by one, with the file and line of the LaTeX each
   would change; apply only the ones the user approves.

## Cannot do

Edit a `.docx` in place with tracked changes of your own, or open a `.doc` or `.docx` that is password protected. For in-place editing the
user needs Word, or a docx library such as Paper Office's `paper-docx`; say so rather than patching the XML by hand.
