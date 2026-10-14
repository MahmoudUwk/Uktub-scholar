/**
 * Differential scenario: the `node:fs` (+ tiny `node:os`) surface the core uses.
 *
 * Runs UNCHANGED against the real `node:fs` (Node, `root` = a temp dir) and
 * against `src/browser/shims/fs.ts` (Chromium worker, `root` = `/proj`) via
 * the esbuild alias. Every step mirrors an exact core call pattern
 * (project-tree `mkdirSync({recursive:true})`, text/binary write+read,
 * overwrite, read-modify-write append, `existsSync`, `statSync` fields the
 * core reads, `readdirSync` incl. `withFileTypes`, file/dir/overwrite/
 * read-only-target renames, `copyFileSync`, `rmSync({recursive,force})`,
 * `chmodSync(0o444/0o644)`, `realpathSync` dot-forms, `accessSync`, and the
 * error code of every failure the core can hit).
 *
 * Normalization (NOT weakening: identical rules both sides): `root` in
 * messages maps to `$ROOT`; `readdirSync` results are sorted (order is
 * OS-dependent); mtimes check as plausible (`MTIME`, never equal); directory
 * sizes map to `DIR`; fresh-file permission bits assert read-only-or-not
 * only (creation modes depend on the host umask), while post-`chmodSync`
 * modes assert exactly; the 5 MiB binary compares by digest.
 */
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { norm, step, type Norm } from "./norm.ts";

function scrub(value: Norm, root: string): Norm {
  if (typeof value === "string") return value.split(root).join("$ROOT");
  if (Array.isArray(value)) return value.map((v) => scrub(v, root));
  if (value !== null && typeof value === "object") {
    const out: Record<string, Norm> = {};
    for (const k of Object.keys(value)) out[k] = scrub((value as Record<string, Norm>)[k], root);
    return out;
  }
  return value;
}

function mtimeNorm(v: unknown): Norm {
  if (typeof v !== "number" || !Number.isFinite(v)) return `BAD_MTIME:${String(v)}` as unknown as Norm;
  return (v > 946684800000 && v < Date.now() + 60000 ? "MTIME" : `BAD_MTIME:${String(v)}`) as unknown as Norm;
}

function statNorm(s: { isFile(): boolean; isDirectory(): boolean; size: number; mode: number; mtimeMs: number }): Norm {
  return norm({
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    size: s.isFile() ? s.size : "DIR",
    writable: (s.mode & 0o200) !== 0 ? 1 : 0,
    mtime: mtimeNorm(s.mtimeMs),
  });
}

function digest(bytes: Uint8Array): Norm {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + (bytes[i] as number)) >>> 0;
  return norm({ len: bytes.length, head: [...bytes.slice(0, 16)], tail: [...bytes.slice(-16)], sum });
}

export function fsCaseCount(): number {
  // Stable count of `out[...]` assignments in runFsScenario (asserts the
  // scenario keeps covering the whole surface; bump with new cases).
  return 52;
}

