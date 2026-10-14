/**
 * Chromium-only fs checks (NOT differential: no Node side exists for these).
 * Imported by the worker only; imports the shims by path, never `node:*`.
 *
 * - `runFsRegistryScenario`: the visible-registry rule + exact `node:os`
 *   strings + fail-closed stubs, as assertable data.
 * - `durabilityWrite` / `durabilityRead`: the abrupt-close durability
 *   fixture (files, mtimes, read-only bits, an atomically renamed directory).
 * - `runFsPerfScenario`: per-call latencies, max round-trip size, DB overhead.
 */
import { DatabaseSync } from "../../src/browser/shims/sqlite.ts";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openProjectFiles,
  projectFilesDbBytes,
  projectFilesIntegrityCheck,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../../src/browser/shims/fs.ts";
import { appendFileSync, createReadStream, mkdtempSync, openSync } from "../../src/browser/shims/fs.ts";
import { arch, homedir, platform, tmpdir } from "../../src/browser/shims/os.ts";
import { norm, step, type Norm } from "./norm.ts";

export function runFsRegistryScenario(root: string): Record<string, Norm> {
  const out: Record<string, Norm> = {};
  const R = (rel: string): string => `${root}/${rel}`;
  openProjectFiles(root);
  // A missing registry must NOT look present (exportFile-miss maps to null).
  out["absentRegistry"] = norm({
    exists: existsSync(R(".registry/registry.db")),
    stat: step(() => statSync(R(".registry/registry.db"))),
  });
  // Create a real standalone registry through the sqlite seam (the dir first,
  // exactly like createRegistry's mkdirSync(dirname(abs), {recursive:true})).
  mkdirSync(R(".registry"), { recursive: true });
  const db = new DatabaseSync(R(".registry/registry.db"));
  db.exec("CREATE TABLE t(a INTEGER PRIMARY KEY, v TEXT)");
  db.prepare("INSERT INTO t(a, v) VALUES(?, ?)").run(1, "hello");
  db.close();
  const st = statSync(R(".registry/registry.db"));
  out["visibleRegistry"] = norm({
    exists: existsSync(R(".registry/registry.db")),
    isFile: st.isFile(),
    sizeGt0: st.size > 0 ? 1 : 0,
    parent: ((readdirSync(R(".registry")) as string[]).slice().sort()),
  });
  out["refuseRead"] = norm(step(() => readFileSync(R(".registry/registry.db"))));
  out["refuseWrite"] = norm(step(() => writeFileSync(R(".registry/registry.db"), "x")));
  out["refuseRm"] = norm(step(() => rmSync(R(".registry/registry.db"), { force: true })));
  out["refuseCopyFrom"] = norm(step(() => copyFileSync(R(".registry/registry.db"), R("backup.db"))));
  out["refuseRenameTo"] = norm(step(() => {
    writeFileSync(R("victim.txt"), "v");
    renameSync(R("victim.txt"), R(".registry/registry.db"));
  }));
  out["refuseChmod"] = norm(step(() => chmodSync(R(".registry/registry.db"), 0o644)));
  out["accessWOk"] = norm(step(() => accessSync(R(".registry/registry.db"), constants.W_OK)));
  out["accessXThrows"] = norm(step(() => accessSync(R(".registry/registry.db"), constants.X_OK)));
  // Exact os strings + fail-closed surface.
  out["osExact"] = norm({ tmp: tmpdir(), home: homedir() });
  out["osPlatformThrows"] = norm(step(() => (platform as unknown as () => string)()));
  out["osArchThrows"] = norm(step(() => (arch as unknown as () => string)()));
  out["fsOpenThrows"] = norm(step(() => (openSync as unknown as () => unknown)()));
  out["fsStreamThrows"] = norm(step(() => (createReadStream as unknown as () => unknown)()));
  out["fsAppendThrows"] = norm(step(() => (appendFileSync as unknown as () => unknown)()));
  out["fsMkdtempThrows"] = norm(step(() => (mkdtempSync as unknown as () => unknown)()));
  out["constantsMatch"] = norm({
    F_OK: constants.F_OK,
    R_OK: constants.R_OK,
    W_OK: constants.W_OK,
    X_OK: constants.X_OK,
    COPYFILE_EXCL: constants.COPYFILE_EXCL,
  });
  return out;
}

interface DurDigest {
  files: Array<{ rel: string; kind: string; size: number; ro: number; mtime: number }>;
  integrity: string;
}

