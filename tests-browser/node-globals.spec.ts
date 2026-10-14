/**
 * Static audit: every Node-global runtime use reachable from the five tool
 * entries (plus the browser worker entry) must be allow-listed below as
 * shim-covered or as a leaf-engine seam. A new Node-global use in the tool
 * graph fails this test. Type-only uses are ignored.
 *
 * Method: build a program over the import graph with `types: ["node"]` so
 * Node globals resolve to `@types/node`, then list every value-position
 * identifier use whose symbol is declared ONLY in `@types/node` (not in the
 * DOM/ES libs) and is not imported or locally declared. Reported as
 * `Global.member` (`Buffer.from`, `process.platform`) or `Buffer.method`
 * for Buffer-typed receivers (`Buffer.toString`); bare value uses as `Buffer`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as ts from "typescript";
import { TOOL_ENTRIES } from "./build.mjs";

export interface AllowEntry {
  /** How the use is satisfied: "shim:<file>" or "leaf:<owning seam>". */
  cover: string;
  /** Repo-relative files where a use of this pair may appear. */
  files: string[];
}

export const ALLOW: Record<string, AllowEntry> = {
  "Buffer": {
    cover: "shim:src/browser/shims/buffer.ts (bare global read; the differential scenario aliases it)",
    files: ["tests-browser/scenarios/buffer.ts"],
  },
  "Buffer.from": {
    cover: "shim:src/browser/shims/buffer.ts",
    files: ["src/core/source/extract.ts", "src/core/source/prepare.ts", "src/core/tools/registry.ts", "src/core/verify/workflow.ts"],
  },
  "Buffer.concat": {
    cover: "shim:src/browser/shims/buffer.ts",
    files: ["src/core/source/download.ts"],
  },
  "Buffer.equals": {
    cover: "shim:src/browser/shims/buffer.ts (required subset; proven by the differential scenario)",
    files: ["tests-browser/scenarios/buffer.ts"],
  },
  "Buffer.includes": {
    cover: "shim:src/browser/shims/buffer.ts (Uint8Array's takes a byte, not a string)",
    files: ["src/core/source/prepare.ts", "tests-browser/scenarios/buffer.ts"],
  },
  "Buffer.indexOf": {
    cover: "shim:src/browser/shims/buffer.ts (string needles like Node)",
    files: ["tests-browser/scenarios/buffer.ts"],
  },
  "Buffer.subarray": {
    cover: "shim:src/browser/shims/buffer.ts (same-kind shared view)",
    files: ["tests-browser/scenarios/buffer.ts"],
  },
  "Buffer.toString": {
    cover: "shim:src/browser/shims/buffer.ts (encodings live in the claim engine too)",
    files: ["src/core/source/prepare.ts", "src/core/verify/claim.ts", "src/core/verify/workflow.ts", "tests-browser/scenarios/buffer.ts"],
  },
  "process": {
    cover: "shim:src/browser/shims/process.ts (element access in the worker op)",
    files: ["src/browser/worker.ts"],
  },
  "process.env": {
    cover: "shim:src/browser/shims/process.ts (host-settable env; the worker op proves it)",
    files: ["src/browser/worker.ts"],
  },
  "process.arch": {
    cover: "leaf:src/core/embed/runtime.ts (embed engine dispatch)",
    files: ["src/core/embed/runtime.ts", "src/browser/worker.ts"],
  },
  "process.exit": {
    cover: "leaf:src/core/embed/runtime.ts (embed engine dispatch)",
    files: ["src/core/embed/runtime.ts"],
  },
  "process.once": {
    cover: "leaf:src/core/embed/runtime.ts + src/core/verify/claim.ts (engine dispatch)",
    files: ["src/core/embed/runtime.ts", "src/core/verify/claim.ts"],
  },
  "process.pid": {
    cover: "leaf:fs staging names (fs is stubbed in the browser, so this is unreachable there)",
    files: ["src/core/registry.ts", "src/core/compile/managed.ts", "src/core/embed/runtime.ts", "src/browser/worker.ts"],
  },
  "process.platform": {
    cover: "leaf:src/core/compile/engine.ts + src/core/embed/runtime.ts + src/core/verify/eos-onnx.ts (engine dispatch)",
    files: ["src/core/compile/engine.ts", "src/core/embed/runtime.ts", "src/core/verify/eos-onnx.ts", "src/browser/worker.ts"],
  },
  "process.removeListener": {
    cover: "leaf:src/core/embed/runtime.ts (embed engine dispatch)",
    files: ["src/core/embed/runtime.ts"],
  },
};

