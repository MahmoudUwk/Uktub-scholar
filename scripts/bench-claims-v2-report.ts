/**
 * claim-verification-v2 report (docs/plans/2026-10-11-claim-verification-v2-benchmark-plan.md): turns the results files of the runner
 * (bench-claims-v2.ts) into the Markdown a reader sees. Everything is recomputed from the records; nothing is read from a previous report.
 *
 * Usage: node scripts/bench-claims-v2-report.ts <results.json>[,<results.json>...] [--subset-of <results.json>] [--out report.md]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { analyse, itemOf, FALSE_RATES, PENALTIES, PARTIAL_AUC_LIMIT, PRODUCT_BAR, type Analysis, type Estimate } from "./bench-claims-v2-score.ts";
import type { RunRecord } from "./bench-claims-v2.ts";

export interface ResultsFile {
  schema: string;
  date: string;
  engine: string;
  device: string;
  label: string;
  identity: { model: string | null; protocol: string; minConfidence: number } | null;
  commit: string;
  dirty: boolean;
  dataset: { claimsSha256: string; corpusSha256: string; papers: number; claims: number; stride: number; offset: number; selection?: string | null };
  chunking: { chunk_tokens: number; overlap_tokens: number; chars_per_token: number; boundary: string };
  maxJudgmentsRaisedFrom: number;
  machine: { cpu: string; cores: number; memoryGb: number; node: string };
  run: { startedAt: string; loadavgStart: number[]; loadavgEnd: number[]; seconds: number };
  /** Which candidate of the model table it is (the runner's --spec), when it ran as one. */
  spec?: string | null;
  /** The GPU the run used and the memory in use on the device (the run's models plus the desktop). */
  gpu?: { name: string; totalMiB: number; baselineUsedMiB: number; peakUsedMiB: number } | null;
  records: RunRecord[];
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** Seconds per claim and per judgment (chunk and localization checks both count; reused judgments are no work). */
export function timingOf(records: RunRecord[]): { meanClaimS: number; medianClaimS: number; secondsPerJudgment: number | null; meanChunks: number } {
  const secs = records.map((r) => r.wallMs / 1000).sort((a, b) => a - b);
  const mid = Math.floor(secs.length / 2);
  const judgments = sum(records.map((r) => r.fresh + r.localizationFresh));
  return {
    meanClaimS: sum(secs) / secs.length,
    medianClaimS: secs.length % 2 === 1 ? (secs[mid] as number) : ((secs[mid - 1] as number) + (secs[mid] as number)) / 2,
    secondsPerJudgment: judgments === 0 ? null : sum(secs) / judgments,
    meanChunks: sum(records.map((r) => r.chunks)) / records.length,
  };
}

/** Claims where the product's own verdict is not `score >= bar`: a check that the scores read back from the cache are the ones the product used. */
export function verdictAgreement(records: RunRecord[], bar: number): { agree: number; total: number; disagreeing: string[] } {
  const disagreeing = records.filter((r) => r.supportFound !== (r.score !== null && r.score >= bar)).map((r) => r.id);
  return { agree: records.length - disagreeing.length, total: records.length, disagreeing };
}

/** The claims both runs scored: how far apart the scores are, and which claims land on opposite sides of the bar. */
export function parityOf(a: RunRecord[], b: RunRecord[], bar: number): { n: number; meanAbsDiff: number; maxAbsDiff: number; flips: { id: string; a: number; b: number }[]; atBar: { positives: { n: number; a: number; b: number }; negatives: { n: number; a: number; b: number } } } {
  const bById = new Map(b.map((r) => [r.id, r]));
  const both = a.flatMap((r) => { const o = bById.get(r.id); return o !== undefined && r.score !== null && o.score !== null ? [{ id: r.id, a: r.score, b: o.score, positive: r.label === "TRUE" }] : []; });
  const count = (positive: boolean) => { const xs = both.filter((x) => x.positive === positive); return { n: xs.length, a: xs.filter((x) => x.a >= bar).length, b: xs.filter((x) => x.b >= bar).length }; };
  const diffs = both.map((x) => Math.abs(x.a - x.b));
  return {
    n: both.length,
    meanAbsDiff: both.length === 0 ? 0 : sum(diffs) / both.length,
    maxAbsDiff: Math.max(0, ...diffs),
    flips: both.filter((x) => x.a >= bar !== x.b >= bar).map(({ id, a: x, b: y }) => ({ id, a: x, b: y })),
    atBar: { positives: count(true), negatives: count(false) },
  };
}

