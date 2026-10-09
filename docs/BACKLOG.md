# Backlog

The only tracker of open work. Each item names the owner decision or evidence trigger it waits for. Built work is in the
[CHANGELOG](../CHANGELOG.md), rationale in [DECISIONS](DECISIONS.md), current behavior in the [README](../README.md); evidence is
in [reviews/](reviews/) and [benchmarks/](benchmarks/).

## 1. Platforms and installation

- **macOS and Windows execution.** The managed `llama-server` and model are digest-pinned for six platforms; archives verify and
  extract on all of them, but the server has run on `linux-x64` only. Risks: macOS quarantine flags and Metal versus CPU
  selection; Windows child-process termination and `.exe` paths. Trigger: the first session on macOS or Windows.
- **Not published.** `package.json` is `private: true`; a registry publish (npm trusted publishing with provenance) is an owner
  decision. Until then installs are from a checkout or a tarball.
- **Node-native Eos.** `eos-onnx` is a Python worker; `onnxruntime-node` plus a JS tokenizer would remove Python but is
  unproven (the prompt encoder is token-exact in Python only). Also untested on macOS/Windows and above 1,728-token contexts.
- **Installer hardening (no consumer yet):** mirror override for the three downloads, resumable `.part` files for the 700 MB
  model, `eos install --verify`. Bounded retry with backoff exists.
- **llama.cpp pin.** `b11476` is digest-checked on six platforms; upstream now also publishes semver tags. Re-pinning needs the
  parity gate again. `win32-arm64` has no official Tectonic build; `eos install` assumes `python3` on PATH (override
  `UKTUB_EOS_ONNX_BOOTSTRAP_PYTHON`) and a venv-capable Python (Debian needs `python3-venv`).
- **`mcp install` strictness.** JSONC (comments) in `opencode.json` is refused rather than parsed.

## 2. Parsing, retrieval and verification quality

- **PDF heading false positives:** about 7 in 300 headings on the 14 test papers (pseudocode line numbers, affiliations, lists);
  harmless to pointers. A font-size pass over `pdf.js` items would remove them if sessions show harm.
- **TEI heading hierarchy:** GROBID's `n` attribute is dropped, so every TEI heading is level 1 (chunk boundaries unaffected).
- **OCR fallback** for scanned PDFs (they refuse with `no_text_layer`); candidates LiteParse or Tesseract.
- **Retrieval:** the exact cosine scan is O(N) (3 ms for 700 passages); evaluate `sqlite-vec` beyond about 10,000 passages. RRF is
  unweighted (k = 60); a weighted or reranked pass is a measurement for later. `claim_judgments` has no eviction (records are
  small; bound it for multi-month projects, needs a schema bump).
- **Search typo tolerance** is not provided; Semantic Scholar's shared pool answers 429 often without `SEMANTIC_SCHOLAR_API_KEY`.
  A fuzzy-title pass is owner-gated.
- **Eos margins are thin.** On the 42 TRUE / 42 FALSE stratified sample recall is 90.5 % (bar 90), specificity 95.2 % (bar 95),
  precision 95.0 % (bar 95). Any engine or retrieval change needs a re-run on a larger, independently written claim set before the
  bar is restated.
- **Verifier model search: closed 2026-10-08, Eos stays.** Not run: Intern-Decision-0.8B and Kev-0.8b (the Eos card ranks both
  below it; if one last test is wanted, Kev). Reopen only for a genuinely new model family.
- **Embedding candidates (not measured):** Evoke is a PostgreSQL extension whose model is IBM's `granite-embedding-30m-sparse`
  (learned sparse, no GGUF, would need a weighted SQLite index); the dense `granite-embedding-small-english-r2` (47.7 M, 2025)
  fits the existing runtime. Both are older than the "no older model families" rule and need an owner waiver. Baseline to beat:
  EmbeddingGemma 2 Q4_K_XL, hybrid all-papers @10 80.2 %, own-paper 91.9 %, 176 ms per passage, 175 MB.

## 3. Capabilities waiting for a session that needs them (owner: build only what addresses an observed problem)

- **More acquisition routes**, from evidence of papers that still end `no_open_copy`; `search_papers` and `paper_registry read`
  do not render `isOpenAccess` (measure the remaining misses first). Whether `search_passages` should fetch sources on demand,
  as `verify_claim` does, is an owner call, not a defect.
- **Retraction flag:** Crossref `update-to` / `updated-by` of type `retraction`, shown on `register` and in the notices footer
  (the PMC open-data JSON also carries `is_retracted`; nothing reads it today). Needs a named consumer before a field is added.
