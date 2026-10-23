/**
 * Phase 9a item 2: the acceptance seams (`window.__uktub`,
 * `window.__uktubAgent`) exist only when the build sets
 * `VITE_UKTUB_ACCEPTANCE_SEAMS=1`.
 *
 * Mechanism test (no bundle): each seam assignment lives in a branch gated
 * on the flag, so when the flag is statically absent the minifier drops the
 * branch — including the seam name. The real `dist/` proof (production
 * bundle clean, flagged bundle carrying the seams) is re-verified by the
 * acceptance run, which greps both bundles.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { transform } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "..");
const FILES = [
  "web/src/services/UktubProjectService.ts",
  "web/src/components/agent/AgentPanel.tsx",
];

async function minified(rel: string, seamsOn: boolean): Promise<string> {
  const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const out = await transform(source, {
    loader: "tsx",
    format: "esm",
    minify: true,
    // What the build does with the flag: statically present ("1") or
    // statically absent (undefined), so dead branches fold.
    define: { "import.meta.env.VITE_UKTUB_ACCEPTANCE_SEAMS": seamsOn ? '"1"' : "undefined" },
  });
  return out.code;
}

for (const rel of FILES) {
  test(`seam gating: ${rel} drops seam names when the flag is absent`, async () => {
    const code = await minified(rel, false);
    assert.doesNotMatch(code, /__uktub/, `${rel} production-shaped output still names a seam`);
  });

  test(`seam gating: ${rel} keeps seam names when the flag is set`, async () => {
    const code = await minified(rel, true);
    assert.match(code, /__uktub/, `${rel} flagged output lost the seam`);
  });
}

test("seam gating: source gates name the explicit flag", () => {
  for (const rel of FILES) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(
      source,
      /import\.meta\.env\.VITE_UKTUB_ACCEPTANCE_SEAMS === '1'/,
      `${rel} seam is not gated on the explicit flag`,
    );
  }
});
