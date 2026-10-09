#!/usr/bin/env python3
"""Semantic Scholar API helper for LLM agents. Stdlib only (urllib, json).

Endpoints covered:
  search      keyword search            GET /graph/v1/paper/search
  bulk        bulk search, token pages  GET /graph/v1/paper/search/bulk (boolean syntax)
  match       title -> paperId          GET /graph/v1/paper/search/match
  autocomplete title completions        GET /graph/v1/paper/autocomplete
  get         one paper, any ID form    GET /graph/v1/paper/{id}
  batch       up to 500 papers          POST /graph/v1/paper/batch
  citations   papers citing this one    GET /graph/v1/paper/{id}/citations
  references  papers this one cites     GET /graph/v1/paper/{id}/references
  paperauthors authors of a paper       GET /graph/v1/paper/{id}/authors
  tldr        one-sentence summary      (tldr is a FIELD, requested via fields=title,tldr)
  snippets    full-text snippet search  GET /graph/v1/snippet/search
  author      author details            GET /graph/v1/author/{id}
  authors     up to 1000 authors        POST /graph/v1/author/batch
  authorsearch author keyword search    GET /graph/v1/author/search
  authorpapers an author's papers       GET /graph/v1/author/{id}/papers
  recommend   similar papers            POST /recommendations/v1/papers/
  recommendfor  similar to one paper    GET /recommendations/v1/papers/forpaper/{id}
  releases    dataset releases          GET /datasets/v1/release  (also `release latest`)
  release     one release's datasets    GET /datasets/v1/release/{id}
  dataset     files for a dataset       GET /datasets/v1/release/{id}/dataset/{name}
  diffs       incremental updates       GET /datasets/v1/diffs/{start}/to/{end}/{name}

Paper ID forms (use exactly one prefix):
  CorpusId:123456 | DOI:10.18653/v1/N18-3011 | ArXiv:2106.15928
  MAG:1234567890 | ACL:W12-Objdet | PMID:12345678 | URL:https://...
  or the 40-char S2 paperId itself.

Auth: set S2_API_KEY env var (request at semanticscholar.org/product/api#api-key-form).
Keyless works but shares a public rate pool; on 429/5xx the script backs off and retries.
"""
import argparse, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

GRAPH = "https://api.semanticscholar.org/graph/v1"
RECO = "https://api.semanticscholar.org/recommendations/v1"
DATA = "https://api.semanticscholar.org/datasets/v1"
KEY = os.environ.get("S2_API_KEY", "").strip()

# LLM-friendly default fields: TLDR instead of full abstract keeps context small
PAPER_FIELDS = "title,year,venue,citationCount,externalIds,openAccessPdf,tldr"
# Recommendations service supports fewer fields (no tldr, no publicationVenue)
RECO_FIELDS = "title,abstract,venue,year,authors,externalIds,openAccessPdf,citationCount"
# Citations/references endpoints reject tldr
CITE_FIELDS = "title,year,venue,citationCount,externalIds,openAccessPdf"


class ApiError(Exception):
    pass


def _request(url, params=None, body=None, method=None, retries=5):
    req_url = url
    req = None
    data = None
    dropped = set()
    for attempt in range(retries + 1):
        if params is not None:
            req_url = url + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(req_url, method=method)
        req.add_header("Accept", "application/json")
        if KEY:
            req.add_header("x-api-key", KEY)
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, data=data, timeout=60) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if (e.code == 429 or e.code >= 500) and attempt < retries:
                # keyless pool is shared and S2 also throws transient 5xx; Retry-After
                # may be absent (429s carry none), so back off patiently either way
                wait = float(e.headers.get("Retry-After") or min(3 * 2 ** attempt, 45))
                time.sleep(min(wait, 45))
                continue
            detail = ""
            try:
                detail = e.read().decode()[:500]
            except Exception:
                pass
            # self-heal: some endpoints reject certain fields; strip them and retry once
            m = re.search(r"Unrecognized or unsupported fields: \[([^\]]+)\]", detail)
            if m and params and "fields" in params and not dropped:
                bad = [f.strip() for f in m.group(1).split(",")]
                keep = [f for f in params["fields"].split(",") if f.strip() not in bad]
                dropped.update(bad)
                if keep:
                    params["fields"] = ",".join(keep)
                    continue
            raise ApiError(f"HTTP {e.code} {url} {detail}") from None
        except urllib.error.URLError as e:
            if attempt < retries:
                time.sleep(2 ** (attempt + 1))
                continue
            raise ApiError(f"network error {url}: {e}") from None
    raise ApiError(f"unreachable: {url}")


