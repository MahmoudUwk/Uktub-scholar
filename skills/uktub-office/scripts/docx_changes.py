#!/usr/bin/env python3
"""List the tracked changes and comments of a .docx, with author, date, text and the paragraph each sits in.

    python3 docx_changes.py returned.docx

Standard library only (a .docx is a zip of XML). Insertions and deletions are read from w:ins / w:del; formatting changes from
w:rPrChange / w:pPrChange / w:sectPrChange / w:tblPrChange; comments from word/comments.xml, with the passage they are anchored to. The
paragraph shown is how it reads once every change is accepted (insertions in, deletions out). Reading never modifies the file.
"""
import sys
import zipfile
import xml.etree.ElementTree as ET

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}
FORMAT_TAGS = ("rPrChange", "pPrChange", "sectPrChange", "tblPrChange", "trPrChange", "tcPrChange")


def q(tag):
    return f"{{{W}}}{tag}"


def attr(el, name):
    return el.get(q(name), "")


def date(el):
    return attr(el, "date")[:10]


def text_of(el):
    return "".join(t.text or "" for t in el.iter() if t.tag in (q("t"), q("delText")))


def main(path):
    try:
        z = zipfile.ZipFile(path)
        document = ET.fromstring(z.read("word/document.xml"))
    except (zipfile.BadZipFile, KeyError, ET.ParseError) as e:
        print(f"error: {path} is not a .docx this tool can read ({type(e).__name__})", file=sys.stderr)
        return 1
    comments = {}
    if "word/comments.xml" in z.namelist():
        for c in ET.fromstring(z.read("word/comments.xml")).iter(q("comment")):
            comments[attr(c, "id")] = (attr(c, "author"), date(c), " ".join(text_of(p) for p in c.iter(q("p"))).strip())

    changes = []  # (kind, author, date, text, paragraph text)
    anchors = {}  # comment id -> anchored text
    for p in document.iter(q("p")):
        accepted = []
        found = []
        open_comments = []

        def walk(el, in_del=False):
            for child in el:
                if child.tag == q("del"):
                    found.append(("deletion", attr(child, "author"), date(child), text_of(child)))
                    walk(child, True)
                elif child.tag == q("ins"):
                    found.append(("insertion", attr(child, "author"), date(child), text_of(child)))
                    walk(child, in_del)
                elif child.tag == q("commentRangeStart"):
                    open_comments.append(attr(child, "id"))
                    anchors.setdefault(attr(child, "id"), "")
                elif child.tag == q("commentRangeEnd"):
                    if attr(child, "id") in open_comments:
                        open_comments.remove(attr(child, "id"))
                elif child.tag.split("}")[-1] in FORMAT_TAGS:
                    found.append(("formatting", attr(child, "author"), date(child), "paragraph properties changed" if child.tag == q("pPrChange") else "formatting changed"))
                elif child.tag == q("t") and not in_del:
                    accepted.append(child.text or "")
                    for cid in open_comments:
                        anchors[cid] += child.text or ""
                else:
                    walk(child, in_del)

        walk(p)
        para = "".join(accepted).strip()
        for kind, author, d, text in found:
            changes.append((kind, author, d, text, para))

    counts = {k: sum(1 for c in changes if c[0] == k) for k in ("insertion", "deletion", "formatting")}
    plural = lambda n, w: f"{n} {w}{'' if n == 1 else 's'}"
    print(f"docx: {path.split('/')[-1]} — {plural(len(changes), 'tracked change')} "
          f"({plural(counts['insertion'], 'insertion')}, {plural(counts['deletion'], 'deletion')}, {counts['formatting']} formatting), {plural(len(comments), 'comment')}")
    for i, (kind, author, d, text, para) in enumerate(changes, 1):
        shown = f'"{text}"' if kind != "formatting" else text
        print(f"[{i}] {kind} by {author} ({d}): {shown}")
        print(f"    in: {para[:240]}")
    for cid, (author, d, text) in comments.items():
        on = anchors.get(cid, "").strip()
        print(f"Comment {cid} by {author} ({d})" + (f' on "{on}"' if on else "") + f": {text}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: docx_changes.py <file.docx>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
