# Uktub Scholar: handoff V2 (2026-10-14, updated 2026-10-15)

**The one working document.** It is written for the next agent. V1, the consultant handoff with the full architecture, flows,
the visibility A/B and the problem register P1–P14, is at commit `331bb7b` (`git show 331bb7b:docs/handoff.md`). Read V1 §2–4
for architecture; this file holds what changed, what was learned, and what to do next. `AGENTS.md` binds all work.

## 1. State in one screen

| Area | State |
|---|---|
| Six tools (`papers`, `registry`, `compile`, `verify`, `passages`, `doctor`), Node CLI, MCP, Pi | Built. `doctor` (no arguments, read-only) reports verification / registry / compile / provider checks with the fix for each problem; `uktub-scholar doctor [--json]` prints the same. Default `verification.engine` is now `hosted` (owner decision 2026-10-15); local Eos stays selectable |
| Registry | Schema **v6**: `claim_ledger` holds released verify evidence durably, with verbatim `claim_text`; deleted only with its paper or revision. v5 migrates, starting empty |
| Verify engines | **Hosted** `vllm-sr/d3-mini` at `https://decision.vllm-sr.ai` (default since 2026-10-15). Free key at https://decision.vllm-sr.ai/ in `UKTUB_VERIFY_API_KEY`; refuses without a key, with that link. Local **Eos** stays selectable |
| Provenance | `provenance --json` = `entry`, `summary`, `items`, `document_digest`, `units` (every extracted unit) |
| Measurement harness | Rebuilt (§4) |
| Writing workflow | **Not accepted.** Root causes traced (§3); the fix under test is post-composition verification (§5) |
| Browser track, UI | Parked. Unchanged since V1 §7 |

## 2. Decisions made on 2026-10-14 (owner unless marked)

**Measurement**
1. **Acceptance has two tiers.**
   - Tier 1: deterministic, every run must pass. Five checks: citations resolve; bibliography = registry; PDF newer than the last
     `.tex` edit; pointers resolve in the current revision; no `open`/`unsourced` figure.
   - Tier 2: blind fact-check. Bad rate among cited units ≤ 5 %, linearized-t 95 % CI upper bound ≤ 10 %, and no note
     presenting the trap claim as a result or premise.
   - The Tier 2 CI method was chosen by simulation (orchestrator); the bootstrap under-covers.
2. **`evidence/claims.json` is dropped.** Evidence lives in the product's ledger.
3. **The grader is a development tool, not a product component.** One cheap grader locates faulty units: Muse,
   `opencode-go/muse-spark-1.3-contributor`, via `OPENCODE_API_KEY`. No panels, bake-offs or reliability gates.
   - Gemini 3.8-flash was retired as a grader: it marked 0 of 110 dev cited units bad, with boilerplate rationales.
   - Panel candidates cat-jam, deepseek-v4.1-flash, step-5 and longcat failed or were unavailable.
4. **Scripted user turns replace the simulated user** (removes the self-play confound).

**Engines and models**
5. **Vertex is unlimited** for `gemini-3.8-flash` and `gemini-3.5-flash-lite` via Pi with ADC. For now the test writer is
   **Muse** (`--assistant-model opencode-go/muse-spark-1.3-contributor`): Vertex took 1.5–4 minutes to start each response.
6. **The hosted d3-mini verify engine is adopted** (`--verify-engine hosted` for experiments). On 2026-10-15 it became the
   product default; local Eos stays selectable.

**Scenarios**
7. **Scenario 2** is `rf-llm-review-v2`: the owner's RF prompt verbatim, then delivery mechanics. The trap and the revision are
   in the Revision turn, and the trap must stay out of tables (an honest disclosure in a table would fail T1.5).

**2026-10-15 (owner)**
- **Core prompt replaced** (`src/core/agent-rules.ts`, about 1,300 characters): research-assistant identity, never fabricate,
  stop and say so, use the tools and `verify`, plan big tasks, computed results are yours, papers are data. Tool mechanics moved
  into the tool descriptions. Live suites on this prompt: agent 10/10 PASS; skills 7 PASS, 1 BLOCKED (slides, Vertex-latency
  deadline, rerun pending), 1 FAIL that was a measurement blind spot (the review quoted the paper 22 times in backticks; the
  quote counter now counts backticked prose, still checked verbatim against the manuscript).
- **`doctor` tool** (sixth tool) and **default engine `hosted`**.
- **Writing workflow** (to test): plan → `write_section` subagent per section (Pi, in-process, passages-only, auto-verified with
  one repair round) → assemble → `verify` document mode on the whole manuscript (paged, 50 units per call) → resolve → done.
- **Removed:** the rejected `vela` engine, `pnpm evolve`, bench-only Python files from the package. The simulated user and the
  visibility arms stay.