/** The run limited to the given claims, so two runs of different sizes are compared on the same ones. */
export function restrictTo(run: ResultsFile, ids: Set<string>, suffix: string): ResultsFile {
  const records = run.records.filter((r) => ids.has(r.id));
  return { ...run, label: `${run.label} ${suffix}`, dataset: { ...run.dataset, claims: records.length, selection: `${records.length} claims, those of another run` }, records };
}

export const pct = (v: number | null): string => (v === null || Number.isNaN(v) ? "n/a" : `${(v * 100).toFixed(1)}%`);
export const iv = (i: { lo: number; hi: number } | null, scale: number, digits: number): string => (i === null ? "" : ` (${(i.lo * scale).toFixed(digits)}–${(i.hi * scale).toFixed(digits)})`);
export const pctI = (v: number | null, i: { lo: number; hi: number } | null): string => `${pct(v)}${v === null ? "" : iv(i, 100, 1)}`;
export const num = (v: number | null, i: { lo: number; hi: number } | null): string => (v === null || Number.isNaN(v) ? "n/a" : `${v.toFixed(2)}${iv(i, 1, 2)}`);
export const est = (e: Estimate): string => num(e.value, e.interval);
const row = (cells: (string | number)[]): string => `| ${cells.join(" | ")} |`;
const table = (head: string[], rows: (string | number)[][]): string[] => [row(head), row(head.map(() => "---")), ...rows.map(row)];

/** A claim that could not be checked is never a low score: the report says how many there were and counts each as not supported. */
function warnings(r: ResultsFile, a: Analysis): string[] {
  const out: string[] = [];
  if (a.unchecked > 0) out.push(`- **${a.unchecked} claim(s) could not be checked** in ${r.label} (a refusal, or a chunk the engine did not judge); each counts as not supported, never as a low score.`);
  if (r.dataset.stride > 1) out.push(`- **${r.label} is a subset**: every ${r.dataset.stride}th claim of each paper (offset ${r.dataset.offset}), ${r.dataset.claims} claims; its accuracy tables are left out (the claim position fixes the claim type, so a stride subset is not a sample of the types); counts at the product bar, cost and agreement are shown.`);
  if (r.dataset.selection) out.push(`- **${r.label} is a selection, not a sample**: ${r.dataset.selection}; its accuracy tables are left out; counts at the product bar, cost and agreement are shown.`);
  if ((r.run.loadavgStart[0] as number) > r.machine.cores / 4) out.push(`- The machine was busy when ${r.label} started (1-minute load average ${(r.run.loadavgStart[0] as number).toFixed(1)} on ${r.machine.cores} cores): its timings are not clean.`);
  if (r.dirty) out.push(`- ${r.label} ran with uncommitted changes in \`src/\`, \`scripts/\` or the dataset, so the commit alone does not reproduce it.`);
  return out;
}

