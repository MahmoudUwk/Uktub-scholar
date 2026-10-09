#!/usr/bin/env python3
"""OpenAlex API helper for LLM agents. Stdlib only (urllib, json).

OpenAlex: 250M+ scholarly works, fully open (CC0). API is free;
a free key (openalex.org/settings/api) gives 10x daily budget.
Docs: https://help.openalex.org  (LLM reference: /api/llm-quick-reference)

Endpoints covered:
  list      list/filter/search any entity   GET /{entity}?filter=...&search=...
  get       one entity by ID or alias       GET /{entity}/{id}  (W.., A.., doi:, orcid:, ror:, issn:, arxiv:)
  abstract  reconstruct a work's abstract   GET /works/{id} (+ abstract_inverted_index decode)
  arxiv     extract arXiv ids from a work   GET /works/{id} (free; needs select=locations,doi,...)
  rate      check your budget               GET /rate-limit
  pdf       download a work PDF ($0.01)     GET content.openalex.org/works/{id}.pdf

Entities: works | authors | sources | institutions | topics | publishers | funders

GOLDEN RULE (from official docs): never filter by names. Resolve names to
OpenAlex IDs first (list with --search), then filter by ID:
  openalex.py list authors --search "Einstein"
  openalex.py list works --filter "authorships.author.id:A5012345678"

Auth: export OPENALEX_API_KEY (sent as Authorization: Bearer header).
Pricing per call: singleton GET free; list $0.0001; search $0.001; PDF $0.01.
Free budget with key: $1.00/day (resets midnight UTC). 429 = over budget or >100 req/s.
Costs are visible in the `meta` block of every response (meta.cost_usd).
"""
import argparse, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from typing import Any

API = "https://api.openalex.org"
CONTENT = "https://content.openalex.org"
KEY = os.environ.get("OPENALEX_API_KEY", "").strip()
ENTITIES = ("works", "authors", "sources", "institutions", "topics", "publishers", "funders")

# Small LLM-friendly field sets (use --select to override; --select-compact adds locations + arxiv_ids on works)
DEFAULT_SELECT = {
    "works": "id,doi,display_name,publication_year,cited_by_count,open_access",
    "authors": "id,orcid,display_name,works_count,cited_by_count,last_known_institutions",
    "sources": "id,issn,display_name,type,works_count,cited_by_count",
    "institutions": "id,ror,display_name,country_code,works_count,cited_by_count",
    "topics": "id,display_name,field,subfield,works_count,cited_by_count",
    "publishers": "id,display_name,works_count,cited_by_count",
    "funders": "id,display_name,works_count,cited_by_count,grants_count",
}


class ApiError(Exception):
    pass


# arXiv id extraction from a work's locations/doi: landing pages like
# http://arxiv.org/abs/1706.03762, arxiv.org/pdf/1706.03762v5, or the arXiv DOI
# https://doi.org/10.48550/arxiv.1706.03762. New-style ids (2401.123456) and
# old-style (cs/0112017, math.GT/0309136) both supported.
ARXIV_URL_RE = re.compile(r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5}|[a-z\-]+/\d{7})v?\d*", re.I)
ARXIV_DOI_RE = re.compile(r"^https?://doi\.org/(10\.48550/arxiv\.[\w.\-]+)$", re.I)


def _work_arxiv_ids(work) -> list:
    """Extract arXiv ids from doi (if an arXiv DOI) and all locations[].landing_page_url."""
    out = []
    for loc in [work] + list(work.get("locations") or []):
        url = loc.get("landing_page_url") if loc is not work else work.get("doi")
        if not url:
            continue
        for aid in ARXIV_URL_RE.findall(url):
            aid = aid.lower()
            if aid not in out:
                out.append(aid)
        m = ARXIV_DOI_RE.match(url)
        if m:
            aid = m.group(1).split("arxiv.", 1)[1].lower()
            if aid not in out:
                out.append(aid)
    return out


