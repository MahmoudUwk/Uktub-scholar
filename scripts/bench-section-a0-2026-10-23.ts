/**
 * Pre-registered section-verify A/B baselines (2026-10-23):
 * `docs/benchmarks/section-verify-ab-2026-10-23.json` (design written BEFORE
 * any keyed request; results null). This script runs the HOSTED d3-mini A0
 * arms on the CURRENT product code only (frozen tree; no B arms exist yet):
 *
 * - phase ladder: documented-vs-measured limits probes (a few dozen requests)
 * - phase claims: 547 claims through the REAL product hosted path
 *   (`verifyClaimTool`, config engine `hosted` = top-10 gate, no hooks that
 *   change the engine; a counting fetch only), scored over the product's own
 *   top-10 candidate set (same scoredHashes fix as 2026-10-22)
 * - phase docs: product document mode on scratch copies of the same 18 notes
 *   as 2026-10-15/2026-10-22 (judgment tables wiped in the copies)
 *
 * The key comes from `VLLM_decision_API` (shell wins over the repo `.env`),
 * is mapped to `UKTUB_VERIFY_API_KEY` in the tool env only, and is never
 * printed, logged or stored. No OpenRouter requests. No paid API.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry, openRegistry, registerPaper } from "../src/core/registry.ts";
import { extractPdf } from "../src/core/source/extract.ts";
import { verifyClaimTool, type VerifyClaimArgs } from "../src/core/tools/verify.ts";
import { selectCandidates, lexicalRank, locatorTokens, type Candidate } from "../src/core/verify/retrieve.ts";
import { TOP_K, topCandidates } from "../src/core/verify/strategy.ts";
import { cachedJudgments } from "../src/core/verify/store.ts";
import { resolveEngineIdentityCached } from "../src/core/verify/engines.ts";
import { criteriaQuestion } from "../src/core/verify/wording.ts";
import { chunkScore, itemOf, PRODUCT_BAR } from "./bench-claims-v2-score.ts";
import { crossFit, ratesOf } from "./bench-claims-v2-metrics.ts";

const DATE = "2026-10-23";
const NOTES = "/home/mahmoud/.cache/uktub-bench/hermes-v0-section-verify-baselines-2026-10-23";
const HOSTED_URL = "https://decision.vllm-sr.ai";
const MODEL = "vllm-sr/d3-mini";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] as string) : fallback;
};

const dotenvValue = (text: string, name: string): string | null => {
  const m = new RegExp(`^(?:export\\s+)?${name}\\s*=\\s*(.*)$`, "m").exec(text);
  if (m === null) return null;
  const value = m[1]!.trim().replace(/^(['"])(.*)\1$/, "$2");
  return value === "" ? null : value;
};

/** Hosted key: the shell wins over the repo `.env`; held in memory only. */
const hostedKey = (): string => {
  const fromEnv = process.env.VLLM_decision_API?.trim();
  if (fromEnv) return fromEnv;
  const envFile = existsSync(".env") ? readFileSync(".env", "utf8") : "";
  const fromFile = dotenvValue(envFile, "VLLM_decision_API");
  if (!fromFile) throw new Error("VLLM_decision_API is not set (neither shell nor .env has it)");
  return fromFile;
};

/** Counting transport: requests + body bytes; the key never enters a log. */
const countingFetch = (counters: { requests: number; chars: number }): typeof fetch =>
  ((async (input: unknown, init?: unknown) => {
    const url = String(typeof input === "string" ? input : (input as { url: string }).url);
    if (url.includes("/v1/systemone") && (init as { method?: string } | undefined)?.method === "POST") {
      counters.requests += 1;
      counters.chars += Buffer.byteLength(String((init as { body?: unknown }).body ?? ""), "utf8");
    }
    return fetch(input as never, init as never);
  }) as typeof fetch);

const cpLen = (s: string): number => Array.from(s).length;
const cpSlice = (s: string, n: number): string => Array.from(s).slice(0, n).join("");

