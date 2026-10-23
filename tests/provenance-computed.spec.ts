/**
 * Computed-results audit: a figure in a statement or table row that cites no
 * registered paper is searched in the project's result files. Strong match
 * (decimals, number-with-unit) -> `computed` with a file:line pointer;
 * weak-only (a round integer without its unit) -> `check`; no match ->
 * unchanged. A figure in a statement that cites a paper keeps paper-only
 * behavior. Never reads outside the project root.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { linesFromString, parsePaper } from "../src/core/review/latex.ts";
import { auditProvenance, type PaperInput, type ResultLine } from "../src/core/provenance/audit.ts";
import { normalizePaperText } from "../src/core/provenance/figures.ts";
import {
  collectResultLines,
  MAX_RESULT_FILES,
  MAX_RESULT_FILE_BYTES,
} from "../src/core/provenance/results.ts";
import { renderFull, renderSummary } from "../src/core/provenance/render.ts";
import { ConfigError, loadChunkConfig } from "../src/core/config.ts";
import { createRegistry } from "../src/core/registry.ts";
import { runProvenance } from "../src/core/provenance/run.ts";
import { provenanceBlock } from "../src/core/tools/compile.ts";
import { doctorTool } from "../src/core/tools/doctor.ts";
import { WriteQueue } from "../src/core/queue.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import {
  checkTierFigures,
  type TierProvenanceDoc,
} from "../scripts/live/deliverable-checks.ts";

const line = (file: string, lineNo: number, raw: string): ResultLine => ({ file, line: lineNo, text: normalizePaperText(raw) });
const RESULTS = [
  line("results/run1.csv", 1, "model,accuracy"),
  line("results/run1.csv", 2, "ours,93.7%"),
  line("results/run1.csv", 3, "batch,80"),
];

const HU: PaperInput[] = [
  { citekey: "hu", doi: "10.1/hu", title: "LoRA", text: "LoRA cuts parameters by 10,000 times." },
];

const texOf = (body: string): string => `\\begin{document}\n${body}\n\\end{document}\n`;
const auditOf = (body: string, papers: PaperInput[] = [], results: ResultLine[] = RESULTS) =>
  auditProvenance({ paper: parsePaper(linesFromString(texOf(body))), tex: texOf(body), papers, ledger: () => null, results });
const figsOf = (body: string, papers: PaperInput[] = [], results: ResultLine[] = RESULTS) =>
  auditOf(body, papers, results).units.flatMap((u) => u.figures);

// ── audit: matching ─────────────────────────────────────────────────────────

describe("computed figures in the audit", () => {
  it("a strong match for an uncited prose figure is computed with its file:line", () => {
    const figs = figsOf("Our model reaches an accuracy of 93.7\\% on the test set.");
    assert.equal(figs.length, 1);
    assert.equal(figs[0]!.status, "computed");
    assert.match(figs[0]!.detail, /results\/run1\.csv:2/);
    assert.equal(auditOf("Our model reaches an accuracy of 93.7\\% on the test set.").summary.figures.computed, 1);
  });

  it("a strong match for a table row that cites nothing is computed (was unsourced)", () => {
    const figs = figsOf("\\begin{tabular}{ll}\nFull FT & accuracy 93.7\\% \\\\\n\\end{tabular}\n");
    assert.ok(figs.length >= 1);
    assert.equal(figs[0]!.status, "computed");
  });

  it("a weak-only match (a round integer without its unit) is check", () => {
    const figs = figsOf("Training used 80GB of memory in total.");
    const f = figs.find((x) => x.token === "80GB")!;
    assert.ok(f, "80GB is extracted");
    assert.equal(f.status, "check");
    assert.match(f.detail, /results\/run1\.csv:3/);
  });

  it("no match leaves uncited prose and unsourced rows unchanged", () => {
    const prose = figsOf("We expect 12.5\\% on our setup.");
    assert.deepEqual(prose.map((f) => f.status), ["uncited"]);
    const row = figsOf("\\begin{tabular}{ll}\nFull FT & OOM on 24\\,GB GPUs \\\\\n\\end{tabular}\n");
    assert.deepEqual(row.map((f) => f.status), ["unsourced"]);
  });

  it("a figure in a statement that cites a registered paper keeps paper-text-only behavior", () => {
    const figs = figsOf("Our model reaches 93.7\\%~\\cite{hu}.", HU, RESULTS);
    assert.equal(figs[0]!.status, "open", "present in results but absent from the cited paper: still open");
  });

  it("computed is not an open item and is counted, not listed with open/check", () => {
    const a = auditOf("Our model reaches an accuracy of 93.7\\% on the test set.");
    assert.deepEqual(a.items.map((i) => i.status), []);
    assert.equal(a.summary.figures.ok, 0);
  });
});

// ── result file collection ──────────────────────────────────────────────────

describe("collectResultLines", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "uktub-computed-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds the default result extensions under results/ and nothing else", () => {
    mkdirSync(join(root, "results"), { recursive: true });
    writeFileSync(join(root, "results", "run1.csv"), "model,accuracy\nours,93.7%\n");
    writeFileSync(join(root, "results", "notes.md"), "93.7% here is not a result file\n");
    writeFileSync(join(root, "paper.tex"), "93.7% in the manuscript is not a result\n");
    const found = collectResultLines(root, "results/**/*.{csv,json,txt,log}");
    assert.deepEqual(found.map((l) => l.file), ["results/run1.csv", "results/run1.csv"]);
    assert.deepEqual(found.map((l) => l.line), [1, 2]);
  });

  it("honours an overriding glob", () => {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "custom.json"), '{"accuracy": 93.7}\n');
    mkdirSync(join(root, "results"), { recursive: true });
    writeFileSync(join(root, "results", "run1.csv"), "93.7\n");
    const found = collectResultLines(root, "data/*.json");
    assert.deepEqual(found.map((l) => l.file), ["data/custom.json"]);
  });

  it("ignores symlinks that escape the project root, and an absent results dir is empty", () => {
    assert.deepEqual(collectResultLines(root, "results/**/*.{csv,json,txt,log}"), []);
    const outside = mkdtempSync(join(tmpdir(), "uktub-computed-out-"));
    try {
      writeFileSync(join(outside, "secret.csv"), "93.7\n");
      mkdirSync(join(root, "results"), { recursive: true });
      symlinkSync(join(outside, "secret.csv"), join(root, "results", "evil.csv"));
      const found = collectResultLines(root, "results/**/*.{csv,json,txt,log}");
      assert.deepEqual(found, [], "the escaping symlink is ignored, not followed");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("is bounded: an oversize file is skipped and the file count is capped", () => {
    mkdirSync(join(root, "results"), { recursive: true });
    writeFileSync(join(root, "results", "big.csv"), `x\n${"9".repeat(MAX_RESULT_FILE_BYTES + 1)}\n`);
    const big = collectResultLines(root, "results/**/*.csv");
    assert.ok(!big.some((l) => l.file === "results/big.csv"), "files over the byte cap are skipped");
    for (let i = 0; i < MAX_RESULT_FILES + 5; i++) writeFileSync(join(root, "results", `f${i}.csv`), "93.7\n");
    const many = collectResultLines(root, "results/**/*.csv");
    assert.ok(new Set(many.map((l) => l.file)).size <= MAX_RESULT_FILES, "at most the file-count cap");
  });
});

// ── config ──────────────────────────────────────────────────────────────────

describe("provenance.results_glob config", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "uktub-computed-cfg-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const FULL = (extra = "") =>
    `chunking:\n  chunk_tokens: 512\n  overlap_tokens: 0\n  chars_per_token: 2.8\n  boundary: section\nverification:\n  engine: hosted\n  min_confidence: 0.99\n  workers: 4\n  max_judgments: 120\n${extra}`;

  it("defaults to the client-policy glob, accepts an override, refuses bad values like other keys", () => {
    assert.equal(loadChunkConfig(root, { env: {} }).provenance.results_glob, "results/**/*.{csv,json,txt,log}");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "chunking.yaml"), `${FULL()}provenance:\n  results_glob: data/*.json\n`);
    assert.equal(loadChunkConfig(root, { env: {} }).provenance.results_glob, "data/*.json");
    for (const [glob, re] of [["/abs/path/*.csv", /project-relative/], ["results/../secret/*.csv", /\.\./], ["", /non-empty/]] as const) {
      writeFileSync(join(root, "config", "chunking.yaml"), `${FULL()}provenance:\n  results_glob: ${JSON.stringify(glob)}\n`);
      assert.throws(() => loadChunkConfig(root, { env: {} }), (e) => e instanceof ConfigError && re.test(e.message), glob);
    }
    writeFileSync(join(root, "config", "chunking.yaml"), `${FULL()}provenance:\n  bogus_key: 1\n`);
    assert.throws(() => loadChunkConfig(root, { env: {} }), (e) => e instanceof ConfigError && /unknown key provenance\.bogus_key/.test(e.message));
  });
});

