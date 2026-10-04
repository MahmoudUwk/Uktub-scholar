/**
 * Managed embedding runtime (owner decision 2026-10-04): a pinned official llama.cpp `llama-server` build and a
 * pinned EmbeddingGemma GGUF, fetched on first use into a shared cache, verified against the lock file's sha256
 * and size, and run as a supervised child process on loopback. A child process, not an in-process binding: a
 * native crash or a CPU-bound batch must not take the agent host down, and the process can be restarted.
 *
 * Trust model: nothing downloaded is used until its digest and size match `models.lock.json` (a reviewed file);
 * the archive is untrusted (the `tar` package refuses `..`, absolute paths and symlink escapes, and `strict`
 * turns every such warning into a failure); downloads are written to a temporary name and renamed only after
 * verification. The cache is shared across projects (model weights are not project state) and removable at any
 * time — the next install fetches again.
 *
 * Pinned for Linux, macOS and Windows on x64 and arm64 (`.tar.gz` and `.zip` builds). Linux x64 is verified by running the
 * server; the others are digest-pinned and extraction-verified (docs/handoff.md). An unpinned platform reports
 * `unsupported_platform` and uses UKTUB_EMBED_URL.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, createWriteStream, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { unzipSync } from "fflate";
import { extract } from "tar";

export type RuntimeErrorCode =
  | "invalid_lock"
  | "unsupported_platform"
  | "download_failed"
  | "checksum_mismatch"
  | "size_mismatch"
  | "unsafe_archive"
  | "missing_binary"
  | "start_failed"
  | "start_timeout";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}

export interface Asset {
  name: string;
  url: string;
  sha256: string;
  size: number;
  /** Top-level directory inside the archive ("" when the files sit at the archive root, as in the Windows zips). */
  dir: string;
  /** Server executable inside `dir`. */
  binary: string;
}
export interface RuntimeLock {
  schema: 1;
  runtime: { name: string; version: string; license: string; assets: Record<string, Asset> };
  embedding: { id: string; file: string; url: string; sha256: string; size: number; license: string; terms: string; profile: string; serverArgs: string[] };
}
export interface InstallPaths {
  server: string;
  model: string;
}

// ── lock ────────────────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
const PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // one path component: no separators, no leading dot

const bad = (why: string): never => {
  throw new RuntimeError("invalid_lock", `models.lock.json is not valid: ${why}`);
};
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" && (o[k] as string).length > 0 ? (o[k] as string) : bad(`${k} must be a non-empty string`));
const https = (o: Record<string, unknown>, k: string): string => {
  const v = str(o, k);
  try {
    if (new URL(v).protocol !== "https:") bad(`${k} must be an https URL`);
  } catch (err) {
    if (err instanceof RuntimeError) throw err;
    bad(`${k} is not a URL`);
  }
  return v;
};
const digest = (o: Record<string, unknown>, k: string): string => (HEX64.test(str(o, k)) ? (o[k] as string) : bad(`${k} must be 64 lower-case hex characters`));
const size = (o: Record<string, unknown>, k: string): number => (Number.isSafeInteger(o[k]) && (o[k] as number) > 0 ? (o[k] as number) : bad(`${k} must be a positive integer`));
const part = (o: Record<string, unknown>, k: string): string => (PART.test(str(o, k)) ? (o[k] as string) : bad(`${k} must be one plain path component`));
const archiveName = (o: Record<string, unknown>): string => (/\.(tar\.gz|zip)$/.test(part(o, "name")) ? (o.name as string) : bad("name must be a .tar.gz or .zip archive"));
const archiveDir = (o: Record<string, unknown>): string => (o.dir === "" ? "" : part(o, "dir"));

export function validateLock(x: unknown): RuntimeLock {
  if (!isObj(x) || x.schema !== 1) return bad("schema must be 1");
  const rt = isObj(x.runtime) ? x.runtime : bad("runtime missing");
  const assetsIn = isObj(rt.assets) ? rt.assets : bad("runtime.assets missing");
  const assets: Record<string, Asset> = {};
  for (const [key, raw] of Object.entries(assetsIn)) {
    const a = isObj(raw) ? raw : bad(`asset ${key} is not an object`);
    assets[key] = { name: archiveName(a), url: https(a, "url"), sha256: digest(a, "sha256"), size: size(a, "size"), dir: archiveDir(a), binary: part(a, "binary") };
  }
  const em = isObj(x.embedding) ? x.embedding : bad("embedding missing");
  const args = Array.isArray(em.serverArgs) && em.serverArgs.every((a) => typeof a === "string") ? (em.serverArgs as string[]) : bad("embedding.serverArgs must be a list of strings");
  return {
    schema: 1,
    runtime: { name: str(rt, "name"), version: part(rt, "version"), license: str(rt, "license"), assets },
    embedding: {
      id: str(em, "id"),
      file: part(em, "file"),
      url: https(em, "url"),
      sha256: digest(em, "sha256"),
      size: size(em, "size"),
      license: str(em, "license"),
      terms: str(em, "terms"),
      profile: str(em, "profile"),
      serverArgs: args,
    },
  };
}

