---
name: self-improving-harness
description: Design and recursively improve an LLM agent harness while resisting benchmark overfitting and context bloat. Uses modular harness components, compact task-specific context, trace-driven diagnosis, sparse attributable edits, leakage screening, noise-aware and cost-aware promotion, structural pruning, rollback, and held-out transfer checks.
---

# Self-Improving Agent Harness

Use this skill when building an agent that should improve its own **harness** over repeated tasks while keeping the backbone model fixed.

## Goal

Improve real task success on **unseen work** while keeping the harness simpler, cheaper, attributable, and reversible.

A harness includes everything around the model weights:

`prompt | control_flow | config | output_plumbing | context_mgmt | client_tool | skill | memory | subagent`

The harness may modify these components, but it should not treat its model weights, evaluator, protected held-out data, security boundaries, or permission system as self-editable state.

## Core rules

1. **Ship transferable mechanisms, not benchmark-shaped instructions.**
2. **Every persistent component must earn its context, latency, or token cost.**
3. **Change few things at a time so gains are attributable.**
4. **Use full history: failed edits are evidence too.**
5. **Do not promote a candidate because of one noisy win.**
6. **Do not tune on held-out or OOD evaluation.**
7. **If guidance does not change an action, check, tool choice, or completion criterion, do not load it.**
8. **Every accepted change must be logged and rollbackable.**

# Part I — Build a strong base harness

## 1. Keep the harness modular

Do not bury all behavior in a giant system prompt. Keep independently editable modules for:

- prompt / policy guidance
- planning and control flow
- tool schemas and tool-selection rules
- retries and recovery
- context loading / compaction / retrieval
- reusable skills
- memory
- subagents
- output validation / plumbing
- stopping logic

A failure should be traceable to a layer, and an edit should name the layer it changes.

## 2. Put behavior in the cheapest reliable layer

Prefer:

- **code/control flow** for deterministic sequencing, retries, gates, and stop conditions
- **tool interfaces** for invocation constraints
- **context management** for what is visible, retrieved, summarized, cached, or dropped
- **skills** for reusable procedures
- **memory** for durable facts or state
- **prompts** for rules that genuinely require model judgment
- **subagents** only when separation of context/work is useful
- **output plumbing** for schema, artifacts, validation, and handoff

If code can enforce a requirement, do not pay to remind the model about it every turn.

## 3. Use a compact task pack, not a standing encyclopedia

For each task, classify:

- task type and domain
- required tools/data
- acceptance criteria
- output format
- time/token/tool-call budget
- relevant failure modes

Load instruction sources in this order:

1. task-specific procedural skill
2. selectively retrieved domain guidance
3. generic rigor / verification guidance
4. minimal baseline

Use a full profession or domain profile only when the task genuinely needs many sections and the budget can absorb it.

The task pack should contain only:

- assumptions to check
- ordered procedure
- tool/reference constraints
- likely failure modes and diagnostics
- validation requirements
- definition of done

Remove instructions that merely restate professional identity or generic background knowledge.

## 4. Preserve working-context headroom

Treat persistent context as a resource cost.

Before execution:

- avoid duplicate instructions already present in the task/environment
- retrieve large guidance only when it becomes relevant
- cache stable context when the runtime supports it
- summarize or drop stale tool output
- preserve room for data, intermediate state, and final synthesis
- keep the original task specification recoverable for final verification

## 5. Add bounded verification before completion

Before stopping, run a small task-appropriate completion gate, such as:

- re-read acceptance criteria
- run tests / validators
- verify required files exist
- validate output schema
- confirm every requested item is covered

Bound the gate. Do not create unbounded reflection loops.

## 6. Add narrow recovery mechanisms

Create task-agnostic recovery rules near recurring failures, for example:

- missing/invalid workdir → verify/create valid directory, retry once
- long-running command → poll non-blockingly instead of restarting
- transient tool error → bounded retry/backoff
- malformed artifact → validate, repair once, then fail clearly
- context overflow → compact/summarize before continuing

Prefer a small recovery mechanism over a long “be robust” instruction.

# Part II — Instrument the harness for self-improvement

## 7. Maintain explicit evolution state

Persist at least:

- immutable baseline `H0`
- current incumbent harness `Ht`
- current best reliable score `S_best`
- empirical noise tolerance `delta`
- candidate/edit history
- per-component contribution history
- performance and resource metrics
- protected evolve / held-out / OOD task manifests
- rollback snapshots

Use `templates/harness-manifest.yaml` and `templates/evolution-log.jsonl` as starter schemas.

## 8. Measure more than accuracy

Track separately:

- task score / verifier result
- first-pass delivery rate
- completed-item accuracy or quality
- end-to-end success, counting unrecoverable harness/infrastructure failures
- input/context tokens
- output/reasoning tokens
- total policy tokens if available
- tool calls / trajectory steps
- wall time and cost
- token/time-limit stops
- crashes / malformed deliverables

