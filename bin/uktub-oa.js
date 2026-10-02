#!/usr/bin/env node
// Bin shim for the uktub-oa CLI.
// The CLI source is TypeScript (src/cli/main.ts). Node >= 23.6 runs type-stripped
// TypeScript natively; Node 22.x (the Pi floor) needs --experimental-strip-types.
// Zero runtime dependencies: the shim uses only node built-ins.
import { spawnSync } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const major = Number(process.versions.node.split(".")[0]);
const minor = Number(process.versions.node.split(".")[1] ?? 0);
const args = process.argv.slice(2);
const mainTs = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");

const needsFlag = major < 23 || (major === 23 && minor < 6);
const result = needsFlag
  ? spawnSync(process.execPath, ["--experimental-strip-types", mainTs, ...args], { stdio: "inherit" })
  : spawnSync(process.execPath, [mainTs, ...args], { stdio: "inherit" });

if (result.error) {
  console.error(`uktub-oa: failed to start: ${result.error.message}`);
  process.exitCode = 1;
} else if (typeof result.status === "number") {
  process.exitCode = result.status;
}
