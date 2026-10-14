/**
 * Run validity for measured runs (PLAN §4.5, brief decided 5–6).
 * VALID enters the analysis (a `budget` outcome counts); BLOCKED is a provider/auth outage
 * (including `invalid_grant`/`invalid_rapt`) rerun in the same slot; INVALID is a harness error
 * or any assistant turn off the configured model.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Validity = "VALID" | "BLOCKED" | "INVALID";

/** Provider/auth outage signals in a stop reason: ADC, quota, transport. Never a cap or a verdict. */
export function isProviderOutage(text: string): boolean {
  return /invalid_grant|invalid_rapt|unauthorized|unauthenticated|fetch failed|\b429\b|RESOURCE_EXHAUSTED|resource exhausted|quota|rate limit|ECONNRESET|ETIMEDOUT|socket hang up/i.test(text);
}

export function classifyValidity(args: {
  stopReason: string;
  assistantModel: string;
  turnModels: string[];
  harnessError?: string | null;
}): Validity {
  if (args.harnessError) return "INVALID";
  if (args.turnModels.some((m) => m !== args.assistantModel)) return "INVALID";
  if (/^error:/i.test(args.stopReason) && !isProviderOutage(args.stopReason)) return "INVALID";
  if (/^blocked:/i.test(args.stopReason) || isProviderOutage(args.stopReason)) return "BLOCKED";
  return "VALID";
}

/**
 * The frozen-tree identity recorded in the manifest: the git tree of the whole working tree as it is now (tracked edits and
 * untracked files, gitignored files excluded), built in a throwaway index so the real index is never touched. Experiments run
 * on uncommitted work, so `HEAD^{tree}` or `git diff HEAD` (blind to untracked files) would not identify what ran. Null outside git.
 */
export function gitTreeHash(repo: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "uktub-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
    if (spawnSync("git", ["add", "-A", "."], { cwd: repo, env, stdio: "ignore" }).status !== 0) return null;
    const r = spawnSync("git", ["write-tree"], { cwd: repo, env, encoding: "utf8" });
    const out = String(r.stdout ?? "").trim();
    return r.status === 0 && /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ValidityRecordInput {
  scenarioId: string;
  scenarioSha256: string;
  assistantModel: string;
  turnModels: string[];
  adcCheckedAt: string;
  treeHash: string | null;
  stopReason: string;
  harnessError?: string | null;
}

/** The validity class plus the manifest fragment every measured run records (decided 6). */
export function validityRecord(input: ValidityRecordInput): {
  validity: Validity;
  manifest: Record<string, unknown>;
} {
  const validity = classifyValidity({
    stopReason: input.stopReason,
    assistantModel: input.assistantModel,
    turnModels: input.turnModels,
    harnessError: input.harnessError,
  });
  return {
    validity,
    manifest: {
      scenarioId: input.scenarioId,
      scenarioSha256: input.scenarioSha256,
      assistantModel: input.assistantModel,
      turnModels: input.turnModels,
      adcCheckedAt: input.adcCheckedAt,
      treeHash: input.treeHash,
      validity,
    },
  };
}
