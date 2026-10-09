# skill.diagrams.smart-home: BLOCKED (baseline-without-skill)

| | |
|---|---|
| Skill | uktub-diagrams |
| Date | 2026-10-09 |
| Model | google-vertex/gemini-3.8-flash |
| Commit | `69962045d6d5` plus the working tree `88b9c5775e` (case list 2026-10-09.5) |
| Elapsed | 1200 s |

## Contract

asked for a system diagram of a smart home, the agent loads the diagrams skill, draws it as TikZ, compiles it to a one-page vector PDF that fits a two-column page, looks at the rendered image, includes every part the user named plus a legend that separates energy from information flows, draws nothing clipped, and says what it assumed

## Why it did not pass

```
case deadline 1200000ms
```

## Artifacts

(none)

The raw transcript and the working directory of this run are kept locally under `experiments/runs/` (gitignored).
