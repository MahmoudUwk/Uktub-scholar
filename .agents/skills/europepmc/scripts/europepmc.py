#!/usr/bin/env python3
"""Europe PMC API helper for LLM agents. Stdlib only (urllib, json).

Europe PMC: 48M+ life-sciences articles (PubMed/MEDLINE, PubMed Central OA,
preprints, patents, theses, NLM Bookshelf). Free, NO API key.
Be courteous: no published rate limit, but throttle ~1-2 req/s (this script
sleeps between paged calls); EBI firewalls abusive traffic.

Base URLs:
  REST:         https://www.ebi.ac.uk/europepmc/webservices/rest   (API 6.9)
  Annotations:  https://www.ebi.ac.uk/europepmc/annotations_api    (API 2.x)
  Grants (GRIST): https://www.ebi.ac.uk/europepmc/GristAPI/rest/get/query=...

Commands:
  search <query>          search 48M+ articles (fields, boolean, cursor paging)
  get <SRC/ID>            one article's core metadata (MED/27480119, PMC/PMC2832744, PPR/PPR150163)
  citations <SRC/ID>      articles citing this one
  references <SRC/ID>     this article's bibliography (citedOrder preserved)
  labslinks <SRC/ID>      third-party External Links (LabsLink providers)
  annotations <SRC:ID>    text-mined annotations (genes, diseases, chemicals, GO...)
                          via annotationsByArticleIds; NOTE: MED:27480119 (not PMID:)
  annentity <entity>      articles tagging an entity (e.g. P04637, "breast cancer")
  suppfiles <PMCid>       supplementary-files ZIP download (OA subset)
  fulltextxml <PMCID>     download JATS full text (OA subset only; id-only path)
  grants <query>          GRIST grant search (funders, PIs, award ids)
  fields                  list the 143 indexed search fields
  syntax                  print the search-syntax cheat sheet

Article id forms: MED/<pmid>, PMC/<pmcid>, PPR/<ppr-id>, or bare PMID
(bare -> MED). PMC ids keep the PMC prefix; preprints keep PPR prefix.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

REST = "https://www.ebi.ac.uk/europepmc/webservices/rest"
ANN = "https://www.ebi.ac.uk/europepmc/annotations_api"
GRIST = "https://www.ebi.ac.uk/europepmc/GristAPI/rest/get"
SLEEP = float(os.environ.get("EPMC_SLEEP", "0.3"))


class ApiError(Exception):
    pass


def _get(url, raw=False):
    req = urllib.request.Request(url, headers={"User-Agent": "agent-research-cli/0.1 (europepmc skill)"})
    last_err = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                data = r.read()
            return data if raw else json.loads(data.decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode("utf-8", "replace")[:300]
            except Exception:
                body = ""
            if e.code in (429, 502, 503, 504):
                last_err = ApiError(f"HTTP {e.code} {url} {body}")
                time.sleep(min(3 * 2 ** attempt, 20))
                continue
            raise ApiError(f"HTTP {e.code} {url} {body}") from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last_err = ApiError(f"{type(e).__name__} {url}: {e}")
            time.sleep(min(2 * 2 ** attempt, 10))
    assert last_err is not None
    raise last_err


def _norm_sid(sid):
    """Normalize to SOURCE/ID. Accepts SOURCE/ID, SOURCE:ID (colon form), bare
    digits -> MED/<pmid>; PMC... -> PMC/...; PPR.../NBK... -> prefixed form."""
    if "/" in sid:
        return sid
    if ":" in sid:
        src, ext = sid.split(":", 1)
        if src.upper() in ("MED", "PMC", "PPR", "NBK", "AGR", "CBA", "CTX", "ETH", "HIR", "PAT", "CIT"):
            return f"{src.upper()}/{ext}"
    if sid.upper().startswith("PMC"):
        return f"PMC/{sid}"
    if sid.upper().startswith("PPR") or sid.upper().startswith("NBK"):
        return f"{sid[:3]}/{sid}"
    if sid.isdigit():
        return f"MED/{sid}"
    raise ApiError(f"cannot infer source for '{sid}' (use SOURCE/ID or SOURCE:ID form, e.g. MED/27480119)")


def _clean(item) -> Any:
    if isinstance(item, dict):
        return {k: _clean(v) for k, v in item.items() if v not in (None, "", [], {})}
    if isinstance(item, list):
        return [_clean(x) for x in item]
    return item


def _flatten_article(r):
    """Compact article view; strips JATS/HTML tags from abstract."""
    import re
    if not isinstance(r, dict):
        return r
    ji = r.get("journalInfo") or {}
    j = ji.get("journal") or {}
    abs_text = r.get("abstractText")
    if abs_text:
        abs_text = re.sub(r"<[^>]+>", "", abs_text).strip()
    out = {
        "id": f"{r.get('source')}/{r.get('id')}",
        "title": r.get("title"),
        "authors": r.get("authorString"),
        "year": r.get("pubYear") or ji.get("yearOfPublication"),
        "journal": r.get("journalTitle") or j.get("title"),
        "doi": r.get("doi"),
        "pmid": r.get("pmid"),
        "pmcid": r.get("pmcid"),
        "pubType": r.get("pubType"),
        "isOA": r.get("isOpenAccess"),
        "inEPMC": r.get("inEPMC"),
        "hasFulltext": r.get("inEPMC") == "Y" or r.get("hasPDF") == "Y",
        "citedBy": r.get("citedByCount"),
        "abstract": abs_text,
    }
    urls = [u.get("url") for u in ((r.get("fullTextUrlList") or {}).get("fullTextUrl") or [])]
    if urls:
        out["fullTextUrls"] = urls
    return {k: v for k, v in out.items() if v not in (None, "", [], {})}


def _check_hit(data):
    """Europe PMC returns HTTP 200 with hitCount 0 for missing records."""
    if isinstance(data, dict) and "errCode" in data:
        raise ApiError(f"{data.get('errCode')}: {data.get('errMsg')}")
    return data


def cmd_search(a):
    params = {"query": a.query, "format": "json", "pageSize": str(min(a.page_size, 1000)),
              "resultType": a.result_type}
    if a.cursor:
        params["cursorMark"] = a.cursor
    if a.page:
        params["page"] = str(a.page)
    if a.sort:
        params["sort"] = a.sort
    if a.synonyms:
        params["synonym"] = "true"
    url = f"{REST}/search?{urllib.parse.urlencode(params)}"
    data = _check_hit(_get(url))
    out = {"hitCount": data.get("hitCount"), "nextCursorMark": data.get("nextCursorMark")}
    rl = ((data.get("resultList") or {}).get("result")) or []
    out["results"] = [f"{r.get('source')}/{r.get('id')}" for r in rl] if a.result_type == "idlist" \
        else [_flatten_article(r) for r in rl]
    return out


def cmd_get(a):
    sid = _norm_sid(a.article)
    data = _check_hit(_get(f"{REST}/article/{sid}?format=json&resultType=core"))
    result = data.get("result")
    if not result:
        return {"hitCount": 0, "note": "no record (EPMC returns HTTP 200 with hitCount 0 for unknown ids)"}
    out = _flatten_article(result)
    if out.get("isOA") != "Y":
        out.pop("abstract", None) if not out.get("abstract") else None
    return out


def cmd_citations(a):
    sid = _norm_sid(a.article)
    params = {"format": "json", "pageSize": str(min(a.page_size, 1000))}
    if a.page:
        params["page"] = str(a.page)
    data = _check_hit(_get(f"{REST}/{sid}/citations?{urllib.parse.urlencode(params)}"))
    out = {"hitCount": data.get("hitCount")}
    out["citations"] = [_flatten_article(c) for c in ((data.get("citationList") or {}).get("citation")) or []]
    return out


def cmd_references(a):
    sid = _norm_sid(a.article)
    params = {"format": "json", "pageSize": str(min(a.page_size, 1000))}
    if a.page:
        params["page"] = str(a.page)
    data = _check_hit(_get(f"{REST}/{sid}/references?{urllib.parse.urlencode(params)}"))
    out = {"hitCount": data.get("hitCount")}
    refs = ((data.get("referenceList") or {}).get("reference")) or []
    out["references"] = [{"order": r.get("citedOrder"), **_flatten_article(r)} for r in refs]
    return out


def cmd_labslinks(a):
    sid = _norm_sid(a.article)
    data = _check_hit(_get(f"{REST}/{sid}/labsLinks?format=json"))
    links = data.get("labsLinksList") or data.get("providers") or []
    if not isinstance(links, list):
        links = [links]
    return {"hitCount": data.get("hitCount"), "links": _clean(links[:50])}


def _ann_get(path, params):
    url = f"{ANN}/{path}?{urllib.parse.urlencode(params)}"
    data = _check_hit(_get(url))
    return data.get("articles", data) if isinstance(data, dict) else data


def cmd_annotations(a):
    # articleIds: SOURCE:EXT_ID where PMC uses the NUMERIC id (PMC:5389698), MED: uses PMID
    src, ext = _norm_sid(a.article).split("/", 1)
    if src == "PMC":
        ext = ext[3:] if ext.upper().startswith("PMC") else ext
    params = {"articleIds": f"{src}:{ext}", "format": "JSON"}
    if a.type:
        params["type"] = a.type
    if a.provider:
        params["provider"] = a.provider
    if a.section:
        params["section"] = a.section
    arts = _ann_get("annotationsByArticleIds", params)
    out = []
    for art in (arts if isinstance(arts, list) else [arts]):
        for ann in (art.get("annotations") or [])[: a.limit]:
            out.append({"exact": ann.get("exact"), "type": ann.get("type"),
                        "provider": ann.get("provider"), "section": ann.get("section"),
                        "tags": [t.get("name") for t in (ann.get("tags") or [])],
                        "uris": [t.get("uri") for t in (ann.get("tags") or [])]})
    return {"article": f"{src}/{ext}", "count": len(out), "annotations": out[: a.limit]}


def cmd_annentity(a):
    params = {"entity": a.entity, "format": "JSON", "pageSize": str(min(max(a.page_size, 1), 8))}
    if a.cursor:
        params["cursorMark"] = a.cursor
    data = _check_hit(_get(f"{ANN}/annotationsByEntity?{urllib.parse.urlencode(params)}"))
    arts = data.get("articles") or []
    out = {"nextCursorMark": data.get("nextCursorMark"), "articles": []}
    for art in arts:
        out["articles"].append({"id": f"{art.get('source')}/{art.get('extId')}",
                                "annCount": len(art.get("annotations") or [])})
    return out


def cmd_suppfiles(a):
    pmcid = a.pmcid if a.pmcid.upper().startswith("PMC") else f"PMC{a.pmcid}"
    url = f"{REST}/{pmcid}/supplementaryFiles"
    payload = _get(url, raw=True)
    out_path = a.out or f"{pmcid}_supp.zip"
    with open(out_path, "wb") as f:
        f.write(payload)
    return {"written": os.path.abspath(out_path), "bytes": len(payload),
            "note": "application/zip; OA subset only"}


def cmd_fulltextxml(a):
    # id-only path: /rest/PMC3257301/fullTextXML (the /PMC/PMC.../fullTextXML form 404s)
    pmcid = a.pmcid if a.pmcid.upper().startswith("PMC") else f"PMC{a.pmcid}"
    url = f"{REST}/{pmcid}/fullTextXML"
    payload = _get(url, raw=True)
    out_path = a.out or f"{pmcid}.xml"
    with open(out_path, "wb") as f:
        f.write(payload)
    head = payload[:200].decode("utf-8", "replace")
    first_line = next((ln for ln in head.split("\n") if ln.strip()), "")
    return {"written": os.path.abspath(out_path), "bytes": len(payload),
            "doctype": first_line[:120]}


def cmd_grants(a):
    # GRIST: query embedded path-style (query=... not ?query=...); terms space-joined
    q = a.query.replace("&", " ")  # never join terms with &
    path_q = urllib.parse.quote(q, safe="")
    fmt = {"json": "json", "xml": "XML", "cerif": "cerif"}[a.format_]  # json must be lowercase; XML/cerif as documented
    url = f"https://www.ebi.ac.uk/europepmc/GristAPI/rest/get/query={path_q}&format={fmt}"
    if a.page:
        url += f"&page={a.page}"
    if a.result_type == "core":
        url += "&resultType=core"  # omitting = lite (default); lowercase required
    data = _get(url)
    if isinstance(data, dict):
        out = {"hitCount": data.get("HitCount", data.get("hitCount"))}
        recs = ((data.get("RecordList") or data.get("grantList") or {}).get("Record")) or []
        out["grants"] = []
        for r in recs:
            person = r.get("Person") or {}
            grant = r.get("Grant") or {}
            funder = (grant.get("Funder") or {})
            out["grants"].append({"pi": " ".join(x for x in (person.get("GivenName"), person.get("FamilyName")) if x) or person.get("FamilyName"),
                                  "funder": funder.get("Name"), "grantId": grant.get("Id"),
                                  "doi": grant.get("Doi"), "title": grant.get("Title")})
        return out
    return {"note": "non-JSON response", "bytes": len(str(data))}


def cmd_fields(a):
    data = _get(f"{REST}/fields?format=json")
    terms = [t.get("term") for t in ((data.get("searchTermList") or {}).get("searchTerms")) or []]
    return {"count": len(terms), "fields": terms}


SYNTAX = """Europe PMC search syntax (verified live against /rest/search):
  Boolean: AND OR NOT (upper-case), parentheses; implicit AND between terms
  Phrase:  double quotes  TITLE:"attention is all you need"
  Fields:  TITLE: ABSTRACT: AUTH:"Smith J" AFF: JOURNAL:"Nature" DOI: PMID: PMC:
           PUB_YEAR:2024  FIRST_PDATE:[2024-01-01 TO 2024-12-31]  (encode [] as %5B %5D)
           SRC:MED|PMC|PPR|AGR|CBA|CTX|ETH|HIR|PAT|CIT  EXT_ID:27480119
  Flags:   OPEN_ACCESS:y  HAS_ABSTRACT:y  HAS_FT:y  IN_EPMC:y  HAS_PDF:y
           HAS_XREFS:y (db cross-refs; NOT HAS_DB_CROSS_REFERENCES)  HAS_REFLIST:y
           IS_BOOK:y  LICENSE:"cc by"  LANG:eng
  Sort:    &sort=CITED desc | P_PDATE_D desc | FIRST_AUTHOR asc (default: relevance)
  Paging:  &pageSize= (default 25, max 1000) + &cursorMark=<nextCursorMark> for deep paging
           (&page=N offset paging also works for small sets)
  Extras:  &synonym=true (MeSH expansion), &resultType=lite|core|idlist, format=xml|json|dc
  Legacy in-query sort tokens: 'malaria sort_date:y', 'crispr sort_cited:y'
