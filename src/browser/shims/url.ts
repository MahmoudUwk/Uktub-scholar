/**
 * Browser implementation of the `node:url` surface the core reaches.
 *
 * The core only imports `fileURLToPath` (launch.ts evaluates it at module
 * top level to locate the CLI entry; verify helpers call it inside functions
 * that belong to the engine seam). Semantics match Node: a `file:` URL (or
 * string) becomes a POSIX path; anything else throws at call time.
 */

function toURL(url: string | URL): URL {
  if (url instanceof URL) return url;
  if (typeof url === "string") return new URL(url);
  throw new TypeError("fileURLToPath argument must be a string or URL");
}

export function fileURLToPath(url: string | URL): string {
  const u = toURL(url);
  if (u.protocol !== "file:") {
    throw new TypeError(`fileURLToPath: expected a file: URL, got ${u.protocol}`);
  }
  if (u.username !== "" || u.password !== "" || (u.hostname !== "" && u.hostname !== "localhost")) {
    throw new TypeError("fileURLToPath: file URL host must be empty or localhost");
  }
  let pathname = u.pathname;
  // Decode %XX (Node throws on malformed sequences via decodeURIComponent).
  pathname = decodeURIComponent(pathname);
  return pathname;
}

const unsupported = (name: string) => (..._args: never[]): never => {
  throw new Error(`not implemented in the browser build: node:url.${name}`);
};

export const pathToFileURL = unsupported("pathToFileURL");
export const fileURLToPathBuffer = unsupported("fileURLToPathBuffer");
export const urlToHttpOptions = unsupported("urlToHttpOptions");