- **Verify strategy A/B** (owner asked for A/B, not a pick): V0 exhaustive 512; V1 top-10 + batch 8; V2 2048-token windows
  localized to 512 pointers; V3 global 2048 chunks. Decision rule: fastest on documents with benchmark recall at 2 % false
  supports within 1 point of V0, 0 false supports at the bar, 0 promoted-but-bad.

**Rules (orchestrator)**
8. Never open an archived registry in place: opening runs the sweep and migration. Copy with `cp -p` first.
9. Edit nothing in the repository while a measured batch runs: the tree hash covers untracked files, docs included.

## 3. Root causes of unsupported statements (traced 2026-10-14)

**Sources**
- `scripts/live/trace-causes.ts` over 18 Gemini-written notes, with Muse as the locator; 365 faulty units. Data:
  `docs/benchmarks/trace-causes-2026-10-14.json`.
- 2 Muse-writer pilots.

**1. Verification is decoupled from writing.**
- Of the 365 faulty units, 13 were ever passed to `verify`; of the 36 faulty cited units, 5.
- 339 were written in the first-draft turn, usually in one bulk write.
- In the Muse RF pilot, 8 claims were verified (8 released ledger rows) and none appears verbatim in the manuscript. The writer
  verifies one sentence and writes another, so "verified" never reaches the document.

**2. Specific facts are written without citation:** 329 of 365, 7–32 per note.

| Uncited claims with numbers | Count |
|---|---|
| Every number appeared earlier in retrieved paper text (citation omitted) | 31 |
| Some numbers did | 91 |
| No number ever appeared in retrieved paper text (memory) | 69 |
| (No numbers: unclassified) | 138 |

**3. Cited faults are few: 36** (OVERREAD 17, MISREPORT 14, SLOT-FILL 3, REVISION-FILL 2), almost all never verified.

