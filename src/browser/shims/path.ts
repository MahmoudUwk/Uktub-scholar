/**
 * Browser (POSIX) implementation of the `node:path` surface the core uses.
 *
 * The core imports `node:path` (platform-specific); on the browser target the
 * semantics are fixed to POSIX, matching Node on Linux. `resolve` works
 * against a fixed virtual cwd of `/` — there is no process cwd in a worker.
 */

// Split off redundant separators and single dots; keep `..` for resolve().
const SEP = "/";
export const sep = SEP;

function isAbsolute(p: string): boolean {
  return p.length > 0 && p.charCodeAt(0) === 47;
}
export { isAbsolute };

// Normalize `.`/`..` segments. `allowAboveRoot` keeps leading `..`.
function normalizeSegments(parts: string[], allowAboveRoot: boolean): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (allowAboveRoot) out.push("..");
      continue;
    }
    out.push(part);
  }
  return out;
}

export function normalize(p: string): string {
  if (typeof p !== "string") throw new TypeError("Path must be a string");
  const abs = isAbsolute(p);
  const trailing = p.length > 1 && p.charCodeAt(p.length - 1) === 47;
  const segs = normalizeSegments(p.split("/"), !abs);
  let out = (abs ? "/" : "") + segs.join("/");
  if (out === "") out = abs ? "/" : ".";
  else if (trailing && out !== "/") out += "/";
  return out;
}

export function join(...paths: string[]): string {
  if (paths.length === 0) return ".";
  for (const p of paths) {
    if (typeof p !== "string") throw new TypeError("Path must be a string");
  }
  // Empty segments are skipped; all-empty joins to ".".
  let joined: string | undefined;
  for (const p of paths) {
    if (p.length === 0) continue;
    joined = joined === undefined ? p : `${joined}/${p}`;
  }
  if (joined === undefined) return ".";
  return normalize(joined);
}

export function resolve(...paths: string[]): string {
  let resolved = "";
  let foundAbs = false;
  for (let i = paths.length - 1; i >= 0; i--) {
    const p = paths[i];
    if (typeof p !== "string") throw new TypeError("Path must be a string");
    if (p === "") continue;
    resolved = resolved === "" ? p : `${p}/${resolved}`;
    if (isAbsolute(p)) { foundAbs = true; break; }
  }
  if (!foundAbs) resolved = `/${resolved}`;
  // resolve never keeps a trailing slash (except the root itself).
  const out = normalize(resolved);
  return out.length > 1 && out.endsWith("/") ? out.slice(0, -1) : out;
}

function stripTrailing(p: string): string {
  let end = p.length;
  while (end > 1 && p.charCodeAt(end - 1) === 47) end--;
  return p.slice(0, end);
}

export function dirname(p: string): string {
  if (typeof p !== "string") throw new TypeError("Path must be a string");
  if (p === "") return ".";
  const s = stripTrailing(p);
  const idx = s.lastIndexOf("/");
  if (idx === -1) return ".";
  if (idx === 0) return "/";
  return s.slice(0, idx);
}

export function basename(p: string, suffix?: string): string {
  if (typeof p !== "string") throw new TypeError("Path must be a string");
  if (suffix !== undefined && typeof suffix !== "string") throw new TypeError("Suffix must be a string");
  const s = stripTrailing(p);
  const idx = s.lastIndexOf("/");
  let base = idx === -1 ? s : s.slice(idx + 1);
  if (suffix !== undefined && suffix.length > 0 && base.endsWith(suffix)) {
    base = base.slice(0, base.length - suffix.length);
  }
  return base;
}

export function extname(p: string): string {
  if (typeof p !== "string") throw new TypeError("Path must be a string");
  const base = basename(p);
  if (base === "" || base === "." || base === "..") return "";
  const idx = base.lastIndexOf(".");
  // Leading dot with no other dot (`.bashrc`) is not an extension.
  if (idx <= 0) return "";
  return base.slice(idx);
}

export function relative(from: string, to: string): string {
  if (typeof from !== "string" || typeof to !== "string") throw new TypeError("Path must be a string");
  const f = resolve(from);
  const t = resolve(to);
  if (f === t) return "";
  const fSegs = f.split("/").filter((s) => s !== "");
  const tSegs = t.split("/").filter((s) => s !== "");
  let i = 0;
  while (i < fSegs.length && i < tSegs.length && fSegs[i] === tSegs[i]) i++;
  const up = fSegs.length - i;
  const parts: string[] = [];
  for (let k = 0; k < up; k++) parts.push("..");
  for (let k = i; k < tSegs.length; k++) parts.push(tSegs[k]);
  return parts.join("/") || "";
}

export interface ParsedPath {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}

export function parse(p: string): ParsedPath {
  if (typeof p !== "string") throw new TypeError("Path must be a string");
  const root = isAbsolute(p) ? "/" : "";
  const base = basename(p);
  const ext = extname(p);
  const dir = dirname(p) === "." && root === "" ? "" : dirname(p);
  return { root, dir, base, ext, name: base.slice(0, base.length - ext.length) };
}

const unsupported = (name: string) => (..._args: never[]): never => {
  throw new Error(`not implemented in the browser build: node:path.${name}`);
};
export const delimiter = ":";
export const posix = { resolve, join, dirname, basename, extname, relative, isAbsolute, normalize, sep, parse, delimiter };
export const format = unsupported("format");
export const matchesGlob = unsupported("matchesGlob");
export const toNamespacedPath = unsupported("toNamespacedPath");
export const win32 = unsupported("win32") as unknown as typeof posix;

const def = { resolve, join, dirname, basename, extname, relative, isAbsolute, normalize, sep, parse, delimiter, posix, format };
export default def;
