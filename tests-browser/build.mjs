/**
 * esbuild bundling for the browser build of the Uktub Scholar core.
 *
 * The core stays synchronous and runs in ONE dedicated Web Worker. At bundle
 * time every `node:*` module in the core's import graph is replaced:
 *  - node:sqlite, node:crypto, node:zlib, node:path (+ node:path/posix),
 *    node:url  -> thin synchronous browser implementations in src/browser/
 *  - every other node:* module -> a throwing stub that fails at CALL time
 *    (never at import time) with "not implemented in the browser build:
 *    <module>.<export>".
 *
 * The Node tsc build is untouched; this file is only used by
 * `pnpm build:browser` and `pnpm test:browser`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/** node:* specifier -> shim source file (relative to repo root). */
export const ALIAS_TABLE = {
  "node:sqlite": "src/browser/shims/sqlite.ts",
  "node:crypto": "src/browser/shims/crypto.ts",
  "node:zlib": "src/browser/shims/zlib.ts",
  "node:path": "src/browser/shims/path.ts",
  "node:path/posix": "src/browser/shims/path.ts",
  "node:url": "src/browser/shims/url.ts",
  "node:fs": "src/browser/shims/fs.ts",
  "node:os": "src/browser/shims/os.ts",
};

/**
 * Scan the core import graph for every `from "node:<mod>"` import so the
 * stub generator below can emit static named exports (ESM needs them) for
 * exactly the names the core reaches. Returns
 * { "<mod>": { named: string[], hasDefault: boolean } }.
 */
export function collectNodeImports(srcDir) {
  const found = new Map();
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { visit(p); continue; }
      if (!e.name.endsWith(".ts")) continue;
      const text = fs.readFileSync(p, "utf8");
      // import ... from "node:x" | "tar"  |  import "…"  |  export … from "…"
      const re = /(?:import|export)\s+([^"';]*?from\s+)?["']((?:node:[a-z0-9_/]+)|tar)["']/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const clause = (m[1] ?? "").replace(/\s+from\s+$/, "").trim();
        const mod = m[2];
        if (!found.has(mod)) found.set(mod, { named: new Set(), hasDefault: false });
        const rec = found.get(mod);
        if (/^\*\s+as\s+([\w$]+)/.test(clause)) {
          // import * as ns: needs every named export the file could touch;
          // the union over the graph (below) covers it; mark default too.
          rec.hasDefault = true;
          continue;
        }
        const def = /^([\w$]+)\s*(,|$)/.exec(clause);
        if (def) rec.hasDefault = true;
        const named = /\{([^}]*)\}/.exec(clause);
        if (named) {
          for (const part of named[1].split(",")) {
            // `constants as fsConstants` exports `constants`; the stub must
            // carry the ORIGINAL name (esbuild maps the alias at import).
            const orig = part.trim().split(/\s+as\s+/)[0]?.trim().replace(/^type\s+/, "");
            if (orig && orig !== "type") rec.named.add(orig);
          }
        }
      }
    }
  };
  visit(srcDir);
  return found;
}

/** Modules with a real browser implementation (never stubbed). */
const aliased = new Set(Object.keys(ALIAS_TABLE));

/**
 * Bundle-time globals: bare `Buffer` / `process` uses in the core resolve to
 * these shim modules through esbuild `inject` (named exports match the
 * global names). Type-level twins live in `src/browser/globals.d.ts`.
 */
export const GLOBAL_INJECT = [
  "src/browser/shims/buffer.ts",
  "src/browser/shims/process.ts",
];

/**
 * Whole third-party packages that belong to future seams (archive handling)
 * and are stubbed as a unit in the browser build. Names are scanned from the
 * core import graph like node:* stubs. `unpdf` (PDF extraction) is NOT stubbed:
 * its eval-free pdf.js build runs in the worker (tests-browser/pdf.spec.ts).
 */
export const STUB_PACKAGES = ["tar"];

