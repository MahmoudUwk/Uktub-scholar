# OpenAlex Reference — Works/Query Mechanics + Entities/Access Products

> Compiled 2026-08-28 from help.openalex.org raw-markdown pages (URL+.md), live-verified API calls, and the official LLM Quick Reference. Part 1: works endpoint + query mechanics. Part 2: entities, CLI, snapshot, fulltext, Unpaywall, OQL/OQO, pricing, corpus.

---

# OpenAlex API — Works Endpoint & Query Mechanics: Agent Reference

**Audience:** LLM agents and developers querying OpenAlex works programmatically.
**Base URL:** `https://api.openalex.org` · **Docs** (every page has a raw-markdown twin by appending `.md`): `https://help.openalex.org` · **Machine index:** `https://help.openalex.org/llms.txt`
**Auth:** API key is free and strongly recommended (10× the no-key budget; get one at openalex.org/settings/api). Send as `?api_key=KEY` or header `Authorization: Bearer <key>`. The legacy `mailto=` polite-pool parameter is **ignored** (replaced by API keys as of Feb 2026). Requests without a key still work, subject to budget/rate limits; 429 = over budget or >100 req/sec.
**Costs (per call):** singleton fetch `/works/W…` = **free** · list (`filter`) = **$0.0001** · `search`/`search.exact`/`search.semantic` = **$0.001** · PDF content download (content.openalex.org) = **$0.01**. Without a key, the free daily budget is $0.10; with a key, $1/day.
**Verified live:** all syntax below was checked against the official docs (help.openalex.org — every page downloadable as raw markdown by appending `.md`, e.g. `https://help.openalex.org/api/filtering.md`), and selected queries were executed against the live API (2026-08).

---

## 1. Endpoint index

All entity endpoints live under `https://api.openalex.org`. Query mechanics (`filter`, `search`, `sort`, `group_by`, paging, `select`) are identical across endpoints; only the filterable/sortable fields differ.

| Endpoint | List / single | What it returns |
|---|---|---|
| `/works` | `/works` · `/works/W…` | scholarly documents (articles, preprints, datasets, books…) |
| `/authors` | `/authors` · `/authors/A…` | researcher profiles |
| `/sources` | `/sources` · `/sources/S…` | journals, conferences, repositories |
| `/institutions` | `/institutions` · `/institutions/I…` | universities, companies |
| `/publishers` | `/publishers` · `/publishers/P…` | publishing organizations |
| `/funders` | `/funders` · `/funders/F…` | research funders |
| `/awards` | `/awards` · `/awards/G…` | specific grants |
| `/topics`, `/subfields`, `/fields`, `/domains`, `/keywords`, `/sdgs`, `/concepts` (deprecated) | aboutness | topic taxonomy (~4,500 topics; domain→field→subfield→topic) |
| `/work-types`, `/source-types`, `/institution-types`, `/countries`, `/continents`, `/languages`, `/licenses`, `/indexes` | vocabulary endpoints | controlled vocabularies |
| `/autocomplete/{entity}` | type-ahead | fast suggestions |
| `/text` | text classification | **deprecated** — do not use |

```bash
# An OpenAlex list response envelope: meta + results (+ group_by when grouping)
curl -s "https://api.openalex.org/works?filter=type:article&per_page=2&select=id,display_name"
```

`meta` contains: `count` (total matches), `db_response_time_ms`, `page`, `per_page`, `next_cursor` (cursor paging), `cost_usd` (e.g. `0.0001`). The `meta.x_query` object echoes back the query as OQL text and OQO JSON — useful for debugging.

---

## 2. OpenAlex IDs & fetching single entities

Every entity has an ID like `https://openalex.org/W2741809807` — a letter prefix + number. Prefixes:

| Prefix | Entity | Prefix | Entity |
|---|---|---|---|
| `W` | Work | `K` | Keyword |
| `A` | **Author** | `P` | **Publisher** |
| `S` | **Source** | `F` | **Funder** |
| `I` | **Institution** | `G` | Award/grant |
| `T` | **Topic** | | |

- Use the bare key (`W2741809807`) or the full URL (`https://openalex.org/W2741809807`) in the path; both work. IDs are **case-insensitive**.
- Singleton fetches are **free** and return the full entity object.

```bash
# By OpenAlex ID (recommended form)
curl "https://api.openalex.org/works/W2741809807"
curl "https://api.openalex.org/works/https://openalex.org/W2741809807"

# External-ID aliases — pass the full URL or the prefix:ID short form:
curl "https://api.openalex.org/works/https://doi.org/10.7717/peerj.4375"
curl "https://api.openalex.org/works/doi:10.7717/peerj.4375"      # works
curl "https://api.openalex.org/works/pmid:29456894"               # PMID (works)
curl "https://api.openalex.org/authors/https://orcid.org/0000-0001-6187-6610"  # ORCID (authors)
curl "https://api.openalex.org/institutions/https://ror.org/02y3ad647"         # ROR (institutions)
curl "https://api.openalex.org/sources/issn:0028-0836"             # ISSN (sources; canonical is ISSN-L)
```

- Canonical external IDs by entity: works → **DOI**, authors → **ORCID**, sources → **ISSN-L**, institutions → **ROR**, topics/publishers → Wikidata. `mag:` prefix (MAG ID) remains a documented work ids key/alias.
- **Merged entities:** requesting a retired/merged ID returns **HTTP 301** to the canonical ID (`Location:` header); HTTP clients normally follow it transparently. Handle redirects or follow manually.
- **Agent rule of thumb:** never filter by entity *names* (`author_name:Einstein` is invalid/unreliable) — resolve names to OpenAlex IDs first via `/authors?search=...`, then filter `authorships.author.id:A...`.

---

## 3. Filtering — full syntax

The `filter` parameter takes comma-separated `attribute:value` pairs. **Filters are case-insensitive.**

```
?filter=attribute:value,attribute2:value2
```

### 3.1 Operator syntax

| Operation | Syntax | Example |
|---|---|---|
| AND between filters | `,` (comma) | `filter=cited_by_count:>1,is_oa:true` |
| OR within one filter | `|` (pipe), **max 100 values** | `filter=type:article\|preprint` |
| AND within one filter | repeat the filter, or `+` | `filter=institutions.country_code:fr,institutions.country_code:gb` ≡ `filter=institutions.country_code:fr+gb` |
| Negation | prefix value with `!` | `filter=country_code:!us` (institutions), `type:!paratext` |
| Greater/less | `>` / `<` (numeric, year, date) | `cited_by_count:>100`, `publication_year:<2020` |
| Range | `lo-hi` on numeric/date | `publication_year:2020-2024`, `cited_by_count:5-20` |
| Date bounds | `from_publication_date:` / `to_publication_date:` | `from_publication_date:2022-01-01,to_publication_date:2022-01-26` |
| Equality (exact value) | plain `field:value` | `type:article`, `publication_year:2023` |