async function phaseLadder(): Promise<void> {
  const key = hostedKey();
  const outPath = join(NOTES, "ladder-2026-10-23.json");
  const probes: unknown[] = [];
  // Real paper text: first corpus PDF by id order, extracted like the product.
  const pdfDir = arg("pdf-dir", join(homedir(), ".cache/uktub-bench/v2-corpus/pdf"));
  const corpus = (JSON.parse(readFileSync("benchmarks/datasets/claim-verification-v2/corpus.json", "utf8")) as { papers: { id: string }[] }).papers;
  const first = [...corpus].sort((a, b) => (a.id < b.id ? -1 : 1))[0]!;
  const text = (await extractPdf(new Uint8Array(readFileSync(join(pdfDir, `${first.id}.pdf`))))).text;
  const allClaims = (JSON.parse(readFileSync("benchmarks/datasets/claim-verification-v2/claims.json", "utf8")) as { claims: { claim: string }[] }).claims;
  const info = await (await fetch(`${HOSTED_URL}/api/info`)).json();
  const documented = {
    max_questions: info.limits.max_questions, max_state_chars: info.limits.max_state_chars,
    max_request_tokens: info.limits.max_request_tokens, max_states: info.limits.max_states,
    max_body_bytes: info.limits.max_body_bytes, timeout_seconds: info.limits.timeout_seconds,
    d3mini: info.models.find((m: { id: string }) => m.id === MODEL)?.limits,
    perKeyConcurrency: info.rate_limits.per_key.max_concurrency,
  };
  const post = async (path: string, body: unknown): Promise<{ status: number; body: string; ms: number }> => {
    const t = Date.now();
    const res = await fetch(`${HOSTED_URL}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    const ms = Date.now() - t;
    const txt = await res.text();
    return { status: res.status, body: txt.slice(0, 600), ms };
  };
  const q = (i: number): unknown => criteriaQuestion(allClaims[i % allClaims.length]!.claim, "criteria");
  const qs = (n: number): Record<string, unknown> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i + 1}`, q(i)]));
  // 1. state-length ladder, one question each
  for (const n of [8000, 16000, 32000, 32001]) {
    const state = cpSlice(text, n);
    if (cpLen(state) !== n) throw new Error(`short paper text: ${cpLen(state)} < ${n}`);
    const r1 = await post("/v1/systemone", { model: MODEL, state, questions: { c1: q(0) } });
    probes.push({ probe: `state_${n}`, stateChars: cpLen(state), questions: 1, status: r1.status, body: r1.body, ms: r1.ms });
  }
  // 2. byte-estimate boundary on a 32,000-char state
  for (const n of [4, 5]) {
    const r2 = await post("/v1/systemone", { model: MODEL, state: cpSlice(text, 32000), questions: qs(n) });
    probes.push({ probe: `state32000_Q${n}`, stateChars: 32000, questions: n, status: r2.status, body: r2.body, ms: r2.ms });
  }
  // 3. question-count ladder on a ~4,000-char state
  for (const n of [20, 64]) {
    const r3 = await post("/v1/systemone", { model: MODEL, state: cpSlice(text, 4000), questions: qs(n) });
    probes.push({ probe: `state4000_Q${n}`, stateChars: 4000, questions: n, status: r3.status, body: r3.body, ms: r3.ms });
  }
  // 4. one invalid question among valid ones
  const bad = { c1: q(1), bad: { type: "bogus-type", instructions: "Is this question valid?" }, c2: q(2) };
  const r4 = await post("/v1/systemone", { model: MODEL, state: cpSlice(text, 4000), questions: bad });
  probes.push({ probe: "invalid_question_systemone", status: r4.status, body: r4.body, ms: r4.ms });
  // 5. same on /v1/decisions
  const r5 = await post("/v1/decisions", { model: MODEL, state: cpSlice(text, 4000), questions: bad });
  probes.push({ probe: "invalid_question_decisions", status: r5.status, body: r5.body, ms: r5.ms });
  writeFileSync(outPath, JSON.stringify({ schema: "section-verify-ab/ladder/1", date: DATE, model: MODEL, documented, probes }, null, 1));
  console.error(`ladder done: ${probes.length} probes -> ${outPath}`);
}

interface ClaimRec {
  id: string; paper: string; label: "TRUE" | "FALSE"; type: string; fold: number;
  score: number | null; unjudged: number; chunks: number; supportFound: boolean;
  fresh: number; cached: number; wallMs: number; refused: string | null;
  pointers: { pointer: string; chunkId: string; score: number; excerpt: string | null }[];
}