/**
 * Core-relative files with no meaning in a static client, stubbed at bundle
 * time (import-time evaluation would otherwise kill the worker):
 * - `src/core/launch.ts`: CLI identity (`BIN_PATH` is computed at import
 *   with `fileURLToPath(import.meta.url)`, an `http:` URL in the worker).
 *   The only core caller is the registry open-refusal message
 *   (`openRegistry`, never run through the worker); `cliCommand` throws at
 *   CALL time. Preferred fix, which deletes this stub: lazy `BIN_PATH` in
 *   core.
 */
export const CORE_STUBS = {
  [path.join(root, "src/core/launch.ts")]: [
    `// Bundle-time browser stub for src/core/launch.ts (no CLI entry here).`,
    `export const BIN_PATH = "";`,
    `// The static client has no CLI: the message names the app action, and the typed refusal (REGISTRY_NOT_INITIALIZED) is preserved.`,
    `export const cliCommand = (subcommand) => "the app's " + JSON.stringify(subcommand) + " action";`,
  ].join("\n"),
};

/**
 * esbuild plugin: resolve aliased modules to shims, stub the rest.
 * `extraStubs` maps additional specifiers (e.g. "node:test") to stub treatment.
 */
export function nodeShimPlugin(found) {
  return {
    name: "uktub-node-shims",
    setup(build) {
      for (const [spec, target] of Object.entries(ALIAS_TABLE)) {
        const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        build.onResolve({ filter: new RegExp(`^${esc}$`) }, () => ({
          path: path.join(root, target),
        }));
      }
      build.onResolve({ filter: /^node:/ }, (args) => {
        if (aliased.has(args.path)) return null;
        return { path: args.path, namespace: "uktub-node-stub" };
      });
      for (const pkg of STUB_PACKAGES) {
        const escPkg = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        build.onResolve({ filter: new RegExp(`^${escPkg}$`) }, (args) => {
          return { path: `pkg:${args.path}`, namespace: "uktub-node-stub" };
        });
      }
      for (const abs of Object.keys(CORE_STUBS)) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (!args.importer || args.importer.startsWith("uktub-")) return null;
          if (path.resolve(path.dirname(args.importer), args.path) !== abs) return null;
          return { path: abs, namespace: "uktub-core-stub" };
        });
      }
      build.onLoad({ filter: /.*/, namespace: "uktub-core-stub" }, (args) => {
        return { contents: CORE_STUBS[args.path] ?? "", loader: "js" };
      });
      build.onLoad({ filter: /.*/, namespace: "uktub-node-stub" }, (args) => {
        const mod = args.path.startsWith("pkg:") ? args.path.slice(4) : args.path;
        const rec = found.get(mod) ?? { named: new Set(), hasDefault: false };
        const names = [...rec.named].filter((n) => n !== "default");
        const lines = [
          `// Auto-generated browser-build stub for ${mod}.`,
          `// Throws at CALL time, never at import time.`,
          `const fail = (name) => (..._a) => { throw new Error("not implemented in the browser build: ${mod}." + name); };`,
        ];
        for (const n of names) lines.push(`export const ${n} = fail(${JSON.stringify(n)});`);
        lines.push(`const __target = (..._a) => { throw new Error("not implemented in the browser build: ${mod} (default call)"); };`);
        lines.push(`export default new Proxy(__target, {`);
        lines.push(`  get: (_t, p) => { if (p === "__esModule" || p === Symbol.toStringTag) return undefined; return fail(String(p)); },`);
        lines.push(`  apply: () => { throw new Error("not implemented in the browser build: ${mod} (default call)"); },`);
        lines.push(`});`);
        return { contents: lines.join("\n"), loader: "js" };
      });
    },
  };
}

