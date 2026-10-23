/**
 * Browser implementation of the `node:sqlite` surface the core uses, on top of
 * the official `@sqlite.org/sqlite-wasm` build (synchronous OO1 API inside a
 * dedicated Worker, VFS `opfs-sahpool`, no COOP/COEP).
 *
 * Implemented (derived by grep over src/core plus src/core/registry.ts):
 * `DatabaseSync` (constructor `(path, { timeout })`, `prepare`, `exec`,
 * `close`, `location`, `isOpen`) and `StatementSync` (`get`, `all`, `run`
 * with `run` returning `{ changes, lastInsertRowid }`), positional `?`
 * parameters, named `:name`/`@name`/`$name` parameters with or without the
 * prefix on the key, BLOB as `Uint8Array`, `PRAGMA user_version`,
 * `journal_mode`, `foreign_keys`, STRICT tables, FTS5 with `bm25()`,
 * `RETURNING`, and transactions through `exec("BEGIN IMMEDIATE")`.
 *
 * Path mapping: `new DatabaseSync("/p/.registry/registry.db")` maps onto a
 * sahpool virtual file whose key is the absolute project path itself (the
 * pool directory holds opaque handles; names are not visible in OPFS).
 * `location()` returns the original absolute path, so the project/root
 * derivation `src/core/tools/registry.ts` does from `db.location()`
 * (`resolve(dirname(location), "..")`) keeps working. Parent directories are
 * not created or required: the browser namespace is flat per pool directory.
 *
 * Per-project pools (Phase 4b, see `src/browser/projects.ts`): every
 * project installs its own pool under its own OPFS directory, so two live
 * workers on one origin coexist whenever they hold different projects. Only
 * one project is open per worker: `ensurePoolInstalled` keeps one installed
 * pool per directory and one ACTIVE pool (the open project's, or the
 * scenario scratch pool); every `DatabaseSync` opens on the active pool. A
 * second tab on the SAME project is refused by the project lock
 * (`src/browser/lock.ts`, taken before any install) with the typed refusal
 * — never a VFS crash. `hostClose` pauses the active pool (releases its
 * SAHs without destroying data) so a fresh worker can install the same
 * directory afterwards; `removeProjectPool` unregisters a project's VFS
 * and destroys its OPFS directory (project deletion).
 *
 * Error shapes match `node:sqlite`: failures are `Error` with
 * `code === "ERR_SQLITE_ERROR"` and the extended result code on `errcode`
 * (e.g. 1555 for a UNIQUE violation); unsafe-integer binds/reads throw
 * `RangeError` with `code === "ERR_OUT_OF_RANGE"`; bad bind values throw
 * `TypeError` with `code === "ERR_INVALID_ARG_TYPE"`; unknown named
 * parameters throw `Error` with `code === "ERR_INVALID_STATE"`; use after
 * `close()` (including a second `close()`) throws `Error` with
 * `code === "ERR_INVALID_STATE"` and message "database is not open".
 *
 * NOT implemented (the core does not use them; each throws a clear error):
 * `createSession`/`applyChangeset`, `prepare` with `setReadonly`,
 * `StatementSyncSync` iteration helpers (`columns`, `expandedSQL`,
 * `setAllowBareNamedParameters`, `setAllowUnknownNamedParameters`),
 * read-only opens, `file:` URIs, `:memory:` shared-cache names, and the
 * `DatabaseSync` `open`/`enableLoadExtension` options. Full list in
 * `remainingNodeImports()` in tests-browser/build.mjs.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import wasmUrl from "@sqlite.org/sqlite-wasm/sqlite3.wasm";

/** Minimal structural surface of the sqlite-wasm module used by this shim. */
interface WasmModule {
  oo1: {
    DB: new (filename?: string) => WasmDb;
    OpfsSAHPoolDb?: new (filename: string) => WasmDb;
  };
  capi: Record<string, number | string | ((...args: never[]) => unknown)>;
  installOpfsSAHPoolVfs: (opts: {
    directory?: string;
    name?: string;
    initialCapacity?: number;
    clearOnInit?: boolean;
  }) => Promise<SahPoolUtil>;
  sqlite3?: unknown;
}
interface WasmDb {
  prepare(sql: string): WasmStmt;
  exec(sql: string): unknown;
  exec(opts: Record<string, unknown>): unknown;
  close(): void;
  changes(total?: boolean): number;
  filename?: string;
}
interface WasmStmt {
  bind(spec: unknown): unknown;
  step(): boolean;
  get(ndx: number): unknown;
  getColumnNames(): string[];
  reset(clearBinds?: boolean): unknown;
  finalize(): unknown;
  parameterCount: number;
  pointer: number | undefined;
}
interface SahPoolUtil {
  OpfsSAHPoolDb: new (filename: string) => WasmDb;
  getCapacity(): number;
  addCapacity(n: number): Promise<number>;
  exportFile(filename: string): Uint8Array;
  importDb(filename: string, data: Uint8Array | ArrayBuffer): Promise<number>;
  unlink(filename: string): boolean;
  /** The SQLite VFS name this pool is registered under. */
  vfsName: string;
  isPaused(): boolean;
  /**
   * Unregister this VFS and release file access handles, without clearing
   * files. Databases on it must be closed first. Reversible with
   * `unpauseVfs()` (same worker) or a fresh install (any worker).
   */
  pauseVfs(): SahPoolUtil;
  /** Re-register this VFS and re-acquire file access handles. */
  unpauseVfs(): Promise<SahPoolUtil>;
  /**
   * Unregister the VFS and remove its directory from OPFS (all client
   * content destroyed). Only the bottom-most directory level is removed.
   * No longer usable afterwards; false when the VFS was not installed.
   * Results are undefined while a database on it is in use.
   */
  removeVfs(): Promise<boolean>;
}

