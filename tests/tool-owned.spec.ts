import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { destructiveToolOwnedCommand } from "../src/core/tool-owned.ts";

describe("destructiveToolOwnedCommand (a shell command that would destroy or overwrite .registry/ or refs/references.bib)", () => {
  const destroys = [
    "rm -rf .registry",
    "rm -rf ./.registry",
    "cd /proj && rm -rf .registry && ls",
    "rmdir .registry",
    "mv .registry /tmp/old",
    "mv refs/references.bib /tmp/x.bib",
    "> refs/references.bib",
    ": > refs/references.bib",
    "echo '' >> refs/references.bib",
    "echo hi > .registry/notes",
    "printf x | tee refs/references.bib",
    "truncate -s 0 refs/references.bib",
    "sed -i 's/a/b/' refs/references.bib",
    "sed -i.bak 's/a/b/' refs/references.bib",
    "cp /tmp/mine.bib refs/references.bib",
    "find . -name '*.db' -path '*.registry*' -delete",
    "shred -u .registry/registry.db",
    "git clean -fdx .registry",
    "rm -f refs/references.bib",
  ];
  const harmless = [
    "cat refs/references.bib",
    "ls -la .registry",
    "grep -c '@article' refs/references.bib",
    "cp refs/references.bib /tmp/backup.bib",
    "head -5 refs/references.bib",
    "rm -rf build",
    "rm manuscript/old.tex",
    "echo done > notes.txt",
    "uktub-scholar sync-bib",
    "wc -l refs/references.bib && echo ok",
    "git status",
    "pdftotext papers/a.pdf -",
  ];
  for (const c of destroys) it(`flags: ${c}`, () => assert.match(destructiveToolOwnedCommand(c) ?? "", /\S/));
  for (const c of harmless) it(`allows: ${c}`, () => assert.equal(destructiveToolOwnedCommand(c), null));

  it("names what would be lost and how it is regenerated", () => {
    assert.match(destructiveToolOwnedCommand("rm -rf .registry") ?? "", /registry/i);
    assert.match(destructiveToolOwnedCommand("rm refs/references.bib") ?? "", /sync/i);
  });
});