export function renderReport(runs: ResultsFile[], opts: { draws?: number; seed?: number } = {}): string {
  const analyses = runs.map((r) => analyse(r.records.map((c) => itemOf(c, c.fold, c.score)), opts));
  const L: string[] = [];
  L.push(`# claim-verification-v2: ${runs.map((r) => r.label).join(", ")} (${[...new Set(runs.map((r) => r.date))].join(", ")})`, "");
  L.push("Each claim runs through the real `verify_claim` path, scoped to its own paper, exhaustive, at the product's chunking. A claim's score is the highest probability any chunk of its paper got. The bar for a false-support rate is fitted on the other papers (4-fold cross-fit by paper) and applied to the held-out ones; every interval resamples whole papers (95 %).", "");
  const covers = (r: ResultsFile): boolean => r.dataset.stride <= 1 && !r.dataset.selection;
  const full = runs.map((_, i) => i).filter((i) => covers(runs[i] as ResultsFile));
  const warn = runs.flatMap((r, i) => warnings(r, analyses[i] as Analysis));
  if (warn.length > 0) L.push("## Read first", "", ...warn, "");

  L.push("## Setup", "");
  for (const r of runs) {
    L.push(`- **${r.label}**: engine \`${r.engine}\`${r.identity?.model ? ` (\`${r.identity.model}\`, protocol \`${r.identity.protocol}\`)` : ""}, device ${r.device}; commit \`${r.commit}\`; dataset claims sha256 \`${r.dataset.claimsSha256.slice(0, 12)}\`, ${r.dataset.claims} claims over ${r.dataset.papers} papers; chunks of ${r.chunking.chunk_tokens} tokens, ${r.chunking.boundary} boundary, overlap ${r.chunking.overlap_tokens}; \`max_judgments\` raised from ${r.maxJudgmentsRaisedFrom} so a paper completes in one call; ${r.machine.cpu}, ${r.machine.cores} cores, ${r.machine.memoryGb} GB, node ${r.machine.node}; load average ${r.run.loadavgStart.map((x) => x.toFixed(1)).join("/")} at start, ${r.run.loadavgEnd.map((x) => x.toFixed(1)).join("/")} at end; ${(r.run.seconds / 60).toFixed(0)} min.`);
  }
  L.push("");

  if (full.length > 0) {
    L.push("## Ranking", "", "AUC and partial AUC are diagnostics of the ranking, not a comparison of what a user gets.", "");
    L.push(...table(["Run", "Positives", "Negatives", "Not checked", "AUC", `Partial AUC (up to ${PARTIAL_AUC_LIMIT * 100} % false supports)`], full.map((i) => {
      const a = analyses[i] as Analysis;
      return [(runs[i] as ResultsFile).label, a.positives, a.negatives, a.unchecked, est(a.auc), est(a.pauc)];
    })), "");
  }

  for (const [k, rate] of FALSE_RATES.entries()) {
    if (full.length === 0) break;
    L.push(`## Bar fitted for a false-support rate of ${rate * 100} % of negatives`, "", "Recall is the share of positives supported; the false-support rate is the share of negatives supported. Utility is (supported positives − w × false supports) / positives, w being the number of misses one false citation is worth.", "");
    L.push(...table(["Run", "Supported positives", "False supports", "Recall", "False-support rate", ...PENALTIES.map((w) => `Utility w = ${w}`)], full.map((i) => {
      const r = runs[i] as ResultsFile;
      const x = (analyses[i] as Analysis).atRate[k] as Analysis["atRate"][number];
      return [r.label, x.rates.tp, x.rates.fp, pctI(x.rates.recall, x.recallInterval), pctI(x.rates.falseRate, x.falseRateInterval), ...x.utility.map((u) => num(u.value, u.interval))];
    })), "");
  }

  L.push("## What the product bar returns", "", `The current setting (\`min_confidence\` ${PRODUCT_BAR}) with no bar fitted, for runs that cover the whole dataset; a partial run's counts at the bar are in its agreement section, on the claims it shares with the first run.`, "");
  L.push(...table(["Run and bar", "Supported positives", "False supports", "Recall", "False-support rate", ...PENALTIES.map((w) => `Utility w = ${w}`)], full.map((i) => {
    const r = runs[i] as ResultsFile;
    const b = (analyses[i] as Analysis).productBar;
    return [`${r.label}, product bar ${b.bar}`, b.rates.tp, b.rates.fp, pct(b.rates.recall), pct(b.rates.falseRate), ...b.utility.map((u) => u.value.toFixed(2))];
  })), "");

  L.push("## False supports by the reason a claim is a negative", "");
  const types = [...new Set(runs.flatMap((r) => r.records.filter((c) => c.label === "FALSE").map((c) => c.type)))].sort();
  L.push(...table(["Run", "Type", "Negatives", "AUC against this type", ...FALSE_RATES.map((x) => `False supports at ${x * 100} %`), "False supports at the product bar"], full.flatMap((i) => {
    const r = runs[i] as ResultsFile;
    const a = analyses[i] as Analysis;
    return types.map((t) => {
      const cell = (rates: Analysis["productBar"]["rates"]) => rates.falseByType[t] ?? { n: 0, fp: 0 };
      const auc = a.aucByType[t];
      return [r.label, t, cell(a.productBar.rates).n, auc === null || auc === undefined ? "n/a" : auc.toFixed(3), ...a.atRate.map((x) => cell(x.rates).fp), cell(a.productBar.rates).fp];
    });
  })), "");

  L.push("## Cost", "");
  L.push(...table(["Run", "Claims", "Chunks per paper", "Seconds per claim (mean)", "Seconds per claim (median)", "Seconds per judgment"], runs.map((r) => {
    const t = timingOf(r.records);
    return [r.label, r.records.length, t.meanChunks.toFixed(0), t.meanClaimS.toFixed(1), t.medianClaimS.toFixed(1), t.secondsPerJudgment === null ? "n/a" : t.secondsPerJudgment.toFixed(2)];
  })), "", "Seconds per judgment is wall time over every fresh judgment of the run (chunks and localization checks), so it includes the call overhead of the worker; a machine that was busy inflates it.", "");

  for (const r of runs.slice(1)) {
    const first = runs[0] as ResultsFile;
    const bar = first.identity?.minConfidence ?? PRODUCT_BAR;
    const p = parityOf(first.records, r.records, bar);
    L.push(`## Agreement of ${r.label} with ${first.label}`, "");
    L.push(`On the ${p.n} claims both runs scored, at the bar ${bar}: positives supported ${p.atBar.positives.a} (${first.label}) and ${p.atBar.positives.b} (${r.label}) of ${p.atBar.positives.n}; negatives supported ${p.atBar.negatives.a} and ${p.atBar.negatives.b} of ${p.atBar.negatives.n}.`, "");
    L.push(`Scores: mean absolute difference ${p.meanAbsDiff.toFixed(4)}, largest ${p.maxAbsDiff.toFixed(4)}; ${p.flips.length} claim(s) fall on opposite sides of the bar ${bar}${p.flips.length > 0 ? ` (${p.flips.slice(0, 10).map((x) => `${x.id}: ${x.a.toFixed(4)} and ${x.b.toFixed(4)}`).join("; ")}${p.flips.length > 10 ? "; …" : ""})` : ""}.`, "");
  }

  L.push("## Checks", "");
  for (const r of runs) {
    const v = verdictAgreement(r.records, r.identity?.minConfidence ?? PRODUCT_BAR);
    L.push(`- ${r.label}: the product's own verdict equals \`score >= ${r.identity?.minConfidence ?? PRODUCT_BAR}\` on ${v.agree} of ${v.total} claims${v.disagreeing.length > 0 ? ` (differing: ${v.disagreeing.slice(0, 10).join(", ")}${v.disagreeing.length > 10 ? ", …" : ""})` : ""}.`);
  }
  L.push("", "## Limits", "");
  L.push("- A negative is a claim the paper does not support, whatever the reason; no support found is not a finding that a claim is false.");
  L.push("- Claims and labels are model-written and model-annotated (no human labelled them); arXiv papers with a CC BY or CC0 licence only; balanced 50/50, so a false-support rate here is a rate per negative, not the number of errors in a real draft.");
  L.push("- Own-paper scope isolates the model and the chunking; a claim checked against many papers has more chances to be falsely supported and is not measured here.", "");
  return L.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = (process.argv[2] ?? "").split(",").filter(Boolean);
  if (files.length === 0) {
    process.stderr.write("usage: bench-claims-v2-report.ts <results.json>[,<results.json>...] [--out report.md]\n");
    process.exit(1);
  }
  let runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as ResultsFile);
  const j = process.argv.indexOf("--subset-of");
  if (j !== -1) {
    // Every run is limited to the claims of the named results file, so a full run and a subset run are compared on the same claims.
    const ids = new Set((JSON.parse(readFileSync(process.argv[j + 1] as string, "utf8")) as ResultsFile).records.map((r) => r.id));
    runs = runs.map((r) => (r.records.every((x) => ids.has(x.id)) ? r : restrictTo(r, ids, `(the same ${ids.size} claims)`)));
  }
  const md = renderReport(runs);
  const i = process.argv.indexOf("--out");
  if (i !== -1) writeFileSync(process.argv[i + 1] as string, md);
  else process.stdout.write(md);
}