type WasmInput = null | number | bigint | string | Uint8Array;

let sqlite3: WasmModule | null = null;
/** Installed pools by OPFS directory (one per project, plus the scenario scratch pool). */
const pools = new Map<string, SahPoolUtil>();
/** Directory of the pool `DatabaseSync` opens on (the open project's, or scratch). */
let activePoolDir: string | null = null;

export interface BootOptions {
  /** OPFS pool directory for this install (required: pools are per project, see `src/browser/projects.ts`). */
  poolDirectory?: string;
  /** VFS registration name, unique per directory (required alongside the directory). */
  vfsName?: string;
  /** SAH pool capacity; defaults to 8 (registry + temp files). */
  poolCapacity?: number;
}

/**
 * Install the pool for one OPFS directory (async, once per directory per
 * worker) and make it the active pool. Fail closed: both `poolDirectory`
 * and `vfsName` are required — there is no implicit global pool. A second
 * live worker holding the SAME directory fails here; that only happens for
 * the same project, which the project lock refuses before any install.
 */
export async function ensurePoolInstalled(options: BootOptions = {}): Promise<void> {
  if (sqlite3 === null) {
    throw new Error("sqlite pool install before ensureBooted() (call it once in the worker)");
  }
  const dir = options.poolDirectory;
  if (typeof dir !== "string" || dir === "") {
    throw new TypeError("ensurePoolInstalled: poolDirectory must be a non-empty string (no implicit global pool)");
  }
  const hit = pools.get(dir);
  if (hit !== undefined) {
    const live = hit.isPaused() ? await hit.unpauseVfs() : hit;
    pools.set(dir, live);
    activePoolDir = dir;
    return;
  }
  const name = options.vfsName;
  if (typeof name !== "string" || name === "") {
    throw new TypeError("ensurePoolInstalled: vfsName must be a non-empty string (one name per directory)");
  }
  const mod = sqlite3;
  const pool = await mod.installOpfsSAHPoolVfs({ directory: dir, name });
  const want = options.poolCapacity ?? 8;
  try {
    const have = Number(pool.getCapacity());
    if (have < want) await pool.addCapacity(want - have);
  } catch {
    // Capacity probe is best-effort; the pool default already holds a database.
  }
  pools.set(dir, pool);
  activePoolDir = dir;
}

/** True once some pool is installed and active in this worker. */
export function hasActivePool(): boolean {
  return activePoolDir !== null && pools.has(activePoolDir);
}

/** The installed pool every `DatabaseSync` opens on, or a clear error. */
function requirePool(): SahPoolUtil {
  const dir = activePoolDir;
  const pool = dir === null ? undefined : pools.get(dir);
  if (pool === undefined) {
    throw new Error(
      "sqlite sahpool has no active pool (call init first, or a scenario op that installs the scratch pool)",
    );
  }
  return pool;
}

/**
 * Pause (unregister, keep data) the active pool and forget it, releasing
 * its SAHs so another worker can install the same directory. Called by
 * `hostClose` after all connections are dropped. No-op without an active
 * pool.
 */
