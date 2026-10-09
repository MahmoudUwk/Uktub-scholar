# Crossref API — Deep Reference (live-verified 2026-08-29)

Everything below was verified against `https://api.crossref.org` with mailto'd requests during the skill build unless marked [docs]. Source URLs per section. Base: `https://api.crossref.org` (free, keyless).

## Sources

- REST API docs: https://github.com/CrossRef/rest-api-doc (`README.md`, `api_format.md` — fetched raw from raw.githubusercontent.com/CrossRef/rest-api-doc/master/)
- Swagger UI: https://api.crossref.org/swagger-ui/index.html — interactive only
- Etiquette / Plus: https://www.crossref.org/documentation/metadata-stewardship/etiquette/ , https://www.crossref.org/services/metadata-delivery/plus-service/

## Envelope shapes (live)

List (`/works?rows=0&mailto=...` → HTTP 200, 194 bytes):

```json
{"status":"ok","message-type":"work-list","message-version":"1.0.0",
 "message":{"facets":{},"total-results":185961640,"items":[],
            "items-per-page":0,"query":{"start-index":0,"search-terms":null}}}
```

Singleton (`/works/{doi}`): `message-type: "work"`, `message` = the record. Other `message-type`s seen: `type-list` (/types, 30 items of `{id,label}`), `license-list` (items are plain URL strings), `journal`/`journal-list`, `funder-list`, `member-list`, `work-agency` (`{"DOI":..., "agency":{"id":"crossref","label":"Crossref"}}`).

Error bodies are NOT JSON: HTTP 404 → plain text `Resource not found.`; HTTP 429 → `Social activity too high... try again later`; validation errors ARE JSON: `{"status":"failed","message-type":"validation-failure","message":[{"type":"select-not-available","value":"bogus_field","message":"... Valid selections are: ..."}]}`. [docs + live]

## /works parameters [docs README "Parameters" + live]

| param | notes |
|---|---|
| `query` | free-text, all fields; relevance-ordered |
| `query.bibliographic` | title+authors+ISSN+year blob — the citation-lookup query; THE way to resolve titles |
| `query.author` / `.editor` / `.chair` / `.translator` / `.contributor` | contributor given+family names |
| `query.container-title` | publication (journal/book) name |
| `query.affiliation` | contributor affiliations |
| `query.title` | **DEPRECATED** by Crossref ("no longer available" per docs) but live-returns 200, falling through to a general query — prefer `query.bibliographic`. |
| `filter` | comma-separated `name:value`; different names AND, repeated name OR |
| `rows` | 1..1000 (default 20; 0 → summary only) [docs: max 1000, live-verified cap respected] |
| `offset` | max 10000 on /works |
| `cursor` | `cursor=*` to start; then `message.next-cursor`; available on all /works routes; cannot combine with offset/sample [docs] |
| `sample` | max 100, random; ignores rows/offset [docs] |
| `sort` | score/relevance, updated, deposited, indexed, published, published-print, published-online, issued, is-referenced-by-count, references-count |
| `order` | asc / desc |
| `select` | comma-separated work fields — see below |
| `facet` | e.g. `facet=type-name:*` (facets: affiliation, funder-name, funder-doi, orcid, container-title, issn, published, type-name, license, category-name, relation-type, publisher-name, ...) |
| `mailto` | polite-pool identifier (also acceptable in User-Agent) |

Filter list (works): `has-funder, funder:{id}, prefix:{p}, member:{id}, from/until-index-date, from/until-deposit-date, from/until-update-date, from/until-created-date, from/until-pub-date, from/until-online-pub-date, from/until-print-pub-date, from/until-posted-date, from/until-accepted-date, has-license, license.url, license.version, license.delay, has-full-text, full-text.version, full-text.type, full-text.application, has-references, reference-visibility:{open,limited,closed}, has-archive, archive, has-orcid, has-authenticated-orcid, orcid:{id}, issn:{xxxx-xxxx}, isbn, type:{type-id}, directory:{doaj}, doi:{doi}, updates:{doi}, is-update, has-update-policy, container-title:{exact}, category-name, type-name, award.number, award.funder, has-assertion, assertion-group, assertion, has-affiliation, alternative-id, article-number, has-abstract, has-clinical-trial-number, content-domain, has-content-domain, has-domain-restriction, has-relation, relation.type, relation.object, relation.object-type`. Dates accept `YYYY`, `YYYY-MM`, `YYYY-MM-DD`; missing month/day pad to 1 [docs "Notes on dates"]. `from-index-date` is the recommended incremental-harvest filter [docs].

