---
name: europepmc
description: Search Europe PMC articles, annotations, grants via REST.
version: 0.1.0
author: Mahmoud Sallam (mahmoudsallam), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [europepmc, pubmed, pmc, preprints, citations, annotations, grants, research, api]
    related_skills: [semantic-scholar, openalex, arxiv]
---

# Europe PMC Skill

Query Europe PMC — EMBL-EBI's open repository of 48M+ life-sciences records (PubMed/MEDLINE, PubMed Central OA full text, preprints, patents, theses, NLM Bookshelf) — through a tested stdlib-only CLI. Free, **no API key**. Strongest for: biomedical literature + OA full-text JATS XML, text-mined entity annotations (genes, diseases, chemicals), grant data (GRIST), and citation graphs. Complements semantic-scholar (broader CS coverage, TLDRs) and openalex (institutions/funders/OA links); Europe PMC is the authoritative source for PMC full text and life-science entity tagging.

## When to Use

- Biomedical/health/life-science literature search (PubMed + PMC + preprints in one index)
- Get OA full text as structured JATS XML (better than PDF scraping)
- Text-mined annotations: genes, proteins, diseases, chemicals, organisms per article, or articles per entity
- Citation graphs (citing + references with bibliography order)
- Grant awards via GRIST (funder, PI, grant id; not NIHMS)
- Don't use for: bulk corpus pulls (use FTP, see reference — REST looping is prohibited), CS/theory papers (use semantic-scholar), institution-level bibliometrics (use openalex)

## Prerequisites

- python3 (stdlib only)
- No key, no registration. Be courteous: no published rate limit, but stay ~1-2 req/s; EBI firewalls aggressive IPs. Set `EPMC_SLEEP` env (default 0.3s) to tune.

## How to Run

```
terminal(command="python3 <skill_dir>/scripts/europepmc.py search 'TITLE:\"crispr\" AND OPEN_ACCESS:y' --page-size 25")
```

Output: one JSON object on stdout. Errors: `{"error": "..."}` on stderr, exit 2. Article ids: `MED/27480119`, `PMC/PMC2832744`, `PPR/PPR150163`, or bare PMID (auto-routed to MED).

## Quick Reference

```
# SEARCH (default relevance; boolean AND/OR/NOT, quotes, wildcards)
... search 'crispr'                                            # keyword
... search 'TITLE:"cluster randomised" AND OPEN_ACCESS:y'      # fielded (hitCount verified 3157)
... search 'malaria' --sort "CITED desc" --page-size 100       # most-cited first
... search 'FIRST_PDATE:[2024-01-01 TO 2024-12-31]' --sort "P_PDATE_D desc"
... search 'crispr' --cursor <nextCursorMark>                  # deep paging
... search 'p53' --result-type core                            # + abstract, MeSH, affiliations
... search 'p53' --result-type idlist                          # ids only (fast)
# ARTICLE
... get MED/27480119                 # core metadata (abstract, journal, OA flags, fullTextUrls)
... citations MED/27480119           # citing articles
... references MED/29867326          # bibliography (order preserved)
... labslinks MED/30067176           # Altmetric etc. external links
# TEXT MINING (separate API base)
... annotations MED/27924004         # genes/diseases/chemicals tagged in the article
... annotations PMC/PMC5389698 --type Diseases,Chemicals
... annentity P04637                 # articles tagging UniProt P04637 (p53), pageSize 1-8
# FULL TEXT (OA subset only)
... fulltextxml PMC3257301 --out paper.xml    # JATS XML, ~150KB typical
... suppfiles PMC3258128 --out supp.zip       # supplementary files ZIP
# GRANTS (GRIST)
... grants 'ga:"Wellcome Trust" pi:hubbard'   # fields: ga, pi, gid, ti, abs, aff, cat, date
# HELPERS
... fields                           # all 143 indexed search fields
... syntax                           # query-language cheat sheet
```

## Procedure

