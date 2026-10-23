import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// Launcher: reads the two research keys from the repo .env into the process
// environment and spawns roundtrip-ui.mjs. Keys are never printed, logged or
// written anywhere. Run from the repo root: `node web/e2e/run-roundtrip-ui.mjs`.
const ROOT = new URL("../../", import.meta.url).pathname;
const WANT = ["OPENALEX_API_KEY", "SEMANTIC_SCHOLAR_API_KEY"];
const envSrc = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
const env = { ...process.env };
for (const name of WANT) {
  const line = envSrc.split("\n").find((l) => l.startsWith(`${name}=`));
  const val = (line ?? "").slice(name.length + 1).trim().replace(/^[\"']|[\"']$/g, "");
  if (!val) throw new Error(`missing ${name} in .env`);
  env[name] = val;
}
const child = spawn(process.execPath, [new URL("./roundtrip-ui.mjs", import.meta.url).pathname], {
  env, stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