def _request(path, params=None, retries=4):
    params = dict(params or {})
    req_url = API + path
    if params:
        req_url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(req_url)
    req.add_header("Accept", "application/json")
    if KEY:
        req.add_header("Authorization", "Bearer " + KEY)
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode())
                rl = {h: resp.headers.get(h) for h in
                      ("X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Credits-Used",
                       "X-RateLimit-Limit-USD", "X-RateLimit-Remaining-USD", "X-RateLimit-Cost-USD",
                       "X-RateLimit-Reset")}
                rl = {k: v for k, v in rl.items() if v is not None}  # /rate-limit emits none
                return data, rl
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode()[:400]
            except Exception:
                pass
            if e.code == 429 and attempt < retries:
                # over daily budget or >100 req/s; reset is midnight UTC
                reset = e.headers.get("X-RateLimit-Reset")
                wait = min(float(reset) if reset else 2 ** (attempt + 1) * 2, 30)
                time.sleep(wait)
                continue
            raise ApiError(f"HTTP {e.code} {req_url} {detail}") from None
        except urllib.error.URLError as e:
            if attempt < retries:
                time.sleep(2 ** (attempt + 1))
                continue
            raise ApiError(f"network error {req_url}: {e}") from None
    raise ApiError(f"unreachable: {req_url}")


def _clean(item) -> Any:
    """Recursively drop None/empty values so output stays compact for LLM context."""
    if isinstance(item, dict):
        cleaned: dict = {}
        for k, v in item.items():
            if v in (None, "", [], {}):
                continue
            cleaned[k] = _clean(v)
        return cleaned
    if isinstance(item, list):
        return [_clean(x) for x in item]
    return item


def _meta(data):
    m = data.get("meta", {}) or {}
    out = {"count": m.get("count")}
    for k in ("page", "per_page", "next_cursor", "cost_usd"):
        if m.get(k) is not None:
            out[k] = m[k]
    return out


def cmd_list(a):
    if a.entity not in ENTITIES:
        raise ApiError(f"entity must be one of: {', '.join(ENTITIES)}")
    if a.search_semantic and a.filter and any(
            f.startswith(("cited_by_count", "last_known_institutions.country_code", "country_code"))
            for f in a.filter.split(",")):
        bad = [f for f in a.filter.split(",") if f.startswith(("cited_by_count", "last_known_institutions.country_code", "country_code"))]
        raise ApiError(f"unsupported with search.semantic (would time out): {','.join(bad)}")
    params = {}
    if a.per_page:
        params["per_page"] = min(a.per_page, 100)  # API max 100; use it to save budget
    if a.page:
        params["page"] = a.page
    if a.cursor:
        params["cursor"] = a.cursor  # use * for first cursor page
    if a.filter:
        params["filter"] = a.filter  # AND=commas, OR=pipes (<=100), negation !, >, <, ranges
    if a.search:
        params["search"] = a.search  # $0.001/call; only ONE search param per request
    if a.search_exact:
        params["search.exact"] = a.search_exact  # disables stemming; enables wildcards * ?
    if a.search_semantic:
        params["search.semantic"] = a.search_semantic  # embedding search; <=2000 chars, <=50 results
    if a.sort:
        params["sort"] = a.sort  # e.g. cited_by_count:desc
    if a.sample:
        params["sample"] = min(a.sample, 10000)
        if a.seed:
            params["seed"] = a.seed
    if a.group_by:
        params["group_by"] = a.group_by
    if a.corpus and a.entity == "works":
        if a.corpus not in ("core", "expansion", "all"):
            raise ApiError("corpus must be core|expansion|all")
        params["corpus"] = a.corpus  # default core; 'all' adds the ~193M expansion corpus
    if a.select_compact and not a.group_by and a.entity == "works":
        params["select"] = "id,doi,display_name,publication_year,type,cited_by_count,indexed_in,locations"
    else:
        select = a.select or DEFAULT_SELECT.get(a.entity)
        if select and not a.group_by:
            params["select"] = select
    data, rl = _request(f"/{a.entity}", params)
    out: dict = {"meta": _meta(data)}
    if a.group_by:
        groups = data.get("group_by", [])
        out["groups"] = [_clean(g) for g in groups]
    else:
        results = data.get("results", [])
        if a.select_compact and a.entity == "works":
            for r in results:
                r["arxiv_ids"] = _work_arxiv_ids(r)
        out["results"] = [_clean(r) for r in results]
    out["budget"] = rl
    if out["meta"].get("next_cursor"):
        out["note"] = "pass --cursor <next_cursor> for the next page (basic ?page= tops out at 10,000)"
    return out


