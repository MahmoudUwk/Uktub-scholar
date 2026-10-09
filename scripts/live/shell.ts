/**
 * Interactive Pi in the sandbox (`pnpm sandbox`): a fresh Pi that already has this package, Vertex AI (user-minted ADC, read-only) and
 * the Eos engine, behind the same boundary as the live acceptance runs (sandbox.ts). The host's own Pi (~/.pi) is never read or written.
 * State lives in two directories in the repository, `.sandbox/{project,pi-agent}` (gitignored): the project (registry, papers,
 * manuscript) and Pi's sessions. Provider keys come from the shell or a gitignored `.env` (keys.ts).
 *
 *   pnpm sandbox [--fresh] [--model <Vertex model id>] [-- <more pi arguments>]
 *
 * `--fresh` deletes the two directories first. The default model is the one live acceptance uses; the provider is always Vertex.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEnv } from "./env.ts";
import { INSIDE_PACKAGE, runInteractive, runSandboxed, writePiSettings } from "./sandbox.ts";

const DEFAULT_MODEL = "gemini-3.8-flash";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const own = split === -1 ? argv : argv.slice(0, split);
const piArgs = split === -1 ? [] : argv.slice(split + 1);
const modelAt = own.indexOf("--model");
const model = modelAt === -1 ? DEFAULT_MODEL : own[modelAt + 1];
if (model === undefined || model.startsWith("-")) throw new Error("--model needs a Vertex model id");

const data = resolve(import.meta.dirname, "../../.sandbox");
const project = join(data, "project");
const agentDir = join(data, "pi-agent");
if (own.includes("--fresh")) for (const d of [project, agentDir]) rmSync(d, { recursive: true, force: true });
mkdirSync(project, { recursive: true });

// The evidence directory of a live run is scratch here: the staged install and the engine logs go away with the session.
const scratch = mkdtempSync(join(tmpdir(), "uktub-shell-"));
let status: number | null = 1;
try {
  const env = createEnv(join(scratch, "run"));
  // Pi retries a stalled or rate-limited Vertex call here (the acceptance runs turn it off so a provider failure stays visible).
  writePiSettings(agentDir, { retry: { enabled: true }, defaultProvider: "google-vertex", defaultModel: model });
  const spec = env.base("shell", { TERM: process.env.TERM ?? "xterm-256color" }, { projectDir: project, agentDir });
  if (!existsSync(join(project, ".registry/registry.db"))) {
    const init = runSandboxed(spec, ["node", `${INSIDE_PACKAGE}/bin/uktub-scholar.js`, "init"]);
    if (init.status !== 0) throw new Error(`project init failed: ${init.stderr}${init.stdout}`);
  }
  console.log(`sandbox Pi: google-vertex/${model}, project ${project}, keys forwarded: ${env.passEnv.join(", ") || "none (keyless providers)"}`);
  status = await runInteractive(spec, ["pi", "--provider", "google-vertex", "--model", model, ...piArgs]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(status ?? 1);
