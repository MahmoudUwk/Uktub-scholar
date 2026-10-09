/**
 * Claim-verification benchmark runner (KTD1). Runs one engine over a dataset
 * from benchmarks/datasets/, keeps RAW per-claim and per-chunk probabilities,
 * recomputes every metric from them (scripts/bench-metrics.ts), and writes a
 * dated report + raw results JSON into docs/benchmarks/.
 *
 * Self-contained by design: it imports only the chunker, the chunk-config
 * loader and the ClaimEngine adapters. Chunks live in memory and scores in a
 * JSON cache keyed by (engine id, revision, claim hash, chunk hash); there is
 * no SQLite scratch database and no dependency on the production
 * verification pipeline.
 *
 * Usage (node >= 22.19 strips types natively):
 *   node scripts/bench-claim-verify.ts \
 *     --dataset benchmarks/datasets/claim-verification-v1 \
 *     --text-dir /path/to/extracted-paper-text \
 *     --engine decision2-kai [--chunked] [--text-mode normalized|paragraph]
 * Flags: --cap N (prefix chars, default 24000) · --chunk-tokens/--overlap-tokens/
 *   --chars-per-token/--boundary (override config/chunking.yaml) · --workers N ·
 *   --cache FILE | --no-cache · --out-dir DIR · --tag TEXT (file-name suffix) ·
 *   --limit-claims N (development only; marks the run partial) ·
 *   --audit-tokens (decision2 engines: measure tokenizer density, no scoring).
 * Env: UKTUB_VERIFY_MIN_CONFIDENCE (bar), UKTUB_CHUNK_CONFIG, engine variables
 *   (UKTUB_JULIA_MODEL, UKTUB_DECISION2_MODEL/_REVISION/_PYTHON, ...).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { chunkText, targetChars, overlapChars, type ChunkTextConfig, type TextChunk } from "../src/core/chunk.ts";
import { loadChunkConfig } from "../src/core/config.ts";
import {
  bevEngine, DEFAULT_MIN_CONFIDENCE, EngineError, juliaEngine, k2Engine, layaEngine, lummaEngine, velaEngine, VELA_MODEL, VELA_REVISION,
  minConfidenceFromEnv, openrouterChatEngine, openrouterDecisionsEngine, type ClaimEngine,
} from "../src/core/verify/claim.ts";
import { resolveScores, scoreKey, sha256, type Label } from "./bench-metrics.ts";
import { BARS, computeDiagnostics, computeMetrics, renderMarkdown, summaryLine, type ClaimResult } from "./bench-report.ts";
import { decision2Worker, type Decision2Worker, type Row, type RowResult, type WorkerReady, type WorkerStats } from "./decision2-client.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** Pinned Decision 2.0 checkpoints (HF commit hashes recorded 2026-10-04). */
const DECISION2 = {
  "decision2-kai": { repo: "vllm-sr/Decision-2.0-Kai-0.6B", revision: "cd49ea3813fd8ba0928a9a23ef6c9a0f2f0cd764", dir: "kai" },
  "decision2-eos": { repo: "vllm-sr/Decision-2.0-Eos-0.8B", revision: "3594047d69f476f1d01cf84c593e213fc3a4dfe0", dir: "eos" },
} as const;
const DECISION2_PROMPT_ID = "claim-noul-criteria-v1"; // wording lives in scripts/decision2_decide.py; part of the cache key
const DECISION2_HOME = join(homedir(), ".cache", "uktub-bench", "decision2");

interface ClaimRow { id: string; paper: string; claim: string; label: Label; evidence?: string; kind?: string }
interface Scorer {
  id: string;
  revision: string;
  lanes: number;
  score(rows: Row[]): Promise<RowResult[]>;
  /** Called once at the end: identity/timing facts and a clean shutdown. */
  finish(): Promise<{ ready?: WorkerReady; stats?: WorkerStats }>;
}

const engineName = arg("engine", "julia")!;
const datasetDir = arg("dataset", "benchmarks/datasets/claim-verification-v1")!;
const textDir = arg("text-dir");
const chunked = flag("chunked");
const textMode = arg("text-mode", "normalized") as "normalized" | "paragraph";
const cap = Number(arg("cap", "24000"));
const outDir = arg("out-dir", join("docs", "benchmarks"))!;
const tag = arg("tag", "")!;
const date = new Date().toISOString().slice(0, 10);

