/**
 * claim-verification-v2 model table (docs/plans/2026-10-11-claim-verification-v2-benchmark-plan.md): one concise, comparable row per engine,
 * built only from FULL runs of the whole dataset (a subset or a selection is refused: its types are not a sample), with the engines that were
 * not run and why. Everything is recomputed from the results files; the engine facts (parameters, licence) come from the metadata file.
 *
 * Usage: node scripts/bench-claims-v2-table.ts --meta docs/benchmarks/claims-v2-models.meta.json --out docs/benchmarks/claims-v2-model-table.md
 *          <results.json>[,<results.json>...] [--gate docs/benchmarks/claims-v2-cpu-gate-2026-10-11.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PARTIAL_AUC_LIMIT, analyse, itemOf, pairedVsReference, type Delta, type Estimate } from "./bench-claims-v2-score.ts";
import { est, num, pctI, type ResultsFile } from "./bench-claims-v2-report.ts";

/** The owner's admission rule (2026-10-11): refuse any model that takes MORE than 2 seconds to run a chunk on CPU. */
export const CPU_GATE_SECONDS = 2;
/** The utility penalty shown in the table: one false citation is worth 10 misses (the plan reports 5, 10 and 20; the full grid is in each run's report). */
const UTILITY_W = 10;

/** A CPU pass within this share of the limit is called narrow: the figure is two claims on one machine, so it cannot settle a close call. */
export const NARROW_MARGIN = 0.1;
export type Gate = "pass" | "refused" | "not measured";
export const gateOf = (secondsPerChunk: number | null): Gate => (secondsPerChunk === null ? "not measured" : secondsPerChunk > CPU_GATE_SECONDS ? "refused" : "pass");

export interface EngineMeta { id: string; name: string; repo: string; revision: string; params: string; licence: string; note?: string }
export interface NotRun { name: string; reason: string; v1: string }

type Interval = { lo: number; hi: number } | null;
export interface ModelRow {
  id: string;
  name: string;
  params: string;
  licence: string;
  auc: Estimate;
  recallAt1: { value: number | null; interval: Interval };
  falseRateAt1: { value: number | null; interval: Interval };
  utilityAt1: { value: number | null; interval: Interval };
  bar: { positives: number; negatives: number; tp: number; fp: number };
  weakestType: { type: string; auc: number } | null;
  gpuSecondsPerClaim: number;
  gpuMiB: number | null;
  cpuSecondsPerChunk: number | null;
  gate: Gate;
  notChecked: number;
  /** What a reader needs to know about this model besides its numbers (from the metadata file). */
  note: string | null;
  /** The difference to the reference model on the same claims (paired by paper); null for the reference itself. */
  vsReference: { recallAt1: Delta; recallAt2: Delta; auc: Delta; pauc: Delta } | null;
}

/** The middle value: robust to the few claims another job on the GPU slowed down. */
const median = (xs: number[]): number => {
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? (v[m] as number) : ((v[m - 1] as number) + (v[m] as number)) / 2;
};

export function modelRow(run: ResultsFile, meta: EngineMeta, cpuSecondsPerChunk: number | null, opts: { draws?: number; seed?: number; reference?: ResultsFile } = {}): ModelRow {
  if (run.dataset.stride > 1 || run.dataset.selection) throw new Error(`${run.label}: only a full run of the dataset can be a row of the model table`);
  const items = run.records.map((c) => itemOf(c, c.fold, c.score));
  const a = analyse(items, opts);
  let vsReference: ModelRow["vsReference"] = null;
  if (opts.reference !== undefined) {
    const have = new Set(run.records.map((r) => r.id));
    if (opts.reference.records.length !== have.size || opts.reference.records.some((r) => !have.has(r.id))) throw new Error(`${run.label}: the reference run did not run the same claims`);
    vsReference = pairedVsReference(items, opts.reference.records.map((c) => itemOf(c, c.fold, c.score)), opts);
  }
  const at1 = a.atRate[0] as (typeof a.atRate)[number];
  const u = at1.utility.find((x) => x.w === UTILITY_W) as (typeof at1.utility)[number];
  const types = Object.entries(a.aucByType).filter((e): e is [string, number] => e[1] !== null).sort((x, y) => x[1] - y[1]);
  return {
    id: meta.id,
    name: meta.name,
    params: meta.params,
    licence: meta.licence,
    auc: a.auc,
    recallAt1: { value: at1.rates.recall, interval: at1.recallInterval },
    falseRateAt1: { value: at1.rates.falseRate, interval: at1.falseRateInterval },
    utilityAt1: { value: u.value, interval: u.interval },
    bar: { positives: a.productBar.rates.positives, negatives: a.productBar.rates.negatives, tp: a.productBar.rates.tp, fp: a.productBar.rates.fp },
    weakestType: types[0] === undefined ? null : { type: types[0][0], auc: types[0][1] },
    gpuSecondsPerClaim: median(run.records.map((r) => r.wallMs / 1000)),
    gpuMiB: run.gpu ? run.gpu.peakUsedMiB - run.gpu.baselineUsedMiB : null,
    cpuSecondsPerChunk,
    gate: gateOf(cpuSecondsPerChunk),
    notChecked: a.unchecked,
    note: meta.note ?? null,
    vsReference,
  };
}

