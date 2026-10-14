/**
 * Browser implementation of the `node:fs` surface the five-tool graph uses,
 * on top of the sqlite shim (`./sqlite.ts`, `opfs-sahpool` VFS, synchronous).
 *
 * Storage: the project's files (manuscript, refs, papers, evidence, build
 * outputs) live in ONE SQLite database `<root>/.registry/project-files.db`
 * in the same sahpool pool the registry uses:
 *
 *   files(path TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('file','dir')),
 *         mode INTEGER, mtime_ms INTEGER, data BLOB)
 *
 * `PRAGMA user_version = 1` (checked on open; anything else refuses to open),
 * `journal_mode = DELETE`. Every call is one statement, or one transaction
 * for multi-row changes (`BEGIN IMMEDIATE ... COMMIT`): a directory rename
 * is a single prefix `UPDATE`, a recursive remove a single prefix `DELETE`,
 * so a kill lands on either the old or the new tree, never a mixture. NO
 * OPFS directory handles, NO write-behind, NO async flush: a returned call
 * is already durable (direct sahpool writes; proven by the durability spec).
 *
 * Boot order: `ensureBooted()` (sqlite) once in the worker, then
 * `openProjectFiles(root)` (the project lock is the CALLER's job —
 * `src/browser/lock.ts` — this module never takes it). `openProjectFiles`
 * is idempotent for the same root; `closeProjectFiles()` drops the
 * connection (reopen re-reads the same durable rows).
 *
 * Visible-registry rule: `.registry/registry.db` stays a SEPARATE standalone
 * SQLite file in the pool (byte-exact export to the Node tool is a
 * requirement, so project bytes must never alias it). The fs layer makes it
 * VISIBLE as a file at `<root>/.registry/registry.db` for `existsSync`,
 * `statSync` (size read live from the pool), `realpathSync`, `accessSync`
 * and `readdirSync` of its parent — and REFUSES every byte access through
 * fs (`readFileSync`/`writeFileSync`/`rmSync`/`copyFileSync`/`renameSync`
 * from or to it, `chmodSync` of it) with EPERM and a clear message. The core
 * never does those (registry bytes move through the sqlite seam); the one
 * exception is `migrateLegacy`'s v2 backup `copyFileSync`, noted in
 * CORE-CHANGES-NEEDED.md. `<root>/.registry/project-files.db` itself (this
 * layer's own store) is NOT visible through fs.
 *
 * Permissions are emulated, owner-bits only: a cleared 0o200 bit means
 * read-only. `writeFileSync`/`copyFileSync` onto a read-only file fail with
 * EACCES; `renameSync` over a read-only target SUCCEEDS (it needs the
 * directory, not the file — exactly what Node does, and what the
 * `writeBibliography` 0444 + staged-rename dance relies on); `rmSync` of a
 * read-only file succeeds (unlink needs the directory). New files are
 * 0o644, new directories 0o755. `accessSync(path, mode)` checks the mode
 * bits (F_OK/R_OK/W_OK/X_OK). No symlinks: `lstatSync` equals `statSync`,
 * `realpathSync` normalizes `.`/`..` against the virtual root and throws
 * ENOENT (syscall `lstat`) for a missing path like Node.
 *
 * Paths are POSIX, absolute, rooted at a virtual `/`; relative paths resolve
 * against the virtual cwd `/` (the path shim). `URL` and `Uint8Array` paths
 * are accepted like Node; error objects carry Node's `code`, `errno`,
 * `syscall` and `path` with Node's message prefixes (probed on Node 26,
 * Linux: `ENOENT: no such file or directory, open '...'` etc.).
 *
 * Implemented (every name the core imports from `node:fs`): `existsSync`,
 * `readFileSync`, `writeFileSync`, `mkdirSync`, `readdirSync`, `statSync`,
 * `lstatSync`, `realpathSync`, `renameSync`, `copyFileSync`, `rmSync`,
 * `chmodSync`, `accessSync`, `constants` (+ a default export). Fail closed:
 * `openSync`, `closeSync`, `createReadStream`, `createWriteStream`,
 * `symlinkSync`, `readlinkSync`, `appendFileSync`, `mkdtempSync` throw
 * "not implemented in the browser build: fs.<name>" at CALL time.
 *
 * Bundled read-only assets: paths under `/__uktub__/` are served from the
 * build-embedded asset table (`uktub:assets`, see
 * `tests-browser/assets-plugin.mjs`) for `existsSync`, `statSync`,
 * `lstatSync`, `realpathSync`, `readdirSync`, `readFileSync` and `accessSync`
 * (files 0o444, directories 0o555); every write to them fails with EROFS.
 */

import { Buffer, BrowserBuffer } from "./buffer.ts";
import { dirname, resolve as posixResolve } from "./path.ts";
import { DatabaseSync, sahpoolFileBytes } from "./sqlite.ts";
// Bundle-time virtual module (tests-browser/assets-plugin.mjs): read-only
// asset bytes (base64) keyed by virtual absolute path under `/__uktub__/`.
import { UKTUB_ASSETS } from "uktub:assets";

/** Version stamped in `PRAGMA user_version` of project-files.db. */
const PROJECT_FILES_VERSION = 1;

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/** `fs.constants` subset (Linux values, matching Node). */
export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE_FORCE: 4,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_EXCL: 128,
  O_TRUNC: 512,
  O_APPEND: 1024,
  S_IFMT: 61440,
  S_IFREG: 32768,
  S_IFDIR: 16384,
} as const;

type RowKind = "file" | "dir";
interface Row {
  kind: RowKind;
  mode: number;
  mtimeMs: number;
  size: number;
}

