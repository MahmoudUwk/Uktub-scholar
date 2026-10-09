# Semantic Scholar: API + Product Reference

> Compiled 2026-08-28 from the official OpenAPI specs, product pages (crawl4ai), and live-verified API calls. Round-2 live re-verification + module-quirk fold-in: 2026-08-29. Part A: full API reference. Part B: rate limits, datasets, Semantic Reader, TLDRs.

---

# Semantic Scholar API — Complete Reference (Academic Graph, Recommendations, Datasets)

> Research compiled 2026-08-28 from the official OpenAPI specs (downloaded live from
> `https://api.semanticscholar.org/{graph|recommendations|datasets}/v1/swagger.json`), the official
> tutorial (https://www.semanticscholar.org/product/api/tutorial), and **live API calls**.
> Verification legend: ✅ = behavior confirmed by a live API call on 2026-08-28; 📄 = documented in the
> official OpenAPI spec / tutorial (not independently live-tested); 🧪 = pinned by the UktubAI research-tools
> module (live-verified + test-pinned; see `functions/src/research-tools/README.md`) or re-verified 2026-08-29.

## 1. Overview

Semantic Scholar exposes three REST APIs, each with its own base URL:

| API | Base URL | Purpose |
|---|---|---|
| Academic Graph (S2AG) | `https://api.semanticscholar.org/graph/v1` | Papers, authors, citations, references, snippets |
| Recommendations | `https://api.semanticscholar.org/recommendations/v1` | Related-paper recommendations |
| Datasets | `https://api.semanticscholar.org/datasets/v1` | Bulk dataset downloads (full corpus copies) |

- Interactive docs (JS SPA): https://api.semanticscholar.org/api-docs/ (per-API: `/api-docs/graph`, `/api-docs/recommendations`, `/api-docs/datasets`)
- OpenAPI specs: `https://api.semanticscholar.org/graph/v1/swagger.json`, `https://api.semanticscholar.org/recommendations/v1/swagger.json`, `https://api.semanticscholar.org/datasets/v1/swagger.json`
- Overview / API key signup: https://www.semanticscholar.org/product/api
- Tutorial: https://www.semanticscholar.org/product/api/tutorial
- Examples & FAQ: https://github.com/allenai/s2-folks (FAQ: https://github.com/allenai/s2-folks/blob/main/FAQ.md)
- Local copies of the specs saved during this research: `~/.hermes/workspace/swagger_graph.json`, `swagger_recommendations.json`, `swagger_datasets.json`

All three APIs return `application/json`. Standard HTTP verbs and status codes.

## 2. Authentication & Rate Limits

- The API key is passed in the **`x-api-key` header (case-sensitive)**. 📄
  ```bash
  curl -H "x-api-key: $S2_API_KEY" "https://api.semanticscholar.org/graph/v1/paper/search?query=covid"
  ```
- Keys are free; request one at https://www.semanticscholar.org/product/api#api-key-form. 📄
- **With a key: 1 request/second shared across all endpoints** (occasionally higher after review). 📄
- **Without a key**: you share a single rate bucket with all other unauthenticated users — expect frequent
  **HTTP 429** even at modest request rates. ✅ (observed sustained 429s on `/paper/search` while
  detail endpoints intermittently succeeded; this is the normal experience for keyless use)
- **429 response body** (verified live ✅):
  ```json
  {"message": "Too Many Requests. Please wait and try again or apply for a key for higher rate limits. https://www.semanticscholar.org/product/api#api-key-form", "code": "429"}
  ```
- **No `Retry-After` header is sent on 429** ✅ (response headers observed: only standard
  AWS API Gateway/CloudFront headers such as `x-amzn-ErrorType: TooManyRequestsException`). Use your own
  exponential backoff; 1–5 s waits are typical.
- **Transient 5xx happen too** ✅ (a live `GET /paper/search` returned 500 "Internal Server Error" on 2026-08-29) — retry them like 429s 🧪 (the module pins 429/5xx/network retries; the skill script does both).
- Other rate-limit guidance from the official tutorial 📄: use batch/bulk endpoints instead of many single
  requests, request only the `fields` you need (smaller responses are faster), and switch to the Datasets
  API when you need more than ~1 req/s at scale.

### Error responses (verified live ✅)

| Status | Meaning | Body shape (observed) |
|---|---|---|
| 200 | OK | — |
| 400 | Bad query params / bad fields / limits exceeded | `{"error": "Unrecognized or unsupported fields: [bad1]"}` or `{"error": "offset + limit must be < 10000"}` |
| 404 | Unknown paper/author ID | `{"error": "Paper with id <id> not found"}` |
| 401 | Missing/invalid API key (Datasets downloads) | `{"error": "A valid API key is required"}` |
| 429 | Rate limited | `{"message": "Too Many Requests. ...", "code": "429"}` |

## 3. Paper & Author ID Formats

`{paper_id}` path parameters accept any of these prefixes (prefix is **case-insensitive in practice** —
the spec shows uppercase; use uppercase). ✅ All formats below resolved to papers in live calls
(sha, CorpusId, DOI, ARXIV, MAG, URL; ACL/PMID are spec-documented 📄):

| Format | Example |
|---|---|
| `<sha>` (S2 paperId, 40-hex) | `649def34f8be52c8b66281af98ae884c09aef38b` |
| `CorpusId:<id>` | `CorpusId:215416146` |
| `DOI:<doi>` | `DOI:10.18653/v1/N18-3011` |
| `ARXIV:<id>` | `ARXIV:2106.15928` |
| `MAG:<id>` (Microsoft Academic Graph) | `MAG:112218234` |
| `ACL:<id>` | `ACL:W12-3903` |
| `PMID:<id>` (PubMed/Medline) | `PMID:19872477` |
| `PMCID:<id>` (PubMed Central) | `PMCID:2323736` |
| `URL:<url>` | `URL:https://arxiv.org/abs/2106.15928v1` |

- `URL:` works for URLs from: `semanticscholar.org`, `arxiv.org`, `aclweb.org`, `acm.org`, `biorxiv.org`. 📄
- **URL-encode the whole id** (the `:` is fine unencoded, but `/` in DOIs/URLs must be encoded) ✅:
  `DOI%3A10.18653%2Fv1%2FN18-3011`. In Python: `urllib.parse.quote(paper_id, safe="")`.
- Papers also have a numeric `corpusId` (int64) in addition to the string `paperId`; the Datasets API keys records by `corpusId`. 📄
- Unknown IDs: single-paper endpoints return **404**; the batch endpoint returns **`null` in place of the paper** ✅.

Author IDs are plain strings, e.g. `1741101` (Oren Etzioni), `1780531` (Daniel S. Weld).

## 4. Graph API — Paper Endpoints (`/graph/v1`)

### 4.1 `GET /paper/search` — Paper relevance search ✅ (shape per spec 📄; live calls 429'd due to shared unauth pool)

Relevance-ranked keyword search. **No special query syntax** is supported; hyphenated terms yield no
matches (replace `-` with a space). Deep pagination is limited — use `/paper/search/bulk` for large pulls.

```bash
curl -H "x-api-key: $S2_API_KEY" \
  "https://api.semanticscholar.org/graph/v1/paper/search?query=attention%20is%20all%20you%20need&limit=5&fields=title,abstract,venue,year,authors,externalIds,citationCount,openAccessPdf,tldr"
```

Parameters:

| Param | Type | Notes |
|---|---|---|
| `query` | string, **required** | Plain text. No special syntax; hyphenated terms → no matches 📄 |
| `fields` | string | Comma-separated; see §6. Default: `paperId,title` |
| `limit` | int | **≤ 100** (default 100 if omitted… spec states "Must be <= 100") |
| `offset` | int | Pagination start position |
| `publicationTypes` | string | CSV of: Review, JournalArticle, CaseReport, ClinicalTrial, Conference, Dataset, Editorial, LettersAndComments, MetaAnalysis, News, Study, Book, BookSection |
| `openAccessPdf` | flag | No value; restricts to papers with a public PDF |
| `minCitationCount` | int/string | e.g. `minCitationCount=200` |
| `publicationDateOrYear` | string | `YYYY-MM-DD:YYYY-MM-DD` range; also `2019-03`, `2019`, open ranges `1981-08-25:`, `:2015-01` |
| `year` | string | `2019`, `2016-2020`, `2010-`, `-2015` |
| `venue` | string | CSV of venue names or ISO4 abbreviations (`Nature,Radiology`) |
| `fieldsOfStudy` | string | CSV of the 23 fields (see §6.4) |

Response `200` (`PaperRelevanceSearchBatch`) 📄:
```json
{
  "total": 576278,
  "offset": 100,
  "next": 103,
  "data": [ { "paperId": "...", "title": "...", "...": "..." } ]
}
```
- `total` is **approximate** — treat as an estimate, not an exact count. 📄
- Pagination: pass `next` as the next `offset`; **`next` absent ⇒ no more results**. 📄
- Limitation 📄: "Can only return up to 1,000 relevance-ranked results" — for larger pulls use `/paper/search/bulk`. Responses are also capped at 10 MB.
- Query semantics 🧪: **all terms are ANDed** — long natural-language sentences return 0 hits; use ~≤8 distinctive keywords. Results expose **no relevance score**.
- Sub-field forms are per-endpoint 🧪: `openAccessPdf.url` **400s here** — request bare `openAccessPdf` (the script default).
- `citationStyles.bibtex` is not served here (2026-08-29: requested alongside other fields, 0/10 rows carried `citationStyles` — the same rejection batch 400s on, silently stripped by the script's self-heal). Fetch BibTeX per id via `GET /paper/{id}` (§6.5).

### 4.2 `GET /paper/search/bulk` — Paper bulk search ✅

Like `/paper/search` but for bulk retrieval: **text query is optional**, supports boolean matching syntax,
returns up to **1,000 papers per call**, paginated by an opaque continuation `token` (not offset).
Up to 10,000,000 papers fetchable this way; beyond that use the Datasets API. Nested data
(`citations`, `references`) is **not** available here.

```bash
curl -H "x-api-key: $S2_API_KEY" \
  "https://api.semanticscholar.org/graph/v1/paper/search/bulk?query=%22fish+ladder%22+%7C+outflow&sort=citationCount:desc&fields=title,year,citationCount"
```

Parameters:

| Param | Type | Notes |
|---|---|---|
| `query` | string | Optional. Matched against title+abstract (English stemming; all terms must be present by default). Syntax 📄: `+` AND, `\|` OR, `-` negation, `"..."` phrase, `*` prefix, `( )` grouping, `~N` fuzzy (edit distance) after a word, `~N` after a phrase (term separation). Examples: `fish -ladder`, `fish \| ladder`, `"fish ladder"~3`, `fish*` |
| `token` | string | Continuation token from the previous response; each call returns a new token |
| `sort` | string | `field:order` where field ∈ {`paperId`, `publicationDate`, `citationCount`} and order ∈ {`asc`,`desc`}. Default `paperId:asc`. Ties broken by paperId; records missing the sort value go last ✅ |
| `fields` | string | Same paper fields as §6 (no `citations`/`references`; `tldr` rejected 🧪) |
| `publicationTypes`, `openAccessPdf`, `minCitationCount`, `publicationDateOrYear`, `year`, `venue`, `fieldsOfStudy` | | Same filter semantics as §4.1 |

Response `200` ✅ (observed):
```json
{
  "total": 96869,
  "token": "PCOBLRZRB2ADACAAYCXTJTAOICIQNP3CDSUKLC4J",
  "data": [
    {"paperId": "b47e6e19e7c459210316ee02b830253fe8a6e904",
     "title": "Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine",
     "year": 2020, "citationCount": 11331}
  ]
}
```
- 1,000 papers returned per call (✅ observed 1000); **`token` absent ⇒ no more results**. Pass `token` back to get the next page ✅.
- Caveat 📄: if data changes while paging, sorted results can shift; the default `paperId` sort avoids this.

### 4.3 `GET /paper/search/match` — Paper title search ✅

Returns the **single closest title match** (one result) for a plain-text query; 404 `"Title match not found"` when nothing matches. Same filter params as §4.1 (no `offset`/`limit`).

```bash
curl -H "x-api-key: $S2_API_KEY" \
  "https://api.semanticscholar.org/graph/v1/paper/search/match?query=Construction%20of%20the%20Literature%20Graph%20in%20Semantic%20Scholar&fields=title,year"
```
Response `200` ✅ (observed):
```json
{"data": [{"paperId": "649def34f8be52c8b66281af98ae884c09aef38b",
           "title": "Construction of the Literature Graph in Semantic Scholar",
           "year": 2018, "matchScore": 179.05287}]}
```
Useful for resolving a known title → `paperId` (check `matchScore` to guard against bad matches). Live 2026-08-29 ✅: same query returned matchScore 179.12 (was 177.6 on 2026-08-28 — it drifts). `citationStyles.bibtex` is not returned here (same silent-strip rejection family as batch) 🧪.

### 4.4 `GET /paper/autocomplete` ✅

Query-completion helper; no `fields` param.

```bash
curl "https://api.semanticscholar.org/graph/v1/paper/autocomplete?query=semanti"
```
Response `200` ✅ (observed): `{"matches": [{"id": "<paperId>", "title": "...", "authorsYear": "Chen et al., 2015"}, ...]}` (default ~10 items). `query` is truncated to its first 100 chars 📄.

### 4.5 `GET /paper/{paper_id}` — Details about a paper ✅

```bash
curl -H "x-api-key: $S2_API_KEY" \
  "https://api.semanticscholar.org/graph/v1/paper/649def34f8be52c8b66281af98ae884c09aef38b?fields=title,abstract,venue,year,authors,externalIds,citationCount,openAccessPdf,tldr"
```
- Query params: `fields` only (see §6.1). Default response: `paperId` + `title`.
- Path param: any ID format from §3. 404 `{"error": "Paper with id <id> not found"}` for unknown IDs ✅.

Observed `200` body (abridged) ✅:
```json
{
  "paperId": "649def34f8be52c8b66281af98ae884c09aef38b",
  "corpusId": 1778604653,
  "externalIds": {"DBLP": "conf/naacl/LoWNKW20", "DOI": "10.18653/v1/N18-3011", "CorpusId": 1778604653},
  "url": "https://www.semanticscholar.org/paper/649def34f8be52c8b66281af98ae884c09aef38b",
  "title": "Construction of the Literature Graph in Semantic Scholar",
  "abstract": "We describe a deployed scalable system for organizing published scientific literature...",
  "venue": "North American Chapter of the Association for Computational Linguistics",
  "year": 2018,
  "referenceCount": 27, "citationCount": 800, "influentialCitationCount": 90,
  "isOpenAccess": true,
  "openAccessPdf": {"url": "https://www.aclweb.org/anthology/N18-3011.pdf", "status": "GOLD", "license": "CCBY", "disclaimer": "..."},
  "fieldsOfStudy": ["Computer Science"],
  "s2FieldsOfStudy": [{"category": "Computer Science", "source": "external"}, {"category": "Computer Science", "source": "s2-fos-model"}],
  "publicationTypes": ["Journal Article", "Conference"],
  "publicationDate": "2018-01-01",
  "journal": {"name": "...", "volume": "...", "pages": "84-91"},
  "citationStyles": {"bibtex": "@Article{Ammar2018ConstructionOT, ...}"},
  "authors": [{"authorId": "1741101", "name": "Oren Etzioni"}],
  "tldr": {"model": "tldr@v2.0.0", "text": "This paper reduces literature graph construction into familiar NLP tasks..."},
  "embedding": {"model": "specter_v1", "vector": [-8.82, -2.66, "... 768 dims total"]}
}
```

**⚠️ There is NO `GET /paper/{id}/tldr` endpoint.** ✅ Live check of
`/graph/v1/paper/649def.../tldr` returns **404** `{"error":"Paper with id <id>/tldr not found"}`.
The TLDR is a **field**: `fields=tldr` on any paper-returning endpoint (see response above).
Same for embeddings: `fields=embedding` (v1, 768-dim, model `specter_v1`) or `fields=embedding.specter_v2`.

### 4.6 `POST /paper/batch` — Details for multiple papers ✅

```bash
curl -X POST -H "x-api-key: $S2_API_KEY" -H "Content-Type: application/json" \
  -d '{"ids": ["649def34f8be52c8b66281af98ae884c09aef38b", "ARXIV:2106.15928", "CorpusId:215416146", "DOI:10.18653/v1/N18-3011"]}' \
  "https://api.semanticscholar.org/graph/v1/paper/batch?fields=title,year,externalIds,citationCount"
```

- `fields` is a **query parameter** (single comma-separated string), **not** in the POST body. Body: `{"ids": ["...", "..."]}` with **≤ 500 IDs per request**. 📄
- Other limits 📄: ≤ 10 MB response; ≤ 9,999 citations returned per call; IDs use the §3 formats.
- Response `200` is a **plain JSON array** in the same order as the requested `ids`; **unresolvable IDs yield `null` entries** ✅:
  ```json
  [
    {"paperId": "649def34f8be52c8b66281af98ae884c09aef38b", "title": "Construction of the Literature Graph in Semantic Scholar", ...},
    {"paperId": "f712fab0d58ae6492e3cdfc1933dae103ec12d5d", "title": "Reinfection and low cross-immunity ...", ...},
    {"paperId": "5c5751d45e298cea054f32b392c12c61027d2fe7", "title": "S2ORC: The Semantic Scholar Open Research Corpus", ...},
    {"paperId": "649def34f8be52c8b66281af98ae884c09aef38b", "title": "Construction of the Literature Graph in Semantic Scholar", ...},
    null
  ]
  ```
  (last entry corresponds to an invalid `BOGUS:xyz` id). Note different external IDs can resolve to the same paper (duplicate `paperId`s across entries) ✅.
- **`citationStyles.bibtex` is REJECTED** ✅ (2026-08-29): `POST /paper/batch?fields=citationStyles.bibtex` → 400 `{"error":"Unrecognized or unsupported fields: [citationStyles.bibtex]"}`. Request BibTeX per id via `GET /paper/{id}` (§6.5).

```python
# Official Python pattern 📄
import requests, json
r = requests.post(
    'https://api.semanticscholar.org/graph/v1/paper/batch',
    params={'fields': 'referenceCount,citationCount,title'},
    json={"ids": ["649def34f8be52c8b66281af98ae884c09aef38b", "ARXIV:2106.15928"]},
    headers={'x-api-key': API_KEY})
print(json.dumps(r.json(), indent=2))
```

### 4.7 `GET /paper/{paper_id}/citations` and `GET /paper/{paper_id}/references` ✅

- `citations` = papers that **cite** this paper (each item wraps the citing paper in `citingPaper`).
- `references` = papers **cited by** this paper (each item wraps the cited paper in `citedPaper`).

```bash
curl -H "x-api-key: $S2_API_KEY" \
  "https://api.semanticscholar.org/graph/v1/paper/649def34f8be52c8b66281af98ae884c09aef38b/citations?fields=contexts,intents,isInfluential,title&limit=1000&offset=0"

curl -H "x-api-key: $S2_API_KEY" \
  "https://api.semanticscholar.org/graph/v1/paper/649def34f8be52c8b66281af98ae884c09aef38b/references?fields=contexts,isInfluential,title&limit=500"
```

Parameters (both endpoints):

| Param | Notes |
|---|---|
| `fields` | Citation-entry fields (`contexts`, `intents`, `contextsWithIntent`, `isInfluential`) plus any paper field **nested inside** `citingPaper.` / `citedPaper.` — e.g. `fields=contexts,title,authors`. If omitted: wrapper + `paperId,title` of the inner paper. Default inner fields: `paperId`,`title` 📄 |
| `limit` | **≤ 1000** (default 100) 📄 |
| `offset` | Pagination start. **Hard cap: `offset + limit must be < 10000`** — exceeding returns 400 `{"error":"offset + limit must be < 10000"}` ✅. So you can page at most the first 9,999 citations/references via offset |
| `publicationDateOrYear` | Filter the citing/cited papers by date (same syntax as §4.1) 📄 |

Response `200` ✅ (observed, citations):
```json
{
  "offset": 0,
  "next": 100,
  "data": [
    {
      "contexts": ["Candidate papers were sourced from Semantic Scholar [27] and evaluated against..."],
      "intents": [],
      "isInfluential": false,
      "citingPaper": {"paperId": "9ef4b086c3d6a50b3a5463c850030bea7e56e812", "title": "AgentR A Stateful and Recovery-Aware..."}
    }
  ]
}
```
- `contexts`: text snippets where the citation appears; `intents`: e.g. `methodology`, `background` (see S2 FAQ); `isInfluential`: boolean 📄.
- Pagination: keep requesting with `next` → `offset` until **`next` is absent**. To reach citations beyond the 9,999 offset cap there is no API workaround (use the Datasets `citations` dataset).
- **Empty pages occur** ✅ (2026-08-29): `citations?fields=contexts&limit=5` on a heavily-cited paper returned `data: []` with `next: 5` — an empty first page does NOT mean "no citations"; keep paging until `next` is absent (entries whose `citingPaper`/`citedPaper` wrapper is null are dropped by the skill script).
- Sub-field forms are per-endpoint 🧪: these edge endpoints reject BOTH `openAccessPdf.url` AND `authors.name` in `fields` — use bare `openAccessPdf` / `authors`.

### 4.8 `GET /paper/{paper_id}/authors` ✅

```bash
curl -H "x-api-key: $S2_API_KEY" \
  "https://api.semanticscholar.org/graph/v1/paper/649def34f8be52c8b66281af98ae884c09aef38b/authors?fields=name,affiliations&limit=1000"
```
- `fields` are **author** fields (§6.2); `authorId` always returned; default response `authorId`+`name`.
- `offset` / `limit` ≤ 1000. Response: `{offset, next, data: [...]}` (AuthorBatch envelope) 📄.

### 4.9 `GET /snippet/search` — Text snippet search 📄

```bash
curl -H "x-api-key: $S2_API_KEY" \
  "https://api.semanticscholar.org/graph/v1/snippet/search?query=The%20literature%20graph%20is%20a%20property%20graph&limit=10"
```
- Returns ~500-word excerpts from title/abstract/body that match the query, ranked. Params: `query` (required), `limit` ≤ 1000 (default 10), `fields` (subset of `snippet.*`, e.g. `fields=snippet.text,snippet.snippetKind`), plus filters: `paperIds` (comma-separated paper IDs, ~100 max), `authors` (fuzzy name AND-match, ≤ 10), `minCitationCount`, `year`, `venue`, `fieldsOfStudy`, `publicationDateOrYear`, `insertedBefore`.
- Response: `{"data": [{"snippet": {"text", "snippetKind" (title|abstract|body), "section", "snippetOffset", "annotations": {"sentences", "refMentions"}},"score", "paper": {"corpusId","title","authors","openAccessInfo"}}], "retrievalVersion"}`.

## 5. Graph API — Author Endpoints (`/graph/v1`)

### 5.1 `GET /author/{author_id}` ✅

```bash
curl -H "x-api-key: $S2_API_KEY" \
  "https://api.semanticscholar.org/graph/v1/author/1741101?fields=name,affiliations,homepage,paperCount,citationCount,hIndex,externalIds,url"
```
Observed `200` ✅:
```json
{
  "authorId": "1741101",
  "externalIds": {"DBLP": ["Oren Etzioni"]},
  "url": "https://www.semanticscholar.org/author/1741101",
  "name": "Oren Etzioni",
  "affiliations": [],
  "homepage": null,
  "paperCount": 259,
  "citationCount": 43671,
  "hIndex": 88
}
```
- `fields` (§6.2); default response: `authorId` + `name`. 404 for unknown author ✅.
- **`aliases` caveat**: listed in the spec's author schema 📄, but requesting it currently returns
  400 `{"error": "Unrecognized or unsupported fields: [aliases]"}` on both `/author/{id}` and
  `/author/search` ✅ (as of 2026-08-28). Don't rely on it.

### 5.2 `POST /author/batch` ✅

```bash
curl -X POST -H "x-api-key: $S2_API_KEY" -H "Content-Type: application/json" \
  -d '{"ids": ["1741101", "1780531"]}' \
  "https://api.semanticscholar.org/graph/v1/author/batch?fields=name,hIndex,citationCount"
```
Response `200` (plain array; order matches request) ✅:
```json
[
  {"authorId": "1741101", "name": "Oren Etzioni", "citationCount": 43671, "hIndex": 88},
  {"authorId": "1780531", "name": "Daniel S. Weld", "citationCount": 47396, "hIndex": 94}
]
```
- **≤ 1,000 author IDs per request**; `fields` goes in the query string; ≤ 10 MB response 📄.

### 5.3 `GET /author/search` ✅

```bash
curl -H "x-api-key: $S2_API_KEY" \
  "https://api.semanticscholar.org/graph/v1/author/search?query=adam%20smith&limit=100&fields=name,url,affiliations,paperCount"
```
- Params: `query` (required, plain text; no special syntax; hyphenated terms → no matches), `offset`, `limit` ≤ 1000, `fields` (author fields + `papers.*` subfields).
- Response `200` ✅ (observed): `{"total": 489, "offset": 0, "next": 2, "data": [{"authorId": "39765778", "name": "Adam D. Smith", ...}]}` — paginate via `next` → `offset` until `next` is absent.
- Specifying `papers` fields returns each author's papers — set a small `limit` to control response size 📄.
- Namesake warning ✅ (2026-08-29): for `Christopher Manning` (55 hits) the canonical Stanford profile was NOT in the first 10 — all top hits were minor profiles (hIndex ≤ 6). Ranking is not prominence-ordered; scan `paperCount`/`hIndex` across pages before picking.

### 5.4 `GET /author/{author_id}/papers` ✅

```bash
curl -H "x-api-key: $S2_API_KEY" \
  "https://api.semanticscholar.org/graph/v1/author/1741101/papers?fields=title,year,venue&limit=1000"
```
- Returns `{offset, next, data: [...]}` where `data` items are **papers** (paper fields, §6.1) ✅ (observed).
- `offset` / `limit` ≤ 1000. Citations/references embedded per paper are capped at the most recent 10,000; use `/paper/{id}/citations` for the full set 📄.

## 6. Field Reference (`fields=` parameter)

Rules 📄:
- Comma-separated, **case-sensitive**; `fields` is always a single query-string value.
- `paperId` is always returned; omitting `fields` returns only `paperId` + `title` (author endpoints: `authorId` + `name`).
- Subfields use dots: `authors.name`, `citations.title,citations.abstract`, `papers.year` (under authors), `embedding.specter_v2`.
- Requesting `authors` defaults to `authorId` + `name`; requesting `citations`/`references` defaults to `paperId` + `title`.

### 6.1 Paper fields 📄

`paperId` (always), `corpusId`, `externalIds` (keys: ArXiv, MAG, ACL, PubMed, Medline, PubMedCentral, DBLP, DOI, CorpusId), `url`, `title`, `abstract` (may be null for legal reasons even when shown on the website), `venue` (normalized name), `publicationVenue` ({id, name, type, alternate_names, url}), `year`, `referenceCount`, `citationCount`, `influentialCitationCount`, `isOpenAccess`, `openAccessPdf` ({url, status: GOLD|HYBRID|BRONZE|GREEN..., license, disclaimer}), `fieldsOfStudy` (array<string>), `s2FieldsOfStudy` (array of {category, source: external|s2-fos-model}), `publicationTypes` (array<string>), `publicationDate` (YYYY-MM-DD), `journal` ({name, volume, pages}), `externalIds`, `citationStyles` ({bibtex}), `authors` (≤ 500 returned — FAQ-sourced, not in OpenAPI spec), `citations` (array of BasePaper), `references` (array of BasePaper), `embedding` ({model, vector} — `embedding.specter_v2` for v2), `tldr` ({model, text} — SciTLDR model), `textAvailability` (fulltext|abstract|none).

### 6.2 Author fields 📄

`authorId` (always), `externalIds` ({DBLP: [...], ORCID: ...}), `url`, `name`, `affiliations` (array<string>), `homepage`, `paperCount`, `citationCount`, `hIndex`, `papers` (list of papers, supports `papers.<paperfield>` subfields). Authors embedded in paper responses may additionally include `normalizedAffiliations` ({rorId, rorDisplayName}). ⚠️ `aliases` is spec-listed but currently rejected by the API ✅ (see §5.1).

### 6.3 Citation/reference entry fields 📄

`contexts` (array<string>), `intents` (array<string>, e.g. methodology/background), `contextsWithIntent` (array of {context, intent...}), `isInfluential` (bool), and the inner paper via `citingPaper` / `citedPaper` (BasePaper — request inner fields as `title`, `authors`, etc. at the top level of `fields`).

### 6.4 `fieldsOfStudy` values 📄

Computer Science, Medicine, Chemistry, Biology, Materials Science, Physics, Geology, Psychology, Art, History, Geography, Sociology, Business, Political Science, Economics, Philosophy, Mathematics, Engineering, Environmental Science, Agricultural and Food Sciences, Education, Law, Linguistics.

### 6.5 BibTeX export (`citationStyles.bibtex`) — where it actually works 🧪

The persist / reference-manager path depends on BibTeX; per-endpoint truth (live):

| Endpoint | `citationStyles.bibtex` in `fields=` | Evidence |
|---|---|---|
| `GET /paper/{id}` | ✅ served | observed in a live 200 body 2026-08-28 (§4.5 response) |
| `POST /paper/batch` | ❌ 400 | 2026-08-29: `{"error":"Unrecognized or unsupported fields: [citationStyles.bibtex]"}` |
| `GET /paper/search` | ❌ not served | 2026-08-29: 0/10 rows carried `citationStyles` (rejection silently stripped by the script's self-heal) |
| `GET /paper/search/match` | ❌ not returned | 2026-08-29: same silent-strip behavior |
| bulk / others | untested | assume unsupported outside single-paper `get` until proven |

Worked example (the only reliable path — one id per call, respect 1 req/s):

```bash
curl -H "x-api-key: $S2_API_KEY" \
  "https://api.semanticscholar.org/graph/v1/paper/DOI:10.18653/v1/N18-3011?fields=title,citationStyles.bibtex"
```

Response (abridged, observed 2026-08-28):

```json
{"title": "Construction of the Literature Graph in Semantic Scholar",
 "citationStyles": {"bibtex": "@Article{Ammar2018ConstructionOT, title={Construction of the Literature Graph in Semantic Scholar}, author={Waleed Ammar and Dirk Weissenborn and ...}, journal={North American Chapter of the Association for Computational Linguistics}, year={2018}}"}}
```

S2 formats the entry server-side (authors, venue, year filled from the graph) — do not hand-build BibTeX from raw fields, and never request the field on search/bulk/match/batch.

## 7. Recommendations API (`/recommendations/v1`)

### 7.1 `POST /papers/` — recommendations from positive/negative examples ✅

```bash
curl -X POST -H "x-api-key: $S2_API_KEY" -H "Content-Type: application/json" \
  -d '{"positivePaperIds": ["649def34f8be52c8b66281af98ae884c09aef38b"], "negativePaperIds": ["ArXiv:1805.02262"]}' \
  "https://api.semanticscholar.org/recommendations/v1/papers/?fields=title,year,abstract&limit=10"
```
- Body schema (`Paper Input`) 📄: `{"positivePaperIds": ["..."], "negativePaperIds": ["..."]}` — either list may be empty/omitted; IDs use the §3 formats.
- Query params: `limit` (**≤ 500**), `fields` (paper fields).
- 🧪 `limit` is honored **only as a query param** — a `limit` in the POST body is silently ignored (100 papers/seed returned).
- 🧪 `openAccessPdf` is rejected in `fields` on this service (requesting it silently emptied every recommendation call until fixed 2026-08-28), but `authors.name` IS accepted here (unlike the citations/references edges).
- Response `200` ✅ (observed): `{"recommendedPapers": [{"paperId": "...", "title": "...", "year": 2026}, ...]}`.
- 404 `Input papers not found` if an example ID is unknown 📄.

### 7.2 `GET /papers/forpaper/{paper_id}` — single-paper recommendations ✅

```bash
curl -H "x-api-key: $S2_API_KEY" \
  "https://api.semanticscholar.org/recommendations/v1/papers/forpaper/649def34f8be52c8b66281af98ae884c09aef38b?fields=title,year,citationCount&limit=10"
```
- Query params: `limit` (≤ 500), `fields`, and `from` — pool selector with allowed values **`recent` and `all-cs`** ✅ (any other value returns 400 `{"error": "Unrecognized value 'X' for \`from\`. Restrict to: \`['recent', 'all-cs']\`"}`; omitting `from` is valid ✅). (Older docs mention `all-cited`; that value is rejected now ✅.)
- Response: `{"recommendedPapers": [...]}` same as §7.1 ✅.

## 8. Datasets API (`/datasets/v1`)

Workflow 📄: list releases → pick a release → list its datasets → fetch pre-signed S3 file links →
download **gzipped JSON-Lines** files (one JSON object per line). Incremental updates between releases
via the diffs endpoint. **API key required for file links and diffs; release/dataset listing is public.** ✅

### 8.1 `GET /release/` ✅

```bash
curl "https://api.semanticscholar.org/datasets/v1/release/"
```
Response: plain JSON array of release-date strings (193 releases observed ✅), e.g.
`["2023-01-03", ..., "2026-08-05", "2026-08-11", "2026-08-18"]`.

### 8.2 `GET /release/{release_id}` ✅

```bash
curl "https://api.semanticscholar.org/datasets/v1/release/2026-08-18"
```
Response `200` ✅ (observed): `{"release_id": "2026-08-18", "README": "...", "datasets": [{"name": "papers", "description": "Core paper metadata", "README": "..."}, ...]}` — 11 datasets observed:
`abstracts, authors, citations, embeddings-specter_v1, embeddings-specter_v2, paper-ids, papers, publication-venues, s2orc, s2orc_v2, tldrs`.

### 8.3 `GET /release/{release_id}/dataset/{dataset_name}` ✅ (401 without key)

```bash
curl -H "x-api-key: $S2_API_KEY" \
  "https://api.semanticscholar.org/datasets/v1/release/2026-08-18/dataset/papers"
```
- Response 200 📄: `{"name": "papers", "description": "...", "README": "...", "files": ["https://...pre-signed..."]}` — `files` are temporary pre-signed S3 URLs (partitions; fetch all of them).
- Without an API key this returns **401** `{"error": "A valid API key is required"}` ✅.

### 8.4 `GET /diffs/{start_release_id}/to/{end_release_id}/{dataset_name}` ✅ (401 without key)

```bash
curl -H "x-api-key: $S2_API_KEY" \
  "https://api.semanticscholar.org/datasets/v1/diffs/2026-08-11/to/latest/papers"
```
- `end_release_id` may be `latest` 📄. Response 200 📄:
  ```json
  {
    "dataset": "papers", "start_release": "2023-08-01", "end_release": "2023-08-29",
    "diffs": [
      {"from_release": "2023-08-01", "to_release": "2023-08-07",
       "update_files": ["https://..."], "delete_files": ["https://..."]}
    ]
  }
  ```
- Apply updates by upserting records keyed on `corpusid`; apply deletes by removing them. Without a key: 401 `{"error": "A valid API key is required"}` ✅.
- Official update pattern (Python, from spec) 📄:
  ```python
  difflist = requests.get('https://api.semanticscholar.org/datasets/v1/diffs/2023-08-01/to/latest/papers').json()
  for diff in difflist['diffs']:
      for url in diff['update_files']:
          for json_line in requests.get(url).iter_lines():
              record = json.loads(json_line)
              datastore.upsert(record['corpusid'], record)
      for url in diff['delete_files']:
          for json_line in requests.get(url).iter_lines():
              record = json.loads(json_line)
              datastore.delete(record['corpusid'])
  ```

## 9. Practical Notes for a Helper Script

1. **Auth**: read `S2_API_KEY` from the environment; send header `x-api-key: <key>`. Works for all three APIs.
2. **429 handling**: no `Retry-After` ✅ — retry with exponential backoff + jitter (e.g. 1s → 2s → 4s → 8s, cap ~30s, 5–6 tries). Unauthenticated use will 429 a lot; a key (1 req/s) is effectively required for any real workload.
3. **Throttle to ≤ 1 req/s even with a key** (tutorial guidance).
4. **Pagination patterns**:
   - offset/next style (`/paper/search`, `/author/search`, `/*/citations`, `/*/references`, `/author/{id}/papers`, `/paper/{id}/authors`): loop while `next` is present, feeding `next` back as `offset`.
   - token style (`/paper/search/bulk`): loop while `token` is present, feeding it back as `token`.
   - citations/references offset cap: `offset + limit < 10000` ✅.
5. **Batching**: ≤ 500 paper IDs / ≤ 1,000 author IDs per batch POST; chunk larger lists; `null` entries in the response array mean "not found" ✅.
6. **Minimize `fields`**: fewer/smaller fields = faster responses; default is just `paperId,title`.
7. **URL-encode path IDs** (`quote(pid, safe="")`) — DOIs and `URL:` ids contain `/`.
8. **Response size cap** on most endpoints: 10 MB → shrink `limit`/`fields` if you hit 400 `"Response would exceed maximum size."`.
9. **Prefer bulk/batch** endpoints over N single calls (official guidance 📄): `/paper/search/bulk` > `/paper/search` for large pulls; `POST /paper/batch` > N × `GET /paper/{id}`.
10. **Title→ID resolution**: use `/paper/search/match` and sanity-check `matchScore` ✅.
11. **Abstracts may be null** (publisher restrictions) even when visible on the website 📄; full text only via snippet search or the `s2orc` datasets.
12. No first-party Python SDK is published by AI2 for the current API (the docs use plain `requests`); `requests` + a thin wrapper is the documented approach. Community packages exist but lag behind.

## 10. Quick Endpoint Index

| Method | Path (append to base URL) | Purpose |
|---|---|---|
| GET | `/graph/v1/paper/search` | Relevance search (limit ≤ 100, offset/next) |
| GET | `/graph/v1/paper/search/bulk` | Bulk search (1,000/call, token pagination, sort, boolean query) |
| GET | `/graph/v1/paper/search/match` | Single closest title match |
| GET | `/graph/v1/paper/autocomplete` | Title prefix completions |
| GET | `/graph/v1/paper/{paper_id}` | One paper by any §3 ID format |
| POST | `/graph/v1/paper/batch` | ≤ 500 papers per call |
| GET | `/graph/v1/paper/{paper_id}/citations` | Papers citing it (limit ≤ 1000, offset+limit < 10000) |
| GET | `/graph/v1/paper/{paper_id}/references` | Papers it cites (same limits) |
| GET | `/graph/v1/paper/{paper_id}/authors` | Its authors (limit ≤ 1000) |
| GET | `/graph/v1/snippet/search` | Full-text snippet search (limit ≤ 1000, default 10) |
| GET | `/graph/v1/author/{author_id}` | Author details |
| POST | `/graph/v1/author/batch` | ≤ 1,000 authors per call |
| GET | `/graph/v1/author/search` | Author name search (limit ≤ 1000) |
| GET | `/graph/v1/author/{author_id}/papers` | Author's papers (limit ≤ 1000) |
| POST | `/recommendations/v1/papers/` | Recs from positive/negative paper lists (limit ≤ 500) |
| GET | `/recommendations/v1/papers/forpaper/{paper_id}` | Recs for one paper (`from` ∈ recent, all-cs) |
| GET | `/datasets/v1/release/` | List release dates |
| GET | `/datasets/v1/release/{release_id}` | Release metadata + dataset list |
| GET | `/datasets/v1/release/{release_id}/dataset/{dataset_name}` | Pre-signed file links (API key required) |
| GET | `/datasets/v1/diffs/{start}/to/{end}/{dataset}` | Incremental diff links (API key required) |

*(There is no `/paper/{id}/tldr` endpoint — request `tldr` as a field instead ✅.)*
---

# Semantic Scholar Product Research: API Rate Limits, Datasets API, Semantic Reader, TLDRs

*Reference document compiled 2026-08-28. All product-page quotes fetched with crawl4ai 0.9.2; live API endpoints verified by direct HTTP calls the same day.*

---

## 1. API Rate Limits & API Key Behavior (`api.semanticscholar.org`)

The Semantic Scholar API is organized into three services: the **Academic Graph API** (authors, papers, citations, venues, SPECTER2 embeddings), the **Recommendations API**, and the **Datasets API** ([product page](https://www.semanticscholar.org/product/api)). Corpus scale at time of writing: **214M papers, 2.49B citations, 79M authors**.

### Unauthenticated access
- Most endpoints are public without authentication, but they are **rate-limited to 1,000 requests per second shared among *all* unauthenticated users** — "Requests may also be further throttled during periods of heavy use" ([API overview page](https://www.semanticscholar.org/product/api)).
- That 1,000 RPS is the capacity of one shared key that every anonymous caller on the internet uses simultaneously; your share is whatever is left and is not reserved. Historically the unauthenticated pool was defined as **5,000 requests per 5 minutes** (also shared), and AI2 has repeatedly *reduced* this pool ("Unauthenticated pool reduction" entries in the [API release notes](https://github.com/allenai/s2-folks/blob/main/API_RELEASE_NOTES.md)).

### API keys
- **Header:** send the key on every request as `x-api-key: <YOUR_KEY>`. AI2 recommends including it with every request even on public endpoints, because it lets them support you better.
- **Intro rate:** "The introductory rate limit for an API key is **1 RPS on all endpoints**." A key does not raise a shared ceiling; it moves you into a guaranteed, uncontended allocation. The [tutorial page](https://www.semanticscholar.org/product/api/tutorial) adds: "In some cases, users may be granted a slightly higher rate following a review."
- **How to request one:** fill the form at **https://www.semanticscholar.org/product/api#api-key-form** ("Request an API key"). The key is delivered **via email** and must not be shared.
- The Datasets API full-corpus downloads additionally route through the partner form (the datasets README points to `https://www.semanticscholar.org/product/api#Partner-Form`).

### Error / retry behavior
- `429` — too many requests, slow down ([s2-folks FAQ](https://github.com/allenai/s2-folks/blob/main/FAQ.md)). `403` — the API key sent is incorrect.
- On `429`, slow down; community tooling universally honors a **`Retry-After` response header when present** (the header itself is not explicitly documented on the product pages — treat as common but unofficial behavior).
- `5xx` — handle gracefully with **exponential backoff**, which the release notes state is *required*: "we now require the use of exponential backoff strategies for API requests." AI2 "cannot guarantee perfect availability."
- **Status page:** https://status.api.semanticscholar.org/ (linked as "API Service Status Page" from the [API overview](https://www.semanticscholar.org/product/api)).
- The [s2-folks repo](https://github.com/allenai/s2-folks/) (scripts, examples, FAQ, release notes) is **not maintained as of January 23, 2025**, but remains the best historical record of rate-plan changes.

**Sources:**
- https://www.semanticscholar.org/product/api (fetched 2026-08-28)
- https://www.semanticscholar.org/product/api/tutorial (search result)
- https://github.com/allenai/s2-folks/blob/main/FAQ.md (fetched via raw.githubusercontent.com)
- https://github.com/allenai/s2-folks/blob/main/API_RELEASE_NOTES.md (search result)
- https://status.api.semanticscholar.org/
- https://api.semanticscholar.org/api-docs/

---

## 2. Datasets API (`https://api.semanticscholar.org/datasets/v1`)

The Datasets API provides downloadable monthly snapshots of the full Semantic Scholar Academic Graph (S2AG) as **gzipped JSON-lines partitions stored on S3**, plus **incremental diffs between sequential releases** ([official docs](https://api.semanticscholar.org/api-docs/datasets), [Open Data Platform paper](https://arxiv.org/html/2301.10140v2)). Reading metadata (list releases, list datasets, READMEs) needs no key; **fetching the presigned download URLs for full datasets requires an API key** — verified live: `GET .../release/2026-08-18/dataset/abstracts` without a key returns `{"error": "A valid API key is required"}`.

### Endpoints (verified live 2026-08-28)
| Endpoint | Returns |
|---|---|
| `GET /datasets/v1/release` | JSON array of all release IDs, e.g. `["2022-05-10", ..., "2026-08-18"]` (weekly cadence) |
| `GET /datasets/v1/release/{release_id}` | `{ "release_id": "2026-08-18", "README": "...", "datasets": [ {"name", "description", "README"}, ... ] }` |
| `GET /datasets/v1/release/latest` | Same shape, most recent release |
| `GET /datasets/v1/release/{release_id}/dataset/{dataset_name}` | `{ "name", "description", "README", "files": [ "<presigned S3 url>", ... ] }` — **requires `x-api-key`** |
| `GET /datasets/v1/diffs/{from_release}/to/{to_release}/{dataset_name}` | Incremental diff with `update_files` / `delete_files` URLs ([example](https://github.com/allenai/s2-folks/blob/main/examples/python/s2ag_datasets/incremental-updates.py)) |

### Dataset names (verified in release `2026-08-18`)
`abstracts`, `authors`, `citations`, `embeddings-specter_v1`, `embeddings-specter_v2`, `paper-ids`, `papers`, `publication-venues`, `s2orc`, `s2orc_v2`, `tldrs`.

Notes:
- **"S2AG"** is the product name for the whole dataset collection, not an individual dataset name. Embeddings are published per model version (`embeddings-specter_v1`, `embeddings-specter_v2`), not as a single `embeddings` dataset.
- Example scale from the release README: abstracts = "100M records in 30 1.8GB files."

### Versioning & files
- **Versioning is by dated release ID** (`YYYY-MM-DD`); a new snapshot is published regularly and old releases remain listed. Each dataset inside a release carries its own `README` (schema, licensing, attribution).
- Each dataset's response contains a **`files` array of pre-signed S3 URLs** (a JSON manifest of partitions). Community references describe the underlying buckets as `s2ff` (files) and `s2anz` (annotations) — **unverified**: these hostnames do not appear in AI2's official docs, the s2-folks repo, or public code search as of this writing; the only bucket verifiable from official material is `s3-us-west-2.amazonaws.com/ai2-s2ag/` (used for open sample data).
- **Sample data (no key needed):** `curl https://s3-us-west-2.amazonaws.com/ai2-s2ag/samples/MANIFEST.txt` lists per-dataset samples like `samples/abstracts/abstracts-sample.jsonl.gz`, plus `samples/s2ag.py` and per-dataset READMEs (verified live).

### How to download (official example, s2-folks `full-datasets.py` / sample `s2ag.py`)
```python
import requests, urllib, os

# 1. Pick a release
latest = requests.get("https://api.semanticscholar.org/datasets/v1/release/latest").json()
print(latest["release_id"])                      # e.g. 2026-08-18
print([d["name"] for d in latest["datasets"]])   # dataset names + READMEs

# 2. Get presigned download URLs (API key required here)
papers = requests.get(
    "https://api.semanticscholar.org/datasets/v1/release/latest/dataset/papers",
    headers={"x-api-key": os.getenv("S2_API_KEY")},
).json()

# 3. Download the gzipped JSONL partitions
for i, url in enumerate(papers["files"]):
    urllib.request.urlretrieve(url, f"papers-part{i}.jsonl.gz")
```
Grab key-free samples with: `for f in $(curl -s https://s3-us-west-2.amazonaws.com/ai2-s2ag/samples/MANIFEST.txt); do curl --create-dirs "https://s3-us-west-2.amazonaws.com/ai2-s2ag/$f" -o "$f"; done`

**Sources:**
- https://api.semanticscholar.org/api-docs/datasets (fetched; endpoint + manifest + "Datasets are partitioned and stored on S3. Clients can retrieve them by requesting this list of pre-signed download urls")
- Live calls: `GET /datasets/v1/release`, `/release/latest`, `/release/2026-08-18/dataset/abstracts` (2026-08-28)
- https://github.com/allenai/s2-folks/tree/main/examples/python/s2ag_datasets (`full-datasets.py`, `get_sample_files.sh`, `incremental-updates.py`, fetched from raw.githubusercontent.com)
- https://s3-us-west-2.amazonaws.com/ai2-s2ag/samples/MANIFEST.txt and `samples/README.txt` (fetched)
- https://arxiv.org/html/2301.10140v2 (Semantic Scholar Open Data Platform paper)

---

## 3. Semantic Reader

**What it is:** "An AI-Powered Augmented Scientific Reading Application" — Semantic Reader uses AI to understand a document's structure and merge it with the Semantic Scholar corpus, surfacing "detailed information in context via tooltips and other overlays." It targets specific reading frictions: paging back and forth for cited-paper details, recognizing the same work across papers, losing track of reading history/notes, and PDF's poor support for mobile reading and screen readers. If logged in, it integrates with your library and, over time, personalizes contextual augmentations. Backed by research from AI2, UC Berkeley, and the University of Washington, supported by the Alfred P. Sloan Foundation ([product page](https://www.semanticscholar.org/product/semantic-reader)).

### Features
- **Citation cards** — details of a cited paper shown in-line where you're reading, **including TLDR summaries** (see §4).
- **Skimming highlights** — AI-generated highlighted overlays with three rhetorical labels: **Goal, Method, Result** (from the Scim project). The number and opacity of highlights are adjustable from a side panel. "Now available on most English-language arXiv papers in computer science fields." Try it via `/reader/` links, e.g. [BERT](https://www.semanticscholar.org/reader/df2b0e26d0599ce3e70df8a9da02e51594e0e992), [LLaMA](https://www.semanticscholar.org/reader/57e849d0de13ed5f91d086936296721d4ff75a75).
- **Definitions on demand** — click any term with a dotted underline to get an **AI-generated definition based on its context in the paper**, without losing your place (ScholarPhi lineage).
- **Personalized in-line citations** — citations are visually augmented based on connections to your research activities, e.g. **"saved in your library"** or **"cited by a paper in your library."** Requires at least one paper in your library; desktop devices only (CiteSee lineage).
- **Hypothesis annotation integration** — highlight text and choose **Annotate or Highlight**; sign in to a [Hypothesis](https://web.hypothes.is/help/) account from the panel to post, review, and share annotations.
- **Table of Contents** (availability varies) and **Save to Library**.

### Availability
"Semantic Reader is now available for **most arXiv papers** on Semantic Scholar with a growing set of features" (citation cards, ToC, library saving); skimming highlights are on "most English-language arXiv papers in **computer science** fields." Demo examples span NLP, CV, and ML papers. Best experienced on a full-size screen.

### Open Research Platform — https://openreader.semanticscholar.org/
The community-facing platform for building "intelligent and interactive paper readers," with **open-source libraries and prototype demos**:
- **PaperMage** (Python) — "Process and Analyze Scholarly PDF Documents": e.g. `CoreRecipe().run("paper.pdf")` yields `doc.paragraphs`, `doc.abstracts[0].sentences`, word-level bounding boxes for prompting LLMs and placing overlays. Site: https://papermage.org · Code: https://github.com/allenai/papermage · Paper: EMNLP 2023 demo track.
- **PaperCraft** (React/TypeScript, aka `@allenai/pdf-components`) — "Create Visually Augmented Interactive Readers": `DocumentWrapper` / `PageWrapper` / `Overlay` / `BoundingBox` components for popovers and highlights. Code: https://github.com/allenai/pdf-component-library · Tutorial: https://openreader.semanticscholar.org/PaperCraft
- **Prototype showcase:** Papeos (UIST 2023), Synergi & Threddy (UIST 2023), Paper Plain (TOCHI'22 → CHI'24), LLM Paper Q&A (GPT-powered PDF QA with attribution), CiteSee (in production), CiteRead, Scim (in production), ScholarPhi (founding project).
- Collaborators on the platform include UW, UC Berkeley, UPenn, MIT, UIUC, CMU, and Minnesota.

**Sources:**
- https://www.semanticscholar.org/product/semantic-reader (fetched 2026-08-28)
- https://openreader.semanticscholar.org/ (fetched 2026-08-28)
- https://www.semanticscholar.org/faq#semantic-reader (referenced from product page)

---

## 4. TLDRs

**What they are:** TLDRs ("Too Long; Didn't Read") are **super-short, automatically generated single-sentence summaries** of a paper's main objective and results, "generated using expert background knowledge and the latest GPT-3 style NLP techniques." Roughly **20 words instead of a 200-word abstract**, designed for fast skimming: "TLDRs help users make quick informed decisions about which papers are relevant" and double as ready-made summaries for sharing ([TLDR product page](https://www.semanticscholar.org/product/tldr)).

**Coverage:** available in beta for **nearly 60 million papers in computer science, biology, and medicine** (figure as stated on the product page).

**Where they appear:**
- On the **Semantic Scholar search results page** and **paper pages**.
- Inside **Semantic Reader citation cards** ("Citations Cards that show details of a cited paper in-line where you're reading, including TLDR summaries").
- In the **API**: "TLDRs are now available in the Semantic Scholar API" — request the `tldr` field on paper endpoints (`.../paper/{id}?fields=tldr`), per the [graph docs](https://api.semanticscholar.org/graph/v1).
- In bulk: a **`tldrs` dataset** ships in every Datasets API release (verified in release `2026-08-18`, §2).

**Research origin:** *TLDR: Extreme Summarization of Scientific Documents* (Cachola, Lo, Cohan, Weld — AI2), which introduced the SCITLDR dataset (5.4K TLDRs over 3.2K papers) and the CATTS training strategy. Feedback: feedback@semanticscholar.org.

**Sources:**
- https://www.semanticscholar.org/product/tldr (fetched 2026-08-28)
- https://www.semanticscholar.org/product/semantic-reader (fetched 2026-08-28 — citation cards + TLDR link)
- https://api.semanticscholar.org/api-docs/ (search result)
- Live Datasets API `/release/latest` listing (contains `tldrs`)