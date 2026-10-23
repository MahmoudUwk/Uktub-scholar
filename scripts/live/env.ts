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
import { GRADER_KEY_NAMES, providerKeys } from "./keys.ts";
import { captureStagedProvenance, type StagedProvenance } from "./provenance.ts";
import { appendRedacted, redact, registerSecrets } from "./redact.ts";
import { dockerAvailable, INSIDE_PACKAGE, runSandboxed, sandboxCommand, stagePackage, writePiSettings, type SandboxSpec } from "./sandbox.ts";

export const IMAGE = "uktub-scholar-sandbox";
export const POLICY = {
  mcpCallTimeoutMs: 120000, // per-request idle timeout; progress heartbeats reset it
  mcpTotalTimeoutMs: 900000, // client policy: one tool call may take up to 15 minutes
  caseTimeoutMs: 1200000,
  retries: 0,
};

/** Assistant-sandbox env for `--verify-engine` (default `eos` sets nothing: the product default stands). */
/** A harness engine choice that runs the product's hosted engine (its free key must be forwarded). */
export function usesHostedEngine(name: string): boolean {
  return verifyEngineEnv(name).UKTUB_VERIFY_ENGINE === "hosted";
}

export function verifyEngineEnv(name: string): Record<string, string> {
  if (name === "eos") return {};
  // The product's own `hosted` engine (d3-mini, src/core/verify/engines.ts): no URL or model duplicated here.
  if (name === "hosted") return { UKTUB_VERIFY_ENGINE: "hosted" };
  // Harness arg (not a product knob): the hosted engine on the whole-section unit path (UKTUB_VERIFY_STRATEGY=units).
  if (name === "hosted-units") return { UKTUB_VERIFY_ENGINE: "hosted", UKTUB_VERIFY_STRATEGY: "units" };
  throw new Error(`--verify-engine must be eos|hosted|hosted-units, got ${JSON.stringify(name)}`);
}

/**
 * Secrets an assistant sandbox needs beyond the provider keys: `OPENCODE_API_KEY`
 * when the assistant runs on opencode-go (otherwise the assistant gets nothing extra).
 * A missing key is a clear error, never a silent keyless run or a model substitution.
 */
export function assistantSecretsForProvider(provider: string, lookup: (name: string) => string | undefined): Record<string, string> {
  if (provider !== "opencode-go") return {};
  const key = lookup("OPENCODE_API_KEY");
  if (!key) throw new Error("BLOCKED: no OPENCODE_API_KEY for an opencode-go assistant (shell or .env); not substituting a model");
  return { OPENCODE_API_KEY: key };
}

/** Per-run assistant secrets ride with the forwarded provider secrets; an explicit value wins. */
export function mergeAssistantSecrets(base: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  return { ...base, ...extra };
}

export interface Env {
  out: string;
  repo: string;
  project: string;
  /** Per-run Pi agent dir of the tested agent. */
  agentDir: string;
  gcpProject: string;
  passEnv: string[];
  /** Names of the grader-only keys (never forwarded to the assistant's sandbox). */
  graderPassEnv: string[];
  /** When the ADC preflight check below ran (ISO timestamp, recorded in the manifest). */
  adcCheckedAt: string;
  runId: string;
  log(line: string): void;
  /** A sandbox spec; `over` swaps mounts (e.g. an empty project for the user simulator). `opts.grader` adds the grader-only keys: assistant specs never get them. */
  base(label: string, env?: Record<string, string>, over?: Partial<SandboxSpec>, opts?: { grader?: boolean }): SandboxSpec;
  openSession(label: string, env?: Record<string, string>): Promise<Session>;
  shell(script: string, timeoutMs?: number): { status: number | null; stdout: string; stderr: string };
  /** Provenance for the evidence: commit, working-tree digest, image, policy. */
  manifest(extra: Record<string, unknown>): Record<string, unknown>;
  sha(path: string): string;
}

const sh = (cmd: string, args: string[], cwd: string): string => spawnSync(cmd, args, { cwd, encoding: "utf8" }).stdout.trim();
const newest = (dir: string): number => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).reduce((m, e) => Math.max(m, statSync(join(e.parentPath, e.name)).mtimeMs), 0);

