---
name: semantic-scholar
description: Search papers, snippets, citations via Semantic Scholar.
version: 0.2.0
author: Mahmoud Sallam (mahmoudsallam), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  internal: true
  hermes:
    tags: [semantic-scholar, papers, citations, snippets, research, api, datasets]
    related_skills: [crawl4ai, arxiv]
---

# Semantic Scholar Skill

Access the Semantic Scholar Academic Graph (214M+ papers) through a tested stdlib-only CLI script: keyword/bulk search, title matching, full-text snippet search, paper metadata by DOI/arXiv/CorpusId, batch lookups (500 at a time), citation graphs, TLDRs, author search, recommendations, and bulk dataset downloads. No SDK, no pip installs. Also documents the Semantic Reader and TLDR products.

## When to Use

- Find papers on a topic, with filters (year, venue, open access)
- Resolve an exact title to an ID (`match`) or complete partial titles (`autocomplete`)
- Search inside paper bodies (`snippets`) — ~500-word excerpts, the only text-level API access
- Batch-fetch metadata for many papers at once (DOI, arXiv ID, CorpusId, URL, ...)
- Export server-formatted BibTeX for a known paper (`get <id> --fields citationStyles.bibtex`; rejected by search/batch — fetch per id)
- Traverse citation graphs (who cites X / what X cites, with citation contexts)
- Get one-sentence AI TLDR summaries (a field, not an endpoint)
- Look up authors, h-index, and their papers
- Get similar-paper recommendations (seed by paper or by +/− id lists)
- Prefer S2 for recent/niche CS topics (relevance search is recency-weighted; cleaner results than OpenAlex semantic search) — pair with OpenAlex for citation-weighted canonical coverage + OA metadata
- Download bulk S2AG datasets (papers, citations, tldrs, embeddings, s2orc, ...)
- Don't use for: full-text PDF extraction (use ocr-and-documents), general web search, non-scholarly content

## Prerequisites

- python3 (script uses only stdlib: urllib, json, re, argparse)
- Optional but strongly recommended: `S2_API_KEY` env var
  - Free key: https://www.semanticscholar.org/product/api#api-key-form (emailed to you)
  - Keyless: shared 1000 req/s pool across ALL unauthenticated users — frequent 429s
  - With key: 1 req/s shared across endpoints; dataset file URLs REQUIRE a key (401 otherwise)

## How to Run

All commands go through the `terminal` tool:

```
terminal(command="python3 <skill_dir>/scripts/semantic_scholar.py search \"transformer attention\" --limit 5")
```

With an API key (never hardcode it in files):

```
terminal(command="S2_API_KEY=<key> python3 <skill_dir>/scripts/semantic_scholar.py search \"...\"")
```

Output is always a single JSON object on stdout; errors go to stderr with exit code 2. Default paper fields: `title,year,venue,citationCount,externalIds,openAccessPdf,tldr` (LLM-sized; `tldr.text` is the one-sentence AI summary). Override with `--fields` (e.g. add `abstract,authors.name`). BibTeX: `citationStyles.bibtex` is accepted by `get` only — search/match/batch reject it (fetch per id).

## Quick Reference

```
# SEARCH
... search "query words" [--limit N] [--offset N] [--pages N] [--year 2022-2025] [--venue "ACL,EMNLP"] [--open-access]
... bulk "query words" [--limit N] [--token TOKEN] [--year ...] [--sort citationCount:desc]   # boolean syntax: see Procedure step 1
... match "An Exact Paper Title"            # -> paperId + matchScore
... autocomplete "semanti"                  # -> title suggestions
# SNIPPETS (text search inside papers)
... snippets "phrase from the paper body" [--paperIds id...] [--author "Name"] [--year ...]
# PAPER
... get CorpusId:13756489 | DOI:10.18653/v1/N18-3011 | ArXiv:1706.03762 | URL:https://...
... batch <id1> <id2> [...]                 # up to 500 ids; unknown ids -> null
... citations <paper_id> [--limit N] [--pages N]  # citing papers (add --fields contexts; limit<=1000, offset+limit<10000)
... references <paper_id> [--limit N] [--pages N] # cited papers + contexts
... paperauthors <paper_id>                 # authors of a paper
... tldr <paper_id>                         # title + TLDR (tldr is a FIELD under the hood)
# AUTHOR
... authorsearch "Christopher Manning"      # find authorId (many namesakes; check counts)
... author <authorId> | authors <id...>     # details / batch (<=1000)
... authorpapers <authorId> [--limit N] [--pages N]
# RECOMMEND
... recommendfor <paper_id> [--limit N]
... recommend --positive <id...> [--negative <id...>]
# DATASETS (bulk downloads; file URLs need API key)
... releases                                # list release ids (weekly)
... release latest | release <id>           # datasets in a release
... dataset <release_id> <name>             # pre-signed S3 URLs (expire; .gz jsonl)
... diffs <start> latest <name>             # incremental update/delete files
```