def cmd_get(a):
    if a.entity not in ENTITIES:
        raise ApiError(f"entity must be one of: {', '.join(ENTITIES)}")
    # external aliases: doi:10.xxx/yyy orcid:0000-... ror:043... issn:1234-5679 arxiv:1706.03762 mag:...
    # URL forms are normalized to alias prefixes (verified live: prefix + full-URL both work)
    ident = a.entity_id.strip()
    if "://" in ident:
        ident = (ident.replace("https://doi.org/", "doi:")
                      .replace("http://doi.org/", "doi:")
                      .replace("https://orcid.org/", "orcid:")
                      .replace("https://ror.org/", "ror:")
                      .replace("https://openalex.org/", ""))
    if ident.lower().startswith("arxiv:"):
        aid = ident.split(":", 1)[1].strip().lower()
        a.entity_id = "doi:10.48550/arxiv." + aid
        ident = a.entity_id
    params = {}
    if a.select and a.select != "full":
        params["select"] = a.select  # 'full' = no select param -> entire record
    data, rl = _request(f"/{a.entity}/{urllib.parse.quote(ident, safe=':/')}", params)
    out: dict = dict(_clean(data))
    if a.entity == "works" and a.arxiv_ids:
        out["arxiv_ids"] = _work_arxiv_ids(data)
    out["budget"] = rl
    return out


def cmd_arxiv(a):
    wid = a.work_id.replace("https://openalex.org/", "").strip()
    # Direct arXiv identifiers (arxiv:<id>, 10.48550/arxiv.<id> with or without doi:,
    # arxiv.org/abs|pdf URLs) are answered locally: the /works/doi:10.48550/arxiv.<id>
    # record itself usually 404s, so the identifier IS the answer (free, deterministic).
    m = (re.match(r"^arxiv:(.+)$", wid, re.I) or ARXIV_URL_RE.search(wid)
         or re.match(r"^(?:doi:)?10\.48550/arxiv\.([\w.\-]+)$", wid, re.I))
    if m:
        aid = re.sub(r"v\d+$", "", m.group(1).strip().lower())
        return {"work": None, "doi": "https://doi.org/10.48550/arxiv." + aid,
                "arxiv_ids": [aid],
                "note": ("arXiv identifier normalized locally (no API call): /works/doi:10.48550/"
                         "arxiv.<id> usually 404s; pass a W-id or publisher DOI to inspect "
                         "the merged record's locations")}
    if not (wid.startswith("W") or wid.lower().startswith("doi:") or "://" in wid):
        raise ApiError("pass a W-id, doi:..., arxiv:<id>, 10.48550/arxiv.<id>, or an arxiv.org URL")
    if "://" in wid:
        wid = wid.replace("https://doi.org/", "doi:").replace("http://doi.org/", "doi:")
    params = {"select": "id,doi,display_name,publication_year,type,cited_by_count,indexed_in,primary_location,locations"}
    data, rl = _request(f"/works/{urllib.parse.quote(wid, safe=':/')}", params)
    arxiv_ids = _work_arxiv_ids(data)
    out: dict = {"work": data.get("id"), "doi": data.get("doi"),
                 "indexed_in": data.get("indexed_in"), "arxiv_ids": arxiv_ids}
    if not arxiv_ids:
        out["note"] = ("no arXiv landing page/DOI in this record's locations — extract the id "
                       "from S2's externalIds.ArXiv and match on normalized title + first author instead ("
                       "note: /works/doi:10.48550/arxiv.<id> may 404 even when a location carries that DOI)")
    return out


def cmd_abstract(a):
    wid = a.work_id.replace("https://openalex.org/", "")
    data, rl = _request(f"/works/{urllib.parse.quote(wid, safe=':')}")
    inv = data.get("abstract_inverted_index")
    out = {"id": data.get("id"), "title": data.get("display_name"),
           "publication_year": data.get("publication_year")}
    if not inv:
        out["abstract"] = None
        out["note"] = "no abstract in OpenAlex for this work"
    else:
        pos = {}
        for word, idxs in inv.items():
            for i in idxs:
                pos[i] = word
        out["abstract"] = " ".join(pos[i] for i in sorted(pos))
    out["budget"] = rl
    return out


def cmd_rate(a):
    params = {}
    data, rl = _request("/rate-limit", params)
    return {"rate_limit": data, "headers": rl}