function collectDigest(root: string): DurDigest {
  const files: DurDigest["files"] = [];
  const walk = (dir: string, prefix: string): void => {
    const names = ((readdirSync(dir) as string[]).slice().sort()) as string[];
    for (const n of names) {
      const abs = dir === "/" ? `/${n}` : `${dir}/${n}`;
      const s = statSync(abs);
      const rel = prefix === "" ? n : `${prefix}/${n}`;
      files.push({
        rel,
        kind: s.isFile() ? "file" : "dir",
        size: s.isFile() ? s.size : 0,
        ro: (s.mode & 0o200) === 0 ? 1 : 0,
        mtime: s.mtimeMs,
      });
      if (s.isDirectory()) walk(abs, rel);
    }
  };
  walk(root, "");
  return { files, integrity: projectFilesIntegrityCheck() };
}

export function durabilityWrite(root: string): DurDigest {
  openProjectFiles(root);
  mkdirSync(`${root}/docs/chapters`, { recursive: true });
  mkdirSync(`${root}/pack`, { recursive: true });
  writeFileSync(`${root}/docs/title.txt`, "Durability title\n", "utf-8");
  const bin = new Uint8Array(65536);
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 7) & 0xff;
  writeFileSync(`${root}/docs/blob.bin`, bin);
  writeFileSync(`${root}/docs/readonly.md`, "# frozen\n", "utf-8");
  chmodSync(`${root}/docs/readonly.md`, 0o444);
  for (let i = 0; i < 5; i++) writeFileSync(`${root}/pack/f${i}.txt`, `file ${i}\n`, "utf-8");
  renameSync(`${root}/pack`, `${root}/packed`);
  return collectDigest(root);
}

export function durabilityRead(root: string): DurDigest {
  // Reopen after an abrupt page close: no shutdown hook ran in between.
  openProjectFiles(root);
  return collectDigest(root);
}

export function runFsPerfScenario(root: string): Record<string, Norm> {
  const out: Record<string, Norm> = {};
  openProjectFiles(root);
  const med = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
  const latencies: Record<string, number> = {};
  let payloadBytes = 0;
  for (const size of [1024, 1024 * 1024, 20 * 1024 * 1024]) {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i += 4096) data[i] = (i >> 12) & 0xff;
    const p = `${root}/perf-${size}.bin`;
    const w: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      writeFileSync(p, data);
      w.push(performance.now() - t0);
    }
    const r: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const back = readFileSync(p) as unknown as Uint8Array;
      r.push(performance.now() - t0);
      if (back.length !== size) throw new Error(`short read at ${size}: ${back.length}`);
    }
    latencies[`write${size}`] = Math.round(med(w) * 100) / 100;
    latencies[`read${size}`] = Math.round(med(r) * 100) / 100;
    payloadBytes += size;
  }
  out["latencyMsMedian"] = norm(latencies);
  // Overhead BEFORE the ceiling churn below (deleted big files leave free
  // pages; the file would otherwise look far larger than its live payload).
  let stored = 0;
  for (const size of [1024, 1024 * 1024, 20 * 1024 * 1024]) {
    stored += (statSync(`${root}/perf-${size}.bin`) as unknown as { size: number }).size;
  }
  const overheadDbBytes = projectFilesDbBytes();
  // Ceiling: increasing round trips past 20 MiB with default WASM memory.
  let ceiling = 20 * 1024 * 1024;
  let firstFailure = "";
  for (const size of [32 * 1024 * 1024, 64 * 1024 * 1024, 128 * 1024 * 1024, 256 * 1024 * 1024]) {
    try {
      const data = new Uint8Array(size);
      data[0] = 1;
      data[size - 1] = 2;
      writeFileSync(`${root}/ceil.bin`, data);
      const back = readFileSync(`${root}/ceil.bin`) as unknown as Uint8Array;
      if (back.length !== size || back[0] !== 1 || back[size - 1] !== 2) throw new Error("mismatch");
      ceiling = size;
      rmSync(`${root}/ceil.bin`, { force: true });
    } catch (err) {
      firstFailure = err instanceof Error ? `${err.constructor.name}: ${err.message.slice(0, 160)}` : String(err);
      try {
        rmSync(`${root}/ceil.bin`, { force: true });
      } catch {
        // Best effort; the ceiling report is what matters.
      }
      break;
    }
  }
  out["ceiling"] = norm({ maxRoundTripBytes: ceiling, firstFailure });
  out["overhead"] = norm({ dbBytes: overheadDbBytes, payloadBytes: stored, writtenTotal: payloadBytes });
  return out;
}
