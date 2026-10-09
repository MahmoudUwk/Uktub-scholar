---
name: openalex
description: Query OpenAlex scholarly graph, 250M works, CC0.
version: 0.3.0
author: Mahmoud Sallam (mahmoudsallam), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [openalex, papers, authors, citations, open-access, research, api, datasets]
    related_skills: [semantic-scholar, arxiv, crawl4ai]
---

# OpenAlex Skill

Query OpenAlex — the fully open (CC0) scholarly graph of 250M+ works, authors, sources, institutions, topics, publishers, and funders — through a tested stdlib-only CLI. Complements semantic-scholar: CC0 licensing, richer OA data (Unpaywall built in), institution/funder/award entities, precise per-request cost model instead of opaque rate limits. Docs are agent-first: every help.openalex.org page is raw markdown at URL + `.md`.

## When to Use

- Find works with precise filters (year, venue, author, institution, OA status, type, citations, funding)
- Resolve names to IDs and vice versa (ORCID, ROR, ISSN, DOI aliases; autocomplete for typeahead)
- Bibliometrics: group_by aggregations, citation distributions, institution/funder output
- Download OA PDFs or GROBID TEI XML for specific works
- Track a daily query budget precisely (every response reports its cost)
- Don't use for: citation contexts/sentences (use semantic-scholar), AI TLDRs (use semantic-scholar), huge bulk pulls (use the free S3 snapshot, see reference)

## Prerequisites

- python3 (stdlib only: urllib, json, argparse)
- API key (free, 10x budget): https://openalex.org/settings/api -> export OPENALEX_API_KEY
- Budget: $1.00/day free with key ($0.10/day keyless), resets midnight UTC
- Cost per call: singleton get = FREE; list/filter = $0.0001; search = $0.001; PDF/TEI = $0.01
- 429 = over daily budget OR >100 req/s. Hard caps: per_page 100, OR values 100/filter, sample 10000, basic paging 10,000 (cursor beyond)

## How to Run

All commands go through the `terminal` tool:

```
terminal(command="OPENALEX_API_KEY=<key> python3 <skill_dir>/scripts/openalex.py list works --filter \"publication_year:2024,is_oa:true\" --per-page 100")
```

Never hardcode the key in files. Output is one JSON object on stdout with `meta` (count, cost_usd), `results`, and `budget` headers. Errors go to stderr, exit code 2. Check `rate` for `daily_used_usd`/`daily_remaining_usd`.

## Quick Reference

```
# LIST / FILTER / SEARCH any of: works authors sources institutions topics publishers funders
... list works --filter "publication_year:2024,is_oa:true" --sort cited_by_count:desc --per-page 100
... list works --search "microplastics"                  # relevance search ($0.001)
... list authors --search "Einstein"                     # STEP 1: resolve name -> ID
... list works --filter "authorships.author.id:A50..."   # STEP 2: filter by ID (golden rule)
... list works --filter "doi:10.1234/a|10.1234/b" --per-page 100    # OR-batch up to 100
... list works --filter "openalex:W123|W456"             # batch by W-id (same OR rules)
... list works --filter "cites:W2741809807"              # incoming citations
... list works --sample 100 --seed 42                    # reproducible random sample
... list works --filter "..." --group-by publication_year           # aggregations
... list works --cursor "*" ...                          # deep paging (>10k results)
# GET one entity (FREE): OpenAlex ID or external alias
... get works W2963341956 | doi:10.18653/v1/N19-1423 | https://doi.org/...   # 'full' keeps every field
... get works arxiv:1706.03762                          # arXiv alias -> 10.48550/arxiv.<id> (may 404; prefer the arxiv command)
... get authors orcid:0000-0001-9487-6983 | institutions ror:042nb2s44 | sources issn:2167-8359
# EXTRAS
... abstract W2741809807         # abstract reconstructed from abstract_inverted_index
... arxiv W2626778328            # cross-provider bridge: extract arxiv ids (free get)
... arxiv 10.48550/arXiv.1706.03762  # arxiv:<id>, bare arXiv DOI, arxiv.org URL: answered locally, no API call
... autocomplete "flori" --entity institutions   # fast typeahead, detects pasted IDs
... rate                         # remaining daily budget
... pdf W4393935425 --out f.pdf  # OA PDF ($0.01; pick works with has_content.pdf:true)
```

Filter syntax: `a:x,b:y` AND; `a:x|y|z` OR (<=100, within one filter only — no cross-filter OR); `a:x+y` AND-within; `!x` negation; `>100`, `<2020`, `2020-2024` comparisons; `from_publication_date:`/`to_publication_date:`; dot-paths for nested fields; `sort=-field` also valid (official recipes). Any `.search:`/`.search.exact:` filter bills at search tier ($0.001), even with 0 results. Key works filters: `publication_year, publication_date, type, language, is_retracted, is_oa, oa_status, cited_by_count, has_doi, has_abstract, has_fulltext, has_content.pdf, primary_location.source.id, authorships.author.id, authorships.institutions.id, institutions.country_code, topics.id, primary_topic.id, funders.id, awards.funder_id, cites:W-id`. Search extras: `--search-exact` (no stemming, wildcards `*` `?`), `--search-semantic` (embeddings, max 50 results). Corpus param: core (default ~322M) | expansion | all (~510M).

