# Experiments: user-simulation iterations

A simulated user (a Pi session on `google-vertex/gemini-3.8-flash`, no tools) talks to the real Uktub agent (Pi + this package, same model) inside the isolated Docker sandbox until it is satisfied or gives up. Each run is one **iteration** and ends with a report. See [docs/testing.md](../docs/testing.md) for how this fits the other test layers.

```
experiments/
  simulator.md                 the user persona and stop rules (hashed into every run)
  scenarios/<name>.md          the frozen user request + success criteria
  runs/<scenario>/iter-NN/     one iteration (created by the runner; all of runs/ is git-ignored)
    report.md                  the report: facts, simulator assessment, agent feedback, recommendations
    metrics.json               deterministic measurements and checks
    conversation.md            the readable conversation
    deliverables/              the manuscript, bibliography, PDF and registry as the user saw them
    evidence/                  raw transcripts, tool calls, logs
```

## Run one iteration

```sh
pnpm build                                   # the sandbox runs the packed dist
pnpm experiment rf-llm-literature-review     # next iteration number is chosen automatically
```

Needs Docker with the `uktub-scholar-sandbox` image (`docker build -t uktub-scholar-sandbox -f docker/test-sandbox.Dockerfile .`), working ADC (`gcloud auth application-default login`) and Vertex access. It spends Vertex quota; budgets are in `scripts/live/experiment.ts` (`EXPERIMENT_POLICY`).

## The improvement loop

1. Run an iteration; read `report.md` (Part A facts first, then the simulator's and the agent's opinions).
2. Pick the recommendations whose evidence is in the transcript. Reproduce a product defect **test first** in its existing test home, make the smallest fix, rebuild. Harness wording changes only after a real session shows the failure.
3. Run the next iteration. Never overwrite or edit an earlier one.

The loop ends when two iterations on the same product code both end with the simulator reporting `success`, every deterministic check in Part A passes, and neither the report nor the agent's feedback names an unresolved blocking obstacle that is in scope to fix (policy and cost decisions go to `docs/BACKLOG.md` for the owner). An iteration that ends `blocked` by provider capacity or a harness limit (Vertex `Resource exhausted`, stalls, the turn cap) is reported as such: it is neither a success nor a product failure, so it does not reset the count; a product-attributable failure, or any change to product code, does. Anything not met is reported as such, not rounded up.

## The self-improving loop (evolve, held-out, OOD)

The improvement loop above is run by hand. `pnpm evolve` adds the discipline of `.agents/skills/harness_skill`: a measured baseline and noise, sparse attributable edits, a leakage screen of the shipped diff, a non-compensatory performance floor, cost rent, pruning, rollback snapshots and protected held-out surfaces. Plan, rules and limits: [docs/plans/2026-10-07-self-improving-harness-plan.md](../docs/plans/2026-10-07-self-improving-harness-plan.md); state: `experiments/harness/` (`manifest.yaml`, `evolution-log.jsonl`, `snapshots/`, `candidates/`).

- **Evolve surface:** `rf-llm-literature-review` (visible to analysis, proposals and selection).
- **Held-out:** `heldout-federated-medical-segmentation` (same task shape, another field) and **OOD:** `ood-claim-check-genomics` (another task shape: check three claims, short output). Both are PROTECTED: run only as periodic release audits through `pnpm evolve audit … --surface heldout|ood`, which prints aggregates only. Never read their reports to propose a change, never tune on them.
- **Protected:** this runner, the checks, the simulator, every frozen scenario and the safety code (`manifest.yaml` `protected`). A candidate touching them is refused.

```sh
pnpm evolve status
pnpm evolve propose --id c1 --component skill --hypothesis "…" --pattern "failure pattern targeted" [--structural]
pnpm evolve screen c1                     # leakage + protected-surface screen of the shipped diff
pnpm experiment rf-llm-literature-review  # as many runs as the baseline had, with the candidate applied
pnpm evolve evaluate c1 rf-llm-literature-review/iter-NN …
pnpm evolve promote c1 --checklist-ok     # after reading the promotion checklist
```

## What is measured, and what is opinion

Part A of every report is deterministic (counts, timings, tokens, refusals, retries, checks computed from files and tool results). Parts B and C are model opinions (the simulator's assessment; the agent's own account of its struggles) and are evidence for investigation, not facts. Free-form prose quality is not auto-graded.
