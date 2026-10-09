#!/usr/bin/env python3
"""crossref.py — Crossref Metadata API CLI (stdlib only).

Resolve papers to full Crossref metadata from partial info (any combination
of title / DOI / author / year / journal / ISSN / type / publisher), plus
direct DOI lookup and helper registries (journals, funders, types, licenses).

- Free, keyless API. Be polite: set CROSSREF_EMAIL (adds mailto= to requests,
  joining the "polite pool" of identified clients).
- One JSON object per command on stdout; errors {"error": ...} on stderr exit 2.

Usage pattern (the compound flow):
    partial info -> resolve -> candidates (score-ranked, match flag) -> get <doi>
"""
import argparse
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://api.crossref.org"
UA_PRODUCT = "UktubAI-CrossrefSkill/0.1"
DEFAULT_TIMEOUT = 30
MAX_ROWS = 1000
RETRIES = 3
BACKOFF_BASE = 1.5
# Compact projection for resolve/match/fundworks (verified selectable).
RESOLVE_SELECT = ("DOI", "title", "author", "issued", "container-title",
                  "is-referenced-by-count", "references-count", "type",
                  "publisher", "volume", "issue", "page", "ISSN",
                  "published", "URL")
TYPE_ALIASES = {"paper": "journal-article", "article": "journal-article",
                "preprint": "posted-content", "book": "book",
                "chapter": "book-chapter", "dataset": "dataset",
                "proceedings": "proceedings-article", "standard": "standard"}


# ---------------------------------------------------------------- I/O utils
def _email(args):
    return getattr(args, "email", None) or os.environ.get("CROSSREF_EMAIL", "") or ""


def _ua(email):
    if email:
        return "%s (https://api.crossref.org; mailto:%s)" % (UA_PRODUCT, email)
    return "%s (https://api.crossref.org)" % UA_PRODUCT


class ApiError(Exception):
    def __init__(self, msg, status=None, body=None):
        super().__init__(msg)
        self.status = status
        self.body = body


_STATE = {"email": "", "rate": None}


