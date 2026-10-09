---
name: crossref
description: Resolve papers to full Crossref metadata from partial info.
version: 0.1.0
author: Mahmoud Sallam (mahmoudsallam), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [crossref, doi, metadata, resolution, citations, research, api]
    related_skills: [semantic-scholar, openalex, arxiv, europepmc]
---

# Crossref Skill

Free, keyless DOI-registry lookups through a tested stdlib-only CLI. **Crossref is the DOI registry** — the authority for DOI→record and full publisher metadata (authors + ORCIDs + affiliations, journal/ISSN/volume/issue/pages, dates, license, funders, citation/reference counts, abstract). Not a discovery engine: for broad/semantic search use semantic-scholar / openalex / europepmc, then come here to resolve the record you already believe exists.

## When to Use

- You have a DOI → `get` returns the full record instantly.
- You have partial info (any combination of title / author / year / journal / ISSN / type) → `resolve` ranks candidates and returns the top record + 4 alternates.
- ISSN → journal metadata; funder name → funder ID → that funder's works.
- Don't use for: broad discovery (Crossref relevance is noisy on fragments and acronyms — semantic-scholar/openalex first), assigning DOIs, or DataCite/arXiv `10.48550/...` DOIs — Crossref 404s those (use api.datacite.org).

## Prerequisites

- python3 (stdlib only: urllib, json, argparse)
- Free, keyless API — no account, no key in any file
- Optional courtesy: `export CROSSREF_EMAIL=you@example.org` adds `mailto=` → the "polite pool" (identified clients get steadier service); the script also sends an identified User-Agent. Crossref "Plus" is a paid SLA (`Crossref-Plus-API-Token` header) — note-only here, not integrated.
- Rate guidance: no hard published limit; be nice — tight `rows`, ≥1s between calls in loops, honor X-Rate-Limit headers (the script surfaces them as `rate-limit`).

## How to Run

All commands via the `terminal` tool:

```
terminal(command="CROSSREF_EMAIL=you@example.org python3 <skill_dir>/scripts/crossref.py resolve 'attention is all you need' --author vaswani")
```

One JSON object on stdout; errors `{"error": ...}` on stderr, exit code 2. `resolve` carries `match` (exact/partial/fuzzy/none) + `confidence` (high/medium/low) so agents can self-verify before trusting a hit. `get` returns the full record — the only place with funder / link / update-to blocks. Deep paging: use the raw API (`cursor=*`, then `message.next-cursor`; works on all /works routes).

## Quick Reference

```
# Compound flow: partial info -> resolve -> pick -> get full record
... resolve 'attention is all you need' --author vaswani    # -> 10.65215/ysbyhc05 (posted-content re-deposit; NeurIPS 10.5555 404s)
... resolve 'mastering the game of go with deep neural networks and tree search'   # -> 10.1038/nature16961 (AlphaGo Nature)
... resolve 'bert pretraining of deep bidirectional transformers' --year 2019     # year filter; many BERT records lack titles
... resolve 'galnac lnp'                                    # fragment -> real GalNAc/LNP paper
... resolve --doi 10.1038/nature14539                       # DOI-only fast path (same as get)
... get 10.1038/nature14539                                 # full record (funders, link, update-to; abstract JATS-stripped)
... get 10.18653/v1/N19-1423                                # ACL records can carry EMPTY titles - judge by authors
... match 'attention is all you need'                       # thin title->doi + confidence + alternates
... journals --issn 0028-0836                               # Nature: print+eISSN, DOI counts
... journals 'Nature Neuroscience'                          # fuzzy title -> ISSNs
... funders 'National Science Foundation'                   # name -> 10.13039/100000001 + alt-names
... fundworks 100000001 --query 'deep learning'             # works funded by a funder id
... types / licenses / fields / syntax                      # registries + meta-commands
```

Filter-inheritance notes: the work filter `issn:` matches any print/electronic/link ISSN of the container (the journals endpoint needs the ISSN Crossref actually holds). `prefix:` filters by owner prefix — but prefix != current owner.

## Procedure

1. **DOI in hand? -> `get <doi>`.** Accepts `10.x/suffix`, `doi:10.x/suffix`, `https://doi.org/...`; DOIs are case-insensitive (`10.1038/NATURE14539` works). HTTP 404 + `{"error"}` = not a Crossref DOI (DataCite/arXiv `10.48550/...`, dblp `10.5555/...`) — try DataCite (api.datacite.org) or doi.org content negotiation.
2. **Resolve with whatever you have** — title (exact or fragment) plus any of `--author --year --journal --issn --type --abstract --min-citations --min-references --publisher`. Mapping: title->`query.bibliographic` (preferred; `query.title` is deprecated but tolerated), author->`query.author`, journal->`query.container-title`, year->`from-pub-date/until-pub-date` filters, `--issn`->`issn:` filter, `--type`->`type:` filter (aliases: paper->journal-article, preprint->posted-content). Or post-filter with `--min-citations`; junk demotion is automatic.
3. **Read `match` + `confidence`**: exact = normalized title equality; partial = query words all inside the top title; fuzzy = >=60% word overlap; none = weak. `re-ranked.moved` = how many candidates the junk-demotion + citation tie-break moved; `top-quality-warning` flags a surviving no-title/correction/derived top. `score` is select-able and appears on full records.
4. **Verify before trusting**: require `match` != none; check year/type/first author of `top`. If `match=none/low` -> add constraints (`--year --author --issn`) or a fuller title; fragments + acronyms are the weak spot.
5. **Then `get <doi>`** — resolve is the search, get is ground truth (license/funders/link/update-to only appear on get). Several equal candidates -> prefer higher inbound citations (projected as `citation-count`; the raw Crossref field is `is-referenced-by-count` — canonical version of record; derived records carry ~0).
6. **Preprint vs published**: separate records/DOIs; prefer `--type journal-article` or `--min-citations 5` for the VoR; `posted-content` = preprint or re-deposit (publisher can be mislabeled); `get.update-to` lists retractions/corrections.
7. **Journal/funder context**: `journals --issn <issn>` or `journals '<words>'`; `funders '<name>'` -> `fundworks <id>`.