## Procedure

1. **Find papers on a topic** — `search` with 2+ query words (plain text, no syntax; hyphens break matching; S2 ANDs all terms — long natural-language sentences return 0, use ~8 distinctive keywords). Pass `--pages N` to auto-fetch up to N pages (merges + dedupes by paperId, sleeps 1.1s between pages, stops when `next` is absent; a `note` in the response says when the page cap cut the loop short). Hand-rolled equivalent: iterate `--offset` (offset+limit <= 10000), stopping when `next` is absent from the response (for `authorpapers`, `total` is always null). Filter: `--year 2023-2026`, `--venue`, `--open-access`. For bulk/no-relevance retrieval (1000/call), `bulk` requires a query but supports boolean syntax (spec-quoted): `+` AND, `|` OR, `-` negates a term, `"` phrase, `*` prefix, `( )` precedence, `~N` after a word = edit distance N (default 2), `~N` after a phrase = terms up to N apart (default 2) — e.g. `(fish ladder) | outflow -privacy` (run `bulk --help` for the same list). Done when papers have `paperId` + `externalIds`.
2. **Resolve known titles** — `match "Exact Title"`; sanity-check `matchScore`. `autocomplete` for fuzzy prefixes.
3. **Enrich known papers** — collect ids (`CorpusId:`, `DOI:`, `ArXiv:`, `PMID:`, `ACL:`, `MAG:`, `URL:`, or 40-char `paperId`), run `batch` (<= 500 per call; chunk and sleep 1s+ between calls; unknown ids come back `null` in order). Done when `requested == len(results)`. Note `citationStyles.bibtex` is REJECTED by batch (400, live 2026-08-29) — fetch BibTeX per id via `get`.
4. **Skim before deep-reading** — `tldr <id>` or read the `tldr` field already present in search/batch/get results.
5. **Search inside paper text** — `snippets "phrase"` (~500-word excerpts from title/abstract/body, scored). Restrict with `--paperIds` (<= 100) or `--author`. This is the only full-text access outside the s2orc dataset.
6. **Citation graph** — `citations <id>` (who cites it; `contexts` holds the citing sentences) and `references <id>` (what it cites). Loop pages with `--pages N` (merges + dedupes) or hand-rolled `--offset` (hard cap: offset+limit < 10000; beyond that use datasets). An empty page with `next` still set means keep paging (live 2026-08-29: `data: []` with `next: 5` on a first page) — don't conclude "no citations" until `next` is absent.
7. **Authors** — `authorsearch` to resolve names to `authorId` (namesakes are common; disambiguate by paperCount/citationCount/hIndex — the canonical profile may not be on page 1: for "Christopher Manning" the first 10 of 55 hits were all minor profiles, live 2026-08-29), then `author`, `authorpapers`, or `authors` (<= 1000 ids).
8. **Related work** — `recommendfor <id>` for similar papers; `recommend --positive <seeds> --negative <avoid>` for steering. Recommendations reject the `tldr` field (script handles it).
9. **Bulk datasets** (millions of rows, not for quick lookups) — `releases` -> `release latest` (dataset names vary by release; the 2026-08-25 release has: abstracts, authors, citations, embeddings-specter_v1/v2, paper-ids, papers, publication-venues, s2orc, s2orc_v2, tldrs) -> `dataset <release_id> <name>` returns signed S3 URLs to .gz JSON-Lines (key records by `corpusid`). For incremental syncing, `diffs <start> latest <name>` returns update/delete file lists. Download with curl; URLs expire.
10. **Verify** — every command returns JSON on stdout; on error stderr carries `{"error": "HTTP <code> ..."}` with exit code 2.

## Pitfalls

