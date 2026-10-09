/**
 * Shared live-test environment: preflight, a staged consumer install of the package, a fresh disposable project, sandbox specs and
 * real stdio MCP sessions. Used by the acceptance runner (run.ts) and the user-simulation experiments (experiment.ts), so both
 * run the tested agent against the same boundary (sandbox.ts) and write evidence the same way.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallResult, Session } from "./cases.ts";
import { providerKeys } from "./keys.ts";
import { appendRedacted, redact, registerSecrets } from "./redact.ts";
import { dockerAvailable, INSIDE_PACKAGE, runSandboxed, sandboxCommand, stagePackage, writePiSettings, type SandboxSpec } from "./sandbox.ts";

export const IMAGE = "uktub-scholar-sandbox";
export const POLICY = {
  mcpCallTimeoutMs: 120000, // per-request idle timeout; progress heartbeats reset it
  mcpTotalTimeoutMs: 900000, // client policy: one tool call may take up to 15 minutes
  caseTimeoutMs: 1200000,
  retries: 0,
};

export interface Env {
  out: string;
  repo: string;
  project: string;
  /** Per-run Pi agent dir of the tested agent. */
  agentDir: string;
  gcpProject: string;
  passEnv: string[];
  runId: string;
  log(line: string): void;
  /** A sandbox spec; `over` swaps mounts (e.g. an empty project for the user simulator). */
  base(label: string, env?: Record<string, string>, over?: Partial<SandboxSpec>): SandboxSpec;
  openSession(label: string, env?: Record<string, string>): Promise<Session>;
  shell(script: string, timeoutMs?: number): { status: number | null; stdout: string; stderr: string };
  /** Provenance for the evidence: commit, working-tree digest, image, policy. */
  manifest(extra: Record<string, unknown>): Record<string, unknown>;
  sha(path: string): string;
}

const sh = (cmd: string, args: string[], cwd: string): string => spawnSync(cmd, args, { cwd, encoding: "utf8" }).stdout.trim();
const newest = (dir: string): number => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).reduce((m, e) => Math.max(m, statSync(join(e.parentPath, e.name)).mtimeMs), 0);