## select semantics (live)

- `select=DOI,title,author,issued,container-title,is-referenced-by-count,references-count,type,publisher,volume,issue,page,ISSN,published,URL` → HTTP 200; returned keys are the intersection with the record's fields (a record without volume just omits it).
- Unknown field → HTTP 400 `validation-failure` with the valid list in the message (machine-parseable).
- **`score` IS selectable** (`select=DOI,score` → 200, live-verified); only `scores` (plural) → 400. Relevance scores also appear on full records (no select param).
- `title`, `container-title`, `original-title`, `subtitle`, `short-title` are ARRAYS of strings [docs api_format.md Work table].

## Relevance score semantics — live observations

- Query present → default order = relevance (score). No query → DOI update date [docs "Sort order"].
- Score values observed 19–53 in tests; **higher is not "better paper"** — it tracks token overlap between query and record text. Real examples: `10.3410/f.726105619.793525345` "Faculty Opinions recommendation of Mastering the game of Go..." (dataset, 2 citations) ranked above `10.1038/nature16961` (journal-article, 11,495 citations); "(Author Correction)" records with near-identical titles outrank the original; publisher "component" records (…/mm1, …/s001) swarm acronym queries.
- Keys with `letter`/`sub` variants (potential corrections): there is **no `potential-update` field** — use `update-to` (on singleton records), `is-update:true` filter, or `relation.type:is-preprint-of` [docs relations filter].
- Records may have `score` even when title-less; ACL/ dblp-style records (`10.18653/v1/N19-1423`, 8,242 citations) can return **empty `title: [""]` with a complete author list** — resolve-by-title can't match it, resolve-by-author+venue can.
- `total-results` sloshes between calls for the same query (live: 1,230,260 vs 3,742,570 for the same bibliographic query seconds apart) — treat it as indicative, never citable.
- No-query lists sort by DOI update date; `sort=is-referenced-by-count&order=desc` gives the most-cited works matching filters (used by `resolve` when only filters, no query terms).

## Rate limits / etiquette (docs + live)

- Docs: identify via `mailto` query param **or** User-Agent `Product/x.y (https://uri; mailto:you@example.org)`. Polite pool = "elevated" service tier; Crossref: "we may throttle pooled machines when impolite activity spikes ... redirect to a faster pool".
- `X-Rate-Limit-Limit` / `X-Rate-Limit-Interval` (e.g. `50` per `1s`) advertise the current cap; live keyless burst observed `1/1s` after a fast series — pacing ≥1 s/call avoided all 429s during ~45-call build. `X-Rate-Limit-Remaining` sometimes absent.
- Etiquette: no full-corpus harvesting via the public API; fine to resolve metadata per-need. `Crossref-Plus-API-Token: Bearer <jwt>` (paid "Plus" SLA) exists for production but is NOT needed for metadata access — note-only in this skill.
- 429 handling: exponential backoff; the script retries 429/500/502/503/504 ×3 (1.5s/3s/6s).

## Works record — field notes (api_format.md)

- `issued` = earliest of published-print / published-online (required). Prefer for display: `published-online` → `published-print` → `issued` → `created` (registration). `created`/`deposited`/`indexed` are full timestamps (date-parts + date-time + timestamp); publication dates are Partial Dates (`date-parts: [[y,m,d]]`, any tail optional). Some records ship [[null,…]] parts.
- `reference-count` deprecated ≡ `references-count` (outbound); `is-referenced-by-count` = inbound (cite counts from Crossref deposits only — typically lower than Google Scholar).
- `license[]`: `{URL, content-version(vor|am|tdm|unspecified), delay-in-days, start}`; `link[]`: `{URL, content-type, content-version, intended-application(text-mining|similarity-checking|unspecified)}`; `funder[]`: `{name, DOI(10.13039/...), award[], doi-asserted-by}`; `update-to[]`: `{DOI, type(retraction|correction|...), updated, label}`; `relation`: map of relation → `{id-type, id, asserted-by}`.
- Contributors: `{given, family, name(=orgs), ORCID(url form), authenticated-orcid, affiliation[{name}], sequence(first|additional)}`.
- JATS XML may ride in `abstract` — needs tag-strip + entity decode.

