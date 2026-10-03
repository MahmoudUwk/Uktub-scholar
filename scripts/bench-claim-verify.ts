/**
 * Claim-verification benchmark runner (KTD1): runs an engine over a dataset
 * from benchmarks/datasets/, prints the metrics table, and writes a dated
 * report + raw results into docs/benchmarks/. Offline except for engines
 * that download their own model (Julia-1 via huggingface_hub).
 *
 * Usage:
 *   node --experimental-strip-types scripts/bench-claim-verify.ts \
 *     --dataset benchmarks/datasets/claim-verification-v1 \
 *     --text-dir /tmp/claims-bench/text \
 *     --engine julia
 * Env: UKTUB_JULIA_MODEL (checkpoint path or HF id), UKTUB_JULIA_PYTHON
 * (interpreter with the julia package), UKTUB_VERIFY_MIN_CONFIDENCE (bar).
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { juliaEngine, mapVerdict, DEFAULT_MIN_CONFIDENCE } from "../src/core/verify/claim.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const datasetDir = arg("dataset", "benchmarks/datasets/claim-verification-v1")!;
const textDir = arg("text-dir")!;
const engineName = arg("engine", "julia")!;
const cap = Number(arg("cap", "24000"));

const ds = JSON.parse(readFileSync(join(datasetDir, "claims.json"), "utf8"));
const claims: { id: string; paper: string; claim: string; label: string; kind?: string }[] = ds.claims;

const texts: Record<string, string> = {};
for (const f of readdirSync(textDir)) if (f.endsWith(".txt")) texts[f.slice(0, -4)] = readFileSync(join(textDir, f), "utf8").replace(/\s+/g, " ");

if (engineName !== "julia") {
  console.error(`engine "${engineName}" has no adapter yet (implemented: julia)`);
  process.exit(2);
}
const engine = juliaEngine({ env: process.env });

const t0 = Date.now();
const rows = claims.map((c) => ({ state: (texts[c.paper] ?? "").slice(0, cap), instructions: c.claim }));
const pTrues = await engine.run(rows);
const wall = Date.now() - t0;
const results = claims.map((c, i) => ({ ...c, pTrue: pTrues[i] }));

function evalAt(bar: number) {
  let tp = 0, fp = 0, tn = 0, fn = 0, unverified = 0, dangerous = 0;
  for (const r of results) {
    const v = mapVerdict(r.pTrue, bar).verdict;
    const isTrue = r.label === "TRUE";
    if (v === "supported") isTrue ? tp++ : (fp++, dangerous++);
    else if (v === "refuted") !isTrue ? tn++ : (fn++, dangerous++);
    else unverified++;
  }
  const decided = tp + fp + tn + fn;
  return { bar, tp, tn, fp, fn, unverified, dangerous, decided, decidedAccuracy: decided ? +((tp + tn) / decided).toFixed(3) : 0 };
}

const trues = results.filter((r) => r.label === "TRUE").map((r) => r.pTrue);
const falses = results.filter((r) => r.label === "FALSE").map((r) => r.pTrue);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sorted = results.map((r) => ({ p: r.pTrue, y: r.label === "TRUE" ? 1 : 0 })).sort((a, b) => a.p - b.p);
let rankSum = 0;
sorted.forEach((x, i) => { rankSum += x.y ? i + 1 : 0; });
const n1 = trues.length, n0 = falses.length;
const auc = n1 && n0 ? +((rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n0)).toFixed(3) : null;

const bar = Number(process.env.UKTUB_VERIFY_MIN_CONFIDENCE ?? DEFAULT_MIN_CONFIDENCE);
console.log(`=== ${claims.length} claims · engine=${engineName} · bar=${bar} · wall=${(wall / 1000).toFixed(0)}s ===`);
console.log("confusion:", JSON.stringify(evalAt(bar)));
console.log("sweep:");
for (const b of [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99]) console.log(JSON.stringify(evalAt(b)));
console.log(`mean P(true): TRUE=${mean(trues).toFixed(3)} FALSE=${mean(falses).toFixed(3)}  AUC=${auc}`);

const date = new Date().toISOString().slice(0, 10);
const outDir = join("docs", "benchmarks");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${engineName}-claim-verification-v1-${date}.results.json`), JSON.stringify({ results, wallMs: wall, bar, auc }, null, 1));

const md = [
  `# ${engineName} on ${ds.dataset} — ${date}`,
  "",
  `${claims.length} claims (${ds.manifest ? "" : ""}${results.filter((r) => r.label === "TRUE").length} TRUE / ${results.filter((r) => r.label === "FALSE").length} FALSE), paper context capped at ${cap} chars, wall ${(wall / 1000).toFixed(0)} s.`,
  "",
  `| Metric | Value |`,
  `|---|---|`,
  `| AUC | ${auc} |`,
  `| Mean P(true) TRUE / FALSE | ${mean(trues).toFixed(3)} / ${mean(falses).toFixed(3)} |`,
  `| Confusion @${bar} | ${JSON.stringify(evalAt(bar))} |`,
  "",
  "| Bar | Decided | TP | FP | TN | FN | Unverified | Dangerous | Decided acc |",
  "|---|---|---|---|---|---|---|---|---|",
  forSweep(),
  "",
  "Per-claim rows: see the results JSON beside this file.",
  "",
].join("\n");

function forSweep(): string {
  return [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99]
    .map((b) => {
      const e = evalAt(b);
      return `| ${b.toFixed(2)} | ${e.decided} | ${e.tp} | ${e.fp} | ${e.tn} | ${e.fn} | ${e.unverified} | ${e.dangerous} | ${e.decidedAccuracy.toFixed(2)} |`;
    })
    .join("\n");
}

const reportPath = join(outDir, `${engineName}-claim-verification-v1-${date}.md`);
writeFileSync(reportPath, md);
console.log(`report: ${reportPath}`);