**Notes and gotchas:**
- **OR works within a filter, not between filters.** `filter=institutions.country_code:fr|primary_location.source.issn:0957-1558` is **invalid** (error). There is no cross-filter OR; no general parentheses groups for filters (parentheses are only in `search` boolean syntax).
- The `+` AND-within-filter syntax does **not** work for search filters, boolean filters, or numeric filters.
- To replicate "(A OR B) AND C" with filters, either put A/B as pipe-values of the **same** filter (`type:article|preprint,cited_by_count:>10`), or run two queries and union IDs client-side.
- The works filter vocabulary is large (~150 fields per the official works summary). There is no single documented enumeration page; fields mirror the work object attributes (Section 8), including dot-paths into nested objects and the synonyms table below. The list in Section 3.2 covers the practical agent set.
- Premium (paid plans) sync filters: `from_created_date:` / `from_updated_date:` (works too — poll-and-upsert). Also `collection:col_xxx` (Bearer-auth) filters by your saved collections.
- **Regex filter:** the task brief asked about `~=?`; the current documented syntax contains **no regex operator** (`~` is fuzzy/proximity in `search`, not in filters; `=` is just the filter's key:value separator). Closest capabilities are wildcard/fuzzy **search** and exact-value filters. Documented nowhere else; do not rely on regex in filters.

### 3.2 Most useful works filter fields (~60)

Grouped by purpose. Nested paths use dot notation and mirror the work object (Section 8).

**Core / pub metadata**
| Filter | Notes |
|---|---|
| `publication_year` | integer; supports `>`, `<`, ranges `2020-2024` |
| `publication_date` | ISO date `YYYY-MM-DD`; also `from_publication_date:` / `to_publication_date:` |
| `type` | one of the work-type vocabulary (Section 8.10) |
| `language` | ISO 639-1 code, e.g. `en` |
| `is_retracted` | boolean (Retraction Watch) |
| `is_paratext` | deprecated boolean → use `type:paratext` |
| `primary_location.source.id` | journal/venue S-id (replaces removed `host_venue.id`) |
| `primary_location.source.issn` | e.g. `0957-1558` |
| `primary_location.source.host_organization:P4310319965` | publisher P-id |
| `primary_location.license` | e.g. `cc-by` |
| `best_oa_location.license` | e.g. `cc-by`, `cc-by-nc`… |
| `locations.source.id` | any host location's source |
| `has_doi` / `has_abstract` / `has_fulltext` | booleans |
| `has_content.pdf` | downloadable PDF fulltext exists |
| `has_refereed_works` | peer-reviewed flag (documented in recipes) |
| `has_refereed_works` / `is_xpac` | `is_xpac` boolean on works in expansion corpus |
| `indexed_in` | `arxiv`, `crossref`, `doaj`, `pubmed`, `datacite` (full list: https://help.openalex.org/data/indexes.md) |
| `corpus=` parameter | `core` (default) / `expansion` / `all` — not a filter, a query param |

**Identity / links**
| Filter | Notes |
|-|-----|
| `doi` | full URL form `https://doi.org/10.xxxx/yyy` (or `10.xxxx/yyy`) — OR-batch up to 100. Canonical `doi` is always the **published** version; arXiv-DOI records (`10.48550/arxiv.<id>`) are **not** reliably directly fetchable — live 404 on `/works/doi:10.48550/arxiv.1706.03762` even though the canonical record carries that DOI as a *location* — so get by W-id or publisher doi: and read locations (or use the CLI's `arxiv` command). |
| `openalex` | filter by one or more W-ids, `openalex:W123|W456` |
| `ids.pmid` / `pmid` | PubMed id |
| `ids.mag` / `mag` | MAG integer id |
| `ids.pmcid` | PubMed Central id |

**arXiv–publisher DOI splits (cross-provider matching; S2 fusion):** a single work can carry *different* DOIs per `locations[]` entry (verified on W2626778328: locations include `http://arxiv.org/abs/1706.03762`, `https://doi.org/10.48550/arxiv.1706.03762`, and publisher DOIs; `ids` has **no** arXiv key — only openalex/doi/mag/pmid/pmcid live there). `indexed_in` may include `arxiv` (attribute, not deprecated; the `is_xpac` *filter* is what was deprecated). Matching recipe for OpenAlex-vs-S2 records with divergent DOIs: extract arXiv ids from `locations[].landing_page_url` (`arxiv.org/abs|pdf/<id>[vN]`) and from a `10.48550/arxiv.*` `doi` on preprint-type works, then join with S2's `externalIds.ArXiv`; fall back to normalized title + first-author family name. S2-provided CS DOIs (`10.5555/...`) did not match any OpenAlex work (filter=doi returned count 0). `locations.landing_page_url` exists as an *attribute* but is **not** in the documented location-filter list (`locations.is_oa/.version/.license/.license_id/.source.id/.source.type/.source.is_in_doaj/.source.is_core` + same under `primary_location.` / `best_oa_location.`) — do not advertise `locations.landing_page_url.search:` as a filter.

**People / orgs (always resolve to IDs first)**
| Filter | Notes |
|---|---|
| `author.id` / `authorships.author.id` | author A-id (shorthand exists) |
| `authorships.institutions.id` | institution I-id (shorthand `institutions.id` works too) |
| `institutions.country_code` / `authorships.countries` | `fr`, `gb`… |
| `institutions.is_global_south` | boolean |
| `raw_author_name.search` | byline string search (see Section 4.4) |
| `countries_distinct_count` | `>1` for international collaboration |
| `institutions_distinct_count` | int comparisons |
| `corresponding_author_ids` | author A-ids flagged corresponding |

**Topic / classification**
| Filter | Notes |
|---|---|
| `topics.id` / `topics.subfield.id` / `topics.field.id` / `topics.domain.id` | topic taxonomy filters |
| `primary_topic.id` | top-ranked topic |
| `topics.count` | number of topics (int) |
| `keywords.id` | keyword K-id |
| `concepts.id` | **deprecated** alias → `topics.id` |
| `mesh` | MeSH term (PubMed-sourced works) |
| `sustainable_development_goals.id` | SDG tagging |

**Access / citations / funding**
| Filter | Notes |
|---|---|
| `open_access.is_oa` | boolean |
| `open_access.oa_status` | `diamond`/`gold`/`green`/`hybrid`/`bronze`/`closed` |
| `open_access.any_repository_has_fulltext` | boolean |
| `is_oa` | shorthand for open_access.is_oa |
| `oa_status` | shorthand for open_access.oa_status |
| `cited_by_count` | int; `>10`, ranges |
| `cites:W…` | works citing a given work (incoming citations) |
| `cites:W1|W2` | union of citers of several works |
| `awards.funder_id` | funder F-id (replaces removed `grants`) |
| `awards.funder_award_id` | grant number e.g. `R01-GM123456` |
| `funders.id` / `funders.country_code` | funder filters |
| `apc_paid.provenance` | `openapc` for article-level APC data |

**Text-search filters (deprecated-ish; prefer `search=`)**
| Filter | Notes |
|---|---|
| `fulltext.search` / `fulltext.search.exact` | searches title+abstract+fulltext |
| `title.search` | title-only (deprecated suffix) |
| `display_name.search` | title-only, authors endpoint |
| `abstract.search` | abstract-only |
| `default.search` | deprecated alias of fulltext.search |
| `raw_author_name.search` | byline search, scoped with quotes (Section 4.4) |

```bash
# — Filter examples —
curl "https://api.openalex.org/works?filter=type:book"
curl "https://api.openalex.org/works?filter=cited_by_count:>1,is_oa:true"                 # AND
curl "https://api.openalex.org/works?filter=institutions.country_code:fr|gb"              # OR (within one filter)
curl "https://api.openalex.org/works?filter=institutions.country_code:fr+gb"              # AND within one filter
curl "https://api.openalex.org/works?filter=institutions.country_code:!us"                # negation
curl "https://api.openalex.org/works?filter=publication_year:2020-2024,cited_by_count:5-20"  # ranges
curl "https://api.openalex.org/works?filter=from_publication_date:2022-01-01,to_publication_date:2022-01-26"
curl "https://api.openalex.org/works?filter=doi:10.1371/journal.pone.0266781|10.1371/journal.pone.0267149&per_page=100"  # batch by DOI
curl "https://api.openalex.org/works?filter=openalex:W2100837269|W2134720587&per_page=100"            # batch by W-id
curl "https://api.openalex.org/works?filter=cites:W2741809807&sort=-publication_date"     # incoming citations
curl "https://api.openalex.org/works?filter=primary_location.source.id:S137773608"        # journal filter (S-id)
curl "https://api.openalex.org/works?filter=awards.funder_id:F4320306076,awards.funder_award_id:R01-GM123456"
curl "https://api.openalex.org/works?filter=topics.id:T10234"
curl "https://api.openalex.org/works?filter=open_access.oa_status:gold,best_oa_location.license:cc-by"
curl "https://api.openalex.org/works?filter=has_content.pdf:true,has_abstract:true,publication_year:>2019"
```

**Blast-radius note:** `publication_year:>2019` etc. are applied to the default (core) corpus. Expansion-corpus works (~193M, mostly datasets/single-repo records, `is_xpac:true`) are **excluded by default**; add `corpus=all` (or `corpus=expansion`) as a query parameter to include them. Legacy `include_xpac=true` is deprecated and cannot be combined with `corpus=`.

---

## 4. Searching

`search=` does full-text search. **Cost: $0.001/call (10× a filter-only call).**

### 4.1 What gets searched (works)
`title`, `abstract`, `fulltext` (when indexed). Other entities search their own name fields.

### 4.2 Text processing
- Stemming + stop-word removal ("the", "an" dropped; "possums" matches "possum").
- Whole-word matching only — `lun` does not match `lunar` (use wildcards for that).
- `search.exact=` disables stemming. **Only one search parameter per request**: `search`, `search.exact`, or `search.semantic`.
- Filter-based `.search:` / `.search.exact:` on any field is **deprecated** but still works — and bills at the **search tier ($0.001/call)**, verified live even with 0 results (verified: `filter=title.search:...` cost $0.001).
- Boolean operators `AND`, `OR`, `NOT` (must be uppercase); bare terms are treated as AND; `"..."` for phrases; parentheses group.

```bash
curl "https://api.openalex.org/works?search=dna"
curl "https://api.openalex.org/works?search=(elmo AND \"sesame street\") NOT (cookie OR monster)"
curl "https://api.openalex.org/works?search.exact=surgery"
```

### 4.3 Phrase, proximity, wildcards, fuzzy
- Phrase: `search="fierce creatures"` (exact phrase; unquoted = anywhere, ranked by proximity).
- Proximity within a phrase: `"climate change"~5` — words within N positions; `N` is a shared budget across the phrase.
- Two phrases near each other: `"machine learning"~5~"neural network"` — each phrase intact, operands within N words, either order.
- Wildcards (require `search.exact`, not default `search`): `*` = 0+ chars, `?` = exactly 1 char; ≥3 chars before wildcard; no leading wildcards.
- Fuzzy: `machin~1` allows up to N=0/1/2 edits; ≥3 chars before `~`.

```bash
curl "https://api.openalex.org/works?search=\"climate change\"~5"
curl "https://api.openalex.org/works?search=\"machine learning\"~5~\"neural network\""
curl "https://api.openalex.org/works?search.exact=machin*"
curl "https://api.openalex.org/works?search=machin~1"
```

### 4.4 search vs filter combination
- `search=` and `filter=` combine freely in one request; the filter narrows, the search ranks. Results are **sorted by `relevance_score` (descending)** when searching; `sort=relevance_score:desc` explicitly requires an active search (error without one).
- Score = text similarity + citation count.
- `fulltext.search:treatment,fulltext.search.exact:psoriat*` — combine a stemmed fulltext filter with a wildcard exact filter to mix stemmed and truncated terms.
- `raw_author_name.search:"jane smith"~1` — byline-scoped person search; quote to scope to one byline (unquoted tokens may match across different authors); `~N` allows middle names; `OR` between quoted phrases combines name forms ("j priem" OR "priem j"). Multiple `raw_author_name.search:` clauses AND together (usually returning nothing).
- Systematic-review pattern: a `search=` URL is capped ~4 KB; split large boolean OR-lists into chunks and union IDs client-side (each chunk is billed separately).
- Semantic search: `search.semantic=` (embeddings, meaning-based; max 2,000 chars input, max 50 results, 1 req/sec; `cited_by_count` and `last_known_institutions.country_code` filters unsupported with it — the API silently returns nothing for them; the CLI guards and errors instead). **Quality flag:** semantic search matches *meaning*, so it shines on long/broad conceptual queries ("predicting drug toxicity from molecular structure") but drifts on **niche technical queries** — fusion testing scored it 5/10 garbage on a niche wireless-penetration query where keyword `search=` was fine. Prefer `search=`/`search.exact=` or plain filters for narrow, term-heavy, or subdomain queries; reserve `search.semantic` for broad conceptual recall or long-text (abstract/grant-aim) queries.

**Live verification (2026-08-29), consumer-critical:** query *"how does early childhood education affect long-term earnings and life outcomes"*, `per_page=50`: 48 results (≤50 cap), `meta.cost_usd=0.001`, X-RateLimit headers present. (1) **`select=` works with `search.semantic`**: `select=id,title,publication_year,cited_by_count,doi,primary_location,authorships,open_access` returned **all 8 fields** on every result — `title` is accepted as a select alias and populated (the field list the UktubAI research-tools provider integration depends on). (2) **No `relevance_score` field is returned** — 0 occurrences in the raw response even without `select`; results arrive pre-ranked (top hits were the canonical on-topic papers: *Investing in Preschool Programs*, the Heckman *Early Childhood Intervention and Life-Cycle Skill Development*) but cannot be re-sorted, thresholded, or merged by score client-side. If a consumer needs scores, it must rank externally. (3) **1 req/s enforced**: of two simultaneously launched identical semantic calls, the second took ~4.9 s vs 0.9 s (429 + backoff; a retrying client absorbs it transparently).

```bash
# search + filter + sort together
curl "https://api.openalex.org/works?search=cancer&filter=publication_year:2023,type:article,open_access.is_oa:true,cited_by_count:>50&sort=-cited_by_count"
```

---

## 5. Paging

| Parameter | Default | Range / limit |
|---|---|---|
| `page` | 1 | `page × per_page` ≤ 10,000 (basic paging hard cap) |
| `per_page` | 25 | **1–100** (legacy `per_page=200` still accepted but deprecated — do not use) |
| `cursor` | — | `cursor=*` to start; follow `meta.next_cursor` until `null` (unlimited depth) |
| `sample` | — | random sample size, **max 10,000**; pair with `seed=` for reproducibility |
| `seed` | — | makes `sample=` deterministic |

```bash
# Basic paging (first 10,000 results only)
curl "https://api.openalex.org/works?filter=publication_year:2020&page=2&per_page=100"

# Cursor paging — step 1: start
curl "https://api.openalex.org/works?filter=publication_year:2020&per_page=100&cursor=*"
# step 2: take meta.next_cursor from the response, feed it back:
curl "https://api.openalex.org/works?filter=publication_year:2020&per_page=100&cursor=IlsxNjA5MzcyODAwMDAwLCAnaHR0cHM..."
# repeat until next_cursor is null and results empty

# Reproducible random sample
curl "https://api.openalex.org/works?filter=publication_year:2024&sample=100&per_page=100&seed=42"
```

- Use cursor paging for deep enumeration. Do **not** use it to download the entire dataset — OpenAlex wants you to use the free snapshot for bulk.
- For group_by results: **cursor paging only** (`page=2` is not supported for groups); max 200 groups/page.
- `sample=100&seed=42` with `per_page=100` returns a deterministic sample (live-verified 2026-08-29: two identical `sample=5&seed=42` calls returned the same W-id sequence).

---

## 6. Selecting fields

`select=` trims the response to listed **root-level** fields only. Dot notation for subfields is **NOT supported** (`select=open_access.is_oa` → error); select the parent object (`open_access`) instead. Works on list endpoints and single-entity fetches; **not** on `group_by` or autocomplete.

```bash
curl "https://api.openalex.org/works?filter=open_access.is_oa:true&select=id,doi,display_name&per_page=5"
# → results[] contains only id, doi, display_name. Cheap + fast for agent loops.
```

Response shape:
```json
{
  "meta": { "count": 121784387, "db_response_time_ms": 129, "page": 1, "per_page": 2, "next_cursor": null, "cost_usd": 0.0001 },
  "results": [
    { "id": "https://openalex.org/W3038568908", "doi": "https://doi.org/10.1585/pfr.15.2402039", "display_name": "Radiation Resistant Camera System for Monitoring Deuterium Plasma Discharges in the Large Helical Device" }
  ]
}
```

Verified live call (2026-08): `GET /works?filter=open_access.is_oa:true&select=id,doi,display_name&per_page=2` returned `meta.count = 121,784,387` OA works, `meta.cost_usd = 0.0001`, plus `meta.x_query` echoing the query as OQL/OQO.

---

## 7. Grouping

`group_by=<field>` aggregates and counts; combinable with `filter`. Response has `meta.count` (total matches), `meta.groups_count` (groups on current page only, may be null), and a `group_by` array of buckets.

Each group object: `key` (OpenAlex ID or raw value), `key_display_name` (display name; identical to key for non-entity values), `count`. (Live-verified 2026-08-29: `filter=publication_year:2024&group_by=topics.id` → a 200-bucket page of `{key, key_display_name, count}`, 10.7M works matched, cost $0.0001.)

```bash
# Count works by type
curl "https://api.openalex.org/works?group_by=type"
# Groups like: {"key": "article", "key_display_name": "article", "count": 202814957}

# By entity: key = OpenAlex ID, key_display_name = name
curl "https://api.openalex.org/works?group_by=authorships.institutions.id"
# {"key": "https://openalex.org/I136199984", "key_display_name": "Harvard University", "count": 1234567}

# With filters
curl "https://api.openalex.org/works?filter=publication_year:2023&group_by=type"
curl "https://apitwo.openalex.org/works?filter=author.id:A5023888391&group_by=open_access.is_oa"
```

**Unknowns:** hidden by default; append `:include_unknown` (`group_by=authorships.countries:include_unknown`). Unknown bucket keys: `"unknown"` for strings/IDs; **`-111` sentinel** for numeric fields (treat -111/-111.0 as unknown); boolean fields surface unknown as the `false` bucket. Empty nested arrays count as unknown.

**Paging:** ≤200 groups per page, `page=` not supported — use `cursor=*` + `next_cursor` like results. Groups are sorted by `key` (not count) when paging.

---

## 8. Work object attributes for LLM consumption

Canonical dictionary: `https://help.openalex.org/data/works/attributes.md` (append `.md` for raw markdown). Highlights agents rely on:

### 8.1 IDs
- `id` — `https://openalex.org/W2741809807`.
- `doi` — canonical external ID; **always the published version's DOI**; full URL form `https://doi.org/10.xxxx/yyy`.
- `ids` — object with keys `openalex`, `doi`, `mag` (MAG integer), `pmid`, `pmcid` (unknown keys omitted).
- `display_name` = `title` (identical).

### 8.2 Abstracts — inverted index ⚠️
`abstract_inverted_index` is an **inverted index**: `{word: [position, ...]}`. OpenAlex does not ship plaintext abstracts (legal reasons) — **agents must reconstruct** by placing each word at its listed position(s) and reading off positions in ascending order. Coverage: >60% of 2022 works, ~45% pre-2000. Occasionally carries trailing non-abstract text (section headings, keywords). Filter presence with `has_abstract:true`. Verified live: reconstructing `W2741809807` yields the correct abstract.

```python
def abstract_from_inverted_index(inv: dict) -> str | None:
    if not inv: return None
    pos = {}
    for word, idxs in inv.items():
        for i in idxs:
            pos[i] = word
    return " ".join(pos[i] for i in sorted(pos))
```

### 8.3 Open access
- `open_access.is_oa` — true if any free-to-read full text exists (broad definition: no pay or login).
- `open_access.oa_status` — `diamond` (no-APC fully-OA journal), `gold` (fully-OA journal), `green` (toll journal + free repo copy), `hybrid` (open license in toll journal), `bronze` (free on publisher page, no open license), `closed`.
- `open_access.oa_url` — best full-text URL (= URL of best_oa_location), may be PDF or landing page.
- `open_access.any_repository_has_fulltext` — repository copy exists ("shadowed green" OA not visible in oa_status).
- `primary_location` — location object closest to version of record; `best_oa_location` — best OA location (publisher > repository; publishedVersion > accepted > submitted; pdf_url preferred; PMC/arXiv rank above other repos; null if none).
- Location objects carry: `is_oa`, `landing_page_url`, `pdf_url`, `license`, `version`, host `source`.

### 8.4 Citations & related
- `cited_by_count` — number of citing works (int). **Treat as ordinal, not exact**: counts are built by reference-matching (source lists + PDF extraction; failed matches silently reduce the count), so absolute numbers trail publisher databases; per-provider divergence is normal (fusion testing saw up to 10x across providers on the same DOI; counts also change over time — `updated_date` moves with them). Never present it as an exact citation total; for high-stakes ranking cross-check a second provider or recompute from `cites:W…` + `group_by`. There is **no** `cited_by_api_url` attribute on work objects (recipes-era field; selecting it silently returns nothing).
- `counts_by_year` — citations per year, last 10 years, zero-years omitted.
- `cited_by_percentile_year` — min/max percentile vs same-year works.
- `fwci` — field-weighted citation impact (1.0 = world average).
- `citation_normalized_percentile` — `{value, is_in_top_1_percent, is_in_top_10_percent}`.
- `referenced_works` — list of W-ids this work **cites** (outgoing).
- `related_works` — algorithmically related works (recent, shared topics).
- Incoming citations: `cites:W…` filter (Section 3).

### 8.5 Other fields agents use
- `type` — controlled vocabulary (8.10); `language` (ISO 639-1 of metadata); `publication_date` (ISO 8601; earliest e-pub date), `publication_year`.
- `authorships[]` — author + institutions + countries + `is_corresponding`, capped at first 100 authors; `corresponding_author_ids`, `corresponding_institution_ids`.
- `institutions` — flattened convenience mirror of authorship institutions (backfilling, may be empty).
- `primary_topic` — top topic object incl. subfield/field/domain (same as `topics[0]`); `topics` up to 3; `keywords` (topic-derived, score-thresholded); `concepts` (legacy); `sustainable_development_goals` (score > 0.4); `mesh` (PubMed-sourced).
- `funders`, `awards` — funding (replaced removed `grants`).
- `has_content` — `{pdf: bool, grobid_xml: bool}`; `has_fulltext` — true if either; `content_urls` — `pdf`/`grobid_xml` URLs under content.openalex.org (key required, API-only, not in snapshot; $0.01/download).
- `is_retracted` (Retraction Watch); `is_xpac` — true for expansion-corpus works (excluded by default; `corpus=all` to include).
- `indexed_in` — subset of `arxiv`, `crossref`, `doaj`, `pubmed`, `datacite` (5 indexes; may include `arxiv` for works with an arXiv location).
- `biblio` — `{volume, issue, first_page, last_page}`; `apc_list` / `apc_paid` (`value`, `currency`, `value_usd`, `provenance`).
- `created_date`, `updated_date` (ISO 8601 UTC; changes with citation-count updates).

### 8.6 Reconstructing text from abstract_inverted_index (worked example)
```bash
curl "https://api.openalex.org/works/W2741809807?select=id,display_name,abstract_inverted_index"
# → place each word at its listed position(s), read positions in order (see 8.2)
```

### 8.7 Removed/deprecated work fields (as of 2026-08)
- **Removed** (error if used): `host_venue`, `alternate_host_venues` → use `primary_location` / `locations`; `grants` → `funders` + `awards`; `has_ngrams` filter → `has_fulltext`.
- **Deprecated but working:** `concepts`/`concepts.id` → `topics`/`topics.id`; `x_concepts` → topics; `last_known_institution` (singular) → `last_known_institutions`; `/text` endpoint → do not use; `is_paratext` → `type:paratext`; `include_xpac`/`is_xpac` filter → `corpus=` parameter; `mailto=` → API key.

---

## 9. Sorting

`sort=field:direction` — direction defaults to ascending; `:desc` for descending. Multi-key via commas. `relevance_score` requires an active `search=` (error otherwise).

```bash
curl "https://api.openalex.org/works?sort=cited_by_count:desc"
curl "https://api.openalex.org/works?search=bioplastics&sort=publication_year:desc,relevance_score:desc"
```

Common sortable: `display_name`, `cited_by_count`, `works_count`, `publication_date`, `relevance_score`. `sort=-publication_date` (leading minus) is also seen in official recipes — equivalent to `:desc`.

**`relevance_score` scale drift (owner's scoring study, 2026-08):** the score is only comparable *within* a single result set — across queries the absolute range drifts by an order of magnitude (observed **58–222** on one query and **910–3884** on another), so cross-query score comparison (merging two searches, caching scores, fusing ranked lists by score) is meaningless. **Citation-magnet inversion:** the score blends text similarity with citation count, so a heavily cited survey can outrank better-matching niche work — in the same study a Radiomics review (`cited_by_count` ≈ **5,752**) outranked directly on-topic federated-learning papers. Consumer consequence: never persist, compare, or sort on raw scores across queries; re-rank client-side (recency, `cited_by_percentile_year`, topic match) before fusion with other providers. Note `search.semantic` emits no score at all (Section 4.4).

---

## 10. Deprecations summary (checked api/deprecations.md)

| Feature | Status | Use instead |
|---|---|---|
| `host_venue`, `alternate_host_venues` | **Removed** | `primary_location`, `locations`; filter `primary_location.source.id:` |
| `grants` | **Removed** | `funders`, `awards` |
| `has_ngrams` (filter) | **Removed** | `has_fulltext` |
| Concepts (entity + `concepts.id` filter) | Deprecated | `topics` / `topics.id` |
| `x_concepts` | Deprecated | topics-based grouping |
| `last_known_institution` (singular) | Deprecated | `last_known_institutions` |
| `/text` endpoint | Deprecated | work's own `topics`/`keywords` |
| `include_xpac=true` / `is_xpac` filter | Deprecated | `corpus=core\|expansion\|all` (`is_xpac` *attribute* stays) |
| `mailto=` polite pool | Replaced (Feb 2026) | API key (`?api_key=` or Bearer header) |
| Filter aliases `concept.id`, `concepts.id`, `x_concepts.id` | Deprecated | `topics.id` |

---

## 11. Limits & error handling (cheat sheet)

| Limit | Value |
|---|---|
| OR values per filter | 100 |
| `per_page` max | 100 (200 legacy accepted, deprecated) |
| Basic paging depth | `page × per_page` ≤ 10,000 |
| Cursor paging | unlimited (follow `meta.next_cursor` until null) |
| `sample` max | 10,000 |
| `group_by` page size | 200 groups |
| Search URL length | ~4 KB total request URL; split huge boolean queries |
| Semantic search | 2,000 chars input, 50 results max, 1 req/s |
| Rate limit | 429 beyond budget or >100 req/sec |
| Cost per call | list $0.0001 · search $0.001 · PDF $0.01 · singleton free |

**X-RateLimit-* response headers (live-verified 2026-08-29 on singleton + billed calls):** `X-RateLimit-Limit` — daily credit limit (10000 with a free key); `X-RateLimit-Remaining` — credits left; `X-RateLimit-Credits-Used` — this call's credit cost (list=1, search/semantic=10, content=100, singleton=0); `X-RateLimit-Limit-USD` — dollar budget (1.0/day free); `X-RateLimit-Remaining-USD` — dollars left (e.g. `0.979`); `X-RateLimit-Cost-USD` — this call's dollar cost; `X-RateLimit-Reset` — seconds to the midnight-UTC reset; plus prepaid/one-time balances (`X-RateLimit-Prepaid-Remaining-USD`, `X-RateLimit-Onetime-Remaining`). Also declared exposed: `X-RateLimit-Credits-Required`, `X-RateLimit-Cost-Required-USD`, `Retry-After`. **Exception:** the `/rate-limit` endpoint itself returns **no** X-RateLimit headers — parse its JSON body (`rate_limit.daily_used_usd` / `daily_remaining_usd` / `endpoint_costs_usd` / `credit_costs`) instead.

Agent practice: retry 429/5xx with exponential backoff; `select=` aggressively; `per_page=100` default; batch ID lookups with `|` (≤100); resolve names → IDs before filtering; use `cursor=*` for deep paging; use the free snapshot for bulk downloads.

## 12. Source pages (raw markdown = URL + `.md`)

- https://help.openalex.org/api/filtering.md · api/searching.md · api/paging.md · api/selecting-fields.md · api/grouping.md · api/get-single-entities.md · api/sorting.md · api/endpoints.md · api/deprecations.md · api/llm-quick-reference.md · api/semantic-search.md
- https://help.openalex.org/data/works.md · data/work-types.md · data/works/open-access.md · data/locations.md · data/indexes.md · data/works/attributes.md · data/works/citations.md · how-to/api-recipes.md · access/example-costs.md
- Machine site index: https://help.openalex.org/llms.txt
---

# OpenAlex Non-Works Entities & Access Products — Agent Reference

Practical reference for coding agents working with OpenAlex. Compiled from help.openalex.org (served as raw markdown by appending `.md` to any URL). All facts below are sourced from those pages; source URLs cited per section.

**Key URLs cheat-sheet:**
- Base API: `https://api.openalex.org/` — list + single entity per entity type
- Docs as markdown: any page + `.md`, e.g. `https://help.openalex.org/data/authors.md` (single-entity pages like `/data/authors/attributes` do NOT resolve to `.md`; the entity overview page contains the full attribute dictionary inline — use that)
- Get a free API key: sign up at https://openalex.org, key at https://openalex.org/settings/api
- Usage dashboard: https://openalex.org/settings/usage ; programmatic: `curl "https://api.openalex.org/rate-limit?api_key=YOUR_KEY"`

**Entity ID prefixes:** `W` work · `A` author · `S` source · `I` institution · `T` topic · `K` keyword · `P` publisher · `F` funder · `G` award

---

## (a) Non-works entities: fields to select & filters that matter

### Common attributes (all entities)

From https://help.openalex.org/data/common-attributes.md and https://help.openalex.org/api/get-single-entities.md:

| Field | Type | Notes |
|---|---|---|
| `id` | string | OpenAlex ID as full URL, e.g. `https://openalex.org/A5023888391` |
| `ids` | object | External IDs; sub-fields filterable (e.g. `ids.openalex`) |
| `display_name` | string | Filterable, searchable via `search` param (`display_name.search` is deprecated) |
| `works_count` | int | Filterable/sortable/groupable |
| `cited_by_count` | int | Filterable/sortable/groupable |
| `summary_stats` | object | `2yr_mean_citedness`, `h_index`, `i10_index`; each sub-field filterable (e.g. `summary_stats.h_index:>40`). Not on works |
| `counts_by_year` | list | `{year, works_count, oa_works_count, cited_by_count}` ~10 years; sort direction inconsistent across entities — sort by `year` yourself |
| `created_date` | string | `YYYY-MM-DD` |
| `updated_date` | string | ISO 8601 UTC of last change (incl. citation recomputation) |

**Single-entity lookups are free** (any volume). Each entity's canonical external ID:
Works→DOI · Authors→ORCID · Sources→ISSN-L · Institutions→ROR · Topics→Wikidata · Publishers→Wikidata.

```bash
# Singletons — FREE:
curl "https://api.openalex.org/authors/A5023888391"
curl "https://api.openalex.org/authors/https://orcid.org/0000-0001-6187-6610"
curl "https://api.openalex.org/institutions/ror:00jmfr291"        # by ROR
curl "https://api.openalex.org/institutions/https://ror.org/02y3ad647"
curl "https://api.openalex.org/sources/issn:0028-0836"            # by ISSN
curl "https://api.openalex.org/works/doi:10.7717/peerj.4375"
# Merged entities 301-redirect to the surviving ID.
```

---

### Authors — `/authors`

Source: https://help.openalex.org/data/authors.md

**Select these (LLM-relevant):**

| Field | What it gives you |
|---|---|
| `id` | `A…` OpenAlex ID |
| `ids` | keys: `openalex`, `orcid`, (rarely) `scopus` |
| `display_name` | canonical name (most-frequent informative form across works) |
| `display_name_alternatives` | other name strings seen (matching aid) |
| `orcid` | ORCID as URL or null — **null far more often than expected**: only reaches OpenAlex attached to a work's metadata |
| `full_name` | name parsed from works; usually identical to display_name |
| `raw_author_names` | exact byline strings clustered into this author (disambiguation inputs) |
| `affiliations` | history: `{institution (dehydrated: id, ror, display_name, country_code, type, lineage), years}` — capped at ~last 10 years |
| `last_known_institutions` | dehydrated institutions from most recent work; empty/null if unknown |
| `topics` | ranked topics with `count` + subfield/field/domain |
| `topic_share` | author's share of world output per topic (`value`) |
| `x_concepts` | **deprecated** — use `topics` |
| `works_count`, `cited_by_count`, `summary_stats`, `counts_by_year` | common (above) |
| `works_api_url` | ready-made `works?filter=author.id:A…` URL |

**Most useful filters** (https://help.openalex.org/api/filtering.md): `has_orcid:true|false`, `orcid`, `last_known_institutions.id` (also `.ror`, `.country_code`, `.continent`, `.is_global_south`, `.type`, `.lineage`), `affiliations.institution.id/.ror/.country_code/.type/.lineage`, `works_count`, `cited_by_count`, `summary_stats.*`, `topics.id`, `topic_share.id`.

**Gotchas:** authors with `works_count:0` are hidden from list results by default. Author name search = `?search=einstein` (matches `display_name` + `display_name_alternatives`). For byline-as-published matching on works: `filter=raw_author_name.search:"john smith"` (quote to scope to one byline; unquoted tokens can match different authors).

---

### Sources — `/sources`

Source: https://help.openalex.org/data/sources.md and https://help.openalex.org/data/sources/attributes.md

Sources are identified primarily by ISSN; all ISSNs sharing an `issn_l` are merged into one source. Every source carries exactly one `type`.

**Select these:**

| Field | What it gives you |
|---|---|
| `issn_l` | linking ISSN — the canonical key (filter/sort/group) |
| `issn` | list of all print+electronic ISSNs; null for many repositories; use `has_issn` for presence |
| `type` | one of `journal`, `ebook platform`, `conference`, `repository`, `book series`, `other`, `metadata` |
| `is_oa` | fully-OA venue (every work OA) — ~65,000 sources |
| `is_in_doaj` | indexed in DOAJ (~23,000) — use when **legitimacy** matters (DOAJ vets; OpenAlex does no independent vetting) |
| `is_core` | on CWTS Core sources list (~36,000) |
| `is_in_scielo`, `is_ojs`, `is_preprint_repository` | provenance flags |
| `oa_flip_year` | year journal flipped to OA (hybrid→gold interpretation) |
| `host_organization` | publisher (or institution for repos) OpenAlex ID; denormalized `host_organization_name`, `host_organization_lineage` |
| `apc_prices`, `apc_usd`, `apc_usd_by_year` | APC list prices (DOAJ-sourced; one current-year price per journal) |
| `country_code`, `homepage_url`, `alternate_titles`, `abbreviated_title` | identity |
| `topics`, `topic_share` | aboutness |
| `first_publication_year`, `last_publication_year`, `oa_works_count` | coverage |
| `works_count`, `cited_by_count`, `summary_stats`, `counts_by_year` | common |

**Most useful filters:** `is_oa`, `is_in_doaj`, `type` (e.g. `type:journal`), `country_code`, `host_organization` / `host_organization.id` / `host_organization_lineage`, `issn` / `has_issn`, `is_core`, `is_in_doaj`, `is_retracted` (n/a here), `is_global_south`. Example from docs: `filter=is_in_doaj:true,type:journal`, `group_by=type`.

---

### Institutions — `/institutions`

Source: https://help.openalex.org/data/institutions.md

Grounded in ROR; a single org can also exist as funder/publisher (see `roles`).

**Select these:**

| Field | What it gives you |
|---|---|
| `ror` | canonical external ID, e.g. `https://ror.org/00jmfr291`; `has_ror:true|false` to select on presence |
| `country_code` | ISO 3166-1 alpha-2 (drives `continent`, `is_global_south` filters) |
| `type` | `education`, `healthcare`, `company`, `government`, `facility`, `nonprofit`, `other`, … |
| `lineage` | OpenAlex IDs of self + all ancestors (ROR hierarchy) — `lineage:<id>` finds it and everything beneath |
| `associated_institutions` | related orgs each with `relationship`: `parent`/`child`/`related` (column, not a filter) |
| `is_super_system` | umbrella systems excluded from some analyses |
| `geo` | `city`, `geonames_city_id`, `region`, `country_code`, `country`, `latitude`, `longitude` |
| `display_name_acronyms`, `display_name_alternatives` | matching aid |
| `repositories` | dehydrated sources for repos it hosts (filter: `repositories.id`, `repositories.host_organization`) |
| `roles` | other roles of same org: `{role: funder|institution|publisher, id, works_count}`; filter `roles.id` |
| `topics`, `topic_share` | aboutness |
| `status` | ROR lifecycle status, e.g. `active` |
| `ids` | keys: `openalex`, `ror`, `grid` (legacy), `wikipedia`, `wikidata`, `mag` |
| `works_count`, `cited_by_count`, `summary_stats`, `counts_by_year` | common |

**Most useful filters:** `country_code`, `type`, `is_global_south`, `continent`, `ror` / `has_ror`, `lineage`, `roles.id`, `repositories.id`, `topics.id`, `works_count`, `cited_by_count`, `summary_stats.*`, `status`.
**Useful patterns from docs:**
```
/institutions?filter=country_code:ca
/institutions?filter=type:company&sort=cited_by_count:desc
/institutions?filter=lineage:I27837315
/institutions?group_by=type
/institutions/ror:00jmfr291
```

---

### Topics — `/topics` (and hierarchy: `/domains`, `/fields`, `/subfields`)

Source: https://help.openalex.org/data/topics.md

~4,500 fine-grained subjects; hierarchy is **domain → field (26) → subfield (252) → topic**. Topics use `T####` IDs; domains/fields/subfields use bare numeric IDs. Replaces deprecated Concepts (~65,000, 6-level, MAG-derived). Concepts → Topics migration: `work.concepts`→`work.topics`, `concepts.id:C123`→`topics.id:T123`, `concepts[0]`→`primary_topic`.

**Select these:** `id`, `ids` (`openalex`, `wikipedia`), `display_name`, `description` (LLM-generated paragraph), `keywords` (short phrases on the topic itself), `subfield` (`id`,`display_name`), `field`, `domain`, `siblings` (other topics in same subfield), `works_count`, `cited_by_count`, `works_api_url`.

**Most useful filters:** on the Topics endpoint: `domain.id`, `field.id`, `subfield.id`, `works_count`, `cited_by_count`, `id`, `display_name`. On **Works** (the real usage): `primary_topic.id:T11636` (works whose primary topic), `topics.id:T11636` (topic in top three), roll-ups `topics.subfield.id`, `topics.field.id`, `topics.domain.id`.

---

### Publishers — `/publishers`

Source: https://help.openalex.org/data/publishers.md

**Select these:**

| Field | What it gives you |
|---|---|
| `ids` | `openalex`, `ror`, `wikidata` |
| `hierarchy_level` | 0 = root; +1 per step down to imprint |
| `parent_publisher` | OpenAlex ID of immediate parent (null for root) |
| `lineage` | full ancestry, self first — `lineage:P4310319965` finds a group + all its imprints |
| `country_codes` | **list** of ISO codes (multi-country publishers) — contrast with funder's single `country_code` |
| `alternate_titles` | other names / former names |
| `roles` | same-org roles elsewhere (`institution`, `funder`) |
| `sources_api_url` | convenience URL of hosted sources |
| `works_count`, `cited_by_count`, `summary_stats`, `counts_by_year` | common |

**Most useful filters:** `country_codes`, `hierarchy_level`, `ror`, `parent_publisher`, `lineage`. To find every source a publisher hosts: `filter=sources with host_organization.id:P…`; roll up imprint works via `lineage`.

---

### Funders — `/funders` (grants live on `/awards`)

Source: https://help.openalex.org/data/funders.md and https://help.openalex.org/data/awards.md

**Select these on funder:** `id`, `ids` (`openalex`, `ror`, `wikidata`, `crossref` (Crossref funder registry ID), `doi` (Funder DOI)), `display_name`, `alternate_titles` (acronyms like `NIH`), `description`, `country_code` (single ISO code), `is_global_south`, `awards_count` (distinct grants recorded), `homepage_url`, `image_url`/`image_thumbnail_url`, `works_count`, `cited_by_count`, `summary_stats`, `counts_by_year` (incl. `oa_works_count` per year), `roles`.

**Most useful filters:** `country_code`, `is_global_south`, `continent`, `ror`, `awards_count`, `roles.id`. Find works a funder funded: `works?filter=funders.id:F4320332161`.

**Awards entity (the individual grants, `G…` IDs):** `funder` (dehydrated: `id`, `display_name`, `doi`; filter `funder.id/.ror/.doi`), `funder_award_id` (funder's own grant number, e.g. `2r01ns050266-06`), `funder_scheme` (e.g. `R01`), `funding_type`, `amount` + `currency` (not converted across awards), `start_date`/`start_year`, `end_date`/`end_year`, `funded_outputs`/`funded_outputs_count`, `doi`, `landing_page_url`, `provenance`, `lead_investigator`, `co_lead_investigator`, `investigators`, `institution_awarded`, `primary_topic`, `topics`. Find works an award funded: `works?filter=awards.id:G…`. Note: work-level `grants` field was removed → `funders` / `awards`.

---

### Cross-entity tips

- **Autocomplete** (fast typeahead, ~200 ms, supports `q` + any filter/search, detects IDs): `https://api.openalex.org/autocomplete/institutions?q=flori` — returns `id`, `external_id`, `display_name`, `entity_type`, `cited_by_count`, `works_count`, `hint` (author→last known institution; source→host org; institution→location). Source: https://help.openalex.org/api/autocomplete.md
- **`select=` returns root-level fields only** — `select=open_access.is_oa` errors; select the parent object. Works on list + single entity; NOT on group_by or autocomplete. Source: https://help.openalex.org/api/selecting-fields.md
- **Deprecated across entities:** `x_concepts` (→ `topics`), singular `last_known_institution` (→ `last_known_institutions[0]`), `/text` endpoint ($0.01/req, deprecated), `concepts.id` filter aliases (→ `topics.id`). Source: https://help.openalex.org/api/deprecations.md
- Keyless budget exists ($0.10/day) but get a free key for $1/day (10×).

---

## (b) OpenAlex CLI (bulk downloads)

Source: https://help.openalex.org/access/cli.md

**What:** official command-line bulk downloader. Handles parallel downloads (up to 200 concurrent), checkpoint/resume, adaptive rate limiting, DOI auto-resolution, progress stats. **Work in progress**: currently focuses on work metadata + content downloads (CSV export and other entities coming).

**Install:**
```bash
pip install openalex-official
```

**Key commands:**
```bash
# Metadata for all works matching a filter:
openalex download \
  --api-key YOUR_KEY \
  --output ./results \
  --filter "topics.id:T10325"

# Metadata + PDFs:
openalex download --api-key YOUR_KEY --output ./results \
  --filter "topics.id:T10325" --content pdf

# Metadata + PDFs + TEI XML:
openalex download --api-key YOUR_KEY --output ./results \
  --filter "topics.id:T10325" --content pdf,xml

# By DOI list (auto-converts DOIs to OpenAlex IDs):
openalex download --api-key YOUR_KEY --output ./results \
  --ids "10.1038/nature12373,10.1126/science.1234567"

# Pipe in a list of work IDs:
cat work_ids.txt | openalex download --api-key YOUR_KEY --output ./results --stdin

openalex download --help   # full options
```

**Output layout:** one JSON per work next to any content files:
```
output/W2741809807.json      # metadata (always)
output/W2741809807.pdf       # if --content pdf
output/W2741809807.tei.xml   # if --content xml
```

**Costs:** metadata nearly free (~$0.10/1,000 list requests; single works by ID free) · PDFs $0.01 each · TEI XML $0.01 each. On the free $1/day key: metadata effectively unlimited-ish, ~100 content files/day.

**When to prefer it over raw API paging:** any bulk pull of works metadata (thousands–millions) and small-to-mid full-text pulls (up to a few million files). It parallelizes, checkpoints, rate-limits, and resolves DOIs for you — things naive `curl` loops get wrong. Use raw API for interactive single lookups (free) and small filtered lists; use the **snapshot** (section c) for the whole dataset.

---

## (c) Data snapshot (bulk)

Source: https://help.openalex.org/access/snapshot.md

**What:** the complete OpenAlex database as files on S3, **free, no AWS account**. As of June 2026 release: ~649M records per format.

| Format | Compression | Prefix | Compressed size |
|---|---|---|---|
| JSON Lines | gzip | `s3://openalex/data/jsonl/` | ~750 GB (works alone ~670 GB) |
| Apache Parquet | snappy | `s3://openalex/data/parquet/` | ~780 GB |

Several TB decompressed. One folder per entity type under each format: `works`, `authors`, `institutions`, `sources`, `publishers`, `funders`, `awards`, `topics`, `subfields`, `fields`, `domains`, `keywords`, `concepts`, plus lookup tables (`countries`, `continents`, `languages`, `licenses`, `sdgs`, type tables). Partitioned by `updated_date=YYYY-MM-DD`, part files up to 400k records. `works/` also carries `deleted_ids.csv` (cumulative deletion log). **Manifest is written last — if `manifest.json` exists, that format's data is complete.** Records have the same schema as API responses (`content_urls` absent — use `has_content`; some abstracts null; **no n-grams** — retired dataset).

**Download (free, anonymous):**
```bash
aws s3 sync "s3://openalex/data/jsonl" "openalex-snapshot/data/jsonl" --no-sign-request
```
Browse: https://openalex.s3.amazonaws.com/browse.html (transfer fees covered by AWS Open Data). 403 `AccessDenied` = you're sending signed requests; add `--no-sign-request`.

**Paid daily snapshot (Member+ plans):** rebuilt daily at `s3://openalex-snapshots/full/<date>/`; auth via `credential_process` in `~/.aws/config`:
```ini
[profile openalex]
credential_process = curl -sf -X POST "https://api.openalex.org/snapshots/credentials?api_key=YOUR_KEY"
```
```bash
aws s3 sync s3://openalex-snapshots/full/2026-04-29/jsonl/ ./snapshot-jsonl --profile openalex
```

**Read JSONL directly:**
```python
import gzip, json
with gzip.open("part_0000.gz", "rt") as f:
    for line in f:
        work = json.loads(line)
```
(DuckDB can query `read_json_auto('part_*.gz')` directly; Parquet loads into DuckDB/Spark/BigQuery.)

**When to use:** you want >10,000 works, whole-entity pulls, reproducible local corpora, or offline analytics. API cursor-paging through the whole dataset "takes days and hammers their servers" — the docs explicitly say don't. **Note:** snapshot contains ALL works incl. expansion (~510M) while the API defaults to core (~322M); filter locally on `is_xpac` to reproduce the API default view.

---

## (d) Fulltext / content archive

Source: https://help.openalex.org/access/fulltext.md

**What:** cached full-text content for **50M+ works** — PDFs (~250 TB) and TEI XML parsed by GROBID (~43M files, ~20 TB). PDFs retain original copyright; OpenAlex grants no extra rights — check `best_oa_location.license`.

**n-grams: RETIRED.** The old n-grams dataset is gone: no n-grams in the snapshot, and the `has_ngrams` filter is removed — migrate to `has_fulltext` (https://help.openalex.org/api/deprecations.md). There is no `/ngrams` endpoint anymore (404). The content archive (PDF/TEI XML) is the replacement full-text story.

**Option 1 — API (≤ ~10K files), $0.01/file:**
```bash
curl "https://content.openalex.org/works/W3038568908.pdf?api_key=YOUR_KEY"
curl "https://content.openalex.org/works/W3038568908.grobid-xml?api_key=YOUR_KEY"   # ⚠️ response is gzip-compressed; decompress before parsing (verified live 2026-08: 56KB gz -> 303KB TEI XML)
# find downloadable works:
# https://api.openalex.org/works?filter=has_content.pdf:true,publication_year:2024
# https://api.openalex.org/works?filter=has_content.pdf:true,best_oa_location.license:cc-by
```
Work objects expose `has_content` (`pdf`, `grobid_xml`) and `content_urls` (API-only, not in snapshot).

**Option 2 — CLI (up to a few million files):** `pip install openalex-official`, then
```bash
openalex download --api-key YOUR_KEY --output ./climate-pdfs \
  --filter "topics.id:T10325,has_content.pdf:true" --content pdf
```
A few million files in a few days at full speed; $0.01/file.

**Option 3 — full archive sync (annual plans + PDF sync add-on, contact sales):** read-only Cloudflare R2 (S3-compatible) credentials:
```bash
aws s3 sync s3://openalex-pdfs ./pdfs \
  --endpoint-url https://<account>.r2.cloudflarestorage.com
```
1–2 weeks for the full archive. Files are UUID-named; map work→file via the bucket manifest `s3://openalex-pdfs/_manifest/content_index/` (daily Parquet: columns `openalex_id`, `pdf_uuid`, `grobid_xml_id`, `updated_date`; queryable with DuckDB). **Do not** map via `locations[].pdf_url` — that's the original publisher URL.

**TEI quality:** GROBID output passed through unchanged incl. errors; no OCR (scanned PDFs yield nothing); drop references whose DOI equals the work's own DOI; cross-check header metadata vs the work record. No Markdown parses yet (roadmap) — roll your own with Marker/Docling/MinerU.

---

## (e) Unpaywall inside OpenAlex

Source: https://help.openalex.org/access/unpaywall.md

**Key fact:** Unpaywall is **not a separate database**. Since the Walden rewrite, Unpaywall records are served from the same OpenAlex data — it's a legacy-compatible *format* over OpenAlex data. The OA facts in an Unpaywall record and in a work's `open_access` object come from the same pipeline. For new projects use the OpenAlex API directly; the Unpaywall format is for integrations that already speak it.

**Unpaywall surfaces:** REST `api.unpaywall.org/v2/{DOI}?email=you@example.com` (Unpaywall data format), Simple Query Tool (≤1,000 DOIs by email), browser extension, subscriber Data Feed (daily changes, Crossref-DOI works only, Unpaywall schema).

**How the `oa` fields map (work object `open_access`, from https://help.openalex.org/data/works/open-access.md and /data/works/attributes.md):**

| OpenAlex field | Meaning |
|---|---|
| `open_access.is_oa` | any free, legal fulltext exists (broad def: readable w/o payment or login) — ~121M of ~322M works (37%) |
| `open_access.oa_status` | `diamond` (~17M, no APC) · `gold` (~15M) · `green` (~66M, free copy in repo) · `hybrid` (~9M, open license in toll journal) · `bronze` (~14M, free w/o license) · `closed` (~202M) |
| `open_access.oa_url` | best fulltext link (= `best_oa_location`'s URL) |
| `open_access.any_repository_has_fulltext` | "shadowed green" OA hidden behind a publisher copy |
| `best_oa_location` | ranked: publisher-hosted > repository; publishedVersion > accepted > submitted; has `pdf_url` > not; DOI-matched repo > title; PMC/arXiv rank high |
| `locations[]` | every copy: `is_oa`, `landing_page_url`, `pdf_url`, `license`, `version`, host `source` (`source.type` splits publisher vs repository; preprint servers count as repositories) |

Unpaywall-format-only extra: `oa_date` (when first free at that location; null for bronze; reliable for repo copies first observed ≥ 2020-08-07). **Coverage:** Crossref-DOA DOIs only — DataCite DOIs excluded (treat them as OA); register-agency check via `https://api.crossref.org/works/{DOI}/agency`.

---

## (f) OQL / OQO in brief

Sources: https://help.openalex.org/access/oql.md, https://help.openalex.org/access/oql-spec.md, https://help.openalex.org/access/oqo-schema.md, https://help.openalex.org/api/oql.md

**OQL** = OpenAlex Query Language — human-readable queries: `works where title has ("climate change") and year >= (2020) and open access is (true)`. Shape: `<entity> where <filters> [group by <dims>] [sample <n> [seed <s>]]`. Can express things classic URL filters can't: deep nesting, OR across different fields, proximity (`title has (within 3 ("smart","phone"))`), wildcard `"wom?n"`, semantic search (`title/abstract is similar to ("…")`), negation (`not` inside parens). Bare words stem; quotes = exact. Loud errors with fix-its (no silent wrong answers). Sort/select are NOT part of OQL — sibling `?sort=`/`?select=` params.

**OQO** = OpenAlex Query Object — the machine-readable JSON twin (`{"get_rows": "works", "filter_rows": […]}`), schema at `https://openalex.org/schemas/oqo/v1.4`. Canonical internal form; OQL↔OQO round-trips (`OQO → OQL → OQO` is identity). **Built for agents:** generating/validating JSON against a schema beats generating query-language strings. OQO describes *which rows*; sort/select/pagination travel as sibling params.

**When an agent should care:** prefer OQO (validate against schema) or OQL (readable, more expressive than URL filters) when queries need nested boolean logic, cross-field OR, or proximity; use classic URL syntax for simple backward-compatible filters. Execute at the API **root** (query carries its own entity), not `/works`:
```bash
curl -G "https://api.openalex.org/" --data-urlencode "oql=works where year is (2020)"
# translate/validate without running:
curl "https://api.openalex.org/query/oql/works%20where%20year%20is%20(2020)"
# long queries: POST JSON {"oql": ...} or {"oqo": ...} to /
```
Every response echoes all three forms in `meta.x_query`. Value validation is strict: closed vocabularies need canonical codes (`country is ca`, not `Canada`; `uk` is invalid → `gb`); IDs are shape-checked per prefix (A/W/S/I/T/P/F/G/C).

---

## (g) Pricing & staying cheap

Sources: https://help.openalex.org/access/pricing.md, https://help.openalex.org/access/example-costs.md, https://help.openalex.org/api/authentication.md

**Budgets:** Free key = **$1/day** (resets midnight UTC) · no key = $0.10/day · prepaid in $1 increments (expires 3 months after last purchase) · Annual: Member $5,000/yr ($20/day) · Member+ $10,000/yr ($100/day, + daily snapshot & sync filters) · Partner from $20,000/yr ($200+/day). Data itself is CC0 and free; you pay for *serving/usage*.

**Per-operation rates:**

| Operation | Cost per 1,000 calls |
|---|---|
| Single entity by ID/DOI | **Free** |
| List + filter | **$0.10** |
| `search` (full-text) | **$1** |
| `search.semantic` | **$1** |
| Content download (PDF/TEI) | **$10** (i.e. $0.01 each) |
| `/text` aboutness (deprecated) | $10 |

**What the free $1/day buys:** single lookups unlimited · 10,000 list+filter calls (1M results w/ per_page=100) · 1,000 searches (100k results) · 100 PDFs. Example: "All works from Harvard" = 8,707 calls, 870,627 results = **$0.87** (fits in one free day, barely).

**What burns budget fast:**
1. **`search`** — 10× the cost of a filter. If a filter can express it, filter.
2. **Content downloads** — 100× list calls; $0.01 per PDF adds up past ~100/day free.
3. **`per_page` below 100** — cost is per request, not per result; `per_page=25` quadruples cost per result.
4. **Browsing openalex.org** draws the same budget (a website search ≈ 18 credits vs 10 for direct API search).
5. Over-fetching fields — big responses are slower (not billed differently, but pages count the same).

**How to stay cheap (from the docs' own best practices):**
- `per_page=100` always (hard max).
- Batch ID lookups with OR syntax (up to 100 values per filter) — `filter=ids.openalex:A1|A2|…`; fetching single works by ID/DOI is free, so prefer singletons/or-lists.
- `select=id,display_name,...` to trim payloads (root-level fields only).
- Use `filter` not `search` whenever possible; use `autocomplete` for UI typeahead.
- Cursor-paging beyond 10,000 results (basic paging caps at `page*per_page ≤ 10,000`; `per_page` max 100; `sample` max 10,000; OR values max 100/filter; 100 req/s).
- Watch `X-RateLimit-Remaining-USD` / `X-RateLimit-Remaining` / `meta.cost_usd` (header semantics: Section 11); check `https://api.openalex.org/rate-limit?api_key=KEY` (JSON body only — it emits no headers); backoff on 429 (semantic is additionally capped at 1 req/s).
- Anything > 10k results → snapshot or CLI, not API paging.

---

## (h) Works corpus: core vs expansion

Source: https://help.openalex.org/data/works/corpus.md

**Two corpora:** **core** = curated catalog, 320M+ works (Crossref, MAG, PubMed, DataCite) — **the default**. **expansion** = ~190M rawer works added in the Nov 2025 Walden update, mostly datasets and single-repository records; formerly called **XPAC** ("Expansion Pack" — the name survives in the `is_xpac` field). **all** = core + expansion, 510M+.

```bash
curl "https://api.openalex.org/works"                    # core (default), ~322M
curl "https://api.openalex.org/works?corpus=all"         # ~510M
curl "https://api.openalex.org/works?corpus=expansion"   # expansion only
```
`corpus` composes with filters (`?filter=has_abstract:true&corpus=all`); it's a **works-only** parameter (other entities reject it). Each work carries `is_xpac` (boolean) so `corpus=all` responses still identify expansion records.

**Deprecated legacy controls** (still work, error if mixed with `corpus=`): `include_xpac=true` (= `corpus=all`), `filter=is_xpac:true&include_xpac=true` (= `corpus=expansion`). The `is_xpac` *attribute* itself is NOT deprecated.

**In OQL:** `works` (core) · `works (expansion corpus)` · `works (all corpora)`.

**When to care:** counts that look surprisingly low (API default hides expansion) or suddenly double (someone added `corpus=all`) are usually the corpus. Careful bibliometrics / well-described literature → stay on core (expansion metadata is thinner and noisier). Casting the widest net (dataset hunting, total-coverage measurement) → `corpus=all`. The snapshot contains all 510M works — replicate the API default by filtering on `is_xpac:false`.

---

*Compiled 2026-08-28. All content sourced from help.openalex.org pages fetched as raw markdown (URLs cited per section). Live API verification: works list `meta.count` = 322,154,219 (core default) confirming core-corpus default.*