## Other endpoints (live)

- `/journals?query=...&rows=N` → journal-list; items `{title, publisher, ISSN[print,electronic], issn-type[{type:pissn|eissn|lissn, value}], counts{total-dois, current-dois, backfile-dois}}`. `/journals/{issn}` = singleton (only the ISSN Crossref holds; a valid-but-foreign ISSN 404s). `/journals/{issn}/works` works (Nature: 447,018 works).
- `/funders?query=...&rows=N` → funder-list; items `{id (10.13039/...), name, location, alt-names[], uri}`. National Science Foundation → `10.13039/100000001` (~110 matches on that name). `/funders/{id}/works?query=...` = works funded by that funder (561,796 for NSF with query=global state row=1 pre-test). Funder filter alternative: `filter=funder:10.13039/...` (or `award.funder` + `award.number` dot-filters).
- `/types` → 30 type ids: book-section, monograph, report-component, report, peer-review, book-track, journal-article, book-part, other, book, journal-volume, book-set, reference-entry, proceedings-article, journal, component, book-chapter, proceedings-series, report-series, proceedings, database, standard, reference-book, posted-content, journal-issue, dissertation, grant, dataset, book-series, edited-book.
- `/licenses?query=...&rows=N` → license-list; items are plain URL strings (~28,950 live). For per-work license data use the work's `license[]` field or `/works?facet=license:*&filter=issn:...`.
- `/members?query=elsevier` → member-list (`{id, primary-name, location, counts{...}, ...}`). Also `/prefixes/{prefix}` (+`/works`), `/works/{doi}/agency` (→ crossref|datacite|medra|public).
- `/members/{id}/works?filter=type:journal-article&cursor=*` = the docs' deep-paging example.

## Worked resolve examples (live, via scripts/crossref.py)

