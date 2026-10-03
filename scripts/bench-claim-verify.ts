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
import { DatabaseSync } from "node:sqlite";

import { juliaEngine, k2Engine, layaEngine, openrouterChatEngine, openrouterDecisionsEngine, mapVerdict, DEFAULT_MIN_CONFIDENCE } from "../src/core/verify/claim.ts";
import { loadChunkConfig } from "../src/core/config.ts";
import { replaceChunks, cachedVerdicts, saveVerdicts, claimHashOf, chunksOf } from "../src/core/verify/store.ts";
import { verifyPairsParallel, mapParallel, mapChunkVerdict } from "../src/core/verify/pipeline.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const datasetDir = arg("dataset", "benchmarks/datasets/claim-verification-v1")!;
const textDir = arg("text-dir")!;
const engineName = arg("engine", "julia")!;
const cap = Number(arg("cap", "24000"));
const chunked = process.argv.includes("--chunked");
const date = new Date().toISOString().slice(0, 10);

const ds = JSON.parse(readFileSync(join(datasetDir, "claims.json"), "utf8"));
const claims: { id: string; paper: string; claim: string; label: string; kind?: string }[] = ds.claims;

const texts: Record<string, string> = {};
for (const f of readdirSync(textDir)) if (f.endsWith(".txt")) texts[f.slice(0, -4)] = readFileSync(join(textDir, f), "utf8").replace(/\s+/g, " ");

if (engineName !== "julia" && engineName !== "k2" && engineName !== "laya" && engineName !== "openrouter" && engineName !== "openrouter-chat") {
  console.error(`engine "${engineName}" has no adapter yet (implemented: julia, k2, laya, openrouter, openrouter-chat)`);
  process.exit(2);
}
if ((engineName === "openrouter" && !process.env.UKTUB_OPENROUTER_MODEL) || (engineName === "openrouter-chat" && !process.env.UKTUB_OPENROUTER_CHAT_MODEL)) {
  console.error(`engine "${engineName}" needs UKTUB_OPENROUTER${engineName === "openrouter" ? "_MODEL" : "_CHAT_MODEL"}`);
  process.exit(2);
}
const openrouterModel = process.env.UKTUB_OPENROUTER_MODEL ?? "";
const openrouterChatModel = process.env.UKTUB_OPENROUTER_CHAT_MODEL ?? "";
const engineFactory =
  engineName === "k2" ? () => k2Engine({ env: process.env })
  : engineName === "laya" ? () => layaEngine({ env: process.env })
  : engineName === "openrouter" ? () => openrouterDecisionsEngine({ env: process.env, model: openrouterModel })
  : engineName === "openrouter-chat" ? () => openrouterChatEngine({ env: process.env, model: openrouterChatModel })
  : () => juliaEngine({ env: process.env });
const engine = engineFactory();
const engineKey = engineName === "openrouter" ? `openrouter:${openrouterModel}`
  : engineName === "openrouter-chat" ? `openrouter-chat:${openrouterChatModel}`
  : engineName;

