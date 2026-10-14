/** Bundle the page-side modules with the repo's own esbuild (no new install). */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const esbuild =
  process.env.ESBUILD_BIN ??
  join(root, "node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild");
if (!existsSync(esbuild)) {
  console.error(`esbuild not found at ${esbuild}; set ESBUILD_BIN`);
  process.exit(1);
}
const out = join(root, "tests-browser-net", "dist-page");
const stub = join(root, "tests-browser-net", "stubs", "node-crypto.js");

const bundle = (entry: string, outfile: string): void =>
  execFileSync(esbuild, [join(root, entry), "--bundle", "--format=esm", `--outfile=${join(out, outfile)}`, `--alias:node:crypto=${stub}`, "--log-level=warning"], {
    stdio: "inherit",
  });

bundle("src/browser/download.ts", "download.bundle.js");
bundle("src/browser/provider-fetch.ts", "provider-fetch.bundle.js");
bundle("src/core/source/arxiv.ts", "arxiv.bundle.js");
console.log(`page bundles written to ${out}`);