// --rerender FILE [--bar X]: recompute metrics and the report from the raw per-chunk
// probabilities stored in an earlier results JSON (no model, no text corpus needed).
const rerender = arg("rerender");
if (rerender) {
  const prev = JSON.parse(readFileSync(rerender, "utf8"));
  const newBar = Number(arg("bar", String(prev.metrics.policyBar)));
  prev.metrics = computeMetrics(prev.results, newBar, BARS);
  prev.diagnostics = computeDiagnostics(prev.results, newBar);
  prev.policy.minConfidence = newBar;
  prev.provenance = { ...prev.provenance, rerenderedFrom: rerender, rerenderedWith: process.argv.slice(2) };
  const dest = join(arg("out-dir", dirname(rerender))!, rerender.split("/").pop()!);
  writeFileSync(dest, JSON.stringify(prev, null, 1));
  writeFileSync(dest.replace(/\.results\.json$/, ".md"), renderMarkdown(prev, tag) + "\n");
  console.log(summaryLine(prev));
  console.log(`rerendered: ${dest}`);
  process.exit(0);
}

const KNOWN = ["julia", "k2", "laya", "bev", "lumma", "openrouter", "openrouter-chat", "decision2-kai", "decision2-eos", "vela"];
if (!KNOWN.includes(engineName)) {
  console.error(`engine "${engineName}" has no adapter yet (implemented: ${KNOWN.join(", ")})`);
  process.exit(2);
}
if (textMode !== "normalized" && textMode !== "paragraph") {
  console.error(`--text-mode must be normalized or paragraph`);
  process.exit(2);
}
if (!textDir) {
  console.error("--text-dir is required (folder of <paper-id>.txt files)");
  process.exit(2);
}

const ds = JSON.parse(readFileSync(join(datasetDir, "claims.json"), "utf8"));
let claims: ClaimRow[] = ds.claims;
const limitClaims = arg("limit-claims") ? Number(arg("limit-claims")) : null;
if (limitClaims !== null) claims = claims.slice(0, limitClaims);

const ws = (s: string) => s.replace(/\s+/g, " ");
/** Chunker input. normalized = the manifest/historical convention (whitespace collapsed, so the
 * paragraph chunker has no breaks and degenerates to hard splits); paragraph = keep blank-line
 * paragraph breaks from pdftotext, collapse whitespace inside each paragraph. */
function prepare(raw: string, mode: "normalized" | "paragraph"): string {
  if (mode === "normalized") return ws(raw);
  return raw.split(/[\f\r\n]*\n[ \t\f]*\n[\s]*/).map((p) => ws(p).trim()).filter((p) => p.length > 0).join("\n\n");
}
const rawTexts: Record<string, string> = {};
for (const f of readdirSync(textDir)) if (f.endsWith(".txt")) rawTexts[f.slice(0, -4)] = readFileSync(join(textDir, f), "utf8");
const papers = [...new Set(claims.map((c) => c.paper))];

// ---- engine ---------------------------------------------------------------

function legacyScorer(id: string, engine: ClaimEngine, lanes: number): Scorer {
  const ok = (p: number): RowResult => ({ p, tokens: null, refused: false, error: null });
  return {
    id, revision: "unpinned", lanes,
    async score(rows) {
      try {
        return (await engine.run(rows)).map(ok);
      } catch (e) {
        if (!(e instanceof EngineError)) throw e;
        // One bad row must not erase the batch: isolate it and keep it as an unchecked error.
        const out: RowResult[] = [];
        for (const r of rows) {
          try { out.push(ok((await engine.run([r]))[0])); } catch (e2) {
            if (!(e2 instanceof EngineError)) throw e2;
            out.push({ p: null, tokens: null, refused: false, error: e2.message });
          }
        }
        return out;
      }
    },
    finish: async () => ({}),
  };
}

