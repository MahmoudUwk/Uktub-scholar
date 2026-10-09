# uktub-scholar

Free, open-source (AGPL-3.0-only), local-first scholarly tools for coding agents: paper search, a paper registry with a rendered
bibliography, LaTeX compilation, passage search over the registered papers' full text, and supporting-evidence retrieval for a
claim. One Model Context Protocol (MCP) server over stdio serves Claude Code, Pi, Cursor, Codex, OpenCode and Antigravity; a Pi
package and a CLI use the same host-independent core. No accounts, no hosted service: everything runs in your project folder, with
your own provider keys ([vision](docs/VISION.md)).

[AGENTS.md](AGENTS.md) contributor rules · [CHANGELOG](CHANGELOG.md) · [VISION](docs/VISION.md) · [DECISIONS](docs/DECISIONS.md) ·
[BACKLOG](docs/BACKLOG.md) · [handoff](docs/handoff.md) · [testing](docs/testing.md) · [benchmarks](benchmarks/README.md) ·
[research skill](skills/uktub-research/SKILL.md)

## Install and host setup

Requires Node >= 22.19.

```sh
pnpm install     # also builds dist/ (the `prepare` script): the Pi package loads the compiled extension
```

A checkout runs `src/` directly; an installed copy ships compiled `dist/` (Node refuses to type-strip files under
`node_modules`). `mcp install` writes `node <absolute path of this copy's bin> mcp` into the host's config, so no PATH setup is
needed. Run it from your research project, per host:

```sh
pnpm exec uktub-scholar mcp install --host claude    # .mcp.json
pnpm exec uktub-scholar mcp install --host pi        # .mcp.json (or: pi install /path/to/Uktub-scholar)
pnpm exec uktub-scholar mcp install --host cursor    # .cursor/mcp.json
pnpm exec uktub-scholar mcp install --host codex     # .codex/config.toml
pnpm exec uktub-scholar mcp install --host opencode  # opencode.json
pnpm exec uktub-scholar mcp install --host agy       # .agents/mcp_config.json (Antigravity)
pnpm exec uktub-scholar mcp [target-dir]             # or run the stdio server directly
```

**Pi package** (`pi install /path/to/Uktub-scholar`): registers the MCP server, loads the `uktub-research` skill, adds the agent
rules to Pi's system prompt, and blocks the agent's `edit`/`write` on `refs/references.bib` and `.registry/` (agent read-only,
human writable; a shell is not blocked, but a destructive shell command touching them asks the human first). It appends a "Tool
notices" footer with any refusal, warning, interruption or registry change the final answer left out, and the server sends
progress heartbeats so a host's request timeout does not kill a long call. To try the package without touching your own Pi, use
`pnpm sandbox` (below).