// ── project level: run, render, compile, doctor, Tier 1 ─────────────────────

describe("computed figures through the product", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "uktub-computed-e2e-"));
    createRegistry(root).close();
    mkdirSync(join(root, "manuscript"), { recursive: true });
    writeFileSync(join(root, "manuscript/main.tex"), texOf("Our model reaches an accuracy of 93.7\\% on the test set."));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const withResults = (): void => {
    mkdirSync(join(root, "results"), { recursive: true });
    writeFileSync(join(root, "results", "run1.csv"), "model,accuracy\nours,93.7%\n");
  };

  it("runProvenance: with the result file the figure is computed; without it, uncited as before", () => {
    withResults();
    const yes = runProvenance({ root, now: () => new Date("2026-10-15T00:00:00Z") });
    assert.ok(yes.ok, yes.ok ? "" : yes.message);
    if (!yes.ok) return;
    const f = yes.audit.units.flatMap((u) => u.figures)[0]!;
    assert.equal(f.status, "computed");
    assert.match(f.detail, /results\/run1\.csv:2/);
    assert.equal(yes.audit.summary.figures.computed, 1);

    rmSync(join(root, "results"), { recursive: true, force: true });
    const no = runProvenance({ root, now: () => new Date("2026-10-15T00:00:00Z") });
    assert.ok(no.ok);
    if (!no.ok) return;
    assert.equal(no.audit.units.flatMap((u) => u.figures)[0]!.status, "uncited");
    assert.equal(no.audit.summary.figures.computed, 0);
  });

  it("renderSummary reports the computed count only when > 0; the full view lists file:line", () => {
    withResults();
    const yes = runProvenance({ root, now: () => new Date("2026-10-15T00:00:00Z") });
    assert.ok(yes.ok);
    if (!yes.ok) return;
    assert.match(renderSummary(yes.audit).join("\n"), /1 computed/);
    assert.match(renderFull(yes.audit), /results\/run1\.csv:2/);
    const db = createRegistry(root);
    db.close();
    const bare = runProvenance({ root: mkdtempSync(join(tmpdir(), "uktub-computed-empty-")), now: () => new Date() });
    assert.ok(!bare.ok, "no registry: a reason, not computed text");
  });

  it("compile reports the computed count in its structured summary", () => {
    withResults();
    const b = provenanceBlock({ root, env: {}, now: () => new Date("2026-10-15T00:00:00Z") } as unknown as ToolContext, "manuscript/main.tex");
    assert.ok(b !== null);
    assert.equal(b!.structured.figures.computed, 1);
    assert.match(b!.lines.join("\n"), /computed/);
  });

  it("doctor reports the computed count in its registry check detail only when > 0", async () => {
    const ctx = (env: Record<string, string | undefined> = {}): ToolContext =>
      ({ root, fetch: async () => { throw new Error("no network"); }, env, now: () => new Date("2026-10-15T00:00:00Z"), queue: new WriteQueue() }) as unknown as ToolContext;
    const noFile = await doctorTool(ctx({ PATH: "" }), {}, { fs: { exists: () => false, executable: () => false } });
    const g0 = noFile.structuredContent!.checks.find((c) => c.name === "registry")!;
    assert.doesNotMatch(g0.detail, /computed/);
    withResults();
    const yes = await doctorTool(ctx({ PATH: "" }), {}, { fs: { exists: () => false, executable: () => false } });
    const g1 = yes.structuredContent!.checks.find((c) => c.name === "registry")!;
    assert.match(g1.detail, /1 computed/);
  });

  it("Tier 1 T1.5 treats computed like ok: computed passes, open still fails", () => {
    const item = (status: string, token = "93.7%") => ({ status, token, file: "manuscript/main.tex", line: 1, section: "", kind: "sentence", papers: [] as string[], why: `${token} ${status}` });
    const doc = (items: ReturnType<typeof item>): TierProvenanceDoc => ({
      entry: "manuscript/main.tex",
      summary: { words: 10, audited: 1, verified: 0, cited: 0, uncited: 1, figures: { ok: 0, check: 0, open: 0, info: 0, computed: 1 }, unregistered: [], labelledUnverified: 0, unlabelledUnverified: 0 },
      items: [items],
      document_digest: "ab".repeat(32),
      units: [],
    });
    assert.equal(checkTierFigures(doc(item("computed"))).ok, true);
    assert.equal(checkTierFigures(doc(item("open", "A100"))).ok, false);
    assert.equal(checkTierFigures(doc(item("unsourced", "48 GB"))).ok, false);
  });
});
