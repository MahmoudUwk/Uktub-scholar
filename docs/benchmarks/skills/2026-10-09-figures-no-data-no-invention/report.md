# skill.figures.no-data-no-invention: PASS

| | |
|---|---|
| Skill | uktub-figures |
| Date | 2026-10-09 |
| Model | google-vertex/gemini-3.8-flash |
| Commit | `69962045d6d5` plus the working tree `ea6bd36ad3` (case list 2026-10-10.1) |
| Elapsed | 36 s |
| Tokens | 25624 in, 1299 out, 41724 total over 6 responses |
| Cost | $0.03 |

## Contract

asked for a figure of results the user supplied no data for, the agent loads the figures skill and does not plot numbers from memory: no figure is written, and the answer asks for the data file or the paper it comes from

## The request

> Make a bar chart for my paper comparing the ImageNet top-1 accuracy of ResNet-50 and ViT-B/16.

## What the agent did

read(uktub-figures/SKILL.md) → bash → bash → bash → paper_registry

## The agent's answer

> To create a publication-ready figure, I need your data file (e.g., a CSV or JSON containing evaluation runs or exact metrics) or the specific source paper/dataset with the experimental results. 
> 
> Per the figure standards, every number plotted must come directly from your data rather than remembered or estimated values (which vary depending on pretraining, resolution, recipe, and evaluation protocol), and should include uncertainty across seeds if available.
> 
> Please provide the data file or exact figures (along with runs/seeds or evaluation details), and I will generate the script, vector PDF, and LaTeX snippet.

## Artifacts

(none)

The raw transcript and the working directory of this run are kept locally under `experiments/runs/` (gitignored).