**LaTeX.** Compilation needs [Tectonic](https://tectonic-typesetting.github.io) >= 0.15.0: your own on `PATH` or at
`UKTUB_TECTONIC_BIN` (both win), else a managed copy from `uktub-scholar tectonic install --yes` (pinned 0.17.0, sha256-verified,
about 10 MB, shared cache). Nothing downloads unless you run that command; Tectonic fetches its TeX bundle on first compile.

Run `uktub-scholar init` in the research project to create `.registry/registry.db` and `refs/references.bib`. Nested projects are
refused. You own layout, LaTeX sources, git, backups and toolchains.

## The five tools

Exposed over MCP (`tools/list`, `tools/call`), through the Pi package and via the CLI, under bare names or host-namespaced ones
(`mcp__uktub_scholar__search_papers`, `uktub-scholar/search_papers`).

| Tool | Behavior and limits |
|---|---|
| `search_papers(query, limit?)` | OpenAlex, Crossref and Semantic Scholar merged by RRF; default 5, maximum 20 |
| `paper_registry(action, …)` | Register, remove, read, attach a source, sync the bibliography, acquire sources |
| `compile_document(entry?)` | Local Tectonic, PDF in `build/`; 120 s budget, at most 50 diagnostics |
| `verify_claim(claim, papers \| passages, query?, continuation?)` | Supporting passages for one claim, with coverage |
| `search_passages(query, papers?, limit?)` | Best-matching passages of the registered papers (section, page, pointer, excerpt) |

Caps are client policies unless a source is named. Provider failures in search become warnings; all providers failing refuses
with `SEARCH_UNAVAILABLE`. Optional keys, read at call time: `OPENALEX_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY` (without it Semantic
Scholar's shared pool often answers 429), `CROSSREF_MAILTO`. DataCite resolves arXiv DOIs at registration. `compile_document`
entry defaults to `manuscript/main.tex`, then `main.tex`, then a lone top-level `.tex`; ambiguity needs an explicit entry; a
missing Tectonic refuses compilation only.

### `paper_registry`

| `action` | Input | Result |
|---|---|---|
| `register` | `identifiers[]` (≤ 50): DOIs in any common form, or `arxiv:YYMM.NNNNN` | One ordered outcome per input. Aliases of one paper register once (later ones report `duplicate`); a refresh keeps the pinned citekey and provider BibTeX; invalid or unknown inputs are refused per item |
| `remove` | `handles[]` (≤ 50): DOIs or citekeys | `removed` / `duplicate` / `absent` / `refused` per input, one transaction, bibliography re-rendered. There is no remove-all |
| `read` | optional `handles[]`, `fields[]`, `limit`, `cursor` | Citekey-ordered records. Default fields: DOI, citekey, title, year, citable. Optional: `authors`, `venue`, `bibtex`, `bibtexSource`, `abstract`, `source`, `refreshedAt`. A page holds ≤ 100 light rows or ≤ 25 with abstract or BibTeX; `cursor` continues the same request and is refused if the registry changed |
| `attach_source` | `attachments[]` (≤ 10): `{handle, path}` to a PDF or GROBID TEI inside the project | Source readiness, revision and counts. The file is neither copied nor deleted; its text is never returned |
| `sync_bibliography` | none | Re-renders `refs/references.bib` from the registry (human edits are not imported). The file is written read-only (0444); the next registry write replaces it, and a human who wants to edit it makes it writable on purpose |
| `acquire` | `handles` (omit for every paper without a source) | Fetches an open-access source (see Sources); a typed status per paper: `ready` (with its kind), `unavailable` or `failed` with code and reason, `deferred` (at most 20 per call; repeat), `absent` |

A paper without provider BibTeX registers as `citable: false` (`BIBTEX_UNAVAILABLE`); a later registration can upgrade it without
moving the citekey. Citekeys are never synthesized by the agent. Abstracts are the provider's own (at most 1,500 characters,
labelled with the provider); a missing abstract is stated, never invented.

### `verify_claim`

Give **one** claim (8–2,000 characters, passed to the verifier unchanged) and a scope: `papers: "all"` or an explicit list of
DOIs or citekeys (≤ 100; an empty list is refused, never read as all). The package prepares sources, selects passages, judges
them and returns only **supporting** passages, each with a verbatim excerpt and an exact pointer `doi@revision#start-end`
(zero-based, end-exclusive UTF-16 offsets into the captured text, page included when the extractor grounds it). Non-supporting
text never reaches the agent.

Four coverage reports stay apart, so success never implies the rest was checked: **sources** (which papers have a usable
captured source, and why the rest do not), **candidates** (exhaustive, or query-limited: an optional `query` only narrows which
passages are checked), **work** (passages judged, new or reused, and any interruption with the unchecked remainder) and
**output** (supporting records available against shown, and any withheld excerpt text).

A `continuation` token resumes unfinished checking and pages more evidence: repeat the same request with it. It names a stored
run (papers at their revisions, candidates, model identity, bar), is refused when any of those changed, and expires after 24
hours. Each evidence record is delivered once across pages; the first call's findings repeat on every page.

**No support found is not a finding that the claim is false.** The package never reports refutation. Scores are engine outputs
under a configured bar, not calibrated probabilities, and checking more passages can raise false supports.

A pointer is current only while its source revision is: a replaced source gets a new revision and old pointers resolve as stale.
Evidence is stored with the decision that produced it (model identity, protocol, bar). A judgment is reused only for the same
claim, passage, model identity and protocol; an engine that cannot report its model (a bare URL is not an identity) disables
reuse unless you declare one with `UKTUB_VERIFY_MODEL_ID`.

**Full-text containment** (a package output contract, for `verify_claim` and `search_passages` alike). Excerpts are verbatim and
at most 1,500 characters; a passage that is half or more of its source, or text beyond 25 % of one source across a run or call,
is withheld with its reason and the pointer kept. This stops support from becoming a full-text export through the package's own
responses; it does not stop an agent with host filesystem access from reading a user-owned PDF.

Direct path (rare): `passages: [{source: pointer} | {text}]` judges exactly those passages (≤ 8). A `source` must be a pointer
this package issued within the last 24 hours and is checked against its current revision; `text` carries no authenticated paper
provenance and can never claim a DOI.

### `search_passages`

Retrieval for the writing agent: describe a topic, question or phrase and get the best-matching passages of the registered
papers: paper, **section heading**, page, an exact pointer and a verbatim excerpt. They are the same chunks `verify_claim` judges
(section chunks of at most 512 tokens, about 1,433 characters). At most 10 passages per call (default 5), best-ranked first under
the containment rule above. Results are retrieval, not verification: check a claim with `verify_claim` before citing it.

Search is BM25 over FTS5, and **hybrid when an embedding server is available** (BM25 and exact cosine fused with RRF, k = 60).
If the server is down or answers badly the call returns keyword results and says `vector search unavailable (…)`. Two ways to
have a server:

- **Managed runtime** (Linux, macOS, Windows; x64 and arm64): `uktub-scholar embed install --yes` downloads two pinned artifacts
  once into a shared cache (`UKTUB_CACHE_DIR`, default `~/.cache/uktub-scholar`, safe to delete), each verified against the sha256
  and size in [`models.lock.json`](src/core/embed/models.lock.json): the official [llama.cpp](https://github.com/ggml-org/llama.cpp)
  CPU build `b11476` for your platform (11–19 MB, MIT) and [EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2) in
  Q4_K_XL (176 MB, **Apache-2.0**; the `unsloth/embeddinggemma-2-GGUF` conversion pinned by commit; the installer shows the licence
  and requires `--yes`). Archives are extracted safely. After that `search_passages` starts `llama-server` on loopback as a
  supervised child (resident for the session, restarted if it dies, ended when the host exits, even on SIGKILL on POSIX); a search
  never downloads. `embed status` shows what is installed. Linux x64 is verified by running the server; the other five builds are
  digest-pinned and their archives verify and extract, but the servers have not run there ([BACKLOG](docs/BACKLOG.md)). A platform
  with no pin is refused with the instruction to run your own server.
- **Your own server**: any OpenAI-compatible `/v1/embeddings` endpoint, which wins over the managed runtime. Start `llama-server`
  with `--embeddings --pooling mean -c 2048 -b 2048 -ub 2048` (the default batch of 512 rejects a chunk of about 570 tokens) and
  use a GGUF converted **with** the sentence-transformers dense modules; the `ggml-org/embeddinggemma-300m-qat-q8_0-GGUF` file
  omits them and its vectors have cosine about 0.01 with the reference model. `scripts/embed-parity.py` is the parity gate.

Vectors are cached in the registry by passage content and served-model identity, so they are embedded once and never read for a
different model. A cold index embeds at most 256 passages per call (repeat the search to extend it).

### Sources

Registration stores metadata only. In a long-lived host (the MCP server) it then starts open-access acquisition in the background
(bounded, one acquisition per paper at a time, shared with `verify_claim` and `acquire`; `UKTUB_ACQUIRE_ON_REGISTER=0` turns it
off); `paper_registry read` with `source` shows `metadata_only`, `acquiring`, `ready`, `unavailable` or `failed`. `verify_claim`
also prepares sources on demand; `search_passages` does not. Any lawful open-access copy a provider record names is used, in this
order: OpenAlex `pdf_url` candidates; the arXiv PDF when the paper's DOI is an arXiv DOI or an open location is an arXiv page;
OpenAlex `oa_url`; the OpenAlex Content API (GROBID TEI, then PDF; **needs `OPENALEX_API_KEY`, about $0.01 per download**); only
if all of those give nothing, the PubMed Central open-data copy of the PMCID Europe PMC reports for the DOI (`pmc-pdf`, keyless,
with its licence) and Europe PMC's open-access PDF links on other hosts (`epmc-pdf`); then Semantic Scholar `openAccessPdf` and the
arXiv preprint named by its `externalIds.ArXiv`. A source from a preprint of a work published under another DOI is stored as
`arxiv-preprint-pdf`, and `verify_claim` says so (`preprint:` line): it may differ from the published version.

Guards: HTTPS only to public addresses (re-checked after every redirect, connection pinned to the checked address); credentials
scoped to the Content API origin; at most 64 MiB and 60 s per download; the extracted text must match the registered paper's
title or DOI; arXiv requests 3 s apart with a cooldown (60 s doubling to 10 min) after a 429 or 403; at most 20 papers per call
(never-attempted first, the rest `deferred`). Landing pages are never scraped and no URL is built from a title. PDFs go through
[`unpdf`](https://github.com/unjs/unpdf) and TEI through `fast-xml-parser` (DOCTYPE and entities refused); scanned PDFs have no
text layer and are refused. A "no open copy" answer is not looked up again for an hour, a failed acquisition not for a day. A
write that waits out the 5-second SQLite lock is refused as `REGISTRY_BUSY`.

Keyless acquisition works for papers with a direct `pdf_url`, an arXiv copy, or a Semantic Scholar open-access PDF or preprint.
When OpenAlex lists only a publisher landing page and no arXiv copy exists, use `attach_source` or set the key.

## CLI

`uktub-scholar` uses the same core functions as the MCP server and the Pi extension:

| Command | Does |
|---|---|
| `init` | Create the registry and an empty `refs/references.bib` |
| `register <id>...` / `deregister <doi\|citekey>...` | Add papers (DOI or `arxiv:ID`) / remove them |
| `attach <doi\|citekey> <file>` | Attach a local PDF or TEI inside the project as a paper's source |
| `list` / `sync-bib` | Print registered papers / re-render `refs/references.bib` |
| `compile [entry.tex]` | Compile with Tectonic into `build/` |
| `verify <claim> [--papers all\|<handle>,...] [--query <words>] [--continuation <token>]` | Supporting passages for one claim |
| `search <query> [--papers all\|<handle>,...] [--limit <n>]` | Passage search |
| `embed status` / `embed install --yes` | Managed embedding runtime |
| `eos status` / `eos install --yes [--gpu]` | Eos without PyTorch: a pinned ONNX export (about 700 MB) and a small Python environment (about 150 MB) |
| `tectonic status` / `tectonic install --yes` | Managed LaTeX engine |
| `mcp [dir]` / `mcp install [--host <name>]` | Run the stdio server / write host configuration |

## Configuration

Resolved on one path: the project's `config/chunking.yaml` (or the file named by `UKTUB_CHUNK_CONFIG`) when present, the
documented defaults otherwise, then environment overrides. Malformed or unknown configuration fails with `CONFIG_INVALID`.

| Key | Default | Source |
|---|---|---|
| `chunking.chunk_tokens` | 512 | cap of one chunk, measured ([section chunking](docs/benchmarks/evidence-chunking-sections-2026-10-04.md)); at most 1,433 characters, inside the excerpt limit |
| `chunking.overlap_tokens` | 0 | fixed-window boundaries only; a section chunk is a unit |
| `chunking.chars_per_token` | 2.8 | calibrated on the benchmark corpus |
| `chunking.boundary` | `section` | `section` (document headings; split only when larger than the cap, tiny sections merged) \| `paragraph` \| `hard` |
| `verification.engine` | `eos` | owner decision 2026-10-04; env `UKTUB_VERIFY_ENGINE` overrides |
| `verification.min_confidence` | 0.99 | client policy; env `UKTUB_VERIFY_MIN_CONFIDENCE` overrides |
| `verification.workers` | 4 | client policy: concurrent engine calls |
| `verification.max_judgments` | 120 | client policy: fresh judgments per call |

### Verification engines

- **`eos` (default)**: [Decision 2.0 Eos 0.8B](https://huggingface.co/vllm-sr/Decision-2.0-Eos-0.8B), a resident local worker
  (`scripts/decision2_decide.py`) on the pinned reviewed revision, shared per process. It needs a Python environment you
  provide: `torch` (CUDA recommended), `transformers>=5.17`, `safetensors`, selected with `UKTUB_EOS_PYTHON` (default `python3`);
  `UKTUB_EOS_MODEL` (a local snapshot or HF id) and `UKTUB_EOS_REVISION` override the pin. A missing environment is a
  `VERIFY_ENGINE_MISSING` refusal naming the cause. Measured on claim-verification-v1 at the 0.99 bar: precision 0.97, recall
  0.50 ([DECISIONS](docs/DECISIONS.md)).
- **`eos-onnx`**: the same model on ONNX Runtime without PyTorch. `uktub-scholar eos install --yes` downloads a pinned 8-bit export
  (Apache-2.0) and builds a small Python environment, then self-checks the worker; select it with `verification.engine: eos-onnx`. About
  49 ms per judgment on a CUDA GPU, 0.8 s on CPU. `UKTUB_EOS_ONNX_DIR` and `UKTUB_EOS_ONNX_PYTHON` use your own copy;
  `UKTUB_EOS_ONNX_REVISION`, `_SHA256` and `_BOOTSTRAP_PYTHON` adjust the pin and installer.
- `openrouter`: `inception/mercury-decide:free` via the System One decisions API; needs `OPENROUTER_API_KEY`;
  `UKTUB_OPENROUTER_MODEL` picks another compatible model, `UKTUB_OPENROUTER_MIN_INTERVAL_MS` sets the throttle.
- `llama-cpp`: a local `/v1/systemone` endpoint (`UKTUB_VERIFY_URL`, default `http://127.0.0.1:8080`); its served model id is
  the judgment identity.
- `vela` (experimental, **not adopted**): [Vela 2.0](https://huggingface.co/vllm-sr/Vela-2.0-0.3B) 0.3B on ONNX Runtime or any
  size on PyTorch (`UKTUB_VELA_BACKEND=torch`), from a snapshot you provide (`UKTUB_VELA_DIR`; also `_REVISION`, `_DEVICE`,
  `_WEIGHTS_FILE`, `_WEIGHTS_SHA256`, `_INFERENCE_SHA256`, `_PYTHON`); refuses weights that differ from the pinned sha256.
- `k2`, `bev`, `lumma`, `julia`, `laya`: retained adapters; selection is not an endorsement. Setup is in
  [engines.ts](src/core/verify/engines.ts), quality and licence decisions in the [benchmark reports](docs/benchmarks/).

Offline tests never spend provider quota, and the package never reads credentials from other repositories.

## Ownership and confinement

The SQLite registry (`.registry/registry.db`) is canonical; `refs/references.bib` is derived and re-rendered on registry writes
(human edits are overwritten; `sync-bib` restores it). All tools validate project paths (`PATH_REFUSED`): lexical `..` escapes,
symlinks leaving the project and the protected `.registry/**` and `.git/**` are rejected before reading or writing. The MCP
server enforces confinement on its own parameters; host file and terminal operations are outside its process and guided by the
[research skill](skills/uktub-research/SKILL.md). Optional project `AGENTS.md` guidance (never written by `init`): use the
scholarly tools for papers, cite only citable registered keys, never hand-edit the rendered bibliography, compile user-owned
LaTeX with `compile_document`.

Registry schema version 5. Versions 1 to 4 migrate in place on open (papers and citekeys intact; version 2's unsourced rows are
dropped after a `registry.db.v2.bak` copy). A foreign or newer schema is refused byte-for-byte unchanged.

## Checks and evidence

```sh
pnpm typecheck && pnpm test    # offline suite, provider fakes, no quota
pnpm sandbox                   # a fresh Pi in Docker with this package, Vertex and Eos preconfigured; your own Pi is untouched
```

Live acceptance of every tool and action (directly and through a real Pi session in an isolated Docker sandbox) and
user-simulation experiments are separate tiers: [docs/testing.md](docs/testing.md), including the `pnpm sandbox` options and a
one-line alias. [Dated benchmark reports](docs/benchmarks/) and [reviews](docs/reviews/) preserve measurements; a score is
evidence about one dataset, not a guarantee.

## Repository layout

| Path | What it is |
|---|---|
| `src/core/` | Host-independent domain code; `src/mcp/`, `src/pi/`, `src/cli/` are the adapters |
| `bin/`, `skills/` | The CLI entry point and the research skill that ship with the package |
| `tests/` | Offline suite; no provider quota |
| `scripts/` | Engine workers, build step, benchmark tools ([index](scripts/README.md)); `scripts/live/` is the live harness |
| `benchmarks/`, `docs/benchmarks/` | Dataset and protocol; dated measurement reports |
| `experiments/` | User-simulation scenarios and the self-improving loop (local run evidence is gitignored) |
| `docs/` | `VISION`, `DECISIONS`, `BACKLOG` (the only backlog), `handoff`, `testing`; dated `plans/` and `reviews/` are history |
| `docker/` | The sandbox image behind `pnpm sandbox` and the live tiers |
| `.agents/skills/` | Skills for agents working on this repository |
| `reference_repos/`, `test_papers/`, `.sandbox/` | Local only, gitignored: studied clones and manuals, the benchmark PDFs, sandbox state |

[NOTICE.md](NOTICE.md) records borrowed-code provenance. License: AGPL-3.0-only.