let filesDb: DatabaseSync | null = null;
let dbPath = "";
let projectRoot = "/";
let registryAbs = "/.registry/registry.db";
let stmtGet: { get(...p: unknown[]): unknown } | null = null;
let stmtGetData: { get(...p: unknown[]): unknown } | null = null;
let stmtPut: { run(...p: unknown[]): unknown } | null = null;
let stmtDel: { run(...p: unknown[]): unknown } | null = null;
let stmtSubtree: { all(...p: unknown[]): unknown[] } | null = null;

/** Open (or re-confirm) the project-files store for `root`. Idempotent. */
export function openProjectFiles(root: string): void {
  const abs = root === "" ? "/" : posixResolve(root);
  if (filesDb !== null && abs === projectRoot) return;
  closeProjectFiles();
  projectRoot = abs;
  registryAbs = abs === "/" ? "/.registry/registry.db" : `${abs}/.registry/registry.db`;
  dbPath = abs === "/" ? "/.registry/project-files.db" : `${abs}/.registry/project-files.db`;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode=DELETE");
    const row = db.prepare("PRAGMA user_version").get() as Record<string, number> | undefined;
    const version = Number(row?.["user_version"] ?? 0);
    if (version === 0) {
      db.exec(
        "CREATE TABLE files(path TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('file','dir')), " +
          "mode INTEGER, mtime_ms INTEGER, data BLOB)",
      );
      db.exec(`PRAGMA user_version = ${PROJECT_FILES_VERSION}`);
    } else if (version !== PROJECT_FILES_VERSION) {
      throw new Error(
        `project-files database at ${dbPath} has user_version ${version} (this build reads ${PROJECT_FILES_VERSION}); refusing to open`,
      );
    } else {
      // Known version but possibly a foreign file: the table must be there.
      const t = db
        .prepare("SELECT name AS n FROM sqlite_master WHERE type='table' AND name='files'")
        .get() as Record<string, unknown> | undefined;
      if (!t) {
        throw new Error(`project-files database at ${dbPath} has no files table; refusing to open`);
      }
    }
    filesDb = db;
    stmtGet = db.prepare("SELECT kind, mode, mtime_ms, length(data) AS size FROM files WHERE path = ?") as never;
    stmtGetData = db.prepare("SELECT data FROM files WHERE path = ? AND kind = 'file'") as never;
    stmtPut = db.prepare(
      "INSERT INTO files(path, kind, mode, mtime_ms, data) VALUES(?, ?, ?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, mode=excluded.mode, " +
        "mtime_ms=excluded.mtime_ms, data=excluded.data",
    ) as never;
    stmtDel = db.prepare("DELETE FROM files WHERE path = ?") as never;
    stmtSubtree = db.prepare("SELECT path, kind FROM files WHERE path = ? OR path LIKE ? ESCAPE '\\'") as never;
    putRow(abs, "dir", DEFAULT_DIR_MODE, null);
  } catch (err) {
    try {
      db.close();
    } catch {
      // The open already failed; that error is the report.
    }
    filesDb = null;
    throw err;
  }
}

/** Drop the project-files connection (rows stay durable in the pool). */
export function closeProjectFiles(): void {
  stmtGet = stmtGetData = stmtPut = stmtDel = stmtSubtree = null;
  if (filesDb !== null) {
    try {
      filesDb.close();
    } finally {
      filesDb = null;
    }
  }
}

/** True while a project-files store is open in this worker. */
export function isProjectFilesOpen(): boolean {
  return filesDb !== null;
}

/** `PRAGMA integrity_check` of the open project-files database. */
export function projectFilesIntegrityCheck(): string {
  const db = requireDb();
  const rows = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
  return rows.map((r) => String(Object.values(r)[0])).join("; ");
}

/** Live byte size of the project-files database file in the pool. */
export function projectFilesDbBytes(): number {
  const bytes = sahpoolFileBytes(dbPath);
  if (bytes === null) throw new Error(`project-files database missing from the pool at ${dbPath}`);
  return bytes.length;
}

/** Live byte size of the standalone registry database file in the pool. */
export function registryDbBytes(): number | null {
  return sahpoolFileBytes(registryAbs)?.length ?? null;
}

// ---------------------------------------------------------------------------
// Errors (Node shapes, probed on Node 26/Linux)
// ---------------------------------------------------------------------------

const ERRNO: Record<string, number> = {
  EPERM: -1,
  ENOENT: -2,
  EACCES: -13,
  EEXIST: -17,
  ENOTDIR: -20,
  EISDIR: -21,
  EINVAL: -22,
  ERR_FS_EISDIR: 21,
};

function fsError(code: string, syscall: string, pathField: string, message: string): Error {
  // Probed on Node 26: libuv-origin failures are plain `Error` (constructor
  // and name both "Error"); only the JS-level rm guard below is SystemError.
  return Object.assign(new Error(message), { code, errno: ERRNO[code] ?? -1, syscall, path: pathField });
}

function rmDirError(display: string): Error {
  const err = new Error(`Path is a directory: rm returned EISDIR (is a directory) ${display}`);
  err.name = "SystemError";
  Object.setPrototypeOf(err, RmSystemError.prototype);
  return Object.assign(err, { code: "ERR_FS_EISDIR", errno: ERRNO["ERR_FS_EISDIR"], syscall: "rm", path: display });
}

class RmSystemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemError";
  }
}
// The constructor name is what the differential norm reads (`__error`).
Object.defineProperty(RmSystemError, "name", { value: "SystemError" });

const notImpl = (name: string): ((...args: any[]) => never) =>
  (..._args: any[]): never => {
    throw new Error(`not implemented in the browser build: fs.${name}`);
  };

function isRegistryPath(abs: string): boolean {
  return abs === registryAbs;
}

function registryRefusal(syscall: string, display: string): Error {
  return fsError(
    "EPERM",
    syscall,
    display,
    `EPERM: operation not permitted, ${syscall} '${display}' (the registry database is not reachable through fs; use the sqlite seam)`,
  );
}

