# Product skills: adoption context (2026-10-09)

Status: research record, nothing built. Owner direction: start adopting the product skills of [BACKLOG §7](../BACKLOG.md#7-skills-for-the-uktub-agent)
(slides, Word and Excel and PDF editing, scientific figures, manuscript "slop" review, grants). Method: four Hermes research runs
(slides and figures, office files, manuscript review, skill format and distribution; raw output, untrusted and partly wrong, is
kept outside the repository in `~/.cache/uktub-bench/hermes-raw-2026-10-09/`), a local read of the pinned skill clones and of Pi's
skills documentation, and our own checks against the GitHub, PyPI, CTAN, arXiv and Hugging Face APIs and a real Tectonic
compile. Hermes could not fetch repository files in three of four runs, so its repository-level claims count only where the
table below confirms them.

## Verified by us

| Fact | How |
|---|---|
| Anthropic's `docx`, `pdf`, `pptx` and `xlsx` skills carry an all-rights-reserved `LICENSE.txt`; `skill-creator` and `frontend-design` are Apache-2.0; OpenScience vendors the four (its `ATTRIBUTION.md`) | `LICENSE.txt` of each, raw GitHub |
| Paper Office: `paper-instruments/skills` is MIT; `paper-docx` 0.2.1, `paper-pptx` 0.2.1 and `paper-xlsx` 0.2.2 are MIT on PyPI (hard forks of python-docx, python-pptx and openpyxl that keep their import names). Its benchmark (61 tasks, 282/305 against 246 upstream and 212 with Anthropic's skills) is vendor-run, not independently reproduced | GitHub licence files, PyPI, Hermes |
| `Gabberflast/academic-pptx-skill`: the repository `LICENSE` is MIT, but its `SKILL.md` frontmatter says "Proprietary. LICENSE.txt" (template residue), and it hands file generation to another PPTX skill. Use the content layer as ideas only | raw `LICENSE` and `SKILL.md` |
| ScientificSlop is arXiv 2610.00531 (Oh, Lee, Ahn, Kim, Kang; preprint, 30 Sep 2026). **Its Table 3 pair accuracies are cross-section references 0.905, macro redundancy 0.723, citation isolation 0.793, evidence gap 0.764** (argument graph 0.586 and figure exposition 0.809 need a model; aggregate 0.859 against Binoculars 0.687). The four numbers the backlog carried from the repository README were partly wrong. Evidence gap has 0.000 true-positive rate at 5 % false positives. The code repository has no licence; the dataset `yerim0210/Scientific_Slop` is CC-BY-4.0 and ships `data/scores.parquet` (usable for parity checks) | arXiv HTML, Hugging Face API |
| Tectonic 0.15.0 and the pinned 0.17.0 both bundle LaTeX2e 2021-11-15 and beamer 3.66. `\usetheme{metropolis}` compiles; `\usetheme{moloch}` fails with "beamerthememoloch.sty not found" on both (Moloch is CTAN 2.2.0, CC-BY-SA-4.0; CTAN's beamer is 3.78) | compiled a one-slide deck with each engine |
| Skill limits: `name` 1–64 characters, `description` up to 1024 (the standard recommends a body under about 500 lines: Hermes, not re-checked). Pi discovers `.agents/skills/` and a package's `pi.skills` (ours already declares `./skills`), loads only name and description at startup and the body on demand; `/skill:name` forces one | Pi's installed `docs/skills.md` and `packages.md` |
| `npx skills add <owner/repo>` (vercel-labs/skills, MIT, 33k stars) scans `skills/`, `.agents/skills/`, `.claude/skills/` and plugin manifests; `metadata.internal: true` in a skill's frontmatter hides it from discovery | the tool's README |
| Poster classes on the shipped engine: `tikzposter` and `beamerposter` compile; `baposter` is not in the bundle. evident-charts reviews a rendered chart for up to 3 rounds and ships `.claude-plugin`, `.codex-plugin` and `gemini-extension.json` beside `skills/`, a precedent for multi-host distribution | compiled each class; its README and file listing |
| Library versions: matplotlib 3.11.2, SciencePlots 2.2.2 (MIT), python-pptx 1.0.2, python-docx 1.2.0, openpyxl 3.1.5 | PyPI |

## Recommendation per skill

| Skill | Build on | Leave out | First deliverable |
|---|---|---|---|
| **Figures** (`uktub-figures`) | OpenScience `core/figures` and the palette and export audit of `core/scientific-visualization` (MIT upstream), OpenResearch `orx-figures` rules (print-size build, vector, numbers from files, caption not title, uncertainty), the evident-charts loop (code checks first, then a vision review, at most 3 rounds); matplotlib plus SciencePlots | `generate_image`, infographics, plotly and seaborn manuals, host-tool references | Skill text and a small audit script (palette, size, vector, fonts); numbers come from the user's data or the registry, never memory |
| **Manuscript review** (`uktub-review`) | The four deterministic measures reimplemented from the paper's Appendix A in TypeScript as a CLI command `uktub-scholar review` (no Python, no sixth MCP tool), tested against `scores.parquet`; the skill wraps it with OpenScience `core/peer-review` structure (blocking against minor, locatable findings, no verdict) and the read-only "Editor" pattern | Argument graph and figure exposition (need a model); AI-text detectors | CLI plus tests first (cross-section references, then citation isolation, evidence gap, macro redundancy), then the skill; full report to a project file, a few lines returned |
| **Slides and posters** (`uktub-slides`) | Beamer with the **Metropolis** theme (it compiles on the shipped engine), OpenScience `latex-posters` templates and checklist, the content discipline of `academic-pptx-skill` (action titles, one exhibit per results slide) | `paper-2-web`, `pptx-posters`, AI slide images (paid closed model) | One slide deck from a registered paper set with citations from `refs/references.bib`; `tikzposter` and `beamerposter` templates only (`baposter` is not in the bundle) |
| **Office files** (`uktub-office`) | pandoc for LaTeX to `.docx` with `--citeproc` against our `.bib`; `paper-docx` for reading and answering co-author tracked changes; `paper-xlsx` later; `pypdf` and `pdfplumber` for PDFs; LibreOffice headless to render and check | Anthropic's skills (proprietary), PyMuPDF, hand-editing OOXML as the main method | A tested LaTeX to `.docx` export on one real manuscript, then one returned tracked-change `.docx` |
| **Grants** (`uktub-grants`) | OpenScience `research/research-grants` (trimmed; one agency reference loaded on demand), `statistical-power`, `experimental-design` | the 36 KB body as written | After the four above |

Hermes advice we did not take: "Beamer with Moloch" (does not compile on our engine; vendoring a CC-BY-SA theme is its own
decision) and "genoffice as a skill dependency" (a desktop-app prerequisite).

## Distribution and quality

- Flat `skills/<name>/SKILL.md`. Pi loads them through the package; other hosts read the user's project `.agents/skills/`
  (Claude Code reads `.claude/skills/`), filled by `npx skills add MahmoudUwk/Uktub-scholar --skill <name>`. Codex needs a one-line
  `AGENTS.md` pointer (our measured result).
- **Risk:** that installer also lists `.agents/skills/`, so the seven development skills (Hermes, Devin, API references, evolve)
  would show up beside the product skills. Marking them `metadata.internal: true` hides them; this touches seven owner-authored files.
- Descriptions say what the skill does and when to use it, with explicit near-misses; 16 to 20 trigger prompts per skill (half
  should not trigger), run on `google-vertex/gemini-3.8-flash` before release. Prerequisites go in `compatibility`, never bundled.
  The existing `uktub-research` description has no "use when" clause; per AGENTS.md it changes only after a real failure.

## Decisions for the owner

1. Order. Our recommendation: figures, manuscript review, slides, office files, grants (value, local-only, least new runtime).
2. Slide theme: Metropolis now, or vendor Moloch (CC-BY-SA), or wait for a newer Tectonic bundle.
3. Accept Paper Office (`paper-docx` and friends) as a stated user-installed prerequisite, and pandoc and LibreOffice as optional ones.
4. Mark the development skills `metadata.internal: true`, or move them out of `.agents/skills/`.
5. Manuscript review as a CLI command, not a sixth MCP tool.
6. Whether `.pptx` is in scope for version 1.
7. Which repository "ARS" is.

## Outcome (2026-10-10)

1. Followed: figures, review, slides, office, grants, plus diagrams; each proven live ([benchmarks/skills](../benchmarks/skills/README.md)).
2. Metropolis; Moloch does not compile on the Tectonic bundles tried.
3. `paper-docx` deferred to the end ([BACKLOG §7](../BACKLOG.md)); pandoc is a stated prerequisite of the `.docx` and `.pptx` routes, LibreOffice optional (a visual check only).
4. Done: every `.agents/skills/*` carries `metadata.internal: true`.
5. Yes: `uktub-scholar review` is a CLI command; the skill calls it.
6. Yes: `.pptx` through pandoc, in `uktub-slides`.
7. Deferred (the owner does not know which repository it is).