export function createEnv(out: string, opts: { corpus?: boolean; maxJudgments?: number; piSettings?: Record<string, unknown>; acquireOnRegister?: boolean } = {}): Env {
  if (existsSync(out)) throw new Error(`${out} exists; each run writes fresh evidence`);
  const repo = resolve(import.meta.dirname, "../..");
  const home = homedir();
  const runId = Date.now().toString(36);
  mkdirSync(out, { recursive: true });
  const logFile = join(out, "subscription.log");
  const log = (line: string): void => {
    const s = redact(`${new Date().toISOString()} ${line}`);
    console.log(s);
    appendFileSync(logFile, `${s}\n`);
  };

  // Preflight: no evidence from a stale build, a missing image or missing auth.
  if (newest(join(repo, "src")) > newest(join(repo, "dist"))) throw new Error("dist is older than src: run `pnpm build` first (the sandbox runs the packed dist)");
  const noImage = dockerAvailable(IMAGE);
  if (noImage !== undefined) throw new Error(`sandbox image missing (docker build -t ${IMAGE} -f docker/test-sandbox.Dockerfile .): ${noImage}`);
  if (spawnSync("gcloud", ["auth", "application-default", "print-access-token"], { encoding: "utf8" }).status !== 0) throw new Error("ADC is not usable (run: gcloud auth application-default login); not bypassing");
  const gcpProject = process.env.GOOGLE_CLOUD_PROJECT || sh("gcloud", ["config", "get-value", "project"], repo);
  if (!gcpProject) throw new Error("no GCP project for Vertex (GOOGLE_CLOUD_PROJECT or gcloud config)");
  // Provider keys: the shell first, then a gitignored `.env` in this repository (scripts/live/keys.ts); a run with none of them is keyless
  // and says so in its manifest.
  const dotenvFile = resolve(repo, ".env");
  const secretEnv = providerKeys(process.env, existsSync(dotenvFile) ? readFileSync(dotenvFile, "utf8") : null);
  const passEnv = Object.keys(secretEnv);
  // The tested agent can read its own environment, so every write below redacts the forwarded key values (CROSSREF_MAILTO is an address, not a credential).
  registerSecrets(Object.fromEntries(Object.entries(secretEnv).filter(([k]) => /KEY|TOKEN|SECRET/.test(k))));

  const consumer = stagePackage(repo, join(out, "stage"));
  const project = join(out, "project");
  for (const d of ["papers", "manuscript", "refs", "config"]) mkdirSync(join(project, d), { recursive: true });
  if (opts.corpus) {
    const corpus = resolve(repo, "test_papers/RF");
    for (const [src, dst] of [["2411.09996v1.pdf", "papers/2411.09996.pdf"], ["2511.15162v1.pdf", "papers/2511.15162.pdf"]] as const) {
      if (!existsSync(join(corpus, src))) throw new Error(`corpus PDF missing: ${join(corpus, src)}`);
      writeFileSync(join(project, dst), readFileSync(join(corpus, src)));
    }
  }
  if (opts.maxJudgments !== undefined) {
    // Harness policy (not the product default of 120): a binding per-call judgment budget so continuation is really exercised.
    writeFileSync(join(project, "config/chunking.yaml"), `chunking:\n  chunk_tokens: 512\n  overlap_tokens: 0\n  chars_per_token: 2.8\n  boundary: section\nverification:\n  engine: eos\n  min_confidence: 0.99\n  workers: 4\n  max_judgments: ${opts.maxJudgments}\n`);
  }
  const agentDir = join(out, "pi-agent");
  writePiSettings(agentDir, opts.piSettings);
  const runDir = join(out, "run");
  mkdirSync(runDir);

  let n = 0;
  const bench = join(home, ".cache/uktub-bench/decision2");
  const base: Env["base"] = (label, env = {}, over = {}) => ({
    image: IMAGE, name: `uktub-live-${runId}-${label}-${++n}`, stageDir: consumer, projectDir: project, agentDir, runDir,
    adcFile: join(home, ".config/gcloud/application_default_credentials.json"),
    tectonicCache: join(home, ".cache/Tectonic"), uktubCache: join(home, ".cache/uktub-scholar"),
    eos: { venv: join(bench, "venv"), pythonStore: resolve(sh("readlink", [join(bench, "venv/bin/python")], repo), "../../.."), model: join(bench, "models/eos") },
    // The registration hook (background acquisition) is off for a session that needs deterministic source states; a case that tests the hook opens its own session with it on.
    env: { GOOGLE_CLOUD_PROJECT: gcpProject, ...(opts.acquireOnRegister === false ? { UKTUB_ACQUIRE_ON_REGISTER: "0" } : {}), ...env },
    // An explicit per-session env value overrides a forwarded secret of the same name (e.g. a deliberately invalid key to force a provider failure).
    secretEnv: Object.fromEntries(Object.entries(secretEnv).filter(([k]) => !(k in env))),
    ...over,
  });

  const init = runSandboxed(base("init"), ["node", `${INSIDE_PACKAGE}/bin/uktub-scholar.js`, "init"]);
  if (init.status !== 0) throw new Error(`project init failed: ${init.stderr}${init.stdout}`);

  const callLog = join(out, "mcp-calls.jsonl");
  const openSession: Env["openSession"] = async (label, env = {}) => {
    const spec = base(`mcp-${label}`, env);
    const { command, args, env: clientEnv } = sandboxCommand(spec, ["node", `${INSIDE_PACKAGE}/bin/uktub-scholar.js`, "mcp"]);
    const transport = new StdioClientTransport({ command, args, env: clientEnv, stderr: "pipe" });
    transport.stderr?.on("data", (d) => appendRedacted(join(out, `mcp-${label}-stderr.log`), String(d)));
    const client = new Client({ name: "uktub-live-acceptance", version: "1" });
    await client.connect(transport);
    log(`MCP SESSION ${label} up (${spec.name})`);
    return {
      async call(name, a, o) {
        const started = Date.now();
        log(`MCP START [${label}] ${name} ${JSON.stringify(a).slice(0, 240)}`);
        const result = (await client.callTool({ name, arguments: a }, undefined, {
          timeout: POLICY.mcpCallTimeoutMs, resetTimeoutOnProgress: true, maxTotalTimeout: POLICY.mcpTotalTimeoutMs, signal: o?.signal,
          onprogress: (p) => log(`MCP PROGRESS [${label}] ${p.message ?? `${p.progress}/${p.total}`}`),
        })) as CallResult;
        appendRedacted(callLog, `${JSON.stringify({ session: label, name, args: a, elapsedMs: Date.now() - started, result })}\n`);
        log(`MCP END [${label}] ${name} error=${!!result.isError} ${Date.now() - started}ms`);
        return result;
      },
      close: () => client.close(),
    };
  };

  const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
  return {
    out, repo, project, agentDir, gcpProject, passEnv, runId, log, base, openSession, sha,
    shell: (script, timeoutMs) => {
      const r = runSandboxed(base("sh"), ["sh", "-c", script], timeoutMs ?? 120000);
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    manifest: (extra) => ({
      commit: sh("git", ["rev-parse", "HEAD"], repo),
      workingTreeDiffSha256: createHash("sha256").update(sh("git", ["diff", "HEAD"], repo)).digest("hex"),
      untracked: sh("git", ["ls-files", "--others", "--exclude-standard"], repo).split("\n").filter(Boolean),
      image: sh("docker", ["image", "inspect", IMAGE, "--format", "{{.Id}}"], repo),
      docker: sh("docker", ["--version"], repo),
      node: process.version,
      sandboxSha256: sha(join(import.meta.dirname, "sandbox.ts")),
      engineDevice: "cpu (no NVIDIA container runtime on this host)",
      providerKeysPassed: passEnv, // names only, never values
      policy: POLICY,
      startedAt: new Date().toISOString(),
      ...extra,
    }),
  };
}
