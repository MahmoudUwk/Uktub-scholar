# uktub-scholar

Local-first scholarly tools for [Pi](https://github.com/earendil-works/pi): paper
search, a paper registry, a rendered bibliography, LaTeX compilation, and
evidence retrieval for claims. The core is host-agnostic; other host adapters
are not implemented.

## Start here

- This README: current setup and behavior.
- [AGENTS.md](AGENTS.md): contributor rules.
- [Vision](docs/VISION.md): product direction; [backlog](docs/BACKLOG.md): deferred work.
- [Decisions](docs/DECISIONS.md): dated rationale, not current setup instructions.
- [Benchmarks](benchmarks/README.md): datasets, runner, and historical evidence.
- [Research skill](skills/uktub-research/SKILL.md): agent usage guidance.

## Development install

The package is private; `pi install npm:uktub-scholar` is not a published install path.
From this checkout:

```sh
pnpm install
pi install .
pnpm exec uktub-scholar --help
```

Requires Node >= 22.19 and Pi >= 1.0.0 (`@earendil-works/pi-coding-agent`).
The bin shim runs TypeScript directly, adding `--experimental-strip-types` on
Node 22. Compilation needs a local [Tectonic](https://tectonic-typesetting.github.io)
>= 0.15.0 on `PATH` or at `UKTUB_TECTONIC_BIN`; no engine is downloaded or bundled.

Run `uktub-scholar init` in the research project to create `.registry/registry.db`
and `refs/references.bib`. Nested projects are refused. The user owns layout,
LaTeX sources, git, backups, and toolchains; sandboxing is optional.

## Four Pi tools

| Tool | Behavior / limits |
|---|---|
| `search_papers(query, limit?)` | OpenAlex + Crossref + Semantic Scholar, merged by RRF; default 5, maximum 20 |
| `paper_registry(action, …)` | Register, remove, read, attach a source, sync the bibliography — one tool, below |
| `compile_document(entry?)` | Local Tectonic, PDF in `build/`; 120 s budget, maximum 50 diagnostics |
| `verify_claim(claim, papers \| passages, query?, continuation?)` | One claim over all or selected papers; supporting passages plus coverage, below |

Caps are client policies unless a source is named (search/registration informed
by the recorded Feynman incident). `UKTUB_COMPILE_TIMEOUT_S` overrides the
compile budget (seconds, minimum 5). Missing Tectonic refuses compilation only.
Entry defaults to `manuscript/main.tex`, then `main.tex`, then a lone top-level
`.tex`; ambiguous candidates require an explicit entry.

Search provider failures become warnings; all providers failing refuses with
`SEARCH_UNAVAILABLE`. Optional keys, read at call time: `OPENALEX_API_KEY`,
`SEMANTIC_SCHOLAR_API_KEY`, `CROSSREF_MAILTO`. DataCite resolves arXiv DOIs during
registration.

### `paper_registry`

| `action` | Input | Result |
|---|---|---|
| `register` | `identifiers[]` (≤ 50): DOIs in any common form, or `arxiv:YYMM.NNNNN` | One ordered outcome per input. Aliases of one paper register once (later ones report `duplicate`); a refresh keeps the pinned citekey and provider BibTeX; unknown or invalid inputs are refused per item |
| `remove` | `handles[]` (≤ 50): explicit DOIs or citekeys | `removed` / `duplicate` / `absent` / `refused` per input, one transaction, bibliography re-rendered. There is no remove-all |
| `read` | optional `handles[]`, `fields[]`, `limit`, `cursor` | Citekey-ordered records. Default fields: DOI, citekey, title, year, citable. Optional: `authors`, `venue`, `bibtex`, `bibtexSource`, `abstract`, `source`, `refreshedAt`. Unsupported fields are refused. A page holds ≤ 100 light rows or ≤ 25 with abstract/BibTeX; `cursor` continues the same request and is refused if the registry changed |
| `attach_source` | `attachments[]` (≤ 10): `{handle, path}` to a PDF or GROBID TEI inside the project | Source readiness, revision and counts. The file is neither copied nor deleted; its text is never returned |
| `sync_bibliography` | — | Re-renders `refs/references.bib` from the registry (human edits are not imported) |

A paper without provider BibTeX registers as `citable: false` (`BIBTEX_UNAVAILABLE`);
a later registration can upgrade it without moving the citekey. Citekeys are never
synthesized by the agent. Abstracts are the provider's own, bounded (1,500 characters)
and labelled with their provider; a missing abstract is stated, never invented. Nothing
is summarized at read time.

### `verify_claim`

Give **one** claim (8–2,000 characters, passed to the verifier unchanged) and a scope:
`papers: "all"` or an explicit list of DOIs/citekeys (≤ 100; an empty list is refused,
never read as all). The package prepares the sources, selects passages, judges them,
and returns only **supporting** passages — each with a verbatim excerpt and an exact
pointer `doi@revision#start-end` (zero-based, end-exclusive UTF-16 offsets into the
captured text; the page is included when the extractor grounds it). Non-supporting text
never reaches the agent.

Four coverage reports are kept apart, so a success never implies the rest was checked:

1. **sources** — which selected papers have a usable captured source, and why the rest do not;
2. **candidates** — exhaustive (every usable passage) or **query-limited** (an optional
   `query` only narrows which passages are checked; it never replaces the claim);
3. **work** — passages judged (new vs reused), and any interruption (work budget,
   cancellation, engine failure) with the unchecked remainder;
4. **output** — supporting records available vs shown, and any excerpt text withheld.

A `continuation` token in the response resumes unfinished checking and/or pages more
evidence: repeat the same request with it. The token names a stored run that captured the
selection: the exact papers at their revisions, the exact locator candidates, the model identity
and the bar. It is refused when a source, claim, exact id list, locator, model or bar changed,
and expires after 24 hours. Each evidence record is delivered exactly once across pages, and
excerpt text counts against the per-source release budget across the whole run. Findings of the
first call (papers without a usable source, unresolved handles) are repeated on every page.
If localizing a supported chunk is interrupted, that chunk is unfinished work for the
continuation — it is never reported as a vague chunk-sized pointer.

**No support found is not a finding that the claim is false.** A low score is only the
absence of support; the package never reports refutation. Scores are engine outputs under
a configured bar, not calibrated probabilities; checking more passages can raise false
supports.

A pointer is current only while its source revision is. A replaced source gets a new
revision, so an old pointer resolves as stale instead of pointing at new text. Evidence is
stored with the decision that produced it (model identity, protocol, bar) and survives
loss of the judgment cache. A judgment is reused only for the same claim, passage, model
identity and protocol; when the engine cannot report what model answers (a bare URL is not
an identity) reuse is disabled, unless you declare one with `UKTUB_VERIFY_MODEL_ID`.

**Full-text containment (a package output contract).** Excerpts are verbatim passages of
at most 1,500 characters. A passage that is half or more of its source, or text beyond 25 %
of one source across a verification, is withheld — the pointer stays. This keeps support
from becoming a full-text export through the package's own responses; it does not stop an
agent with host filesystem access from reading a user-owned PDF (the guard below is advisory).

Direct path (rare): `passages: [{source: pointer} | {text}]` judges exactly those passages
(≤ 8). A `source` must be a pointer this package issued as evidence (within the last 24 hours)
and is checked against its current revision, so the direct path cannot be used to read
arbitrary spans; `text` carries **no authenticated paper provenance** and can never claim a DOI.

### Sources

Registration stores metadata only. `verify_claim` prepares sources on demand, from
OpenAlex only (Unpaywall is deprecated into it): open-access `pdf_url` candidates from the
work record, then the OpenAlex Content API at the record's own `content_urls` (GROBID TEI,
then PDF; **needs `OPENALEX_API_KEY` and costs about $0.01 per download**). URLs are never
synthesized and landing pages are never scraped. Downloads are HTTPS-only to public
addresses (re-checked after every redirect, connection pinned to the checked address),
credential-scoped to the Content API origin, bounded in size (64 MiB) and time, and the
extracted text must match the registered paper's title or DOI. PDFs come from
[`unpdf`](https://github.com/unjs/unpdf) and TEI from `fast-xml-parser` (DOCTYPE/entity
declarations refused); scanned PDFs have no text layer and are refused — there is no OCR.
At most 20 papers are acquired per call (never-attempted first); the rest are reported as
`deferred` and reached by repeating the request. A failed acquisition is not retried for 24
hours (a retry can cost a download); a failed local attach never throttles acquisition. Use
`paper_registry` `attach_source` to supply your own file instead. A write that waits out the
5-second SQLite lock is refused as `REGISTRY_BUSY`.

Key-less acquisition succeeds only for papers whose OpenAlex record carries a direct `pdf_url`
(for example a J-STAGE PDF downloaded live); OpenAlex often lists landing pages only (a
PeerJ paper and an arXiv preprint did), which are not scraped — attach a file or set the key.

## CLI

`uktub-scholar` exposes `init`, `register <id>...`, `attach <doi|citekey> <file>`,
`verify <claim> [--papers all|<handle>,… ] [--query <words>] [--continuation <token>]`,
`deregister <doi|citekey>...`, `sync-bib`, `list`, and `compile [entry.tex]`.
`register`, `attach` and `verify` call the same tool functions the agent uses and print
exactly what the agent reads.

## Configuration

Resolved on one path: the project's `config/chunking.yaml` (or the file named by
`UKTUB_CHUNK_CONFIG`) when present, the documented defaults otherwise, then env overrides.
Malformed or unknown supplied configuration fails with `CONFIG_INVALID`.

