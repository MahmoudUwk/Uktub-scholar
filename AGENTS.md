# AGENTS.md — working rules for this repository

For coding agents and human contributors working on `uktub-scholar`.

## Start here

- `README.md`: installation, tools, CLI, configuration and limits.
- `docs/VISION.md`: scope; `docs/DECISIONS.md`: rationale.
- `docs/BACKLOG.md`: deferred work; `docs/review-2026-10-04.md`: independent review evidence and verification record.
- `docs/plans/`: dated plans with acceptance cases (history, not the current contract).
- `src/core/`: host-independent domain code; `src/pi/` and `src/cli/`: adapters.
- `benchmarks/`: dataset/protocol; `docs/benchmarks/`: measured evidence.

Keep current usage in README, decisions in DECISIONS, and open work in BACKLOG.
Do not duplicate these ledgers or treat historical plans as current contracts.

## Product stance (binding)

- **The CLI/TUI user is technical and trusted.** We provide conventions, not
  custody: the user manages git, backups, folder layout, and environment
  themselves. The package must never fight their choices.
- **Conventions are advisory; contracts are minimal.** Only two things are
  tool-owned: `.registry/registry.db` and `refs/references.bib` (agent read-only,
  human writable). Everything else — `manuscript/`, git, build tooling — is the
  user's.
- **No parallel stores, no global index.** Pi owns sessions (cwd-keyed). The
  filesystem is the only project index (one `.registry/` marker per tree;
  nested projects are refused). Registry operations render `refs/references.bib`
  from SQLite; `sync-bib` is one-way and never imports human bibliography edits.
- **Sandboxing is opt-in.** The Docker wrapper exists for isolation when wanted;
  plain `pi` on the host is a first-class way to run. When the wrapper runs, it
  binds the project directory and a persistent host sessions directory so
  transcripts survive container exits.
- **A UI layer may enforce more later** (aimed at non-technical users). Any such
  enforcement lives above the package, never inside it.

## Engineering rules

- Minimal implementations; no abstraction without a second concrete consumer.
- **Behavior first (TDD), every behavior change.** Write a deterministic behavioral test
  from the requirement. Run it against the current code and see the expected failure — an
  import error, a broken fixture or an unrelated exception is not a red result. Make the
  smallest correct change. Run the test again and see it pass. Cover boundaries, failure
  paths, state changes and provenance. Refactor on green. Do not weaken a test or add a
  special case to get green. A retrieval, parser or model change repeats the cycle for
  every affected contract. Documentation-only changes need factual review, not product tests.
- Test consumer-visible behavior — what a host, the CLI or the agent can observe — not
  source text, mock forwarding, incidental defaults or fixed tool counts.
  Detailed acceptance cases live in `docs/plans/`, not here.
- Harness wording (skill text, tool descriptions, refusal hints) changes only
  after a real session shows a failure — never to make our own tests pass
  (tests pin contracts for hosts; they are not the customer).
- Every schema field needs a named consumer; every input limit names its source
  (a provider/OS limit, or a labelled client policy).
- Registry schema changes bump `PRAGMA user_version`, migrate known versions explicitly
  (tested with genuine legacy fixtures), and never rewrite or even open-for-write a foreign
  or newer database.
- Source text never leaves the package through a tool response, error, progress message or
  detail (excerpts are bounded, verbatim and pointer-bound; see README). Fetching is
  HTTPS-only to public addresses with credentials scoped to their origin. OpenAlex is the
  only acquisition route; Unpaywall is forbidden.
- Tests run fully offline (provider fakes); `pnpm test` must stay green before
  any push. Experiments that need real models are separate, dated, and recorded in
  `docs/benchmarks/`.
- Provenance of borrowed methods is recorded in `NOTICE.md`.
- **Git: commit and push directly to `main` (owner decision 2026-10-04: the owner works alone).**
  No branches or PRs. Still stage reviewed paths only — never blanket-stage, reset or clean —
  and never stage `.mcp.json` or `opencode.json`. Run the checks below before pushing; a push
  does not deploy anything.
- Never read credentials from retired repositories. Offline tests must not spend provider
  quota; live provider calls belong in dated experiments and smokes, recorded in review documents.
- Verification defaults to the local Decision 2.0 Eos engine (owner decision 2026-10-04;
  needs a Python env with torch/transformers — README); OpenRouter Mercury and the other
  engines remain selectable.
  Model scores and benchmark rankings are evidence, not guarantees. There is no refutation
  verdict: no support found is not a finding that a claim is false. Document unsupported or
  unexercised paths honestly.
- Chunks are section chunks (default `boundary: section`, 512 tokens): one set serves `verify_claim` and
  `search_passages`, so a hit is always a unit the engine can read whole. The splitter (`src/core/sections.ts`)
  and heading detector (`src/core/source/headings.ts`) are property- and golden-tested; change them test
  first, and bump `SECTION_CHUNKING_VERSION` when their behavior changes so stored chunks rebuild. Passage
  search is keyword (FTS5) plus an optional embedding server (your own via `UKTUB_EMBED_URL`, or the managed
  pinned runtime installed with `uktub-scholar embed install --yes`; `models.lock.json` is the reviewed pin — change
  a digest only with a re-run parity gate); a missing or failing server degrades to keyword results and says so.
  A search never downloads anything. Do not edit `src/` or the schema while a benchmark
  that starts fresh processes is running (it once read a newer schema than its code).
- After behavioral changes, run `pnpm exec tsc --noEmit`, `pnpm test`, and an
  actual CLI/tool smoke. Record evidence once in review documentation, not fixed test
  counts throughout the docs.