const row = (cells: (string | number)[]): string => `| ${cells.join(" | ")} |`;
const table = (head: string[], rows: (string | number)[][]): string[] => [row(head), row(head.map(() => "---")), ...rows.map(row)];

/** Best recall at 1 % false supports first; ties by AUC; an engine with no value last. */
const byRecall = (a: ModelRow, b: ModelRow): number => (b.recallAt1.value ?? -1) - (a.recallAt1.value ?? -1) || (b.auc.value ?? -1) - (a.auc.value ?? -1);

export function renderModelTable(rows: ModelRow[], notRun: NotRun[], info: { date: string; commit: string; claims: number; dirty?: boolean }, referenceName?: string): string {
  const sorted = [...rows].sort(byRecall);
  const first = sorted[0];
  const mark = (r: ModelRow): string => `${r.name}${r.notChecked > 0 ? " †" : ""}`;
  const L: string[] = [];
  L.push(`# Model benchmark on claim-verification-v2 (${info.date})`, "");
  L.push(`All ${info.claims} claims through the real \`verify_claim\` path, each against its own paper at the product's chunking (512-token sections), on the GPU, with the Decision 2.0 claim wording unless a note says otherwise. Score = highest chunk probability; bars for a false-support rate are fitted on the other papers (4-fold cross-fit); intervals are 95 % and resample whole papers. Commit \`${info.commit}\`${info.dirty ? ", with uncommitted changes (the commit alone does not reproduce it)" : ""}. Method: [plan](../plans/2026-10-11-claim-verification-v2-benchmark-plan.md); data: [dataset card](../../benchmarks/datasets/claim-verification-v2/README.md). No support found is not a finding that a claim is false.`, "");

  L.push("## Accuracy", "");
  L.push(...table(
    ["#", "Model", "AUC", "Recall at 1 % false supports", `Utility (w = ${UTILITY_W}) at that bar`, `At the 0.99 bar: true / false supported${first ? ` (of ${first.bar.positives} / ${first.bar.negatives})` : ""}`, "Hardest negatives (AUC)"],
    sorted.map((r, i) => [i + 1, mark(r), est(r.auc), pctI(r.recallAt1.value, r.recallAt1.interval), num(r.utilityAt1.value, r.utilityAt1.interval), `${r.bar.tp} / ${r.bar.fp}`, r.weakestType === null ? "n/a" : `${r.weakestType.type} ${r.weakestType.auc.toFixed(3)}`]),
  ), "");
  if (rows.some((r) => r.notChecked > 0)) L.push(`† claims that could not be checked (a refusal, or a chunk the engine did not judge) count as not supported: ${rows.filter((r) => r.notChecked > 0).map((r) => `${r.name} ${r.notChecked}`).join(", ")}.`, "");
  L.push(`Recall at 1 % false supports: share of true claims supported when the bar lets through 1 % of the false ones (comparable across score scales). Utility: (supported true − ${UTILITY_W} × false supports) / true claims. A model at 0 / 0 on the 0.99 bar never scores that high; that says nothing about its ranking. Rows are ordered by recall at 1 %, and that order is nominal: neighbours are usually not distinguishable (see the paired section). "Hardest negatives" is the false-claim type the model ranks worst (perturbed: one value, direction or entity changed; contradiction: the paper says the opposite; fabricated; general knowledge).`, "");

  if (referenceName !== undefined && sorted.some((r) => r.vsReference !== null)) {
    const verdict = (d: Delta): string => (d.interval === null ? "n/a" : d.interval.lo > 0 ? "better" : d.interval.hi < 0 ? "worse" : "not distinguishable");
    const cell = (d: Delta, scale: number, unit: string, digits: number): string => {
      if (d.value === null || d.interval === null) return "n/a";
      const sg = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v * scale).toFixed(digits)}`;
      return `${sg(d.value)}${unit} (${sg(d.interval.lo)} to ${sg(d.interval.hi)}) ${verdict(d)}`;
    };
    L.push(`## Against ${referenceName} (paired by paper)`, "");
    const vs = (r: ModelRow): NonNullable<ModelRow["vsReference"]> => r.vsReference as NonNullable<ModelRow["vsReference"]>;
    L.push(...table(
      ["Model", "AUC, difference", `Partial AUC (up to ${PARTIAL_AUC_LIMIT * 100} % false supports), difference`, "Recall at 1 % false supports, difference", "Recall at 2 % false supports, difference"],
      sorted.filter((r) => r.vsReference !== null).map((r) => [mark(r), cell(vs(r).auc, 1, "", 3), cell(vs(r).pauc, 1, "", 3), cell(vs(r).recallAt1, 100, " pts", 1), cell(vs(r).recallAt2, 100, " pts", 1)]),
    ), "");
    L.push(`Difference = model minus ${referenceName} on the same claims; the interval resamples the same papers for both. "better" / "worse" mean it excludes zero. AUC (whole ranking) and the low-false-support columns can disagree: a model can rank better overall without being distinguishable where the product operates (the last three columns).`, "");
  }

  L.push("## Cost and fit", "");
  L.push(...table(
    ["Model", "Params", "Licence", "GPU s per claim", "GPU memory (MiB)", "CPU s per chunk", `CPU gate (not over ${CPU_GATE_SECONDS} s)`],
    sorted.map((r) => [mark(r), r.params, r.licence, r.gpuSecondsPerClaim.toFixed(1), r.gpuMiB === null ? "n/a" : r.gpuMiB, r.cpuSecondsPerChunk === null ? "n/a" : r.cpuSecondsPerChunk.toFixed(2), r.gate === "pass" && (r.cpuSecondsPerChunk as number) >= CPU_GATE_SECONDS * (1 - NARROW_MARGIN) ? "pass (narrow)" : r.gate]),
  ), "");
  L.push("GPU s per claim: median wall time of one `verify_claim` call (about 67 chunks, one after another). GPU memory: use above the idle baseline. A model that fails the CPU gate is not adoptable however accurate it is.", "");

  const noted = sorted.filter((r) => r.note !== null);
  if (noted.length > 0) {
    L.push("## Notes on individual models", "");
    for (const r of noted) L.push(`- **${r.name}**: ${r.note}`);
    L.push("");
  }

  if (notRun.length > 0) {
    L.push("## Not run on v2", "");
    L.push(...table(["Model", "Why", "Known from v1 (135 claims, different protocol)"], notRun.map((n) => [n.name, n.reason, n.v1])), "");
  }
  return L.join("\n");
}