| partial info | query built | live result |
|---|---|---|
| exact title | `query.bibliographic='attention is all you need'` | noise top ("Is Attention All You Need?" book chapter, cit 55) — NeurIPS record absent from Crossref |
| title + author | same + `query.author=vaswani` | **10.65215/ysbyhc05**, posted-content 2025, cit 21, 8 Google-Brain authors, match=exact/high |
| full title + year | `query.bibliographic='bert pretraining of deep bidirectional transformers'` + 2019 filters | multiple BERT records; **Devlin's record is `10.18653/v1/N19-1423` (8,242 cit) with EMPTY title** — the 2019-NAACL record resolves via author/venue but may surface only via alternates/re-rank (QA live-run at rows 5-8 did not surface it in alternates; match=none is the correct stop signal) |
| title + author + year (+type) | CLIP paper 'clip learning transferable visual models' +radford +2021 +journal-article | not found — real title is 'Learning Transferable Visual Models From Natural Language Supervision' (ICML/PMLR had no DOIs; hidden from Crossref under nickname queries) |
| partial fragment | `query.bibliographic='galnac lnp'` | 10.18609/nuc.2026.021 "Challenging the GalNAc dogma: intrinsic LNP chemistry…" after junk demotion |
| author + year + journal (no title) | `query.author=Devlin Chang`, `query.container-title=North American Chapter of the Association for Computational Linguistics`, 2019 | matches found but not always first: QA live-run ranked a different NAACL 2019 paper top (Devlin's N19-1423 has an EMPTY title in Crossref and sat only in alternates) — always verify the first author of `top`; author-field coverage is unreliable at ACL/NAACL-style venues |
| ISSN + year (no title) | `filter=issn:0028-0836,from/until-pub-date:2023`, sort=citations | 10.1038/s41586-022-05473-8 FinnGen (cit 3,858) |
| DOI known | `/works/{doi}` | 10.1038/nature14539 "Deep learning" (Springer); 10.1038/nature16961 AlphaGo (funder presence varies by publisher deposit — this record has none) |
| weird-cased / wrapped DOI | `10.1038/NATURE14539`, `doi:…`, `https://doi.org/…` | 200 — DOIs are case-insensitive; `doi:` and https wrappers normalized |
| URL-encoded slash DOI | `/works/10.1002%2F0470841559.ch1` | 200 (path-encode the DOI, not just the slash) |
| arXiv DOI | `/works/10.48550/arXiv.1706.03762` | **404** — DataCite-registered, Crossref does not serve it (correct `{"error"}` + exit 2) |
| dblp DOI | `/works/10.5555/3295222.3295349` | **404** (NeurIPS records are not Crossref) |
| bad DOI | `/works/10.9999/nope.nope` | 404 → {"error"} exit 2 |
| nonsense query | `query=zzxxxqqqyyyelephant-unicorn-9x7y2z` | HTTP 200 total-results 3,074 (tokens OR'd; near-empty candidate lists only with very restrictive filters — check top quality, not total) |
| unicode title | `overshoot` (á characters) | 200; urllib encodes correctly; no special handling needed |
| ampersand | `AT&T laboratories speech` | 200 (urlencode escapes) |

## Preprint vs published handling (live)

- Same paper can exist as `journal-article` (VoR) and `posted-content` (preprint/re-deposit) under different DOIs. Citation count concentrates on the VoR (Nature14539: 75,795) while preprints carry ~0–21.
- `10.65215/*` posted-content re-deposits (2025) reproduce full author lists/affiliations for papers whose original venue has no Crossref DOIs (NeurIPS) — often the ONLY Crossref resolution; publisher field may be a re-deposit service ("Shenzhen Medical Academy of Research and Translation"), not the venue.
- Retraction/correction handling: `update-to[]` on the VoR record; filters `is-update:true`, `updates:{doi}`; `relation.type:is-preprint-of` links some preprint↔VoR pairs.
- Recommendation: for metadata extraction prefer the VoR (`--type journal-article` or higher `is-referenced-by-count`); for availability/link questions, ask doi.org with BOTH DOIs.

## Matching-quality playbook (what worked / what didn't)

- Worked: full title exact; full title + author (+year filters); author+venue+year without title (filters-only path); ISSN+year; fragment of distinctive technical terms ('galnac lnp'); DOI in any casing/wrapper.
- Half-worked: truncated titles ('mastering the game of go' — Nature paper buried beyond top-5 among 'Go'-word noise); title terms the record doesn't share ('bert pretraining of deep…' vs record fragment 'Pre-training of Deep Bidirectional Transformers' matched an unrelated Spectrum-BERT component as top).
- Failed as-is: acronym nicknames ('clip', 'bert' alone), generic fragments, proceedings-only venues (PMLR/ICML, NeurIPS; ACL parted via member-deposited comps). Countermeasure: get a fuller title, add `--author`, and use `--type` filters; treat `match=none` as a stop sign, then switch to a discovery-first provider.
- Alternates quality: good (real sibling records, corrections demoted) once junk demotion + citation tie-break apply; empty titles and derived records still make manual review worth it for weak matches.

## Script notes (scripts/crossref.py)

- stdlib only (urllib, json, argparse, re, time); one JSON object per command; errors `{"error": ...}` to stderr, exit 2; `_clean` drops nulls; timeout 30 s + retry w/ backoff on 429/5xx; mailto from CROSSREF_EMAIL env (or `--email`); User-Agent identified as `UktubAI-CrossrefSkill/0.1 (…; mailto:…)`.
- DOI normalization: strips `doi:` and `https://doi.org/`; path-segments percent-encoded; junk-demotion re-ranker (`no-title`, corrections, datasets, grants, peer-reviews, components) + citation tie-break; year-inside-bibliographic fallback when date filters zero out; `rows` default 5, max 1000.

## Cross-output conventions [docs mime-type]

`Content-Type: application/vnd.crossref-api-message+json`; versioning doc: major-version routes via `/v1/works` style prefixes; legacy versions supported ≤9 months. [docs]