Do not silently drop failed runs from the denominator.

## 9. Estimate evaluation noise before evolving

Run the unchanged base harness multiple times on the evolve set.

Use repeated measurements to estimate `delta`, the natural score fluctuation of the same harness.

`delta` is a measurement of evaluation noise, not a threshold to tune until candidates pass.

Preserve a held-out set that the evolution loop never sees. When possible, also preserve an OOD set with different task wording, tools, environments, or verifiers.

# Part III — The recursive improvement loop

Run the following loop for a bounded number of rounds.

## 10. Analyze failures before proposing changes

From the current incumbent's trajectories, cluster failures by mechanism:

- state not read / perceived
- planning error
- wrong tool choice
- bad tool arguments
- failed recovery
- context overload or lost context
- missing task-specific procedure
- verification failure
- premature or late stopping
- deliverable/output failure
- excessive cost / trajectory length

Produce cross-task failure feedback. Prefer recurring causal patterns over one-off task details.

## 11. Propose atomic edits with explicit hypotheses

Each atomic edit must record:

- `component`
- `hypothesis`
- `source_diff`
- `failure_pattern_targeted`
- `expected_benefit`
- `expected_cost_change`
- `risks`

The proposer may reason from task-specific failures, but the **shipped diff** should encode a reusable mechanism rather than those task specifics.

## 12. Use an annealed edit budget

Limit how many independently attributable edits may be bundled into one candidate.

Practical default:

- early rounds: at most 3–4 coordinated atomic edits
- middle rounds: 2 edits
- late rounds: 1 edit

The exact schedule may vary. The goal is to make later gains attributable to a specific mechanism.

## 13. Use the whole edit history

Condition new proposals on previous outcomes.

For every evaluated edit retain:

- round
- component
- hypothesis
- diff
- score delta
- cost delta
- accepted/rejected status
- rejection reason

Do not repeatedly retest a mechanism already falsified unless materially new evidence or implementation changes justify it.

## 14. Explore underused components when stalled

Track which component classes have received measured edits.

If progress across several rounds remains within `delta`, reserve at least one candidate for an underexplored component.

Do not let evolution collapse into endless prompt rewriting. Explore structural mechanisms such as:

- control flow
- context management
- client/tool interface
- skill retrieval
- memory
- subagent decomposition
- output plumbing

# Part IV — Screen and select candidates

## 15. Screen the shipped diff for leakage before expensive evaluation

Reject candidates whose persistent diff includes:

- benchmark or task names
- entity names specific to the evolve set
- known answers or task-specific values
- grader/rubric exploits
- document-genre logic that exists only because of the evolve suite
- benchmark-specific lookup tables
- inert machinery that does not alter useful behavior

Screen the **diff**, not the proposer rationale.

## 16. Evaluate candidates against the same evolve surface

For each screened candidate:

- run the same task set and verifier policy as the incumbent
- use the same number of trials where possible
- collect both score and resource cost
- count failed/missing rollouts as failures unless the evaluation protocol explicitly says otherwise

Compute:

- `dScore = score(candidate) - score(incumbent)`
- `dCost = (cost(candidate) - cost(incumbent)) / cost(incumbent)`

## 17. Apply a non-compensatory performance floor

A candidate must not fall materially below the best reliable score seen so far.

Operationally:

`score(candidate) >= S_best - delta`

A cost reduction does not compensate for a real performance regression beyond this floor.

## 18. Make added complexity pay rent

If `dScore` clearly exceeds `delta`, allow extra cost only when justified by the measured gain.

If `dScore` is within the noise band, do **not** treat the apparent score increase as strong evidence. Prefer candidates that:

- reduce cost materially, or
- introduce a genuinely new structural mechanism worth testing

Do not keep a 20–30% cost increase for a tiny/noisy score gain.

## 19. Promote only admissible candidates

A candidate may replace the incumbent only if all required gates pass:

- leakage screen
- performance floor
- cost/complexity rule
- domain-specific safety/integrity guards

Among admissible candidates, select the best measured performer. If none qualifies, keep the incumbent unchanged.

Update `S_best` monotonically from reliable accepted results; never move the floor downward to make a regression look acceptable.

## 20. Prune stale mechanisms

Over a rolling window, identify components that have been exercised but have shown no positive measured contribution.

Propose removal or simplification of those components.

Persistent context blocks are especially strong pruning candidates when they:

- rarely fire
- duplicate task instructions
- consume tokens every turn
- were added for one benchmark/task genre
- do not change a decision, check, tool call, or completion criterion

The harness should not grow monotonically.

# Part V — Transfer, release, and rollback

## 21. Keep development and release evaluation separate

Use three surfaces when feasible:

1. **Evolve set** — visible to analysis/proposal/selection.
2. **ID held-out set** — same broad distribution, never used for proposing or candidate selection.
3. **OOD audit set** — different tasks, tools, wording, or verifiers.

