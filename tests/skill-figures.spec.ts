/**
 * The helper module of the uktub-figures skill (skills/uktub-figures/scripts/figstyle.py): page-width figures, a colour-blind-safe
 * palette, vector PDF with embedded fonts, a PNG preview for looking at the result, a record of the plotted data, and an audit that
 * names real defects. Needs python3 with matplotlib (the skill's stated prerequisite); skipped without it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPTS = resolve(import.meta.dirname, "../skills/uktub-figures/scripts");
const hasMatplotlib = spawnSync("python3", ["-c", "import matplotlib"], { encoding: "utf8" }).status === 0;

function runFigure(body: string): { dir: string; out: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), "figstyle-"));
  writeFileSync(join(dir, "make.py"), `import sys\nsys.path.insert(0, ${JSON.stringify(SCRIPTS)})\nimport numpy as np\nfrom figstyle import COLUMN, TEXT, WIDE, PALETTE, use_style, figure, save\nuse_style()\n${body}\n`);
  const r = spawnSync("python3", ["make.py"], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "", MPLBACKEND: "Agg", MPLCONFIGDIR: join(dir, "mpl") } });
  return { dir, out: `${r.stdout}${r.stderr}`, status: r.status };
}

describe("figstyle (skill helper)", { skip: !hasMatplotlib }, () => {
  it("writes a vector PDF at the page width, a PNG preview and the plotted data, and reports a clean audit", () => {
    const { dir, out, status } = runFigure(`
x = np.array([100, 200, 500, 1000])
fig, ax = figure(width=TEXT)
ax.errorbar(x, [0.50, 0.58, 0.66, 0.71], yerr=[0.01, 0.02, 0.01, 0.015], color=PALETTE["blue"], marker="o", label="ours")
ax.plot(x, [0.45, 0.52, 0.60, 0.64], color=PALETTE["orange"], marker="s", label="baseline")
ax.set_xscale("log"); ax.set_xlabel("Training-set size (examples)"); ax.set_ylabel("Accuracy (fraction correct)"); ax.legend()
save(fig, "fig_scaling")
`);
    assert.equal(status, 0, out);
    assert.match(out, /audit: clean/, out);
    for (const f of ["fig_scaling.pdf", "fig_scaling.png", "fig_scaling.plotdata.json"]) assert.ok(existsSync(join(dir, f)), `${f} missing: ${out}`);
    const pdf = readFileSync(join(dir, "fig_scaling.pdf"), "latin1");
    assert.ok(/\/FontFile/.test(pdf), "fonts are not embedded");
    assert.ok(!/\/Subtype\s*\/Image/.test(pdf), "the plot was rasterized");
    const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/.exec(pdf);
    assert.ok(box && Math.abs(Number(box[1]) - 5.5 * 72) < 1.5, `page width ${box?.[1]} pt is not 5.5 in`);
    const data = JSON.parse(readFileSync(join(dir, "fig_scaling.plotdata.json"), "utf8")) as { series: Array<{ label: string; y: number[] }> };
    const ours = data.series.find((s) => s.label === "ours");
    assert.deepEqual(ours?.y, [0.5, 0.58, 0.66, 0.71]);
    assert.deepEqual(data.series.find((s) => s.label === "baseline")?.y, [0.45, 0.52, 0.6, 0.64]);
  });

  it("uses a colour-blind-safe palette and embeds TrueType fonts", () => {
    const { out, status } = runFigure(`
import matplotlib
print("fonttype", matplotlib.rcParams["pdf.fonttype"])
print("colors", len(PALETTE), sorted(PALETTE)[:3])
`);
    assert.equal(status, 0, out);
    assert.match(out, /fonttype 42/);
    assert.match(out, /colors 8 /);
  });

  it("names each real defect instead of reporting clean", () => {
    const { out, status } = runFigure(`
fig, ax = figure(width=8.0)
ax.plot([1, 2, 3], [1, 4, 9])
ax.set_title("A title that belongs in the caption")
ax.set_xlabel("step")
ax.text(0.5, 0.5, "tiny", fontsize=4)
save(fig, "bad")
`);
    assert.equal(status, 0, out);
    assert.doesNotMatch(out, /audit: clean/);
    assert.match(out, /audit: \d+ issue/);
    assert.match(out, /width 8(\.0+)? in/i);
    assert.match(out, /title/i);
    assert.match(out, /y label|ylabel/i);
    assert.match(out, /4(\.0)? pt/i);
  });
});
