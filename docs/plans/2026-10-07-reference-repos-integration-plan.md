# Plan: ideas from three reference repositories, kept minimal

Status: 2026-10-07. P1 and the read-only bibliography are built and verified live; the owner chose to build only what addresses an observed problem, so P2 and P3 moved to BACKLOG §3; SKIP is recorded so nobody re-studies it.
The clones live in `reference_repos/` (gitignored, read-only, untrusted data). Studied, nothing executed:

| Repo | Commit | Licence | What it really is |
|---|---|---|---|
| [aipoch/open-science](https://github.com/aipoch/open-science) | `2102e6d` | Apache-2.0 | Electron research workbench; the literature layer (`src/main/literature/`) is about 6.6k lines and the only part that matters here |
| [alphaXiv/OpenResearch](https://github.com/alphaXiv/OpenResearch) | `b9ce4f3` | MIT | Rust experiment orchestrator (`orx`); literature is about 700 lines, retrieval is hosted and closed |
| [synthetic-sciences/OpenScience](https://github.com/synthetic-sciences/OpenScience) | `44d0334` | Apache-2.0 | OpenCode fork with 411 skills; typed literature tool is smaller than ours, skills are prose and curl recipes |

All three are Apache-2.0 or MIT, compatible with this package's AGPL-3.0-only. This plan borrows ideas and public API shapes only; no code is copied. Provenance goes in `NOTICE.md` when something is built.

## What the studies found, honestly

- **None of them has what our hard gaps need.** No OCR, no vector-index scaling, no reranker, no typo tolerance and no judgment-cache design exist in any of the three. Their retrieval is BM25-only or hosted. Do not look there again for those; the backlog entries stand.
- **None of them verifies claims.** Our `verify_claim` with exact pointers is ahead of all three; their citation guards are prompt text, plus (aipoch) a rule that any DOI or PMID presented as freshly retrieved must trace to a tool result.
- **Their OA acquisition is weaker or equal to ours** except for one thing: PubMed Central and Europe PMC routes (both aipoch and OpenScience), which we lack.
- **Already done here, so not duplicated:** `Retry-After` handling (`fetchWithRetry`, seconds, capped), year filters on `search_papers`, HTML/`%PDF` sniffing, SSRF-safe downloads with redirect re-checks, byte caps, identity check, arXiv spacing, typed per-provider warnings, abstract-only fallbacks that name the reason.

## P1 - built (small, existing tools, evidence-backed)

1. **Europe PMC full-text route** (aipoch `full-text-sources.ts`, OpenScience `paper-lookup`). One keyless lookup, `GET https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:"<doi>"&resultType=core&format=json`, then the `fullTextUrlList.fullTextUrl[]` entries with `documentStyle` `pdf` and `availabilityCode` `OA` or `F`. It covers PMC open-access articles and bioRxiv/medRxiv preprints. Asked in the last tier, with Semantic Scholar; every candidate still goes through the guarded downloader and identity check. New source kind `epmc-pdf`. Both studies agree this is the largest real hole in OA coverage. **Correction from the live run:** the `fullTextUrl` PDF links on `europepmc.org` (`?pdf=render`, `/backend/ptpmcrender.fcgi`) answer scripted clients with a Cloudflare bot challenge, so they are never fetched. The PMC open-data S3 bucket route that this plan first skipped as a duplicate is the one that works (public HTTPS, per-version JSON with `pdf_url`, `license_code`, `is_retracted`; the PDF's md5 matched). Europe PMC now supplies the PMCID and other-host PDF links; the bucket supplies the PDF.
2. **arXiv cooldown** (OpenScience `connectors/literature/arxiv.ts`). A 429 or 403 from arXiv starts a cooldown (60 s, doubling to 10 min) during which arXiv candidates are skipped, not retried; arXiv treats ignored 403s as abuse. Today we only space requests.

## P2 - deferred by the owner to BACKLOG §3 (each changes a documented contract or a stance)

| # | Idea | Source | Why it waits |
|---|---|---|---|
| a | **Citation graph**: one hop backward/forward through OpenAlex `filter=cites:W` / `referenced_works`, hydrated 50 per call, unhydrated references reported not dropped | aipoch `literature-openalex.ts` | A new capability; BACKLOG §4 defers it, and a sixth MCP tool changes the five-tool contract. A CLI-only route would not |
| b | **Retraction flag on `register`** from Crossref `update-to` / `updated-by` (`retraction`) | aipoch `kernel.py` | New field with a named consumer (the register line and the notices footer); small schema or output change |
| c | **Deterministic manuscript audit** (undefined citation key, missing `\includegraphics` file, bare "table below", every DOI in the text is registered) with no model in the loop, for the stated reason that free-text fix hints are an injection channel | aipoch `style_pass`, OpenResearch `orx-paper` | New capability; the earlier ScientificSlop idea in BACKLOG §9 overlaps and should be merged into it, not built twice |
| d | **Host-neutral enforcement hook** (`uktub-scholar hook` for Claude Code `PreToolUse`: deny writes to `refs/references.bib` and `.registry/`, deny on any parse error) | OpenResearch `plan_gate.rs` | `AGENTS.md` says enforcement lives above the package, not inside it |
| e | **Held-out experiment scenario** so the improve-and-rerun loop does not overfit the one scenario | OpenScience `evals/launch` (dev vs held-out flows) | Harness work, low risk; needs a second scenario written and frozen first |

## P3 - recorded, deferred (BACKLOG §3)

- Resumable `.part` downloads with `Range`/`If-Range` and an env-var mirror override that keeps the pinned sha256 (aipoch `resilient-download.ts`). BACKLOG §6 already says "no consumer yet".
- Idle-access retention sweep for `claim_judgments` (aipoch `full-text-index.ts`). Needs a schema bump; the table is small.
- `Retry-After` as an HTTP date (OpenResearch). Our parser takes seconds only; no provider has sent the date form.

## SKIP, with reasons

CORE (needs a key, mixed licences); **Unpaywall (forbidden: deprecated into OpenAlex)**; the hosted alphaXiv search and markdown endpoints (undocumented third-party URLs); LLM "reviewer" loops; skill marketplaces; scanned-PDF heuristics (our `no_text_layer` refusal already says it); browser-cookie extraction and telemetry in OpenResearch; Electron, sandbox and desktop packaging.

## Acceptance for P1

Test-first offline tests with fake providers (Europe PMC `fullTextUrlList` shapes including a restricted-access entry that must be ignored, a not-found, an answer for a different DOI; arXiv cooldown on 429/403 with an injected clock). Then a live case against the real Europe PMC for a paper that has a PMC copy, in the direct suite, and the existing suites rerun.

## Also built: read-only bibliography (owner request)

`refs/references.bib` is rendered with mode 0444 (staged file, `chmod`, atomic rename), so no host's edit tool can add a fabricated entry; the next registry write replaces it and the human may `chmod` it. This replaced the idea of a Claude Code hook, which the AGENTS.md stance rules out. See DECISIONS 2026-10-07.