def _clean(item):
    """Drop None/empty values so output stays compact for LLM context."""
    if isinstance(item, dict):
        return {k: _clean(v) for k, v in item.items() if v not in (None, "", [], {})}
    if isinstance(item, list):
        return [_clean(x) for x in item]
    return item


def _papers(items, fields):
    """Flatten {data: [...]} lists and clean entries."""
    if isinstance(items, dict):
        items = items.get("data", [])
    return [_clean(p) for p in items]


def _fetch_pages(url, params, pages, key_fn):
    """Offset-style multi-page fetch: merges up to `pages` responses, deduping
    rows by key_fn(item). Stops early when the API stops returning `next`.
    Sleeps ~1.1s between page requests (1 req/s with an API key).
    Returns (rows, last_envelope, more_pages_left)."""
    pages = max(1, min(pages or 1, 100))
    out = _request(url, params)
    rows, seen = [], set()

    def absorb(items):
        for it in items:
            k = key_fn(it)
            if k is not None and k not in seen:
                seen.add(k)
                rows.append(it)

    absorb(out.get("data", []) or [])
    done = 1
    nxt = out.get("next")
    while nxt is not None and done < pages:
        time.sleep(1.1)  # paged requests must respect 1 req/s
        params["offset"] = nxt
        out = _request(url, params)
        done += 1
        absorb(out.get("data", []) or [])
        nxt = out.get("next")
    return rows, out, nxt is not None  # more_pages_left True if pages cap hit early


def cmd_search(a):
    q = a.query.strip()
    if len(q.split()) < 1:
        raise ApiError("query needs at least 1 word (2 recommended); too-short queries 400")
    params = {"query": q, "limit": min(a.limit, 100), "fields": a.fields}
    if a.offset:
        params["offset"] = a.offset
    if a.year:
        params["year"] = a.year  # e.g. 2020-2024 or 2023
    if a.venue:
        params["venue"] = a.venue
    if a.open_access:
        params["openAccessPdf"] = ""
    items, out, more = _fetch_pages(f"{GRAPH}/paper/search", params, a.pages,
                                    lambda it: it.get("paperId"))
    res = {"total": out.get("total"), "offset": out.get("offset"),
           "next": out.get("next"), "papers": _papers(items, a.fields)}
    if more and (a.pages or 1) > 1:
        res["note"] = f"stopped after {a.pages} pages; 'next' holds the next offset"
    return res


def cmd_bulk(a):
    q = (a.query or "").strip()
    if not q:
        raise ApiError(
            "bulk search needs query words. Note: the spec says query is optional, "
            "but live behavior 400s with 'too many hits' unless the query is narrow — "
            "always supply one (boolean syntax: run `bulk --help`)")
    params = {"query": q, "fields": a.fields, "limit": min(a.limit, 1000)}
    if a.token:
        params["token"] = a.token
    if a.year:
        params["year"] = a.year
    if a.sort:
        params["sort"] = a.sort  # e.g. citationCount:desc, publicationDate:desc
    out = _request(f"{GRAPH}/paper/search/bulk", params)
    res = {"total": out.get("total"), "papers": _papers(out, a.fields)}
    if out.get("token"):
        res["token"] = out["token"]
        res["note"] = "pass --token to fetch the next page"
    return res


# Verbatim operator semantics from GET /graph/v1/paper/search/bulk in the official
# swagger spec (https://api.semanticscholar.org/graph/v1/swagger.json):
# "+" for AND operation | "|" for OR operation | "-" negates a term
# '"' collects terms into a phrase | "*" can be used to match a prefix
# "(" and ")" for precedence | "~N" after a word matches within the edit distance
# of N (Defaults to 2 if N is omitted) | "~N" after a phrase matches with the
# phrase terms separated up to N terms apart (Defaults to 2 if N is omitted)
BULK_SYNTAX = ("boolean query syntax (matched against title+abstract, terms stemmed, "
               "ALL terms required by default): + AND | | OR | - negates a term | "
               "\"...\" phrase | * prefix | ( ) precedence | word~N edit-distance fuzzy "
               "(~ =N default 2) | \"phrase\"~N terms up to N apart (default 2). "
               "Examples: fish -ladder | (fish ladder) | outflow | fish* | \"fish ladder\"~3")