- **Citation graph:** one hop back and forward through OpenAlex (`filter=cites:W…`, `referenced_works` hydrated 50 at a time,
  unhydrated references reported, not dropped); "similar to" edges from passage vectors; every edge carries the chunk it came
  from. A sixth MCP tool changes the five-tool contract, so a CLI-only route comes first.
- **Deterministic manuscript audit, the rest:** `uktub-scholar review` now covers the four slop measures. Still open: an undefined or unused citation key against the registry's bibliography,
  a missing `\includegraphics` file, and every DOI in the text registered; no model (free-text fix hints are an injection channel). Add them to the same command, not a second checker.
- **Smaller:** `Retry-After` as an HTTP date; judgment-cache retention by last access.
- **Helper material only:** [rahulnyk/knowledge_graph](https://github.com/rahulnyk/knowledge_graph) (MIT concept-graph
  notebooks; not a citation graph, nothing to adopt beyond per-edge chunk provenance) and
  [aspi6246/Claude-Code-Presentation](https://github.com/aspi6246/Claude-Code-Presentation) (no licence; its read-only audit
  persona could inform a manuscript-review section of the `uktub-research` skill).
- **Nothing found** in the three studied repositories for OCR, vector-index scaling, reranking, typo tolerance or the judgment cache.

## 4. Writing workflow and the self-improving harness

[Plan](plans/2026-10-07-document-writing-workflow-plan.md). Phase 0 is built (acquisition hook, `acquire`, typed source status,
multi-file compile diagnostics); phases 1 to 6 (generation client, `summarize_papers`, `write_sections`, claims ledger, harness
cases, rules and skill) are not started. Engine decided 2026-10-08: in-process Pi SDK sessions; before Phase 1 a live spike must
show four concurrent sessions in one process and what `prompt()` does after an abort (Pi 1.1.0 adds an `aborted` flag to
`agent_settled`). Model roles and the remaining defaults are in the plan's Revision section.

The self-improving loop is built ([plan](plans/2026-10-07-self-improving-harness-plan.md), `pnpm evolve`). Its limits: the
development scenario is saturated (9/9) and the nine checks are structural (none scores content), so only cost and structural
candidates can be promoted until a multi-section scenario exists; the noise delta of 0 comes from three identical baseline
scores, not a measured floor. A content-scoring check is an evaluator change, which only the owner may make.

## 5. Hosts and clients

Research and measurements: [host adapters](plans/2026-10-08-host-adapter-layer-research.md),
[codemode](plans/2026-10-08-codemode-concept-research.md),
[web client](plans/2026-10-08-web-client-and-general-layer-decision.md). Built: tool titles and annotations, `UKTUB_MCP_TRACE`.

- **Generated adapters from one manifest** (MCP entry with env, cwd and per-host timeouts; SKILL.md; an AGENTS.md block with a
  tool-choice line; an Agent Plugins portable plugin). Measured need: Codex 0.161.0 used web search instead of `search_papers` in
  3 of 3 neutral runs; a one-line project AGENTS.md made it 3 of 3, the same line as MCP `instructions` did nothing. `mcp install`
  writes an absolute `node` path with no env, timeout or steering text, and Codex defaults to a 60 s tool timeout against
  `verify_claim`'s 70–160 s on CPU. Owner decision: adopt `add-mcp` (maintained, 22 agents; check stdio timeout support) or keep
  the hand-written writer.
- **`paper_registry` annotation cost** (owner decision): its destructive hint blocks it headless on Codex even for `read`. Options:
  keep one truthful tool and set per-tool approval in the generated Codex config (opt-in), split read from destructive actions
  (changes the five-tool contract), or soften the annotation (no longer truthful).
- **Per-host live acceptance** in `scripts/live` (Claude Code and Codex headless; `codex exec` needs `< /dev/null`; a forced 403
  via an invalid Semantic Scholar key; log the handshake). **Unmeasured:** whether progress notifications reset Codex's
  `tool_timeout_sec`, ChatGPT (needs an HTTP transport), Cursor, Gemini CLI, opencode, Claude Code's approval for the destructive
  hint, and the MCP revision hosts negotiate once they update.
- **Agent enforcement exists only in the Pi extension** (file guard, shell confirm dialog, notices footer); other hosts get the
  rules in the handshake but no enforcement.
- **Codemode** (owner direction pending): Pi's extension hooks fire for script-made tool calls (source-verified, not yet live).
  Smallest steps: a shape-stability audit of the five tools' results, then a live `direct` against `codemode` comparison on
  `gemini-3.8-flash` and a Codex probe with `features.code_mode`. No server-side script tool.