## Procedure

1. **Search works** — prefer `--filter` ($0.0001) over `--search` ($0.001) when keywords map to filters. Filters AND with commas; OR only within one filter via pipes; "(A OR B) AND C" works when A/B share a field. `--per-page 100` always (cost is per request, not per result).
2. **Resolve names to IDs first** — never filter by name. `list authors --search "..."` or `autocomplete` -> take the `id` -> filter `authorships.author.id:`. Same for institutions (ror), sources (issn), funders.
3. **Enrich known works** — batch via `filter=doi:10.x/a|10.x/b|...` (<=100, $0.0001) or free singletons `get works doi:...`. `cites:W-id` for incoming citations; `referenced_works` field for outgoing. `filter=openalex:W1|W2` batches by W-id.
4. **Cross-provider dedup (S2/arXiv) — DOI-only matching misses ~14% of pairs.** One work carries one `doi` row but multiple `locations[]` with different DOI landing pages: `locations[].landing_page_url` can hold both `arxiv.org/abs/<id>` and `doi:10.48550/arxiv.<id>` AND the publisher DOI (verified on W2626778328: `indexed_in:['arxiv','crossref']`, 11 locations incl. arXiv). `arxiv <W-id|doi:...>` (free) extracts arXiv ids for you; in bulk use `--select-compact`. Match recipe: extract arXiv ids on both sides (OA via the regex/`arxiv` command; S2 via `externalIds.ArXiv`) and join on them; if neither side has DOI match nor arXiv id, fall back to normalized title (lower, strip punctuation) + first-author family name. S2's CS record DOIs (`10.5555/...`) never match OpenAlex — expect title matching there.
5. **Read abstracts** — `abstract <W-id>` reconstructs plaintext from `abstract_inverted_index` (word->positions map; OpenAlex never ships plaintext). Presence: `has_abstract:true`. Sanity-check: some records carry front-matter junk instead of the real abstract; cross-check the title.
6. **Bibliometrics** — `--group-by <field>` returns `{key, key_display_name, count}` buckets; cursor-paged (200/page). Numeric unknowns surface as `-111`; add `:include_unknown` to see them.
7. **Deep pagination** — basic `--page` caps at 10,000; start cursor paging with `--cursor "*"` and feed back `meta.next_cursor` until null. For millions of rows use the official CLI (`pip install openalex-official`) or the free S3 snapshot (see reference) — the docs explicitly say don't cursor-pag the whole dataset.
8. **Corpus choice** — default is the curated core corpus; counts look ~60% smaller than `corpus=all` (adds the expansion corpus of datasets/repo records, flagged `is_xpac`). Never mix corpus values when comparing numbers. Legacy `include_xpac=true` is deprecated.
9. **PDFs/TEI** — `pdf <W-id>` ($0.01). Pick candidates with `has_content.pdf:true` (plain `is_oa` is NOT sufficient — many OA works are not in the content store; 404 "Work not found in content index" otherwise). TEI XML: same URL with `.grobid-xml` (response is gzip-compressed — decompress before parsing).
10. **Verify** — `rate` shows budget and per-endpoint costs; every response carries `meta.cost_usd` and X-RateLimit headers.

## Pitfalls