export function readLock(): RuntimeLock {
  return validateLock(JSON.parse(readFileSync(new URL("./models.lock.json", import.meta.url), "utf8")));
}

export const platformKey = (platform: string = process.platform, arch: string = process.arch): string => `${platform}-${arch}`;

// ── paths and receipts ──────────────────────────────────────────────────────

const modelPathOf = (lock: RuntimeLock, cache: string): string => join(cache, "models", lock.embedding.sha256.slice(0, 16), lock.embedding.file);
const runtimeDirOf = (lock: RuntimeLock, a: Asset, cache: string): string => join(cache, "runtime", `${lock.runtime.version}-${a.sha256.slice(0, 12)}`);
const serverPathOf = (lock: RuntimeLock, a: Asset, cache: string): string => join(runtimeDirOf(lock, a, cache), a.dir, a.binary);
const RECEIPT = ".verified";

const fileSize = (p: string): number | null => {
  try {
    const s = statSync(p);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
};

const runtimeReady = (lock: RuntimeLock, a: Asset, cache: string): boolean => {
  try {
    const receipt = JSON.parse(readFileSync(join(runtimeDirOf(lock, a, cache), RECEIPT), "utf8")) as { sha256?: string };
    return receipt.sha256 === a.sha256 && fileSize(serverPathOf(lock, a, cache)) !== null;
  } catch {
    return false;
  }
};

/** Cheap "is it installed" check (receipt, file presence and size); `installRuntime` re-verifies digests. */
export function installedPaths(lock: RuntimeLock, cacheDir: string, platform: string): InstallPaths | null {
  const a = lock.runtime.assets[platform];
  if (a === undefined) return null;
  const model = modelPathOf(lock, cacheDir);
  if (fileSize(model) !== lock.embedding.size || !runtimeReady(lock, a, cacheDir)) return null;
  return { server: serverPathOf(lock, a, cacheDir), model };
}

// ── download ────────────────────────────────────────────────────────────────

async function downloadVerified(fetchImpl: typeof fetch, url: string, dest: string, expect: { sha256: string; size: number }): Promise<void> {
  mkdirSync(join(dest, ".."), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Date.now()}.part`;
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: "follow" });
  } catch (err) {
    throw new RuntimeError("download_failed", `download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok || res.body === null) throw new RuntimeError("download_failed", `download failed: HTTP ${res.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const gate = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > expect.size) return cb(new RuntimeError("size_mismatch", `the download is larger than the pinned ${expect.size} bytes`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as never), gate, createWriteStream(tmp));
    if (bytes !== expect.size) throw new RuntimeError("size_mismatch", `the download is ${bytes} bytes, the pin says ${expect.size}`);
    if (hash.digest("hex") !== expect.sha256) throw new RuntimeError("checksum_mismatch", "the download does not match the pinned sha256");
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    if (err instanceof RuntimeError) throw err;
    throw new RuntimeError("download_failed", `download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const sha256File = (path: string): string | null => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
};

// ── extraction ──────────────────────────────────────────────────────────────

/** Client policy: most bytes an archive may unpack to (the largest pinned CPU build is under 100 MB unpacked). */
export const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

/** A zip entry name that stays inside the install directory: no NUL, backslash, drive letter, absolute path or `..` segment. */
function safeZipName(name: string): boolean {
  return !(name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes(".."));
}

function extractZip(file: string, into: string, maxBytes: number): void {
  let total = 0;
  // the declared size is checked per entry BEFORE it is inflated, so a zip bomb never gets to allocate
  const entries = unzipSync(readFileSync(file), {
    filter: (f) => {
      total += f.originalSize;
      if (total > maxBytes) throw new Error(`the archive unpacks to something larger than ${maxBytes} bytes`);
      if (!safeZipName(f.name)) throw new Error(`unsafe entry name "${f.name}"`);
      return true;
    },
  });
  for (const [name, data] of Object.entries(entries)) {
    const target = join(into, name);
    if (name.endsWith("/")) mkdirSync(target, { recursive: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
    }
  }
}

async function extractTarGz(archive: string, staging: string): Promise<void> {
  // Regular files and directories go through tar in strict mode (it refuses `..`, absolute paths and links that escape).
  // Symlinks are collected and recreated after validation: a release archive legitimately carries chains of
  // same-directory library links (libx.so → libx.so.0 → libx.so.0.5.0) that tar's own link guard rejects in some orders.
  const links: { path: string; target: string }[] = [];
  await extract({
    file: archive,
    cwd: staging,
    strict: true,
    filter: (path, entry) => {
      if ((entry as { type?: string }).type !== "SymbolicLink") return true;
      links.push({ path, target: (entry as { linkpath?: string }).linkpath ?? "" });
      return false;
    },
  });
  for (const l of links) {
    const rel = normalize(l.path);
    // the link must sit inside the staging directory (checked on the RAW path: normalising would hide a `..`) and point at a
    // plain sibling name: nothing it can resolve to leaves the directory
    if (isAbsolute(l.path) || isAbsolute(rel) || l.path.split(/[\\/]/).includes("..") || rel === ".." || rel.startsWith(`..${sep}`) || !PART.test(l.target)) {
      throw new Error(`unsafe symbolic link "${l.path}" -> "${l.target}"`);
    }
    mkdirSync(dirname(join(staging, rel)), { recursive: true });
    symlinkSync(l.target, join(staging, rel));
  }
}

// ── install ─────────────────────────────────────────────────────────────────

export async function installRuntime(o: {
  lock: RuntimeLock;
  cacheDir: string;
  platform: string;
  fetch: typeof fetch;
  maxUnpackedBytes?: number;
}): Promise<{ paths: InstallPaths; downloaded: ("model" | "runtime")[] }> {
  const { lock, cacheDir } = o;
  const asset = lock.runtime.assets[o.platform];
  if (asset === undefined) {
    throw new RuntimeError(
      "unsupported_platform",
      `no ${lock.runtime.name} ${lock.runtime.version} build is pinned for ${o.platform}; run your own embedding server and set UKTUB_EMBED_URL instead`,
    );
  }
  const downloaded: ("model" | "runtime")[] = [];

  const model = modelPathOf(lock, cacheDir);
  if (fileSize(model) !== lock.embedding.size || sha256File(model) !== lock.embedding.sha256) {
    rmSync(model, { force: true });
    await downloadVerified(o.fetch, lock.embedding.url, model, lock.embedding);
    downloaded.push("model");
  }

  if (!runtimeReady(lock, asset, cacheDir)) {
    const finalDir = runtimeDirOf(lock, asset, cacheDir);
    const archive = join(cacheDir, "downloads", `${asset.name}`);
    await downloadVerified(o.fetch, asset.url, archive, asset);
    const staging = `${finalDir}.${process.pid}.${Date.now()}.tmp`;
    mkdirSync(staging, { recursive: true });
    try {
      try {
        if (asset.name.endsWith(".zip")) extractZip(archive, staging, o.maxUnpackedBytes ?? MAX_UNPACKED_BYTES);
        else await extractTarGz(archive, staging);
      } catch (err) {
        throw new RuntimeError("unsafe_archive", `the runtime archive was refused: ${err instanceof Error ? err.message : String(err)}`);
      }
      const binary = join(staging, asset.dir, asset.binary);
      if (fileSize(binary) === null) throw new RuntimeError("missing_binary", `the runtime archive has no ${asset.dir === "" ? "" : `${asset.dir}/`}${asset.binary}`);
      chmodSync(binary, 0o755);
      writeFileSync(join(staging, RECEIPT), JSON.stringify({ sha256: asset.sha256, version: lock.runtime.version }));
      rmSync(finalDir, { recursive: true, force: true });
      renameSync(staging, finalDir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
      rmSync(archive, { force: true });
    }
    downloaded.push("runtime");
  }
  return { paths: { server: serverPathOf(lock, asset, cacheDir), model }, downloaded };
}

// ── supervised server ───────────────────────────────────────────────────────

/** Client policy: a local embedding model loads in seconds; a minute is a hung start. */
export const START_TIMEOUT_MS = 60_000;
/** Client policy: how much of the child's log is kept in a start failure message. */
const LOG_TAIL_CHARS = 300;
/** Client policy: attempts when the chosen port is taken between choosing and binding. */
const BIND_ATTEMPTS = 3;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const tailOf = (path: string): string => {
  try {
    return readFileSync(path, "utf8").replace(/\s+/g, " ").trim().slice(-LOG_TAIL_CHARS);
  } catch {
    return "";
  }
};

export interface ManagedServer {
  url: string;
  pid: number;
  stop(): Promise<void>;
}

export async function startServer(o: { paths: InstallPaths; lock: RuntimeLock; cacheDir: string; timeoutMs?: number }): Promise<ManagedServer> {
  const timeoutMs = o.timeoutMs ?? START_TIMEOUT_MS;
  let last: RuntimeError | null = null;
  for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt++) {
    try {
      return await startOnce(o, await freePort(), timeoutMs);
    } catch (err) {
      if (!(err instanceof RuntimeError) || err.code !== "start_failed" || !/address already in use|EADDRINUSE|bind/i.test(err.message)) throw err;
      last = err; // lost the race for the port: pick another
    }
  }
  throw last!;
}

async function startOnce(o: { paths: InstallPaths; lock: RuntimeLock; cacheDir: string }, port: number, timeoutMs: number): Promise<ManagedServer> {
  const logDir = join(o.cacheDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `llama-server-${port}.log`);
  const fd = openSync(logPath, "w");
  const url = `http://127.0.0.1:${port}`;
  let exited: { code: number | null; signal: string | null } | null = null;
  const child = spawn(o.paths.server, ["-m", o.paths.model, "--host", "127.0.0.1", "--port", String(port), ...o.lock.embedding.serverArgs], { stdio: ["ignore", fd, fd] });
  closeSync(fd);
  let spawnError: Error | null = null;
  child.once("error", (err) => (spawnError = err));
  child.once("exit", (code, signal) => (exited = { code, signal }));
  const killNow = (): void => void child.kill("SIGTERM");
  process.once("exit", killNow);
  const stop = async (): Promise<void> => {
    process.removeListener("exit", killNow);
    if (exited !== null) return;
    child.kill("SIGTERM");
    for (let i = 0; i < 50 && exited === null; i++) await sleep(100);
    if (exited === null) child.kill("SIGKILL");
    for (let i = 0; i < 20 && exited === null; i++) await sleep(50);
  };

  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (spawnError !== null) {
      process.removeListener("exit", killNow);
      throw new RuntimeError("start_failed", `could not start ${o.paths.server}: ${(spawnError as Error).message}`);
    }
    if (exited !== null) {
      process.removeListener("exit", killNow);
      const e = exited as { code: number | null; signal: string | null };
      throw new RuntimeError("start_failed", `llama-server exited during start (${e.signal ?? `code ${e.code}`}): ${tailOf(logPath)}`);
    }
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new RuntimeError("start_timeout", `llama-server did not become healthy within ${timeoutMs} ms: ${tailOf(logPath)}`);
    }
    await sleep(100);
  }
  child.unref();
  return { url, pid: child.pid!, stop };
}

