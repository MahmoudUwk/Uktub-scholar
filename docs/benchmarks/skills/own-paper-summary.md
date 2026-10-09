# Skill cases on the owner's own paper: summary

These live cases (`pnpm live:skills`) ran a real Pi session on `test_papers/` content that is not published here. Their reports quote the paper, so the evidence
(prompt, answer, artifacts) stays in the gitignored `private/` folder next to this file; what is committed is only the verdict, the model, the time, the cost and
the number of tool calls. A `baseline-without-skill` row is the same case with the skill hidden.

| Case | Skill | Verdict | Model | Time | Cost | Tools | Variant |
|---|---|---|---|---|---|---|---|
| skill.grants.specific-aims | uktub-grants | PASS | google-vertex/gemini-3.8-flash | 535 s | $0.45 | 38 tool calls |  |
| skill.office.latex-to-docx | uktub-office | PASS | google-vertex/gemini-3.8-flash | 1092 s | $1.04 | 116 tool calls |  |
| skill.review.own-paper | uktub-review | PASS | google-vertex/gemini-3.8-flash | 115 s | $0.15 | 21 tool calls |  |
| skill.review.own-paper | uktub-review | FAIL | google-vertex/gemini-3.8-flash | 140 s | $0.13 | 14 tool calls | baseline-without-skill |
| skill.slides.own-paper | uktub-slides | PASS | google-vertex/gemini-3.8-flash | 368 s | $0.48 | 59 tool calls |  |
| skill.slides.pptx-from-paper | uktub-slides | FAIL |  | 416 s |  | not recorded |  |
