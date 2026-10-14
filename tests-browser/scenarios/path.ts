/**
 * Differential scenario: node:path (POSIX) surface the core uses.
 *
 * Runs UNCHANGED against `node:path/posix` (Node) and `src/browser/shims/path.ts`
 * (Chromium worker). `resolve` cases are anchored so they never depend on the
 * process cwd (the shim resolves against the fixed virtual cwd `/`).
 */
import posix from "node:path/posix";
import { norm, step, type Norm } from "./norm.ts";

type Case = [fn: string, args: string[]];

const CASES: Case[] = [
  ["resolve", ["/", "a", "b"]],
  ["resolve", ["/a", "b", "c"]],
  ["resolve", ["/a", "/b", "c"]],
  ["resolve", ["a", "/b"]],
  ["resolve", ["/a/./b", "../c"]],
  ["resolve", ["/"]],
  ["resolve", ["/a", ".."]],
  ["resolve", ["/a", "../.."]],
  ["resolve", ["/a/b/", "../", "./c/"]],
  ["resolve", ["", "/x"]],
  ["resolve", ["/x", ""]],
  ["resolve", ["/a//b", "c"]],
  ["join", ["a", "b", "c"]],
  ["join", ["/a", "b"]],
  ["join", ["a", "", "b"]],
  ["join", ["a", ""]],
  ["join", ["", "a"]],
  ["join", ["", ""]],
  ["join", ["a", "..", "b"]],
  ["join", ["/", "a"]],
  ["join", ["a/", "b/"]],
  ["dirname", ["/a/b/c"]],
  ["dirname", ["/a/b/"]],
  ["dirname", ["/a"]],
  ["dirname", ["/"]],
  ["dirname", ["a"]],
  ["dirname", [""]],
  ["dirname", ["a/b"]],
  ["dirname", ["/a//b//c"]],
  ["basename", ["/a/b/c.txt"]],
  ["basename", ["/a/b/c.txt", ".txt"]],
  ["basename", ["/a/b/", ]],
  ["basename", [""]],
  ["basename", ["/"]],
  ["basename", ["c.txt", ".txt"]],
  ["basename", ["archive.tar.gz", ".gz"]],
  ["basename", ["a", "a"]],
  ["extname", ["c.txt"]],
  ["extname", ["archive.tar.gz"]],
  ["extname", [".bashrc"]],
  ["extname", ["a."]],
  ["extname", [".."]],
  ["extname", [""]],
  ["extname", ["/a/b/c.TXT"]],
  ["extname", ["a..b"]],
  ["relative", ["/a/b", "/a/b/c"]],
  ["relative", ["/a/b/c", "/a/b"]],
  ["relative", ["/a/b", "/a/c"]],
  ["relative", ["/", "/a"]],
  ["relative", ["/a", "/"]],
  ["relative", ["/a/b", "/a/b"]],
  ["relative", ["/x/y", "/p/q"]],
  ["relative", ["/a/", "/a/b/"]],
  ["isAbsolute", ["/a"]],
  ["isAbsolute", ["a"]],
  ["isAbsolute", [""]],
  ["isAbsolute", ["/"]],
  ["normalize", [""]],
  ["normalize", ["/a//b/../c"]],
  ["normalize", ["a/./b"]],
  ["normalize", ["../a"]],
  ["normalize", ["/../a"]],
  ["normalize", ["/a/b/"]],
  ["normalize", ["a/b/"]],
  ["normalize", ["/"]],
  ["normalize", ["."]],
  ["normalize", ["a/../../b"]],
  ["parse", ["/a/b/c.txt"]],
  ["parse", ["a"]],
  ["parse", ["/"]],
];

export function pathCaseCount(): number {
  return CASES.length;
}

export function runPathScenario(): Record<string, Norm> {
  const out: Record<string, Norm> = {};
  out["sep"] = norm((posix as unknown as { sep: string }).sep);
  out["count"] = norm(CASES.length);
  CASES.forEach(([fn, args], i) => {
    out[`case-${i}-${fn}-${args.join("+")}`] = step(() => {
      switch (fn) {
        case "resolve": return posix.resolve(...(args as [string, ...string[]]));
        case "join": return posix.join(...(args as [string, ...string[]]));
        case "dirname": return posix.dirname(args[0]);
        case "basename": return args.length > 1 ? posix.basename(args[0], args[1]) : posix.basename(args[0]);
        case "extname": return posix.extname(args[0]);
        case "relative": return posix.relative(args[0], args[1]);
        case "isAbsolute": return posix.isAbsolute(args[0]);
        case "normalize": return posix.normalize(args[0]);
        case "parse": return posix.parse(args[0]);
        default: throw new Error(`unknown fn ${fn}`);
      }
    });
  });
  return out;
}