def cmd_get(a):
    params = {"fields": a.fields}
    return _clean(_request(f"{GRAPH}/paper/{urllib.parse.quote(a.paper_id, safe=':')}", params))


def cmd_batch(a):
    ids = a.paper_ids
    if len(ids) > 500:
        raise ApiError("batch is capped at 500 paper ids per call")
    out = _request(f"{GRAPH}/paper/batch", params={"fields": a.fields}, body={"ids": ids}, method="POST")
    return {"requested": len(ids), "papers": [_clean(p) for p in out]}


def _citations_like(paper_id, suffix, a):
    params = {"fields": a.fields, "limit": min(a.limit, 1000)}
    if a.offset:
        params["offset"] = a.offset  # max 9999 per API
    url = f"{GRAPH}/paper/{urllib.parse.quote(paper_id, safe=':')}/{suffix}"
    key = "citingPaper" if suffix == "citations" else "citedPaper"
    items, out, more = _fetch_pages(url, params, a.pages,
                                    lambda it: ((it.get(key) or {}).get("paperId")))
    rows = []
    for item in items:
        row = _clean(item.get(key, {}))
        if isinstance(row, dict) and item.get("contexts"):
            row["contexts"] = list(item["contexts"])[:2]  # sentences where it is cited
        rows.append(_clean(row))
    res = {"offset": out.get("offset"), "next": out.get("next"), "papers": rows}
    if more and (a.pages or 1) > 1:
        res["note"] = f"stopped after {a.pages} pages; 'next' holds the next offset"
    return res


def cmd_citations(a):
    return _citations_like(a.paper_id, "citations", a)


def cmd_references(a):
    return _citations_like(a.paper_id, "references", a)


def cmd_tldr(a):
    out = _request(f"{GRAPH}/paper/{urllib.parse.quote(a.paper_id, safe='')}",
                   params={"fields": "title,tldr"})
    return _clean(out)


def cmd_match(a):
    params = {"query": a.query, "fields": a.fields}
    out = _request(f"{GRAPH}/paper/search/match", params)
    return {"match": _clean(out.get("data", [{}])[0])}


def cmd_autocomplete(a):
    out = _request(f"{GRAPH}/paper/autocomplete", params={"query": a.query})
    return out


def cmd_snippets(a):
    params = {"query": a.query, "limit": min(a.limit, 100)}
    if a.paperIds:
        params["paperIds"] = ",".join(a.paperIds[:100])
    if a.author:
        params["authors"] = a.author
    if a.year:
        params["year"] = a.year
    out = _request(f"{GRAPH}/snippet/search", params)
    rows = []
    for item in out.get("data", []):
        sn = item.get("snippet", {}) or {}
        row = {"score": item.get("score"),
               "text": sn.get("text"),
               "kind": sn.get("snippetKind"),
               "section": sn.get("section"),
               "paper": {k: v for k, v in (item.get("paper", {}) or {}).items()
                         if k in ("corpusId", "title", "authors", "year")}}
        rows.append(_clean(row))
    return {"matches": rows}


def cmd_paperauthors(a):
    params = {"fields": "name,affiliations,authorId", "limit": min(a.limit, 1000)}
    if a.offset:
        params["offset"] = a.offset
    out = _request(f"{GRAPH}/paper/{urllib.parse.quote(a.paper_id, safe='')}/authors", params)
    return {"authors": [_clean(x) for x in out.get("data", [])]}


def cmd_author(a):
    return _clean(_request(f"{GRAPH}/author/{urllib.parse.quote(a.author_id, safe=':')}",
                           params={"fields": "name,affiliations,paperCount,citationCount,hIndex,url"}))


def cmd_authors(a):
    if len(a.author_ids) > 1000:
        raise ApiError("author batch is capped at 1000 ids")
    out = _request(f"{GRAPH}/author/batch", params={"fields": a.fields}, body={"ids": a.author_ids}, method="POST")
    return {"authors": [_clean(x) for x in out]}


def cmd_authorsearch(a):
    params = {"query": a.query, "limit": min(a.limit, 100), "fields": "name,affiliations,paperCount,citationCount,hIndex"}
    if a.offset:
        params["offset"] = a.offset
    items, out, more = _fetch_pages(f"{GRAPH}/author/search", params, a.pages,
                                    lambda it: it.get("authorId"))
    res = {"total": out.get("total"), "next": out.get("next"),
           "authors": [_clean(x) for x in items]}
    if more and (a.pages or 1) > 1:
        res["note"] = f"stopped after {a.pages} pages; 'next' holds the next offset"
    return res


