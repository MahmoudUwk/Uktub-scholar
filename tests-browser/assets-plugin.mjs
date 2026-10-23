/**
 * Bundled read-only assets for the browser build (task 1).
 *
 * The core reads bundled files with `readFileSync(new URL("./x", import.meta.url))`
 * (registry.ts -> schema.sql, verify/eos-onnx.ts, embed/runtime.ts, compile/managed.ts
 * -> lock jsons). In the worker `import.meta.url` is an `http:` URL, so this plugin:
 *
 * 1. rewrites `import.meta.url` in every `src/core/**` module to a virtual
 *    `file:///__uktub__/<repo-relative module path>` URL, so `new URL("./x", ...)`
 *    and `fileURLToPath` keep working with zero core edits;
 * 2. embeds every asset referenced by a `new URL("<literal>", import.meta.url)`
 *    pattern in `src/core/**` (never a hand-kept list; core-stubbed files such as
 *    launch.ts are skipped) into a read-only table served by `src/browser/shims/fs.ts`
 *    under `/__uktub__/…` and exposed to the bundle as the virtual module `uktob:assets`.
 *
 * Scan with `collectAssetRefs(root)`; bundle with `assetPlugin(root)`.
 */
import fs from "node:fs";
import path from "node:path";

export const ASSET_VIRTUAL_PREFIX = "/__uktub__/";
export const ASSET_MODULE = "uktub:assets";

/** The shipped research skill Pi reads from disk: the worker serves the same file as a bundled read-only asset (no copy). */
export const SKILL_VIRTUAL_PATH = `${ASSET_VIRTUAL_PREFIX}skills/uktub-research/SKILL.md`;
export function skillDiskPath(root) {
  return path.join(root, "skills", "uktub-research", "SKILL.md");
}

/** Files whose `import.meta.url` uses are bundle-stubbed away (see CORE_STUBS). */
const STUBBED_FILES = new Set(["src/core/launch.ts"]);

/**
 * Scan `src/core/**` for `new URL("<literal>", import.meta.url)` asset references.
 * Returns `{ assets: Map<virtualAbsPath, diskAbsPath>, byModule: Map<moduleRel, string[]> }`.
 * A referenced file missing from disk fails closed at build time.
 */
export function collectAssetRefs(root) {
  const coreDir = path.join(root, "src", "core");
  const assets = new Map();
  const byModule = new Map();
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        visit(p);
        continue;
      }
      if (!e.name.endsWith(".ts")) continue;
      const rel = path.relative(root, p).split(path.sep).join("/");
      if (STUBBED_FILES.has(rel)) continue;
      const text = fs.readFileSync(p, "utf8");
      const re = /new\s+URL\(\s*(["'])(\.\.?\/[^"']*)\1\s*,\s*import\.meta\.url\s*\)/g;
      let m;
      const refs = [];
      while ((m = re.exec(text)) !== null) {
        const literal = m[2];
        const disk = path.normalize(path.join(path.dirname(p), literal));
        if (!fs.existsSync(disk) || !fs.statSync(disk).isFile()) {
          throw new Error(`browser asset missing on disk: ${literal} referenced from ${rel} (resolves to ${disk})`);
        }
        const virtualDir = path.posix.dirname(`/${rel}`);
        const virtual = path.posix.normalize(path.posix.join(virtualDir, literal));
        const key = `${ASSET_VIRTUAL_PREFIX}${virtual.slice(1)}`;
        if (!assets.has(key)) assets.set(key, disk);
        refs.push(key);
      }
      if (refs.length > 0) byModule.set(rel, refs);
    }
  };
  visit(coreDir);
  return { assets, byModule };
}

/** Rewrite `import.meta.url` in a core module to its virtual `file:` URL. */
export function virtualUrlForModule(rel) {
  return `file:///__uktub__/${rel}`;
}

export function assetPlugin(root) {
  const { assets } = collectAssetRefs(root);
  // The same skill file Pi ships from disk: bundled read-only, never copied.
  const skillDisk = skillDiskPath(root);
  if (!fs.existsSync(skillDisk) || !fs.statSync(skillDisk).isFile()) {
    throw new Error(`browser asset missing on disk: skills/uktub-research/SKILL.md (resolves to ${skillDisk})`);
  }
  assets.set(SKILL_VIRTUAL_PATH, skillDisk);
  const corePrefix = path.join(root, "src", "core") + path.sep;
  return {
    name: "uktub-assets",
    setup(build) {
      build.onResolve({ filter: /^uktub:assets$/ }, () => ({ path: ASSET_MODULE, namespace: "uktub-assets" }));
      build.onLoad({ filter: /.*/, namespace: "uktub-assets" }, () => {
        const entries = [...assets.entries()]
          .map(([key, disk]) => `${JSON.stringify(key)}: ${JSON.stringify(fs.readFileSync(disk).toString("base64"))}`)
          .join(",\n");
        return { contents: `export const UKTUB_ASSETS = {\n${entries}\n};\n`, loader: "js" };
      });
      build.onLoad({ filter: /\.ts$/ }, (args) => {
        if (!args.path.startsWith(corePrefix) || !args.path.endsWith(".ts")) return null;
        const text = fs.readFileSync(args.path, "utf8");
        if (!text.includes("import.meta.url")) return null;
        const rel = path.relative(root, args.path).split(path.sep).join("/");
        const out = text.split("import.meta.url").join(JSON.stringify(virtualUrlForModule(rel)));
        return { contents: out, loader: "ts", resolveDir: path.dirname(args.path) };
      });
    },
  };
}