1. **Search** — `search` with `--page-size 25-1000`; lite resultType is compact and has OA/fulltext/citation flags. Deep paging: feed `nextCursorMark` back via `--cursor`. `--result-type idlist` when you only need ids.
2. **Resolve IDs** — PMID -> `MED/<pmid>`; PMCID -> `PMC/<pmcid>`; preprints -> `PPR/<id>`. Bare integers route to MED automatically. Use `get` (returns hitCount 0 object for unknown ids — never a 404).
3. **Metadata** — `get` returns core record: title, authors, journal, doi, OA flags, `fullTextUrls`. Abstracts have JATS/HTML tags stripped by the script.
4. **Citations** — `citations` (who cites this) and `references` (what this cites, in `citedOrder`). Offset paging (`--page`), not cursor.
5. **Annotations** — `annotations MED/27924004` (slash or colon form both work: `MED:27480119`, `PMC:5389698`) returns text-mined entities with exact spans, semantic types, providers, and mapped ontology URIs. Filter by `--type Diseases,Gene_Proteins`, `--provider`, `--section Abstract`. Cross-article: `annentity <accession-or-term>` (1-8 articles/page, cursor).
6. **Full text** — `fulltextxml` for the OA subset (id-only path `/PMC.../fullTextXML`). Non-OA articles 404 — fall back to `fullTextUrls` from `get`. JATS XML is the structured form for downstream parsing.
7. **Grants** — `grants 'field:term'` (ga/grant_agency, pi, gid, ti, abs, aff, cat). Query is path-style embedded; terms are space-joined, never `&`.

## Pitfalls

- **Always `format=json`** — XML is the default everywhere.
- **`/article/{src}/{id}` puts the record under `result`** (singular); search/citations use `resultList`/`citationList`. The script handles this.
- **Missing ids return HTTP 200 + hitCount 0**, not 404 — check `hitCount`, not status codes.
- **`fullTextXML`/`supplementaryFiles`/`bookXML` use id-only paths** (`/PMC3257301/fullTextXML`); the `/PMC/PMC.../fullTextXML` form 404s. Citations/references/labsLinks DO use `/MED/{pmid}/...` form.
- **fullTextXML is OA-only** — `inEPMC:Y` alone is NOT sufficient (non-OA inEPMC articles 404); check `isOpenAccess:Y` or the license.
- **`databaseLinks` JSON is unreliable** (often returns empty body even for xref-rich articles) — use `HAS_XREFS:y` search or `datalinks` (Scholix) instead; the script therefore does not wrap it.
- **Annotations API is a different base** (`/europepmc/annotations_api/`, not `/webservices/rest/`) and uses `MED:<pmid>` (`PMID:` prefix 400s) and `PMC:<numeric>` (no PMC prefix in the id).
- **GRIST quirks**: query embedded path-style (`/get/query=...` not `?query=...`); `format=json` must be lowercase (uppercase returns XML); response keys are Capitalised (`HitCount`, `RecordList`); no award amounts.
- **`pageSize` max 1000**; >1000 returns HTTP 200 + `{"errCode": 404, "errMsg": "Invalid page size..."}` envelope.
- **Search field for cross-refs is `HAS_XREFS:y`** (`HAS_DB_CROSS_REFERENCES` is not indexed).
- **`/article/NBK/{id}` is unreliable** (returned a wrong record live) — use search (`SRC:NBK`) for bookshelf items.
- **No automated bulk download of non-bulk-set content** — EBI policy; bulk via FTP (`ftp.ebi.ac.uk/pub/databases/pmc/`) only, and OAI (`europepmc.org/oai.cgi`) was broken at research time (verify before relying).
- Do not loop REST search to drain the corpus; use the FTP bulk sets.

## Verification

- `search 'TITLE:"cluster randomised" AND OPEN_ACCESS:y'` returns hitCount ~3157.
- `get MED/27480119` returns the nitrofurantoin paper (doi 10.2174/1567201813666160729095229, citedBy >= 1).
- `annotations MED/27924004` returns OntoGene `Sequence` annotations with ontology URIs.
- `grants 'ga:"Wellcome Trust" pi:hubbard'` returns hitCount 4 records with funder "Wellcome Trust".
- `fulltextxml PMC3257301` writes JATS XML starting `<!DOCTYPE article`.
- `fields` returns exactly 143 field names.

## References

- `references/api-notes.md` — complete reference: verified endpoints + response shapes, full source table, query fields, grants/GRIST field list, annotations API model, OAI/FTP/SOAP status table, rate-limit policy, 11 live-verified gotchas.
- Articles REST docs: https://europepmc.org/RestfulWebService · Annotations API: https://europepmc.org/AnnotationsApi
- Grants API: https://europepmc.org/GristAPI · Bulk: https://europepmc.org/downloads · Developers hub: https://europepmc.org/developers
- Web Service Reference PDF: https://europepmc.org/docs/EBI_Europe_PMC_Web_Service_Reference.pdf
- Developer forum: https://groups.google.com/a/ebi.ac.uk/g/epmc-webservices