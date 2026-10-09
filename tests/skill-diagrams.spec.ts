/**
 * The skeleton in skills/uktub-diagrams/SKILL.md is what the agent starts from, so it must compile with the engine the package ships
 * guidance for (Tectonic) and produce a one-page vector PDF. Skipped when no tectonic is on the PATH.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hasTectonic = spawnSync("tectonic", ["--version"], { encoding: "utf8" }).status === 0;
const SKILL = resolve(import.meta.dirname, "../skills/uktub-diagrams/SKILL.md");

describe("uktub-diagrams skeleton", { skip: !hasTectonic }, () => {
  it("compiles to a one-page PDF without raster images", () => {
    const tex = /```latex\n([\s\S]*?)```/.exec(readFileSync(SKILL, "utf8"))?.[1];
    assert.ok(tex, "no latex skeleton in the skill");
    const dir = mkdtempSync(join(tmpdir(), "diagram-"));
    writeFileSync(join(dir, "d.tex"), tex);
    const r = spawnSync("tectonic", ["-X", "compile", "d.tex"], { cwd: dir, encoding: "utf8", timeout: 240_000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-1500));
    assert.ok(existsSync(join(dir, "d.pdf")));
    const pdf = readFileSync(join(dir, "d.pdf"), "latin1");
    const info = spawnSync("pdfinfo", [join(dir, "d.pdf")], { encoding: "utf8" });
    if (info.status === 0) assert.match(info.stdout, /Pages:\s+1\b/, "a diagram is one page");
    assert.ok(!/\/Subtype\s*\/Image/.test(pdf));
  });
});
