/**
 * Uncertainty for benchmark AUC: percentile bootstrap over claims (seeded,
 * reproducible) for each bench-claim-verify/2 results JSON, plus the paired
 * difference between the first file and every later one. 135 claims over 14
 * papers is a small sample, and claims within a paper are not independent, so
 * treat the intervals as optimistic.
 *
 * Usage: node scripts/bench-bootstrap-auc.ts a.results.json [b.results.json ...]
 */
import { readFileSync } from "node:fs";

import { aucTieCorrect, claimScore } from "./bench-metrics.ts";

const DRAWS = 2000;
const SEED = 20261004;
function rng(seed: number): () => number { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pct = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];

const runs = process.argv.slice(2).map((f) => {
  const d = JSON.parse(readFileSync(f, "utf8"));
  const byId = new Map<string, { score: number | null; positive: boolean }>();
  for (const r of d.results) byId.set(r.id, { score: claimScore(r.chunkP), positive: r.label === "TRUE" });
  return { file: f, byId };
});
const ids = [...runs[0].byId.keys()];
const auc = (run: (typeof runs)[number], sample: string[]) =>
  aucTieCorrect(sample.flatMap((id) => { const x = run.byId.get(id)!; return x.score === null ? [] : [{ score: x.score, positive: x.positive }]; }));

const rand = rng(SEED);
const samples = Array.from({ length: DRAWS }, () => ids.map(() => ids[Math.floor(rand() * ids.length)]));
for (const run of runs) {
  const xs = samples.map((s) => auc(run, s)).filter((x): x is number => x !== null).sort((a, b) => a - b);
  console.log(`${run.file.split("/").pop()}: AUC ${auc(run, ids)?.toFixed(3)}  95% CI [${pct(xs, 0.025).toFixed(3)}, ${pct(xs, 0.975).toFixed(3)}]  (${DRAWS} draws, seed ${SEED})`);
}
for (const run of runs.slice(1)) {
  const diffs = samples.map((s) => { const a = auc(runs[0], s), b = auc(run, s); return a === null || b === null ? null : b - a; }).filter((x): x is number => x !== null).sort((a, b) => a - b);
  console.log(`paired diff (${run.file.split("/").pop()} - first): ${(auc(run, ids)! - auc(runs[0], ids)!).toFixed(3)}  95% CI [${pct(diffs, 0.025).toFixed(3)}, ${pct(diffs, 0.975).toFixed(3)}]`);
}
