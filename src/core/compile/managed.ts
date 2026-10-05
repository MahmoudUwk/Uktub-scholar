/**
 * Managed tectonic: an explicit, sha256-pinned install of the LaTeX engine into the shared cache (`uktub-scholar tectonic install --yes`),
 * so a researcher without TeX tooling can compile. Never downloads on its own: a compile only USES an installed copy, after the user's
 * `UKTUB_TECTONIC_BIN` and a `tectonic` on PATH. Reuses the verified download/extract code of the embedding runtime. The archive is
 * extracted and the binary self-checked (`--version` must report the pinned version) in a staging directory; only then is it committed.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Asset, MAX_UNPACKED_BYTES, RuntimeError, downloadVerified, extractTarGz, extractZip, parseAsset } from "../embed/runtime.ts";

export interface TectonicLock {
  schema: 1;
  tool: { name: string; version: string; license: string; assets: Record<string, Asset> };
}

const bad = (why: string): never => {
  throw new RuntimeError("invalid_lock", `tectonic.lock.json is not valid: ${why}`);
};
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const nonEmpty = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" && (o[k] as string).length > 0 ? (o[k] as string) : bad(`${k} must be a non-empty string`));

export function validateTectonicLock(x: unknown): TectonicLock {
  if (!isObj(x) || x.schema !== 1) return bad("schema must be 1");
  const tool = isObj(x.tool) ? x.tool : bad("tool missing");
  const rawAssets = isObj(tool.assets) ? tool.assets : bad("tool.assets missing");
  const version = nonEmpty(tool, "version");
  if (!/^\d+\.\d+\.\d+$/.test(version)) bad("version must be a stable semver, never a rolling build");
  const assets: Record<string, Asset> = {};
  for (const [key, raw] of Object.entries(rawAssets)) assets[key] = parseAsset(key, raw);
  return { schema: 1, tool: { name: nonEmpty(tool, "name"), version, license: nonEmpty(tool, "license"), assets } };
}

export function readTectonicLock(): TectonicLock {
  return validateTectonicLock(JSON.parse(readFileSync(new URL("./tectonic.lock.json", import.meta.url), "utf8")));
}

const RECEIPT = ".verified";
const dirOf = (lock: TectonicLock, a: Asset, cache: string): string => join(cache, "tools", `tectonic-${lock.tool.version}-${a.sha256.slice(0, 12)}`);
const binaryOf = (lock: TectonicLock, a: Asset, cache: string): string => join(dirOf(lock, a, cache), a.dir, a.binary);

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The installed binary's path (receipt matches the pinned digest and the file exists), or null. Cheap: no hashing. */
export function managedTectonicPath(lock: TectonicLock, cacheDir: string, platform: string): string | null {
  const a = lock.tool.assets[platform];
  if (a === undefined) return null;
  try {
    const receipt = JSON.parse(readFileSync(join(dirOf(lock, a, cacheDir), RECEIPT), "utf8")) as { sha256?: string };
    return receipt.sha256 === a.sha256 && isFile(binaryOf(lock, a, cacheDir)) ? binaryOf(lock, a, cacheDir) : null;
  } catch {
    return null;
  }
}

export async function installTectonic(o: {
  lock: TectonicLock;
  cacheDir: string;
  platform: string;
  fetch: typeof fetch;
  /** `--version` output of a candidate binary (the self-check before anything is committed). */
  probe: (binary: string) => Promise<string>;
}): Promise<{ path: string; downloaded: boolean }> {
  const { lock, cacheDir } = o;
  const asset = lock.tool.assets[o.platform];
  if (asset === undefined) {
    throw new RuntimeError("unsupported_platform", `no tectonic ${lock.tool.version} build is pinned for ${o.platform}; install tectonic yourself and put it on PATH or set UKTUB_TECTONIC_BIN`);
  }
  const existing = managedTectonicPath(lock, cacheDir, o.platform);
  if (existing !== null) return { path: existing, downloaded: false };

  const archive = join(cacheDir, "downloads", asset.name);
  await downloadVerified(o.fetch, asset.url, archive, asset);
  const staging = join(cacheDir, "downloads", `tectonic-${asset.sha256.slice(0, 12)}.${process.pid}.${Date.now()}.tmp`);
  mkdirSync(staging, { recursive: true });
  try {
    try {
      if (asset.name.endsWith(".zip")) extractZip(archive, staging, MAX_UNPACKED_BYTES);
      else await extractTarGz(archive, staging);
    } catch (err) {
      throw new RuntimeError("unsafe_archive", `the tectonic archive was refused: ${err instanceof Error ? err.message : String(err)}`);
    }
    const binary = join(staging, asset.dir, asset.binary);
    if (!isFile(binary)) throw new RuntimeError("missing_binary", `the tectonic archive has no ${asset.binary}`);
    chmodSync(binary, 0o755);
    let reported: string;
    try {
      reported = await o.probe(binary);
    } catch (err) {
      throw new RuntimeError("start_failed", `the downloaded tectonic did not run: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!new RegExp(`tectonic\\s+${lock.tool.version.replaceAll(".", "\\.")}`, "i").test(reported)) {
      throw new RuntimeError("start_failed", `the downloaded tectonic reports "${reported.trim().slice(0, 80)}", not the pinned ${lock.tool.version}`);
    }
    writeFileSync(join(staging, RECEIPT), JSON.stringify({ sha256: asset.sha256, version: lock.tool.version }));
    const finalDir = dirOf(lock, asset, cacheDir);
    mkdirSync(join(cacheDir, "tools"), { recursive: true });
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(staging, finalDir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(archive, { force: true });
  }
  return { path: binaryOf(lock, asset, cacheDir), downloaded: true };
}
