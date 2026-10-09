# Europe PMC Reference — REST API + Annotations + Grants + Bulk Surfaces

> Compiled 2026-08-28 from two research passes over europepmc.org docs (crawled), live API verification, and the developer forum. Part 1: Articles RESTful API. Part 2: Grants (GRIST), Annotations API, OAI, FTP bulk, SOAP, rate limits, search syntax. All ✅ items were called live on 2026-08-28; ❌ = verified absent.

---

# Europe PMC Articles RESTful API — Verified Research Notes

**Researched:** 2026-08-28 · **Live-verified:** all marked ✅ were called against the production API and observed directly; ❌ = tested and does not exist.
**Base URL:** `https://www.ebi.ac.uk/europepmc/webservices/rest` · API version observed: **6.9**
**Auth:** none. Free, no key, no registration. XML is the default format everywhere — always pass `format=json` for JSON.
**Test version exists at:** `https://www.ebi.ac.uk/europepmc/webservices/test/rest/...` (release staging).

Primary sources:
- Articles RESTful API doc (Swagger-style, api version 6.9): https://europepmc.org/RestfulWebService
- Developer resources hub: https://europepmc.org/developers
- Annotations API doc: https://europepmc.org/AnnotationsApi
- Search syntax guide (SPA; mostly JS-rendered): https://europepmc.org/searchSyntaxGuide
- Web Service Reference Guide PDF: https://europepmc.org/docs/EBI_Europe_PMC_Web_Service_Reference.pdf
- Release notes PDF: https://europepmc.org/docs/Europe_PMC_RESTful_Release_Notes.pdf
- Developer forum: https://groups.google.com/a/ebi.ac.uk/g/epmc-webservices

Local crawls (for reuse): `~/.hermes/workspace/epmc_pages/` — `restfulwebservice.md` (full endpoint reference), `annotationsapi.md`, `searchsyntax.md`, `api_samples/*.json` (live response bodies).

---

## 0. No Swagger / OpenAPI spec

❌ Probed all of these — 404: `.../rest/swagger.json`, `.../rest/openapi.json`, `.../rest/api-docs`.
The interactive docs at https://europepmc.org/RestfulWebService **are** the spec (a rendered Swagger list, "base url: /europepmc/webservices/rest, api version: 6.9"). `GET /rest/` returns **405 Method Not Allowed** (no landing page).

## 1. Data sources (`{source}` path segment)

