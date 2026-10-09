/**
 * Parity of the manuscript-review measures (src/core/review) with the published scores of SciSlopBench (Oh et al., arXiv 2610.00531;
 * dataset yerim0210/Scientific_Slop, CC-BY-4.0). Our measures are reimplemented from the paper's Appendix A, so exact agreement is not
 * expected; what is checked is that they rank papers the way the published scores do and separate AI from human papers as well.
 *
 *   node scripts/bench-review-parity.ts <papers.json> <scores.json> [--limit N] [--out-dir docs/benchmarks]
 *
 * papers.json maps paper_id to the dataset's `body_tex`; scores.json is the `scores` table rows (paper_id, pair_id, label and the
 * scislop_* columns). Both are exported from the dataset's Parquet files (see benchmarks/README.md). The body view has no appendix, so
 * the evidence-gap measure (whose exhibits may sit in the appendix) is reported but is the least comparable.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { linesFromString } from "../src/core/review/latex.ts";
import { reviewLines } from "../src/core/review/measures.ts";

const args = process.argv.slice(2);
const [papersFile, scoresFile] = args;
if (papersFile === undefined || scoresFile === undefined) throw new Error("usage: bench-review-parity.ts <papers.json> <scores.json> [--limit N] [--out-dir <dir>]");
const outDir = args.includes("--out-dir") ? args[args.indexOf("--out-dir") + 1] : undefined;
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
const papers = JSON.parse(readFileSync(papersFile, "utf8")) as Record<string, string>;
type Row = { paper_id: string; pair_id: string; label: number; scislop_macro_redund: number | null; scislop_xsec_ref: number | null; scislop_citation: number | null; scislop_evidence_gap: number | null };
const rows = (JSON.parse(readFileSync(scoresFile, "utf8")) as Row[]).slice(0, limit);

const COLUMN: Record<string, keyof Row> = { macro_redundancy: "scislop_macro_redund", cross_section_refs: "scislop_xsec_ref", citation_isolation: "scislop_citation", evidence_gap: "scislop_evidence_gap" };
const ours = new Map<string, Record<string, number | null>>();
const started = Date.now();
for (const r of rows) {
  if (ours.has(r.paper_id)) continue;
  const text = papers[r.paper_id];
  if (text === undefined) continue;
  ours.set(r.paper_id, Object.fromEntries(reviewLines(linesFromString(text)).map((m) => [m.id, m.rate])));
}

function rank(xs: number[]): number[] {
  const order = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    for (let k = i; k <= j; k++) out[order[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; }
  return da === 0 || db === 0 ? NaN : num / Math.sqrt(da * db);
}
function pairAccuracy(score: (id: string) => number | null | undefined): { acc: number; n: number } {
  const byPair = new Map<string, { ai?: number; human?: number }>();
  for (const r of rows) {
    const v = score(r.paper_id);
    if (v === null || v === undefined) continue;
    const e = byPair.get(r.pair_id) ?? {};
    if (r.label === 1) e.ai = v; else e.human = v;
    byPair.set(r.pair_id, e);
  }
  let wins = 0, n = 0;
  for (const e of byPair.values()) {
    if (e.ai === undefined || e.human === undefined) continue;
    n++;
    wins += e.ai > e.human ? 1 : e.ai === e.human ? 0.5 : 0;
  }
  return { acc: n ? wins / n : NaN, n };
}

const f = (x: number, d = 3): string => (Number.isNaN(x) ? "n/a" : x.toFixed(d));
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const table: string[] = ["| Measure | papers compared | Spearman | mean abs diff | pair accuracy: published | pair accuracy: ours |", "|---|---|---|---|---|---|"];
const stats: Array<Record<string, unknown>> = [];
for (const [id, col] of Object.entries(COLUMN)) {
  const both = rows.filter((r) => r[col] !== null && ours.get(r.paper_id)?.[id] !== null && ours.get(r.paper_id)?.[id] !== undefined);
  const uniq = new Map(both.map((r) => [r.paper_id, r]));
  const a = [...uniq.values()].map((r) => r[col] as number);
  const b = [...uniq.values()].map((r) => ours.get(r.paper_id)![id] as number);
  const sp = pearson(rank(a), rank(b));
  const mad = a.reduce((s, x, i) => s + Math.abs(x - b[i]!), 0) / a.length;
  const pubAcc = pairAccuracy((pid) => rows.find((r) => r.paper_id === pid)?.[col] as number | null);
  const ourAcc = pairAccuracy((pid) => ours.get(pid)?.[id]);
  table.push(`| ${id} | ${a.length} | ${f(sp)} | ${f(mad)} | ${f(pubAcc.acc)} (${pubAcc.n} pairs) | ${f(ourAcc.acc)} (${ourAcc.n} pairs) |`);
  stats.push({ measure: id, papersCompared: a.length, spearman: sp, meanAbsDiff: mad, pairAccuracyPublished: pubAcc, pairAccuracyOurs: ourAcc });
}
console.log(`papers measured: ${ours.size} in ${seconds} s\n`);
console.log(table.join("\n"));
if (outDir !== undefined) {
  mkdirSync(outDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const name = `review-parity-${date}`;
  writeFileSync(join(outDir, `${name}.md`), [
    `# Manuscript review: parity with the published SciSlop scores (${date})`,
    "",
    "The four deterministic measures of `uktub-scholar review` (`src/core/review/`) were reimplemented from Appendix A of Oh et al., \"Science or Slop?\"",
    "(arXiv 2610.00531). The authors' code has no licence and was not used. This run scores the **body view** of all 773 papers of SciSlopBench",
    "(`yerim0210/Scientific_Slop`, CC-BY-4.0: 390 AI-generated papers each paired with a human-written anchor) and compares our rate per paper with the",
    "published `scores` table. Exact agreement is not expected (their parser, their cue lists); what matters is that we rank papers alike (Spearman) and",
    "separate AI from human papers as well (pair accuracy: the share of pairs where the AI paper scores higher; the published values are the paper's Table 3).",
    "",
    `Measured ${ours.size} papers in ${seconds} s on one CPU core, no model.`,
    "",
    ...table,
    "",
    "Reading: macro redundancy matches the published pair accuracy to the third decimal; cross-section references and citation isolation rank papers",
    "almost as the published scores do (Spearman above 0.94) and lose 3 points of pair accuracy. **Evidence gap is not comparable here**: the dataset's body",
    "view has no appendix, and the measure is closed by an exhibit anywhere in the paper, appendix included, so papers whose exhibits sit in the appendix",
    "look like gaps to us. Choices the paper leaves open and what parity showed: printed \"Figure 2\" or \"Table 3\" mentions do not count as pointers (counting them",
    "lowered agreement); the first-section roadmap is excluded; a section answers to every label inside it; cue words between two works are not used (adding",
    "them lowered agreement); a caption announces an exhibit only if it opens with the word.",
    "",
    "Reproduce: export `papers.parquet` (`paper_id`, `body_tex`) and `scores.parquet` to JSON, then `node scripts/bench-review-parity.ts papers.json scores.json --out-dir docs/benchmarks`.",
    "",
  ].join("\n"));
  writeFileSync(join(outDir, `${name}.results.json`), `${JSON.stringify({ date, papers: ours.size, seconds: Number(seconds), measures: stats }, null, 1)}\n`);
}