- **Keyless 429s are the norm** — the shared unauthenticated pool is busy at peak hours and sends NO `Retry-After` header; the script backs off exponentially (up to ~45s waits) and retries 5 times; transient 5xx are retried the same way (live 500s happen). With a key, throttle to ~1 req/s (the `--pages` loop bakes this in with 1.1s between page calls; plain `search` = max 100 results per page, loop with `--offset` beyond it). Never hammer.
- **`tldr` field is rejected** by bulk search, citations, references, author-papers, and recommendations endpoints. The script self-heals: parses the 400 error, strips the rejected fields, retries once. (`publicationVenue` is valid on recommendations despite older notes saying otherwise.)
- **`fields` sub-field acceptance is per-endpoint**: `openAccessPdf.url` 400s on `search` (bare `openAccessPdf` is valid); citations/references reject BOTH `openAccessPdf.url` and `authors.name` (bare forms only); recommendations reject `openAccessPdf` outright but accept `authors.name`. The script defaults already use the safe bare forms, and the self-heal strips anything else a 400 names.
- **BibTeX (`citationStyles.bibtex`) is a single-paper field**: `get` serves it; `batch` rejects it with 400 (live 2026-08-29) and search/match never return it (same rejection, silently stripped by the self-heal). For a bibliography, loop `get <id> --fields citationStyles.bibtex` at 1 req/s — do not batch it.
- **Recommendations `limit` is query-param-only**: a `limit` in the POST body is silently ignored (you get 100/seed). The script always sends it as a query param.
- **authorsearch ranks namesakes arbitrarily** — for `authorsearch "Christopher Manning"` the canonical Stanford profile (hIndex 90+) was absent from the first 10 of 55 hits; scan paperCount/hIndex across pages before picking.
- **Empty citation/reference pages happen**: live 2026-08-29, `citations <id> --fields contexts --limit 5` returned `data: []` with `next: 5` — keep paging (`--pages` does this) until `next` is absent.
- **`tldr` is a field, not an endpoint** — there is no `GET /paper/{id}/tldr` (it 404s). Same for embeddings: `fields=embedding` (768-dim SPECTER v1) or `embedding.specter_v2`.
- **offset cap**: citations/references require offset+limit < 10000 (400 otherwise). Search tops out at 1,000 relevance-ranked results; use `bulk` (token pagination, up to 10M) or datasets beyond that.
- **ID prefixes**: keep the exact form (`CorpusId:123` not `123`); the script URL-encodes them (DOIs and `URL:` ids contain `/`).
- **Abstracts may be null** (publisher restrictions) even when the paper shows an abstract on the website.
- **Cross-provider matching**: S2 and OpenAlex disagree on ~14% of DOIs for the same work (arXiv vs publisher split) — when fusing S2 + OpenAlex results, match on normalized title + year, not DOI alone. `match` returns one result with `matchScore` (BM25-ish title relevance; sanity-check it — there is no threshold parameter to tune tolerance).
- **Dataset names differ per release**; always list a release first. Dataset file URLs and diffs REQUIRE an API key (401 without one) and expire shortly after issuance.
- **Response cap 10 MB** on most endpoints; shrink `limit`/`fields` if you hit `Response would exceed maximum size`.
- Do NOT put the API key in the skill, scripts, or committed files; pass it via env var per invocation.

## Verification

- `search "attention is all you need"` returns `total > 0` with the Vaswani 2017 paper in results.
- `get ArXiv:1706.03762` returns "Attention is All you Need" (paperId `204e3073870fae3d...`).
- `match "Construction of the Literature Graph in Semantic Scholar"` returns paperId `649def34f8be52c8...` with matchScore ~179 (drifts as the index updates: 177.6 on 2026-08-28, 179.1 on 2026-08-29).
- `tldr DOI:10.18653/v1/N19-1423` returns the BERT one-sentence summary.
- `releases` returns a non-empty list of `YYYY-MM-DD` strings; `release latest` lists 10-11 dataset names.
- `snippets "literature graph"` returns scored matches with `text` and `paper.title`.
- `search "large language models" --pages 2 --limit 5` merges both pages into unique papers (dedup by paperId) and emits a `note` when the page cap stopped the loop.
- `autocomplete "semanti"` returns ~10 `matches` with paper `id` + `title`.
- `paperauthors 649def34f8be52c8b66281af98ae884c09aef38b` returns the paper's authors with `authorId`s (incl. Oren Etzioni `1741101`).
- `recommendfor 649def34f8be52c8b66281af98ae884c09aef38b --limit 5` returns 5 `recommendedPapers`.
- `recommend --positive 649def34f8be52c8b66281af98ae884c09aef38b --negative ArXiv:1706.03762 --limit 5` returns 200 with recommendations; the list differs from `recommendfor`'s (2/5 overlap), consistent with the negative seed being honored.
- `authorsearch "Christopher Manning"` returns namesakes with `paperCount`/`hIndex` (55 hits on 2026-08-29; canonical profile NOT in the first 10 — scan before picking).
- `batch <id> --fields citationStyles.bibtex` → HTTP 400 "Unrecognized or unsupported fields: [citationStyles.bibtex]" — BibTeX is `get`-only (live 2026-08-29).

## References

- `references/api-notes.md` — full endpoint reference with request/response shapes, ID formats, rate limits, datasets/diffs workflows, and Semantic Reader / TLDR product notes, compiled from the official OpenAPI specs plus live-verified calls.
- Official docs: https://api.semanticscholar.org/api-docs/ (per-API specs at `/graph/v1/swagger.json`, `/recommendations/v1/swagger.json`, `/datasets/v1/swagger.json`)
- Tutorial: https://www.semanticscholar.org/product/api/tutorial | Examples/FAQ: https://github.com/allenai/s2-folks | Status: https://status.api.semanticscholar.org/
- Semantic Reader (augmented in-product reading: citation cards with TLDRs, Goal/Method/Result skimming highlights, definitions, Hypothesis annotation): https://www.semanticscholar.org/product/semantic-reader
- Open research platform (PaperMage + PaperCraft libraries for building readers): https://openreader.semanticscholar.org/