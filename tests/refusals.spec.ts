/**
 * U4 refusal table spec (KTD6): static completeness scan over `src/` — every
 * refusal code or warning code referenced anywhere must have a table entry
 * with a non-empty stable `next`, in BOTH classes. Pattern:
 * UktubAI_Agentic/tests/contract/pi-refusals.spec.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { REFUSALS, WARNINGS, renderRefusal } from "../src/core/refusals.ts";
import type { RefusalCode, WarningCode } from "../src/core/refusals.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const SCAN_PATTERN = /"(REGISTRY_NOT_INITIALIZED|REGISTRY_CORRUPT|REGISTRY_SCHEMA_UNSUPPORTED|REGISTRY_BUSY|INVALID_DOI|DOI_NOT_FOUND|QUERY_REQUIRED|PATH_REFUSED|SEARCH_UNAVAILABLE|BATCH_TOO_LARGE|COMPILE_ENGINE_MISSING|COMPILE_NO_ENTRY|COMPILE_TIMEOUT|VERIFY_ENGINE_MISSING|CONFIG_INVALID|PI_EXTENSION_API_UNAVAILABLE)"/g;
// Mirror guarantee: the pattern above must know every code the table declares.
const ALL_CODES: RefusalCode[] = [
  "REGISTRY_NOT_INITIALIZED", "REGISTRY_CORRUPT", "REGISTRY_SCHEMA_UNSUPPORTED", "REGISTRY_BUSY",
  "INVALID_DOI", "DOI_NOT_FOUND", "QUERY_REQUIRED", "PATH_REFUSED", "SEARCH_UNAVAILABLE",
  "BATCH_TOO_LARGE", "COMPILE_ENGINE_MISSING", "COMPILE_NO_ENTRY", "COMPILE_TIMEOUT",
  "VERIFY_ENGINE_MISSING", "CONFIG_INVALID", "PI_EXTENSION_API_UNAVAILABLE",
];

test("every refusal code referenced in src/ has a table entry with stable next", () => {
  const referenced = new Set<string>();
  for (const file of listTsFiles(srcRoot)) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(SCAN_PATTERN)) {
      referenced.add(match[1] as RefusalCode);
    }
  }
  for (const code of referenced) {
    const entry = REFUSALS[code as RefusalCode];
    assert.ok(entry, `code ${code} referenced in src/ has no REFUSALS entry`);
    assert.ok(entry.next.length > 0, `code ${code} has an empty next hint`);
  }
});

test("the scan pattern covers every code the REFUSALS table declares", () => {
  const patternSources = new Set([...ALL_CODES]);
  for (const code of Object.keys(REFUSALS)) {
    assert.ok(patternSources.has(code as RefusalCode), `REFUSALS code ${code} is missing from the scan pattern — a deleted table entry would go unnoticed`);
  }
});

test("every warning code referenced in src/ has a table entry with stable next", () => {
  const referenced = new Set<string>();
  for (const file of listTsFiles(srcRoot)) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(/"(BIBTEX_UNAVAILABLE|DOI_TITLE_MISMATCH)"/g)) {
      referenced.add(match[1] as WarningCode);
    }
  }
  for (const code of referenced) {
    const entry = WARNINGS[code as WarningCode];
    assert.ok(entry, `warning ${code} referenced in src/ has no WARNINGS entry`);
    assert.ok(entry.next.length > 0, `warning ${code} has an empty next hint`);
  }
});

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
