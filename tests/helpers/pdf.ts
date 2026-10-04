/**
 * Offline PDF fixtures: a minimal hand-built PDF 1.4 writer (Helvetica text,
 * correct xref table) so source-extraction tests need no binary files and no
 * third-party document.
 */

const escapePdf = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** One PDF; each entry of `pages` is that page's text lines (empty = no text layer). */
export function makePdf(pages: string[][]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);
  add("<< /Type /Catalog /Pages 2 0 R >>"); // 1
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`); // 2
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"); // 3
  pages.forEach((lines, i) => {
    const pageObj = 4 + i * 2;
    const content =
      lines.length === 0
        ? "0.5 g 50 50 300 300 re f" // image-only stand-in: drawing, no text operators
        : "BT /F1 11 Tf 14 TL 50 740 Td " + lines.map((l) => `(${escapePdf(l)}) Tj T*`).join(" ") + " ET";
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObj + 1} 0 R >>`);
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** A GROBID-shaped TEI document: header title + body sections. */
export function makeTei(opts: { title: string; doi?: string; sections: { head?: string; paragraphs: string[] }[]; doctype?: string }): string {
  const body = opts.sections
    .map((s) => `<div>${s.head ? `<head>${s.head}</head>` : ""}${s.paragraphs.map((p) => `<p>${p}</p>`).join("")}</div>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>${opts.doctype ?? ""}
<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title level="a" type="main">${opts.title}</title></titleStmt>
<sourceDesc><biblStruct><analytic>${opts.doi ? `<idno type="DOI">${opts.doi}</idno>` : ""}</analytic></biblStruct></sourceDesc></fileDesc></teiHeader>
<text xml:lang="en"><body>${body}</body></text></TEI>`;
}