let worker: Decision2Worker | null = null;
function makeScorer(workersFlag: number | undefined, configWorkers: number): Scorer {
  const env = process.env;
  const d2 = DECISION2[engineName as keyof typeof DECISION2];
  if (d2) {
    worker = decision2Worker({
      env: {
        ...env,
        UKTUB_DECISION2_MODEL: env.UKTUB_DECISION2_MODEL ?? join(DECISION2_HOME, "models", d2.dir),
        UKTUB_DECISION2_REVISION: env.UKTUB_DECISION2_REVISION ?? d2.revision,
        UKTUB_DECISION2_STDERR: env.UKTUB_DECISION2_STDERR ?? join(DECISION2_HOME, `worker-${d2.dir}.err`),
        UKTUB_DECISION2_PYTHON: env.UKTUB_DECISION2_PYTHON ?? join(DECISION2_HOME, "venv", "bin", "python"),
      },
    });
    const w = worker;
    return {
      id: `${engineName}:${DECISION2_PROMPT_ID}`,
      revision: env.UKTUB_DECISION2_REVISION ?? d2.revision,
      lanes: 1, // one resident process owns the GPU
      score: (rows) => w.scoreMany(rows),
      async finish() {
        const ready = await w.ready;
        const stats = await w.stats();
        await w.close();
        return { ready, stats };
      },
    };
  }
  const lanes = workersFlag ?? configWorkers;
  if (engineName === "openrouter" || engineName === "openrouter-chat") {
    const model = (engineName === "openrouter" ? env.UKTUB_OPENROUTER_MODEL : env.UKTUB_OPENROUTER_CHAT_MODEL) ?? "";
    if (!model) {
      console.error(`engine "${engineName}" needs UKTUB_OPENROUTER${engineName === "openrouter" ? "_MODEL" : "_CHAT_MODEL"}`);
      process.exit(2);
    }
    const engine = engineName === "openrouter" ? openrouterDecisionsEngine({ env, model }) : openrouterChatEngine({ env, model });
    return legacyScorer(`${engineName}:${model}`, engine, lanes);
  }
  const resident: Record<string, [string, () => ClaimEngine, number]> = {
    julia: [`julia:${env.UKTUB_JULIA_MODEL ?? "SupersonicLabs/Julia-1"}`, () => juliaEngine({ env }), lanes],
    laya: ["laya:convaiinnovations/laya-multilingual", () => layaEngine({ env }), 1], // one resident Router: N workers would multiply checkpoint VRAM
    k2: ["k2:IFM/K2-Type-0.9B", () => k2Engine({ env }), lanes],
    bev: ["bev:avbiswas/bev-decider-0.4B", () => bevEngine({ env }), lanes],
    lumma: ["lumma:FrontiersMind/lumma-fev-0.6b", () => lummaEngine({ env }), lanes],
    vela: [`vela:${env.UKTUB_VELA_REVISION === undefined ? VELA_MODEL : basename(env.UKTUB_VELA_DIR ?? "unset")}@${(env.UKTUB_VELA_REVISION ?? VELA_REVISION).slice(0, 12)}`, () => velaEngine({ env }), 1], // one resident model session
  };
  const [id, make, n] = resident[engineName];
  return legacyScorer(id, make(), n);
}

// ---- token audit (decision2 engines only) ----------------------------------

if (flag("audit-tokens")) {
  if (!DECISION2[engineName as keyof typeof DECISION2]) { console.error("--audit-tokens needs a decision2 engine"); process.exit(2); }
  const scorer = makeScorer(1, 1);
  const w = worker!;
  const ready = await w.ready;
  const overheads = [];
  for (const c of claims) overheads.push((await w.count({ state: "x", instructions: c.claim })).tokens);
  const perPaper: Record<string, unknown>[] = [];
  const probe = claims[0].claim;
  for (const p of papers) {
    const text = prepare(rawTexts[p] ?? "", "normalized");
    const tokens = (await w.count({ state: text, instructions: probe })).tokens - (await w.count({ state: "x", instructions: probe })).tokens + 1;
    perPaper.push({ paper: p, chars: text.length, stateTokens: tokens, charsPerToken: +(text.length / tokens).toFixed(3) });
  }
  const audit = {
    engine: engineName, revision: scorer.revision, maxInputTokens: ready.max_input_tokens,
    overheadTokens: { min: Math.min(...overheads), max: Math.max(...overheads), note: "serialized prompt with a 1-char state: instructions + options + suffix, per claim" },
    heuristicCharsPerToken: Number(arg("chars-per-token", "2.8")), // the repo convention being checked (config/chunking.yaml)
    minCharsPerToken: Math.min(...perPaper.map((x) => x.charsPerToken as number)),
    perPaper,
  };
  console.log(JSON.stringify(audit, null, 1));
  const auditOut = arg("audit-out");
  if (auditOut) { mkdirSync(dirname(auditOut), { recursive: true }); writeFileSync(auditOut, JSON.stringify(audit, null, 1)); }
  await scorer.finish();
  process.exit(0);
}