export async function pauseActivePool(): Promise<void> {
  const dir = activePoolDir;
  activePoolDir = null;
  if (dir === null) return;
  const pool = pools.get(dir);
  pools.delete(dir);
  if (pool !== undefined && !pool.isPaused()) pool.pauseVfs();
}

/**
 * Unregister a project's VFS and destroy its OPFS directory (project
 * deletion). Installs a handle for the directory first when this worker
 * never opened the project. Callers must hold the project lock and hold no
 * open connections on the pool.
 */
export async function removeProjectPool(directory: string, vfsName: string): Promise<boolean> {
  if (sqlite3 === null) {
    throw new Error("sqlite shim used before ensureBooted() (call it once in the worker)");
  }
  let pool = pools.get(directory);
  if (pool === undefined) {
    const mod = sqlite3;
    pool = await mod.installOpfsSAHPoolVfs({ directory, name: vfsName });
    pools.set(directory, pool);
  }
  if (pool.isPaused()) pool = await pool.unpauseVfs();
  const removed = await pool.removeVfs();
  pools.delete(directory);
  if (activePoolDir === directory) activePoolDir = null;
  return removed;
}

/**
 * Async one-time boot for the worker: loads WASM and refuses to run without
 * FTS5. Installs NO pool: the open project's pool is installed by `hostInit`
 * (per-project directory, after the lock), scenario ops install the scratch
 * pool lazily. Every `DatabaseSync` method after this is synchronous. Must
 * be called inside the dedicated Worker.
 */
export async function ensureBooted(): Promise<void> {
  if (sqlite3 !== null) return;
  const init = sqlite3InitModule as unknown as (cfg: {
    locateFile: (path: string, prefix: string) => string;
  }) => Promise<WasmModule>;
  const mod = await init({
    locateFile: () => new URL(String(wasmUrl), import.meta.url).href,
  });
  const used = mod.capi.sqlite3_compileoption_used as unknown as (name: string) => number;
  // JSON is core since SQLite 3.38 (no compile option); only FTS5 is gated.
  if (!used("ENABLE_FTS5")) throw new Error("browser sqlite build lacks ENABLE_FTS5; refusing to boot");
  sqlite3 = mod;
}

function api(): WasmModule {
  if (sqlite3 === null) {
    throw new Error("sqlite shim used before ensureBooted() (call it once in the worker)");
  }
  return sqlite3;
}

function sqliteError(message: string, errcode: number): Error {
  const err = new Error(message);
  (err as unknown as { code: string }).code = "ERR_SQLITE_ERROR";
  (err as unknown as { errcode: number }).errcode = errcode;
  return err;
}

/** Map an OO1/SQLite3Error throw onto the node:sqlite error shape. */
function toNodeError(err: unknown): unknown {
  if (err instanceof RangeError || err instanceof TypeError) return err;
  // Already-shaped errors (our own typed throws) pass through untouched.
  if (err instanceof Error && typeof (err as unknown as { code?: unknown }).code === "string") return err;
  const rec = (err !== null && typeof err === "object" ? err : {}) as { code?: unknown; resultCode?: unknown };
  const raw = err instanceof Error ? err.message : String(err);
  const seen = /sqlite3 result code (\d+)/.exec(raw);
  const extended =
    typeof rec.resultCode === "number"
      ? rec.resultCode
      : typeof rec.code === "number"
        ? rec.code
        : seen !== null
          ? Number(seen[1])
          : undefined;
  const mod = sqlite3;
  const resultCode = extended ?? ((mod?.capi.SQLITE_ERROR as number | undefined) ?? 1);
  // OO1 text looks like "SQLITE_CONSTRAINT_PRIMARYKEY: sqlite3 result code
  // 1555: UNIQUE constraint failed: t.a" (or "fn() failed: ..."); node:sqlite
  // carries only SQLite's own text.
  const message = raw
    .replace(/^[A-Z_]+:\s*sqlite3 result code \d+:\s*/, "")
    .replace(/^[\w$]+\(\) (?:failed|error):\s*/, "")
    .replace(/^SQLite3Error:\s*/, "");
  return sqliteError(message, resultCode);
}

function outOfRange(value: number | bigint): RangeError {
  const err = new RangeError(`Value is too large to be represented as a JavaScript number: ${String(value)}`);
  (err as unknown as { code: string }).code = "ERR_OUT_OF_RANGE";
  return err;
}

