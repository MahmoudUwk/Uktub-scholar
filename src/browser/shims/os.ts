/**
 * Browser implementation of the `node:os` surface the core uses.
 *
 * Audit (grep over `src/`): the tool graph reaches only `homedir()`
 * (`src/core/embed/config.ts`: `XDG_CACHE_HOME ?? HOME ?? homedir()` cache
 * default — an engine-seam path, not a tool path). `tmpdir()` is provided
 * for the same class of leaf use. Everything else throws
 * "not implemented in the browser build: node:os.<name>" at CALL time.
 *
 * Fixed virtual values: `tmpdir()` returns `/tmp`, `homedir()` returns
 * `/home/user` (POSIX, rooted at the same virtual `/` as the fs shim, which
 * creates these lazily on demand — they are NOT pre-created).
 */

export function tmpdir(): string {
  return "/tmp";
}

export function homedir(): string {
  return "/home/user";
}

export const EOL = "\n";
export const devNull = "/dev/null";

const notImpl = (name: string) => (..._args: never[]): never => {
  throw new Error(`not implemented in the browser build: node:os.${name}`);
};

export const platform = notImpl("platform");
export const type = notImpl("type");
export const arch = notImpl("arch");
export const release = notImpl("release");
export const hostname = notImpl("hostname");
export const userInfo = notImpl("userInfo");
export const cpus = notImpl("cpus");
export const totalmem = notImpl("totalmem");
export const freemem = notImpl("freemem");
export const loadavg = notImpl("loadavg");
export const uptime = notImpl("uptime");
export const networkInterfaces = notImpl("networkInterfaces");
export const availableParallelism = notImpl("availableParallelism");

const def = {
  tmpdir,
  homedir,
  EOL,
  devNull,
  platform,
  type,
  arch,
  release,
  hostname,
  userInfo,
  cpus,
  totalmem,
  freemem,
  loadavg,
  uptime,
  networkInterfaces,
  availableParallelism,
};
export default def;