// ---- policy ----------------------------------------------------------------

// Giving all four chunk flags makes a run independent of config/chunking.yaml (reproducible
// across config edits); otherwise the missing values come from the loaded config.
const explicit = ["chunk-tokens", "overlap-tokens", "chars-per-token", "boundary"].every((n) => arg(n) !== undefined);
const cfg = chunked && !explicit ? loadChunkConfig(process.cwd(), { env: process.env, required: true }) : null;
const chunking: ChunkTextConfig | null = !chunked ? null : {
  chunk_tokens: Number(arg("chunk-tokens", String(cfg?.chunking.chunk_tokens))),
  overlap_tokens: Number(arg("overlap-tokens", String(cfg?.chunking.overlap_tokens))),
  chars_per_token: Number(arg("chars-per-token", String(cfg?.chunking.chars_per_token))),
  boundary: arg("boundary", cfg?.chunking.boundary) as "paragraph" | "hard",
};
const bar = cfg ? Number(process.env.UKTUB_VERIFY_MIN_CONFIDENCE ?? cfg.verification.min_confidence) : minConfidenceFromEnv(process.env);
const scorer = makeScorer(arg("workers") ? Number(arg("workers")) : undefined, cfg?.verification.workers ?? 1);

// Chunks (chunked) or one capped prefix per paper (baseline), all in memory.
interface PaperChunks { chars: number; chunks: { index: number; char_start: number; char_end: number; hash: string; text: string }[] }
const paperChunks: Record<string, PaperChunks> = {};
for (const p of papers) {
  const raw = rawTexts[p];
  if (raw === undefined) { paperChunks[p] = { chars: 0, chunks: [] }; continue; }
  if (chunking) {
    const text = prepare(raw, textMode);
    const cs: TextChunk[] = chunkText(text, chunking);
    paperChunks[p] = { chars: text.length, chunks: cs.map((c) => ({ index: c.index, char_start: c.char_start, char_end: c.char_end, hash: c.content_hash, text: c.text })) };
  } else {
    const text = ws(raw);
    const prefix = text.slice(0, cap);
    paperChunks[p] = { chars: text.length, chunks: [{ index: 0, char_start: 0, char_end: prefix.length, hash: sha256(prefix), text: prefix }] };
  }
}
const totalChunks = Object.values(paperChunks).reduce((n, p) => n + p.chunks.length, 0);
console.log(`${chunked ? "chunked" : `prefix(${cap})`}: ${papers.length} papers -> ${totalChunks} chunks · engine ${scorer.id} · text-mode ${chunked ? textMode : "normalized"} · bar ${bar} · lanes ${scorer.lanes}`);

// ---- score cache -----------------------------------------------------------

interface CacheEntry { p: number; tokens: number | null }
const cachePath = flag("no-cache") ? null : (arg("cache") ?? join(homedir(), ".cache", "uktub-bench", "score-cache.json"));
const cache = new Map<string, CacheEntry>();
if (cachePath && existsSync(cachePath)) {
  const stored = JSON.parse(readFileSync(cachePath, "utf8")) as { version: number; entries: Record<string, CacheEntry> };
  if (stored.version === 1) for (const [k, v] of Object.entries(stored.entries)) cache.set(k, v);
}
function saveCache(): void {
  if (!cachePath) return;
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ version: 1, entries: Object.fromEntries(cache) }));
}

// ---- evaluation ------------------------------------------------------------

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  }));
  return out;
}

