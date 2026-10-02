/**
 * Engine location (KTD1): resolve the tectonic binary without ever guessing.
 * Order: the UKTUB_TECTONIC_BIN override (injected env — the user names their
 * binary), else `tectonic` on PATH. The resolved candidate is validated by a
 * `--version` probe; the floor is the version this package's fixtures and
 * sandbox are tested against (0.15.0 — the version-2 CLI whose stream grammar
 * src/core/compile/diagnostics.ts pins).
 */

import { accessSync, existsSync, constants as fsConstants } from "node:fs";

export const ENGINE_ENV_OVERRIDE = "UKTUB_TECTONIC_BIN";
export const ENGINE_MIN_VERSION = { major: 0, minor: 15 };

export interface ResolvedEngine {
  path: string;
  version: string;
}

export type EngineResolution =
  | { ok: true; engine: ResolvedEngine }
  | { ok: false; reason: "not-found" | "not-executable" | "version-unsupported"; detail: string };

/** Existence/executability seam (KTD6): tests inject a fake, prod uses the real fs. */
export interface EngineFs {
  exists(p: string): boolean;
  executable(p: string): boolean;
}

const realFs: EngineFs = {
  exists: (p) => existsSync(p),
  executable: (p) => {
    try {
      accessSync(p, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export async function resolveEngine(
  env: Record<string, string | undefined>,
  execFile: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
  fs: EngineFs = realFs,
): Promise<EngineResolution> {
  const override = env[ENGINE_ENV_OVERRIDE];
  const candidates: string[] = override
    ? [override]
    : (env.PATH ?? "")
        .split(":")
        .filter((p) => p.length > 0)
        .map((dir) => `${dir}/tectonic`);
  const found = candidates.find((p) => fs.exists(p));
  if (!found) {
    return {
      ok: false,
      reason: "not-found",
      detail: override
        ? `${ENGINE_ENV_OVERRIDE} points at "${override}", which does not exist`
        : "no `tectonic` binary on PATH",
    };
  }
  if (!fs.executable(found)) {
    return { ok: false, reason: "not-executable", detail: `${found} is not executable` };
  }
  let out: { stdout: string; stderr: string };
  try {
    out = await execFile(found, ["--version"]);
  } catch (e) {
    return { ok: false, reason: "not-executable", detail: `${found} --version failed: ${String(e)}` };
  }
  const m = /tectonic (\d+)\.(\d+)\.(\d+)/i.exec(`${out.stdout}${out.stderr}`);
  if (!m) {
    return { ok: false, reason: "version-unsupported", detail: `${found} did not report a tectonic version` };
  }
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major < ENGINE_MIN_VERSION.major || (major === ENGINE_MIN_VERSION.major && minor < ENGINE_MIN_VERSION.minor)) {
    return {
      ok: false,
      reason: "version-unsupported",
      detail: `tectonic ${m[1]}.${m[2]}.${m[3]} is older than the tested floor ${ENGINE_MIN_VERSION.major}.${ENGINE_MIN_VERSION.minor}.0`,
    };
  }
  return { ok: true, engine: { path: found, version: `${m[1]}.${m[2]}.${m[3]}` } };
}