## Pitfalls

- **NeurIPS/PMLR have no Crossref DOIs** (dblp owns `10.5555/...` -> live 404). 'attention is all you need' resolves only via 2025 posted-content re-deposits (10.65215/ysbyhc05, publisher listed as "Shenzhen Medical Academy of Research and Translation"). Verify suspect DOIs via `/works/<doi>/agency` (-> crossref|datacite|medra|public).
- **arXiv DOIs (`10.48550/...`) are DataCite — always 404 on /works.** Recognize the prefix and go to DataCite/doi.org; do not retry Crossref.
- **`query.title` is DEPRECATED** by Crossref (docs say "no longer available"; live it still returns 200 and falls through to a general query) — use `query.bibliographic`. Unknown `select` field -> 400 `select-not-available` (the message lists valid names; `score` IS a valid select).
- **`title`/`container-title` are ARRAYS** (join for display). Some records — e.g. ACL `10.18653/v1/N19-1423`, 8242 citations — carry an EMPTY title with full authors; judge by authors+venue+year.
- **Corrections/errata rank ABOVE the genuine article** (Crossref score loves token overlap; "(Author Correction) <title>" overlaps more). resolve re-ranks junk to the bottom — but skim alternates when suspicion remains.
- **Prefix != current owner** (README "Notes on owner prefixes"): `prefix:` filters the original registrant; current ownership rides `owner_prefix`/member — use `member:` for a publisher's modern output.
- **Partial date filters pad**: `YYYY`/`YYYY-MM` become day 1, so `until-pub-date:2019` excludes Feb-Dec 2019 — use `until-pub-date:2019-12-31`. resolve auto-falls-back when year filters return zero (year moved into `query.bibliographic`, filters dropped, `fallback` reported).
- **Fragments + acronyms fail silently**: 'bert', 'clip', 'go' drown the true paper in offset noise and derived records; full title (+ `--author`, `+ --type journal-article`) resolves reliably. When the venue had no DOIs at all (CLIP/ICML=PMLR, NeurIPS), the paper is simply NOT in Crossref under its own record.
- **Etiquette**: mailto + X-Rate-Limit headers + tight rows; no bulk harvests (Plus is the SLA route). The script sends an identified UA + mailto from CROSSREF_EMAIL; keep loops >=1s/call.

## Verification

- `get 10.1038/nature14539` -> "Deep learning", Springer Science and Business Media LLC; `get 10.1038/nature16961` -> AlphaGo Nature paper (no `funder` block on this record — funder presence varies by publisher deposit).
- `resolve 'attention is all you need' --author vaswani` -> `match=exact/high`, top **10.65215/ysbyhc05** (posted-content 2025-08-23, cit 21, publisher "Shenzhen Medical Academy of Research and Translation", 8 authors with Google Brain affiliations; alternates pc26a033 cit 20, nxvz2v36 cit 16; re-ranked.moved=2). NeurIPS DOI 10.5555/3295222.3295349 -> live 404.
- `resolve 'galnac lnp'` -> top 10.18609/nuc.2026.021 "Challenging the GalNAc dogma: intrinsic LNP chemistry..." (resolves on native rank; the junk-demotion re-rank may or may not fire — check `re-ranked.moved`).
- `get 10.48550/arXiv.1706.03762` -> HTTP 404 {"error": ...NOT in Crossref; DataCite/arXiv DOIs...} exit 2 (correct behavior, not a bug).
- `resolve --issn 0028-0836 --year 2023` -> top = FinnGen Nature paper 10.1038/s41586-022-05473-8 (cit 3858). `journals --issn 2230-5174` -> HTTP 404 {"error"} exit 2 (ISSN not held by Crossref; unknown DOIs likewise 404 -> exit 2).
- `journals --issn 0028-0836` -> "Nature", 447,018 total DOIs. `funders 'National Science Foundation'` -> 10.13039/100000001. `types` -> 30 ids; `licenses` -> ~28.9k license URLs.
- `fields` + `syntax` meta-commands; every subcommand live-tested in the build session (~45 polite-mailto calls).

## References

- `references/api-notes.md` — full /works param table, all query.* params, filter list, envelope shapes, select/score semantics, rate-limit/etiquette, journals/funders/types/licenses field notes, worked resolve-examples for every partial-info combination, preprint-vs-published handling, with source URLs.
- REST API docs: https://github.com/CrossRef/rest-api-doc (README + api_format.md)
- Swagger UI: https://api.crossref.org/swagger-ui/index.html (NO machine spec: /swagger.json -> route-not-found; /v3/api-docs -> 404 route-not-found)
- Etiquette and Plus: https://www.crossref.org/documentation/metadata-stewardship/etiquette/ | https://www.crossref.org/services/metadata-delivery/plus-service/
- Sibling skills: semantic-scholar / openalex (better discovery), arxiv (arXiv-native metadata + source PDFs)