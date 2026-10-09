/** A small .pptx built from XML (the structure pandoc writes): four slides with a title, text, a picture, a table, an equation and one slide's notes. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const slide = (title: string | undefined, kind: "ctrTitle" | "title", body: string) =>
  `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree>` +
  (title === undefined ? "" : `<p:sp><p:nvSpPr><p:nvPr><p:ph type="${kind}"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>`) +
  body + `</p:spTree></p:cSld></p:sld>`;
const text = (t: string) => `<p:sp><p:nvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`;
const rels = (target?: string) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${target ? `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="${target}"/>` : ""}</Relationships>`;
export function writeFixturePptx(): string {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "ppt/slides/slide1.xml": strToU8(slide("A synthetic study", "ctrTitle", text("A. Author"))),
    "ppt/slides/slide2.xml": strToU8(slide("The method halves the error", "title", text("Error fell from 13.1 to 12.5 units") + text("Training took 2 hours"))),
    "ppt/slides/slide3.xml": strToU8(slide("The figure shows the trend", "title", "<p:pic><p:nvPicPr/></p:pic>")),
    "ppt/slides/slide10.xml": strToU8(slide(undefined, "title", "<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Method</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Error</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Ours</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>12.5</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame><m:oMathPara><m:oMath/></m:oMathPara>")),
    "ppt/slides/_rels/slide2.xml.rels": strToU8(rels("../notesSlides/notesSlide1.xml")),
    "ppt/notesSlides/notesSlide1.xml": strToU8(`<?xml version="1.0"?><p:notes ${P}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Say the baseline first.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`),
    "ppt/media/image1.png": new Uint8Array([1]),
  };
  const path = join(mkdtempSync(join(tmpdir(), "pptx-")), "talk.pptx");
  writeFileSync(path, zipSync(files));
  return path;
}