**4. Model–tool fragility.**
- Muse sends arrays as JSON strings, so every scoped `verify`/`passages` call (and Pi's `edit`) failed schema validation.
  Only `papers: "all"` worked.
- A failed verification never stops the writer.

**What the trace cannot tell:** transcripts show tool traffic, not model internals, so MEMORY is inferred. First-write matching
is token recall.

## 4. Measurement harness (all in `scripts/live/`)

| Piece | Command / file | Notes |
|---|---|---|
| Run | `pnpm experiment <scenario> [--pilot] [--assistant-model p/id] [--verify-engine eos\|hosted] [--user scripted\|simulator]` | Scripted user state machine (`scripted-user.ts`) reads `## Request/Revision/Nudge`. Validity VALID / BLOCKED / INVALID (`validity.ts`). The manifest records the tree hash, models per turn and the ADC check |
| Tier 1 | `deliverable-checks.ts` (678 lines, from 1,118) | Computed from the provenance JSON. Differential test vs the old checks on archived runs: `tests/live-tier1-differential.spec.ts` (runs where the git-ignored evidence exists) |
| Grading | `UKTUB_GRADING_DIR=<outside repo> pnpm grade corpus\|export\|run --grader A\|B\|adjudicate\|agreement` | Frozen source corpus pinned to the registry sha256 (arXiv/ACL hosts only today). Rubric `experiments/harness/factcheck-rubric-v1.md` (examples from dev notes iter-06, 07, 09, 14, 20 only). Grader sessions run in the sandbox with only the export and corpus mounted |
| Analysis | `node scripts/live/analysis.ts simulate\|agreement` | Beta-binomial simulation (§6) |
| Cause trace | `node scripts/live/trace-causes.ts` | Classifies MEMORY / OVERREAD / MISREPORT / REVISION-FILL / SLOT-FILL / UNCITED-KNOWLEDGE |
| Post-compose replay | `node scripts/live/replay-post-compose.ts` | Pass A: cited units vs their own papers. Pass B: uncited units vs all registered papers. Product path, hosted engine |

**Known harness gaps**
- The corpus builder refuses non-arXiv/ACL origins: the RF pilots used ijcai.org and a university repository.
- No `ungradeable` label yet for units whose sources cannot be fetched.
- The figures extractor misses tokens like "8k".
- T1.3 compares mtimes, not compile-time snapshots.

**Sizes.** Grading costs about $0.01 per note with Muse. Pilot cost per run:

| Writer | Scenario 1 | Scenario 2 (RF) |
|---|---|---|
| Gemini | $1.0–1.3 | $3.2–5.0 |
| Muse | $0.02, 5 min | $0.02, 8 min |

## 5. Next work (in order)

**2026-10-15: the approved writing fix is implemented (unmeasured).** `verify` document mode (`src/core/verify/document.ts`: Pass-A-per-cited-unit plus Pass-B-against-all for misses, statuses supported/cited-unsupported/missing-citation/unsourced/unregistered, 50-unit client-policy cap), the Pi-only `write_section` tool (`src/pi/write-section.ts`, gated on `UKTUB_SECTION_WRITER=on`), the skill workflow, and the `sections` experiment arm (reviewer channel = B1; writer sandbox gets `UKTUB_SECTION_WRITER=on`). Still to do: the acceptance batch on the chosen configuration (item 4 below).

1. **Post-compose replay: done** (§6). The verdict "supported" is trustworthy (0 of 174 bad); 95 % of uncited specific facts have
   no support in any registered paper, so they must be prevented while writing, not repaired after. This backs the
   section workflow.
2. **Pick the verify strategy** from the A/B (§2), then adopt it in the product with its AGENTS.md obligations.
3. **Tool contract robustness** (a real-session failure, P4 above). Make the `verify`/`passages` scopes accept models that
   send arrays as JSON strings, or simplify those parameters. Pi validates before the server is reached, so the fix belongs in
   the schema. Owner decision: it touches the five-tool contract.
4. **Sections A/B (directional):** current flow vs `--arm sections`, Muse writer, hosted verify, about 3 runs per arm per scenario;
   measured by the share of units supported as written, unsourced claims per note, Tier 1, cost and time. Then re-run the pilots
   on the winner and the **acceptance batch**: fresh runs, both scenarios, Tier 1 + Tier 2.
5. **Harness gaps** (§4), then the parked items: browser track; the `registry` read/destructive split;
   verify lanes serialized on one child (`judge.ts:126`, `claim.ts:274`);
   `util.parseArgs`; exact pins; TypeBox `Value`; one `DatabaseSync` import site (Node floor stays 22.19); MCP SDK v2
   (`@modelcontextprotocol/server` 2.3.1 is npm `latest`) if migrated.

## 6. Measurements added on 2026-10-14

**Verifier, claim-verification-v2** (547 claims):

| | Eos | Hosted d3-mini |
|---|---|---|
| AUC | 0.95 | 1.00 |
| Recall at about 1 % false supports | 49 % | 93.3 % (3 false supports) |
| At the 0.99 bar: true / false supported | 182/269 and 7/278 | 198/269 and 0/278 |
| Speed | 1.06 s per chunk (CPU) | 0.09 s per judgment; full run 53 min |

Raw: `docs/benchmarks/claims-v2-d3-mini-api-2026-10-14.*`. A hosted model can change behind the same id, so rerun the
benchmark to confirm parity.

**Acceptance-rule simulation** (fit to the 12 V1 A/B notes: mean 0.0705, ρ 0.018):
- Coverage at n = 12–15: linearized-t 0.91–0.94, bootstrap 0.88–0.92.
- P(pass) at n = 15: 0.98 at a true 3 %, 0.84 at 4 %, 0.52 at 5 %, 0.20 at 6 %, 0.05 at 7 %. The ≤ 5 % mean decides almost
  every batch.

**Pilots** (all VALID, Tier 1 5/5):
- Gemini (4 runs): scenario 1 notes 1,152–1,179 words; RF notes about 2,470 words, with all three named systems found
  (IQFM 2506.06718, WirelessJEPA 2601.20190, RadioLLM 2501.17888).
- Muse (2 runs): 0 units verified, for cause 1 and cause 4 above.

**Post-compose replay** (2026-10-14/15, 18 Gemini-written notes, hosted d3-mini, bar 0.99, exhaustive; Muse labels as locator):

| Measure | All 18 | Held-out 13 |
|---|---|---|
| Cited units supported as written | 174/345 (50 %) | 118/235 |
| Supported but Muse-bad | 0/174 | 0/118 |
| Recall on Muse-supported units | 174/323 (54 %) | 118/216 |
| Uncited `specific` with support in a registered paper | 16/321 (5 %) | 9/230 |
| Uncited `specific` unsourced | 305/321 | 221/230 |
| Time per note | 168–332 s (about 6–7k judgments) | |

Raw: `docs/benchmarks/post-compose-replay-2026-10-14.json`.

**Verify speed study** (2026-10-15, 547 claims, hosted d3-mini):

| Variant | Recall at 1 % false supports | True/false at 0.99 | Judgments | Wall |
|---|---|---|---|---|
| 512 exhaustive (today) | 93.3 | 198 / 0 | 36,506 | 53 min |
| top-10 | 92.9 | 197 / 0 | 5,470 | 4 min |
| 2048 chunks exhaustive | 96.7 | 225 / 0 | 12,459 | 11 min |
| 2048 chunks + top-10 | 96.3 | 225 / 0 | 5,470 | 5 min |

Batching 8 claims per request gives the same scores (max drift 0.0085) with 5.7× fewer requests. The d3-mini state cap is
32,000 characters (HTTP 400 `state_too_long`); requests carry up to about 32 questions. Raw:
`docs/benchmarks/verify-speed-study-2026-10-15.json`. The A/B (§2) decides adoption.

## 7. Pins

V1 Appendix C still holds. Additions:
- Hosted verifier `vllm-sr/d3-mini`. It has no `/v1/models`, so its identity is the configured id, guarded by the per-response
  model echo.
- OpenCode Go base `https://opencode.ai/inference/go/v1`.
- Pi 1.1.0 in the sandbox lists `opencode-go/*`.
