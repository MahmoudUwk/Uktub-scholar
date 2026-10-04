/**
 * Recompute AUC for the stored historical results (docs/benchmarks/*.results.json
 * written before bench-claim-verify/2). Historical AUC used a rank-sum with no
 * tie correction; this prints the original formula (reproduction check) next
 * to the tie-correct value, both from the stored per-claim `pTrue`. Chunked
 * historical files store only the claim-level aggregate (`pTrue`), not
 * per-chunk probabilities, so only AUC can be recomputed for them.
 *
 * Usage: node scripts/bench-recompute-historical.ts [docs/benchmarks] [out.md]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { aucTieCorrect } from "./bench-metrics.ts";

const dir = process.argv[2] ?? join("docs", "benchmarks");
const outPath = process.argv[3];

/** The historical formula, kept only to confirm the stored numbers reproduce. */
function legacyAuc(items: { score: number; positive: boolean }[]): number | null {
  const sorted = items.map((x) => ({ p: x.score, y: x.positive ? 1 : 0 })).sort((a, b) => a.p - b.p);
  let rankSum = 0;
  sorted.forEach((x, i) => { rankSum += x.y ? i + 1 : 0; });
  const n1 = items.filter((x) => x.positive).length;
  const n0 = items.length - n1;
  return n1 && n0 ? (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n0) : null;
}
const f = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : x.toFixed(3));

const rows: string[] = [];
for (const file of readdirSync(dir).filter((n) => n.endsWith(".results.json")).sort()) {
  const d = JSON.parse(readFileSync(join(dir, file), "utf8"));
  if (d.schema) continue; // new-format runs already use the corrected metrics
  const results = d.results as { label: string; pTrue: number }[];
  const items = results.map((r) => ({ score: r.pTrue, positive: r.label === "TRUE" }));
  const distinct = new Set(results.map((r) => r.pTrue)).size;
  const mode = file.includes("+chunks") ? "chunked (stored claim aggregate)" : "whole paper (24k prefix)";
  rows.push(`| \`${file.replace("-claim-verification-v1-2026-10-03.results.json", "")}\` | ${mode} | ${results.length} | ${distinct} | ${d.auc ?? "not stored"} | ${f(legacyAuc(items))} | ${f(aucTieCorrect(items))} |`);
}
const md = [
  "| Run | Mode | Claims | Distinct scores | Stored AUC | Original formula, recomputed | Tie-correct, recomputed |",
  "|---|---|---|---|---|---|---|",
  ...rows,
].join("\n");
console.log(md);
if (outPath) writeFileSync(outPath, md + "\n");
