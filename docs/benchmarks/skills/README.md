# Skill benchmarks: proof of what each product skill did

Each folder is one live case (`pnpm live:skills`): a real Pi session on the model named in its report, in the Docker sandbox, given a task a skill is
for. The case checks the skill was loaded and the artifact is right (files, bytes, extracted data); the folder keeps the request, the order of tools,
the agent's answer and the artifacts it produced. Cases and verdicts are defined in `scripts/live/skill-cases.ts`; how to run them is in
[docs/testing.md](../../testing.md). Archive a run with `node scripts/live/archive.ts <run-dir>`.

Cases that ran on the owner's own paper quote it, so their evidence stays local; [own-paper-summary.md](own-paper-summary.md) lists their verdicts, time and cost.

A `--baseline-without-skill` folder is the same case with the skill hidden. A `--superseded-...` folder passed the checks of its day and was replaced
after a defect those checks missed; its report says which, and the case now checks for it.

| Case | Skill | Verdict | Model | Time | Cost |
|---|---|---|---|---|---|
| [2026-10-09-diagrams-smart-home](2026-10-09-diagrams-smart-home/report.md) | uktub-diagrams | PASS | google-vertex/gemini-3.8-flash | 832 s | $0.41 |
| [2026-10-09-diagrams-smart-home--baseline-without-skill](2026-10-09-diagrams-smart-home--baseline-without-skill/report.md) | uktub-diagrams | BLOCKED |  | 1200 s |  |
| [2026-10-09-diagrams-smart-home--superseded-extra-labels](2026-10-09-diagrams-smart-home--superseded-extra-labels/report.md) | uktub-diagrams | PASS | google-vertex/gemini-3.8-flash | 522 s | $0.52 |
| [2026-10-09-figures-no-data-no-invention](2026-10-09-figures-no-data-no-invention/report.md) | uktub-figures | PASS | google-vertex/gemini-3.8-flash | 36 s | $0.03 |
| [2026-10-09-figures-plot-user-data](2026-10-09-figures-plot-user-data/report.md) | uktub-figures | PASS | google-vertex/gemini-3.8-flash | 260 s | $0.12 |
| [2026-10-09-figures-plot-user-data--baseline-without-skill](2026-10-09-figures-plot-user-data--baseline-without-skill/report.md) | uktub-figures | FAIL | google-vertex/gemini-3.8-flash | 302 s | $0.13 |
| [2026-10-09-office-tracked-changes](2026-10-09-office-tracked-changes/report.md) | uktub-office | PASS | google-vertex/gemini-3.8-flash | 39 s | $0.04 |