- **Filter by IDs, never names** — OpenAlex's own #1 documented mistake.
- **`select=` accepts root-level fields only** — `select=open_access.is_oa` errors; select the parent (`open_access`). Not available with group_by.
- **Budget math**: search = 10x a filter call, PDFs = 100x. The free $1/day = ~10,000 filter calls OR ~1,000 searches OR ~100 PDFs. Singleton gets are free — use them for one-offs. Billed responses' `budget` block carries `X-RateLimit-Limit` (10000 credits/day), `-Remaining`, `-Credits-Used` (list=1, search/semantic=10, content=100), `-Limit-USD` (1), `-Remaining-USD`, `-Cost-USD`, `-Reset` (secs to the midnight-UTC reset); the `/rate-limit` endpoint itself emits no headers — parse its JSON instead.
- **Basic paging dies at 10,000 results** (page*per_page cap) — switch to `--cursor`.
- **Abstract text is not stored** — always reconstruct (the `abstract` command does it); ~40-55% of works have no abstract at all (`has_abstract:true` to filter).
- **`is_oa` != downloadable**: PDF endpoint needs `has_content.pdf:true`, not just `is_oa:true`.
- **Deprecated/removed**: `host_venue` (removed -> `primary_location`), `grants` (removed -> `funders`/`awards`), `concepts`/`x_concepts` (deprecated -> `topics`), `has_ngrams` (removed -> `has_fulltext`), `/text` endpoint (do not use), `mailto=` (ignored since Feb 2026 -> use key).
- **`search` params are exclusive**: only one of search / search.exact / search.semantic per request; search URLs cap ~4KB (split big OR-lists).
- **Merged IDs return 301** redirects to the canonical ID — follow them.
- **`cited_by_count` is ordinal, not exact** — it counts matched reference lists (Crossref/PDF extraction; matches can fail), so absolute numbers trail publisher counts. Any single-field metric can also be inflated by entity conflation (up to 10x divergence across providers was observed in fusion testing; counts also move — `updated_date` changes with them). Use it to *rank*, never to report; there is no `cited_by_api_url` field (silently ignored if requested). For high-stakes ranking, cross-check a second provider or recompute via `cites:` + `group_by`.
- **`relevance_score` (keyword `search=`) has a per-query scale** — descending within one result set, but the absolute range drifts per query (observed 58–222 on one query, 910–3884 on another): never compare, merge-sort, or cache scores across queries. `search.semantic` emits no score at all. Re-rank client-side (recency, `cited_by_percentile_year`, topic match) instead of on raw scores.
- **Cross-provider (S2) dedup: DOI-only matching misses the arXiv split** (~14% of same-work pairs). OA `doi` = publisher DOI; the arXiv variant lives only in `locations[].landing_page_url` / a `10.48550/arxiv.*` `doi` on preprint-type records. Extract arXiv ids from locations (see step 4) or fall back to normalized-title + first-author matching; `indexed_in:arxiv` tells you a work HAS an arXiv record but is not a join key. S2 CS DOIs (`10.5555/...`) never match.
- **`search.semantic` is for broad conceptual queries only** — GTE-Large title+abstract embeddings; long-tail/noisy on niche technical queries and hard-term queries (fusion testing: 5/10 garbage on a niche wireless query where keyword search was fine). Cap 50 results, 2,000 chars. For niche queries prefer `--search` / `--search-exact` with boolean operators, or `--filter`. Live 2026-08: semantic results carry **no `relevance_score` field** (trust the returned order — top hits were the canonical on-topic papers) while `--select` works with it (all requested root fields returned, `title` accepted). Two parallel semantic calls: the 2nd stalled ~4 s (1 rps) and recovered via the CLI's 429 retry. Citation magnets can still outrank better matches: in the owner's scoring study a Radiomics review (cited_by_count ≈ 5,752) outranked on-topic federated-learning work.
- **Untrusted text**: fields pass through unsanitized; escape before HTML/SQL use.
- Do NOT put the API key in files; pass via env var per invocation. Rotate instantly at openalex.org/settings/api if leaked.

## Verification

- `rate` returns `daily_budget_usd: 1` with the key set.
- `get works doi:10.7717/peerj.4375` resolves; `get institutions ror:042nb2s44` returns MIT (I63966007).
- `abstract W2741809807` returns "Despite growing interest in Open Access (OA)..." (The state of OA, Piwowar 2018).
- `list authors --search Einstein` returns A-ids; `autocomplete "flori" --entity institutions` returns University of Florida.
- `list works --cursor "*"` returns `meta.next_cursor`.
- `list works --filter "cites:W2741809807"` returns works citing that paper.
- `arxiv W2626778328` returns `arxiv_ids: ["1706.03762"]` (Attention Is All You Need; free get).
- `arxiv 10.48550/arXiv.1706.03762` (and `arxiv:<id>`, arxiv.org/abs|pdf URLs) returns `arxiv_ids: ["1706.03762"]`, normalized locally with no API call (the arXiv-DOI record itself 404s).
- `list works --filter "publication_year:2024" --group-by topics.id` → a 200-bucket page of `{key, key_display_name, count}` (10,729,983 works in 2024), cost $0.0001.
- `list works --filter "publication_year:2024" --sample 5 --seed 42` run twice → identical W-id sequence.
- `list works --cursor "*" --per-page 1` → `meta.next_cursor` (base64) present; count 321,635,641 (core).
- `list works --search-semantic "how does early childhood education affect long-term earnings and life outcomes" --per-page 50` → 48 results (≤50 cap), $0.001, X-RateLimit headers present, NO `relevance_score` field; results pre-ranked (canonical ECE/Heckman papers first). A second parallel semantic call stalled ~4 s (1 rps) and recovered via the CLI's 429 retry.
- same query + `--select id,title,publication_year,cited_by_count,doi,primary_location,authorships,open_access` → all 8 fields returned on every result (`title` accepted as a select alias) — the select list the UktubAI research-tools consumer depends on works with search.semantic.
- `get funders ror:01cwqze88` → National Institutes of Health (F4320332161); `get sources issn:2167-8359` → PeerJ (S1983995261).

## References

- `references/api-notes.md` — complete reference: works filters (~60 fields), search/wildcard/proximity syntax, paging/grouping, entity field dictionaries (authors/sources/institutions/topics/publishers/funders/awards), OA/Unpaywall mapping, CLI + snapshot bulk workflows, OQL/OQO, pricing worked examples, deprecations table — with source URLs.
- LLM quick reference (official, agent-optimized): https://help.openalex.org/api/llm-quick-reference.md
- Machine index: https://help.openalex.org/llms.txt (any page + `.md` = raw markdown)
- OpenAPI spec: https://help.openalex.org/openapi.json
- Get a key: https://openalex.org/settings/api | Usage: https://openalex.org/settings/usage