async function buildClaimsRoot(): Promise<{ root: string; dois: Map<string, string>; folds: Map<string, number>; candidates: Map<string, Candidate[]> }> {
  const datasetDir = "benchmarks/datasets/claim-verification-v2";
  const pdfDir = arg("pdf-dir", join(homedir(), ".cache/uktub-bench/v2-corpus/pdf"));
  const corpus = (JSON.parse(readFileSync(join(datasetDir, "corpus.json"), "utf8")) as { papers: { id: string; fold: number; sha256: string }[] }).papers;
  const root = join(NOTES, "claims-registry");
  const crypto = await import("node:crypto");
  if (!existsSync(join(root, ".registry", "registry.db"))) {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const db = createRegistry(root);
    const cfg = (await import("../src/core/config.ts")).DEFAULTS.chunking;
    for (const p of [...corpus].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const bytes = new Uint8Array(readFileSync(join(pdfDir, `${p.id}.pdf`)));
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== p.sha256) throw new Error(`${p.id}: PDF sha mismatch`);
      registerPaper(db, { doi: `10.9999/v2-${p.id}`, title: p.id, authors: [], year: 2026 });
    }
    for (const p of [...corpus].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const bytes = new Uint8Array(readFileSync(join(pdfDir, `${p.id}.pdf`)));
      const x = await extractPdf(bytes);
      const { publishSource } = await import("../src/core/verify/store.ts");
      publishSource(db, `10.9999/v2-${p.id}`, { kind: "local-file", ref: "bench.pdf", license: null, digest: crypto.createHash("sha256").update(bytes).digest("hex"), extraction: x.extraction, text: x.text, pageStarts: x.pageStarts, sections: x.sections }, (await import("../src/core/config.ts")).DEFAULTS.chunking, new Date());
    }
    db.close();
  }
  const reg = openRegistry(root);
  const dois = new Map<string, string>(); const folds = new Map<string, number>(); const candidates = new Map<string, Candidate[]>();
  for (const p of corpus) {
    dois.set(p.id, `10.9999/v2-${p.id}`); folds.set(p.id, p.fold);
    candidates.set(p.id, selectCandidates(reg, [`10.9999/v2-${p.id}`], null)[0]?.candidates ?? []);
  }
  reg.close();
  return { root, dois, folds, candidates };
}

/**
 * The product's scored candidate set for A0 (mirrors workflow
 * narrowCandidates: no-searchable-words claims fall back to exhaustive;
 * otherwise the lexicalRank top-K, TOP_K=10).
 */
function scoredHashes(all: Candidate[], db: { prepare: Function } | unknown, doi: string, claim: string): string[] {
  if (locatorTokens(claim).length === 0) return all.map((c) => c.hash);
  const ranked = lexicalRank(db as never, [doi], claim, TOP_K);
  return topCandidates(all, ranked.map((r) => r.chunkId)).map((c) => c.hash);
}

