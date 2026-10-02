# Decision log

Verdicts on design proposals, newest first. A falsified proposal is never
re-proposed without new evidence (RRSI discipline: the edit history exists so
dead hypotheses are not redrawn). Entries record the verdict, the reason, and
the evidence that would reopen the question.

## 2026-10-02

- **Sandbox-by-default for agent sessions — REJECTED.** Opt-in stays. Evidence:
  Gemini CLI, Aider, and Pi all default sandbox off; default-on frameworks
  (Codex, OpenHands) pair it with approval ladders that belong to the host
  (Pi), not to a package. Reopen only if a real session shows unisolated
  agents harming users at scale.
- **Parallel/persistent wrapper session store — REJECTED as a *new* store;
  KEPT as a bind of Pi's store.** Pi owns sessions (cwd-keyed); the sandbox
  mounts a host directory for Pi's own store so transcripts survive container
  exits. Dropping it would destroy researcher transcripts — more restriction,
  not less. Reopen only if Pi changes its session model.
- **Global project index — REJECTED.** Filesystem scan is the maintained
  pattern (DVC up-scan, Quarto marker); global-DB registries couple projects
  (Zotero's lesson). Nested projects are refused by `init`.
- **Two-way references.bib sync — REJECTED, permanently.** A .bib carries no
  merge semantics; the registry is the source of truth, `sync-bib` renders
  one-way (Better BibTeX maintainer's argument applies verbatim). Reopen only
  if a maintained standard adds merge metadata to BibTeX.
- **Bundling a LaTeX engine — REJECTED.** The engine is the user's (PATH or
  `UKTUB_TECTONIC_BIN`); the package owns detection, invocation, outdir, and
  diagnostics. The sandbox image pins Tectonic 0.15.0 for zero-install
  sandbox use. Reopen only if optionalDependencies distribution proves
  painless and users ask for it.
- **Trust model — ADOPTED.** The CLI/TUI user is technical and trusted;
  conventions over enforcement; a future UI layer may enforce more for
  non-technical users, above the package, never inside it.
