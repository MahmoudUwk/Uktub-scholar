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

test("refusal hints name the short public tools, never the legacy long names", () => {
  assert.match(REFUSALS.DOI_NOT_FOUND.next, /papers/);
  assert.match(REFUSALS.DOI_NOT_FOUND.next, /registry/);
  assert.match(REFUSALS.QUERY_REQUIRED.next, /papers requires/);
  assert.match(REFUSALS.VERIFY_ENGINE_MISSING.next, /passages/);
  for (const [code, entry] of [...Object.entries(REFUSALS), ...Object.entries(WARNINGS)]) {
    assert.doesNotMatch(entry.next, /search_papers|paper_registry|compile_document|verify_claim|search_passages/, `${code} still names a legacy tool`);
  }
});