def cmd_authorpapers(a):
    params = {"fields": a.fields, "limit": min(a.limit, 100)}
    if a.offset:
        params["offset"] = a.offset
    items, out, more = _fetch_pages(
        f"{GRAPH}/author/{urllib.parse.quote(a.author_id, safe=':')}/papers", params, a.pages,
        lambda it: it.get("paperId"))
    res = {"total": out.get("total"), "offset": out.get("offset"), "next": out.get("next"),
           "papers": _papers(items, a.fields)}
    if more and (a.pages or 1) > 1:
        res["note"] = f"stopped after {a.pages} pages; 'next' holds the next offset"
    return res


def cmd_recommend(a):
    body = {}
    if a.positive:
        body["positivePaperIds"] = a.positive
    if a.negative:
        body["negativePaperIds"] = a.negative
    if not body:
        raise ApiError("give --positive and/or --negative paper ids")
    out = _request(f"{RECO}/papers/", params={"fields": a.fields, "limit": min(a.limit, 500)},
                   body=body, method="POST")
    return {"recommendedPapers": _papers(out.get("recommendedPapers", []), a.fields)}


def cmd_recommendfor(a):
    params = {"fields": a.fields, "limit": min(a.limit, 500)}
    out = _request(f"{RECO}/papers/forpaper/{urllib.parse.quote(a.paper_id, safe=':')}", params)
    return {"recommendedPapers": _papers(out.get("recommendedPapers", []), a.fields)}


def cmd_releases(a):
    out = _request(f"{DATA}/release")
    return {"releases": out}


def cmd_release(a):
    out = _request(f"{DATA}/release/{urllib.parse.quote(a.release_id, safe='.')}")
    return {"release": out}


def cmd_dataset(a):
    out = _request(f"{DATA}/release/{urllib.parse.quote(a.release_id, safe='.')}/dataset/{a.name}")
    return {"dataset": _clean(out)}


def cmd_diffs(a):
    end = "latest" if a.end == "latest" else urllib.parse.quote(a.end, safe=".")
    out = _request(f"{DATA}/diffs/{urllib.parse.quote(a.start, safe='.')}/to/{end}/{a.name}")
    diffs = []
    for d in out.get("diffs", []):
        diffs.append({k: d.get(k) for k in ("from_release", "to_release", "update_files", "delete_files")})
    return {"dataset": out.get("dataset"), "start_release": out.get("start_release"),
            "end_release": out.get("end_release"), "diffs": diffs}


