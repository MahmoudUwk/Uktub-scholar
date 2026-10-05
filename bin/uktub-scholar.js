#!/usr/bin/env node
// Bin shim for the uktub-scholar CLI. Zero runtime dependencies: only node built-ins.
// An installed package ships compiled JavaScript in dist/ (Node cannot type-strip files under node_modules), run in-process.
// A source checkout has no dist/: run the TypeScript natively (Node >= 23.6 strips types; 22.x needs --experimental-strip-types).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const compiled = join(root, "dist", "cli", "main.js");
// A checkout has src/ and may carry a stale dist/: run the code being edited. An installed package ships no src/.
const isCheckout = existsSync(join(root, "src", "cli", "main.ts"));

if (!isCheckout && existsSync(compiled)) {
  const { main } = await import(pathToFileURL(compiled).href);
  await main(args);
} else {
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1] ?? 0);
  const mainTs = join(root, "src", "cli", "main.ts");
  const needsFlag = major < 23 || (major === 23 && minor < 6);
  const result = spawnSync(process.execPath, [...(needsFlag ? ["--experimental-strip-types"] : []), mainTs, ...args], { stdio: "inherit" });
  if (result.error) {
    console.error(`uktub-scholar: failed to start: ${result.error.message}`);
    process.exitCode = 1;
  } else if (typeof result.status === "number") {
    process.exitCode = result.status;
  } else {
    // status === null: the child died to a signal — never report success.
    process.exitCode = 1;
  }
}
