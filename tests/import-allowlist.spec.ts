import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Core stays host-independent: built-ins, internal modules, TypeBox, YAML, the
 * two document parsers (unpdf for PDF, fast-xml-parser for GROBID TEI) and `tar`
 * (safe extraction of the pinned llama.cpp release archive).
 * Only src/pi may import the Pi peer package.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const CORE_ALLOW_PREFIXES = ["node:", ".", "/", "typebox", "yaml", "unpdf", "fast-xml-parser", "tar"];
const CORE_DENY = ["@earendil-works"];

test("src/core imports nothing Pi-specific", () => {
  const coreDir = join(root, "core");
  for (const file of listTsFiles(coreDir)) {
    const src = readFileSync(file, "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) {
      for (const deny of CORE_DENY) {
        assert.ok(
          !spec.startsWith(deny),
          `${file} imports "${spec}" — src/core must not depend on host packages (KTD1)`,
        );
      }
      const allowed = CORE_ALLOW_PREFIXES.some((p) => spec.startsWith(p));
      assert.ok(allowed, `${file} imports "${spec}" — outside the core allowlist`);
    }
  }
});

test("src/pi is the only place importing the Pi peer package", () => {
  for (const dir of ["core", "cli"] as const) {
    for (const file of listTsFiles(join(root, dir))) {
      const src = readFileSync(file, "utf8");
      assert.ok(
        !src.includes("@earendil-works"),
        `${file} must not import the Pi package (KTD1: adapter is the only Pi consumer)`,
      );
    }
  }
  // src/pi must reference the peer (it is the adapter); its imports are
  // covered by the first test's deny scan being scoped to core.
  const piFiles = listTsFiles(join(root, "pi"));
  assert.ok(piFiles.length > 0, "src/pi exists");
});
