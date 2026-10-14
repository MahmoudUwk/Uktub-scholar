/**
 * claim-verification-v2 CPU gate (owner rule, 2026-10-11: refuse any model that takes more than 2 seconds to run a chunk on CPU). The figure comes
 * from a real run of the model on CPU through the product path (bench-claims-v2.ts --device cpu, a couple of claims over one paper): the median over
 * claims of the wall time per fresh judgment, so it is steady state (the model is loaded before the first claim) and includes the worker's own overhead.
 *
 * Usage: node scripts/bench-claims-v2-cpu-gate.ts --out docs/benchmarks/claims-v2-cpu-gate-2026-10-11.json <results.json>[,<results.json>...]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { RunRecord } from "./bench-claims-v2.ts";
import type { ResultsFile } from "./bench-claims-v2-report.ts";

/** Median seconds per fresh judgment (chunk or localization check) over the claims; a claim that only reused judgments did no work and is left out. */
export function secondsPerChunkOf(records: RunRecord[]): number | null {
  const per = records.filter((r) => r.fresh + r.localizationFresh > 0).map((r) => r.wallMs / 1000 / (r.fresh + r.localizationFresh)).sort((a, b) => a - b);
  if (per.length === 0) return null;
  const m = Math.floor(per.length / 2);
  return per.length % 2 === 1 ? (per[m] as number) : ((per[m - 1] as number) + (per[m] as number)) / 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf("--out");
  const out = outAt >= 0 ? (argv[outAt + 1] as string) : null;
  const files = (argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--out") ?? "").split(",").filter(Boolean);
  if (out === null || files.length === 0) {
    process.stderr.write("usage: bench-claims-v2-cpu-gate.ts --out <gate.json> <results.json>[,<results.json>...]\n");
    process.exit(1);
  }
  const engines: Record<string, { secondsPerChunk: number | null; claims: number; chunksPerPaper: number; device: string; machine: string; note: string }> = {};
  for (const f of files) {
    const r = JSON.parse(readFileSync(f, "utf8")) as ResultsFile;
    const id = (r.spec ?? r.label).replace(/^eos-onnx$/, "eos");
    // Eos on the CPU IS the 8-bit ONNX artifact, so the table's row for that artifact on the GPU carries the same CPU figure.
    for (const key of id === "eos" ? ["eos", "eos-q8"] : [id]) engines[key] = {
      secondsPerChunk: secondsPerChunkOf(r.records),
      claims: r.records.length,
      chunksPerPaper: Math.round(r.records.reduce((s, c) => s + c.chunks, 0) / r.records.length),
      device: r.device,
      machine: `${r.machine.cpu}, ${r.machine.cores} threads`,
      note: `${r.engine}${r.spec ? ` (${r.spec})` : ""}, median over ${r.records.length} claims, load average ${r.run.loadavgStart.map((x) => x.toFixed(1)).join("/")} at start`,
    };
  }
  writeFileSync(out, JSON.stringify({ schema: "claims-v2-cpu-gate/1", rule: "refuse any model that takes more than 2 seconds to run a chunk on CPU (owner, 2026-10-11)", engines }, null, 1));
}