const MAX_SAFE = 9007199254740991;

/** Validate one bind value the way node:sqlite does; returns the OO1 value.
 * NOTE: unsafe-integer doubles bind fine (only READS of INTEGER-declared
 * columns range-check); booleans/undefined/plain objects are rejected. */
function checkBindValue(value: unknown, index: number): WasmInput {
  if (value === null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return value;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw Object.assign(
    new TypeError(`Provided value cannot be bound to SQLite parameter ${index}.`),
    { code: "ERR_INVALID_ARG_TYPE" },
  );
}

const NAMED_RE = /^[:@$]/;

function unknownNamed(key: string): Error {
  return Object.assign(new Error(`Unknown named parameter '${key}'`), { code: "ERR_INVALID_STATE" });
}

export type SQLInputValue = null | number | bigint | string | Uint8Array;
export type SQLOutputValue = null | number | bigint | string | Uint8Array;
export type SQLInputRecord = Record<string, SQLInputValue>;

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export class StatementSync {
  private readonly stmt: WasmStmt;
  private readonly db: DatabaseSync;
  private columnNames: string[] | null = null;
  /** Set once `finalizeForClose` runs (always via the owning db's `close`). */
  private finalized = false;

  /** @internal constructed by DatabaseSync.prepare only. */
  constructor(stmt: WasmStmt, db: DatabaseSync) {
    this.stmt = stmt;
    this.db = db;
  }

  /**
   * @internal finalize the underlying OO1 statement so the owning
   * connection can truly close (unfinalized statements keep the VFS file
   * open as a zombie, which blocks `pauseVfs`/`removeVfs`). Idempotent.
   */
  finalizeForClose(): void {
    if (this.finalized) return;
    this.finalized = true;
    try {
      this.stmt.finalize();
    } catch {
      // Best-effort during close; the db close reports real failures.
    }
  }

  /** Same refusal as before when the db is closed, plus a finalized guard. */
  private assertUsable(): void {
    this.db.assertOpen();
    if (this.finalized) {
      throw Object.assign(new Error("statement has been finalized"), { code: "ERR_INVALID_STATE" });
    }
  }

  private bindAll(params: unknown[]): void {
    const mod = api();
    if (params.length === 1 && params[0] !== null && typeof params[0] === "object" && !(params[0] instanceof Uint8Array) && !ArrayBuffer.isView(params[0])) {
      // Named-parameter form (a bare Array lands here too, exactly as in node:sqlite).
      const record = params[0] as Record<string, unknown>;
      const capi = api().capi;
      const paramCount = capi.sqlite3_bind_parameter_count as unknown as (stmt: unknown) => number;
      const paramName = capi.sqlite3_bind_parameter_name as unknown as (stmt: unknown, n: number) => string | null;
      const count = paramCount(this.stmt);
      const declared = new Map<string, string>();
      for (let i = 1; i <= count; i++) {
        const name = paramName(this.stmt, i);
        if (name) declared.set(name.replace(NAMED_RE, ""), name);
      }
      const spec: Record<string, WasmInput> = {};
      let idx = 0;
      for (const [key, value] of Object.entries(record)) {
        idx++;
        const bare = key.replace(NAMED_RE, "");
        const spelling = declared.get(bare);
        if (spelling === undefined) throw unknownNamed(key);
        // OO1 wants the declared spelling; node:sqlite takes it with or
        // without the prefix, so translate here.
        spec[spelling] = checkBindValue(value, idx);
      }
      try {
        this.stmt.bind(spec);
      } catch (err) {
        throw toNodeError(err);
      }
      return;
    }
    const values = params.map((v, i) => checkBindValue(v, i + 1));
    try {
      if (values.length > 0) {
        // node:sqlite rejects positional binds on statements that declare
        // named parameters (SQLITE_RANGE "column index out of range").
        const capi = api().capi;
        const paramName = capi.sqlite3_bind_parameter_name as unknown as (stmt: unknown, n: number) => string | null;
        const count = (this.stmt.parameterCount ?? 0) as number;
        for (let i = 1; i <= count; i++) {
          if (paramName(this.stmt, i) !== null) {
            throw sqliteError("column index out of range", capi.SQLITE_RANGE as number);
          }
        }
        this.stmt.bind(values as WasmInput[]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such parameter|out of range|column index/i.test(msg)) {
        throw sqliteError("column index out of range", mod.capi.SQLITE_RANGE as number);
      }
      throw toNodeError(err);
    }
  }

  private readRow(): Record<string, SQLOutputValue> {
    const capi = api().capi;
    const colType = capi.sqlite3_column_type as unknown as (stmt: unknown, i: number) => number;
    const colInt64 = capi.sqlite3_column_int64 as unknown as (stmt: unknown, i: number) => bigint;
    const colDecl = capi.sqlite3_column_decltype as unknown as (stmt: unknown, i: number) => string | null;
    const SQLITE_INTEGER = capi.SQLITE_INTEGER as number;
    if (this.columnNames === null) this.columnNames = this.stmt.getColumnNames();
    const row: Record<string, SQLOutputValue> = {};
    const ptr = this.stmt.pointer;
    for (let i = 0; i < this.columnNames.length; i++) {
      let value: SQLOutputValue;
      // node:sqlite range-checks reads only for INTEGER-declared columns
      // (typeless columns and expressions return the lossy double).
      const decltype = ptr !== undefined ? colDecl(this.stmt, i) : null;
      const checked = decltype !== null && decltype.toUpperCase().includes("INT");
      if (ptr !== undefined && checked && colType(this.stmt, i) === SQLITE_INTEGER) {
        // Exact 64-bit read: node:sqlite throws past the safe-integer range.
        const v = colInt64(this.stmt, i);
        if (v > BigInt(MAX_SAFE) || v < BigInt(-MAX_SAFE)) throw outOfRange(v);
        value = Number(v);
      } else {
        const raw = this.stmt.get(i);
        if (typeof raw === "bigint") {
          if (raw > BigInt(MAX_SAFE) || raw < BigInt(-MAX_SAFE)) throw outOfRange(raw);
          value = Number(raw);
        } else if (raw instanceof Uint8Array) {
          value = Uint8Array.from(raw);
        } else if (raw instanceof ArrayBuffer) {
          value = new Uint8Array(raw);
        } else {
          value = (raw ?? null) as SQLOutputValue;
        }
      }
      row[this.columnNames[i]] = value;
    }
    return row;
  }

  private finish(): void {
    this.stmt.reset(true);
  }

  /** Run an op with every OO1 throw mapped; a finish() failure only
   * replaces an in-flight error when there is none. */
  private guarded<T>(op: () => T): T {
    let failed: unknown = null;
    let result: T = undefined as T;
    try {
      result = op();
    } catch (err) {
      failed = toNodeError(err);
    }
    try {
      this.finish();
    } catch (err) {
      if (failed === null) failed = toNodeError(err);
    }
    if (failed !== null) throw failed;
    return result;
  }

  get(...params: Array<SQLInputValue | SQLInputRecord>): Record<string, SQLOutputValue> | undefined {
    this.assertUsable();
    return this.guarded(() => {
      this.bindAll(params);
      let hasRow = false;
      try {
        hasRow = this.stmt.step();
      } catch (err) {
        throw toNodeError(err);
      }
      if (!hasRow) return undefined;
      return this.readRow();
    });
  }

  all(...params: Array<SQLInputValue | SQLInputRecord>): Array<Record<string, SQLOutputValue>> {
    this.assertUsable();
    return this.guarded(() => {
      this.bindAll(params);
      const rows: Array<Record<string, SQLOutputValue>> = [];
      for (;;) {
        let hasRow = false;
        try {
          hasRow = this.stmt.step();
        } catch (err) {
          throw toNodeError(err);
        }
        if (!hasRow) break;
        rows.push(this.readRow());
      }
      return rows;
    });
  }

  run(...params: Array<SQLInputValue | SQLInputRecord>): RunResult {
    this.assertUsable();
    return this.guarded(() => {
      this.bindAll(params);
      try {
        this.stmt.step();
      } catch (err) {
        throw toNodeError(err);
      }
      return this.db.changeInfo();
    });
  }
}

export interface DatabaseOptions {
  timeout?: number;
}

export class DatabaseSync {
  private handle: WasmDb | null;
  private readonly originalPath: string;
  private open = true;
  /** Every statement prepared on this connection (finalized by `close`). */
  private readonly statements = new Set<StatementSync>();

  constructor(path: string, options: DatabaseOptions = {}) {
    const mod = api();
    if (typeof path !== "string") {
      throw Object.assign(new TypeError("Database path must be a string."), { code: "ERR_INVALID_ARG_TYPE" });
    }
    const extra = Object.keys(options ?? {}).filter((k) => k !== "timeout");
    if (extra.length > 0) {
      throw new Error(`not implemented in the browser build: node:sqlite DatabaseSync option(s): ${extra.join(", ")}`);
    }
    this.originalPath = path;
    try {
      if (path === ":memory:") {
        this.handle = new mod.oo1.DB(":memory:");
      } else {
        const pool = requirePool();
        this.handle = new pool.OpfsSAHPoolDb(path);
      }
    } catch (err) {
      throw toNodeError(err);
    }
    if (typeof options?.timeout === "number") {
      // node:sqlite sets the busy timeout at open; same here, same connection.
      this.exec(`PRAGMA busy_timeout = ${Math.trunc(options.timeout)}`);
    }
  }

  /** @internal rejections for use-after-close mirror node:sqlite exactly. */
  assertOpen(): void {
    if (!this.open || this.handle === null) {
      throw Object.assign(new Error("database is not open"), { code: "ERR_INVALID_STATE" });
    }
  }

  /** @internal current { changes, lastInsertRowid } for this connection. */
  changeInfo(): RunResult {
    this.assertOpen();
    const changes = Number((this.handle as WasmDb).changes(false));
    const row = (this.handle as WasmDb).exec({
      sql: "SELECT last_insert_rowid() AS id",
      rowMode: "object",
      resultRows: [],
      returnValue: "resultRows",
    }) as Array<{ id: number }>;
    return { changes, lastInsertRowid: row[0]?.id ?? 0 };
  }

  prepare(sql: string): StatementSync {
    this.assertOpen();
    if (typeof sql !== "string") {
      throw Object.assign(new TypeError("SQL must be a string."), { code: "ERR_INVALID_ARG_TYPE" });
    }
    try {
      // Like node:sqlite, only the first statement of the string is prepared.
      const stmt = new StatementSync((this.handle as WasmDb).prepare(sql), this);
      this.statements.add(stmt);
      return stmt;
    } catch (err) {
      throw toNodeError(err);
    }
  }

  exec(sql: string): undefined {
    this.assertOpen();
    try {
      // OO1 exec runs every statement in the string (schema migrations,
      // multi-PRAGMA opens, BEGIN/COMMIT); returns undefined like node:sqlite.
      (this.handle as WasmDb).exec(sql);
      return undefined;
    } catch (err) {
      throw toNodeError(err);
    }
  }

  close(): void {
    this.assertOpen();
    // Finalize every prepared statement first: an unfinalized statement
    // keeps the connection a zombie with its VFS file open, which blocks
    // `pauseVfs`/`removeVfs` (and a fresh worker's install) after close.
    for (const stmt of this.statements) stmt.finalizeForClose();
    this.statements.clear();
    try {
      (this.handle as WasmDb).close();
    } catch (err) {
      throw toNodeError(err);
    } finally {
      this.handle = null;
      this.open = false;
    }
  }

  get isOpen(): boolean {
    return this.open && this.handle !== null;
  }

  location(): string | null {
    this.assertOpen();
    return this.originalPath;
  }
}

/**
 * Live byte size of a sahpool file (`exportFile` copy), or null when the
 * file is absent. Used by the fs shim to make the standalone registry
 * database visible at its project path (`existsSync`/`statSync`/parent
 * `readdirSync`) without ever opening it through fs. Synchronous; a missing
 * file throws inside `exportFile`, which maps to null here.
 */
export function sahpoolFileBytes(path: string): Uint8Array | null {
  if (sqlite3 === null || !hasActivePool()) {
    throw new Error("sqlite shim used before ensureBooted() (call it once in the worker)");
  }
  try {
    const bytes = requirePool().exportFile(path);
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  } catch {
    return null;
  }
}

/**
 * Import raw SQLite database bytes into a sahpool file slot, overwriting any
 * existing contents. Must only be called when no connection is open on `path`.
 */
export async function sahpoolImportDb(path: string, bytes: Uint8Array): Promise<number> {
  if (sqlite3 === null || !hasActivePool()) {
    throw new Error("sqlite shim used before ensureBooted() (call it once in the worker)");
  }
  return await requirePool().importDb(path, bytes);
}

/** Remove a sahpool file slot if present. */
export function sahpoolUnlink(path: string): boolean {
  if (sqlite3 === null || !hasActivePool()) {
    throw new Error("sqlite shim used before ensureBooted() (call it once in the worker)");
  }
  return requirePool().unlink(path);
}