def main():
    p = argparse.ArgumentParser(description="Semantic Scholar API CLI (see module docstring)")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp, fields_default=PAPER_FIELDS):
        sp.add_argument("--fields", default=fields_default, help="comma-separated fields to return")

    s = sub.add_parser("search", help="keyword search papers")
    s.add_argument("query")
    s.add_argument("--limit", type=int, default=20)
    s.add_argument("--offset", type=int, default=None)
    s.add_argument("--pages", type=int, default=None,
                   help="fetch up to N pages (offset pagination), merge + dedupe; stops when 'next' is absent")
    s.add_argument("--year", help="filter, e.g. 2022-2025")
    s.add_argument("--venue", help="comma-separated venue filter")
    s.add_argument("--open-access", action="store_true", help="only papers with open access PDF")
    common(s)

    s = sub.add_parser("bulk", help="bulk search, up to 1000/page, token pagination")
    s.add_argument("query", nargs="?", default=None,
                   help="optional; supports boolean syntax (see examples below)")
    s.add_argument("--limit", type=int, default=100)
    s.add_argument("--token", help="continuation token from previous call")
    s.add_argument("--year", help="filter, e.g. 2022-2025")
    s.add_argument("--sort", help="e.g. citationCount:desc or publicationDate:desc")
    common(s)
    # surface the exact spec syntax in --help output
    s.description = "Bulk search, up to 1000 papers per page, token pagination. " + BULK_SYNTAX

    s = sub.add_parser("get", help="paper details, any ID form (CorpusId:, DOI:, ArXiv:, ...)")
    s.add_argument("paper_id")
    common(s)

    s = sub.add_parser("match", help="resolve an exact paper title to its ID")
    s.add_argument("query")
    common(s)

    s = sub.add_parser("autocomplete", help="paper title completions while typing")
    s.add_argument("query")

    s = sub.add_parser("snippets", help="search ~500-word text snippets from inside papers")
    s.add_argument("query")
    s.add_argument("--limit", type=int, default=10)
    s.add_argument("--paperIds", nargs="+", help="restrict to these paper ids (~100 max)")
    s.add_argument("--author", help="fuzzy author name filter")
    s.add_argument("--year", help="e.g. 2022-2025")

    s = sub.add_parser("paperauthors", help="authors of a paper")
    s.add_argument("paper_id")
    s.add_argument("--limit", type=int, default=100)
    s.add_argument("--offset", type=int, default=None)

    s = sub.add_parser("batch", help="up to 500 papers by id list")
    s.add_argument("paper_ids", nargs="+")
    common(s)

    for name, help_t in (("citations", "papers that cite this one"),
                         ("references", "papers this one cites")):
        s = sub.add_parser(name, help=help_t)
        s.add_argument("paper_id")
        s.add_argument("--limit", type=int, default=50)
        s.add_argument("--offset", type=int, default=None)
        s.add_argument("--pages", type=int, default=None,
                       help="fetch up to N pages (offset pagination), merge + dedupe; stops when 'next' is absent")
        common(s, CITE_FIELDS)

    s = sub.add_parser("tldr", help="one-sentence AI summary of a paper")
    s.add_argument("paper_id")

    s = sub.add_parser("author", help="author details by S2 author id")
    s.add_argument("author_id")

    s = sub.add_parser("authors", help="up to 1000 authors by id list")
    s.add_argument("author_ids", nargs="+")
    common(s, "name,affiliations,paperCount,citationCount,hIndex")

    s = sub.add_parser("authorsearch", help="author keyword search")
    s.add_argument("query")
    s.add_argument("--limit", type=int, default=10)
    s.add_argument("--offset", type=int, default=None)
    s.add_argument("--pages", type=int, default=None,
                   help="fetch up to N pages (offset pagination), merge + dedupe; stops when 'next' is absent")

    s = sub.add_parser("authorpapers", help="an author's papers")
    s.add_argument("author_id")
    s.add_argument("--limit", type=int, default=20)
    s.add_argument("--offset", type=int, default=None)
    s.add_argument("--pages", type=int, default=None,
                   help="fetch up to N pages (offset pagination), merge + dedupe; stops when 'next' is absent")
    common(s)

    s = sub.add_parser("recommend", help="similar papers from positive/negative id lists")
    s.add_argument("--positive", nargs="+", required=False, help="paper ids to like")
    s.add_argument("--negative", nargs="+", required=False, help="paper ids to avoid")
    s.add_argument("--limit", type=int, default=20)
    common(s, RECO_FIELDS)

    s = sub.add_parser("recommendfor", help="similar papers for one paper id")
    s.add_argument("paper_id")
    s.add_argument("--limit", type=int, default=20)
    common(s, RECO_FIELDS)

    s = sub.add_parser("releases", help="list dataset release ids")
    s = sub.add_parser("release", help="datasets in one release")
    s.add_argument("release_id")
    s = sub.add_parser("dataset", help="files/urls for one dataset in a release")
    s.add_argument("release_id")
    s.add_argument("name", help="papers|authors|citations|tldrs|abstracts|s2orc|embeddings-specter_v1/v2|...")

    s = sub.add_parser("diffs", help="incremental update files between two releases")
    s.add_argument("start", help="start release id, e.g. 2025-01-07")
    s.add_argument("end", help="end release id or 'latest'")
    s.add_argument("name", help="dataset name")

    args = p.parse_args()
    fn = {"search": cmd_search, "bulk": cmd_bulk, "match": cmd_match,
          "autocomplete": cmd_autocomplete, "snippets": cmd_snippets,
          "get": cmd_get, "batch": cmd_batch,
          "citations": cmd_citations, "references": cmd_references, "tldr": cmd_tldr,
          "paperauthors": cmd_paperauthors,
          "author": cmd_author, "authors": cmd_authors, "authorsearch": cmd_authorsearch,
          "authorpapers": cmd_authorpapers, "recommend": cmd_recommend,
          "recommendfor": cmd_recommendfor, "releases": cmd_releases,
          "release": cmd_release, "dataset": cmd_dataset, "diffs": cmd_diffs}[args.cmd]
    try:
        print(json.dumps(fn(args), ensure_ascii=False))
    except ApiError as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(2)
    except BrokenPipeError:
        try:
            sys.stdout.close()
        except Exception:
            pass
        sys.exit(0)


if __name__ == "__main__":
    main()