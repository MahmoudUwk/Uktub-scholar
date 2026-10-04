/**
 * Metrics + Markdown rendering for bench-claim-verify results. Pure: both are
 * derived from the raw per-chunk probabilities in a results object, so a
 * stored run can be re-rendered (`--rerender`) at any bar without a model.
 */
import {
  aucTieCorrect, claimScore, compatibilityScore, supportAt, sweep, type Label, type ScoredClaim,
} from "./bench-metrics.ts";

export interface ClaimResult {
  id: string; paper: string; label: Label; kind: string | undefined; claim: string; claim_hash: string;
  /** One probability per chunk of the paper; null = not checked (refused/error/unavailable). */
  chunkP: (number | null)[];
  chunkTokens: (number | null)[];
  issues: { chunk: number; kind: "refused" | "error"; message: string }[];
  /** Evaluation reference only: chunks whose text contains the gold quote. Never an input. */
  goldChunks: number[];
}

export const BARS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99, 0.995, 0.999];

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const scoredOf = (rs: ClaimResult[]): ScoredClaim[] => rs.map((r) => ({ id: r.id, label: r.label, chunkP: r.chunkP }));

/** Every number is recomputed from the raw chunk probabilities. */
export function computeMetrics(results: ClaimResult[], bar: number, bars: number[] = BARS) {
  const aucOf = (rs: ClaimResult[]) => rs.flatMap((r) => { const s = claimScore(r.chunkP); return s === null ? [] : [{ score: s, positive: r.label === "TRUE" }]; });
  const aucItems = aucOf(results);
  return {
    scoreDefinition: "claim score = max probability over CHECKED chunks; claims with no checked chunk are excluded from AUC and counted as unchecked",
    auc: aucTieCorrect(aucItems),
    aucClaims: aucItems.length,
    aucExcludedUnchecked: results.length - aucItems.length,
    aucCompatibilityScoreAtPolicyBar: aucTieCorrect(results.flatMap((r) => { const s = compatibilityScore(r.chunkP, bar); return s === null ? [] : [{ score: s, positive: r.label === "TRUE" }]; })),
    meanPTrue: { TRUE: mean(aucItems.filter((x) => x.positive).map((x) => x.score)), FALSE: mean(aucItems.filter((x) => !x.positive).map((x) => x.score)) },
    policyBar: bar,
    atPolicyBar: sweep(scoredOf(results), [bar])[0],
    sweep: sweep(scoredOf(results), [...new Set([...bars, bar])].sort((a, b) => a - b)),
    byKind: Object.fromEntries([...new Set(results.map((r) => r.kind ?? "unknown"))].sort().map((k) => {
      const sub = results.filter((r) => (r.kind ?? "unknown") === k);
      return [k, { claims: sub.length, auc: aucTieCorrect(aucOf(sub)), support: supportAt(scoredOf(sub), bar) }];
    })),
  };
}

export function computeDiagnostics(results: ClaimResult[], bar: number) {
  return {
    note: "gold evidence quotes are an evaluation reference only; they were never part of any input",
    trueClaimsWithGoldQuoteInSomeChunk: results.filter((r) => r.label === "TRUE" && r.goldChunks.length > 0).length,
    trueClaims: results.filter((r) => r.label === "TRUE").length,
    trueSupportedAtPolicyBarWithGoldChunk: results.filter((r) => r.label === "TRUE" && r.chunkP.some((p, i) => p !== null && p >= bar && r.goldChunks.includes(i))).length,
    topFalseSupports: results.filter((r) => r.label === "FALSE").map((r) => ({ id: r.id, kind: r.kind, claim: r.claim, p: claimScore(r.chunkP) }))
      .filter((x) => x.p !== null).sort((a, b) => (b.p as number) - (a.p as number)).slice(0, 5),
  };
}

type Metrics = ReturnType<typeof computeMetrics>;
// Loosely typed on purpose: the same renderer reads freshly built and re-loaded results.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RunOutput = any;

const f = (x: number | null | undefined, d = 3) => (x === null || x === undefined ? "n/a" : x.toFixed(d));

