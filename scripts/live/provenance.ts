/**
 * Shared run/package provenance for the live harness (one helper, two consumers).
 *
 * The acceptance/experiment runner (env.ts) captures the package identity at
 * staging/start via `captureStagedProvenance`; the evolution controller
 * (evolve.ts) checks those records via `validateRunSet` before any baseline,
 * evaluation or audit may use a run. One definition here, no second index:
 * the protected/evaluator file list itself stays in the evolve manifest; this
 * module only hashes and compares what it is given (globs read from the
 * manifest file on disk, never from the controller's evolving memory).
 */
import { createHash } from "node:crypto";
import { existsSync, globSync, mkdtempSync, openSync, readSync, closeSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parse } from "yaml";
import { KEY_NAMES } from "./keys.ts";
import { EVIDENCE_TABLE_CHECK_IDS, LENGTH_SOURCED_CHECK_IDS, PROTOCOL_CHECK_IDS } from "./evolution.ts";

export const PRIMARY_MODEL_ID = "gemini-3.8-flash";
export const FALLBACK_MODEL_ID = "gemini-3.5-flash-lite";
/** Exact served profiles: the manifest records per-turn models, and validation requires equality with these, never a substring. */
export const PRIMARY_MODEL_PROFILE = `google-vertex/${PRIMARY_MODEL_ID}`;
export const FALLBACK_MODEL_PROFILE = `google-vertex/${FALLBACK_MODEL_ID}`;

/**
 * Untracked files whose contents establish package identity: versioned code
 * only. Evidence, run outputs and experiment products are excluded because
 * they are products of a run, not inputs to it (a run must not certify its
 * own output as its input).
 */
const RELEVANT_UNTRACKED_PREFIXES = ["src/", "scripts/", "skills/", "config/", "tests/", "bin/"];

/** Stateful controller outputs: never part of the protected input digest. */
const STATEFUL_SUFFIXES = ["experiments/harness/manifest.yaml", "experiments/harness/evolution-log.jsonl"];
const STATEFUL_PREFIXES = ["experiments/harness/snapshots/", "experiments/harness/candidates/"];

