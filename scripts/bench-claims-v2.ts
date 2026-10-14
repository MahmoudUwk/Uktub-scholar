/**
 * claim-verification-v2 runner (docs/plans/2026-10-11-claim-verification-v2-benchmark-plan.md, step 4): every claim goes through the REAL
 * `verify_claim` path (`verifyClaimTool`), scoped to its own paper, exhaustive, at the product's chunking and bar. The paper is published
 * straight from its PDF (unpdf extraction, sections, 512-token chunks), as scripts/bench-evidence.ts does; acquisition and identity checks
 * are covered by the offline suite. The score of a claim is the highest probability any chunk of its paper got, read back from the registry's
 * judgment cache, so the whole score range is available, not only what clears the bar. Wall time per claim is recorded.
 *
 * One deviation from the product defaults, on purpose: `verification.max_judgments` is raised so a long paper completes in one call
 * (the product would continue it with a continuation token; the score would be the same).
 *
 * Usage: node scripts/bench-claims-v2.ts (--engine eos-onnx | --spec kai|vela-0.8b|vela-0.3b|d3-lite|d3-edge|d1-omni|eos) --device cpu|gpu [--papers N] [--stride K --offset O | --ids file.json] [--resume] [--label L]
 * Output: <out>/claims-v2-<label>-<date>.results.json (records and run facts); the metrics come from bench-claims-v2-report.ts.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, homedir, loadavg, tmpdir, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEFAULTS } from "../src/core/config.ts";
import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry, openRegistry, registerPaper } from "../src/core/registry.ts";
import { extractPdf } from "../src/core/source/extract.ts";
import { verifyClaimTool, type VerifyClaimArgs } from "../src/core/tools/verify.ts";
import { selectCandidates } from "../src/core/verify/retrieve.ts";
import { cachedJudgments, publishSource } from "../src/core/verify/store.ts";
import { chunkScore } from "./bench-claims-v2-score.ts";
import { cpuVariant, engineSpecs } from "./bench-claims-v2-engines.ts";
import { decision2Worker } from "./decision2-client.ts";
import { httpEngine, startServer, waitForServer } from "./bench-claims-v2-http.ts";

/** The auth header of a hosted System One endpoint, built at request time from a key that is never stored. */
const remoteHeaders = (key: string): Record<string, string> => ({ authorization: "Bearer " + key });

/** One `NAME=value` (or `export NAME=value`) line of a dotenv file; the name keeps its case (provider keys are not all uppercase). */
const dotenvValue = (text: string, name: string): string | null => {
  const m = new RegExp(`^(?:export\\s+)?${name}\\s*=\\s*(.*)$`, "m").exec(text);
  if (m === null) return null;
  const value = m[1]!.trim().replace(/^(['"])(.*)\1$/, "$2");
  return value === "" ? null : value;
};

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] as string) : fallback;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const datasetDir = arg("dataset", "benchmarks/datasets/claim-verification-v2");
const pdfDir = arg("pdf-dir", join(homedir(), ".cache/uktub-bench/v2-corpus/pdf"));
const outDir = arg("out", "docs/benchmarks");
const workDir = arg("work", join(homedir(), ".cache/uktub-bench/v2-runs"));
const benchHome = join(homedir(), ".cache/uktub-bench");
const specId = arg("spec", ""); // a candidate of the model table (bench-claims-v2-engines.ts): launched on the GPU through the product path
const device = arg("device", "unlabelled"); // where the model ran (a label); with --spec and cpu the candidate's own device settings become cpu (cpuVariant)
const spec0 = specId === "" ? null : (engineSpecs(benchHome)[specId] ?? (() => { throw new Error(`unknown --spec ${specId}`); })());
const spec = spec0 !== null && device === "cpu" ? cpuVariant(spec0) : spec0;
const engine = spec?.engine ?? arg("engine", "eos-onnx");
const date = arg("date", new Date().toISOString().slice(0, 10));
const label = arg("label", `${specId === "" ? engine : specId}-${device}`);
const paperLimit = Number(arg("papers", "0")); // 0 = all papers (smoke runs take the first N by id)
const stride = Number(arg("stride", "1")); // every k-th claim of each paper: a deterministic subset
const offset = Number(arg("offset", "0"));
const idsFile = arg("ids", ""); // a JSON array of claim ids to run instead of the stride subset (a selection, not a sample: the report says so)

interface CorpusPaper { id: string; fold: number; sha256: string }
interface DatasetClaim { id: string; paper: string; claim: string; label: "TRUE" | "FALSE"; type: string }
const corpus = (JSON.parse(readFileSync(join(datasetDir, "corpus.json"), "utf8")) as { papers: CorpusPaper[] }).papers;
const allClaims = (JSON.parse(readFileSync(join(datasetDir, "claims.json"), "utf8")) as { claims: DatasetClaim[] }).claims;
const wanted = idsFile === "" ? null : new Set(JSON.parse(readFileSync(idsFile, "utf8")) as string[]);
const papers = [...corpus].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, paperLimit > 0 ? paperLimit : undefined);
const claims = papers.flatMap((p) => allClaims.filter((c) => c.paper === p.id).sort((a, b) => (a.id < b.id ? -1 : 1)).filter((c, i) => (wanted === null ? i % stride === offset : wanted.has(c.id))));