export function runFsScenario(root: string): Record<string, Norm> {
  const out: Record<string, Norm> = {};
  // Local-only helper: never leaves this function, never part of `out`.
  const S = (fn: () => unknown): Norm => scrub(step(fn), root);
  const R = (rel: string): string => `${root}/${rel}`;

  // os seam values: only their shape is differential (exact strings are
  // shim-only assertions in the spec: /tmp and /home/user).
  out["osShape"] = norm({
    tmp: typeof tmpdir() === "string" && tmpdir().startsWith("/") ? "ABS" : tmpdir(),
    home: typeof homedir() === "string" && homedir().startsWith("/") ? "ABS" : homedir(),
  });

  // Project tree creation (registry.ts / review/run.ts / compile/run.ts pattern).
  out["mkdirTree"] = S(() => {
    mkdirSync(R("paper/sections"), { recursive: true });
    mkdirSync(R("refs"), { recursive: true });
    mkdirSync(R("evidence"), { recursive: true });
    return (readdirSync(root) as string[]).slice().sort();
  });

  // Text write + read (writeFileSync staged biblio pattern, "utf-8" spelling).
  const tex = "\\documentclass{article}\n\\begin{document}\ncaf\u00e9 \\cite{doe2024}\n\\end{document}\n";
  out["writeText"] = S(() => {
    writeFileSync(R("paper/main.tex"), tex, "utf-8");
    return readFileSync(R("paper/main.tex"), "utf8");
  });

  // Binary: all 256 byte values, exact round trip (tools/registry.ts pattern:
  // readFileSync with no encoding is a Buffer whose .toString() is used).
  out["binary256"] = S(() => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    writeFileSync(R("paper/blob.bin"), all);
    const back = readFileSync(R("paper/blob.bin")) as unknown as Uint8Array;
    return { bytes: [...back], asStringHex: (back as unknown as { toString(e: string): string }).toString("hex").slice(0, 32) };
  });

  // 5 MiB binary by digest (full arrays would bloat the RPC result).
  out["binary5M"] = S(() => {
    const n = 5 * 1024 * 1024;
    const big = new Uint8Array(n);
    for (let i = 0; i < n; i++) big[i] = (i * 31 + (i >> 8)) & 0xff;
    writeFileSync(R("evidence/big.bin"), big);
    return digest(readFileSync(R("evidence/big.bin")) as unknown as Uint8Array);
  });

  // Overwrite truncates (writeBibliography re-render pattern).
  out["overwrite"] = S(() => {
    writeFileSync(R("refs/notes.txt"), "first");
    writeFileSync(R("refs/notes.txt"), "second-longer");
    return readFileSync(R("refs/notes.txt"), "utf8");
  });

  // Append via read-modify-write (the only append the core does).
  out["appendRmw"] = S(() => {
    writeFileSync(R("refs/log.txt"), "a");
    writeFileSync(R("refs/log.txt"), `${readFileSync(R("refs/log.txt"), "utf8")}b`);
    return readFileSync(R("refs/log.txt"), "utf8");
  });

  // existsSync on file/dir/missing/under-a-file (tool-owned.ts pattern).
  out["exists"] = S(() => ({
    file: existsSync(R("paper/main.tex")),
    dir: existsSync(R("refs")),
    missing: existsSync(R("refs/nope.txt")),
    underFile: existsSync(R("paper/main.tex/child")),
  }));

  // statSync fields the core reads (isFile/isDirectory/size/mtimeMs/mode).
  out["statFile"] = S(() => statNorm(statSync(R("paper/main.tex"))));
  out["statDir"] = S(() => statNorm(statSync(R("refs"))));
  out["lstatEqStat"] = S(() => {
    const a = statNorm(statSync(R("paper/main.tex")));
    const b = statNorm(lstatSync(R("paper/main.tex")));
    return { same: JSON.stringify(a) === JSON.stringify(b) ? 1 : 0, a, b };
  });

  // readdirSync names (sorted in-scenario) + withFileTypes (registry.ts sweep).
  out["readdir"] = S(() => ((readdirSync(R("paper")) as string[]).slice().sort()));
  out["readdirTypes"] = S(() =>
    (readdirSync(R("paper"), { withFileTypes: true }) as Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>)
      .map((e) => ({ name: e.name, f: e.isFile() ? 1 : 0, d: e.isDirectory() ? 1 : 0 }))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
  );

  // renameSync file, directory, over an existing file.
  out["renameFile"] = S(() => {
    writeFileSync(R("refs/mv.txt"), "mv");
    renameSync(R("refs/mv.txt"), R("refs/moved.txt"));
    return { gone: existsSync(R("refs/mv.txt")), content: readFileSync(R("refs/moved.txt"), "utf8") };
  });
  out["renameDir"] = S(() => {
    mkdirSync(R("evidence/pack"), { recursive: true });
    writeFileSync(R("evidence/pack/a.txt"), "1");
    writeFileSync(R("evidence/pack/b.txt"), "2");
    renameSync(R("evidence/pack"), R("evidence/packed"));
    return {
      gone: existsSync(R("evidence/pack")),
      kids: ((readdirSync(R("evidence/packed")) as string[]).slice().sort()),
      a: readFileSync(R("evidence/packed/a.txt"), "utf8"),
    };
  });
  out["renameOverFile"] = S(() => {
    writeFileSync(R("refs/t1.txt"), "1");
    writeFileSync(R("refs/t2.txt"), "2");
    renameSync(R("refs/t1.txt"), R("refs/t2.txt"));
    return readFileSync(R("refs/t2.txt"), "utf8");
  });

  // chmodSync 0444/0644 + the bibliography dance: write fails EACCES on a
  // read-only file, rename OVER a read-only target succeeds.
  out["chmod444"] = S(() => {
    writeFileSync(R("refs/references.bib"), "@article{a,\n}\n");
    chmodSync(R("refs/references.bib"), 0o444);
    const s = statSync(R("refs/references.bib"));
    return { oct: ((s.mode & 0o777).toString(8) as string), writable: (s.mode & 0o200) !== 0 ? 1 : 0 };
  });
  out["writeReadonly"] = S(() => writeFileSync(R("refs/references.bib"), "x"));
  out["renameOverReadonly"] = S(() => {
    writeFileSync(R("refs/staged.0.tmp"), "@article{b,\n}\n");
    chmodSync(R("refs/staged.0.tmp"), 0o444);
    renameSync(R("refs/staged.0.tmp"), R("refs/references.bib"));
    return readFileSync(R("refs/references.bib"), "utf8");
  });
  out["chmod644"] = S(() => {
    chmodSync(R("refs/references.bib"), 0o644);
    writeFileSync(R("refs/references.bib"), "plain");
    return readFileSync(R("refs/references.bib"), "utf8");
  });

  // copyFileSync (+ EXCL + failures).
  out["copy"] = S(() => {
    copyFileSync(R("paper/main.tex"), R("paper/copy.tex"));
    return readFileSync(R("paper/copy.tex"), "utf8") === tex ? "SAME" : "DIFF";
  });
  out["copyExcl"] = S(() => copyFileSync(R("paper/main.tex"), R("paper/copy.tex"), fsConstants.COPYFILE_EXCL));
  out["copyMissing"] = S(() => copyFileSync(R("paper/nope.tex"), R("paper/x.tex")));
  out["copyNoDestDir"] = S(() => copyFileSync(R("paper/main.tex"), R("nodir/x.tex")));
  out["copyDir"] = S(() => copyFileSync(R("refs"), R("refs-copy")));

  // rmSync incl. missing path (+force), non-recursive dir refusal.
  out["rmFile"] = S(() => {
    rmSync(R("paper/copy.tex"));
    return existsSync(R("paper/copy.tex"));
  });
  out["rmMissing"] = S(() => rmSync(R("paper/nope.tex")));
  out["rmMissingForce"] = S(() => rmSync(R("paper/nope.tex"), { force: true }));
  out["rmDirNoRec"] = S(() => rmSync(R("evidence/packed")));
  out["rmDirRec"] = S(() => {
    rmSync(R("evidence/packed"), { recursive: true, force: true });
    return existsSync(R("evidence/packed"));
  });

  // realpathSync dot-forms + missing (tools/context.ts confinement pattern).
  out["realpathDot"] = S(() => realpathSync(R("paper/sections/..")));
  out["realpathDotDot"] = S(() => realpathSync(R("paper/sections/../sections/./")));
  out["realpathMissing"] = S(() => realpathSync(R("paper/nope.tex")));

  // accessSync (compile/engine.ts X_OK pattern + W_OK read-only refusal).
  out["access"] = S(() => {
    const got: Record<string, string> = {};
    got["fOk"] = accessSync(R("paper/main.tex")) === undefined ? "OK" : "WEIRD";
    got["missing"] = (step(() => accessSync(R("paper/nope.tex"))) as Record<string, unknown>).__error ? "THROWS" : "NO-THROW";
    chmodSync(R("paper/main.tex"), 0o444);
    got["wOkRo"] = (step(() => accessSync(R("paper/main.tex"), fsConstants.W_OK)) as Record<string, unknown>).__error ? "THROWS" : "NO-THROW";
    got["xOk644"] = (step(() => accessSync(R("paper/main.tex"), fsConstants.X_OK)) as Record<string, unknown>).__error ? "THROWS" : "NO-THROW";
    chmodSync(R("paper/main.tex"), 0o755);
    got["xOk755"] = accessSync(R("paper/main.tex"), fsConstants.X_OK) === undefined ? "OK" : "WEIRD";
    chmodSync(R("paper/main.tex"), 0o644);
    return got;
  });

  // Every remaining failure code the core can hit.
  out["errOpenMissing"] = S(() => readFileSync(R("missing.txt"), "utf8"));
  out["errMkdirOverFile"] = S(() => mkdirSync(R("paper/main.tex")));
  out["errMkdirNoParent"] = S(() => mkdirSync(R("nodir/sub")));
  out["errMkdirUnderFile"] = S(() => mkdirSync(R("paper/main.tex/child"), { recursive: true }));
  out["errReaddirFile"] = S(() => readdirSync(R("paper/main.tex")));
  out["errReaddirMissing"] = S(() => readdirSync(R("paper/nodir")));
  out["errStatMissing"] = S(() => statSync(R("paper/nope.tex")));
  out["errStatUnderFile"] = S(() => statSync(R("paper/main.tex/child")));
  out["errReadDir"] = S(() => readFileSync(R("refs")));
  out["errWriteNoDir"] = S(() => writeFileSync(R("nodir/x.txt"), "y"));
  out["errWxExists"] = S(() => writeFileSync(R("paper/main.tex"), "y", { flag: "wx" }));
  out["errRenameMissing"] = S(() => renameSync(R("paper/nope.tex"), R("paper/x.tex")));
  out["errRenameNoDestDir"] = S(() => renameSync(R("paper/main.tex"), R("nodir/x.tex")));
  out["errRenameFileOntoDir"] = S(() => renameSync(R("paper/main.tex"), R("refs")));
  out["errRenameDirOntoFile"] = S(() => {
    mkdirSync(R("evidence/d"), { recursive: true });
    return renameSync(R("evidence/d"), R("paper/main.tex"));
  });
  out["errRenameIntoSelf"] = S(() => renameSync(R("evidence/d"), R("evidence/d/sub")));
  out["errChmodMissing"] = S(() => chmodSync(R("paper/nope.tex"), 0o644));

  out["caseKeys"] = norm("v1");
  return out;
}
