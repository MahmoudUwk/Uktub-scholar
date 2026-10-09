#!/usr/bin/env python3
"""Read a .pptx back: per slide its title, its text, the number of pictures, tables and equations, and its speaker notes.

    python3 pptx_outline.py talk.pptx

Standard library only (a .pptx is a zip of XML). Table cells are read too (rows joined by ` ; `, cells by ` | `). Slides are listed in slide order (slide10 after slide9). Reading never modifies the file.
"""
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"


def texts(el):
    return [t.text or "" for t in el.iter(f"{{{A}}}t")]


def paragraphs(el):
    return ["".join(texts(p)) for p in el.iter(f"{{{A}}}p") if "".join(texts(p)).strip()]


def main(path):
    try:
        z = zipfile.ZipFile(path)
        names = z.namelist()
        slides = sorted((n for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)), key=lambda n: int(re.findall(r"\d+", n)[0]))
        if not slides:
            raise KeyError("ppt/slides")
    except (zipfile.BadZipFile, KeyError) as e:
        print(f"error: {path} is not a .pptx this tool can read ({type(e).__name__})", file=sys.stderr)
        return 1
    rows = []
    for n in slides:
        root = ET.fromstring(z.read(n))
        title, body = "", []
        for sp in root.iter(f"{{{P}}}sp"):
            ph = sp.find(f".//{{{P}}}ph")
            lines = paragraphs(sp)
            if ph is not None and ph.get("type") in ("title", "ctrTitle"):
                title = " ".join(lines)
            else:
                body.extend(lines)
        notes = ""
        rels = n.replace("slides/", "slides/_rels/") + ".rels"
        if rels in names:
            for r in ET.fromstring(z.read(rels)).iter(f"{{{REL}}}Relationship"):
                target = r.get("Target", "")
                if r.get("Type", "").endswith("/notesSlide"):
                    notes_path = "ppt/" + target.replace("../", "")
                    if notes_path in names:
                        notes = " ".join(paragraphs(ET.fromstring(z.read(notes_path))))
        grid = [" ; ".join(" | ".join(" ".join(texts(c)).strip() for c in tr.iter(f"{{{A}}}tc")) for tr in tbl.iter(f"{{{A}}}tr")) for tbl in root.iter(f"{{{A}}}tbl")]
        rows.append((title, body, len(list(root.iter(f"{{{P}}}pic"))), len(grid), len(list(root.iter(f"{{{M}}}oMath"))), notes, grid))
    print(f"pptx: {path.split('/')[-1]} — {len(rows)} slides, pictures {sum(r[2] for r in rows)}, tables {sum(r[3] for r in rows)}, "
          f"equations {sum(r[4] for r in rows)}, notes on {sum(1 for r in rows if r[5])} slides")
    for i, (title, body, pics, tables, eqs, notes, grid) in enumerate(rows, 1):
        print(f"[{i}] {title or '(no title)'} | pictures {pics}, tables {tables}, equations {eqs}, notes {'yes' if notes else 'no'}")
        if body:
            print(f"    text: {' | '.join(body)[:300]}")
        for g in grid:
            print(f"    table: {g[:600]}")
        if notes:
            print(f"    notes: {notes[:200]}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: pptx_outline.py <file.pptx>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