if (chunked) {
  // Chunked like-for-like: each claim is verified against EVERY chunk of its
  // paper (cache-integrated, parallel resident engines); paper verdict =
  // any-supported. Same dataset, same metrics at claim level.
  const cfg = loadChunkConfig(process.cwd(), { env: process.env, required: true });
  const bar = Number(process.env.UKTUB_VERIFY_MIN_CONFIDENCE ?? cfg.verification.min_confidence);
  const model = engineName === "k2" ? "k2:IFM/K2-Type-0.9B"
    : engineName === "laya" ? "laya:convaiinnovations/laya-multilingual"
    : engineName === "openrouter" || engineName === "openrouter-chat" ? engineKey
    : `julia:${process.env.UKTUB_JULIA_MODEL ?? "SupersonicLabs/Julia-1"}`;
  const papers = [...new Set(claims.map((c) => c.paper))];
  const scratch = new DatabaseSync(":memory:");
  scratch.exec(readFileSync(new URL("../src/core/schema.sql", import.meta.url), "utf8"));
  const stubPaper = scratch.prepare(
    "INSERT INTO papers (doi, citekey, title, authors_json, year, venue, provider_bibtex, bibtex_source, citable, ingested_at) VALUES (?, ?, ?, '[]', NULL, NULL, NULL, NULL, 0, ?)",
  );
  for (const p of papers) stubPaper.run(p, p.slice(0, 40), p, new Date().toISOString());
  for (const p of papers) replaceChunks(scratch, p, texts[p], cfg.chunking);
  console.log(`chunked: ${papers.length} papers -> ${scratch.prepare("SELECT count(*) n FROM chunks").get()?.n} chunks (target ${cfg.chunking.chunk_tokens} tokens, overlap ${cfg.chunking.overlap_tokens})`);

  const t0 = Date.now();
  const results = await mapParallel(claims, cfg.verification.workers, (c) => {
    const chunks = chunksOf(scratch, c.paper);
    const cached = cachedVerdicts(scratch, c.claim, model, bar, chunks.map((ch) => ch.content_hash));
    const missing = chunks.filter((ch) => !cached.has(ch.content_hash));
    const freshRows = missing.map((ch) => ({ state: ch.text, instructions: c.claim }));
    const workers = engineName === "laya" ? 1 : cfg.verification.workers; // one resident Router: N workers would multiply checkpoint VRAM (hosted HTTP engines parallelize fine)
  // One shared engine for the whole run: process-based adapters stay
  // resident (model load paid once); per-claim factories would spawn 135
  // GPU workers and orphan each on GC.
  return verifyPairsParallel(() => engine, freshRows, Math.max(1, Math.floor(workers / papers.length))).then((pTrues) => {
      missing.forEach((ch, j) => saveVerdicts(scratch, [{ claim_hash: claimHashOf(c.claim), chunk_hash: ch.content_hash, model, min_confidence: bar, verdict: mapChunkVerdict(pTrues[j], bar).verdict, confidence: pTrues[j], evidence_quote: ch.text.includes(c.evidence ?? "\u0000") ? c.evidence : null }]));
      const ps = chunks.map((ch, j) => missing.includes(ch) ? pTrues[j] : cached.get(ch.content_hash)!.confidence);
      const supported = chunks.some((ch, j) => mapChunkVerdict(ps[j], bar).verdict === "supported");
      const refuted = chunks.some((ch, j) => mapChunkVerdict(ps[j], bar).verdict === "refuted");
      const best = supported ? Math.max(...ps.filter((p) => p >= bar)) : refuted ? Math.min(...ps.filter((p) => 1 - p >= bar)) : Math.max(...ps);
      return { ...c, pTrue: best, verdict: supported ? "supported" : refuted ? "refuted" : "unverified", chunkCount: chunks.length };
    });
  });
  const wall = Date.now() - t0;

  function evalAt(bar: number) {
    let tp = 0, fp = 0, tn = 0, fn = 0, dangerous = 0;
    for (const r of results) {
      const isTrue = r.label === "TRUE";
      if (r.verdict === "supported") isTrue ? tp++ : (fp++, dangerous++);
      else if (r.verdict === "refuted") !isTrue ? tn++ : (fn++, dangerous++);
    }
    const decided = tp + fp + tn + fn;
    return { bar, tp, tn, fp, fn, unverified: results.length - decided, dangerous, decided, decidedAccuracy: decided ? +((tp + tn) / decided).toFixed(3) : 0 };
  }
  console.log(`=== 135 claims CHUNKED · ${cfg.verification.workers} workers · wall=${(wall / 1000).toFixed(0)}s ===`);
  console.log("confusion at bar:", JSON.stringify(evalAt(bar)));
  for (const b of [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99]) console.log(JSON.stringify(evalAt(b)));
  const trues = results.filter((r) => r.label === "TRUE").map((r) => r.pTrue);
  const falses = results.filter((r) => r.label === "FALSE").map((r) => r.pTrue);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const all = results.map((r) => ({ p: r.pTrue, y: r.label === "TRUE" ? 1 : 0 })).sort((a, b) => a.p - b.p);
  let rankSum = 0; all.forEach((x, i) => { rankSum += x.y ? i + 1 : 0; });
  const n1 = trues.length, n0 = falses.length;
  console.log(`mean P(true): TRUE=${mean(trues).toFixed(3)} FALSE=${mean(falses).toFixed(3)}  AUC=${((rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n0)).toFixed(3)}`);
  writeFileSync(join(outDirSafe(), `${engineKey.replace(/[\/~:]/g, "-")}+chunks-claim-verification-v1-${date}.results.json`), JSON.stringify({ results, wallMs: wall, bar }, null, 1));
  process.exit(0);
}

function outDirSafe(): string {
  const d = join("docs", "benchmarks");
  mkdirSync(d, { recursive: true });
  return d;
}

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
const outDir = join("docs", "benchmarks");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${engineKey.replace(/[\/~:]/g, "-")}-claim-verification-v1-${date}.results.json`), JSON.stringify({ results, wallMs: wall, bar, auc }, null, 1));

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

const reportPath = join(outDir, `${engineKey.replace(/[\/~:]/g, "-")}-claim-verification-v1-${date}.md`);
writeFileSync(reportPath, md);
console.log(`report: ${reportPath}`);