Do not inspect held-out/OOD results every round and then adapt to them; that simply turns them into evolve data.

Use them as periodic release audits. If you repeatedly release, rotate or refresh audit sets where possible.

## 22. Prefer transfer over development score

A harness with a smaller evolve-set gain but better unseen-task transfer is preferable to a benchmark specialist.

The release report should include both performance and cost.

## 23. Roll back on production regression

Keep the previous accepted harness available.

Rollback when a deployed change causes a material regression in:

- end-to-end success
- reliability
- cost/latency beyond the accepted envelope
- tool safety/integrity
- output validity

Production observations may generate hypotheses for the next evolution cycle, but do not hot-patch the harness from a single failure.

# Part VI — Autonomous operating loop

Use this as the high-level self-improvement controller:

```text
initialize H0
measure baseline repeatedly -> delta
set Ht = H0
set S_best = reliable_score(H0)

for round in bounded_horizon:
    traces = run(Ht, evolve_set)
    feedback = analyze_cross_task_failures(traces)

    budget = anneal_edit_budget(round)
    candidates = propose_edits(
        Ht,
        feedback,
        edit_history,
        budget,
        unexplored_components,
        prune_targets,
    )

    candidates = leakage_screen_shipped_diffs(candidates)

    for candidate in candidates:
        score, cost = evaluate(candidate, evolve_set)
        log(candidate, score, cost)
        mark admissible only if:
            score >= S_best - delta
            and complexity_is_justified(score, cost, delta)
            and domain_guards_pass(candidate)

    if any admissible candidate:
        Ht = best_admissible_candidate
        S_best = max(S_best, reliable_score(Ht))
        snapshot_for_rollback(Ht)
    else:
        keep Ht

    mark_unproductive_components_for_pruning()

periodically:
    audit Ht on protected held-out/OOD sets
    compare against H0 and previous release
    release only if transfer/reliability/cost envelope is acceptable
```

# Candidate record

Use this shape for every proposed atomic edit:

```yaml
round: 7
component: context_mgmt
hypothesis: "Old tool outputs are crowding out task state and causing late-stage errors."
failure_pattern_targeted: "context loss after long tool trajectories"
source_diff: "..."
expected_benefit: "better completion accuracy after long runs"
expected_cost_change: "lower context tokens"
risks:
  - "summary may omit a needed detail"
result:
  score_delta: null
  cost_delta: null
  accepted: null
  rejection_reason: null
```

# Harness review checklist

Before calling a harness “good,” verify:

### Runtime behavior
- required state is read before acting
- tools are selected and invoked correctly
- recurring failures have bounded recovery
- verification occurs before completion
- stop conditions and deliverables are explicit

### Context discipline
- task-specific procedures outrank broad personas
- standing instructions are minimal
- large guidance is retrieved only when relevant
- stale outputs are summarized/dropped
- context headroom remains for execution

### Architecture
- components are independently editable
- deterministic requirements live in code/control flow where feasible
- skills/memory/subagents have clear purposes
- output plumbing validates artifacts

### Evolution discipline
- baseline and noise are measured
- each edit has a hypothesis and attributable diff
- rejected edits remain in history
- edit bundles shrink over time
- underexplored components are tried when stalled
- leakage is screened before scoring
- cost grows only with justified gain
- stale components are pruned
- rollback is possible

### Evaluation
- failures stay in the denominator
- reliability, correctness, and resource use are separate metrics
- held-out/OOD data is protected from tuning
- release decisions prioritize transfer, not evolve-set leaderboard gain

# Anti-patterns

Avoid:

- giant always-on profession/persona prompts
- self-improvement that only rewrites prompts
- benchmark/rubric text leaking into the shipped harness
- changing many unrelated mechanisms at once
- selecting the single highest noisy score
- keeping every historical addition forever
- tuning thresholds on held-out/OOD results
- repeatedly resending static guidance that could be retrieved or cached
- dropping crashes or timeout runs from evaluation
- reducing cost by accepting a meaningful success regression
- hot-patching from one anecdotal failure without evaluation
- allowing the harness to rewrite its evaluator, protected tests, permissions, or safety boundaries

# Definition of done

A self-improvement cycle is complete when:

- the incumbent is versioned and rollbackable
- accepted changes have attributable hypotheses and measured outcomes
- no shipped diff contains evolve-set specifics
- performance clears the noise-aware floor
- added cost is justified
- unnecessary context/components have been pruned
- protected transfer evaluation does not show unacceptable regression
- runtime metrics and failures are reported consistently

## Compact policy

**Observe → diagnose → propose sparse edits → screen → evaluate → promote conservatively → prune → audit transfer → repeat.**

And for context:

**If guidance does not change the next action, check, tool choice, or completion criterion, do not load it.**