export async function bundle(entryRel, outRel, { extraEntries = {} } = {}) {
  const { default: esbuild } = await import("esbuild");
  const { assetPlugin } = await import("./assets-plugin.mjs");
  const found = collectNodeImports(path.join(root, "src"));
  const entryPoints = {};
  entryPoints[path.basename(outRel, ".js")] = path.join(root, entryRel);
  for (const [k, v] of Object.entries(extraEntries)) entryPoints[k] = path.join(root, v);
  await esbuild.build({
    entryPoints,
    outdir: path.dirname(path.join(root, outRel)),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2024",
    loader: { ".wasm": "file" },
    inject: GLOBAL_INJECT.map((f) => path.join(root, f)),
    plugins: [nodeShimPlugin(found), assetPlugin(root)],
    logLevel: "warning",
  });
  return found;
}

/** The six tool graphs the bundle proof must compile (task 5 + doctor). */
export const TOOL_ENTRIES = [
  "src/core/tools/registry.ts",
  "src/core/tools/passages.ts",
  "src/core/tools/verify.ts",
  "src/core/tools/compile.ts",
  "src/core/tools/search.ts",
  "src/core/tools/doctor.ts",
];

/**
 * For every still-stubbed node:* module: the core files and the exports they
 * reach. This is the work list for the file-system, download and engine seams.
 */
export function remainingNodeImports() {
  const found = collectNodeImports(path.join(root, "src"));
  const perModule = new Map();
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { visit(p); continue; }
      if (!e.name.endsWith(".ts")) continue;
      const text = fs.readFileSync(p, "utf8");
      const re = /(?:import|export)\s+([^"';]*?from\s+)?["']((?:node:[a-z0-9_/]+)|tar)["']/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const mod = m[2];
        if (aliased.has(mod)) continue;
        if (!perModule.has(mod)) perModule.set(mod, new Map());
        const files = perModule.get(mod);
        const rel = path.relative(root, p);
        if (!files.has(rel)) files.set(rel, new Set());
        const clause = (m[1] ?? "").replace(/\s+from\s+$/, "").trim();
        const named = /\{([^}]*)\}/.exec(clause);
        if (named) for (const part of named[1].split(",")) {
          const nm = part.trim().split(/\s+as\s+/)[0]?.trim().replace(/^type\s+/, "");
          if (nm && nm !== "type") files.get(rel).add(nm);
        }
        const def = /^([\w$]+)\s*(,|$)/.exec(clause);
        if (def || /^\*\s+as/.test(clause)) files.get(rel).add("(default/namespace)");
      }
    }
  };
  visit(path.join(root, "src"));
  return { found, perModule };
}

// CLI: pnpm build:browser -- <entry> <out> | --tools <outdir> | --report
const args = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(root, "tests-browser/build.mjs")) {
  if (args[0] === "--tools") {
    const outdir = args[1] ?? "dist-browser/tools";
    const { default: esbuild } = await import("esbuild");
    const { assetPlugin } = await import("./assets-plugin.mjs");
    const found = collectNodeImports(path.join(root, "src"));
    const entries = Object.fromEntries(TOOL_ENTRIES.map((e) => [path.basename(e, ".ts"), path.join(root, e)]));
    await esbuild.build({
      entryPoints: entries, outdir: path.join(root, outdir), bundle: true,
      platform: "browser", format: "esm", target: "es2024",
      loader: { ".wasm": "file" }, plugins: [nodeShimPlugin(found), assetPlugin(root)], logLevel: "warning",
    });
    console.log(`bundled ${TOOL_ENTRIES.length} tool graphs -> ${outdir}`);
  } else if (args[0] === "--worker") {
    await bundle("src/browser/worker.ts", (args[1] ?? "dist-browser/worker.js"));
    console.log("worker bundled");
  } else if (args[0] === "--report") {
    const { perModule } = remainingNodeImports();
    for (const [mod, files] of [...perModule.entries()].sort()) {
      console.log(mod);
      for (const [f, names] of [...files.entries()].sort()) console.log(`  ${f}: ${[...names].sort().join(", ")}`);
    }
  } else {
    const [entry, out] = args;
    if (!entry || !out) { console.error("usage: build.mjs (--tools outdir | --worker [out] | --report | <entry> <out>)"); process.exit(1); }
    await bundle(entry, out);
    console.log(`bundled ${entry} -> ${out}`);
  }
}