export const sha256Text = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Chunked file hash (1 MiB reads): no size cap, constant memory. Null when unreadable. */
export function sha256File(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    try {
      const h = createHash("sha256");
      const buf = Buffer.alloc(1024 * 1024);
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        h.update(buf.subarray(0, n));
      }
      return h.digest("hex");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** A shell capture that never throws: null when the command fails (e.g. no git, no docker). */
function capture(repo: string, cmd: string, args: string[]): string | null {
  try {
    const r = spawnSync(cmd, args, { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) return null;
    const out = String(r.stdout ?? "").trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/**
 * SHA-256 of the complete `git diff HEAD` output, of any size. `git diff` is
 * streamed to a temp file and hashed in chunks: a buffered capture truncates
 * past 1 MiB (ENOBUFS, status null) and silently loses the dirty tree. Null
 * when the diff cannot be captured (no git, no HEAD): an explicit failure
 * state, never an empty string (a clean tree hashes to the SHA-256 of empty
 * input, so empty never means "no change").
 */
function diffHash(repo: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "uktub-diff-"));
  const file = join(dir, "diff");
  try {
    const fd = openSync(file, "w");
    try {
      const r = spawnSync("git", ["diff", "HEAD"], { cwd: repo, stdio: ["ignore", fd, "ignore"] });
      if (r.status !== 0) return null;
    } finally {
      closeSync(fd);
    }
    return sha256File(file);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Deterministic fingerprint over sorted repo-relative paths and their bytes.
 * Files are streamed in chunks; a path that cannot be read hashes as
 * "missing" alongside its name, so a deletion changes the digest instead of
 * silently passing.
 */
export function fingerprintFiles(repo: string, relPaths: string[]): string {
  const h = createHash("sha256");
  const buf = Buffer.alloc(1024 * 1024);
  for (const rel of [...relPaths].sort()) {
    h.update(`${rel}\n`);
    try {
      const fd = openSync(join(repo, rel), "r");
      try {
        for (;;) {
          const n = readSync(fd, buf, 0, buf.length, null);
          if (n === 0) break;
          h.update(buf.subarray(0, n));
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      h.update("missing");
    }
    h.update("\n");
  }
  return h.digest("hex");
}

/** Expand globs against the repo (existing files only, no node_modules), sorted. */
export function expandGlobs(repo: string, globs: string[]): string[] {
  const out = new Set<string>();
  for (const g of globs) {
    for (const f of globSync(g, { cwd: repo })) {
      const full = join(repo, f);
      try {
        if (!statSync(full).isFile() || f.includes("node_modules")) continue;
      } catch {
        continue;
      }
      out.add(f);
    }
  }
  return [...out].sort();
}

const isStateful = (f: string): boolean =>
  STATEFUL_SUFFIXES.includes(f) || STATEFUL_PREFIXES.some((p) => f.startsWith(p));

/** Built-in editable/protected globs: must match experiments/harness/manifest.yaml; read live from disk when present. */
const BUILTIN_EDITABLE_GLOBS = [
  "src/core/agent-rules.ts", "src/core/refusals.ts", "skills/**", "src/mcp/server.ts", "src/core/tools/*.ts",
  "src/core/notices.ts", "src/core/bibrender.ts", "src/core/rag/**", "src/core/chunk.ts", "src/core/chunk-document.ts",
  "src/core/sections.ts", "src/core/verify/workflow.ts", "src/core/source/prepare.ts", "src/core/compile/run.ts",
  "config/**", "src/core/config.ts", "src/pi/writer/**", "src/pi/subagent/**",
];
const BUILTIN_PROTECTED_GLOBS = [
  "scripts/live/**", "experiments/simulator.md", "experiments/scenarios/**",
  "src/core/tool-owned.ts", "src/pi/index.ts", "src/core/source/download.ts", "src/core/safe-detail.ts",
];

/**
 * The globs that define the staged surface, read from the manifest file on
 * disk (independent of the controller's evolving in-memory state). Falls back
 * to the built-in globs when no manifest exists yet (pre-init staging).
 */
export function stagingGlobs(repo: string): { editable: string[]; protected: string[]; scopeHash: string } {
  const file = join(repo, "experiments/harness/manifest.yaml");
  try {
    const m = parse(readFileSync(file, "utf8")) as { components?: Record<string, string[]>; protected?: string[] };
    if (m !== null && typeof m === "object" && m.components !== undefined && m.protected !== undefined) {
      const editable = [...new Set(Object.values(m.components).flat())].sort();
      const protectedGlobs = (m.protected as string[]).filter((g) => g !== "experiments/harness/manifest.yaml");
      const scopeHash = sha256Text(JSON.stringify({ components: m.components, protected: m.protected }));
      return { editable, protected: protectedGlobs, scopeHash };
    }
  } catch {
    // fall through to built-ins
  }
  return {
    editable: BUILTIN_EDITABLE_GLOBS,
    protected: BUILTIN_PROTECTED_GLOBS,
    scopeHash: sha256Text(JSON.stringify({ components: BUILTIN_EDITABLE_GLOBS, protected: BUILTIN_PROTECTED_GLOBS })),
  };
}

/** Content identity of the editable + protected surfaces (hashes only, never bodies). */
export function stagingSurfaceHashes(repo: string): { surfaceHash: string; protectedHash: string; scopeHash: string } {
  const { editable, protected: prot, scopeHash } = stagingGlobs(repo);
  const protectedFiles = expandGlobs(repo, prot).filter((f) => !isStateful(f));
  const protectedSet = new Set(protectedFiles);
  const editableFiles = expandGlobs(repo, editable).filter((f) => !isStateful(f) && !protectedSet.has(f));
  return { surfaceHash: fingerprintFiles(repo, editableFiles), protectedHash: fingerprintFiles(repo, protectedFiles), scopeHash };
}

/** Sha256 of the staged consumer tarball (`pnpm pack` output under `<stage>/tar`), null when absent. */
export function tarballHash(stageDir: string): string | null {
  try {
    const tar = join(stageDir, "tar");
    if (!existsSync(tar)) return null;
    const tgz = readdirSync(tar).filter((f) => f.endsWith(".tgz")).sort();
    if (tgz.length === 0) return null;
    const h = createHash("sha256");
    const buf = Buffer.alloc(1024 * 1024);
    for (const f of tgz) {
      const fd = openSync(join(tar, f), "r");
      try {
        for (;;) {
          const n = readSync(fd, buf, 0, buf.length, null);
          if (n === 0) break;
          h.update(buf.subarray(0, n));
        }
      } finally {
        closeSync(fd);
      }
    }
    return h.digest("hex");
  } catch {
    return null;
  }
}

export interface StagedProvenance {
  commit: string;
  /** SHA-256 of the complete `git diff HEAD` output; null when the diff could not be captured (explicit failure, never ""). */
  workingTreeDiffSha256: string | null;
  /** Repo-relative untracked paths (names only, as before). */
  untracked: string[];
  /** Content hashes of the relevant untracked code (all of it, chunked; evidence and runs excluded). */
  untrackedSha256: Record<string, string>;
  /** Actual staged package hash (the tarball the sandbox installs), null when unstaged. */
  packageHash: string | null;
  /** Content identity of the editable surface at staging (binds runs to the measured bytes). */
  surfaceHash: string;
  /** Whole protected input set digest at staging (stateful manifest/log/snapshots excluded). */
  protectedHash: string;
  /** Stable hash of the scope/policy definition the globs came from. */
  scopeHash: string;
  /** Captured once at staging/start, never recomputed at report time. */
  capturedAt: string;
}

/**
 * Capture the package identity at staging/start. Existing consumers keep their
 * shape (`commit`, `workingTreeDiffSha256`, `untracked`); the content hashes,
 * the staged tarball hash and the surface identity are added, never
 * credential values. `stageDir` is the stage root (`<out>/stage`, holding
 * `tar/` and `consumer/`), not the consumer subdir.
 */
export function captureStagedProvenance(repo: string, stageDir: string): StagedProvenance {
  const commit = capture(repo, "git", ["rev-parse", "HEAD"]) ?? "";
  const diff = diffHash(repo);
  const names = (capture(repo, "git", ["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  const untrackedSha256: Record<string, string> = {};
  for (const name of names) {
    if (!RELEVANT_UNTRACKED_PREFIXES.some((p) => name.startsWith(p))) continue;
    const sha = sha256File(join(repo, name));
    if (sha !== null) untrackedSha256[name] = sha;
  }
  const { surfaceHash, protectedHash, scopeHash } = stagingSurfaceHashes(repo);
  return {
    commit,
    workingTreeDiffSha256: diff,
    untracked: names,
    untrackedSha256,
    packageHash: tarballHash(stageDir),
    surfaceHash,
    protectedHash,
    scopeHash,
    capturedAt: new Date().toISOString(),
  };
}

export interface RunEvidence {
  ref: string;
  scenario: string;
  iteration: number;
  metrics: any;
  /** Raw metrics.json bytes the manifest digest covers; null when unreadable (binding unverifiable, refused). */
  metricsRaw?: string | null;
  manifest: any | null;
}

export interface RunSetPolicy {
  /** Scenarios allowed for development (baseline/evaluate). */
  evolve: string[];
  heldout: string[];
  ood: string[];
  /** For audits: the surface being audited and its allowed scenarios. */
  auditSurface?: "heldout" | "ood";
  repo: string;
}

/**
 * Labelled fallback turns for one side (`uktub` is the agent side,
 * `simulator` the simulator side). Null for the legacy unattributable array
 * shape, which validation refuses rather than guessing a side.
 */
const fallbackTurnsFor = (metrics: any, side: "uktub" | "simulator"): unknown[] | null => {
  const f = metrics?.fallbackTurns;
  if (f === undefined || f === null) return [];
  if (Array.isArray(f)) return null;
  if (typeof f === "object") {
    const list = (f as Record<string, unknown>)[side];
    return Array.isArray(list) ? list : [];
  }
  return [];
};

const checkIdsOf = (metrics: any): string[] => {
  const checks = metrics?.checks;
  return Array.isArray(checks) ? checks.map((c) => String(c?.id ?? "")) : [];
};

const expectedCheckIds = (repo: string, scenario: string): string[] => {
  const file = join(repo, "experiments/scenarios", `${scenario}.md`);
  const declared = existsSync(file) && /^## Evidence table\s*$/m.test(readFileSync(file, "utf8"));
  return [...PROTOCOL_CHECK_IDS, ...(declared ? [...EVIDENCE_TABLE_CHECK_IDS, ...LENGTH_SOURCED_CHECK_IDS] : [])].sort();
};

const evaluatorFileFor = (key: string, scenario: string): string => {
  if (key === "scenarioSha256") return `experiments/scenarios/${scenario}.md`;
  if (key === "simulatorSha256") return "experiments/simulator.md";
  if (key === "experimentSha256") return "scripts/live/experiment.ts";
  return "scripts/live/agent.ts";
};

/**
 * Check that a set of recorded runs may be used for `op`: unique refs, allowed
 * surface (held-out/OOD never enter baseline/evaluate), scenario/iteration
 * match, the same concrete evaluator protocol check set with its critical
 * checks present (missing checks refuse, never pass by omission), the expected
 * model profile with labelled fallback (exact profile equality across the set
 * partitions different actual profiles; a substring match is not
 * compatibility), key names only (never values), the whole protected input set
 * digest matching current bytes (fail closed), matching window/config/image/
 * engine policy, one shared surface digest and one package identity. Returns
 * problems (empty: usable).
 */
export function validateRunSet(runs: RunEvidence[], policy: RunSetPolicy, op: string): string[] {
  const problems: string[] = [];
  const refs = runs.map((r) => r.ref);
  if (new Set(refs).size !== refs.length) problems.push(`duplicate run refs in ${op}: ${refs.join(", ")}`);
  const allowed = policy.auditSurface === undefined ? policy.evolve : policy.auditSurface === "heldout" ? policy.heldout : policy.ood;
  const heldOrOod = new Set([...policy.heldout, ...policy.ood]);
  for (const r of runs) {
    if (policy.auditSurface === undefined && heldOrOod.has(r.scenario)) {
      problems.push(`${r.ref}: ${r.scenario} is a held-out/OOD scenario and cannot enter ${op} (release audits are separate)`);
      continue;
    }
    if (!allowed.includes(r.scenario)) problems.push(`${r.ref}: ${r.scenario} is not an ${policy.auditSurface ?? "evolve"} scenario in the manifest`);
  }
  const withManifest = runs.filter((r) => r.manifest !== null && typeof r.manifest === "object");
  for (const r of runs) {
    if (r.manifest === null || typeof r.manifest !== "object") {
      problems.push(`${r.ref}: no run manifest (evidence/manifest.json); runs recorded before provenance are historical, re-run with the current harness`);
    }
  }
  if (withManifest.length !== runs.length) return problems;
  const checkSets = new Map<string, string>();
  for (const r of withManifest) {
    const m = r.manifest as Record<string, unknown>;
    if (m["scenario"] !== r.scenario || Number(m["iteration"]) !== r.iteration) {
      problems.push(`${r.ref}: run manifest identifies ${String(m["scenario"])} iteration ${String(m["iteration"])} (declared ${r.scenario} iteration ${r.iteration})`);
    }
    const ids = checkIdsOf(r.metrics).sort();
    const required = expectedCheckIds(policy.repo, r.scenario);
    if (JSON.stringify(ids) !== JSON.stringify(required)) {
      problems.push(`${r.ref}: run metrics carry ${ids.length} check(s) [${ids.join(", ")}]; scenario protocol requires exactly [${required.join(", ")}] (re-run with the current harness; missing checks never pass by omission and unknown checks are refused)`);
    }
    const priorSet = checkSets.get(r.scenario);
    if (priorSet !== undefined && priorSet !== JSON.stringify(ids)) problems.push(`${r.ref}: evaluator check set differs from another ${r.scenario} repeat`);
    else checkSets.set(r.scenario, JSON.stringify(ids));
    const profile = m["modelProfile"] as Record<string, unknown> | null | undefined;
    if (profile === null || profile === undefined || typeof profile !== "object" || Array.isArray(profile)) {
      problems.push(`${r.ref}: run manifest has no per-turn modelProfile (runs recorded before exact model profiles are historical; re-run with the current harness)`);
    } else {
      const sides = [["agent", "uktub"], ["simulator", "simulator"]] as const;
      for (const [profileSide, turnsSide] of sides) {
        const list = profile[profileSide];
        if (!Array.isArray(list) || list.length === 0 || !list.every((s) => s === PRIMARY_MODEL_PROFILE || s === FALLBACK_MODEL_PROFILE)) {
          problems.push(`${r.ref}: manifest modelProfile.${profileSide} must list exactly the served profiles (${PRIMARY_MODEL_PROFILE}, or the labelled ${FALLBACK_MODEL_PROFILE} fallback); got ${JSON.stringify(list ?? null)}`);
          continue;
        }
        const labelled = fallbackTurnsFor(r.metrics, turnsSide);
        if (labelled === null) {
          problems.push(`${r.ref}: fallback turns are in a legacy shape that cannot attribute turns to a side; re-run with the current harness`);
          continue;
        }
        const servedFallback = (list as unknown[]).includes(FALLBACK_MODEL_PROFILE);
        if (servedFallback && labelled.length === 0) {
          problems.push(`${r.ref}: modelProfile.${profileSide} shows turns served on the ${FALLBACK_MODEL_PROFILE} fallback with no labelled fallback turn; every fallback turn is labelled, never implicit`);
        } else if (!servedFallback && labelled.length > 0) {
          problems.push(`${r.ref}: ${labelled.length} labelled fallback turn(s) on ${turnsSide} but modelProfile.${profileSide} shows only ${PRIMARY_MODEL_PROFILE} (profile and labels disagree; re-run with the current harness)`);
        }
      }
    }
    const keys = m["providerKeysPassed"];
    if (!Array.isArray(keys) || !(keys as unknown[]).every((k) => typeof k === "string" && (KEY_NAMES as readonly string[]).includes(k))) {
      problems.push(`${r.ref}: providerKeysPassed must list key names only (${KEY_NAMES.join(", ")})`);
    }
    for (const k of KEY_NAMES as readonly string[]) {
      if (typeof m[k] === "string" && (m[k] as string).length > 0) problems.push(`${r.ref}: run manifest carries a value for ${k}; key names only, never values`);
    }
    const manifestPolicy = (m["policy"] as Record<string, unknown> | undefined) ?? {};
    const manifestWindow = (manifestPolicy["simulatedWindowTokens"] as number | null | undefined) ?? null;
    const metricsWindow = (r.metrics?.simulatedWindowTokens as number | null | undefined) ?? null;
    if (manifestWindow !== metricsWindow) {
      problems.push(`${r.ref}: window policy mismatch (manifest ${JSON.stringify(manifestWindow)} vs metrics ${JSON.stringify(metricsWindow)}); compare only runs of the same setting`);
    }
    const recordedDigest = m["metricsSha256"];
    if (typeof recordedDigest !== "string" || recordedDigest.length === 0) {
      problems.push(`${r.ref}: run manifest has no metrics digest (runs recorded before metrics binding are historical, never silently accepted; re-run with the current harness)`);
    } else if (typeof r.metricsRaw !== "string") {
      problems.push(`${r.ref}: metrics.json bytes are unavailable, so the manifest metrics digest cannot be verified; refusing`);
    } else if (sha256Text(r.metricsRaw) !== recordedDigest) {
      problems.push(`${r.ref}: metrics.json bytes do not match the manifest metrics digest (replaced or stale metrics are refused; re-run with the current harness)`);
    }
    if (r.metrics !== null && typeof r.metrics === "object") {
      if (r.metrics.scenario !== m["scenario"] || Number(r.metrics.iteration) !== Number(m["iteration"])) {
        problems.push(`${r.ref}: metrics identify ${String(r.metrics.scenario)} iteration ${String(r.metrics.iteration)} but the manifest identifies ${String(m["scenario"])} iteration ${String(m["iteration"])} (replaced metrics are refused)`);
      }
    }
    for (const k of ["commit", "packageHash", "surfaceHash", "protectedHash", "image", "engineDevice"]) {
      if (typeof m[k] !== "string" || (m[k] as string).length === 0) problems.push(`${r.ref}: run manifest is missing package identity field ${k} (historical run without staged provenance; re-run with the current harness)`);
    }
    const diff = m["workingTreeDiffSha256"];
    if (typeof diff !== "string" || !/^[0-9a-f]{64}$/.test(diff)) {
      problems.push(`${r.ref}: run manifest workingTreeDiffSha256 is not the hash of the complete working-tree diff (a capture failure is recorded as null, never as an empty string that validates; historical runs without staged provenance must be re-run with the current harness)`);
    }
  }
  // Cross-run agreement: one evaluated set is one package, one surface, one
  // evaluator input set, one window, one key profile, one model profile.
  const agree = (label: string, values: unknown[]): void => {
    if (new Set(values.map((v) => JSON.stringify(v))).size > 1) problems.push(`${op}: ${label} differs across the run set (${values.map((v) => JSON.stringify(v)).join(" vs ")}); evaluate one package at a time`);
  };
  agree("package commit", withManifest.map((r) => (r.manifest as any).commit));
  agree("working-tree diff", withManifest.map((r) => (r.manifest as any).workingTreeDiffSha256));
  agree("staged package hash", withManifest.map((r) => (r.manifest as any).packageHash));
  agree("content surface digest", withManifest.map((r) => (r.manifest as any).surfaceHash));
  agree("protected input set digest", withManifest.map((r) => (r.manifest as any).protectedHash));
  agree("model profile", withManifest.map((r) => (r.manifest as any).model));
  agree("served model profiles", withManifest.map((r) => (r.manifest as any).modelProfile));
  agree("key profile", withManifest.map((r) => (r.manifest as any).providerKeysPassed));
  agree("window policy", withManifest.map((r) => (r.manifest as any)?.policy?.simulatedWindowTokens ?? null));
  agree("sandbox image", withManifest.map((r) => (r.manifest as any).image ?? null));
  agree("engine config", withManifest.map((r) => (r.manifest as any).engineDevice ?? null));
  for (const key of ["scenarioSha256", "simulatorSha256", "experimentSha256", "agentDriverSha256"]) {
    const values = withManifest.map((r) => (r.manifest as any)[key]);
    if (values.some((v) => typeof v !== "string" || v.length === 0)) {
      problems.push(`${op}: evaluator hash ${key} is missing from a run manifest (historical run; re-run with the current harness)`);
      continue;
    }
    agree(`evaluator hash ${key}`, values);
  }
  // Every referenced evaluator file must exist locally with matching bytes
  // (fail closed: a missing current file is drift, never a skip).
  for (const key of ["scenarioSha256", "simulatorSha256", "experimentSha256", "agentDriverSha256"]) {
    const representative = runs[0];
    const file = evaluatorFileFor(key, String((representative.manifest as any)?.scenario ?? representative.scenario));
    const current = sha256File(join(policy.repo, file));
    const recorded = (withManifest[0].manifest as any)[key];
    if (current === null) {
      problems.push(`${op}: evaluator file ${file} is missing locally; refusing (fail closed, not skipped)`);
    } else if (recorded !== current) {
      problems.push(`${op}: evaluator hash ${key} in the run manifests does not match the current ${file} (evaluator drift; re-run with the current harness)`);
    }
  }
  // The whole protected input set must match current bytes (fail closed: a
  // missing current file is drift, never a skip).
  try {
    const current = stagingSurfaceHashes(policy.repo).protectedHash;
    const recorded = (withManifest[0]?.manifest as any)?.protectedHash;
    if (typeof recorded === "string" && recorded.length > 0 && recorded !== current) {
      problems.push(`${op}: protected input set digest in the run manifests does not match the current protected files (evaluator drift; re-run with the current harness)`);
    }
  } catch {
    problems.push(`${op}: cannot hash the current protected input set; refusing`);
  }
  return problems;
}