/** file:line:API uses keyed by `Global.member`, repo-relative. Exported for TDD red/green probing. */
export function collectNodeGlobalUses(root: string): Map<string, Set<string>> {
  const entries = TOOL_ENTRIES.map((e) => path.join(root, e)).concat([path.join(root, "src/browser/worker.ts")]);
  const program = ts.createProgram(entries, {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    strict: true,
    skipLibCheck: true,
    types: ["node"],
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const uses = new Map<string, Set<string>>();
  const add = (api: string, file: string, line: number): void => {
    if (!uses.has(api)) uses.set(api, new Set());
    uses.get(api)?.add(`${file}:${line}`);
  };
  const inNodeTypes = (d: ts.Declaration): boolean => d.getSourceFile().fileName.includes("@types/node");
  const inTypePosition = (node: ts.Node): boolean => {
    let p: ts.Node | undefined = node.parent;
    while (p !== undefined) {
      if (p.kind >= ts.SyntaxKind.FirstTypeNode && p.kind <= ts.SyntaxKind.LastTypeNode) return true;
      if (ts.isImportDeclaration(p) || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamedImports(p) || ts.isExportSpecifier(p)) return true;
      p = p.parent;
    }
    return false;
  };

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !file.fileName.startsWith(root) || file.fileName.includes("node_modules")) continue;
    const rel = path.relative(root, file.fileName);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        // Walk to the chain root, keeping the member closest to it.
        const names: string[] = [node.name.text];
        let expr: ts.Expression = node.expression;
        for (;;) {
          if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr)) {
            expr = expr.expression;
            continue;
          }
          if (ts.isCallExpression(expr)) {
            expr = expr.expression;
            continue;
          }
          if (ts.isPropertyAccessExpression(expr)) {
            names.unshift(expr.name.text);
            expr = expr.expression;
            continue;
          }
          break;
        }
        if (ts.isIdentifier(expr) && !inTypePosition(expr)) {
          const decls = checker.getSymbolAtLocation(expr)?.getDeclarations() ?? [];
          if (decls.length > 0 && decls.every(inNodeTypes)) {
            const lc = file.getLineAndCharacterOfPosition(expr.getStart());
            add(`${expr.text}.${names[0]}`, rel, lc.line + 1);
          } else {
            // Node-typed receiver method (e.g. Buffer.prototype.toString):
            // the shim must cover it even though the receiver is not a global.
            try {
              const t = checker.getTypeAtLocation(node.expression);
              const tsym = t.symbol ?? t.aliasSymbol;
              const tdecls = tsym?.getDeclarations() ?? [];
              if (tsym?.name === "Buffer" && tdecls.some(inNodeTypes)) {
                const pdecls = checker.getSymbolAtLocation(node.name)?.getDeclarations() ?? [];
                if (pdecls.length > 0 && pdecls.every(inNodeTypes)) {
                  const lc = file.getLineAndCharacterOfPosition(node.name.getStart());
                  add(`Buffer.${node.name.text}`, rel, lc.line + 1);
                }
              }
            } catch {
              // Unresolvable receiver type: ignore (fail open here; the
              // global-root pass above is the strict one).
            }
          }
        }
      } else if (ts.isIdentifier(node)) {
        const parent = node.parent;
        if (
          (ts.isPropertyAccessExpression(parent) && (parent.expression === node || parent.name === node)) ||
          (ts.isPropertyAssignment(parent) && parent.name === node)
        ) {
          // Handled by the property-access branch above (Global.member), or
          // an object-literal key: never a global use itself.
        } else if (!inTypePosition(node)) {
          const decls = checker.getSymbolAtLocation(node)?.getDeclarations() ?? [];
          if (decls.length > 0 && decls.every(inNodeTypes)) {
            const lc = file.getLineAndCharacterOfPosition(node.getStart());
            add(node.text, rel, lc.line + 1);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return uses;
}

test("tool graph uses only allow-listed Node globals", { timeout: 180000 }, () => {
  const root = path.resolve(import.meta.dirname, "..");
  const actual = collectNodeGlobalUses(root);
  const problems: string[] = [];
  for (const api of [...actual.keys()].sort()) {
    const entry = ALLOW[api];
    if (entry === undefined) {
      problems.push(`new Node-global use, add a shim or leaf seam: ${api} at ${[...(actual.get(api) ?? [])].sort().join(" ")}`);
      continue;
    }
    for (const loc of [...(actual.get(api) ?? [])].sort()) {
      const locFile = loc.slice(0, loc.lastIndexOf(":"));
      if (!entry.files.includes(locFile)) problems.push(`${api} newly used in ${loc} (allow-listed files: ${entry.files.join(", ")})`);
    }
  }
  for (const api of Object.keys(ALLOW).sort()) {
    if (!actual.has(api)) problems.push(`stale allow-list entry (no longer used in the graph): ${api}`);
  }
  console.log("  Node-global uses (shimmed / leaf):");
  for (const api of [...actual.keys()].sort()) {
    console.log(`  - ${api} [${ALLOW[api]?.cover ?? "UNLISTED"}] ${[...(actual.get(api) ?? [])].sort().join(" ")}`);
  }
  assert.deepEqual(problems, []);
});
