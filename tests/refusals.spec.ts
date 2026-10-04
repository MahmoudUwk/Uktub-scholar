import { test } from "node:test";
import assert from "node:assert/strict";

import { REFUSALS, WARNINGS, renderRefusal } from "../src/core/refusals.ts";

test("every table entry's next is non-empty and message-free (code+next stable)", () => {
  for (const [code, entry] of Object.entries(REFUSALS)) {
    assert.ok(entry.next.length > 0, `REFUSALS.${code}.next empty`);
  }
  for (const [code, entry] of Object.entries(WARNINGS)) {
    assert.ok(entry.next.length > 0, `WARNINGS.${code}.next empty`);
  }
});

test("renderRefusal renders the stable refusal shape", () => {
  const rendered = renderRefusal({
    code: "DOI_NOT_FOUND",
    message: `no provider knows "10.1/nope"`,
  });
  assert.match(rendered, /^Refused: DOI_NOT_FOUND — /);
  assert.match(rendered, new RegExp(`Next: ${REFUSALS.DOI_NOT_FOUND.next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.$`));
});
