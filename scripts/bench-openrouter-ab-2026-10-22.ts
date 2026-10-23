/**
 * Pre-registered A/B: `openrouter` engine (paid `inception/mercury-decide`) exhaustive vs top-10,
 * plus the cross-claim batching probe and document mode.
 *
 * Pre-registration: `docs/benchmarks/openrouter-mercury-verify-ab-2026-10-22.json` (design block
 * written BEFORE any mercury-decide request). Worker brief: `TASK.md` in
 * `~/.cache/uktub-bench/hermes-ab-openrouter-verify-2026-10-22/`.
 *
 * - Arm E (claims): product `verifyClaimTool` per claim scoped to its own paper, config engine
 *   `openrouter` (strategy gate -> exhaustive), injected product `openrouterDecisionsEngine`.
 * - Arm T (claims + docs): identical harness code, config engine `hosted` (selects the REAL
 *   product top10 gate `narrowCandidates`) with the SAME engine injected via `hooks.createEngine`
 *   and identity `declared:openrouter:inception/mercury-decide` via the product's own
 *   `UKTUB_VERIFY_MODEL_ID` seam (a true assertion: these weights answer). No hosted key is used.
 * - Batching probe: direct endpoint POSTs, never cached, never through product code.
 * - The key comes from `OPENROUTER_API_KEY` (shell) or the repo `.env`; it is never printed,
 *   logged or stored.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEFAULTS } from "../src/core/config.ts";
import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry, openRegistry, registerPaper } from "../src/core/registry.ts";
import { extractPdf } from "../src/core/source/extract.ts";
import { verifyClaimTool } from "../src/core/tools/verify.ts";
import type { VerifyClaimArgs } from "../src/core/tools/verify.ts";
import { selectCandidates, lexicalRank, locatorTokens, type Candidate } from "../src/core/verify/retrieve.ts";
import { TOP_K, topCandidates } from "../src/core/verify/strategy.ts";
import { cachedJudgments } from "../src/core/verify/store.ts";
import { openrouterDecisionsEngine, fetchWith429Retry } from "../src/core/verify/claim.ts";
import { resolveEngineIdentityCached, SYSTEMONE_PROTOCOL } from "../src/core/verify/engines.ts";
import { criteriaQuestion } from "../src/core/verify/wording.ts";
import { chunkScore, itemOf, PRODUCT_BAR } from "./bench-claims-v2-score.ts";
import { crossFit, ratesOf } from "./bench-claims-v2-metrics.ts";

/** Paid decision model under test (NOT the `:free` default). */
const MODEL = "inception/mercury-decide";
const MODEL_ID = `openrouter:${MODEL}`;
const DATE = "2026-10-22";
const NOTES = "/home/mahmoud/.cache/uktub-bench/hermes-ab-openrouter-verify-2026-10-22";
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] as string) : fallback;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const dotenvValue = (text: string, name: string): string | null => {
  const m = new RegExp(`^(?:export\\s+)?${name}\\s*=\\s*(.*)$`, "m").exec(text);
  if (m === null) return null;
  const value = m[1]!.trim().replace(/^(['"])(.*)\1$/, "$2");
  return value === "" ? null : value;
};

const openrouterKey = (): string => {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const envFile = existsSync(".env") ? readFileSync(".env", "utf8") : "";
  const fromFile = dotenvValue(envFile, "OPENROUTER_API_KEY");
  if (!fromFile) throw new Error("OPENROUTER_API_KEY is not set (neither shell nor .env)");
  return fromFile;
};

export async function keyUsage(key: string): Promise<{ usage: number | null; limit_remaining: number | null }> {
  const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}` } });
  const j = (await res.json()) as { data?: { usage?: number; limit_remaining?: number } };
  return { usage: j.data?.usage ?? null, limit_remaining: j.data?.limit_remaining ?? null };
}

/** Counting transport for the decisions engine: requests + body bytes, key never logged. */
const countingFetch = (counters: { requests: number; chars: number }): typeof fetch =>
  (async (input: unknown, init?: unknown) => {
    const url = String(typeof input === "string" ? input : (input as { url: string }).url);
    if (url.includes("/api/alpha/decisions") && (init as { method?: string } | undefined)?.method === "POST") {
      counters.requests += 1;
      counters.chars += Buffer.byteLength(String((init as { body?: unknown }).body ?? ""), "utf8");
    }
    return fetch(input as never, init as never);
  }) as typeof fetch;

interface ClaimRec {
  id: string; paper: string; label: "TRUE" | "FALSE"; type: string; fold: number;
  score: number | null; unjudged: number; chunks: number; supportFound: boolean;
  fresh: number; cached: number; wallMs: number; refused: string | null;
}

const sha256short = (s: string): string => {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 0x01000193) >>> 0; }
  return h1.toString(16).padStart(8, "0");
};

async function buildClaimsRoot(): Promise<{ root: string; dois: Map<string, string>; folds: Map<string, number>; chunkHashes: Map<string, string[]>; chunkText: Map<string, string>; candidates: Map<string, Candidate[]> }> {
  const datasetDir = "benchmarks/datasets/claim-verification-v2";
  const pdfDir = arg("pdf-dir", join(homedir(), ".cache/uktub-bench/v2-corpus/pdf"));
  const corpus = (JSON.parse(readFileSync(join(datasetDir, "corpus.json"), "utf8")) as { papers: { id: string; fold: number; sha256: string }[] }).papers;
  const root = join(NOTES, "claims-registry");
  if (!existsSync(join(root, ".registry", "registry.db"))) {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const db = createRegistry(root);
    const crypto = await import("node:crypto");
    const dois = new Map<string, string>();
    const cfg = DEFAULTS.chunking;
    [...corpus].sort((a, b) => (a.id < b.id ? -1 : 1)).forEach((p, i) => {
      const bytes = new Uint8Array(readFileSync(join(pdfDir, `${p.id}.pdf`)));
      const digest = crypto.createHash("sha256").update(bytes).digest("hex");
      if (digest !== p.sha256) throw new Error(`${p.id}: PDF sha mismatch`);
      const doi = `10.9999/v2-${String(i + 1).padStart(3, "0")}`;
      dois.set(p.id, doi);
      registerPaper(db, { doi, title: p.id, authors: [], year: 2026 });
    });
    // Publish serially (extraction is CPU-bound); registry writes through the one db handle.
    for (const p of [...corpus].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const bytes = new Uint8Array(readFileSync(join(pdfDir, `${p.id}.pdf`)));
      const crypto2 = await import("node:crypto");
      const x = await extractPdf(bytes);
      const { publishSource } = await import("../src/core/verify/store.ts");
      publishSource(db, dois.get(p.id)!, { kind: "local-file", ref: "bench.pdf", license: null, digest: crypto2.createHash("sha256").update(bytes).digest("hex"), extraction: x.extraction, text: x.text, pageStarts: x.pageStarts, sections: x.sections }, cfg, new Date());
    }
    db.close();
  }
  const reg = openRegistry(root);
  const dois = new Map<string, string>();
  const folds = new Map<string, number>();
  [...corpus].sort((a, b) => (a.id < b.id ? -1 : 1)).forEach((p, i) => {
    dois.set(p.id, `10.9999/v2-${String(i + 1).padStart(3, "0")}`);
    folds.set(p.id, p.fold);
  });
  const chunkHashes = new Map<string, string[]>();
  const chunkText = new Map<string, string>();
  const candidates = new Map<string, Candidate[]>();
  for (const p of corpus) {
    const cands = selectCandidates(reg, [dois.get(p.id)!], null)[0]?.candidates ?? [];
    candidates.set(p.id, cands);
    chunkHashes.set(p.id, cands.map((c) => c.hash));
    for (const c of cands) chunkText.set(c.hash, c.text);
  }
  reg.close();
  return { root, dois, folds, chunkHashes, chunkText, candidates };
}

/**
 * The product's scored candidate set per arm (mirrors workflow
 * `narrowCandidates`: a claim with no searchable words falls back to
 * exhaustive; the top10 strategy otherwise judges lexicalRank top-K).
 * FIX 2026-10-22: Arm T was scored over every chunk (always unjudged);
 * the scored set is the top-10 candidates the product actually judged.
 */
function scoredHashes(all: Candidate[], db: { prepare: Function } | unknown, doi: string, claim: string, arm: "E" | "T"): string[] {
  if (arm === "E") return all.map((c) => c.hash);
  if (locatorTokens(claim).length === 0) return all.map((c) => c.hash);
  const ranked = lexicalRank(db as never, [doi], claim, TOP_K);
  return topCandidates(all, ranked.map((r) => r.chunkId)).map((c) => c.hash);
}

async function runClaims(arm: "E" | "T"): Promise<void> {
  const key = openrouterKey();
  const { root, dois, folds, candidates } = await buildClaimsRoot();
  const datasetDir = "benchmarks/datasets/claim-verification-v2";
  const allClaims = (JSON.parse(readFileSync(join(datasetDir, "claims.json"), "utf8")) as { claims: { id: string; paper: string; claim: string; label: "TRUE" | "FALSE"; type: string }[] }).claims;
  const smoke = flag("smoke");
  const claims = smoke ? allClaims.slice(0, 2) : allClaims;
  const outPath = join(NOTES, `claims-arm${arm}-2026-10-22${smoke ? "-smoke" : ""}.json`);
  const partial = join(NOTES, `claims-arm${arm}-2026-10-22.partial.jsonl`);
  const done = new Map<string, ClaimRec>();
  if (!smoke && existsSync(partial)) for (const l of readFileSync(partial, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l) as ClaimRec; done.set(r.id, r); }

  const cfgPath = join(NOTES, `bench-arm${arm}.yaml`);
  const engineName = arm === "E" ? "openrouter" : "hosted";
  writeFileSync(cfgPath, `chunking:\n  chunk_tokens: 512\n  overlap_tokens: 0\n  chars_per_token: 2.8\n  boundary: section\nverification:\n  engine: ${engineName}\n  min_confidence: 0.99\n  workers: 8\n  max_judgments: 100000\n`);
  const counters = { requests: 0, chars: 0 };
  const counted = countingFetch(counters);
  const env = {
    ...process.env, UKTUB_CHUNK_CONFIG: cfgPath, OPENROUTER_API_KEY: key, UKTUB_OPENROUTER_MODEL: MODEL,
    ...(arm === "T" ? { UKTUB_VERIFY_MODEL_ID: MODEL_ID } : {}),
  } as Record<string, string>;
  const ctx = { root, fetch: counted as never, env, now: () => new Date(), queue: new WriteQueue() };
  const hooks = { createEngine: () => openrouterDecisionsEngine({ env, model: MODEL, fetchImpl: counted }), fetchImpl: counted };
  const identity = await resolveEngineIdentityCached(env, engineName, { fetchImpl: counted });
  if (identity === null) throw new Error("no engine identity (refusing to run unattributed judgments)");
  console.error(`arm ${arm}: identity=${identity.model} protocol=${identity.protocol} resume=${done.size}/${claims.length}`);

  const t0 = Date.now();
  const reg = openRegistry(root);
  for (const c of claims) {
    if (done.has(c.id)) continue;
    const t1 = Date.now();
    let rec: ClaimRec;
    try {
      const r = await verifyClaimTool(ctx as never, { claim: c.claim, papers: [dois.get(c.paper)!] } as VerifyClaimArgs, hooks);
      const s = r.structuredContent as Record<string, unknown> | null;
      const refused = (r.details as { refused?: { code: string; message: string } } | undefined)?.refused;
      if (s === null) {
        const hashes = scoredHashes(candidates.get(c.paper)!, reg, dois.get(c.paper)!, c.claim, arm);
        rec = { id: c.id, paper: c.paper, label: c.label, type: c.type, fold: folds.get(c.paper)!, score: null, unjudged: hashes.length, chunks: hashes.length, supportFound: false, fresh: 0, cached: 0, wallMs: Date.now() - t1, refused: `${refused?.code}: ${refused?.message}` };
      } else {
        const eng = (s as { engine: { model: string; protocol: string } }).engine;
        const hashes = scoredHashes(candidates.get(c.paper)!, reg, dois.get(c.paper)!, c.claim, arm);
        const judged = eng.model === null ? new Map<string, number>() : cachedJudgments(reg, c.claim, { model: eng.model, protocol: eng.protocol }, hashes);
        const sc = chunkScore(hashes, judged);
        const cov = (s as { coverage: { work: { fresh: number; cached: number } } }).coverage;
        const res = (s as { result: { supportFound: boolean } }).result;
        rec = { id: c.id, paper: c.paper, label: c.label, type: c.type, fold: folds.get(c.paper)!, score: sc.score, unjudged: sc.unjudged, chunks: hashes.length, supportFound: res.supportFound, fresh: cov.work.fresh, cached: cov.work.cached, wallMs: Date.now() - t1, refused: null };
      }
    } catch (e) {
      const hashes = scoredHashes(candidates.get(c.paper)!, reg, dois.get(c.paper)!, c.claim, arm);
      rec = { id: c.id, paper: c.paper, label: c.label, type: c.type, fold: folds.get(c.paper)!, score: null, unjudged: hashes.length, chunks: hashes.length, supportFound: false, fresh: 0, cached: 0, wallMs: Date.now() - t1, refused: `threw: ${e instanceof Error ? e.message.slice(-200) : String(e).slice(-200)}` };
    }
    done.set(rec.id, rec);
    if (!smoke) appendFileSync(partial, `${JSON.stringify(rec)}\n`);
    if (done.size % 10 === 0) console.error(`${done.size}/${claims.length} claims, ${((Date.now() - t0) / 1000).toFixed(0)} s, ${counters.requests} req`);
  }
  reg.close();
  const records = claims.map((c) => done.get(c.id)!);
  const items = records.map((r) => itemOf({ id: r.id, paper: r.paper, label: r.label, type: r.type }, r.fold, r.score));
  const bar = { rates: ratesOf(items, new Map(items.map((x) => [x.id, x.score !== null && x.score >= PRODUCT_BAR]))) };
  const r1 = crossFit(items, 0.01); const r1rates = ratesOf(items, r1.supported);
  const r2 = crossFit(items, 0.02); const r2rates = ratesOf(items, r2.supported);
  const summary = {
    schema: "openrouter-mercury-verify-ab/claims-arm/1", date: DATE, arm, identity, engine: MODEL,
    claims: records.length,
    bar099: { true: `${bar.rates.tp}/${bar.rates.positives}`, false: `${bar.rates.fp}/${bar.rates.negatives}` },
    crossfit: { r1: r1rates.recall, r1tf: [r1rates.tp, r1rates.fp], r2: r2rates.recall, r2tf: [r2rates.tp, r2rates.fp], thresholds1: r1.thresholds, thresholds2: r2.thresholds },
    batch1: { requests: counters.requests, charsSent: counters.chars, wallS: Math.round((Date.now() - t0) / 1000) },
    refused: records.filter((r) => r.refused !== null).map((r) => ({ id: r.id, refused: r.refused })),
    keyAfter: await keyUsage(key),
  };
  writeFileSync(outPath, JSON.stringify({ summary, records }, null, 1));
  console.error(`arm ${arm} done: bar099 T ${summary.bar099.true} F ${summary.bar099.false}; r1 ${r1rates.recall} r2 ${r2rates.recall}; ${counters.requests} req`);

  // Pair-level scores for the batching probe (Arm T only): hash -> pTrue per claim.
  if (arm === "T" && !smoke) {
    const reg2 = openRegistry(root);
    const out = join(NOTES, "pairs-armT-2026-10-22.jsonl");
    if (!existsSync(out)) {
      for (const c of claims) {
        const judged = cachedJudgments(reg2, c.claim, identity, candidates.get(c.paper)!.map((x) => x.hash));
        appendFileSync(out, `${JSON.stringify({ id: c.id, claim: c.claim, pairs: [...judged].map(([h, p]) => ({ h, p })) })}\n`);
      }
    }
    const texts: Record<string, string> = {};
    const { chunkText } = await buildClaimsRoot();
    for (const [h, t] of chunkText) texts[h] = t;
    writeFileSync(join(NOTES, "pair-states-2026-10-22.json"), JSON.stringify(texts));
    reg2.close();
  }
}

async function runProbe(): Promise<void> {
  const key = openrouterKey();
  const pairs: { id: string; claim: string; pairs: { h: string; p: number }[] }[] = readFileSync(join(NOTES, "pairs-armT-2026-10-22.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const states = JSON.parse(readFileSync(join(NOTES, "pair-states-2026-10-22.json"), "utf8")) as Record<string, string>;
  // Group (claim, hash) pairs by identical state text.
  const byState = new Map<string, { claim: string; id: string; h: string; p: number }[]>();
  for (const row of pairs) for (const pr of row.pairs) {
    const st = states[pr.h];
    if (st === undefined) continue;
    const k = sha256short(st);
    if (!byState.has(k)) byState.set(k, []);
    byState.get(k)!.push({ claim: row.claim, id: row.id, h: pr.h, p: pr.p });
  }
  const groups = [...byState].map(([k, rows]) => ({ key: k, state: states[rows[0]!.h]!, rows }));
  const multi = groups.filter((g) => g.rows.length > 1);
  console.error(`probe: ${pairs.reduce((n, r) => n + r.pairs.length, 0)} pairs, ${groups.length} distinct states, ${multi.length} multi-claim states`);

  // FIX 2026-10-22: bounded retry on transient 5xx/network errors (first full
  // run died at 1150/2152 groups on a single HTTP 502; that run's spend is
  // discarded and the probe reruns from scratch). Non-2xx non-5xx still fails
  // fast, exactly as before.
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const post = async (state: string, qs: Record<string, unknown>): Promise<Record<string, number>> => {
    let lastErr: unknown = null;
    for (let a = 0; a < 4; a++) {
      try {
        const send = (): Promise<Response> => fetch(DECISIONS_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model: MODEL, state, questions: qs }),
        });
        const res = await fetchWith429Retry(send, { label: `openrouter probe (${MODEL})`, farResetAfterMs: 90_000, signal: undefined });
        if (!res.ok) {
          if (res.status >= 500 && res.status < 600 && a < 3) { await res.body?.cancel().catch(() => undefined); await sleep(2000 * (a + 1)); continue; }
          throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(-300)}`);
        }
        const parsed = (await res.json()) as { answers?: Record<string, { noul?: number }> };
        const out: Record<string, number> = {};
        for (const k of Object.keys(qs)) {
          const v = parsed.answers?.[k]?.noul;
          if (typeof v !== "number") throw new Error(`response missing answers.${k}.noul`);
          out[k] = v;
        }
        return out;
      } catch (e) {
        lastErr = e;
        if (a < 3 && (e instanceof TypeError || /HTTP 50[23]/.test(e instanceof Error ? e.message : String(e)))) { await sleep(2000 * (a + 1)); continue; }
        throw e;
      }
    }
    throw lastErr;
  };

  // Pre-test: one 2-question request.
  const pre = multi.find((g) => g.rows.length >= 2)!;
  const preQs = { c1: criteriaQuestion(pre.rows[0]!.claim, "criteria"), c2: criteriaQuestion(pre.rows[1]!.claim, "criteria") };
  let preResult: string;
  try {
    const ans = await post(pre.state, preQs);
    preResult = `ok: ${JSON.stringify(ans)}`;
  } catch (e) {
    preResult = `REJECTED: ${e instanceof Error ? e.message : String(e)}`;
  }
  console.error(`pretest: ${preResult}`);
  const outPath = join(NOTES, "batching-probe-2026-10-22.json");
  if (preResult.startsWith("REJECTED")) {
    writeFileSync(outPath, JSON.stringify({ schema: "openrouter-mercury-verify-ab/probe/1", date: DATE, pretest: preResult, note: "endpoint rejects multi-question requests; probe stopped per pre-registration", keyAfter: await keyUsage(key) }, null, 1));
    return;
  }
  // Full probe: ≤8 questions per request, concurrency 8.
  const reqs: { state: string; keys: string[]; qs: Record<string, unknown>; ref: { id: string; h: string; p: number }[] }[] = [];
  for (const g of groups) {
    for (let i = 0; i < g.rows.length; i += 8) {
      const slice = g.rows.slice(i, i + 8);
      const qs: Record<string, unknown> = {};
      slice.forEach((r, j) => { qs[`c${j + 1}`] = criteriaQuestion(r.claim, "criteria"); });
      reqs.push({ state: g.state, keys: slice.map((_, j) => `c${j + 1}`), qs, ref: slice });
    }
  }
  const t0 = Date.now();
  let done = 0; let http = 0;
  const diffs: number[] = []; let flips = 0; const flipRows: { id: string; h: string; batch1: number; batched: number }[] = [];
  const worker = async (queue: typeof reqs): Promise<void> => {
    while (queue.length > 0) {
      const r = queue.pop()!;
      const ans = await post(r.state, r.qs);
      http += 1;
      r.ref.forEach((f, j) => {
        const q = ans[`c${j + 1}`]!;
        diffs.push(Math.abs(q - f.p));
        const flip = (q >= PRODUCT_BAR) !== (f.p >= PRODUCT_BAR);
        if (flip) { flips += 1; flipRows.push({ id: f.id, h: f.h, batch1: f.p, batched: q }); }
      });
      done += 1;
      if (done % 50 === 0) console.error(`probe ${done}/${reqs.length} req-groups, ${http} http`);
    }
  };
  const queue = [...reqs];
  await Promise.all(Array.from({ length: 8 }, () => worker(queue)));
  const max = Math.max(...diffs); const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const totalPairs = reqs.reduce((n, r) => n + r.ref.length, 0);
  writeFileSync(outPath, JSON.stringify({
    schema: "openrouter-mercury-verify-ab/probe/1", date: DATE, pretest: preResult,
    pairs: totalPairs, requests: http, savedVsBatch1: totalPairs - http, wallS: Math.round((Date.now() - t0) / 1000),
    drift: { n: diffs.length, max, mean }, flips, flipRows: flipRows.slice(0, 50),
    keyAfter: await keyUsage(key),
  }, null, 1));
  console.error(`probe done: n=${diffs.length} max=${max} mean=${mean} flips=${flips} req=${http} (batch1 would be ${totalPairs})`);
}

