/**
 * Browser implementation of the Node `process` surface the core can reach.
 *
 * Data only: `env` (empty; the host replaces or fills it), `platform`
 * (`"browser"` — leaf engine files branch on `"win32"` vs POSIX, and the
 * browser is POSIX-like), `arch`, `pid` (inert `0`; only used for temp-file
 * staging names next to `node:fs` calls, which are stubbed in this build),
 * `argv` and `versions`. Event and lifecycle methods (`once`, `on`, `exit`,
 * ...) only live in leaf engine files and throw a clear "not implemented in
 * the browser build: process.<name>" at CALL time.
 */

export interface BrowserProcess {
  env: Record<string, string | undefined>;
  /** Runtime value is `"browser"` (POSIX-like); typed wide so leaf engine
   * files branching on `"win32"` keep typechecking (they never run here). */
  platform: string;
  arch: string;
  pid: number;
  argv: string[];
  versions: Record<string, string>;
  /** Throwing stubs at runtime (engine dispatch only); typed wide for the same reason. */
  once: (...args: any[]) => any;
  on: (...args: any[]) => any;
  addListener: (...args: any[]) => any;
  removeListener: (...args: any[]) => any;
  removeAllListeners: (...args: any[]) => any;
  off: (...args: any[]) => any;
  exit: (...args: any[]) => any;
}

const throwing = (name: string): ((...args: any[]) => any) =>
  (..._args: any[]): any => {
    throw new Error(`not implemented in the browser build: process.${name}`);
  };

/**
 * The bundle-time global (esbuild `inject` in tests-browser/build.mjs maps
 * bare `process` uses to this export); the type-level global lives in
 * `src/browser/globals.d.ts`. Mutate or replace `.env` to pass host env.
 */
export const process: BrowserProcess = {
  env: {},
  platform: "browser",
  arch: "browser",
  pid: 0,
  argv: [],
  versions: {},
  once: throwing("once"),
  on: throwing("on"),
  addListener: throwing("addListener"),
  removeListener: throwing("removeListener"),
  removeAllListeners: throwing("removeAllListeners"),
  off: throwing("off"),
  exit: throwing("exit"),
};
