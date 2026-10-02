---
name: uktub-research
description: Guidance for using uktub-oa scholarly tools — when to search versus register, citekey usage, uncitable papers, batch limits, and registry hygiene for LaTeX bibliographies.
---

# Scholarly research with uktub-oa

Three tools manage a local paper registry and a rendered `references.bib` beside
the user's LaTeX project: `search_papers`, `register_papers`, `list_papers`.
The registry is the source of truth; the bibliography is derived from it.

## Search versus register

- **The registry is the bibliography.** Any paper your answer relies on —
  cited, compared, or summarized — must be registered first. A literature
  review with unregistered sources is incomplete work: search, pick the
  strongest candidates, and register them before writing.
- If a system or paper the user named has no search hits, say so explicitly in
  the answer ("no indexed records found for X") — never silently drop it or
  substitute a different work.
- Use `search_papers` when the topic is open-ended: given a rough query, it
  returns merged candidates from OpenAlex, Crossref, and Semantic Scholar in
  relevance order, each with a DOI when one exists. Candidate DOIs appear in
  the tool result text.
- Use `register_papers` once you have DOIs — from search results, from the
  user's own list, or from a paper's page. Do not register on the user's
  behalf without checking the titles match what they asked for.
- `search_papers` with a DOI-shaped query still searches; prefer registering
  that DOI directly instead.
- To check what is already registered before searching again, use
  `list_papers` rather than guessing.

## Citekeys

- Registration returns a pinned citekey. In LaTeX, cite it exactly as returned:
  `\cite{<citekey>}`. Never invent, shorten, or "fix" a citekey — collisions
  are resolved with a base-26 suffix at registration and the key is never
  recomputed afterwards.
- If a paper was deregistered and re-registered, it may hold a different
  citekey; re-run `list_papers` rather than assuming.

## Uncitable papers

- A paper without provider-supplied BibTeX registers with `citable: false` and
  a `BIBTEX_UNAVAILABLE` warning. It exists in the registry but does not appear
  in `references.bib` yet.
- That is not an error. Re-registering the same DOI later, once the provider
  supplies BibTeX, upgrades it in place and keeps the citekey. BibTeX is never
  synthesized or repaired.

## Batches

- `register_papers` accepts at most 50 DOIs per call and refuses larger calls.
  Split a long list into calls of 50 or fewer.
- If registration order matters to you, use one batch call rather than several
  parallel ones: batch results come back in input DOI order.

## Registry hygiene

- Never hand-edit `refs/references.bib`. It is rendered by the registry and is
  overwritten on the next registry write. If it diverges or is damaged, run
  `uktub-oa sync-bib` to re-render it from the registry.
- Removing papers is a human CLI action: `uktub-oa deregister <doi|citekey>...`.
  Run it via the shell only when the user asks for removal.
- If search keeps degrading (`SEARCH_UNAVAILABLE`, provider warnings), suggest
  the user set optional keys — `OPENALEX_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY`,
  `CROSSREF_MAILTO` (see README) — anonymous Semantic Scholar callers are
  rate-limited hard.
- All tools operate inside the project directory; `.registry` and `.git` are
  protected and path traversal is refused.
- Failures arrive as `Refused: CODE — <what happened>. Next: <what to do>` —
  follow the `Next` hint; it is stable per code.