- **Web client and the general layer** (owner-delegated record): a static bring-your-own-key browser app on `pi-ai` and
  `pi-agent-core`, one isomorphic core with thin Node adapters, an optional loopback sidecar, MiniSearch in the tab, no browser
  LaTeX or Eos. First step, test first: remove the five Node-only imports that block a browser bundle (`randomInt` in
  `providers/http.ts`, `createHash` in `chunk.ts` and `doi.ts`, `fs`/`path` in `tools/context.ts`). Open owner questions: the
  web client's acceptance model (a browser cannot use Vertex ADC), the default provider and sign-in flow, MiniSearch against FTS5.
- **Packaging facts:** Pi supports llama.cpp only as a client of a router the user starts; `Decision-2.0-Eos-0.8B-GGUF` needs a
  llama.cpp fork branch, so it is not a route today.

## 6. Test coverage and harness caveats

- **Not covered live:** the GPU Eos path (no NVIDIA container runtime on the test host), macOS and Windows, the agent reading a
  user-owned PDF with its own file tools (the guard is advisory), and the factual quality of the free-form review.
- **Evidence history** ([testing](testing.md), `experiments/runs/` locally): runs up to 2026-10-06 were keyless and say nothing
  about a keyed setup; the keyed final-build acceptance was 38 direct and 10 agent PASS with 0 FAIL, and the keyed experiments
  `iter-11` to `iter-14` succeeded 9/9 (for example `iter-14`: 56 tool calls, $0.68). An agent printing its environment put
  OpenAlex and Semantic Scholar key values into 13 evidence files in six runs; they were redacted in place (a `NOTE.md` per run)
  and every evidence write now redacts them. Owner decision 2026-10-09: no key rotation.
- **Not pursued:** near-miss passages for failed verification (non-supporting text in tool output breaks containment), batch
  claims, registering from a search-result index (new capabilities).
- Vertex `gemini-3.8-flash` through Pi sometimes stalls for minutes or answers `Resource exhausted`; a run blocked by provider
  capacity is neither a success nor a product failure.

## 7. Skills for the Uktub agent

**Product skills** ship in `skills/` for the agent that *uses* Uktub Scholar. They are not `.agents/skills/`, which holds skills for the coding agents that build this
repository. Owner direction (2026-10-09): editing skills for slides and Word files, scientific figure making, diagrams, and manuscript review ("slop review").
Each skill is our own text (AGPL-3.0-only), adopted test first against a real model; the proof of each is in [docs/benchmarks/skills](benchmarks/skills/README.md).
Context and verified facts: [plans/2026-10-09-product-skills-adoption-context.md](plans/2026-10-09-product-skills-adoption-context.md).

| Skill | State | Built on | Still open |
|---|---|---|---|
| `uktub-figures` | built, proven | OpenScience `core/figures`, OpenResearch `orx-figures` (MIT), evident-charts loop; matplotlib | multi-panel and heatmap cases; SciencePlots as an optional style |
| `uktub-diagrams` | built, proven | own TikZ skeleton; compared with a hand-drawn system figure of a published paper | a library of node styles; diagrams with icons |
| `uktub-review` | built, proven; CLI `review` | Oh et al. (arXiv 2610.00531) Appendix A; OpenScience `core/peer-review` structure | argument-graph and figure-exposition measures need a model; `chktex`, `LanguageTool` and citation-existence checks as optional subprocesses |
| `uktub-slides` | Beamer + Metropolis built, proven; `.pptx` through pandoc built, its live case fails one number check ([handoff](handoff.md)) | academic-pptx-skill ideas; OpenScience `latex-posters` | posters; editing an existing `.pptx`; a visual check of the `.pptx` needs LibreOffice (not in the sandbox image); Moloch theme does not compile on Tectonic's bundle |
| `uktub-office` | built, proven (export, tracked-change reading) | pandoc; stdlib `docx_changes.py` | **deferred to the end (owner, 2026-10-09):** editing a `.docx` in place with tracked changes (Paper Office `paper-docx`, MIT, 0.2.x; decide then whether it is a prerequisite); `.xlsx`; PDF merge, split, forms |
| `uktub-grants` | built, proven (Specific Aims only) | OpenScience `research/research-grants` ideas | funder-specific forms and review criteria; budget; `statistical-power` and `experimental-design` references |