const flag = (argv: string[], name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : null;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const metaFile = flag(argv, "--meta");
  const out = flag(argv, "--out");
  const files = (argv.find((a) => !a.startsWith("--") && !argv[argv.indexOf(a) - 1]?.startsWith("--")) ?? "").split(",").filter(Boolean);
  if (metaFile === null || files.length === 0) {
    process.stderr.write("usage: bench-claims-v2-table.ts --meta <meta.json> [--gate <gate.json>] [--out table.md] <results.json>[,<results.json>...]\n");
    process.exit(1);
  }
  const meta = JSON.parse(readFileSync(metaFile, "utf8")) as { engines: EngineMeta[]; notRun: NotRun[] };
  const gateFile = flag(argv, "--gate");
  const gate = gateFile === null ? {} : (JSON.parse(readFileSync(gateFile, "utf8")) as { engines: Record<string, { secondsPerChunk: number | null }> }).engines;
  const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as ResultsFile);
  const idOf = (r: ResultsFile): string => r.spec ?? r.label.replace(/-gpu$/, "");
  const referenceId = flag(argv, "--reference") ?? "eos";
  const reference = runs.find((r) => idOf(r) === referenceId);
  const rows = runs.map((r) => {
    const m = meta.engines.find((e) => e.id === idOf(r));
    if (m === undefined) throw new Error(`no metadata for ${r.label} (spec ${r.spec ?? "none"})`);
    return modelRow(r, m, gate[m.id]?.secondsPerChunk ?? null, reference !== undefined && r !== reference ? { reference } : {});
  });
  const first = runs[0] as ResultsFile;
  const referenceName = reference === undefined ? undefined : meta.engines.find((e) => e.id === idOf(reference))?.name;
  const md = renderModelTable(rows, meta.notRun, { date: first.date, commit: first.commit.slice(0, 7), claims: first.records.length, dirty: runs.some((r) => r.dirty) }, referenceName);
  if (out !== null) writeFileSync(out, md);
  else process.stdout.write(md);
}