export function createEnv(out: string, opts: { corpus?: boolean; maxJudgments?: number; piSettings?: Record<string, unknown>; acquireOnRegister?: boolean; assistantSecrets?: Record<string, string> } = {}): Env {
  out = resolve(out);
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
  const adcCheckedAt = new Date().toISOString();
  const gcpProject = process.env.GOOGLE_CLOUD_PROJECT || sh("gcloud", ["config", "get-value", "project"], repo);
  if (!gcpProject) throw new Error("no GCP project for Vertex (GOOGLE_CLOUD_PROJECT or gcloud config)");
  // Provider keys: the shell first, then a gitignored `.env` in this repository (scripts/live/keys.ts); a run with none of them is keyless
  // and says so in its manifest.
  const dotenvFile = resolve(repo, ".env");
  const dotenvText = existsSync(dotenvFile) ? readFileSync(dotenvFile, "utf8") : null;
  const secretEnv = providerKeys(process.env, dotenvText);
  const passEnv = Object.keys(secretEnv);
  // Grader keys (the owner's OpenCode Go key): read through the same mechanism but kept separate —
  // never in passEnv/secretEnv, so the assistant's sandbox never receives them. Only specs built
  // with base(..., { grader: true }) forward them, to grader sessions.
  const graderSecretEnv = providerKeys(process.env, dotenvText, GRADER_KEY_NAMES);
  const graderPassEnv = Object.keys(graderSecretEnv);
  // The tested agent can read its own environment, so every write below redacts the forwarded key values (CROSSREF_MAILTO is an address, not a credential).
  registerSecrets(Object.fromEntries(Object.entries(secretEnv).filter(([k]) => /KEY|TOKEN|SECRET/.test(k))));
  registerSecrets(Object.fromEntries(Object.entries(graderSecretEnv).filter(([k]) => /KEY|TOKEN|SECRET/.test(k))));
  // Per-run assistant secrets (hosted verify key, opencode-go assistant key): redacted like the provider keys.
  const assistantSecrets = opts.assistantSecrets ?? {};
  registerSecrets(Object.fromEntries(Object.entries(assistantSecrets).filter(([k]) => /KEY|TOKEN|SECRET/.test(k))));

  const stageDir = join(out, "stage");
  const consumer = stagePackage(repo, stageDir);
  // Provenance is captured once here, at staging/start — never recomputed at report time, so the record identifies
  // the bytes the run actually used.
  // stageDir is the stage root (tar/ + consumer/): the tarball hash lives in stage/tar, not in the consumer subdir.
  const staged: StagedProvenance = captureStagedProvenance(repo, stageDir);
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
  const base: Env["base"] = (label, env = {}, over = {}, flags = {}) => ({
    image: IMAGE, name: `uktub-live-${runId}-${label}-${++n}`, stageDir: consumer, projectDir: project, agentDir, runDir,
    adcFile: join(home, ".config/gcloud/application_default_credentials.json"),
    tectonicCache: join(home, ".cache/Tectonic"), uktubCache: join(home, ".cache/uktub-scholar"),
    eos: { venv: join(bench, "venv"), pythonStore: resolve(sh("readlink", [join(bench, "venv/bin/python")], repo), "../../.."), model: join(bench, "models/eos") },
    // The registration hook (background acquisition) is off for a session that needs deterministic source states; a case that tests the hook opens its own session with it on.
    env: { GOOGLE_CLOUD_PROJECT: gcpProject, ...(opts.acquireOnRegister === false ? { UKTUB_ACQUIRE_ON_REGISTER: "0" } : {}), ...env },
    // An explicit per-session env value overrides a forwarded secret of the same name (e.g. a deliberately invalid key to force a provider failure).
    // Grader-only keys ride along only when flags.grader is set (grader sessions); the assistant's specs never carry them.
    // Per-run assistant secrets (hosted verify key, opencode-go assistant key) ride with every non-grader spec.
    secretEnv: {
      ...Object.fromEntries(Object.entries(mergeAssistantSecrets(secretEnv, assistantSecrets)).filter(([k]) => !(k in env))),
      ...(flags.grader === true ? Object.fromEntries(Object.entries(graderSecretEnv).filter(([k]) => !(k in env))) : {}),
    },
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
    out, repo, project, agentDir, gcpProject, passEnv, graderPassEnv, adcCheckedAt, runId, log, base, openSession, sha,
    shell: (script, timeoutMs) => {
      const r = runSandboxed(base("sh"), ["sh", "-c", script], timeoutMs ?? 120000);
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    manifest: (extra) => ({
      commit: staged.commit,
      workingTreeDiffSha256: staged.workingTreeDiffSha256,
      untracked: staged.untracked,
      untrackedSha256: staged.untrackedSha256,
      packageHash: staged.packageHash,
      image: sh("docker", ["image", "inspect", IMAGE, "--format", "{{.Id}}"], repo),
      docker: sh("docker", ["--version"], repo),
      node: process.version,
      sandboxSha256: sha(join(import.meta.dirname, "sandbox.ts")),
      engineDevice: "cpu (no NVIDIA container runtime on this host)",
      providerKeysPassed: passEnv, // names only, never values
      graderKeysPassed: graderPassEnv, // names only, never values; forwarded only to grader sessions
      policy: POLICY,
      startedAt: staged.capturedAt,
      ...extra,
    }),
  };
}