// ---------------------------------------------------------------------------
// Bundled read-only assets under `/__uktub__/` (task 1)
// ---------------------------------------------------------------------------
// The esbuild asset plugin rewrites `import.meta.url` in `src/core/**` to a
// virtual `file:///__uktub__/<module path>` URL and embeds every
// `new URL("<literal>", import.meta.url)` target as base64 in the virtual
// `uktub:assets` module. This layer serves those bytes for the read calls the
// core makes (`openRegistry`'s schema read, lock-file reads) and refuses every
// write with EROFS. Assets need no open store: they are memory-resident.

const ASSET_ROOT = "/__uktub__";

function isAssetPath(abs: string): boolean {
  return abs === ASSET_ROOT || abs.startsWith(`${ASSET_ROOT}/`);
}

const assetCache = new Map<string, Uint8Array>();

/** Decoded bytes of an asset file, or null when `abs` names no asset file. */
function assetBytes(abs: string): Uint8Array | null {
  const hit = assetCache.get(abs);
  if (hit !== undefined) return hit;
  const b64 = (UKTUB_ASSETS as Record<string, string>)[abs];
  if (typeof b64 !== "string") return null;
  const raw = Buffer.from(b64, "base64" as never);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice();
  assetCache.set(abs, bytes);
  return bytes;
}