async function phaseClaims(): Promise<void> {
  const key = hostedKey();
  const { root, dois, folds, candidates } = await buildClaimsRoot();
  const datasetDir = "benchmarks/datasets/claim-verification-v2";
  const allClaims = (JSON.parse(readFileSync(join(datasetDir, "claims.json"), "utf8")) as { claims: { id: string; paper: string; claim: string; label: "TRUE" | "FALSE"; type: string }[] }).claims;
  const outPath = join(NOTES, "a0-claims-2026-10-23.json");
  const partial = join(NOTES, "a0-claims-2026-10-23.partial.jsonl");
  const done = new Map<string, ClaimRec>();
  if (existsSync(partial)) for (const l of readFileSync(partial, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l) as ClaimRec; done.set(r.id, r); }
  const cfgPath = join(NOTES, "bench-a0.yaml");
  writeFileSync(cfgPath, `chunking:\n  chunk_tokens: 512\n  overlap_tokens: 0\n  chars_per_token: 2.8\n  boundary: section\nverification:\n  engine: hosted\n  min_confidence: 0.99\n  workers: 8\n  max_judgments: 100000\n`);
  const counters = { requests: 0, chars: 0 };
  const counted = countingFetch(counters);
  const env = { ...process.env, UKTUB_CHUNK_CONFIG: cfgPath, UKTUB_VERIFY_API_KEY: key } as Record<string, string>;
  const ctx = { root, fetch: counted as never, env, now: () => new Date(), queue: new WriteQueue() };
  const hooks = { fetchImpl: counted }; // product builds its own hosted engine; only the transport is counted
  const identity = await resolveEngineIdentityCached(env, "hosted", { fetchImpl: counted });
  if (identity === null) throw new Error("no engine identity (refusing to run unattributed judgments)");
  console.error(`a0 claims: identity=${identity.model} protocol=${identity.protocol} resume=${done.size}/${allClaims.length}`);
  const t0 = Date.now();
  const reg = openRegistry(root);
  for (const c of allClaims) {
    if (done.has(c.id)) continue;
    const t1 = Date.now();
    let rec: ClaimRec;
    try {
      const r = await verifyClaimTool(ctx as never, { claim: c.claim, papers: [dois.get(c.paper)!] } as VerifyClaimArgs, hooks);
      const s = r.structuredContent as Record<string, unknown> | null;
      const refused = (r.details as { refused?: { code: string; message: string } } | undefined)?.refused;
      const hashes = scoredHashes(candidates.get(c.paper)!, reg, dois.get(c.paper)!, c.claim);
      if (s === null) {
        rec = { id: c.id, paper: c.paper, label: c.label, type: c.type, fold: folds.get(c.paper)!, score: null, unjudged: hashes.length, chunks: hashes.length, supportFound: false, fresh: 0, cached: 0, wallMs: Date.now() - t1, refused: `${refused?.code}: ${refused?.message}`, pointers: [] };
      } else {
        const eng = (s as { engine: { model: string; protocol: string } }).engine;
        const judged = eng.model === null ? new Map<string, number>() : cachedJudgments(reg, c.claim, { model: eng.model, protocol: eng.protocol }, hashes);
        const sc = chunkScore(hashes, judged);
        const cov = (s as { coverage: { work: { fresh: number; cached: number } } }).coverage;
        const res = (s as { result: { supportFound: boolean }; evidence?: { pointer: string; chunkId: string; excerpt: string | null; judgment: { score: number } }[] }).result;
        const ev = (s as { evidence?: { pointer: string; chunkId: string; excerpt: string | null; judgment: { score: number } }[] }).evidence ?? [];
        rec = { id: c.id, paper: c.paper, label: c.label, type: c.type, fold: folds.get(c.paper)!, score: sc.score, unjudged: sc.unjudged, chunks: hashes.length, supportFound: res.supportFound, fresh: cov.work.fresh, cached: cov.work.cached, wallMs: Date.now() - t1, refused: null, pointers: c.label === "TRUE" && res.supportFound ? ev.map((e) => ({ pointer: e.pointer, chunkId: e.chunkId, score: e.judgment.score, excerpt: (e.excerpt ?? "").slice(0, 300) })) : [] };
      }
    } catch (e) {
      const hashes = scoredHashes(candidates.get(c.paper)!, reg, dois.get(c.paper)!, c.claim);
      rec = { id: c.id, paper: c.paper, label: c.label, type: c.type, fold: folds.get(c.paper)!, score: null, unjudged: hashes.length, chunks: hashes.length, supportFound: false, fresh: 0, cached: 0, wallMs: Date.now() - t1, refused: `threw: ${e instanceof Error ? e.message.slice(-200) : String(e).slice(-200)}`, pointers: [] };
    }
    done.set(rec.id, rec);
    appendFileSync(partial, `${JSON.stringify(rec)}\n`);
    if (done.size % 25 === 0) console.error(`${done.size}/${allClaims.length} claims, ${((Date.now() - t0) / 1000).toFixed(0)} s, ${counters.requests} req`);
  }
  reg.close();
  const records = allClaims.map((c) => done.get(c.id)!);
  const items = records.map((r) => itemOf({ id: r.id, paper: r.paper, label: r.label, type: r.type }, r.fold, r.score));
  const bar = { rates: ratesOf(items, new Map(items.map((x) => [x.id, x.score !== null && x.score >= PRODUCT_BAR]))) };
  const r1 = crossFit(items, 0.01); const r1rates = ratesOf(items, r1.supported);
  const r2 = crossFit(items, 0.02); const r2rates = ratesOf(items, r2.supported);
  const git = (...a: string[]): string => { try { return execFileSync("git", a, { encoding: "utf8" }).trim(); } catch { return "unknown"; } };
  writeFileSync(outPath, JSON.stringify({
    schema: "section-verify-ab/a0-claims/1", date: DATE, arm: "A0", engine: "hosted", model: MODEL,
    identity, commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain", "--", "src", "scripts", "benchmarks/datasets/claim-verification-v2").length > 0,
    claims: records.length,
    bar099: { true: `${bar.rates.tp}/${bar.rates.positives}`, false: `${bar.rates.fp}/${bar.rates.negatives}` },
    crossfit: { r1: r1rates.recall, r1tf: [r1rates.tp, r1rates.fp], r2: r2rates.recall, r2tf: [r2rates.tp, r2rates.fp], thresholds1: r1.thresholds, thresholds2: r2.thresholds },
    batch1: { requests: counters.requests, charsSent: counters.chars, wallS: Math.round((Date.now() - t0) / 1000) },
    unjudged: records.filter((r) => r.score === null).map((r) => r.id),
    refused: records.filter((r) => r.refused !== null).map((r) => ({ id: r.id, refused: r.refused })),
    records,
  }, null, 1));
  console.error(`a0 claims done: bar099 T ${bar.rates.tp}/${bar.rates.positives} F ${bar.rates.fp}/${bar.rates.negatives}; r1 ${r1rates.recall} r2 ${r2rates.recall}; ${counters.requests} req`);
}