def cmd_autocomplete(a):
    # fast typeahead across all entities; detects pasted IDs; cheap
    entity = a.entity if a.entity != "works" else "works"
    params = {"q": a.query}
    data, rl = _request(f"/autocomplete/{entity}", params)
    out: dict = {"matches": [_clean(m) for m in data.get("results", data.get("matches", []))]}
    out["budget"] = rl
    return out


def cmd_pdf(a):
    wid = a.work_id.replace("https://openalex.org/", "")
    url = f"{CONTENT}/works/{urllib.parse.quote(wid, safe=':')}.pdf"
    req = urllib.request.Request(url)
    if KEY:
        req.add_header("Authorization", "Bearer " + KEY)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = resp.read()
    except urllib.error.HTTPError as e:
        raise ApiError(f"HTTP {e.code} downloading PDF (costs $0.01; needs is_oa work): {e.reason}") from None
    out_path = a.out or f"{wid}.pdf"
    with open(out_path, "wb") as f:
        f.write(payload)
    return {"saved": os.path.abspath(out_path), "bytes": len(payload),
            "cost_usd": 0.01, "note": "only works with an OA pdf location"}


def main():
    p = argparse.ArgumentParser(description="OpenAlex API CLI (see module docstring)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("list", help="list/filter/search entities (works, authors, ...)")
    s.add_argument("entity", choices=ENTITIES)
    s.add_argument("--filter", help='e.g. "publication_year:2024,is_oa:true" or "doi:a|b|c" (OR)')
    s.add_argument("--search", help="fulltext relevance search ($0.001/call)")
    s.add_argument("--search-exact", help="exact search, no stemming; enables * ? wildcards")
    s.add_argument("--search-semantic", help="meaning-based search (embeddings); max 50 results")
    s.add_argument("--sort", help="e.g. cited_by_count:desc")
    s.add_argument("--per-page", type=int, help="default 25, max 100")
    s.add_argument("--page", type=int, help="basic paging (max 10,000 results)")
    s.add_argument("--cursor", help="cursor paging; start with * (use for >10k results)")
    s.add_argument("--sample", type=int, help="random sample size (max 10000)")
    s.add_argument("--seed", help="reproducible sample seed")
    s.add_argument("--select", help="comma-separated fields to return")
    s.add_argument("--select-compact", action="store_true",
                   help="works: use the dedup-ready field set (id,doi,display_name,publication_year,"
                        "type,cited_by_count,indexed_in,locations) + extract arxiv_ids")
    s.add_argument("--group-by", help="aggregate counts by field")
    s.add_argument("--corpus", help="works only: core (default) | expansion | all")

    s = sub.add_parser("get", help="one entity by OpenAlex ID (W2741809807) or alias (doi:..., orcid:..., ror:..., arxiv:...)")
    s.add_argument("entity", choices=ENTITIES)
    s.add_argument("entity_id")
    s.add_argument("--select", help="comma-separated fields, or 'full' for everything (default: trimmed LLM set)")
    s.add_argument("--arxiv-ids", action="store_true", help="works: extract arxiv_ids from locations/doi")

    s = sub.add_parser("arxiv", help="extract arXiv ids for a work (free get; cross-provider dedup)")
    s.add_argument("work_id", help="W-id, doi:..., arxiv:<id>, 10.48550/arxiv.<id>, or arxiv.org URL")

    s = sub.add_parser("abstract", help="a work's abstract, reconstructed from the inverted index")
    s.add_argument("work_id", help="W-id or full URL")

    s = sub.add_parser("rate", help="check remaining daily budget")

    s = sub.add_parser("autocomplete", help="fast typeahead; matches names and detects pasted IDs")
    s.add_argument("query")
    s.add_argument("--entity", choices=ENTITIES, default="authors", help="entity to suggest (default authors)")

    s = sub.add_parser("pdf", help="download a work's OA PDF ($0.01 each)")
    s.add_argument("work_id")
    s.add_argument("--out", help="output path (default <id>.pdf)")

    args = p.parse_args()
    fn = {"list": cmd_list, "get": cmd_get, "abstract": cmd_abstract, "arxiv": cmd_arxiv,
          "rate": cmd_rate, "pdf": cmd_pdf, "autocomplete": cmd_autocomplete}[args.cmd]
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