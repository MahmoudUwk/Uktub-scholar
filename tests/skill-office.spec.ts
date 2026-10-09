/**
 * skills/uktub-office/scripts/docx_changes.py: list the tracked changes and comments a co-author left in a .docx, using only the Python
 * standard library (a .docx is a zip of XML). The fixture is built here, a small document with an insertion, a deletion, a formatting
 * change and two comments, one of them anchored to a passage.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";

const SCRIPT = resolve(import.meta.dirname, "../skills/uktub-office/scripts/docx_changes.py");
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function docx(documentXml: string, commentsXml?: string): string {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document ${W}><w:body>${documentXml}</w:body></w:document>`),
  };
  if (commentsXml) files["word/comments.xml"] = strToU8(`<?xml version="1.0"?><w:comments ${W}>${commentsXml}</w:comments>`);
  const path = join(mkdtempSync(join(tmpdir(), "docx-")), "returned.docx");
  writeFileSync(path, zipSync(files));
  return path;
}
const run = (path: string, ...args: string[]) => spawnSync("python3", [SCRIPT, path, ...args], { encoding: "utf8" });

describe("docx_changes.py", { skip: !hasPython }, () => {
  const file = docx(
    `<w:p><w:r><w:t xml:space="preserve">The mean error is </w:t></w:r>` +
      `<w:del w:id="1" w:author="Dr Co" w:date="2026-10-08T09:00:00Z"><w:r><w:delText>12.5</w:delText></w:r></w:del>` +
      `<w:ins w:id="2" w:author="Dr Co" w:date="2026-10-08T09:00:00Z"><w:r><w:t>12.9</w:t></w:r></w:ins>` +
      `<w:r><w:t xml:space="preserve"> units per run.</w:t></w:r></w:p>` +
      `<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>The method helps.</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>` +
      `<w:del w:id="3" w:author="Ana" w:date="2026-10-09T10:00:00Z"><w:r><w:delText xml:space="preserve"> It is obviously better.</w:delText></w:r></w:del></w:p>` +
      `<w:p><w:pPr><w:pPrChange w:id="4" w:author="Ana" w:date="2026-10-09T10:00:00Z"><w:pPr/></w:pPrChange></w:pPr><w:r><w:t>Heading text</w:t></w:r></w:p>`,
    `<w:comment w:id="0" w:author="Dr Co" w:date="2026-10-08T09:05:00Z"><w:p><w:r><w:t>Please add the standard deviation over seeds.</w:t></w:r></w:p></w:comment>` +
      `<w:comment w:id="5" w:author="Ana" w:date="2026-10-09T10:05:00Z"><w:p><w:r><w:t>Check the units here.</w:t></w:r></w:p></w:comment>`,
  );

  it("counts the tracked changes and comments, and lists each with author, date, text and the paragraph it sits in (as it reads with changes accepted)", () => {
    const r = run(file);
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout;
    assert.match(out, /4 tracked changes \(1 insertion, 2 deletions, 1 formatting\), 2 comments/);
    assert.match(out, /deletion by Dr Co \(2026-10-08\): "12\.5"/);
    assert.match(out, /insertion by Dr Co \(2026-10-08\): "12\.9"/);
    assert.match(out, /deletion by Ana \(2026-10-09\): " It is obviously better\."/);
    assert.match(out, /formatting by Ana \(2026-10-09\)/);
    assert.match(out, /in: The mean error is 12\.9 units per run\./, "the paragraph as it reads once the changes are accepted");
    assert.match(out, /Comment 0 by Dr Co \(2026-10-08\) on "The method helps\.": Please add the standard deviation over seeds\./);
    assert.match(out, /Comment 5 by Ana \(2026-10-09\): Check the units here\./);
  });

  it("says plainly when a document has no tracked changes and no comments, and refuses what is not a .docx", () => {
    const clean = docx('<w:p><w:r><w:t>Nothing to see.</w:t></w:r></w:p>');
    assert.match(run(clean).stdout, /0 tracked changes.*0 comments/);
    const bad = join(mkdtempSync(join(tmpdir(), "notdocx-")), "x.docx");
    writeFileSync(bad, "not a zip");
    const r = run(bad);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not a .docx|zip/i);
  });
});