const DOC_ITERS = ["01", "02", "03", "04", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15", "17", "18", "19", "20"];

async function phaseDocs(): Promise<void> {
  const key = hostedKey();
  const only = arg("notes", "");
  const iters = (only === "" ? DOC_ITERS : only.split(",")).filter((x) => DOC_ITERS.includes(x));
  const cfgPath = join(NOTES, "bench-docs-a0.yaml");
  writeFileSync(cfgPath, `chunking:\n  chunk_tokens: 512\n  overlap_tokens: 0\n  chars_per_token: 2.8\n  boundary: section\nverification:\n  engine: hosted\n  min_confidence: 0.99\n  workers: 8\n  max_judgments: 100000\n`);
  const counters = { requests: 0, chars: 0 };
  const counted = countingFetch(counters);
  const env = { ...process.env, UKTUB_CHUNK_CONFIG: cfgPath, UKTUB_VERIFY_API_KEY: key } as Record<string, string>;
  const hooks = { fetchImpl: counted };
  const outPath = join(NOTES, "a0-docs-2026-10-23.json");
  const partial = join(NOTES, "a0-docs-2026-10-23.partial.jsonl");
  const done = new Map<string, unknown>();
  if (existsSync(partial)) for (const l of readFileSync(partial, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l) as { iter: string }; done.set(r.iter, r); }
  const t0 = Date.now();
  for (const iter of iters) {
    if (done.has(iter)) continue;
    const src = `/home/mahmoud/.cache/uktub-bench/wording/work/ab-docs-v0-iter-${iter}`;
    const root = join(NOTES, `docs-a0-iter-${iter}`);
    if (!existsSync(join(root, ".registry", "registry.db"))) {
      rmSync(root, { recursive: true, force: true });
      cpSync(src, root, { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(root, ".registry", "registry.db"));
      for (const t of ["claim_judgments", "verify_runs", "claim_evidence", "claim_ledger"]) db.prepare(`DELETE FROM ${t}`).run();
      db.close();
    }
    const ctx = { root, fetch: counted as never, env, now: () => new Date(), queue: new WriteQueue() };
    const t1 = Date.now();
    const units: unknown[] = [];
    let offset: number | undefined = undefined; let pages = 0; let refused: unknown = null;
    const httpBefore = counters.requests; const charsBefore = counters.chars;
    for (;;) {
      const r = await verifyClaimTool(ctx as never, { document: "manuscript/main.tex", ...(offset !== undefined ? { offset } : {}) }, hooks);
      if (r.structuredContent === null) { refused = (r.details as { refused?: unknown } | undefined)?.refused ?? r.details; break; }
      const s = r.structuredContent as { units: unknown[]; next?: number | null };
      units.push(...s.units);
      pages += 1;
      if (s.next === null || s.next === undefined) break;
      offset = s.next;
    }
    const rec = { iter, units: units.length, pages, requests: counters.requests - httpBefore, chars: counters.chars - charsBefore, wallMs: Date.now() - t1, refused, unitOutcomes: units };
    done.set(iter, rec);
    appendFileSync(partial, `${JSON.stringify({ iter, units: (rec as { units: number }).units, pages, requests: (rec as { requests: number }).requests, wallMs: (rec as { wallMs: number }).wallMs, refused })}\n`);
    console.error(`docs a0 iter-${iter}: ${units.length} units, ${(rec as { requests: number }).requests} req, ${(((Date.now() - t0) / 1000) / 60).toFixed(1)} min elapsed`);
  }
  const notes = iters.map((i) => done.get(i)!);
  writeFileSync(outPath, JSON.stringify({
    schema: "section-verify-ab/a0-docs/1", date: DATE, arm: "A0", engine: "hosted", model: MODEL,
    identity: await resolveEngineIdentityCached(env, "hosted", { fetchImpl: counted }),
    notes, requests: counters.requests, charsSent: counters.chars, wallS: Math.round((Date.now() - t0) / 1000),
  }, null, 1));
  console.error(`docs a0 done: ${notes.length} notes, ${counters.requests} req`);
}

const phase = arg("phase", "ladder");
if (phase === "ladder") await phaseLadder();
else if (phase === "claims") await phaseClaims();
else if (phase === "docs") await phaseDocs();
else throw new Error(`unknown phase ${phase}`);
console.error("src/ web/ skills/ config/ status (must be clean of product edits):");
console.error(execFileSync("git", ["status", "--porcelain", "--", "src", "web", "skills", "config"]).toString() || "(clean)");