const DOC_ITERS = ["01", "02", "03", "04", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15", "17", "18", "19", "20"];

async function runDocs(arm: "E" | "T"): Promise<void> {
  const key = openrouterKey();
  const only = arg("notes", arm === "E" ? "01,02,03,04,06,07" : "");
  const iters = (only === "" ? DOC_ITERS : only.split(",")).filter((x) => DOC_ITERS.includes(x));
  const engineName = arm === "E" ? "openrouter" : "hosted";
  const cfgPath = join(NOTES, `bench-docs-arm${arm}.yaml`);
  writeFileSync(cfgPath, `chunking:\n  chunk_tokens: 512\n  overlap_tokens: 0\n  chars_per_token: 2.8\n  boundary: section\nverification:\n  engine: ${engineName}\n  min_confidence: 0.99\n  workers: 8\n  max_judgments: 100000\n`);
  const counters = { requests: 0, chars: 0 };
  const counted = countingFetch(counters);
  const env = {
    ...process.env, UKTUB_CHUNK_CONFIG: cfgPath, OPENROUTER_API_KEY: key, UKTUB_OPENROUTER_MODEL: MODEL,
    ...(arm === "T" ? { UKTUB_VERIFY_MODEL_ID: MODEL_ID } : {}),
  } as Record<string, string>;
  const hooks = { createEngine: () => openrouterDecisionsEngine({ env, model: MODEL, fetchImpl: counted }), fetchImpl: counted };
  const outPath = join(NOTES, `docs-arm${arm}-2026-10-22.json`);
  const partial = join(NOTES, `docs-arm${arm}-2026-10-22.partial.jsonl`);
  const done = new Map<string, unknown>();
  if (existsSync(partial)) for (const l of readFileSync(partial, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l) as { iter: string }; done.set(r.iter, r); }
  const t0 = Date.now();
  for (const iter of iters) {
    if (done.has(iter)) continue;
    const src = `/home/mahmoud/.cache/uktub-bench/wording/work/ab-docs-v0-iter-${iter}`;
    const root = join(NOTES, `docs-arm${arm}-iter-${iter}`);
    if (!existsSync(join(root, ".registry", "registry.db"))) {
      rmSync(root, { recursive: true, force: true });
      cpSync(src, root, { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(root, ".registry", "registry.db"));
      for (const t of ["claim_judgments", "verify_runs", "claim_evidence", "claim_ledger"]) db.prepare(`DELETE FROM ${t}`).run();
      // Fresh-request accounting: the product cache would reuse the 2026-10-15 d3-mini
      // judgments only under the hosted identity, which this run never uses. Wiped anyway.
      db.close();
    }
    const ctx = { root, fetch: counted as never, env, now: () => new Date(), queue: new WriteQueue() };
    const t1 = Date.now();
    const units: unknown[] = [];
    let offset: number | undefined = undefined; let pages = 0; let refused: unknown = null;
    const httpBefore = counters.requests;
    for (;;) {
      const r = await verifyClaimTool(ctx as never, { document: "manuscript/main.tex", ...(offset !== undefined ? { offset } : {}) }, hooks);
      if (r.structuredContent === null) { refused = (r.details as { refused?: unknown } | undefined)?.refused ?? r.details; break; }
      const s = r.structuredContent as { units: unknown[]; next?: number | null };
      units.push(...s.units);
      pages += 1;
      if (s.next === null || s.next === undefined) break;
      offset = s.next;
    }
    const rec = { iter, units: units.length, pages, requests: counters.requests - httpBefore, wallMs: Date.now() - t1, refused, unitOutcomes: units };
    done.set(iter, rec);
    appendFileSync(partial, `${JSON.stringify({ iter, units: units.length, pages, requests: (rec as { requests: number }).requests, wallMs: (rec as { wallMs: number }).wallMs, refused })}\n`);
    console.error(`docs arm ${arm} iter-${iter}: ${units.length} units, ${(rec as { requests: number }).requests} req, ${(((Date.now() - t0) / 1000) / 60).toFixed(1)} min elapsed`);
  }
  const notes = iters.map((i) => done.get(i)!);
  writeFileSync(outPath, JSON.stringify({
    schema: "openrouter-mercury-verify-ab/docs-arm/1", date: DATE, arm,
    engine: MODEL, identity: await resolveEngineIdentityCached(env, engineName, { fetchImpl: counted }),
    notes, requests: counters.requests, charsSent: counters.chars, wallS: Math.round((Date.now() - t0) / 1000),
    keyAfter: await keyUsage(key),
  }, null, 1));
  console.error(`docs arm ${arm} done: ${notes.length} notes, ${counters.requests} req`);
}

/**
 * FIX 2026-10-22 rescore: recompute Arm T claim scores over the product's
 * real top-10 candidate set (scoredHashes) from the judgments already cached
 * in the registry. No HTTP, no key needed. Preserves the original batch1
 * counters and keyAfter from the run being rescored. Rewrites both the
 * partial jsonl and the final JSON.
 */
async function runRescore(arm: "E" | "T"): Promise<void> {
  const { root, dois, folds, candidates } = await buildClaimsRoot();
  const datasetDir = "benchmarks/datasets/claim-verification-v2";
  const allClaims = (JSON.parse(readFileSync(join(datasetDir, "claims.json"), "utf8")) as { claims: { id: string; paper: string; claim: string; label: "TRUE" | "FALSE"; type: string }[] }).claims;
  const byId = new Map(allClaims.map((c) => [c.id, c]));
  const partial = join(NOTES, `claims-arm${arm}-2026-10-22.partial.jsonl`);
  const prev = JSON.parse(readFileSync(join(NOTES, `claims-arm${arm}-2026-10-22.json`), "utf8")) as { summary: Record<string, unknown>; records: ClaimRec[] };
  const reg = openRegistry(root);
  const identity = prev.summary.identity as { model: string; protocol: string };
  const records: ClaimRec[] = prev.records.map((r) => {
    const c = byId.get(r.id)!;
    const hashes = scoredHashes(candidates.get(c.paper)!, reg, dois.get(c.paper)!, c.claim, arm);
    if (r.refused !== null) return { ...r, score: null, unjudged: hashes.length, chunks: hashes.length };
    const judged = cachedJudgments(reg, c.claim, identity, hashes);
    const sc = chunkScore(hashes, judged);
    return { ...r, score: sc.score, unjudged: sc.unjudged, chunks: hashes.length };
  });
  reg.close();
  const items = records.map((r) => itemOf({ id: r.id, paper: r.paper, label: r.label, type: r.type }, r.fold, r.score));
  const bar = { rates: ratesOf(items, new Map(items.map((x) => [x.id, x.score !== null && x.score >= PRODUCT_BAR]))) };
  const r1 = crossFit(items, 0.01); const r1rates = ratesOf(items, r1.supported);
  const r2 = crossFit(items, 0.02); const r2rates = ratesOf(items, r2.supported);
  const summary = {
    ...(prev.summary as object),
    bar099: { true: `${bar.rates.tp}/${bar.rates.positives}`, false: `${bar.rates.fp}/${bar.rates.negatives}` },
    crossfit: { r1: r1rates.recall, r1tf: [r1rates.tp, r1rates.fp], r2: r2rates.recall, r2tf: [r2rates.tp, r2rates.fp], thresholds1: r1.thresholds, thresholds2: r2.thresholds },
    rescored: "2026-10-22 FIX: scores recomputed over the product top-10 candidate set (was: every chunk); batch1/keyAfter preserved from the original run",
  };
  writeFileSync(join(NOTES, `claims-arm${arm}-2026-10-22.json`), JSON.stringify({ summary, records }, null, 1));
  writeFileSync(partial, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.error(`rescore arm ${arm} done: bar099 T ${bar.rates.tp}/${bar.rates.positives} F ${bar.rates.fp}/${bar.rates.negatives}; r1 ${r1rates.recall} r2 ${r2rates.recall}`);
}

const phase = arg("phase", "claims");
const arm = arg("arm", "E") as "E" | "T";
if (phase === "claims") await runClaims(arm);
else if (phase === "docs") await runDocs(arm);
else if (phase === "probe") await runProbe();
else if (phase === "rescore") await runRescore(arm);
else throw new Error(`unknown phase ${phase}`);
console.error("src/ web/ skills/ config/ status (must be clean of product edits):");
console.error(execFileSync("git", ["status", "--porcelain", "--", "src", "web", "skills", "config"]).toString() || "(clean)");
