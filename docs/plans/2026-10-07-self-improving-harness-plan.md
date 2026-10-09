# Plan (built): the self-improving harness loop

Status: built 2026-10-07. Source: `.agents/skills/harness_skill` (SKILL.md, `harness-manifest.yaml`, `promotion-checklist.md`). Code: `scripts/live/evolution.ts` (pure rules, 23 offline tests), `scripts/live/evolve.ts` (controller, 6 offline integration tests in a temporary repo), manifest and log in `experiments/harness/`.

## What "harness" means here

The model is fixed (the Pi session's model). The harness is everything else, mapped from the skill's component list to files in `manifest.yaml`:

| Component | Files (globs) |
|---|---|
| prompt | `src/core/agent-rules.ts`, `src/core/refusals.ts` |
| skill | `skills/**` |
| client_tool | `src/mcp/server.ts`, `src/core/tools/*.ts` (schemas, descriptions, rendering) |
| output_plumbing | `src/core/notices.ts`, `src/core/bibrender.ts` |
| context_mgmt | `src/core/rag/**`, chunking and section code |
| control_flow | `src/core/verify/workflow.ts`, `src/core/source/prepare.ts`, `src/core/compile/run.ts` |
| config | `config/**`, `src/core/config.ts` |
| subagent | `src/pi/writer/**`, `src/pi/subagent/**` (the planned writer workflow) |
| memory | none yet |

**Protected, never self-editable:** the evaluator and its frozen inputs (`scripts/live/**`, `experiments/simulator.md`, `experiments/scenarios/**`, the manifest, `tests/evolution.spec.ts`), permissions and safety boundaries (`src/core/tool-owned.ts`, the Pi guard in `src/pi/index.ts`, the SSRF-safe downloader, `safe-detail.ts`). A candidate that touches one is refused. Held-out and OOD data are the two frozen scenarios `heldout-federated-medical-segmentation` and `ood-claim-check-genomics`; audit results print aggregates only.

## The loop (who does what)

The proposer is the working agent (a Claude Code or Pi session) under the owner's supervision; the controller supplies the discipline the skill asks for.

1. **Baseline** (`pnpm evolve baseline <scenario>/iter-NN…`): repeated runs of the unchanged harness give S_best and the noise: `delta` is the observed score spread and the relative cost spread. Fewer than three completed runs is marked provisional.
2. **Analyze** failures from the run reports (Part A facts first), clustered by mechanism (state not read, wrong tool, bad arguments, failed recovery, context loss, missing procedure, verification, stopping, deliverable, cost).
3. **Propose** (`pnpm evolve propose --id … --component … --hypothesis … --pattern … [--structural]`): the controller diffs the editable surface against the incumbent snapshot, attributes every changed file to a component, refuses protected edits, undeclared components and bundles larger than the annealed budget (4, then 2, then 1 edits), and reminds when progress has stalled and an untouched component should be tried.
4. **Screen** (`pnpm evolve screen <id>`): the SHIPPED diff's added lines are scanned for scenario names, bold phrases, CamelCase and ALLCAPS identifiers and DOIs of the evolve, held-out and OOD scenarios, and for evaluator check ids. A hit blocks evaluation.
5. **Evaluate**: run the same scenario(s) with the candidate applied (`pnpm experiment <scenario>`, same trial count as the baseline) and record them: `pnpm evolve evaluate <id> <scenario>/iter-NN…`. Blocked runs (provider capacity, deadlines) are counted and reported, never averaged in and never dropped silently; a third or more blocked, or fewer than two completed runs, is INCONCLUSIVE and must be rerun.
6. **Decide** (the skill's gates, with client-policy numbers in the manifest): leakage; domain guards; the non-compensatory floor `score >= S_best - delta`; not worse than the incumbent beyond the noise; a score gain beyond the noise may cost at most 25 % more; inside the noise band a candidate must cut cost by at least 10 % and more than the measured cost noise, or be a declared structural mechanism costing at most 10 % more.
7. **Promote** (`pnpm evolve promote <id> --checklist-ok` after reading `promotion-checklist.md`): snapshots the new incumbent first, keeps S_best monotone, logs everything. **Reject** keeps the failed edit in the history; the history conditions the next proposal and is never repeated without new evidence.
8. **Prune** (`pnpm evolve prune`): components exercised for the whole window without a positive measured contribution are proposed for removal.
9. **Audit** (`pnpm evolve audit <scenario>/iter-NN… --surface heldout|ood`): periodic release check against the reference recorded for H0; regression is a drop beyond the noise or a cost rise beyond the rent. Never inspected every round, never used to tune.
10. **Rollback** (`pnpm evolve rollback --to H0 --yes`): restores the editable surface from a snapshot. Snapshots are plain file copies under `experiments/harness/snapshots/`; this package does not commit for the owner.

## Known limits, stated

- **The evolve scenario is saturated** (every keyed run is 9/9), so the score gives the loop no gradient: today's promotions can only come from cost reductions and declared structural mechanisms. The multi-section writing scenario of `2026-10-07-document-writing-workflow-plan.md` (ledger coverage, unsupported-claim rate, cite validity) is the discriminating surface to add; it is also where a subagent component first becomes editable.
- **The baseline noise is thin and mixed:** H0 was measured from iter-12 to iter-14, which straddle small product changes (see `baseline_note` in the manifest). Cost noise is 60 % because wall-clock and token use vary a lot between runs; re-measure with true unchanged repeats when the first candidate is proposed.
- **The controller does not run the experiments itself;** it records and judges them. Runs cost about $0.6–1.1 each and 15–25 minutes.
- **A "protected" set is a protocol, not a sandbox:** the working agent can read the held-out scenario files. The screen, the aggregates-only audit and the rule against tuning on them are what keep them honest.