// ── resident server (one per cache directory, for the life of the process) ─────

const resident = new Map<string, ManagedServer>();
const starting = new Map<string, Promise<ManagedServer>>();

/** The servers this process has started (read-only view for tests and diagnostics). */
export const residentServers = (): ReadonlyMap<string, ManagedServer> => resident;

const isHealthy = async (url: string): Promise<boolean> => {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) })).ok;
  } catch {
    return false;
  }
};

/** The managed server for this cache: reused while healthy, restarted when it died, started once when several callers race. */
export async function ensureServer(o: { paths: InstallPaths; lock: RuntimeLock; cacheDir: string; timeoutMs?: number }): Promise<ManagedServer> {
  const key = o.cacheDir;
  const cur = resident.get(key);
  if (cur !== undefined) {
    if (await isHealthy(cur.url)) return cur;
    resident.delete(key);
    await cur.stop().catch(() => undefined);
  }
  let pending = starting.get(key);
  if (pending === undefined) {
    pending = startServer(o)
      .then((s) => {
        resident.set(key, s);
        return s;
      })
      .finally(() => starting.delete(key));
    starting.set(key, pending);
  }
  return pending;
}

export async function stopManagedServers(): Promise<void> {
  const all = [...resident.values()];
  resident.clear();
  await Promise.all(all.map((s) => s.stop().catch(() => undefined)));
}
