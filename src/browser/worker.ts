/**
 * Dedicated worker entry for the browser build: runs the whole synchronous
 * core surface (here: the differential scenarios) behind a postMessage RPC.
 *
 * Protocol: `{ id, op, args }` -> `{ id, ok: true, result }` or
 * `{ id, ok: false, error }`. On startup the worker boots SQLite
 * (async WASM load + `opfs-sahpool` install) and posts `{ boot: true, ok }`.
 */
import { ensureBooted, DatabaseSync, sahpoolFileBytes } from "./shims/sqlite.ts";
import { mkdirSync, openProjectFiles, writeFileSync } from "./shims/fs.ts";
import { dirname } from "./shims/path.ts";
import {
  PROJECT_ROOT,
  hostCallTool,
  hostClose,
  hostExportProject,
  hostInit,
  hostReadAsset,
  type InitArgs,
  type ToolName,
} from "./host.ts";
import { runSqliteScenario } from "../../tests-browser/scenarios/sqlite.ts";
import { runCryptoScenario } from "../../tests-browser/scenarios/crypto.ts";
import { runBufferScenario } from "../../tests-browser/scenarios/buffer.ts";
import { runZlibScenario } from "../../tests-browser/scenarios/zlib.ts";
import { runPdfScenario, type PdfFixture } from "../../tests-browser/scenarios/pdf.ts";
import { runPathScenario } from "../../tests-browser/scenarios/path.ts";
import { runFsScenario } from "../../tests-browser/scenarios/fs.ts";
import { runFscoreScenario } from "../../tests-browser/scenarios/fscore.ts";
import {
  durabilityRead,
  durabilityWrite,
  runFsPerfScenario,
  runFsRegistryScenario,
} from "../../tests-browser/scenarios/fslocal.ts";

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(msg: unknown): void;
};

scope.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as { id: string; op: string; args: Record<string, never> };
  const reply = (payload: unknown): void => scope.postMessage(payload);
  void (async () => {
    try {
      let result: unknown;
      switch (msg.op) {
        case "ping":
          result = { pong: true };
          break;
        case "sqlite":
          result = runSqliteScenario(
            (msg.args as unknown as { dbPath: string }).dbPath,
            (msg.args as unknown as { schemaSql: string }).schemaSql,
          );
          break;
        case "crypto":
          result = runCryptoScenario();
          break;
        case "buffer":
          result = await runBufferScenario();
          break;
        case "process": {
          // Bare `process`: resolves ONLY through esbuild `inject` (no import
          // above), so this op also proves the inject wiring. Reports the shim
          // shape, proves the host can set env, and proves event/exit throw.
          const setEnv = (msg.args as unknown as { setEnv?: Record<string, string> }).setEnv;
          if (setEnv !== undefined) Object.assign(process.env, setEnv);
          const throws: Record<string, string> = {};
          for (const m of ["once", "on", "exit"] as const) {
            try {
              process[m]();
            } catch (err) {
              throws[m] = err instanceof Error ? err.message : String(err);
            }
          }
          result = { platform: process.platform, arch: process.arch, pid: process.pid, env: { ...process.env }, throws };
          break;
        }
        case "zlib":
          result = runZlibScenario((msg.args ?? {}) as never);
          break;
        case "pdf": {
          // Fixtures arrive inline (base64) or as same-origin URLs (large real PDFs stay out of postMessage).
          const { inline, urls } = msg.args as unknown as {
            inline: { name: string; base64: string }[];
            urls: { name: string; url: string }[];
          };
          const fixtures: PdfFixture[] = inline.map((f) => ({ name: f.name, bytes: Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)) }));
          for (const u of urls) fixtures.push({ name: u.name, bytes: new Uint8Array(await (await fetch(u.url)).arrayBuffer()) });
          result = await runPdfScenario(fixtures);
          break;
        }
        case "path":
          result = runPathScenario();
          break;
        case "fs":
          openProjectFiles((msg.args as unknown as { root: string }).root);
          result = runFsScenario((msg.args as unknown as { root: string }).root);
          break;
        case "fscore":
          openProjectFiles((msg.args as unknown as { root: string }).root);
          result = runFscoreScenario((msg.args as unknown as { root: string }).root);
          break;
        case "fsregistry":
          result = runFsRegistryScenario((msg.args as unknown as { root: string }).root);
          break;
        case "fswrite":
          result = durabilityWrite((msg.args as unknown as { root: string }).root);
          break;
        case "fsread":
          result = durabilityRead((msg.args as unknown as { root: string }).root);
          break;
        case "fsperf":
          result = runFsPerfScenario((msg.args as unknown as { root: string }).root);
          break;
        case "init":
          result = await hostInit((msg.args ?? {}) as unknown as InitArgs);
          break;
        case "callTool": {
          const { name, toolArgs } = msg.args as unknown as { name: ToolName; toolArgs: Record<string, unknown> };
          result = await hostCallTool(name, toolArgs ?? {});
          break;
        }
        case "exportProject":
          result = await hostExportProject();
          break;
        case "close":
          result = await hostClose();
          break;
        case "readAsset":
          result = hostReadAsset((msg.args as unknown as { path: string }).path);
          break;
        case "makeForeignRegistry": {
          // Test seam: stamp a foreign/newer `user_version` onto the project
          // registry so the refusal path (refused before any write) is provable.
          const version = (msg.args as unknown as { version: number }).version;
          const db = new DatabaseSync(`${PROJECT_ROOT}/.registry/registry.db`);
          try {
            db.exec("CREATE TABLE IF NOT EXISTS probe(x)");
            db.exec(`PRAGMA user_version = ${Number(version)}`);
          } finally {
            db.close();
          }
          result = { version: Number(version) };
          break;
        }
        case "registryBytes": {
          const bytes = sahpoolFileBytes(`${PROJECT_ROOT}/.registry/registry.db`);
          result = bytes === null ? null : Array.from(bytes);
          break;
        }
        case "writeFile": {
          // Test seam: place a project file (e.g. a TEI source) into the
          // worker's file store from bytes ferried across postMessage.
          const { rel, base64 } = msg.args as unknown as { rel: string; base64: string };
          const abs = `${PROJECT_ROOT}/${rel}`;
          const bin = atob(base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const parent = dirname(abs);
          if (parent !== PROJECT_ROOT) mkdirSync(parent, { recursive: true });
          writeFileSync(abs, bytes);
          result = { path: rel, bytes: bytes.length };
          break;
        }
        default:
          throw new Error(`unknown worker op: ${String(msg.op)}`);
      }
      reply({ id: msg.id, ok: true, result });
    } catch (err) {
      reply({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
};

void (async () => {
  try {
    await ensureBooted();
    scope.postMessage({ boot: true, ok: true });
  } catch (err) {
    scope.postMessage({ boot: true, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
})();
