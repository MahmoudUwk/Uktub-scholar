---
name: uktub-research
description: Using uktub-scholar's six tools (and `doctor` for setup problems) for scholarly search, the paper registry (register, acquire, read, remove, attach, sync), citekeys, LaTeX compilation, one-claim evidence retrieval, and exploratory passage search.
---

# Scholarly research with uktub-scholar

Five core capabilities operate beside the user's project: `papers`, `registry`,
`compile`, `verify`, and `passages`. The SQLite registry is canonical.
`refs/references.bib` is rendered from it. The PDF is derived from the user's own LaTeX sources.

Depending on the host agent and MCP configuration, tools may be available under their bare names
(`papers`, `registry`, `compile`, `verify`, `passages`) or namespaced
with the server name (e.g. `mcp__uktub__papers`, `mcp__uktub__registry`, etc.).
The capabilities and arguments are identical in either form.

## Search versus register

- **The registry is the bibliography.** Register every paper your answer relies on
  before you write. A literature review with unregistered sources is incomplete work.
- If a paper the user named has no search hits, say so ("no indexed records found for X").
  Never drop it or substitute another work.
- Use `papers` for open-ended topics. It returns merged candidates in relevance
  order, each with a DOI when one exists. The DOIs are in the result text.
- Use `registry` with `action: "register"` once you have DOIs or `arxiv:YYMM.NNNNN`
  identifiers. Check that the titles match what the user asked for.
- A DOI-shaped query to `papers` still searches. Register that DOI directly instead.
- To see what is registered, use `registry` with `action: "read"`. Do not guess.

## The registry tool

- `register`: at most 50 identifiers. You get one outcome per input, in input order.
  Aliases of one paper register once; the later ones report `duplicate`.
- `read`: default fields are title, year and citable. Ask for `authors`, `venue`, `bibtex`,
  `abstract`, `source` or `refreshedAt` only when you need them. A long registry comes in pages:
  repeat the same request with the `cursor` from the previous page.
- `remove`: name the DOIs or citekeys. There is no remove-all. Remove only when the user asks.
- `attach_source`: prepare a PDF or GROBID TEI file that is inside the project as a paper's
  source. You never see the file's text.
- `acquire`: fetch open-access sources for selected handles, or omit handles for papers
  without sources. Registration starts this in the background in MCP, but metadata alone
  is not searchable text. Before passage search, read the `source` field: use ready sources,
  continue deferred batches within the task budget, and disclose unavailable or failed ones.
  Do not invent a claim or run `verify` just to acquire text. Use `attach_source` for
  a user-supplied file; repeated calls do not bypass acquisition cooldowns.
- `sync_bibliography`: re-render `refs/references.bib` if it is damaged or stale.

## Citekeys

- Registration returns a pinned citekey. Cite it exactly: `\cite{<citekey>}`.
  Never invent, shorten or "fix" a citekey. The key is never recomputed.
- If a paper was removed and registered again, its citekey may differ. Read it again.

## Uncitable papers

- A paper without provider BibTeX registers with `citable: false` and a `BIBTEX_UNAVAILABLE`
  warning. It is in the registry but not in `references.bib` yet.
- That is not an error. Registering the same DOI later can upgrade it and keeps the citekey.
  BibTeX is never synthesized or repaired.

## Running a review

- Agree the mode first: a related-work pass (fast, best-effort coverage) or a systematic
  review (explicit query set, screening, reported counts). Never present the first as the second.
- Budget the loop: bounded `papers` calls, dedupe by DOI, rank by fit to the question.
- Register everything the answer will rely on.
- For each claim, say supported, partly supported, or not supported by the registered sources.
  The deliverable is a table of claim → citekey, not prose alone. Never attach a source that is not
  registered.

## Finding support for a claim

- `verify` takes **one** claim and a scope: `papers: "all"`, or a list of DOIs or citekeys.
  Write the claim as one plain sentence. The package passes it to the verifier unchanged.
- You do not load papers and you do not prepare passages. The package prepares sources,
  searches, and judges. You receive only supporting passages, each with an excerpt and an exact
  pointer `doi@revision#start-end`.
- Read the four coverage lines before you trust a result:
  - **sources**: some papers may have no usable source. Say so. Do not call them "checked".
  - **candidates**: `exhaustive` checks every passage. `query-limited` checks only passages
    that match your optional `query`.
  - **work**: if the work was interrupted, passages were not checked.
    Repeat the same request with the `continuation` token to continue.
  - **output**: more evidence may exist than one response shows. Use the same token.
- **No support found does not mean the claim is false.** Report it as "no support found in
  these papers under this search". Never write that a paper contradicts a claim because of this tool.
- A `query` only narrows what is checked. A query that finds nothing is a statement about the
  search, not about the papers. Run the exhaustive request before you conclude anything.
- A withheld excerpt still has a pointer. Cite the paper by its citekey; do not quote text
  you were not given.
- The score is the engine's output at a configured bar. Do not present it as a probability
  that the claim is true. Checking more papers can raise false supports. Check the excerpt yourself.
- Rare direct path: `passages` judges exactly the passages you give. A `{text}` passage has no
  paper provenance. Never cite a paper for it.