From the API doc parameter tables (https://europepmc.org/RestfulWebService):

| Source | Content | Ext-id form |
|---|---|---|
| `MED` | PubMed/MEDLINE | PMID (e.g. `27480119`) |
| `PMC` | PubMed Central (incl. items not in PubMed) | PMCID, `PMC…` prefix (e.g. `PMC2832744`) |
| `PPR` | Preprints | `PPR…` prefix (e.g. `PPR150163`) |
| `AGR` | Agricola (USDA NAL) | numeric |
| `CBA` | Chinese Biological Abstracts | numeric |
| `CTX` | CiteXplore submissions | numeric |
| `ETH` | EThOS theses (British Library) | numeric |
| `HIR` | NHS Evidence (UK Health Information Resources) | numeric |
| `PAT` | Patents (EPO etc.) | numeric |
| `CIT` | CiteSeer (PSU) | numeric |
| `NBK` | NLM Bookshelf (books not in PubMed) | bare number, no `NBK` prefix in path (e.g. `/article/NBK/32884`) |

Caveat: the parameter tables on the doc page list slightly different source sets for different endpoints (e.g. citations/references list `AGR CBA CTX ETH HIR MED PAT PMC PPR`; the `/article` endpoint adds `NBK` and `CIT`). ✅ Live: `MED`, `PMC`, `PPR` all return real records via `/article/{source}/{id}`.

## 2. GET /rest/search — the workhorse

Source: https://europepmc.org/RestfulWebService (search module) + live verification.

### Parameters (all verified unless noted)

| Param | Values / behavior |
|---|---|
| `query` | keyword, phrase in quotes, fielded `field:term`, boolean combos |
| `format` | `xml` (default) / `json` / `dc` (Dublin Core, RDF/XML — search only) |
| `resultType` | `lite` (default) / `core` / `idlist` |
| `pageSize` | default 25, **max 1000** |
| `cursorMark` | opaque cursor; start by omitting (or `*`), then pass back `nextCursorMark` |
| `sort` | `FIELD asc\|desc` for single-valued fields: `CITED`, `P_PDATE_D`, `AUTH_FIRST`, `FIRST_IDATE_D`… |
| `synonym` | `true/false` (case-insensitive; also Y/N/YES/NO) — MeSH synonym expansion, default false |
| `callback` | JSONP wrapper (format must be json) |
| `email` | optional; registers you for API news |

### Response envelope ✅ (JSON, `resultType=lite`)

```json
{
  "version": "6.9",
  "hitCount": 416430,
  "nextCursorMark": "AoIIQA0ArCg1NjI4MTc2Mw==",
  "nextPageUrl": "https://www.ebi.ac.uk/...",
  "request": { "query": "p53", "resultType": "lite", "pageSize": 25, "page": 1 },
  "resultList": { "result": [ { ... } ] }
}
```
- `nextPageUrl` present on page-based GET search; absent in POST search response (only `cursorMark` paging there).
- **No `nextCursorMark` when hitCount is 1** (e.g. single-article query).

Lite result fields ✅ (typical MED hit): `id` (= PMID for MED), `source`, `pmid`, `pmcid` (when present), `doi`, `title`, `authorString`, `journalTitle`, `journalVolume`, `issue`, `pageInfo`, `pubYear`, `pubType`, `firstPublicationDate`, `firstIndexDate`, `citedByCount`, `isOpenAccess`, `inEPMC`, `inPMC`, `hasPDF`, `hasReferences`, `hasSuppl`, `hasTextMinedTerms`, `hasTMAccessionNumbers`, `hasDbCrossReferences`, `hasLabsLinks`, `hasBook` (+ `bookOrReportDetails` on non-journal items, `fullTextIdList` on FT items, `tmAccessionTypeList` on some).

`idlist` ✅: each result only `{id, pmid?, source}`.
`core` ✅: adds `abstractText`, `journalInfo{}`, `authorList{}`, `affiliation`, `meshHeadingList{}`, `chemicalList{}`, `keywordList{}`, `fullTextUrlList{}`, `pubModel`, `pubTypeList{}`, `language`, `publicationStatus`, `dateOfCreation/Revision/Completion`, `subsetList`, `authorIdList`, `authMan/nihAuthMan/epmcAuthMan`.

### Errors
- `pageSize=1001` → HTTP 200 with `{"errCode":404,"errMsg":"Invalid page size provided. Valid size is between 1 and 1000"}` ✅
- Unknown/bad query syntax generally returns an error envelope; check `errCode`/`errMsg` keys.

### Query syntax (verified by live calls)

- Boolean: `AND`, `OR`, `NOT` (upper-case), parentheses; implicit AND between terms.
- Phrases in double quotes; fielded `field:term`; wildcards `*` (e.g. `title:"cell*"`-style) supported by the engine.
- Field list (143 fields) via `GET /rest/fields?format=json` ✅ → `{"searchTermList":{"searchTerms":[{"term":"ABBR"},...]}}`. Notable fields: `TITLE, ABSTRACT, AUTH, AUTH_FIRST, AFF, JOURNAL, DOI, PMID, PMC, P_PDATE_D, FIRST_PDATE, PUB_YEAR, SRC, EXT_ID, HAS_ABSTRACT, HAS_FT, OPEN_ACCESS, HAS_REFLIST, HAS_XREFS, HAS_PDF, HAS_SUPPL, CITED, CITED_BY_PMCID, LICENSE, IN_EPMC, IS_BOOK, BOOK_TITLE, PDB_PUBS, ARXPR_PUBS, ANNOTATION_TYPE, ANNOTATION_PROVIDER, REF, REFFED_BY`...
- ✅ `SRC:MED` / `SRC:PMC` / `SRC:PPR` source filters.
- ✅ Date range: `FIRST_PDATE:[2024-01-01 TO 2024-01-31]` (worked: covid + this range → 14,545 hits).
- ✅ Flags: `OPEN_ACCESS:y`, `HAS_ABSTRACT:y`, `HAS_XREFS:y` (has database cross-refs; note: **`HAS_DB_CROSS_REFERENCES:y` is NOT a field** — returned 0 hits; the lite field is `hasDbCrossReferences` but the search field is `HAS_XREFS`).
- Full-text search: plain terms match metadata + (for full-text participants) body text; `HAS_FT:y` restricts to full-text articles. `IN_EPMC:y` = full text hosted at EPMC. Also `HAS_FT:y AND OPEN_ACCESS:y` (OA set).
- Legacy sort-in-query tokens (documented): `sort_cited:y`, `sort_date:y` inside the query string (e.g. `malaria sort_date:y` ✅). Prefer the `sort` parameter.

### Example queries (all verified live)

```bash
# Keyword search, JSON, lite fields (25/page)
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=p53&format=json'

# Max page size (1000) — verified; 1001 returns an error envelope
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=p53&format=json&pageSize=1000'

# Specific article
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=ext_id:27480119%20AND%20SRC:MED&format=json&resultType=core'

# Date-filtered
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=covid%20AND%20(FIRST_PDATE:%5B2024-01-01%20TO%202024-01-31%5D)&format=json'

# OA preprints with abstracts
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=OPEN_ACCESS:y%20AND%20HAS_ABSTRACT:y%20AND%20SRC:PPR&format=json'

# Sort by citations / date (sort param)
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=malaria&format=json&sort=CITED%20desc&pageSize=5'
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=malaria%20sort_date:y&format=json&pageSize=5'  # legacy form

# Dublin Core (RDF/XML) — search only; forces resultType=core semantics
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=malaria&format=dc&pageSize=1'
```

### Paging

- **cursorMark (recommended, stable under inserts):** first call without `cursorMark` (or `cursorMark=*`), read `nextCursorMark`, feed it back. ✅ Verified over 2 pages with `malaria sort_date:y` — hitCount stable (288,642), new cursor each page.
- `page` + `pageSize` offset paging also works for search (and is the only mode for citations/references/databaseLinks/labsLinks).
- **POST /rest/searchPOST** ✅ — same parameters as GET, sent as `application/x-www-form-urlencoded` body (`query=...&resultType=core&pageSize=10`). Use for very long queries / deep paging. Response has no `nextPageUrl`; use cursorMark.

```bash
curl -s -X POST 'https://www.ebi.ac.uk/europepmc/webservices/rest/searchPOST' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'query=cancer&format=json&pageSize=2&resultType=core'
```

## 3. GET /rest/article/{source}/{ext_id}

Source: https://europepmc.org/RestfulWebService (article module) + live verification.

Params: `resultType` (lite default — **must** pass `resultType=core` for abstract/full metadata), `format` (xml/json/dc), `callback`, `email`.

✅ Verified:
- `/article/MED/27480119` → `{"version","hitCount":1,"request":{...},"result":{...lite fields...}}` — single object under **`result`** (not `resultList`).
- `/article/MED/27480119?resultType=core` → full record incl. `abstractText`, `journalInfo`, `authorList`, `meshHeadingList`, `chemicalList`, `fullTextUrlList`.
- `/article/PMC/PMC2832744?resultType=core` → same shape (pmcid `PMC2832744`, pmid `20158213`, inEPMC=Y, isOpenAccess=N, citedByCount=56).
- `/article/PPR/PPR150163?resultType=core` → preprint record: `bookOrReportDetails`, `fullTextIdList`, doi `10.1101/2020.04.09.20056291` (no journalInfo).
- **Unknown id returns HTTP 200** with `hitCount: 0` and **no `result` key** (e.g. `/article/MED/999999999`) — don't rely on 404s.
- ⚠️ `/article/NBK/32884?format=json` behaved oddly live: request echoed `{source:"NBK", id:"32884"}` but returned an unrelated `MED/41324167` record. Treat NBK retrieval as unreliable; prefer search (`ext_id:... AND SRC:NBK`) for bookshelf items.

Core-record field notes ✅:
- `abstractText` contains **inline HTML/JATS-ish markup** (e.g. `<h4>Objectives</h4>`, `<i>`, `<sub>`) — strip tags before display.
- `journalInfo`: `{journal:{title, medlineAbbreviation, essn, isoabbreviation, issn, nlmid}, volume, issue, journalIssueId, yearOfPublication, monthOfPublication, dateOfPublication, printPublicationDate}`.
- `fullTextUrlList.fullTextUrl[]`: `{availability, availabilityCode (F=free/S=subscription), documentStyle (html/pdf/doi), site (Europe_PMC/DOI/PubMed...), url}`.
- `meshHeadingList.meshHeading[]`: `{descriptorName, majorTopic_YN}`.

```bash
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/article/MED/27480119?format=json&resultType=core'
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/article/PMC/PMC2832744?format=json&resultType=core'
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/article/PPR/PPR150163?format=json&resultType=core'
```

## 4. Citations & references

Source: https://europepmc.org/RestfulWebService (citations / references modules) + live verification.

- **`GET /rest/{source}/{id}/citations`** — articles *citing* the given one ✅
  Envelope: `{"version","hitCount":10067,"request":{...},"citationList":{"citation":[...]}}`
  Citation fields: `id, source, citationType, title, authorString, journalAbbreviation, issue, pubYear, volume, pageInfo, citedByCount`.
  Params: `page` (from 1), `pageSize` (default 25, max 1000), `format`, `callback`.
- **`GET /rest/{source}/{id}/references`** — the reference list of the given article ✅
  Envelope: `{"version","hitCount":19,"request":{...},"referenceList":{"reference":[...]}}`
  Reference fields: same as citations plus `citedOrder` (position in the article's bibliography).
  Paging ✅: `?page=2&pageSize=2` works (offset-based, not cursor).

```bash
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/MED/9843981/citations?format=json&pageSize=25'
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/MED/29867326/references?format=json&pageSize=100&page=1'
```
- `bookCitations` ❌ not documented; not tested further — use citations/references.
- Citation count also on every lite/core record as `citedByCount` ✅.

## 5. Database cross-references, labs links, datalinks

Source: https://europepmc.org/RestfulWebService (databaseLinks / labsLinks / datalinks modules) + live verification.

- **`GET /rest/{source}/{id}/databaseLinks?format=json`** — biological database records citing this publication (UniProt, ENA/EMBL, IntAct, InterPro, PDB, ChEBI, ChEMBL, OMIM, PRIDE, ArrayExpress).
  - Params: `database` (one of the codes above), `page`, `pageSize` (default 25, max 1000), `format`, `callback`.
  - Response: `{"version","request":{...,"semanticType":"<DB>"},"section":{...}}` — links grouped per section.
  - ⚠️ **Live caveat:** on every article I tried (PMIDs 30067176, 41358835; PMC13285729), the JSON body contained only `version` + `request` — no `section` data — even for articles whose lite record says `hasDbCrossReferences: Y`. Filtering with `database=UNIPROT` just echoes `semanticType`. XML may behave differently; **the reliable route to xrefs is search with `HAS_XREFS:y` + field filters, or the datalinks module below.**
- **`GET /rest/{source}/{id}/datalinks?format=json`** — consolidated data-literature links (databaseLinks + labsLinks + text-mined terms) in **Scholix** format. Params: `category`, `obtainedBy` (`tm_accession|tm_term|ext_links|submission`), `fromDate` (DD-MM-YYYY), `tags` (comma-separated: `related_data,supporting_data,plain_english,fulltext,other`), `sectionLimit`, `email`, `format`. (Endpoint timed out twice during live checks — it's heavy; use narrow filters and generous timeouts.)
- **`GET /rest/{source}/{id}/labsLinks?format=json`** — third-party External Links (LabsLink providers) ✅
  Envelope: `{"version","hitCount":2,"request":{...},"providers":[...],"linksCountList":[...]}`. Params: `providerIds`, `page`, `pageSize`, `format`.

```bash
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/MED/30067176/labsLinks?format=json'
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/MED/30067176/datalinks?format=json&obtainedBy=tm_accession'
```

## 6. Full text XML, supplementary files, book XML

Source: https://europepmc.org/RestfulWebService (fullTextXML / bookXML / supplementaryFiles modules) + live verification.

- **`GET /rest/{id}/fullTextXML`** — JATS full text for the **Open Access subset**; id-only path form (`{id}` = PMCID).
  - ✅ `https://www.ebi.ac.uk/europepmc/webservices/rest/PMC3257301/fullTextXML` → HTTP 200, `Content-Type: application/xml`, body starts `<!DOCTYPE article PUBLIC "-//NLM//DTD JATS (Z39.96) Journal Archiving and Interchange DTD with MathML3 v1.4 ...`.
  - ❌ `/rest/PMC/PMC3257301/fullTextXML` (source/id form) → 404. Use the id-only form.
  - Availability: OA articles only (`isOpenAccess:Y`, or `inEPMC` with a CC license; `inEPMC=Y` alone is NOT sufficient — the non-OA inEPMC article PMC2832744 returned 404 ✅). Check `OPEN_ACCESS:y` / `inEPMC` + license first; otherwise fetch `fullTextUrlList` links.
- **`GET /rest/{id}/supplementaryFiles`** — ZIP of supplementary files ✅
  - `https://www.ebi.ac.uk/europepmc/webservices/rest/PMC3258128/supplementaryFiles` → HTTP 200, `Content-Type: application/zip`, `Content-Disposition: attachment; filename = PMC3258128_SupplementaryFiles.zip`.
  - Optional param `includeInlineImage` (`y/true` default | `n/false`) to exclude inline images.
  - Id-only path form; non-OA images excluded by policy.
- **`GET /rest/{id}/bookXML`** — book XML for the OA bookshelf ✅
  - `https://www.ebi.ac.uk/europepmc/webservices/rest/NBK32884/bookXML` → `application/xml`, JATS Book DTD (`<!DOCTYPE book-part SYSTEM "book.dtd">`), works for the book's PMID id too (e.g. `/10510270/bookXML` per docs).
  - Only OA books; id-only path form (bare `NBK32884`, no source segment).

```bash
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC3257301/fullTextXML' | head -c 400
curl -sL -o supp.zip 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC3258128/supplementaryFiles'
curl -s 'https://www.ebi.ac.uk/europepmc/webservices/rest/NBK32884/bookXML' | head -c 300
```

## 7. Text-mined terms & annotations

Sources: https://europepmc.org/RestfulWebService (overview), https://europepmc.org/AnnotationsApi (full spec), live verification.

- ❌ **`/rest/{source}/{id}/textMinedTerms` and `/rest/{source}/{id}/annotations` are 404** (live-verified). The per-article text-mining surface in the current API is the **Annotations API** (separate controller under `/europepmc/annotations_api/`, spec: https://europepmc.org/AnnotationsApi). `GET /rest/annotations?query=...` ❌ also 404 — there is no query-based annotation search under `/rest`.
- Annotation model: W3C Open Annotation; per-article providers: `Europe PMC, HES-SO_SIB, OpenTargets, NaCTeM, IntAct, DisGeNET, PubTator_NCBI, NTNU/BSC, OntoGene, PheneBank, Metagenomics, Biostudies, Scicrunch`.
- Semantic types (queryable): `Gene_Proteins, Organisms, Chemicals, Gene Ontology, Diseases, Accession Numbers, Resources, Gene Function, Gene Disease, Protein Interaction, Biological Event, Gene Mutations, TF_TG, Software Mentions, Cell Line, ...` (full list in the AnnotationsApi doc).

### Annotations endpoints (all under `https://www.ebi.ac.uk/europepmc/annotations_api/`) ✅

- **`GET /annotationsByArticleIds?articleIds=MED:21494379[&articleIds=...]&format=JSON`**
  - 1–8 ids, each `SOURCE:EXT_ID` (PMC ext_id is the numeric part, e.g. `PMC:19992`).
  - Filters: `type` (comma list of semantic types), `subType` (database, for Resources/Accession Numbers, e.g. `uniprot,chebi`), `section` (Title/Abstract/Introduction/Methods/Results/...), `provider`, `format` (JSON | JSON-LD | XML | ID_LIST).
  - Shape: `{"articles":[{"source","extId","pmcid","fullTextIdList","annotations":[...]}]}` (JSON-LD adds a top-level `annotations` array).
  - Annotation object: `{exact, prefix, postfix, id (ann_link), section, type, subType, provider, tags:[{name, uri}], frequency, fileName}` ✅.
- **`GET /annotationsByEntity?entity=P04637&format=JSON&pageSize=1..8&cursorMark=...`** ✅
  - Articles whose annotations tag the entity; `filter=1` (default) returns only annotations tagging that entity, `filter=0` returns all annotations of matching articles.
  - Shape: `{"articles":[...same as above...], "cursorMark":"0.0", "nextCursorMark":"95.72817683"}` — cursor paging, **pageSize must be 1–8** (articles per page).
- **`GET /annotationsByProvider?provider=Europe+PMC&format=JSON...`** — same paging model, by provider.

```bash
curl -s 'https://www.ebi.ac.uk/europepmc/annotations_api/annotationsByArticleIds?articleIds=MED:21494379&format=JSON'
curl -s 'https://www.ebi.ac.uk/europepmc/annotations_api/annotationsByArticleIds?articleIds=MED:21494379&type=Gene_Proteins&section=Abstract&format=JSON'
curl -s 'https://www.ebi.ac.uk/europepmc/annotations_api/annotationsByEntity?entity=P04637&format=JSON&pageSize=1&cursorMark=95.72817683'
```

Note: JSON-LD format swaps `target`/`body` blocks (TextQuoteSelector with exact/prefix/suffix; or entity-list items for relationship annotations) — documented with examples at https://europepmc.org/AnnotationsApi#jsonLD.

## 8. Books & chapters

- Book/chapter search is regular search with `SRC:NBK` (+ `IS_BOOK:y`, `BOOK_TITLE:`). Books appear as `NBK…` records; `HAS_BOOK`/`bookOrReportDetails` appear on journal articles that belong to book collections.
- `GET /rest/{id}/bookXML` (section 6) retrieves full book/chapter XML (OA only).
- ⚠️ `/rest/article/NBK/{id}` returned a wrong record live (see §3) — verify NBK results by checking the returned `source` field, or use search.

## 9. Misc endpoints (documented, not exhaustively verified)

Source: https://europepmc.org/RestfulWebService

- `GET /rest/fields?format=json` ✅ — 143 indexed search fields (see §2).
- `GET /rest/profile?query=...&profileType=pub_type|source|all` — hit-count profile by publication type / data source. ✅ (returns `profileList`).
- `POST /rest/status-update-search` — article status monitor updates; JSON body `{"ids":[{"src":"MED","extId":"..."}]}`, header `Content-Type: application/json`; params `format=xml|json`. (Behind the Article Status Monitor.)
- `GET /rest/{source}/{id}/evaluations` — community/peer-review evaluations for an article.
- Grants API (separate service): https://europepmc.org/GristAPI.
- OAI-PMH, SOAP, FTP bulk downloads: https://europepmc.org/OaiService, https://europepmc.org/SoapWebServices, https://europepmc.org/downloads. For bulk (>25k articles/day-scale) use FTP/OAI, not the REST API.

## 10. Rate limits / courtesy policy

- **No API key, no published numeric rate limit** for Europe PMC's REST API (verified by reading the API doc, the developers hub, and searching the developer forum).
- EMBL-EBI's general services guidance expects courteous, low-volume programmatic access; there is no published whitelist/tier program for Europe PMC — the developer forum thread "Request for increased limit of API calls" (Sep 2025, https://groups.google.com/a/ebi.ac.uk/g/epmc-webservices/c/58IylGvdeY8) asks about limits and received no published-tier answer.
- Stated restriction (https://europepmc.org/developers, "Summary of protocols"): *it is not permissible to use any kind of automated process to bulk download other content from Europe PMC* beyond the offered OA/full-text-metadata bulk channels (FTP/OAI).
- Practical guidance: throttle to ~1–3 req/s, cache aggressively, use `POST /searchPOST` + cursorMark for long result sets, and bulk FTP for large corpora. A 429/403 response signals backing off.

## 11. Gotchas (all live-verified)

1. XML is the default format — always pass `format=json` (or parse XML).
2. `pageSize` > 1000 → HTTP 200 + `{"errCode":404,"errMsg":"Invalid page size provided. Valid size is between 1 and 1000"}`.
3. `/article/{source}/{id}` puts the record under `result` (singular); search/citations/references use `resultList`/`citationList`/`referenceList`. `hitCount` is still an envelope key everywhere.
4. Missing article → HTTP 200, `hitCount: 0`, no `result`/empty `resultList`. Handle by checking hitCount/result presence, not status codes.
5. `fullTextXML` and `supplementaryFiles` use **id-only** paths (`/PMC123456/fullTextXML`, `/PMC123456/supplementaryFiles`), NOT `/PMC/PMC123456/...` (that 404s). Citations/references/databaseLinks/datalinks/labsLinks DO use `/{source}/{id}/...`.
6. fullTextXML is for the **OA subset**; a non-OA inEPMC article returns 404. Use `fullTextUrlList` (core resultType) to find free/subscription links otherwise.
7. `abstractText` carries inline HTML/JATS tags — strip or render.
8. The search field for database cross-refs is `HAS_XREFS:y` (`HAS_DB_CROSS_REFERENCES` is not indexed).
9. Annotation search lives under `/europepmc/annotations_api/` (different base path than `/webservices/rest/`); `/rest/annotations?...` does not exist.
10. `databaseLinks` JSON frequently returns an empty body (only `version`/`request`) even for xref-rich articles — verify against datalinks (Scholix) or search-field routes before relying on it.
11. DC format exists only for search (`format=dc`), returns RDF/XML, and ignores `resultType` (always core-like).
12. `nextCursorMark` is absent when `hitCount <= 1`; stop paging when `resultList.result` is empty or no new `nextCursorMark` appears.
---

# Europe PMC Non-Search API Surfaces — Research Notes

**Researched:** 2026-08-28 (live API calls + crawled docs; raw pages in `~/.hermes/workspace/epmc_pages/`)
**Auth:** none — all Europe PMC APIs are free, no key.
**Docs hub:** https://europepmc.org/developers (crawled: `epmc_developers.md`)

---

## (a) Grants RESTful (GRIST) API

- **Doc URL:** https://europepmc.org/GristAPI (sub-pages: `/GristAPI/dataFields`, `/GristAPI/funderNames`)
- **What GRIST is:** the *GRant Information SysTem* — a database of grant awards supplied by the Europe PMC Funders' Group. **Does not include NIHMS grants.**

### Endpoints (both verified live)
| URL | Status |
|---|---|
| `https://www.ebi.ac.uk/europepmc/GristAPI/rest/get/query={terms}[&params]` | ✅ **verified working** (documented URL) |
| `https://www.ebi.ac.uk/europepmc/webservices/rest/grantSearch?query=...` | ❌ **404** (empty body) — do **not** use; the guess in the task brief is wrong |

### Parameters (all verified against docs)
- `query` — only obligatory param. Bare terms are keyword searches ANDed together (**separate with spaces, never `&`**); `"quoted phrase"` supported; fielded searches below. Un-fielded terms default to `kw:`.
- `resultType` — `lite` (default; key metadata) | `core` (adds abstracts, grant start/end dates, institution details)
- `page` — 25 grants/page, pages start at **1**
- `format` — `XML` (default) | `JSON` | `cerif` (CERIF XML, eurocris schema)

### Search fields (from the parameter table on the doc page)
| Field | Meaning |
|---|---|
| `ga`, `grant_agency` | funder name/abbreviation/FundRef ID (e.g. `ga:"Wellcome Trust"`, `grant_agency:501100000381`) |
| `gid`, `gr`, `grant_id` | grant number/ID |
| `title`, `ti` | grant title |
| `abstract`, `abs` | grant abstract |
| `date`, `active_date` | active date between start/end; format `yyyy-mm-dd` (mm/dd optional): `date:2012-04` |
| `kw` | titles, abstracts, streams, types |
| `pi` | PI last name + optional initials: `pi:hubbard`, `pi:"Hubbard S"` |
| `pi_id`, `author_id` | alternative ID `{type}/{value}`: `pi_id:ORCID/0000-0001-2345-6789` |
| `aff` | institution/department |
| `cat` | category grouping: `cat:"COVID-19"` |
| `epmc_funders` | `yes`/`no`/`y`/`n`/`true`/`false` |

### Response shape (JSON, **verified live**)
Top level: `{"HitCount": "1683", "Request": {"Query", "ResultType", "Page"}, "RecordList": {"Record": [...]}}`
- **Note:** keys are capitalised (`HitCount`, `RecordList`) — *not* the lowercase `hitCount`/`grantList` guessed in the brief; there is no `awardAmount` field.
- Each `Record` = `{"Person": {"FamilyName","GivenName","Initials","Title"}, "Grant": {"Funder":{"Name","pubMedSearchTerm"}, "Id", "Doi", "Title"}}` (one record per grant–PI pair).
- `resultType=core` adds abstracts, dates, institution. Pagination **headers** (`hitcount`, `page`, `query`, `resulttype`) verified live on a CERIF request: `HTTP/2 200, hitcount: 613, page: 1, query: pi:smith, resulttype: CERIF, content-type: text/xml`.

### Verified example curls
```bash
curl 'https://www.ebi.ac.uk/europepmc/GristAPI/rest/get/query=malaria&format=json'
curl 'https://www.ebi.ac.uk/europepmc/GristAPI/rest/get/query=ga:"Wellcome Trust" pi:smith&format=json'
curl 'https://www.ebi.ac.uk/europepmc/GristAPI/rest/get/query=gid:081052&resultType=core&format=json'
curl 'https://www.ebi.ac.uk/europepmc/GristAPI/rest/get/query=pi:smith&format=cerif&page=2' -D -   # pagination in headers
```
**Gotcha:** the query string is embedded in the URL *path-style* (`query=...` not `?query=...`). Encode spaces as `%20`; never join terms with `&`.

---

## (b) Annotations API

- **Doc URL:** https://europepmc.org/AnnotationsApi (Swagger UI; `api version: 2.0.3`)
- **What annotations are:** text-mined semantic entities marked up inside abstracts and open-access full text: gene/proteins, organisms, chemicals, diseases, GO terms, cell lines, accession numbers, plus relationship annotations (gene–disease, gene–drug, disease–drug) and more. Type list includes: `Gene_Proteins, Organisms, Chemicals, Gene Ontology, Diseases, Accession Numbers, Resources, Gene Function, Gene Disease, Protein Interaction, Biological Event, Gene Mutations, TF_TG, Software Mentions, Cell Line, Cell, Sequence, Organ Tissue, Molecular Process, Clinical Drug, Experimental Methods, Molecule, Pathway, Anatomy, Phenotype, ...`
- **SciLite connection:** annotations are what the SciLite viewer (https://europepmc.org/Annotations) overlays on abstracts/full text in the reading interface; the API exposes the same data programmatically.
- **Licensing scope:** annotations on abstracts + full-text articles that are open access or CC-BY / CC-BY-NC / CC0 (per the protocols table on the developers hub).

### Base URL: `https://www.ebi.ac.uk/europepmc/annotations_api/`

| Endpoint | Purpose | Key params |
|---|---|---|
| `GET /annotationsByArticleIds` | annotations for 1–8 articles | `articleIds` (SOURCE:EXTERNAL_ID), `type`, `subType`, `section`, `provider`, `format` |
| `GET /annotationsByProvider` | articles annotated by a provider | `provider`, `filter`, `format`, `cursorMark`, `pageSize` |
| `GET /annotationsByEntity` | articles tagging a named entity | `entity`, `filter`, `format`, `cursorMark`, `pageSize` |
| `GET /annotationsBySectionAndOrType` | by article section and/or annotation type | `section`, `type`, `provider`, `subType`, `format`, `cursorMark`, `pageSize` |
| `GET /annotationsByRelationship` | gene–disease etc. relationship annotations | `query`, `format`, `cursorMark`, `pageSize` |

- **`articleIds` format (verified live):** `SOURCE:EXTERNAL_ID`. Sources: `MED` (PubMed), `PMC` (numeric ID **without** the "PMC" prefix, e.g. `PMC:5389698`), `PAT, AGR, CBA, HIR, CTX, ETH, CIT, PPR, NBK`. ⚠️ `PMID:` is **rejected** — the API 400s with "SOURCE must have one of the following values [PMC, MED, ...]"; PubMed IDs must use `MED:`.
- **Providers (verified via live 400 error message):** `Europe PMC, HES-SO_SIB, OpenTargets, NaCTeM, PubTator_NCBI, IntAct, DisGeNET, NTNU/BSC, PheneBank, OntoGene, Metagenomics, Biostudies, Scicrunch, SoFAIR`.
  - Note: **UniProt / CHEBI / Disease Ontology are not "providers"** in this API's sense (the brief guessed them). UniProt/IntAct/CHEBI etc. appear as annotation **types/subTypes** (e.g. `subType=uniprot,intact,chebi` with `type=Accession Numbers` or `Resources`) or as tag URIs. The "Cell Line" and "Disease" content comes under types/`Europe PMC` provider. There is also a separate "annotations by provider/query" pattern only via these five endpoints — no generic `/rest/annotations?...` endpoint exists.
- **Pagination:** `cursorMark` (first request: omit or `0.0`; then pass back `nextCursorMark`) + `pageSize` (1–8 articles/page). The single-article `annotationsByArticleIds` returns **all** annotations for the given articles in one response.
- **`format`:** `JSON` (default) | `JSON-LD` (W3C Web-Annotation-style with `@context`, `body`, `target`, `creator`; see `#jsonLD` section of the doc page) | `XML` | `ID_LIST` (on provider/entity/section endpoints).

### Response shape (JSON, **verified live**)
```json
[ { "source": "MED", "extId": "27924004", "pmcid": "PMC5389698",
    "annotations": [ {
      "prefix": "e, we evaluated the ", "exact": "genome", "postfix": "-wide distribution o",
      "tags": [ { "name": "genome", "uri": "http://purl.obolibrary.org/obo/SO_0001026" } ],
      "id": "http://europepmc.org/abstract/MED/27924004#ontogene-...",
      "type": "Sequence", "section": "Abstract (http://purl.org/dc/terms/abstract)",
      "provider": "OntoGene" } ] } ]
```
- `exact` = the matched text span, with `prefix`/`postfix` context; `tags[]` carry the mapped database entity `name` + `uri`; `type` = semantic type; `provider` = source of annotation; `frequency` appears on provider-aggregated results; `section` = where in the article.
- Verified live on `PMC:5389698`: 592 annotations, providers `Europe PMC` + `OntoGene`, types `Accession Numbers, Cell Line, Chemicals, Diseases, Experimental Methods, Gene Ontology, Gene_Proteins, Organisms, Sequence`.

### Verified example curls
```bash
# Annotations for one article's abstract (note MED: not PMID:)
curl -H 'Accept: application/json' \
  'https://www.ebi.ac.uk/europepmc/annotations_api/annotationsByArticleIds?articleIds=MED:27924004'

# Provider-aggregated stream (paginated, 1-8 articles/page)
curl -H 'Accept: application/json' \
  'https://www.ebi.ac.uk/europepmc/annotations_api/annotationsByProvider?provider=Europe%20PMC'

# Filter to annotation type(s) + accession-number database
curl -H 'Accept: application/json' \
  'https://www.ebi.ac.uk/europepmc/annotations_api/annotationsByArticleIds?articleIds=PMC:5389698&type=Diseases,Chemicals&format=JSON'
```

---

## (c) OAI-PMH service

- **Doc URL:** https://europepmc.org/OaiService
- **Documented base URL:** `https://europepmc.org/oai.cgi?` — **currently broken from plain curl**: returns Cloudflare `error 1016` (DNS origin error), and following the redirect yields EBI `Error: 500` pages. ⚠️ **Verified broken on 2026-08-28 — flag to the skill author: test before relying on it.**
- **`https://www.ebi.ac.uk/europepmc/webservices/oai`** (the URL guessed in the task brief) → **404** (verified: plain curl HTTP 404, headless browser 404 page). **Moved/does not exist.**
- Protocol: OAI-PMH **2.0** only (no earlier versions). Most items are copyright-protected; full text is only harvestable for the **public-domain + Open Access subset** (`set=pmc-open`).

### Formats & sets (from doc page)
- `metadataPrefix=pmc` → **NLM Journal Archiving XML full text** (open-access subset only)
- `metadataPrefix=pmc_fm` → NLM metadata only
- `metadataPrefix=oai_dc` → Dublin Core metadata only
- (No "JATS" prefix name — the NLM format *is* the JATS predecessor; use `pmc`/`pmc_fm`.)
- Set: `pmc-open` = all items whose full text may be harvested.
- **Segmentation:** ListIdentifiers > 1000 hits → resumptionToken; ListRecords page sizes: 25 (pmc full text), 50 (pmc metadata), 250 (oai_dc).

### Documented verb examples
```
https://europepmc.org/oai.cgi?Verb=Identify
https://europepmc.org/oai.cgi?Verb=ListmetadataFormats
https://europepmc.org/oai.cgi?Verb=ListSets
https://europepmc.org/oai.cgi?verb=ListRecords&metadataPrefix=pmc&set=pmc-open
https://europepmc.org/oai.cgi?verb=ListRecords&from=2007-10-01&metadataPrefix=pmc
https://europepmc.org/oai.cgi?verb=GetRecord&metadataPrefix=pmc&identifier=oai:europepmc.org:2654146
```

### OAI vs REST guidance
- **Use OAI-PMH** for standards-compliant repository harvesting/synchronization of bulk metadata (oai_dc / NLM XML) and scheduled incremental pulls (`from=` date + `resumptionToken`).
- **Use the Articles REST API** for interactive/query-driven access (search, individual records, citations, JSON), and **FTP bulk downloads** for one-off large corpora. OAI at Europe PMC is currently unreliable (see flag above), so prefer REST + FTP for agents.

---

## (d) Bulk downloads (FTP)

- **Doc URL:** https://europepmc.org/downloads (sub-pages: `/downloads/openaccess`, `/downloads/manuscripts`, `/downloads/preprints`, and `/FtpSite`)
- **FTP root (verified live):** https://ftp.ebi.ac.uk/pub/databases/pmc/ (also reachable via https://europepmc.org/ftp/... which proxies/redirects into the same tree). Direct FTP protocol host: `ftp.ebi.ac.uk` (anonymous).
- **Licensing constraint (from developers hub, verbatim):** *"It is not permissible to use any kind of automated process to bulk download other content from Europe PMC"* — i.e. everything outside the open-access/bulk sets. Full text is limited to the OA subset.

### Directory map (verified live 2026-08-28)
| Path | Content | Update |
|---|---|---|
| `oa/` | **Open-access full-text XML article packages**, flat `PMCxxxxx_PMCyyyyy.xml.gz` chunks (e.g. `PMC13900_PMC17829.xml.gz` ≈ 1.1 MB; ~1290 packages covering PMCIDs up to ~PMC13.3M); subdirs: `AccNoAnalysisData/`, `AccNoSupplData/`, `SectionisedData/`, `efo_go/`, `ner_tagging/`, `set_v1/` | updated ~monthly (last-modified 2026-07-25) |
| `PMCLiteMetadata/` | **Metadata XML for ALL full-text articles** (lite response format): single `PMCLiteMetadata.tgz` = **2.1 GB** (verified) | weekly |
| `PMCOALiteMetadata/` | lite metadata for OA subset | weekly |
| `manuscripts/` | author manuscripts (funder-mandated), XML + text | — |
| `preprints/`, `preprint_abstracts/` | preprint full text / abstracts (XML) | frequent |
| `DOI/` | PMID–PMCID–DOI mapping files | monthly (overwritten 1st of month) |
| `TextMinedTerms/` | text-mined accession numbers in articles | weekly |
| `ref_check/` | CSV of author-manuscript deposition dates (HEFCE REF) | monthly |
| `article-html/`, `pdf/`, `journals/`, `micropubs/`, `otar/`, `fc/`, `rendered_pages/` | other formats/experiments | — |

### Agent guidance: bulk vs API
- **Bulk (FTP):** one-shot corpus builds, local indexing/embedding over the full OA set, weekly metadata snapshots — always cheaper than millions of REST calls, and it's the *only* permitted way to mass-download full text.
- **API (REST):** targeted lookups, search-driven workflows, citations/references, anything incremental or interactive; annotations via the Annotations API.
- **Never:** loop the REST search endpoint to drain the whole corpus, or download non-OA full text programmatically (explicitly prohibited; risk of IP blacklisting).

### Verified example curls
```bash
# List OA packages
curl 'https://europepmc.org/ftp/oa/' | grep -oE 'PMC[0-9]+_PMC[0-9]+\.xml\.gz' | head
# Download one OA article package
curl -O 'https://europepmc.org/ftp/oa/PMC13900_PMC17829.xml.gz'
# All full-text metadata (2.1 GB)
curl -O 'https://europepmc.org/ftp/pmclitemetadata/PMCLiteMetadata.tgz'
# PMID-PMCID-DOI mappings
curl 'https://europepmc.org/ftp/DOI_mappings/'
```

---

## (e) SOAP web service (legacy)

- **Doc URL:** https://europepmc.org/SoapWebServices
- **WSDL (verified live, HTTP 200, JAX-WS RI 2.3.2):** `https://www.ebi.ac.uk/europepmc/webservices/soap?wsdl`
- Test WSDL: `https://www.ebi.ac.uk/europepmc/webservices/test/soap?wsdl`
- Current production version: **6.5**; reference guide PDF: https://europepmc.org/docs/EBI_Europe_PMC_Web_Service_Reference.pdf
- **Status: legacy.** Two parallel versions are kept only so users can migrate between releases. **Recommendation for agents: ignore SOAP, use the Articles REST API** (same data, JSON, simpler). Clients: JAX-WS (Java), Perl (docs at `/JaxWs`, `/Perl`).

---

## (f) EBI rate limits / courtesy policy

- **`https://www.ebi.ac.uk/data_services` is 404 (verified, both curl and headless).** No single public EBI "whitelist" policy page found for Europe PMC.
- **No explicit published requests/sec limit exists for Europe PMC APIs.** What is documented/verifiable:
  - EBI-wide guidance is per-service; e.g. the EBI Proteins API doc (https://www.ebi.ac.uk/proteins/api/doc) states: *"We limit your requests to 200 requests/second/user"* — indicative of EBI's general tolerance scale, not an EPMC rule.
  - EBI firewall blacklisting is real: frequent automated hits can get an IP blacklisted (see e.g. eQTL Catalogue data-access notes), requiring manual whitelisting by EBI support (https://www.ebi.ac.uk/support).
  - Europe PMC's own channel for higher-limit / partnership requests is the **developer forum**: https://groups.google.com/a/ebi.ac.uk/g/epmc-webservices (e.g. thread "Request for increased limit of API calls", Sep 2025, unanswered publicly) and the helpdesk via https://europepmc.org/ContactUs.
  - The hard content rule is licensing-based, not rate-based: automated bulk download is permitted **only** for the bulk sets listed in (d); "It is not permissible to use any kind of automated process to bulk download other content."
- **Practical guidance for agents:** stay ≤ ~1–2 requests/sec, set a descriptive User-Agent, cache aggressively, prefer FTP for bulk, and use `pageSize=25` (max 1000) on REST search rather than repeated small calls. No API key exists; nothing to whitelist in advance — contact the forum/helpdesk if a project needs sustained high volume.

---

## (g) Search syntax (field tags etc.) — for query building

- **Canonical doc:** https://europepmc.org/searchSyntaxGuide — ⚠️ **page renders only section headers in every render/crawl attempt** (tables load via XHR; raw HTML contains no field tags). Mirrors `dev.europepmc.org` / `staging.europepmc.org` behave identically. Flag: the guide's content could not be captured; syntax below was **verified against the live search API** instead (base `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=...&format=json`).
- **Verified field queries (live hitCounts on 2026-08-28):**

| Syntax | Example | Verified hitCount |
|---|---|---|
| `TITLE:"phrase"` | `TITLE:"cluster randomised"` | 4,753 |
| `ABSTRACT:` | (documented; same pattern as TITLE) | — |
| `AUTH:"J Smith"` | `TITLE:"cluster" AND AUTH:"J Smith"` | 131 |
| `JOURNAL:` | (documented; e.g. `JOURNAL:"Nature"`) | — |
| `DOI:`, `PMID:`, `PMC:` | ID lookups | — |
| `FIRST_PDATE:[y TO y]` | `"cluster randomised" AND FIRST_PDATE:[2020 TO 2024]` | 7,391 |
| `PUB_YEAR:yyyy` | `"cluster randomised" AND PUB_YEAR:2023` | 1,527 |
| `SRC:` | `SRC:PPR` (preprints) | 1,226,926 |
| `OPEN_ACCESS:y` | `"cluster randomised" AND OPEN_ACCESS:y` | 3,157 |
| `HAS_ABSTRACT:y` | `(TITLE:"machine learning" OR TITLE:"deep learning") AND HAS_ABSTRACT:y` | 139,204 |
| Boolean | `AND`, `OR`, `NOT`, parentheses (verified in combos above) | — |
| Wildcard | `TITLE:immun*` | 1,005,413 |
| Phrase | `"cluster randomised"` (double quotes) | — |
| Sort by citations | `&sort=CITED desc` (with `OPEN_ACCESS:y` example: 11,943 hits) | — |

- Response envelope (verified): `{"version":"6.9","hitCount":N,"nextCursorMark":"...","nextPageUrl":"...","request":{...},"resultList":{"result":[...]}}`
- **Agent-useful extras (documented on REST page / well-established):** `HAS_FT:y` (has full text), `LANG:eng`, date range `FIRST_PDATE:[2020-01-01 TO 2020-12-31]`, `&pageSize=` up to 1000, `&cursorMark=` deep pagination, `&resultType=core|lite`.
- **URL-encoding gotcha (verified):** space (`%20`) inside a query string value works, but `[` `]` must be percent-encoded (`%5B`/`%5D`) in some clients — `FIRST_PDATE:[2020 TO 2024]` failed unencoded via curl and succeeded as `%5B2020%20TO%202024%5D`. Always fully URL-encode query values.

---

## Quick status table (all verified 2026-08-28)

| Surface | Status |
|---|---|
| Grants (GRIST) `GristAPI/rest/get/` | ✅ working (legacy-style URL is the *documented* one) |
| `webservices/rest/grantSearch` | ❌ 404 — do not use |
| Annotations API `annotations_api/*` | ✅ working (5 endpoints; `MED:` not `PMID:`) |
| OAI `webservices/oai` | ❌ 404 — moved / never at EBI host |
| OAI `europepmc.org/oai.cgi` | ⚠️ broken from curl (Cloudflare 1016 → EBI 500 page); verify before use |
| Bulk FTP `ftp.ebi.ac.uk/pub/databases/pmc/` | ✅ working (`oa/`, `PMCLiteMetadata/`, `DOI/`, ...) |
| SOAP WSDL `webservices/soap?wsdl` | ✅ responds (legacy — prefer REST) |
| EBI `/data_services` | ❌ 404 — no single EBI rate-limit page; per-service limits only |
| searchSyntaxGuide page tables | ⚠️ JS/XHR-only — could not be captured; syntax verified via live search API |