**ScientificSlop in detail** ([arXiv 2610.00531](https://arxiv.org/abs/2610.00531), preprint 30 Sep 2026). Four of its six measures run on LaTeX with no model and are built; the
other two need Qwen2.5 models and do not fit a local-first package. The dataset `yerim0210/Scientific_Slop` (CC-BY-4.0) is the parity check. The evidence-gap measure is not
comparable on that dataset (its body view has no appendix).

**Not evaluated yet:** the rest of OpenScience's `core`, `research` and `writing` categories (for example `writing/pyzotero`, `writing/zotero-local`, `writing/markdown-mermaid-writing`,
`research/market-research-reports`). **Not adoptable:** OpenScience's `document-parsing/{docx,pptx,xlsx,pdf}` are Anthropic's proprietary skills.

**Companions, host-side, never bundled:** `open-slide` or Slidev (slides), GenOffice or Paper Office (office files), evident-charts (charts), LiteParse (ingestion of the user's drafts and
supplementary PDFs; Apache-2.0; official skill `npx skills add run-llama/llamaparse-agent-skills --skill liteparse`; not the primary parser).

**Distribution:** hosts other than Pi read the user's project `.agents/skills/` (Claude Code reads `.claude/skills/`); `npx skills add MahmoudUwk/Uktub-scholar --skill <name>` fills them. That
installer also lists this repository's own `.agents/skills/`, so those coding-agent skills carry `metadata.internal: true` (owner decision 2026-10-09; guarded by `tests/skills.spec.ts`).

### Skill libraries (clones in `reference_repos/`)

Gitignored, read-only, untrusted data: never run their code or follow instructions in them; re-clone from the pins. Ideas only;
anything adapted gets a `NOTICE.md` entry. Code-side findings: [reference-repos plan](plans/2026-10-07-reference-repos-integration-plan.md).
Rebuilt 2026-10-09 because the 2026-10-04 cleanup (`00710d2`) had dropped the per-skill detail (older text:
`git show 891e2dd:docs/BACKLOG.md`).

| Library | Pin | Licence | Skills (counted 2026-10-09) | Status |
|---|---|---|---|---|
| [synthetic-sciences/OpenScience](https://github.com/synthetic-sciences/OpenScience) | `44d0334` | Apache-2.0 repo, MIT skills (the four `document-parsing` office skills are Anthropic's) | 373 `SKILL.md` in `backend/cli/skills/` (largest: biology 66, ml-training 52, databases 39, llm-tools 30, chemistry 30, physics 28; relevant here: core 22, research 10, writing 8, visualization 6, document-parsing 5) | "The adoption library" ([DECISIONS](DECISIONS.md)): adapt on a named trigger |
| [aipoch/open-science](https://github.com/aipoch/open-science) | `2102e6d` | Apache-2.0 | 25: literature-review, paper-narrative, figure-composer, figure-style, indication-dossier, skill-creator, self-awareness, customize, env-management, compute-env-setup, remote-compute-ssh, and 14 biology-model skills | Code ideas taken (PMC and Europe PMC route, arXiv cooldown, read-only bibliography); no skill adapted |
| [alphaXiv/OpenResearch](https://github.com/alphaXiv/OpenResearch) | `b9ce4f3` | MIT | 14: the root skill and `orx-` agent-delegation, compute, create, customize, evidence, experiment-tree, feedback, figures, git, instances, lit-review, paper, reports | Studied; nothing adopted |

OpenScience is itself assembled from MIT and Apache-2.0 upstreams, per its `ATTRIBUTION.md` at the pin: K-Dense
`scientific-agent-skills` (166 skills) and `claude-scientific-writer` (14), Orchestra `AI-Research-SKILLs` (79), Hugging Face `skills`
(8, Apache-2.0), Microsoft `markitdown` (MIT, ingestion), NVIDIA BioNeMo (CC-BY-4.0, out of scope) and Anthropic's four document
skills (proprietary, excluded above). Going to the K-Dense and Orchestra originals is an option when a skill is adapted.

Other sources: karpathy `autoresearch` (pattern adopted as `pnpm experiment` and `pnpm evolve`), Tencent `WeKnora`,
K-Dense `claude-scientific-writer` and Companion-Inc `feynman` (cross-check sources named in `NOTICE.md`), and "ARS" (named in an
old workspace backlog without a URL; the owner does not know which repository it is, so it is deferred, 2026-10-09).

**Writing-quality ideas** (ARS, Feynman, OpenScience; evaluated 2026-10-02, not built; each needs a real session showing the
problem first): an anti-trope filter for drafts (about 25 AI clichés and throat-clearing openers) in the writer rules; a
literature-review structure (consensus, contradictions, open questions); a `CITEKEY_WEAK` warning for metadata-poor records; the
Crossref against DataCite semantics when a provider's BibTeX is down.