const counters = { fresh: 0, cached: 0, tokensFresh: 0, tokensTotal: 0, refused: 0, errors: 0 };
const errorSamples: string[] = [];
const t0 = Date.now();
let done = 0;
const results: ClaimResult[] = await pool(claims, scorer.lanes, async (c) => {
  const pc = paperChunks[c.paper];
  const claimHash = sha256(c.claim);
  const keys = pc.chunks.map((ch) => scoreKey(scorer.id, scorer.revision, claimHash, ch.hash));
  const issues: ClaimResult["issues"] = [];
  const tokens: (number | null)[] = pc.chunks.map((_, i) => cache.get(keys[i])?.tokens ?? null);
  const pCache = new Map<string, number>();
  for (const k of keys) if (cache.has(k)) pCache.set(k, cache.get(k)!.p);
  const { scores, fresh } = await resolveScores(keys, pCache, async (missing) => {
    const answers = await scorer.score(missing.map((i) => ({ state: pc.chunks[i].text, instructions: c.claim })));
    return answers.map((a, j) => {
      const i = missing[j];
      tokens[i] = a.tokens;
      if (a.p === null) {
        issues.push({ chunk: i, kind: a.refused ? "refused" : "error", message: a.error ?? "unknown" });
        a.refused ? counters.refused++ : counters.errors++;
        if (errorSamples.length < 5) errorSamples.push(`${c.id}#${i}: ${a.error}`);
      } else {
        cache.set(keys[i], { p: a.p, tokens: a.tokens });
        counters.tokensFresh += a.tokens ?? 0;
      }
      return a.p;
    });
  });
  counters.fresh += fresh;
  counters.cached += keys.length - fresh;
  counters.tokensTotal += tokens.reduce<number>((s, t) => s + (t ?? 0), 0);
  const ev = c.evidence ? ws(c.evidence) : null;
  const goldChunks = ev ? pc.chunks.filter((ch) => ws(ch.text).includes(ev)).map((ch) => ch.index) : [];
  if (++done % 20 === 0) console.log(`  ${done}/${claims.length} claims · ${((Date.now() - t0) / 1000).toFixed(0)} s · fresh ${counters.fresh} cached ${counters.cached}`);
  return {
    id: c.id, paper: c.paper, label: c.label, kind: c.kind, claim: c.claim, claim_hash: claimHash,
    chunkP: scores, chunkTokens: tokens, issues, goldChunks,
  };
});
const wallMs = Date.now() - t0;
saveCache();
const facts = await scorer.finish();

// ---- metrics (all from raw chunk probabilities) ----------------------------

const mode = chunked ? "chunked" : "prefix";
const metrics = computeMetrics(results, bar, BARS);
const diagnostics = computeDiagnostics(results, bar);

function gitFacts(): { commit: string | null; dirty: boolean | null } {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  const dirty = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  return { commit: head.status === 0 ? head.stdout.trim() : null, dirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null };
}

const out = {
  schema: "bench-claim-verify/2",
  date,
  partial: limitClaims !== null,
  dataset: { name: ds.dataset, claims: results.length, TRUE: results.filter((r) => r.label === "TRUE").length, FALSE: results.filter((r) => r.label === "FALSE").length, papers: papers.length },
  engine: { name: engineName, id: scorer.id, revision: scorer.revision, ready: facts.ready ?? null },
  mode,
  textMode: chunked ? textMode : "normalized",
  policy: chunking
    ? { ...chunking, target_chars: targetChars(chunking), overlap_chars: overlapChars(chunking), minConfidence: bar, defaultMinConfidence: DEFAULT_MIN_CONFIDENCE }
    : { prefix_chars: cap, minConfidence: bar, defaultMinConfidence: DEFAULT_MIN_CONFIDENCE },
  papers: Object.fromEntries(papers.map((p) => [p, { chars: paperChunks[p].chars, chunks: paperChunks[p].chunks.map(({ text: _t, ...rest }) => rest) }])),
  results,
  metrics,
  diagnostics,
  cost: {
    wallMs, lanes: scorer.lanes, verifierCallsFresh: counters.fresh, checksFromCache: counters.cached,
    tokensFresh: counters.tokensFresh, tokensTotal: counters.tokensTotal,
    refusedOverLimit: counters.refused, errorRows: counters.errors, errorSamples,
    worker: facts.stats ?? null,
  },
  provenance: { git: gitFacts(), node: process.version, argv: process.argv.slice(2), cache: cachePath },
};

const base = `${scorer.id.split(":")[0].replace(/[\/~:]/g, "-")}${chunked ? "+chunks" : ""}${tag ? `-${tag}` : ""}-claim-verification-v1-${date}`;
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${base}.results.json`), JSON.stringify(out, null, 1));
writeFileSync(join(outDir, `${base}.md`), renderMarkdown(out, tag) + "\n");
console.log(summaryLine(out));
console.log(`report: ${join(outDir, base)}.md`);
process.exit(0);