"""


def cmd_syntax(a):
    return {"syntax": SYNTAX}


def main():
    p = argparse.ArgumentParser(description="Europe PMC API CLI (free, no key; be courteous)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search", help="search articles; 'syntax' shows the query language")
    s.add_argument("query")
    s.add_argument("--page-size", type=int, default=25, help="default 25, max 1000")
    s.add_argument("--cursor", help="nextCursorMark from the previous page")
    s.add_argument("--page", type=int, help="offset paging (small sets)")
    s.add_argument("--sort", help="e.g. 'CITED desc', 'P_PDATE_D desc'")
    s.add_argument("--result-type", choices=["lite", "core", "idlist"], default="lite")
    s.add_argument("--synonyms", action="store_true", help="MeSH synonym expansion")

    for name, help_ in [("get", "one article's metadata (core)"),
                        ("citations", "articles citing this one"),
                        ("references", "this article's bibliography"),
                        ("labslinks", "third-party LabsLink external links")]:
        s = sub.add_parser(name, help=help_)
        s.add_argument("article", help="SOURCE/ID (MED/27480119, PMC/PMC2832744, PPR/PPR150163, or bare PMID)")
        if name in ("citations", "references"):
            s.add_argument("--page-size", type=int, default=25, help="max 1000")
            s.add_argument("--page", type=int)

    s = sub.add_parser("annotations", help="text-mined annotations for one article")
    s.add_argument("article", help="SOURCE/ID or SOURCE:ID (MED/27480119 or MED:27480119; PMC/PMC5389698 or PMC:5389698)")
    s.add_argument("--type", help="semantic type filter, e.g. 'Diseases,Gene_Proteins'")
    s.add_argument("--provider", help="e.g. 'Europe PMC', 'OntoGene'")
    s.add_argument("--section", help="e.g. Abstract")
    s.add_argument("--limit", type=int, default=50)

    s = sub.add_parser("annentity", help="articles whose annotations tag an entity")
    s.add_argument("entity", help="e.g. P04637 (UniProt acc) or 'breast cancer'")
    s.add_argument("--page-size", type=int, default=8, help="articles per page, 1-8")
    s.add_argument("--cursor", help="nextCursorMark from previous page")

    for name, help_ in [("suppfiles", "download supplementary-files ZIP (OA subset)"),
                        ("fulltextxml", "download JATS full text (OA subset only)")]:
        s = sub.add_parser(name, help=help_)
        s.add_argument("pmcid", help="PMCID (PMC2832744 or 2832744)")
        s.add_argument("--out", help="output path")

    s = sub.add_parser("grants", help="search GRIST grant database (funders, PIs, awards)")
    s.add_argument("query", help='e.g. \'ga:"Wellcome Trust" pi:smith\' or gid:081052')
    s.add_argument("--page", type=int)
    s.add_argument("--result-type", choices=["lite", "core"], default="lite")
    s.add_argument("--format", dest="format_", choices=["json", "xml", "cerif"], default="json")

    sub.add_parser("fields", help="list the 143 indexed search fields")
    sub.add_parser("syntax", help="print search-syntax cheat sheet")

    args = p.parse_args()
    fn = {"search": cmd_search, "get": cmd_get, "citations": cmd_citations,
          "references": cmd_references, "labslinks": cmd_labslinks,
          "annotations": cmd_annotations, "annentity": cmd_annentity,
          "suppfiles": cmd_suppfiles, "fulltextxml": cmd_fulltextxml,
          "grants": cmd_grants, "fields": cmd_fields, "syntax": cmd_syntax}[args.cmd]
    try:
        print(json.dumps(fn(args), ensure_ascii=False))
    except ApiError as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(2)
    except OSError as e:
        print(json.dumps({"error": f"file write failed: {e}"}), file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()