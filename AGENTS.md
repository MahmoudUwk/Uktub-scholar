# AGENTS.md — working rules for this repository

For coding agents and human contributors working on `uktub-scholar`.

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
  nested projects are refused). The bibliography file is canonical; the SQLite
  registry is a derived, agent-side cache with one-way `sync-bib`.
- **Sandboxing is opt-in.** The Docker wrapper exists for isolation when wanted;
  plain `pi` on the host is a first-class way to run. When the wrapper runs, it
  binds the project directory and a persistent host sessions directory so
  transcripts survive container exits.
- **A UI layer may enforce more later** (aimed at non-technical users). Any such
  enforcement lives above the package, never inside it.

## Engineering rules

- Minimal implementations; no abstraction without a second concrete consumer.
- Harness wording (skill text, tool descriptions, refusal hints) changes only
  after a real session shows a failure — never to make our own tests pass
  (tests pin contracts for hosts; they are not the customer).
- Every schema field needs a named consumer; every input limit names its source.
- Registry schema changes bump `PRAGMA user_version`; never silently rewrite a
  foreign or newer database.
- Tests run fully offline (provider fakes); `pnpm test` must stay green before
  any push.
- Provenance of borrowed methods is recorded in `NOTICE.md`.