export interface RunRecord {
  id: string;
  paper: string;
  label: "TRUE" | "FALSE";
  type: string;
  fold: number;
  score: number | null;
  unjudged: number;
  chunks: number;
  /** The product's own verdict at its bar (min_confidence), for comparison with the score-based metrics. */
  supportFound: boolean;
  fresh: number;
  cached: number;
  localizationFresh: number;
  wallMs: number;
  refused: string | null;
}

const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const git = (...a: string[]): string => { try { return execFileSync("git", a, { encoding: "utf8" }).trim(); } catch { return "unknown"; } };

/** The GPU's name and the memory the whole device has in use (the run's models plus the desktop): `peakUsedMiB` is the largest sample. */
function gpuProbe(): { name: string; totalMiB: number; baselineUsedMiB: number; peakUsedMiB: number } {
  try {
    const [name, total, used] = execFileSync("nvidia-smi", ["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"], { encoding: "utf8" }).trim().split("\n")[0]!.split(",").map((x) => x.trim());
    return { name: name!, totalMiB: Number(total), baselineUsedMiB: Number(used), peakUsedMiB: Number(used) };
  } catch {
    return { name: "unknown", totalMiB: 0, baselineUsedMiB: 0, peakUsedMiB: 0 };
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "uktub-v2-"));
  mkdirSync(workDir, { recursive: true });
  const partial = join(workDir, `claims-v2-${label}-${date}.partial.jsonl`);
  const done = new Map<string, RunRecord>();
  if (flag("resume") && existsSync(partial)) for (const l of readFileSync(partial, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l) as RunRecord; done.set(r.id, r); }
  else if (existsSync(partial)) rmSync(partial);

  // Publish every paper from its PDF, after checking the file is the one the dataset names.
  const db = createRegistry(root);
  const dois = new Map<string, string>();
  const cfg = DEFAULTS.chunking;
  for (const [i, p] of papers.entries()) {
    const bytes = new Uint8Array(readFileSync(join(pdfDir, `${p.id}.pdf`)));
    if (sha256(bytes) !== p.sha256) throw new Error(`${p.id}: the PDF does not match the dataset's sha256`);
    const doi = `10.9999/v2-${String(i + 1).padStart(3, "0")}`;
    dois.set(p.id, doi);
    registerPaper(db, { doi, title: p.id, authors: [], year: 2026 });
    const x = await extractPdf(bytes);
    publishSource(db, doi, { kind: "local-file", ref: "bench.pdf", license: null, digest: sha256(bytes), extraction: x.extraction, text: x.text, pageStarts: x.pageStarts, sections: x.sections }, cfg, new Date());
  }
  db.close();

  const cfgPath = join(root, "bench.yaml");
  const v = DEFAULTS.verification;
  writeFileSync(cfgPath, `chunking:\n  chunk_tokens: ${cfg.chunk_tokens}\n  overlap_tokens: ${cfg.overlap_tokens}\n  chars_per_token: ${cfg.chars_per_token}\n  boundary: ${cfg.boundary}\nverification:\n  engine: ${engine}\n  min_confidence: ${v.min_confidence}\n  workers: ${v.workers}\n  max_judgments: 100000\n`);
  const env = { ...process.env, UKTUB_CHUNK_CONFIG: cfgPath, ...(device === "cpu" ? { UKTUB_DECISION2_DEVICE: "cpu" } : {}), ...(spec?.env ?? {}), ...(spec?.adapter ? { UKTUB_VERIFY_MODEL_ID: spec.adapter.declaredId } : {}), ...(spec?.server ? { UKTUB_VERIFY_MODEL_ID: spec.server.declaredId } : {}), ...(spec?.remote ? { UKTUB_VERIFY_MODEL_ID: spec.remote.declaredId } : {}) } as Record<string, string>;
  const ctx = { root, fetch: ((...a: Parameters<typeof fetch>) => fetch(...a)) as never, env, now: () => new Date(), queue: new WriteQueue() };
  // The idle baseline of the GPU, taken BEFORE any model is loaded, so the memory figure includes the model and not only its activations.
  const gpu = device === "gpu" ? gpuProbe() : null;
  // An adapter has no product engine of its own: its resident worker is injected, the identity is the declared one.
  const worker = spec?.adapter ? decision2Worker({ env: { ...process.env, ...spec.adapter.env } as Record<string, string>, pythonBin: spec.adapter.python, script: join(dirname(fileURLToPath(import.meta.url)), spec.adapter.script) }) : null;
  // A model with its own System One server: the author's server is started for the run and stopped after it, rows are posted over HTTP.
  const server = spec?.server ? startServer({ cwd: spec.server.cwd, command: spec.server.command, env: { ...process.env, ...spec.server.env } as Record<string, string> }) : null;
  if (server !== null) {
    process.once("exit", () => { try { process.kill(-(server.child.pid as number), "SIGKILL"); } catch { /* gone */ } });
    await waitForServer(spec!.server!.url, { timeoutMs: 600_000, intervalMs: 2_000 });
  }
  const serverInfo = server === null ? null : await fetch(`${spec!.server!.url}/v1/models`).then((r) => r.json()).catch(() => null);
  // A hosted endpoint needs its key at request time: the shell wins over the repository's `.env`, and the key lives only in the
  // request closure below (never in the spec, the logs, the partial file or the results).
  const remoteKey = spec?.remote === undefined ? null : (process.env["VLLM_decision_API"] || (existsSync(".env") ? dotenvValue(readFileSync(".env", "utf8"), "VLLM_decision_API") : null) || null);
  if (spec?.remote !== undefined && remoteKey === null) throw new Error(`${specId}: VLLM_decision_API is not set (neither the shell nor .env has it)`);
  const latencies: number[] = [];
  const hooks = worker !== null ? { createEngine: () => worker.asEngine() } : server !== null ? { createEngine: () => httpEngine(spec!.server!.url, spec!.server!.wording) } : spec?.remote !== undefined ? { createEngine: () => httpEngine(spec!.remote!.url, spec!.remote!.wording, fetch, { model: spec!.remote!.model, concurrency: spec!.remote!.concurrency, onLatency: (ms) => { latencies.push(ms); }, headers: remoteHeaders(remoteKey as string) }) } : {};
  const workerReady = worker === null ? null : await worker.ready;

  const reg = openRegistry(root);
  const chunkHashes = new Map<string, string[]>();
  for (const p of papers) chunkHashes.set(p.id, selectCandidates(reg, [dois.get(p.id)!], null)[0]?.candidates.map((c) => c.hash) ?? []);
  const foldOf = new Map(papers.map((p) => [p.id, p.fold]));
  const start = { at: new Date().toISOString(), loadavg: loadavg() };
  const t0 = Date.now();
  let identity: { model: string | null; protocol: string; minConfidence: number } | null = null;

  for (const c of claims) {
    if (done.has(c.id)) continue;
    const t1 = Date.now();
    const r = await verifyClaimTool(ctx as never, { claim: c.claim, papers: [dois.get(c.paper)!] } as VerifyClaimArgs, hooks);
    const wallMs = Date.now() - t1;
    const s = r.structuredContent as Record<string, any> | null;
    const refused = r.details.refused as { code: string; message: string } | undefined;
    let rec: RunRecord;
    if (s === null) {
      rec = { id: c.id, paper: c.paper, label: c.label, type: c.type, fold: foldOf.get(c.paper)!, score: null, unjudged: 0, chunks: chunkHashes.get(c.paper)!.length, supportFound: false, fresh: 0, cached: 0, localizationFresh: 0, wallMs, refused: `${refused?.code}: ${refused?.message}` };
    } else {
      identity ??= { model: s.engine.model === null ? null : String(s.engine.model).replaceAll(homedir(), "~"), protocol: s.engine.protocol, minConfidence: s.engine.minConfidence };
      const judged = s.engine.model === null ? new Map<string, number>() : cachedJudgments(reg, c.claim, { model: s.engine.model, protocol: s.engine.protocol }, chunkHashes.get(c.paper)!);
      const sc = chunkScore(chunkHashes.get(c.paper)!, judged);
      rec = { id: c.id, paper: c.paper, label: c.label, type: c.type, fold: foldOf.get(c.paper)!, score: sc.score, unjudged: sc.unjudged, chunks: chunkHashes.get(c.paper)!.length, supportFound: s.result.supportFound, fresh: s.coverage.work.fresh, cached: s.coverage.work.cached, localizationFresh: s.coverage.work.localizationFresh, wallMs, refused: null };
    }
    done.set(rec.id, rec);
    appendFileSync(partial, `${JSON.stringify(rec)}\n`);
    if (gpu !== null && done.size % 5 === 0) gpu.peakUsedMiB = Math.max(gpu.peakUsedMiB, gpuProbe().peakUsedMiB);
    if (done.size % 10 === 0) console.error(`${done.size}/${claims.length} claims, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  reg.close();
  rmSync(root, { recursive: true, force: true });
  const workerStats = worker === null ? null : await worker.stats().catch(() => null);
  await worker?.close();
  await server?.stop();

  const records = claims.map((c) => done.get(c.id)!);
  const pctOf = (xs: number[], q: number): number | null => {
    if (xs.length === 0) return null;
    const v = [...xs].sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.floor(q * v.length))] as number;
  };
  const file = join(outDir, `claims-v2-${label}-${date}.results.json`);
  writeFileSync(file, JSON.stringify({
    schema: "bench-claims-v2/1",
    date,
    spec: specId === "" ? null : specId,
    engine,
    worker: workerReady === null ? (serverInfo === null ? null : { server: spec!.server!.url, wording: spec!.server!.wording, models: serverInfo }) : { ...workerReady, stats: workerStats },
    device,
    label,
    identity,
    commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain", "--", "src", "scripts", "benchmarks/datasets/claim-verification-v2").length > 0,
    dataset: { claimsSha256: sha256(readFileSync(join(datasetDir, "claims.json"))), corpusSha256: sha256(readFileSync(join(datasetDir, "corpus.json"))), papers: papers.length, claims: claims.length, stride, offset, selection: wanted === null ? null : `${wanted.size} claims chosen by id from ${basename(idsFile)}` },
    chunking: cfg,
    maxJudgmentsRaisedFrom: v.max_judgments,
    gpu,
    machine: { cpu: cpus()[0]?.model ?? "unknown", cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30), node: process.version },
    run: { startedAt: start.at, loadavgStart: start.loadavg, loadavgEnd: loadavg(), seconds: Math.round((Date.now() - t0) / 1000) },
    records,
    remote: spec?.remote === undefined ? null : { url: spec.remote.url, model: spec.remote.model, wording: spec.remote.wording, requests: latencies.length, latencyMs: { p50: pctOf(latencies, 0.5), p95: pctOf(latencies, 0.95) } },
  }, null, 1));
  console.log(`wrote ${file} (${records.length} claims)`);
}

await main();