| Key | Default | Source |
|---|---|---|
| `chunking.chunk_tokens` | 1024 | measured: recall plateaus here ([window sweep](docs/benchmarks/evidence-window-sweep-2026-10-04.md)); the engine window is the ceiling |
| `chunking.overlap_tokens` | 16 | continuity across paragraph boundaries (the measured setting) |
| `chunking.chars_per_token` | 2.8 | calibrated on the benchmark corpus (densest paper 3.10; 0.9 headroom) |
| `chunking.boundary` | `paragraph` | `paragraph` \| `hard` |
| `verification.engine` | `eos` | owner decision 2026-10-04; env `UKTUB_VERIFY_ENGINE` overrides |
| `verification.min_confidence` | 0.99 | client policy; env `UKTUB_VERIFY_MIN_CONFIDENCE` overrides |
| `verification.workers` | 4 | client policy: concurrent engine calls |
| `verification.max_judgments` | 120 | client policy: fresh judgments per call (≈ 7 min on the hosted free tier) |

Engines:

- `eos` (default): [Decision 2.0 Eos 0.8B](https://huggingface.co/vllm-sr/Decision-2.0-Eos-0.8B), a
  resident local worker (`scripts/decision2_decide.py`) on the pinned reviewed revision. One
  worker is shared per process (a long-lived Pi session loads the model once). It needs a Python
  environment you provide — `torch` (CUDA recommended; it ran on an 8 GB laptop GPU at about 3 GB),
  `transformers>=5.17`, `safetensors` — selected with `UKTUB_EOS_PYTHON` (default `python3`).
  `UKTUB_EOS_MODEL` (a local snapshot directory or the HF id) and `UKTUB_EOS_REVISION` override the pin;
  the judgment identity includes the revision and a fingerprint of local files. At the 0.99 bar it
  measured precision 0.97 and recall 0.84 at the default 1,024-token window (0.52 at 8,192)
  ([evidence](docs/benchmarks/evidence-quality-end-to-end-2026-10-04.md)); a missing environment is a
  `VERIFY_ENGINE_MISSING` refusal naming the cause.
- `openrouter`: `inception/mercury-decide:free`, System One decisions API;
  needs `OPENROUTER_API_KEY`; `UKTUB_OPENROUTER_MODEL` selects another compatible model.
- `llama-cpp`: local `/v1/systemone` endpoint (`UKTUB_VERIFY_URL`, default
  `http://127.0.0.1:8080`); its served model id (`/v1/models`) is the judgment identity.
- `k2`, `bev`, `lumma`, `julia`, `laya`: retained adapters; selection is not an
  endorsement. Setup lives in [engines.ts](src/core/verify/engines.ts), quality and
  license decisions in the dated [benchmark reports](docs/benchmarks/).

The package never reads credentials from retired repositories, and offline tests never
spend provider quota.

## Ownership and guard

The SQLite registry is canonical; `refs/references.bib` is derived and re-rendered
on registry writes. Human edits to it are overwritten; `sync-bib` restores it.
The Pi `tool_call` guard blocks agent access to `.registry/**` and agent writes
to `refs/references.bib`; bibliography reads are allowed. Bash guarding scans
command text, not shell syntax: it is advisory protection, not a security sandbox.
Removing the extension removes the guard.

Optional project `AGENTS.md` guidance (never written by `init`): use the scholarly
tools for papers, cite only citable registered keys, never hand-edit the rendered
bibliography, and compile user-owned LaTeX with `compile_document`.

Registry schema version 3. Version 1 and 2 registries migrate in place on open (papers and
citekeys intact); version 2's unsourced chunk, verdict and pointer rows are dropped, after
a `registry.db.v2.bak` copy. A foreign or newer schema is refused byte-for-byte unchanged.

## Checks and evidence

```sh
pnpm typecheck
pnpm test
```

The test suite uses offline provider fakes. Real-Pi smoke and live API evidence
are separate tiers; the exercised checkout evidence is in [handoff](docs/handoff.md).
[Dated benchmark reports](docs/benchmarks/) preserve measurements of engines and
evidence quality; a score is evidence about one dataset, not a guarantee.

`scripts/test-sandbox.sh` runs an optional Docker Pi TUI, mounts the package and
read-only ADC, and persists project/session data in `../uktub-sandbox/`.
`--fresh` deletes that persisted data. The TUI registry panel refreshes after tool calls.

[NOTICE.md](NOTICE.md) records borrowed-code provenance. License: AGPL-3.0-only.
Companion research/deliverable skills and their adoption triggers live in the backlog.
