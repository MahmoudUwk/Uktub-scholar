# Section chunking vs fixed windows — Eos 0.8B — 2026-10-04

The same end-to-end `verify_claim` workflow as the [window sweep](evidence-window-sweep-2026-10-04.md) (in-package `eos` engine, bar 0.99, own-paper scope, fresh registry per mode, locator query = the claim in the guided rows), with the chunk policy as the only change: **fixed** windows (`paragraph` boundary, overlap = window/64) against **section** chunks (document headings; a section that fits the cap stays whole, a larger one is split into balanced sentence-aligned pieces, tiny sections merge into a neighbour that fits; no overlap), at caps of 1,024 and 512 tokens (2.8 chars/token).

Two disjoint samples of the 135-claim dataset (every third claim of each label, offsets 0 and 1): 25 TRUE and 20–21 FALSE claims each. Offset 0 is the sample the earlier sweep used to choose 1,024; **offset 1 is untouched validation**.

| Policy | Sample | TRUE recall (exhaustive) | Recall (guided) | Gold-hit precision (lower bound) | Fresh judgments / claim (exhaustive → guided) | FALSE claims with own-paper support |
|---|---|---|---|---|---|---|
| fixed 1,024 | offset 0 | 84.0 % | 84.0 % | 72.4 % | 30.5 → 7.9 | 2/21 |
| fixed 1,024 | offset 1 | 76.0 % | 72.0 % | 73.1 % | 29.3 → 7.6 | 1/20 |
| section 1,024 | offset 0 | 84.0 % | 84.0 % | 70.0 % | 32.3 → 7.2 | 2/21 |
| section 1,024 | offset 1 | 92.0 % | 92.0 % | 85.2 % | 31.1 → 7.2 | 2/20 |
| fixed 512 | offset 0 | 84.0 % | 84.0 % | 75.0 % | 50.1 → 5.0 | 2/21 |
| fixed 512 | offset 1 | 84.0 % | 84.0 % | 77.8 % | 48.1 → 5.0 | 0/20 |
| **section 512** | offset 0 | **96.0 %** | 96.0 % | 75.0 % | 52.2 → 5.0 | 2/21 |
| **section 512** | offset 1 | 84.0 % | 84.0 % | 77.8 % | 50.2 → 5.0 | 1/20 |

Pooled over both samples (50 TRUE claims, 41 FALSE): support recall (exhaustive) **fixed 1,024 80 % (40/50) · section 1,024 88 % (44/50) · fixed 512 84 % (42/50) · section 512 90 % (45/50)**; own-paper false supports 3 · 4 · 2 · 3 of 41. Paired against fixed 1,024 (the previous default), claim by claim: section 512 gains 6 claims and loses 1; section 1,024 gains 5 and loses 1; fixed 512 gains 3 and loses 1.

Reading:

- Section chunking is **not worse** than fixed windows at either cap, and the direction of every paired comparison favours it. The adoption criterion (not worse than fixed 1,024 on held-out claims) is met; **superiority is not established** — 50 claims, one claim is 2 points, the sign test on 6 gains / 1 loss gives p ≈ 0.13 two-sided.
- False supports are within noise of each other (2–4 of 41 in every policy).
- At a 512 cap a locator query needs 5.0 judgments per claim (7.6 for fixed 1,024); an exhaustive pass needs about 1.7× the judgments of a 1,024 window because there are more chunks.
- 512 is the only cap at which every chunk (≤ 1,433 characters) is inside the 1,500-character excerpt limit, so one chunk is one releasable passage (no localization recheck) and the same chunks serve `search_passages`.
- **Decision: default `boundary: section`, 512 tokens, no overlap.**

Raw per-claim records (spans, counts, 160-character exemplars): `evidence-endtoend-sections-*` and `evidence-endtoend-fixed-*-offset1-*` results files beside this report; the offset-0 fixed runs are the earlier `evidence-endtoend-sweep-T*` files. One run (section 1,024, offset 1) was repeated after a code edit during the first attempt made its guided half read a newer schema than the process spoke (45 refusals, no records); the repeat is the reported run.
