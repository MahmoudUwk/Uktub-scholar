/**
 * What `npm pack` would ship: every product skill with its helper scripts and the compiled code they call, and nothing private or
 * generated (a local test paper, evidence of runs on it, Python bytecode, tests, docs, secrets). `--ignore-scripts` lists the files
 * without building anything; it needs `dist/`, which the live runners also require.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const pack = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: ROOT, encoding: "utf8" });
const skip = pack.status !== 0 || !existsSync(join(ROOT, "dist/cli/main.js"));
const files: string[] = skip ? [] : (JSON.parse(pack.stdout) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);

describe("published package contents", { skip: skip ? "npm or dist/ is not available" : false }, () => {
  const skills = readdirSync(join(ROOT, "skills")).filter((n) => statSync(join(ROOT, "skills", n)).isDirectory());
  it("ships every product skill and its helper scripts", () => {
    for (const name of skills) assert.ok(files.includes(`skills/${name}/SKILL.md`), `${name}/SKILL.md`);
    for (const name of skills) {
      const scripts = join(ROOT, "skills", name, "scripts");
      if (existsSync(scripts)) for (const f of readdirSync(scripts).filter((x) => /\.(?:py|sh|mjs)$/.test(x))) assert.ok(files.includes(`skills/${name}/scripts/${f}`), `${name}/scripts/${f}`);
    }
  });
  it("ships the compiled code the skills call, including the review command", () => {
    assert.ok(files.includes("dist/cli/main.js"));
    assert.ok(files.some((f) => /^dist\/core\/review\/run\.js$/.test(f)), "dist/core/review/run.js");
  });
  it("ships nothing private or generated", () => {
    const bad = files.filter((f) => /(?:^|\/)(?:__pycache__|test_papers|\.agents|private|tests|docs|experiments|\.sandbox|src)\//.test(f) || /\.pyc$|uktub-case\.json$|(?:^|\/)\.env/.test(f));
    assert.deepEqual(bad, []);
  });
});