- If a source cannot be prepared, the result names the reason (`no_open_copy`, `no_credential`,
  `identity_mismatch`, `no_text_layer`, and others). Ask the user to attach a file with
  `registry` `attach_source`, or to set `OPENALEX_API_KEY` for open-access content.

## Searching passages in registered papers

- `passages` performs exploratory text retrieval over registered papers (`papers: "all"` or an explicit list of DOIs or citekeys).
- Give a descriptive natural-language `query`, question, or phrase.
- Returns the best-matching passages (at most `limit`, default 5, maximum 10), each with:
  - The paper's `citekey`, `title`, and `doi`
  - The `section` heading where the passage occurs
  - The grounded `page` number (when available from the source)
  - An exact source pointer `doi@revision#start-end`
  - A verbatim `excerpt` (capped at 1,500 characters and bounded by the 25% per-source containment policy)
- Search is hybrid when an embedding runtime is present (combining FTS5 BM25 lexical search and dense cosine vector search via Reciprocal Rank Fusion), or lexical BM25 when no embedder is configured.
- Use `passages` to explore what the registered papers say about a topic or question.
- **Retrieval is not verification**: always use `verify` to rigorously verify a factual proposition before citing it.

## Writing a document from the papers

No claim from memory: every factual statement needs a registry pointer.
When writing a document, work section by section, never in one bulk write:

1. Plan an outline: sections, each with a goal, a word budget (pass `max_words` to `write_section` when there is a length limit), and the citekeys it may use.
2. If `write_section` is available, write each section with it
   (`goal`, `max_words`, plus `papers` as ONE string of citekeys separated by spaces or
   commas). Otherwise write each section yourself only from `passages` of the
   listed papers, then run `verify` with `text` on what you wrote.
3. Save each section as soon as it is written, byte for byte, to its own file `manuscript/sections/NN-name.tex`, and `\input{sections/NN-name}` it from `manuscript/main.tex`; finished sections then survive an interruption, and later revisions are targeted edits of one section file, never a rewrite of the whole manuscript. Keep `supported` sentences from `write_section` verbatim (rewriting a supported sentence invalidates its verification; to shorten, delete whole sentences rather than paraphrasing them). Put citations before the period (e.g. `fact~\cite{ref}.`) or separate sentences with a space or blank line so sentence boundaries split cleanly. Then `compile`.
4. Run `verify` with `document` on the whole manuscript.
5. Resolve every non-`supported` unit before reporting done: rewrite it from a
   passage of its cited paper, add the suggested citation, delete it, or mark
   it explicitly unverified by writing the word "unverified" in it (for example
   "(unverified)"). `compile` lists every statement that is neither verified nor
   so marked as `UNLABELLED`; a finished document has none. Check `compile` output: resolve any `OPEN` figure
   (not found in the cited paper's text; fails deliverable checks) by citing the paper
   that states it, removing the number, or writing "not reported"; a `table-row` unit is
   checked by its figures, not its wording, and one with a missing figure is resolved
   the same way. Separate unverified
   notes/anecdotes (which cite no paper) into their own paragraph with a blank line so
   they are not merged with cited statements. Recompile, re-verify, and list what is
   still unverified in your final report.

`verify` document mode checks the text as written, 50 units per call; when
the result says NOT DONE, call again with the `offset` it names until every
unit is checked. Cited units are checked against their own papers, uncited units against all
registered papers. `missing-citation` names the paper to cite;
`unregistered` names a citekey the registry does not know — a unit that also
cites registered papers is still checked against them, and its unknown keys
are listed on the result. `skipped` was not checked: too short to check, or
too long (split it and check the parts).

## Compiling the document

- `compile` runs Tectonic: the user's own (`UKTUB_TECTONIC_BIN`, then PATH), else a
  managed copy the user installed with `uktub-scholar tectonic install --yes`. Nothing is
  downloaded by a compile — a missing engine refuses; tell the user that command instead of improvising.
- Entry resolution: `entry` omitted → `manuscript/main.tex`, then `main.tex`,
  then a lone top-level `.tex`. Several candidates refuse with the list — pass
  `entry` explicitly rather than guessing.
- Output goes to `build/` in the project root. Treat `build/` as disposable:
  never cite it, never hand-edit it, and do not `rm -rf` anything else to "clean"
  the project.
- On failure the result carries structured diagnostics (severity, file, line,
  message). Fix the named source locations — the LaTeX sources are the user's
  files; write with the host's file-editing tools, then recompile. Compile
  errors are ordinary results, not run-ending failures; report what did not
  compile and continue.
- Warnings (overfull boxes, undefined citations) ride along on successful
  compiles. Mention them only when they matter to the user's ask; do not
  silently hide a broken reference in a "successful" build.

## Registry hygiene

- Never hand-edit `refs/references.bib`. It is rendered by the registry and is
  overwritten on the next registry write. If it diverges or is damaged, use `registry`
  `action: "sync_bibliography"` to re-render it from the registry.
- Remove papers with `registry` `action: "remove"`, only when the user asks.
- All tools operate inside the project directory; `.registry` and `.git` are
  protected and path traversal is refused.
- Failures arrive as `Refused: CODE — <what happened>. Next: <what to do>` —
  follow the `Next` hint; it is stable per code.
