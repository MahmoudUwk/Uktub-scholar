/**
 * Evaluation isolation for live acceptance runs: Pi's documented "plain Docker" method (whole Pi process in a container, see
 * Pi docs/containerization.md), using the repo's existing `uktub-scholar-sandbox` image (Pi + Tectonic). Dev tooling, not a
 * product feature; normal host Pi stays supported.
 *
 * The tested Pi sees a consumer-style install of the package (what `pnpm pack` ships plus production dependencies — no src,
 * tests, docs, scripts or benchmarks), one disposable project, a per-run Pi agent dir, read-only ADC, and the read-only engine
 * pieces it needs. The controller, graders, expected answers, earlier results, the repository and the host home are not mounted.
 *
 * Known limits (the boundary probe reports them): the ADC file is readable by the agent; the network is open (Vertex and the
 * scholarly APIs need it); this host has no NVIDIA container runtime, so the Eos engine runs on CPU (~0.8 s per judgment).
 */
import { type ChildProcess, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Paths inside the container (fixed, so evidence reads the same on every run). */
export const INSIDE = {
  home: "/home/eval",
  project: "/work/project",
  agentDir: "/pi-agent",
  cache: "/cache",
  adc: "/adc/adc.json",
  /** The consumer install root; the package itself is `${stage}/node_modules/uktub-scholar`. */
  stage: "/opt/stage",
} as const;

export const INSIDE_PACKAGE = `${INSIDE.stage}/node_modules/uktub-scholar`;

export interface SandboxSpec {
  image: string;
  /** Container name, so a stuck run can be stopped by name. */
  name: string;
  /** Consumer-style install root made by `stagePackage` (mounted read-only at INSIDE.stage). */
  stageDir: string;
  /** Disposable project (read-write at INSIDE.project, the working directory). */
  projectDir: string;
  /** Per-run Pi agent dir (read-write at INSIDE.agentDir). */
  agentDir: string;
  /** Per-run evidence directory for llama-server logs and the Tectonic cache copy (read-write). */
  runDir: string;
  /** Host ADC file (read-only). */
  adcFile: string;
  /** Host Tectonic bundle cache; copied into runDir so the host cache is never written. */
  tectonicCache: string;
  /** Host uktub-scholar cache; only `runtime` and `models` are mounted, read-only. */
  uktubCache: string;
  /** Eos engine: venv, the uv-managed interpreter store its python symlinks into (alias dirs included), and the model snapshot (read-only, same paths). */
  eos: { venv: string; pythonStore: string; model: string };
  /** Environment for the process; the container receives nothing else from the host. */
  env: Record<string, string>;
  /**
   * Secrets (provider API keys). Passed by name only (`docker run -e NAME`, the value travels in the docker client's environment), so they
   * never appear in an argv, a log or a manifest. The agent inside can still read its own environment (a documented exposure, like the ADC file).
   */
  secretEnv?: Record<string, string>;
  /** Interactive session: the container gets a terminal (`-t`). Everything else is pipe-only. */
  tty?: boolean;
}

const run = (cmd: string, args: string[], cwd: string): string => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr.trim().slice(0, 400)}`);
  return r.stdout;
};

/**
 * Consumer-style install: `pnpm pack` (the package `files` allowlist) installed as a dependency of an empty project, the way
 * a user installs it, so peers resolve and nothing outside the shipped files is present. Requires a fresh `pnpm build`.
 */
export function stagePackage(repo: string, dest: string): string {
  if (existsSync(dest)) throw new Error(`stage dir ${dest} exists; each run stages fresh`);
  const tar = join(dest, "tar");
  mkdirSync(tar, { recursive: true });
  run("pnpm", ["pack", "--pack-destination", tar], repo);
  const tgz = join(tar, readdirSync(tar).find((f) => f.endsWith(".tgz")) ?? "");
  const consumer = join(dest, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "stage", private: true }));
  run("pnpm", ["add", tgz, "--offline", "--ignore-scripts"], consumer);
  return consumer;
}

/** The `docker run` argv (after `docker`) that runs `command` inside the boundary. */
function dockerArgs(spec: SandboxSpec, command: string[]): string[] {
  const cacheCopy = join(spec.runDir, "tectonic-cache");
  if (!existsSync(cacheCopy)) cpSync(spec.tectonicCache, cacheCopy, { recursive: true });
  const logs = join(spec.runDir, "engine-logs");
  mkdirSync(logs, { recursive: true });
  const uid = process.getuid?.() ?? 1000;
  const env: Record<string, string> = {
    HOME: INSIDE.home,
    PI_CODING_AGENT_DIR: INSIDE.agentDir,
    GOOGLE_APPLICATION_CREDENTIALS: INSIDE.adc,
    UKTUB_CACHE_DIR: INSIDE.cache,
    UKTUB_EOS_PYTHON: `${spec.eos.venv}/bin/python`,
    UKTUB_EOS_MODEL: spec.eos.model,
    ...spec.env,
  };
  const ro = (host: string, inside: string) => ["-v", `${host}:${inside}:ro`];
  return [
    "run", "--rm", spec.tty ? "-it" : "-i", "--init", "--name", spec.name,
    "--user", `${uid}:${process.getgid?.() ?? 1000}`,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
    "--tmpfs", "/tmp", "--tmpfs", `${INSIDE.home}:uid=${uid}`, "--tmpfs", `${INSIDE.home}/.cache:uid=${uid}`, "--tmpfs", `${INSIDE.cache}:uid=${uid}`,
    "--entrypoint", "",
    "-w", INSIDE.project,
    ...ro(spec.stageDir, INSIDE.stage),
    ...ro(spec.adcFile, INSIDE.adc),
    ...ro(join(spec.uktubCache, "runtime"), `${INSIDE.cache}/runtime`),
    ...ro(join(spec.uktubCache, "models"), `${INSIDE.cache}/models`),
    ...ro(spec.eos.venv, spec.eos.venv), ...ro(spec.eos.pythonStore, spec.eos.pythonStore), ...ro(spec.eos.model, spec.eos.model),
    "-v", `${logs}:${INSIDE.cache}/logs`,
    "-v", `${cacheCopy}:${INSIDE.home}/.cache/Tectonic`,
    "-v", `${spec.agentDir}:${INSIDE.agentDir}`,
    "-v", `${spec.projectDir}:${INSIDE.project}`,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...Object.keys(spec.secretEnv ?? {}).flatMap((k) => ["-e", k]),
    spec.image, ...command,
  ];
}

/** The `docker` invocation for `command`, for a host that spawns the process itself (an MCP stdio transport). */
export const sandboxCommand = (spec: SandboxSpec, command: string[]): { command: string; args: string[]; env: Record<string, string> } => ({ command: "docker", args: dockerArgs(spec, command), env: clientEnv(spec) });

/** The docker client's own environment: the host's plus the secrets it forwards by name. */
const clientEnv = (spec: SandboxSpec): Record<string, string> => ({ ...(process.env as Record<string, string>), ...(spec.secretEnv ?? {}) });

/** Run `command` to completion inside the boundary (probes, tool checks). */
export function runSandboxed(spec: SandboxSpec, command: string[], timeoutMs = 120000): SpawnSyncReturns<string> {
  return spawnSync("docker", dockerArgs(spec, command), { encoding: "utf8", timeout: timeoutMs, env: clientEnv(spec) });
}

/** Start `command` inside the boundary with piped stdio (the Pi RPC process). */
export function spawnSandboxed(spec: SandboxSpec, command: string[]): ChildProcess {
  return spawn("docker", dockerArgs(spec, command), { stdio: ["pipe", "pipe", "pipe"], env: clientEnv(spec) });
}

/** Hand the terminal to `command` inside the boundary (the interactive Pi); resolves with its exit status. Termination signals go to the container. */
export function runInteractive(spec: SandboxSpec, command: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", dockerArgs({ ...spec, tty: true }, command), { stdio: "inherit", env: clientEnv(spec) });
    const forward = (signal: NodeJS.Signals): boolean => child.kill(signal);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, forward);
    child.on("error", reject);
    child.on("close", resolve);
  });
}

/**
 * Custom Pi models the harness adds (models.json, Pi 1.3 schema: `providers.<id>.models[]`). Owner decision 2026-10-19: MiniMax M3.1
 * Flash Free on OpenCode Go is the assistant option and grader B. Source: OpenCode's live model list
 * (GET https://opencode.ai/zen/go/v1/models) includes `minimax-m3.1-flash-free`; Pi 1.3.0's static catalog does not.
 * Free tier: cost 0 (label only: the price is not in the live list). API type, baseUrl, reasoning and input types are copied
 * from Pi's catalog entry `minimax-m3` on opencode-go. contextWindow/maxTokens are ASSUMED equal to minimax-m3 (1000000 / 131072):
 * not published in the live list. No apiKey here: the key comes from OPENCODE_API_KEY in the sandbox environment.
 */
export const PI_CUSTOM_MODELS = {
  providers: {
    "opencode-go": {
      models: [
        {
          id: "minimax-m3.1-flash-free",
          name: "MiniMax M3.1 Flash Free",
          api: "anthropic-messages",
          baseUrl: "https://opencode.ai/inference/go",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000000,
          maxTokens: 131072,
        },
      ],
    },
  },
};

/** Write the harness's custom models.json into an agent dir (every Pi agent dir the harness creates gets one). */
export function writePiModels(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(PI_CUSTOM_MODELS, null, 2));
}

/** Write the per-run Pi settings: only the staged package (by its in-container path), no retry (a retry would hide a provider failure). */
export function writePiSettings(agentDir: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [INSIDE_PACKAGE], retry: { enabled: false }, ...extra }, null, 2));
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writePiModels(agentDir);
}

/** Docker and the sandbox image must exist before any run relies on them. */
export function dockerAvailable(image: string): string | undefined {
  const r = spawnSync("docker", ["image", "inspect", image], { encoding: "utf8" });
  return r.status === 0 ? undefined : (r.stderr || String(r.error)).trim();
}

/**
 * Grader isolation (PLAN.md rev 3, section 4.6): a grading session sees the note export and the frozen
 * corpus read-only, one writable output dir, its Pi agent dir and ADC — nothing else (no run logs, no
 * evidence dirs, no product statuses, no consumer stage, no engine mounts). Secrets travel by name only
 * (`-e NAME`, value in the docker client's environment), exactly like SandboxSpec.secretEnv.
 */
export const GRADER_INSIDE = {
  home: "/home/eval",
  note: "/work/note",
  corpus: "/work/corpus",
  out: "/work/out",
  agentDir: "/pi-agent",
  adc: "/adc/adc.json",
} as const;

export interface GraderSandboxSpec {
  image: string;
  /** Container name, so a stuck grading session can be stopped by name. */
  name: string;
  /** Note export directory (mounted read-only at /work/note). */
  noteDir: string;
  /** Frozen corpus directory (mounted read-only at /work/corpus). */
  corpusDir: string;
  /** Session output directory (writable at /work/out, the working directory). */
  outDir: string;
  /** Per-session Pi agent dir (writable at /pi-agent). */
  agentDir: string;
  /**
   * Host ADC file (read-only). Optional: only grader B (Vertex) needs it; Muse
   * grader/adjudicator sessions omit it and get no ADC mount or credential env.
   */
  adcFile?: string;
  /** Environment for the process; the container receives nothing else from the host. */
  env: Record<string, string>;
  /**
   * Grader-only secrets (OPENCODE_API_KEY). Passed by name only, so values never appear in an argv,
   * a log or a manifest. Provider keys (Semantic Scholar/OpenAlex/Crossref) must never be here:
   * build the value with grade-lib.graderSecretsOnly.
   */
  secretEnv?: Record<string, string>;
}

/** The `docker run` argv (after `docker`) that runs `command` inside the grader boundary. */
export function graderDockerArgs(spec: GraderSandboxSpec, command: string[]): string[] {
  const uid = process.getuid?.() ?? 1000;
  const env: Record<string, string> = {
    HOME: GRADER_INSIDE.home,
    PI_CODING_AGENT_DIR: GRADER_INSIDE.agentDir,
    ...(spec.adcFile !== undefined ? { GOOGLE_APPLICATION_CREDENTIALS: GRADER_INSIDE.adc } : {}),
    ...spec.env,
  };
  return [
    "run", "--rm", "-i", "--init", "--name", spec.name,
    "--user", `${uid}:${process.getgid?.() ?? 1000}`,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
    "--tmpfs", "/tmp", "--tmpfs", `${GRADER_INSIDE.home}:uid=${uid}`, "--tmpfs", `${GRADER_INSIDE.home}/.cache:uid=${uid}`,
    "--entrypoint", "",
    "-w", GRADER_INSIDE.out,
    "-v", `${spec.noteDir}:${GRADER_INSIDE.note}:ro`,
    "-v", `${spec.corpusDir}:${GRADER_INSIDE.corpus}:ro`,
    "-v", `${spec.outDir}:${GRADER_INSIDE.out}`,
    "-v", `${spec.agentDir}:${GRADER_INSIDE.agentDir}`,
    ...(spec.adcFile !== undefined ? ["-v", `${spec.adcFile}:${GRADER_INSIDE.adc}:ro`] : []),
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...Object.keys(spec.secretEnv ?? {}).flatMap((k) => ["-e", k]),
    spec.image, ...command,
  ];
}

/** The `docker` invocation for `command`, for a host that spawns the process itself (Pi RPC). */
export const graderCommand = (spec: GraderSandboxSpec, command: string[]): { command: string; args: string[]; env: Record<string, string> } => ({
  command: "docker",
  args: graderDockerArgs(spec, command),
  env: { ...(process.env as Record<string, string>), ...(spec.secretEnv ?? {}) },
});

/** Start `command` inside the grader boundary with piped stdio (the Pi RPC process). */
export function spawnGrader(spec: GraderSandboxSpec, command: string[]): ChildProcess {
  return spawn("docker", graderDockerArgs(spec, command), { stdio: ["pipe", "pipe", "pipe"], env: { ...(process.env as Record<string, string>), ...(spec.secretEnv ?? {}) } });
}

/** Run `command` to completion inside the grader boundary. */
export function runGrader(spec: GraderSandboxSpec, command: string[], timeoutMs = 120000): SpawnSyncReturns<string> {
  return spawnSync("docker", graderDockerArgs(spec, command), { encoding: "utf8", timeout: timeoutMs, env: { ...(process.env as Record<string, string>), ...(spec.secretEnv ?? {}) } });
}