def _get(path, params=None, timeout=DEFAULT_TIMEOUT):
    """GET BASE+path; retry w/ backoff on 429/5xx; remember X-Rate-Limit-*."""
    params = {k: v for k, v in (params or {}).items() if v is not None}
    if _STATE["email"] and not any(k == "mailto" for k in params):
        params["mailto"] = _STATE["email"]  # polite pool, per Crossref docs
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, headers={
        "User-Agent": _ua(_STATE["email"]),
        "Accept": "application/json"})
    last = None
    for attempt in range(RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                hdrs = dict(resp.headers)
                _STATE["rate"] = {k: hdrs[k] for k in hdrs
                                  if k.lower().startswith("x-rate-limit")}
                return json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode("utf-8", "replace")
            except Exception:
                body = ""
            if e.code in (429, 500, 502, 503, 504) and attempt < RETRIES - 1:
                time.sleep(BACKOFF_BASE * (2 ** attempt))
                last = e
                continue
            hint = ""
            if e.code == 404:
                hint = (" — 404 means the DOI is NOT in Crossref; DataCite/"
                        "arXiv DOIs (10.48550/...) and other non-Crossref "
                        "registries are not served here (check /agency or "
                        "use doi.org content negotiation)")
            raise ApiError("HTTP %s from %s%s" % (e.code, path, hint),
                           status=e.code, body=body[:400])
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            if attempt < RETRIES - 1:
                time.sleep(BACKOFF_BASE * (2 ** attempt))
                last = e
                continue
            raise ApiError("network error: %s" % e)
    raise ApiError("unreachable after retries: %s" % last)


def _clean(obj):
    """Recursively drop None values and empty dicts/lists."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            c = _clean(v)
            if c is None or c == {} or c == []:
                continue
            out[k] = c
        return out or None
    if isinstance(obj, list):
        vals = [_clean(v) for v in obj]
        return [v for v in vals if v is not None] or None
    return obj


def _rate():
    return _STATE.get("rate")


def _norm_doi(raw):
    s = (raw or "").strip()
    s = re.sub(r"^https?://(dx\.)?doi\.org/", "", s, flags=re.I)
    s = re.sub(r"^doi:\s*", "", s, flags=re.I)
    return s.strip()


def _clip(v, n=280):
    if isinstance(v, str) and len(v) > n:
        return v[:n - 1] + "…"
    return v


def _strip_jats(s):
    txt = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    return re.sub(r"\s+", " ", txt).strip()


def _first_date(d):
    parts = ((d or {}).get("date-parts") or [[]])[0]
    parts = [p for p in parts if isinstance(p, int)]  # some records: [None, ...]
    if not parts:
        return None
    try:
        return "-".join("%02d" % p if i else "%04d" % p
                        for i, p in enumerate(parts))
    except (TypeError, ValueError):
        return None


def _authors(items):
    out = []
    for a in (items or []):
        name = a.get("name") or " ".join(
            x for x in [a.get("given"), a.get("family")] if x)
        if not name:
            continue
        entry = {"name": name}
        orcid = a.get("ORCID")
        if orcid:
            entry["orcid"] = re.sub(r"^https?://orcid\.org/", "", orcid)
        if a.get("authenticated-orcid"):
            entry["orcid-authenticated"] = True
        affs = [af.get("name") for af in (a.get("affiliation") or [])
                if af.get("name")]
        if affs:
            entry["affiliation"] = affs
        if a.get("sequence") == "first":
            entry["first"] = True
        out.append(entry)
    return out


def _norm_title(t):
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", (t or "").lower())).strip()


def _title_of(item):
    t = item.get("title")
    if isinstance(t, list):
        t = t[0] if t else None
    return t or ""


def _match_confidence(query_title, top_title):
    if not query_title:
        return "direct", "exact"
    q, t = _norm_title(query_title), _norm_title(top_title)
    if not q or not t:
        return "none", "low"
    if q == t:
        return "exact", "high"
    qw, tw = set(q.split()), set(t.split())
    if qw and qw.issubset(tw):
        return "partial", ("high" if len(qw) >= 3 else "medium")
    if len(qw & tw) / float(max(1, len(qw))) >= 0.6:
        return "fuzzy", "medium"
    return "none", "low"


# --------------------------------------------- quality-aware re-ranking
# Crossref's relevance score can rank derived/no-title records ABOVE the
# genuine paper (live examples: 'Faculty Opinions recommendation of …',
# empty-title ACL records, publisher components). Demote those, promote
# real papers, and use citations as the tie-breaker.
_JUNK_PAT = re.compile(
    r"^(faculty opinions|recommendation of|review of:|author correction|"
    r"publisher correction|correction(?: to|:)|erratum|retraction(?: note|"
    r":|\s|$))", re.I)


def _junk_reason(item):
    if not _title_of(item):
        return "no-title"
    if _JUNK_PAT.match(_title_of(item) or ""):
        return "correction/derived record"
    if item.get("type") in ("component", "dataset", "peer-review", "grant"):
        return "non-article type (%s)" % item.get("type")
    return None


def _rerank(items):
    """Stable-sort candidates: junk to the bottom, then citations desc.

    Returns (items, moved_dicts_reversed). Only signals local reordering;
    the API's score order is preserved in `score` fields."""
    def key(it):
        return (1 if _junk_reason(it) else 0,          # junk last
                -(it.get("is-referenced-by-count") or 0))  # citations desc
    order = list(items)
    try:
        order.sort(key=key)  # python sort is stable; lxml not needed
    except TypeError:
        return items, 0
    moved = sum(1 for i, (a, b) in enumerate(zip(order, items)) if a is not b)
    return order, moved


_RERANK_NOTE = ("candidates re-ranked: Crossref score can favor derived "
                "records (corrections, 'recommendation of …' datasets, "
                "no-title components); junk demoted, citations used as "
                "tie-breaker when titles look similar")


# ------------------------------------------------------------ projections
def _project_work(m, full=False):
    if not isinstance(m, dict):
        return {}
    issn_type = None
    if m.get("issn-type"):
        issn_type = {e["type"]: e["value"] for e in m["issn-type"]
                     if e.get("value")}
    proj = {
        "doi": m.get("DOI"),
        "title": _clip(" | ".join(m.get("title") or []), 400) or None,
        "subtitle": _clip(" / ".join(m.get("subtitle") or [])) or None,
        "authors": _authors(m.get("author")) or None,
        "container-title": (m.get("container-title") or [None])[0],
        "issn": m.get("ISSN") or None,
        "issn-type": issn_type,
        "volume": m.get("volume"),
        "issue": m.get("issue"),
        "page": m.get("page") or m.get("article-number"),
        "published": (_first_date(m.get("published-online"))
                      or _first_date(m.get("issued"))
                      or _first_date(m.get("published-print"))
                      or _first_date(m.get("created"))),
        "published-print": _first_date(m.get("published-print")),
        "published-online": _first_date(m.get("published-online")),
        "issued": _first_date(m.get("issued")),
        "type": m.get("type"),
        "publisher": m.get("publisher"),
        "citation-count": m.get("is-referenced-by-count"),
        "references-count": (m.get("references-count")
                             or m.get("reference-count")),
        "license": ([l.get("URL") for l in (m.get("license") or [])
                     if l.get("URL")] or None),
        "abstract": _strip_jats(m["abstract"]) if m.get("abstract") else None,
        "url": m.get("URL"),
        "subject": m.get("subject"),
        "score": m.get("score"),
        "created": _first_date(m.get("created")),
    }
    if full:
        proj["funder"] = [{"name": f.get("name"), "doi": f.get("DOI"),
                           "award": f.get("award")}
                          for f in (m.get("funder") or [])] or None
        proj["link"] = [{"application": l.get("intended-application"),
                         "content-type": l.get("content-type"),
                         "url": l.get("URL")}
                        for l in (m.get("link") or [])] or None
        proj["update-to"] = [{"doi": u.get("DOI"), "type": u.get("type"),
                              "updated": _first_date(u.get("updated"))}
                             for u in (m.get("update-to") or [])] or None
        proj["update-policy"] = m.get("update-policy")
    return _clean(proj)


def _passes(item, min_citations=None, min_references=None, publisher=None):
    if min_citations is not None and \
            (item.get("is-referenced-by-count") or 0) < min_citations:
        return False
    if min_references is not None:
        rc = item.get("references-count") or item.get("reference-count") or 0
        if rc < min_references:
            return False
    if publisher and publisher.lower() not in \
            (item.get("publisher") or "").lower():
        return False
    return True


def _query_built(args):
    """Build /works params from ANY partial-info combination."""
    params, meta = {}, {}
    filters = []
    title = getattr(args, "title", None)
    if isinstance(title, (list, tuple)):
        title = " ".join(t for t in title if t)
    bib = (title or "").strip()
    if bib:
        params["query.bibliographic"] = bib
    if getattr(args, "author", None):
        params["query.author"] = args.author.strip()
    if getattr(args, "journal", None):
        params["query.container-title"] = args.journal.strip()
    doi = getattr(args, "doi", None)
    if doi:
        nd = _norm_doi(doi)
        if not nd.lower().startswith("10."):
            raise ApiError("invalid DOI: %r (expected 10.xxxx/suffix)" % nd)
        filters.append("doi:" + nd)
        meta["doi"] = nd
    year = getattr(args, "year", None)
    year_in_bib = False
    if year:
        if not (bib or getattr(args, "author", None) or
                getattr(args, "journal", None)):
            # filters only, no queries — still fine
            pass
        filters.append("from-pub-date:%s-01-01" % year)
        filters.append("until-pub-date:%s-12-31" % year)
    if getattr(args, "issn", None):
        filters.append("issn:" + args.issn.strip())
    if getattr(args, "type", None):
        tval = args.type.strip()
        filters.append("type:" + TYPE_ALIASES.get(tval.lower(), tval))
    if getattr(args, "abstract", False):
        filters.append("has-abstract:true")
    if filters:
        params["filter"] = ",".join(filters)
    no_query = not (params.get("query.bibliographic") or
                    params.get("query.author") or
                    params.get("query.container-title") or
                    params.get("query"))
    if no_query and not filters:
        raise ApiError("resolve needs at least one of: title, --doi, "
                       "--author, --year, --journal, --issn, --type")
    if no_query:  # filters only: make "the answer" deterministic
        params["sort"] = "is-referenced-by-count"
        params["order"] = "desc"
        meta["sort"] = "is-referenced-by-count:desc (no query terms)"
    select = getattr(args, "select", None)
    params["select"] = select if select else ",".join(RESOLVE_SELECT)
    rows = getattr(args, "rows", 5) or 5
    if not 0 <= rows <= MAX_ROWS:
        raise ApiError("rows must be 0..%d" % MAX_ROWS)
    params["rows"] = rows
    return params, meta, year


# --------------------------------------------------------------- commands
def cmd_resolve(args):
    params, meta, year = _query_built(args)
    data = _get("/works", params)
    msg = data.get("message", {})
    items = msg.get("items") or []
    fallback = None
    if not items and year and params.get("query.bibliographic"):
        # Fallback: year metadata may be missing/partial -> move the year
        # into the bibliographic blob and drop date filters.
        fallback = ("year-filters-empty: re-queried with year inside "
                    "query.bibliographic, date filters dropped")
        p2 = {k: v for k, v in params.items() if k not in ("filter",)}
        p2["query.bibliographic"] = params["query.bibliographic"] + " " + str(year)
        data = _get("/works", p2)
        msg = data.get("message", {})
        items = msg.get("items") or []
        params = p2
    if not items:
        raise ApiError("no Crossref records matched: %s" % json.dumps(
            {k: v for k, v in params.items() if k != "select"}))
    kept, dropped = [], 0
    mins = {"min_citations": getattr(args, "min_citations", None),
            "min_references": getattr(args, "min_references", None),
            "publisher": getattr(args, "publisher", None)}
    if any(v is not None for v in mins.values()):
        for it in items:
            if _passes(it, mins["min_citations"], mins["min_references"],
                       mins["publisher"]):
                kept.append(it)
            else:
                dropped += 1
        if kept:
            items = kept
        else:
            # every row failed the post-filter — do NOT silently fall back to
            # unfiltered results; raise so the agent knows the constraint
            # was never satisfied (QA finding: silent passthrough trap)
            raise ApiError(
                "all %d candidates failed the post-filters %s; relax "
                "--min-citations/--min-references/--publisher or resolve "
                "with a different query" % (
                    dropped,
                    json.dumps({k: v for k, v in mins.items() if v is not None})))
    items, moved = _rerank(items)
    top = items[0]
    match, conf = _match_confidence(
        params.get("query.bibliographic"), _title_of(top))
    out = {
        "query": {k: v for k, v in params.items() if k != "select"},
        "total-results": msg.get("total-results"),
        "match": match,
        "confidence": conf,
        "score": top.get("score"),
        "top": _project_work(top),
        "alternates": [_project_work(i) for i in items[1:5]],
        "next": "crossref.py get %s" % (top.get("DOI") or ""),
        "rate-limit": _rate(),
    }
    if moved:
        out["re-ranked"] = {"moved": moved, "note": _RERANK_NOTE}
        jn = _junk_reason(top)
        if jn:
            out["re-ranked"]["top-quality-warning"] = jn
    if dropped:
        out["post-filter-dropped"] = dropped
    if fallback:
        out["fallback"] = fallback
    return _clean(out)


def cmd_get(args):
    doi = _norm_doi(args.doi)
    if not doi.lower().startswith("10."):
        raise ApiError("invalid DOI: %r (expected 10.xxxx/suffix)" % doi)
    rec = _get("/works/" + urllib.parse.quote(doi, safe=""))
    return _clean({"work": _project_work(rec["message"], full=True),
                   "rate-limit": _rate()})


def cmd_match(args):
    title = (args.title or "").strip()
    if not title:
        raise ApiError("match needs a title argument")
    params = {"query.bibliographic": title, "rows": 3}
    if args.year:
        params["filter"] = ("from-pub-date:%s-01-01,until-pub-date:%s-12-31"
                            % (args.year, args.year))
    data = _get("/works", params)
    items = data["message"].get("items") or []
    if not items:
        raise ApiError('no Crossref records matched "%s"' % title)
    items, moved = _rerank(items)
    top = items[0]
    match, conf = _match_confidence(title, _title_of(top))
    return _clean({
        "query": {"query.bibliographic": title},
        "total-results": data["message"].get("total-results"),
        "doi": top.get("DOI"),
        "title": _title_of(top) or None,
        "authors": _authors(top.get("author")) or None,
        "year": _first_date(top.get("issued")),
        "type": top.get("type"),
        "citation-count": top.get("is-referenced-by-count"),
        "score": top.get("score"),
        "score-note": "score is select-able (select=score) and shown on full records; match fetches full records so score is included",
        "match": match,
        "confidence": conf,
        "alternates": [{"doi": i.get("DOI"), "title": _title_of(i),
                        "citations": i.get("is-referenced-by-count")}
                       for i in items[1:5]],
        "next": "crossref.py get %s" % (top.get("DOI") or ""),
        "rate-limit": _rate(),
    })


def cmd_journals(args):
    if args.issn:
        data = _get("/journals/" + urllib.parse.quote(args.issn.strip(),
                                                      safe=""))
        m = data.get("message") or {}
        return _clean({"journal": {
            "title": m.get("title"), "publisher": m.get("publisher"),
            "issn": m.get("ISSN"), "issn-type": m.get("issn-type"),
            "counts": m.get("counts"),
            "works-api": "%s/journals/%s/works" % (BASE, args.issn.strip()),
        }, "rate-limit": _rate()})
    params = {"rows": args.rows}
    if args.query:
        params["query"] = args.query
    data = _get("/journals", params)
    msg = data.get("message", {})
    items = [{"title": j.get("title"), "publisher": j.get("publisher"),
              "issn": j.get("ISSN"), "issn-type": j.get("issn-type"),
              "dois": (j.get("counts") or {}).get("total-dois")}
             for j in (msg.get("items") or [])]
    return _clean({"total-results": msg.get("total-results"),
                   "journals": items, "rate-limit": _rate()})


def cmd_funders(args):
    params = {"rows": args.rows}
    if args.query:
        params["query"] = args.query
    data = _get("/funders", params)
    msg = data.get("message", {})
    items = [{"id": f.get("id"), "name": f.get("name"),
              "location": f.get("location"),
              "alt-names": f.get("alt-names"), "uri": f.get("uri")}
             for f in (msg.get("items") or [])]
    return _clean({"total-results": msg.get("total-results"),
                   "funders": items,
                   "hint": "fundworks <id> lists the funder's works",
                   "rate-limit": _rate()})


def cmd_fundworks(args):
    fid = args.funder_id.strip()
    fid = re.sub(r"^https?://doi\.org/", "", fid, flags=re.I)
    fid = re.sub(r"^doi:\s*", "", fid, flags=re.I)
    if not fid.startswith("10.13039/"):
        fid = "10.13039/" + fid.lstrip("/")
    path = "/funders/%s/works" % urllib.parse.quote(fid, safe="/")
    params = {"rows": args.rows,
              "select": ",".join(RESOLVE_SELECT)}
    if args.query:
        params["query"] = args.query
    data = _get(path, params)
    msg = data.get("message", {})
    return _clean({"funder": fid,
                   "total-results": msg.get("total-results"),
                   "works": [_project_work(i) for i in (msg.get("items") or [])],
                   "rate-limit": _rate()})


def cmd_types(args):
    data = _get("/types")
    msg = data.get("message", {})
    items = [{"id": t.get("id"), "label": t.get("label")}
             for t in (msg.get("items") or [])]
    return _clean({"total-results": msg.get("total-results"),
                   "types": items, "rate-limit": _rate()})


def cmd_licenses(args):
    params = {"rows": args.rows}
    if args.query:
        params["query"] = args.query
    data = _get("/licenses", params)
    msg = data.get("message", {})
    return _clean({"total-results": msg.get("total-results"),
                   "licenses": msg.get("items") or [],
                   "note": "query filters license URLs; put a license facet "
                           "on /works for per-work license data",
                   "rate-limit": _rate()})


def cmd_fields(args):
    """Meta-command: enumerate selectable fields from a live probe."""
    try:
        data = _get("/works", {"rows": 1, "select": ",".join(RESOLVE_SELECT),
                               "mailto": _STATE["email"] or None})
        observed = sorted((data["message"].get("items") or [{}])[0].keys())
        err = None
    except ApiError as e:
        observed = None
        err = str(e)
    return _clean({
        "default-select": list(RESOLVE_SELECT),
        "observed-selectable (live, rows=1)": observed,
        "core-fields (api_format.md)": [
            "abstract", "alternative-id", "archive", "article-number",
            "assertion", "author", "chair", "clinical-trial-number",
            "content-domain", "container-title", "created", "deposited",
            "DOI", "editor", "event", "funder", "group-title", "indexed",
            "ISBN", "ISSN", "issn-type", "issued", "is-referenced-by-count",
            "issue", "language", "license", "link", "member", "original-title",
            "page", "prefix", "published", "published-online",
            "published-print", "publisher", "publisher-location",
            "reference-count", "reference", "references-count", "relation",
            "review", "scores", "short-container-title", "short-title",
            "source", "subject", "subtitle", "title", "translator", "type",
            "update-policy", "update-to", "updated", "URL", "volume"],
        "note": ("title/container-title/original-title are ARRAYS of strings; "
                 "unknown select names -> HTTP 400 validation-failure"),
        "error": err if observed is None else None,
        "rate-limit": _rate(),
    })


def cmd_syntax(args):
    return {"syntax": {
        "base": BASE,
        "envelopes": {
            "list": {"status": "ok", "message-type": "work-list",
                     "message-version": "1.0.0",
                     "message": {"total-results": 0, "items": [],
                                 "items-per-page": 0,
                                 "query": {"start-index": 0}}},
            "singleton": {"status": "ok", "message-type": "work",
                          "message": {"DOI": "10.x/y"}}},
        "query.*": {
            "query": "free-text across all fields; score-ordered (relevance)",
            "query.bibliographic": "title+authors+ISSN+year blob — BEST for "
                                   "title->DOI resolution / citation lookup",
            "query.title": "DEPRECATED (live: still 200, falls through to a general query) — use "
                           "query.bibliographic",
            "query.author/editor/chair/translator": "contributor given+family names",
            "query.container-title": "publication (journal) name",
            "query.affiliation": "contributor affiliations"},
        "filters (AND across names, OR by repeating the same filter)": {
            "from-pub-date / until-pub-date": "YYYY or YYYY-MM or YYYY-MM-DD",
            "type": "id from /types (journal-article, posted-content, ...)",
            "issn": "xxxx-xxxx (journal filter; repeats = multiple ISSNs)",
            "doi": "restrict list results to this DOI",
            "container-title": "EXACT publication-title match",
            "has-abstract / has-references / has-orcid / has-license / "
            "has-full-text / has-funder": "boolean flags",
            "funder / award.funder / award.number": "funding filters",
            "prefix / member": "owner prefix (≠ current owner) / member id",
            "from-index-date": "best filter for incremental harvesting",
            "relation.type / relation.object": "e.g. is-preprint-of"},
        "paging": {"rows": "1..1000 (default 20; rows=0 -> summary only)",
                   "offset": "max 10000",
                   "sample": "max 100 (ignores rows/offset)",
                   "cursor": "cursor=* to start, then message.next-cursor; "
                             "supported on all /works routes"},
        "sorting": "sort=score|relevance|updated|deposited|indexed|published|"
                   "published-print|published-online|issued|"
                   "is-referenced-by-count|references-count (&order=asc|desc)",
        "select": "comma-separated fields — see `fields`",
        "politeness": "mailto=<email> param or User-Agent mailto: -> polite "
                      "pool; Crossref may throttle pooled machines when "
                      "impolite traffic spikes (X-Rate-Limit-* headers)",
        "plus": "Crossref Plus = paid SLA (Crossref-Plus-API-Token header); "
                "not needed for metadata access — note-only in this skill",
        "agencies": "/works/{doi}/agency -> {crossref|datacite|medra|...}; "
                    "non-Crossref DOIs 404 on all other routes",
    }}


# =================================================================== main
def main():
    p = argparse.ArgumentParser(
        prog="crossref.py",
        description="Crossref Metadata API — resolve papers to full metadata "
                    "from partial info, fetch records by DOI, and query "
                    "journals/funders/types/licenses registries.",
        epilog='One JSON object per command on stdout; errors {"error":...} '
               "on stderr, exit 2. Courtesy: set CROSSREF_EMAIL (polite pool).")
    p.add_argument("--email", help="contact email (polite pool); default "
                                   "$CROSSREF_EMAIL")
    sub = p.add_subparsers(dest="cmd")

    r = sub.add_parser(
        "resolve", help="FLAGSHIP — best Crossref query from ANY partial-info "
                        "combination; top record + 4 alternates",
        epilog="ex: resolve 'attention is all you need' --year 2017 --author vaswani\n"
               "ex: resolve 'bert pretraining' --year 2019 --type journal-article\n"
               "ex: resolve 'galnac lnp'                       (fragment)\n"
               "ex: resolve --issn 0028-0836 --year 2018       (no title)\n"
               "ex: resolve --doi 10.1038/nature14539          (same as get)")
    r.add_argument("title", nargs="*", help="title text (exact or fragment)")
    r.add_argument("--doi", help="DOI if known (10.x/suffix, doi.org URL ok)")
    r.add_argument("--author", help="author name(s) — given and/or family")
    r.add_argument("--year", help="publication year (YYYY)")
    r.add_argument("--journal", help="journal title (fuzzy query.container-title)")
    r.add_argument("--issn", help="journal ISSN xxxx-xxxx (exact filter)")
    r.add_argument("--type", help="type id or alias (paper, preprint, book, ...)")
    r.add_argument("--publisher", help="client-side publisher name post-filter")
    r.add_argument("--abstract", action="store_true",
                   help="require has-abstract:true")
    r.add_argument("--min-references", type=int,
                   help="client-side: keep records with references-count >= N")
    r.add_argument("--min-citations", type=int,
                   help="client-side: keep records with is-referenced-by-count >= N")
    r.add_argument("--select", help="override the default select= field list")
    r.add_argument("--rows", type=int, default=5,
                   help="candidates to fetch (default 5)")
    r.set_defaults(func=cmd_resolve)

    g = sub.add_parser("get", help="full record by DOI",
                       epilog="ex: get 10.1038/nature14539\n"
                              "ex: get doi:10.1038/nature14539\n"
                              "ex: get https://doi.org/10.1038/nature14539")
    g.add_argument("doi")
    g.set_defaults(func=cmd_get)

    m = sub.add_parser(
        "match", help="thin title->doi wrapper (query.bibliographic) with "
                      "score + confidence hint + alternates",
        epilog="ex: match 'attention is all you need' --year 2017")
    m.add_argument("title")
    m.add_argument("--year")
    m.set_defaults(func=cmd_match)

    j = sub.add_parser("journals", epilog="ex: journals --issn 0028-0836\n"
                                          "ex: journals 'Nature Neuroscience'")
    j.add_argument("query", nargs="?", default=None)
    j.add_argument("--issn", help="fetch one journal by ISSN instead")
    j.add_argument("--rows", type=int, default=5)
    j.set_defaults(func=cmd_journals)

    f = sub.add_parser("funders", epilog="ex: funders 'National Science Foundation'")
    f.add_argument("query", nargs="?", default=None)
    f.add_argument("--rows", type=int, default=5)
    f.set_defaults(func=cmd_funders)

    fw = sub.add_parser("fundworks", epilog="ex: fundworks 100000001 --query 'deep learning'")
    fw.add_argument("funder_id", help="10.13039/ id (bare id or doi: form ok)")
    fw.add_argument("--query")
    fw.add_argument("--rows", type=int, default=5)
    fw.set_defaults(func=cmd_fundworks)

    t = sub.add_parser("types", help="list Crossref work type ids")
    t.set_defaults(func=cmd_types)

    l = sub.add_parser("licenses", help="list license URLs in Crossref metadata")
    l.add_argument("query", nargs="?", default=None)
    l.add_argument("--rows", type=int, default=5)
    l.set_defaults(func=cmd_licenses)

    fl = sub.add_parser("fields", help="list select= fields usable on /works")
    fl.set_defaults(func=cmd_fields)
    sy = sub.add_parser("syntax", help="cheat-sheet: query/filter/paging/sorting")
    sy.set_defaults(func=cmd_syntax)

    args = p.parse_args()
    if not getattr(args, "func", None):
        p.print_help(sys.stderr)
        sys.exit(2)
    _STATE["email"] = _email(args)
    try:
        out = args.func(args)
        print(json.dumps(out, ensure_ascii=False, indent=1))
    except ApiError as e:
        print(json.dumps({"error": str(e), "status": e.status,
                          "detail": _clip(e.body)},
                         ensure_ascii=False), file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()