/** True when `abs` is `/__uktub__` itself or a prefix directory of an asset. */
function assetIsDir(abs: string): boolean {
  if (abs === ASSET_ROOT) return true;
  const prefix = `${abs}/`;
  for (const key of Object.keys(UKTUB_ASSETS)) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/** Immediate child names of an asset directory (unsorted, like Node). */
function assetChildNames(abs: string): string[] {
  const prefix = abs === ASSET_ROOT ? `${ASSET_ROOT}/` : `${abs}/`;
  const out = new Set<string>();
  for (const key of Object.keys(UKTUB_ASSETS)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (rest !== "") out.add(rest.split("/")[0]);
  }
  return [...out];
}

function assetReadonly(syscall: string, display: string): Error {
  return fsError("EROFS", syscall, display, `EROFS: read-only file system, ${syscall} '${display}'`);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

type InputPath = string | URL | Uint8Array | ArrayBuffer | DataView;

function pathToString(p: InputPath): string {
  if (typeof p === "string") return p;
  if (p instanceof URL) {
    if (p.protocol !== "file:") {
      throw Object.assign(new TypeError(`The argument 'path' must be a file: URL`), {
        code: "ERR_INVALID_ARG_TYPE",
      });
    }
    return decodeURIComponent(p.pathname);
  }
  if (p instanceof Uint8Array) return new TextDecoder().decode(p);
  if (p instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(p));
  if (ArrayBuffer.isView(p)) {
    const v = p as unknown as DataView;
    return new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  throw Object.assign(
    new TypeError(`The argument 'path' must be a string, Uint8Array, or URL. Received ${typeof p}`),
    { code: "ERR_INVALID_ARG_TYPE" },
  );
}

/** Display form for messages (Node echoes the input as given). */
function displayOf(p: InputPath): string {
  try {
    const s = pathToString(p);
    if (p instanceof URL) return s;
    return typeof p === "string" ? p : s;
  } catch {
    return String(p);
  }
}

/**
 * Normalize to an absolute virtual path (`""` stays `""`, always missing).
 * Throws TypeError on null bytes like Node (`ERR_INVALID_ARG_VALUE`).
 */
function toAbs(p: InputPath): string {
  const s = pathToString(p);
  if (s.includes("\0")) {
    throw Object.assign(new TypeError("The argument 'path' must be a string or Uint8Array without null bytes"), {
      code: "ERR_INVALID_ARG_VALUE",
    });
  }
  if (s === "") return "";
  return posixResolve(s);
}

// ---------------------------------------------------------------------------
// Store access
// ---------------------------------------------------------------------------

function requireDb(): DatabaseSync {
  if (filesDb === null) throw new Error("fs shim used before openProjectFiles() (call it once per project)");
  return filesDb;
}

function getRow(abs: string): Row | null {
  if (abs === "" || abs === "/") return abs === "/" ? { kind: "dir", mode: DEFAULT_DIR_MODE, mtimeMs: 0, size: 0 } : null;
  if (isRegistryPath(abs)) {
    const bytes = sahpoolFileBytes(abs);
    if (bytes === null) return null;
    return { kind: "file", mode: 0o644, mtimeMs: Date.now(), size: bytes.length };
  }
  const r = (stmtGet as unknown as { get(p: string): RowRec | undefined }).get(abs) as RowRec | undefined;
  if (!r) return null;
  return { kind: r.kind, mode: r.mode, mtimeMs: r.mtime_ms, size: r.size ?? 0 };
}

interface RowRec {
  kind: RowKind;
  mode: number;
  mtime_ms: number;
  size: number | null;
}

function putRow(abs: string, kind: RowKind, mode: number, data: Uint8Array | null): void {
  requireDb();
  (stmtPut as unknown as { run(...p: unknown[]): unknown }).run(abs, kind, mode, Date.now(), data);
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Walk the ancestor chain outermost-first (kernel order): the first missing
 * ancestor throws ENOENT, the first file ancestor throws ENOTDIR.
 */
function ensureParentDir(abs: string, syscall: string, display: string): void {
  const chain: string[] = [];
  let cur = dirname(abs);
  while (true) {
    chain.unshift(cur);
    if (cur === "/") break;
    cur = dirname(cur);
  }
  for (const c of chain) {
    if (c === "/") continue;
    const row = getRow(c);
    if (!row) throw fsError("ENOENT", syscall, display, `ENOENT: no such file or directory, ${syscall} '${display}'`);
    if (row.kind !== "dir") throw fsError("ENOTDIR", syscall, display, `ENOTDIR: not a directory, ${syscall} '${display}'`);
  }
}

/** Immediate child names of a directory (unsorted, like Node). */
function childNames(abs: string): string[] {
  requireDb();
  const prefix = abs === "/" ? "/" : `${abs}/`;
  const rows = (stmtSubtree as unknown as { all(a: string, b: string): Array<{ path: string; kind: string }> }).all(
    abs,
    `${escapeLike(prefix)}%`,
  );
  const out: string[] = [];
  for (const r of rows) {
    if (r.path === abs || !r.path.startsWith(prefix)) continue;
    const rest = r.path.slice(prefix.length);
    if (rest !== "" && !rest.includes("/")) out.push(rest);
  }
  if ((abs === "/" ? "/.registry" : `${projectRoot}/.registry`) === abs || dirname(registryAbs) === abs) {
    if (sahpoolFileBytes(registryAbs) !== null && !out.includes("registry.db")) out.push("registry.db");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stats / Dirent
// ---------------------------------------------------------------------------

export class Stats {
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly mtime: Date;
  readonly atimeMs: number;
  readonly atime: Date;
  readonly ctimeMs: number;
  readonly ctime: Date;
  readonly birthtimeMs: number;
  readonly birthtime: Date;
  private readonly kind: RowKind;
  constructor(kind: RowKind, size: number, mode: number, mtimeMs: number) {
    this.kind = kind;
    this.size = size;
    this.mode = (kind === "dir" ? S_IFDIR : S_IFREG) | (mode & 0o7777);
    this.mtimeMs = mtimeMs;
    this.mtime = new Date(mtimeMs);
    this.atimeMs = mtimeMs;
    this.atime = new Date(mtimeMs);
    this.ctimeMs = mtimeMs;
    this.ctime = new Date(mtimeMs);
    this.birthtimeMs = mtimeMs;
    this.birthtime = new Date(mtimeMs);
  }
  isFile(): boolean {
    return this.kind === "file";
  }
  isDirectory(): boolean {
    return this.kind === "dir";
  }
  isSymbolicLink(): boolean {
    return false;
  }
  isFIFO(): boolean {
    return false;
  }
  isSocket(): boolean {
    return false;
  }
  isCharacterDevice(): boolean {
    return false;
  }
  isBlockDevice(): boolean {
    return false;
  }
}

export class Dirent {
  readonly name: string;
  readonly parentPath: string;
  private readonly kind: RowKind;
  constructor(name: string, parentPath: string, kind: RowKind) {
    this.name = name;
    this.parentPath = parentPath;
    this.kind = kind;
  }
  get path(): string {
    return this.parentPath;
  }
  isFile(): boolean {
    return this.kind === "file";
  }
  isDirectory(): boolean {
    return this.kind === "dir";
  }
  isSymbolicLink(): boolean {
    return false;
  }
  isFIFO(): boolean {
    return false;
  }
  isSocket(): boolean {
    return false;
  }
  isCharacterDevice(): boolean {
    return false;
  }
  isBlockDevice(): boolean {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Implemented surface
// ---------------------------------------------------------------------------

export function existsSync(p: InputPath): boolean {
  try {
    const abs = toAbs(p);
    if (isAssetPath(abs)) return assetBytes(abs) !== null || assetIsDir(abs);
    if (filesDb === null) return false;
    if (abs === "/") return true;
    return getRow(abs) !== null;
  } catch {
    return false;
  }
}

function statImpl(p: InputPath, syscall: "stat" | "lstat"): Stats {
  requireDb();
  const display = displayOf(p);
  const s = pathToString(p);
  if (s.includes("\0")) {
    throw Object.assign(new TypeError("The argument 'path' must be a string or Uint8Array without null bytes"), {
      code: "ERR_INVALID_ARG_VALUE",
    });
  }
  const abs = s === "" ? "" : posixResolve(s);
  const trailing = s.length > 1 && s.endsWith("/");
  if (isAssetPath(abs)) {
    const bytes = assetBytes(abs);
    if (bytes !== null) {
      if (trailing) {
        throw fsError("ENOTDIR", syscall, display, `ENOTDIR: not a directory, ${syscall} '${display}'`);
      }
      return new Stats("file", bytes.length, 0o444, 0);
    }
    if (assetIsDir(abs)) return new Stats("dir", 0, 0o555, 0);
    throw fsError("ENOENT", syscall, display, `ENOENT: no such file or directory, ${syscall} '${display}'`);
  }
  if (abs === "" || abs === "/") {
    if (abs === "") throw fsError("ENOENT", syscall, display, `ENOENT: no such file or directory, ${syscall} '${display}'`);
    return new Stats("dir", 0, DEFAULT_DIR_MODE, Date.now());
  }
  // Ancestor walk first (kernel order), then the leaf.
  const chain: string[] = [];
  let cur = abs;
  while (cur !== "/") {
    chain.unshift(cur);
    cur = dirname(cur);
  }
  for (const c of chain.slice(0, -1)) {
    const row = getRow(c);
    if (!row) throw fsError("ENOENT", syscall, display, `ENOENT: no such file or directory, ${syscall} '${display}'`);
    if (row.kind !== "dir") throw fsError("ENOTDIR", syscall, display, `ENOTDIR: not a directory, ${syscall} '${display}'`);
  }
  const row = getRow(abs);
  if (!row) throw fsError("ENOENT", syscall, display, `ENOENT: no such file or directory, ${syscall} '${display}'`);
  if (trailing && row.kind === "file") {
    throw fsError("ENOTDIR", syscall, display, `ENOTDIR: not a directory, ${syscall} '${display}'`);
  }
  return new Stats(row.kind, row.kind === "file" ? row.size : 0, row.mode, row.mtimeMs);
}

export function statSync(p: InputPath): Stats {
  return statImpl(p, "stat");
}

export function lstatSync(p: InputPath): Stats {
  return statImpl(p, "lstat");
}

export function realpathSync(p: InputPath): string {
  const display = displayOf(p);
  const abs = toAbs(p);
  if (isAssetPath(abs)) {
    if (assetBytes(abs) !== null || assetIsDir(abs)) return abs;
    throw fsError("ENOENT", "lstat", display, `ENOENT: no such file or directory, lstat '${display}'`);
  }
  requireDb();
  if (abs === "") throw fsError("ENOENT", "lstat", display, `ENOENT: no such file or directory, lstat '${display}'`);
  // Realpath resolves `.`/`..` lexically (no symlinks exist); every surviving
  // component must exist, innermost leaf included (Node: ENOENT/lstat).
  const chain: string[] = [];
  let cur = abs;
  while (cur !== "/") {
    chain.unshift(cur);
    cur = dirname(cur);
  }
  for (const c of chain) {
    const row = getRow(c);
    if (!row) throw fsError("ENOENT", "lstat", display, `ENOENT: no such file or directory, lstat '${display}'`);
    if (row.kind !== "dir" && c !== abs) {
      throw fsError("ENOTDIR", "lstat", display, `ENOTDIR: not a directory, lstat '${display}'`);
    }
  }
  return abs;
}

function bytesFromString(s: string, encoding: string): Uint8Array {
  const raw = Buffer.from(s, ((encoding === "binary" ? "latin1" : encoding) || "utf8") as never);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice();
}

function toBytes(data: unknown, encoding?: string): Uint8Array {
  if (typeof data === "string") return bytesFromString(data, encoding ?? "utf8");
  if (data instanceof Uint8Array) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    const v = data as unknown as DataView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
  }
  throw Object.assign(new TypeError("The argument 'data' must be a string, Uint8Array, or ArrayBuffer"), {
    code: "ERR_INVALID_ARG_TYPE",
  });
}

type ReadOptions = string | { encoding?: string | null } | undefined | null;
type WriteOptions = string | { encoding?: string; flag?: string; mode?: number } | undefined | null;

function readEncodingOf(opt: ReadOptions): string | null {
  if (opt === undefined || opt === null) return null;
  if (typeof opt === "string") return opt;
  return (opt.encoding ?? null) as string | null;
}

/** With a string/string-encoding options: a decoded string (Node overloads). */
export function readFileSync(p: InputPath, options: string | { encoding: string }): string;
/** Without an encoding: a Buffer (a `Uint8Array` subclass, like Node). */
export function readFileSync(p: InputPath, options?: ReadOptions): BrowserBuffer;
export function readFileSync(p: InputPath, options?: ReadOptions): BrowserBuffer | string {
  const display = displayOf(p);
  const abs = toAbs(p);
  if (isAssetPath(abs)) {
    const bytes = assetBytes(abs);
    if (bytes !== null) {
      const buf = Buffer.from(bytes);
      const enc = readEncodingOf(options);
      if (enc === null) return buf;
      return buf.toString(enc as never);
    }
    if (assetIsDir(abs)) throw fsError("EISDIR", "read", display, "EISDIR: illegal operation on a directory, read");
    throw fsError("ENOENT", "open", display, `ENOENT: no such file or directory, open '${display}'`);
  }
  const db = requireDb();
  if (isRegistryPath(abs)) throw registryRefusal("open", display);
  if (abs === "") throw fsError("ENOENT", "open", display, `ENOENT: no such file or directory, open '${display}'`);
  ensureParentDir(abs, "open", display);
  const row = getRow(abs);
  if (!row) throw fsError("ENOENT", "open", display, `ENOENT: no such file or directory, open '${display}'`);
  if (row.kind === "dir") throw fsError("EISDIR", "read", display, "EISDIR: illegal operation on a directory, read");
  const rec = (stmtGetData as unknown as { get(x: string): { data: Uint8Array } | undefined }).get(abs);
  const bytes = rec?.data instanceof Uint8Array ? rec.data : new Uint8Array(rec?.data as unknown as ArrayBuffer);
  const buf = Buffer.from(bytes);
  const enc = readEncodingOf(options);
  if (enc === null) return buf;
  return buf.toString(enc as never);
}

export function writeFileSync(p: InputPath, data: unknown, options?: WriteOptions): void {
  const display = displayOf(p);
  const abs = toAbs(p);
  if (isAssetPath(abs)) throw assetReadonly("open", display);
  requireDb();
  if (isRegistryPath(abs)) throw registryRefusal("open", display);
  if (abs === "") throw fsError("ENOENT", "open", display, `ENOENT: no such file or directory, open '${display}'`);
  let flag = "w";
  let encoding = "utf8";
  let createMode = DEFAULT_FILE_MODE;
  if (typeof options === "string") encoding = options;
  else if (options !== undefined && options !== null) {
    if (options.encoding !== undefined) encoding = options.encoding;
    if (options.flag !== undefined) flag = options.flag;
    if (options.mode !== undefined) createMode = Number(options.mode) & 0o777;
  }
  if (flag !== "w" && flag !== "wx" && flag !== "a") {
    throw new Error(`not implemented in the browser build: fs.writeFileSync flag ${JSON.stringify(flag)}`);
  }
  ensureParentDir(abs, "open", display);
  const row = getRow(abs);
  if (row?.kind === "dir") throw fsError("EISDIR", "open", display, `EISDIR: illegal operation on a directory, open '${display}'`);
  if (flag === "wx" && row) throw fsError("EEXIST", "open", display, `EEXIST: file already exists, open '${display}'`);
  if (row && (row.mode & 0o200) === 0) {
    throw fsError("EACCES", "open", display, `EACCES: permission denied, open '${display}'`);
  }
  const incoming = toBytes(data, encoding);
  if (flag === "a" && row) {
    const rec = (stmtGetData as unknown as { get(x: string): { data: Uint8Array } | undefined }).get(abs);
    const prev = rec?.data ?? new Uint8Array(0);
    const joined = new Uint8Array(prev.length + incoming.length);
    joined.set(prev, 0);
    joined.set(incoming, prev.length);
    putRow(abs, "file", row.mode, joined);
    return;
  }
  putRow(abs, "file", row ? row.mode : createMode, incoming);
}

export function mkdirSync(p: InputPath, options?: { recursive?: boolean; mode?: number }): void {
  const display = displayOf(p);
  const abs = toAbs(p);
  if (isAssetPath(abs)) throw assetReadonly("mkdir", display);
  requireDb();
  if (abs === "" || abs === "/") return;
  if (isRegistryPath(abs)) throw registryRefusal("mkdir", display);
  const recursive = options?.recursive ?? false;
  const mode = options?.mode !== undefined ? Number(options.mode) & 0o777 : DEFAULT_DIR_MODE;
  const existing = getRow(abs);
  if (existing) {
    if (existing.kind === "dir") {
      if (recursive) return;
      throw fsError("EEXIST", "mkdir", display, `EEXIST: file already exists, mkdir '${display}'`);
    }
    throw fsError("EEXIST", "mkdir", display, `EEXIST: file already exists, mkdir '${display}'`);
  }
  // Ancestor chain outermost-first.
  const chain: string[] = [];
  let cur = dirname(abs);
  while (cur !== "/") {
    chain.unshift(cur);
    cur = dirname(cur);
  }
  for (const c of chain) {
    const row = getRow(c);
    if (!row) {
      if (!recursive) throw fsError("ENOENT", "mkdir", display, `ENOENT: no such file or directory, mkdir '${display}'`);
      putRow(c, "dir", DEFAULT_DIR_MODE, null);
      continue;
    }
    if (row.kind !== "dir") throw fsError("ENOTDIR", "mkdir", display, `ENOTDIR: not a directory, mkdir '${display}'`);
  }
  putRow(abs, "dir", mode, null);
}

export function readdirSync(p: InputPath, options: { withFileTypes: true; encoding?: string }): Dirent[];
export function readdirSync(p: InputPath, options?: { withFileTypes?: false; encoding?: string }): string[];
export function readdirSync(p: InputPath, options?: { withFileTypes?: boolean; encoding?: string }): string[] | Dirent[] {
  const display = displayOf(p);
  const abs = toAbs(p);
  if (isAssetPath(abs)) {
    if (assetBytes(abs) !== null) {
      throw fsError("ENOTDIR", "scandir", display, `ENOTDIR: not a directory, scandir '${display}'`);
    }
    if (!assetIsDir(abs)) {
      throw fsError("ENOENT", "scandir", display, `ENOENT: no such file or directory, scandir '${display}'`);
    }
    const names = assetChildNames(abs);
    if (options?.withFileTypes === true) {
      return names.map((n) => {
        const child = abs === ASSET_ROOT ? `${ASSET_ROOT}/${n}` : `${abs}/${n}`;
        return new Dirent(n, abs, assetBytes(child) !== null ? "file" : "dir");
      });
    }
    return names;
  }
  requireDb();
  if (abs === "") throw fsError("ENOENT", "scandir", display, `ENOENT: no such file or directory, scandir '${display}'`);
  if (abs !== "/") {
    // Ancestor walk (kernel order) then the leaf.
    const chain: string[] = [];
    let cur = abs;
    while (cur !== "/") {
      chain.unshift(cur);
      cur = dirname(cur);
    }
    for (const c of chain.slice(0, -1)) {
      const row = getRow(c);
      if (!row) throw fsError("ENOENT", "scandir", display, `ENOENT: no such file or directory, scandir '${display}'`);
      if (row.kind !== "dir")
        throw fsError("ENOTDIR", "scandir", display, `ENOTDIR: not a directory, scandir '${display}'`);
    }
    const leaf = getRow(abs);
    if (!leaf) throw fsError("ENOENT", "scandir", display, `ENOENT: no such file or directory, scandir '${display}'`);
    if (leaf.kind !== "dir")
      throw fsError("ENOTDIR", "scandir", display, `ENOTDIR: not a directory, scandir '${display}'`);
  }
  const names = childNames(abs);
  if (options?.withFileTypes === true) {
    return names.map((n) => {
      const child = abs === "/" ? `/${n}` : `${abs}/${n}`;
      const row = getRow(child);
      return new Dirent(n, abs, row?.kind ?? "file");
    });
  }
  return names;
}

export function renameSync(oldPath: InputPath, newPath: InputPath): void {
  const db = requireDb();
  const sDisplay = displayOf(oldPath);
  const dDisplay = displayOf(newPath);
  const src = toAbs(oldPath);
  const dest = toAbs(newPath);
  if (isAssetPath(src)) throw assetReadonly("rename", sDisplay);
  if (isAssetPath(dest)) throw assetReadonly("rename", dDisplay);
  if (isRegistryPath(src)) throw registryRefusal("rename", sDisplay);
  if (isRegistryPath(dest)) throw registryRefusal("rename", dDisplay);
  const fail = (code: string, prefix: string): Error =>
    fsError(code, "rename", src, `${code}: ${prefix}, rename '${sDisplay}' -> '${dDisplay}'`);
  if (src === "") throw fail("ENOENT", "no such file or directory");
  // Source chain (kernel order).
  {
    const chain: string[] = [];
    let cur = src;
    while (cur !== "/") {
      chain.unshift(cur);
      cur = dirname(cur);
    }
    for (const c of chain.slice(0, -1)) {
      const row = getRow(c);
      if (!row) throw fail("ENOENT", "no such file or directory");
      if (row.kind !== "dir") throw fail("ENOTDIR", "not a directory");
    }
  }
  const srcRow = getRow(src);
  if (!srcRow) throw fail("ENOENT", "no such file or directory");
  if (srcRow.kind === "dir" && src === "/") throw fail("EINVAL", "invalid argument");
  if (dest === "" || dest === "/") throw fail("EINVAL", "invalid argument");
  if (src === dest) return;
  if (srcRow.kind === "dir" && dest.startsWith(`${src}/`)) throw fail("EINVAL", "invalid argument");
  // Destination parent walk (kernel order); messages still name both ends.
  {
    const chain: string[] = [];
    let cur = dirname(dest);
    while (true) {
      chain.unshift(cur);
      if (cur === "/") break;
      cur = dirname(cur);
    }
    for (const c of chain) {
      if (c === "/") continue;
      const row = getRow(c);
      if (!row) throw fail("ENOENT", "no such file or directory");
      if (row.kind !== "dir") throw fail("ENOTDIR", "not a directory");
    }
  }
  const destRow = getRow(dest);
  if (destRow) {
    if (srcRow.kind === "file" && destRow.kind === "dir") throw fail("EISDIR", "illegal operation on a directory");
    if (srcRow.kind === "dir" && destRow.kind === "file") throw fail("ENOTDIR", "not a directory");
    if (srcRow.kind === "dir" && destRow.kind === "dir") {
      const kids = childNames(dest);
      if (kids.length > 0) throw fail("ENOTEMPTY", "directory not empty");
      (stmtDel as unknown as { run(x: string): unknown }).run(dest);
    } else {
      // File over file (even read-only): the directory entry is replaced.
      (stmtDel as unknown as { run(x: string): unknown }).run(dest);
    }
  }
  if (srcRow.kind === "file") {
    const bytes = readRawBytes(src) ?? new Uint8Array(0);
    db.exec("BEGIN IMMEDIATE");
    try {
      (stmtDel as unknown as { run(x: string): unknown }).run(src);
      putRow(dest, "file", srcRow.mode, bytes);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The original error is the report.
      }
      throw err;
    }
    return;
  }
  // Directory: one prefix UPDATE in one transaction (atomic either/or).
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE files SET path = ? || substr(path, ?) WHERE path = ? OR path LIKE ? ESCAPE '\\'").run(
      dest,
      src.length + 1,
      src,
      `${escapeLike(src)}/%`,
    );
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original error is the report.
    }
    throw err;
  }
}

function readRawBytes(abs: string): Uint8Array | null {
  const rec = (stmtGetData as unknown as { get(x: string): { data: Uint8Array } | undefined }).get(abs);
  if (!rec || rec.data === null || rec.data === undefined) return null;
  return rec.data instanceof Uint8Array ? rec.data : new Uint8Array(rec.data as unknown as ArrayBuffer);
}

export function copyFileSync(src: InputPath, dest: InputPath, mode?: number): void {
  const sDisplay = displayOf(src);
  const dDisplay = displayOf(dest);
  const s = toAbs(src);
  const d = toAbs(dest);
  if (isAssetPath(s)) throw assetReadonly("copyfile", sDisplay);
  if (isAssetPath(d)) throw assetReadonly("copyfile", dDisplay);
  requireDb();
  if (isRegistryPath(s)) throw registryRefusal("copyfile", sDisplay);
  if (isRegistryPath(d)) throw registryRefusal("copyfile", dDisplay);
  const fail = (code: string, prefix: string): Error =>
    fsError(code, "copyfile", s, `${code}: ${prefix}, copyfile '${sDisplay}' -> '${dDisplay}'`);
  if (s === "") throw fail("ENOENT", "no such file or directory");
  {
    const chain: string[] = [];
    let cur = s;
    while (cur !== "/") {
      chain.unshift(cur);
      cur = dirname(cur);
    }
    for (const c of chain.slice(0, -1)) {
      const row = getRow(c);
      if (!row) throw fail("ENOENT", "no such file or directory");
      if (row.kind !== "dir") throw fail("ENOTDIR", "not a directory");
    }
  }
  const srcRow = getRow(s);
  if (!srcRow) throw fail("ENOENT", "no such file or directory");
  if (srcRow.kind === "dir") throw fail("EISDIR", "illegal operation on a directory");
  if (d === "" || d === "/") throw fail("EISDIR", "illegal operation on a directory");
  {
    const chain: string[] = [];
    let cur = dirname(d);
    while (true) {
      chain.unshift(cur);
      if (cur === "/") break;
      cur = dirname(cur);
    }
    for (const c of chain) {
      if (c === "/") continue;
      const row = getRow(c);
      if (!row) throw fail("ENOENT", "no such file or directory");
      if (row.kind !== "dir") throw fail("ENOTDIR", "not a directory");
    }
  }
  const destRow = getRow(d);
  if (destRow?.kind === "dir") throw fail("EISDIR", "illegal operation on a directory");
  if (destRow && (mode ?? 0) & constants.COPYFILE_EXCL) throw fail("EEXIST", "file already exists");
  if (destRow && (destRow.mode & 0o200) === 0) throw fail("EACCES", "permission denied");
  const bytes = readRawBytes(s) ?? new Uint8Array(0);
  putRow(d, "file", destRow ? destRow.mode : srcRow.mode & 0o777, bytes);
}

export function rmSync(p: InputPath, options?: { recursive?: boolean; force?: boolean }): void {
  const db = requireDb();
  const display = displayOf(p);
  const abs = toAbs(p);
  const recursive = options?.recursive ?? false;
  const force = options?.force ?? false;
  if (isAssetPath(abs)) throw assetReadonly("unlink", display);
  if (isRegistryPath(abs)) throw registryRefusal("unlink", display);
  if (abs === "" || abs === "/") {
    if (abs === "/" && !force) {
      throw rmDirError(display);
    }
    if (abs === "") {
      if (force) return;
      throw fsError("ENOENT", "lstat", display, `ENOENT: no such file or directory, lstat '${display}'`);
    }
    throw rmDirError(display);
  }
  {
    const chain: string[] = [];
    let cur = abs;
    while (cur !== "/") {
      chain.unshift(cur);
      cur = dirname(cur);
    }
    for (const c of chain.slice(0, -1)) {
      const row = getRow(c);
      if (!row) {
        if (force) return;
        throw fsError("ENOENT", "lstat", display, `ENOENT: no such file or directory, lstat '${display}'`);
      }
      if (row.kind !== "dir") {
        if (force) return;
        throw fsError("ENOTDIR", "lstat", display, `ENOTDIR: not a directory, lstat '${display}'`);
      }
    }
  }
  const row = getRow(abs);
  if (!row) {
    if (force) return;
    throw fsError("ENOENT", "lstat", display, `ENOENT: no such file or directory, lstat '${display}'`);
  }
  if (row.kind === "dir" && !recursive) {
    throw rmDirError(display);
  }
  if (row.kind === "file") {
    (stmtDel as unknown as { run(x: string): unknown }).run(abs);
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM files WHERE path = ? OR path LIKE ? ESCAPE '\\'").run(abs, `${escapeLike(abs)}/%`);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original error is the report.
    }
    throw err;
  }
}

export function chmodSync(p: InputPath, mode: number): void {
  const display = displayOf(p);
  const abs = toAbs(p);
  if (isAssetPath(abs)) throw assetReadonly("chmod", display);
  requireDb();
  if (isRegistryPath(abs)) throw registryRefusal("chmod", display);
  if (abs === "") throw fsError("ENOENT", "chmod", display, `ENOENT: no such file or directory, chmod '${display}'`);
  ensureParentDir(abs, "chmod", display);
  const row = getRow(abs);
  if (!row) throw fsError("ENOENT", "chmod", display, `ENOENT: no such file or directory, chmod '${display}'`);
  requireDb().prepare("UPDATE files SET mode = ? WHERE path = ?").run(Number(mode) & 0o7777, abs);
}

export function accessSync(p: InputPath, mode?: number): void {
  const display = displayOf(p);
  const abs = toAbs(p);
  const want = mode ?? constants.F_OK;
  const fail = (code: "ENOENT" | "EACCES", prefix: string): Error =>
    fsError(code, "access", display, `${code}: ${prefix}, access '${display}'`);
  if (isAssetPath(abs)) {
    // Assets are read-only files (0o444) and traversable directories (0o555).
    const bytes = assetBytes(abs);
    if (bytes !== null) {
      if ((want & constants.W_OK) !== 0) throw fail("EACCES", "permission denied");
      if ((want & constants.X_OK) !== 0) throw fail("EACCES", "permission denied");
      return;
    }
    if (assetIsDir(abs)) {
      if ((want & constants.W_OK) !== 0) throw fail("EACCES", "permission denied");
      return;
    }
    throw fail("ENOENT", "no such file or directory");
  }
  requireDb();
  if (abs === "/") {
    if ((want & constants.W_OK) !== 0 && (DEFAULT_DIR_MODE & 0o200) === 0) throw fail("EACCES", "permission denied");
    if ((want & constants.X_OK) !== 0 && (DEFAULT_DIR_MODE & 0o100) === 0) throw fail("EACCES", "permission denied");
    return;
  }
  {
    const chain: string[] = [];
    let cur = abs;
    while (cur !== "/") {
      chain.unshift(cur);
      cur = dirname(cur);
    }
    for (const c of chain.slice(0, -1)) {
      const row = getRow(c);
      if (!row) throw fail("ENOENT", "no such file or directory");
      if (row.kind !== "dir") throw fsError("ENOTDIR", "access", display, `ENOTDIR: not a directory, access '${display}'`);
    }
  }
  const row = getRow(abs);
  if (!row) throw fail("ENOENT", "no such file or directory");
  if ((want & constants.W_OK) !== 0 && (row.mode & 0o200) === 0) throw fail("EACCES", "permission denied");
  if ((want & constants.X_OK) !== 0 && (row.mode & 0o100) === 0) throw fail("EACCES", "permission denied");
}

// Fail closed: used by future seams (engines/download), never by the tools.
// Typed wide (`any`) so the engine files that call them keep typechecking;
// every call still throws at CALL time, never at import time.
type AnyFn = (...args: any[]) => any;
/** Minimal stream face for the throwing create*Stream stubs: method calls on
 * the result keep typechecking (contextually typed listeners); the calls
 * themselves still throw at CALL time. */
export interface FsStream {
  on(event: string, listener: (...args: any[]) => void): FsStream;
  once(event: string, listener: (...args: any[]) => void): FsStream;
  pipe(dest: unknown): FsStream;
  end(data?: unknown): void;
}
export const openSync: AnyFn = notImpl("openSync");
export const closeSync: AnyFn = notImpl("closeSync");
export const createReadStream: (...args: any[]) => FsStream = notImpl("createReadStream");
export const createWriteStream: (...args: any[]) => FsStream = notImpl("createWriteStream");
export const symlinkSync: AnyFn = notImpl("symlinkSync");
export const readlinkSync: AnyFn = notImpl("readlinkSync");
export const appendFileSync: AnyFn = notImpl("appendFileSync");
export const mkdtempSync: AnyFn = notImpl("mkdtempSync");

const def = {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  lstatSync,
  realpathSync,
  renameSync,
  copyFileSync,
  rmSync,
  chmodSync,
  accessSync,
  constants,
  openSync,
  closeSync,
  createReadStream,
  createWriteStream,
  symlinkSync,
  readlinkSync,
  appendFileSync,
  mkdtempSync,
};
export default def;