export function renderMarkdown(out: RunOutput, tag: string): string {
  const m: Metrics = out.metrics;
  const bar: number = m.policyBar;
  const s = m.atPolicyBar;
  const cost = out.cost;
  const ready = out.engine.ready;
  const stats = cost.worker;
  const pol = out.policy;
  const chunkLine = out.mode === "chunked"
    ? `Chunks: ${pol.chunk_tokens} tokens x ${pol.chars_per_token} chars/token = ${pol.target_chars} chars, overlap ${pol.overlap_chars} chars, boundary ${pol.boundary}, text mode ${out.textMode}, ${Object.values(out.papers as Record<string, { chunks: unknown[] }>).reduce((n, p) => n + p.chunks.length, 0)} chunks.`
    : `Context: first ${pol.prefix_chars} characters of each whitespace-normalized paper.`;
  const row = (e: Metrics["sweep"][number]) =>
    `| ${e.bar} | ${e.support.supported} | ${e.support.truePositives} | ${e.support.falseSupports} | ${f(e.support.supportPrecision, 2)} | ${f(e.support.supportRecall, 2)} | ${f(e.support.abstentionRate, 2)} | ${e.compatibility.decided} | ${e.compatibility.tp + e.compatibility.tn} | ${f(e.compatibility.decidedAccuracy, 3)} |`;
  const d = out.diagnostics;
  return [
    `# ${out.engine.name} on ${out.dataset.name} — ${out.mode}${tag ? ` (${tag})` : ""} — ${out.date}`,
    "",
    out.partial ? "**PARTIAL RUN (development only): not all claims were evaluated.**\n" : null,
    `${out.dataset.claims} claims (${out.dataset.TRUE} TRUE / ${out.dataset.FALSE} FALSE), ${out.dataset.papers} papers. New measurement from \`scripts/bench-claim-verify.ts\` (schema bench-claim-verify/2); metrics are recomputed from the raw per-chunk probabilities in the JSON beside this file.`,
    "",
    `Engine \`${out.engine.id}\`, revision \`${out.engine.revision}\`. ${chunkLine}`,
    "",
    "| Metric | Value |",
    "|---|---|",
    `| AUC, tie-corrected (max checked chunk score) | ${f(m.auc)} over ${m.aucClaims} claims (${m.aucExcludedUnchecked} unchecked excluded) |`,
    `| Mean claim score TRUE / FALSE | ${f(m.meanPTrue.TRUE)} / ${f(m.meanPTrue.FALSE)} |`,
    `| Support at ${bar}: supported / true / FALSE SUPPORTS | ${s.support.supported} / ${s.support.truePositives} / ${s.support.falseSupports} |`,
    `| Support precision / recall at ${bar} | ${f(s.support.supportPrecision, 3)} / ${f(s.support.supportRecall, 3)} |`,
    `| Abstention rate at ${bar} | ${f(s.support.abstentionRate, 3)} |`,
    `| Checked coverage (claims fully checked / chunks checked) | ${f(s.support.checkedCoverage, 3)} / ${f(s.support.chunkCoverage, 3)} (${s.support.checkedChunks}/${s.support.totalChunks} chunks; ${s.support.unchecked} claims unchecked) |`,
    `| Compatibility decided accuracy at ${bar} (two-sided, historical definition) | ${f(s.compatibility.decidedAccuracy, 3)} over ${s.compatibility.decided} decided (tp ${s.compatibility.tp}, fp ${s.compatibility.fp}, tn ${s.compatibility.tn}, fn ${s.compatibility.fn}) |`,
    `| AUC of the historical aggregate score at ${bar} (comparison only) | ${f(m.aucCompatibilityScoreAtPolicyBar)} |`,
    `| Verifier calls (fresh / from cache) | ${cost.verifierCallsFresh} / ${cost.checksFromCache} |`,
    `| Tokens processed (fresh / total checks) | ${cost.tokensFresh} / ${cost.tokensTotal} |`,
    `| Context refusals / error rows | ${cost.refusedOverLimit} / ${cost.errorRows} |`,
    `| Wall time | ${(cost.wallMs / 1000).toFixed(0)} s${stats ? ` (worker inference ${stats.infer_s} s)` : ""} |`,
    ready ? `| Model load | ${ready.load_s} s, ${ready.vram_after_load_mib ?? "n/a"} MiB resident |` : null,
    stats ? `| Peak GPU memory (allocated / reserved) | ${stats.peak_vram_mib} / ${stats.peak_vram_reserved_mib} MiB |` : null,
    "",
    "Threshold sweep, recomputed from raw scores. Support columns follow the package question (any checked chunk >= bar supports; a low score only abstains). The last three columns are the labelled historical two-sided *compatibility* metric.",
    "",
    "| Bar | Supported | True | False supports | Support precision | Support recall | Abstention | Compat decided | Compat correct | Compat decided acc |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...m.sweep.map(row),
    "",
    "By kind at the policy bar:",
    "",
    "| Kind | Claims | AUC | Supported | False supports | Support recall |",
    "|---|---|---|---|---|---|",
    ...Object.entries(m.byKind).map(([k, v]) => `| ${k} | ${v.claims} | ${f(v.auc)} | ${v.support.supported} | ${v.support.falseSupports} | ${f(v.support.supportRecall, 2)} |`),
    "",
    `Gold-quote reference (evaluation only, never an input): ${d.trueClaimsWithGoldQuoteInSomeChunk}/${d.trueClaims} TRUE claims have their gold quote inside at least one chunk of the checked input; ${d.trueSupportedAtPolicyBarWithGoldChunk} TRUE claims were supported at ${bar} by a chunk containing the gold quote.`,
    "",
    cost.refusedOverLimit + cost.errorRows ? `Unchecked rows: ${cost.refusedOverLimit} refused over the context limit, ${cost.errorRows} errors. Samples: ${cost.errorSamples.join("; ") || "none"}` : "No refusals or error rows.",
    "",
    "Raw per-claim and per-chunk probabilities: see the results JSON beside this file.",
    "",
  ].filter((l): l is string => l !== null).join("\n");
}

export function summaryLine(out: RunOutput): string {
  const m: Metrics = out.metrics;
  const s = m.atPolicyBar;
  return [
    `=== ${out.dataset.claims} claims · ${out.engine.id} · ${out.mode} · bar ${m.policyBar} · wall ${(out.cost.wallMs / 1000).toFixed(0)} s ===`,
    `AUC (tie-correct) ${f(m.auc)} over ${m.aucClaims} claims (${m.aucExcludedUnchecked} unchecked excluded)`,
    `support@${m.policyBar}: supported ${s.support.supported}, true ${s.support.truePositives}, false supports ${s.support.falseSupports}, abstention ${f(s.support.abstentionRate, 3)}, chunk coverage ${f(s.support.chunkCoverage, 3)}`,
    `compatibility@${m.policyBar}: decided ${s.compatibility.decided}, accuracy ${f(s.compatibility.decidedAccuracy, 3)}, dangerous ${s.compatibility.dangerous}`,
    `calls fresh ${out.cost.verifierCallsFresh} cached ${out.cost.checksFromCache} · refused ${out.cost.refusedOverLimit} · errors ${out.cost.errorRows}`,
  ].join("\n");
}
