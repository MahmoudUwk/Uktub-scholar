/**
 * Passage-search experiment (roadmap step 3; docs/benchmarks): does the vector leg earn its place beside
 * BM25? Gold passage recall@k for the lexical ranking, the vector ranking and their RRF fusion, through
 * the package's own `searchPassages` path (section chunks, FTS5, stored vectors), with a real local
 * embedding server behind the OpenAI-compatible client.
 *
 *   node scripts/bench-rag.ts --embed-url http://127.0.0.1:8124 --embed-model <id> --out <dir>
 *        [--chunk-tokens 512] [--boundary section] [--profile embeddinggemma]
 *        [--queries <json of {id, paraphrase, question}>] [--query-fields claim,paraphrase,question]
 *
 * Queries are the TRUE claims of `claim-verification-v1` (the same gold quotes as the evidence runs), as the
 * claim text itself (lexically anchored to the source) and, with --queries, as independent paraphrases and
 * questions written without seeing the papers (vocabulary mismatch: where BM25 is weakest).
 * A hit counts when a returned passage overlaps the located gold span. Two scopes: the claim's own
 * paper (can the passage be found) and all papers (can it be found among distractors). Paper bodies
 * stay local; artifacts hold counts and spans only.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EMBED_PROFILES, createHttpEmbedder } from "../src/core/embed/embedder.ts";
import { ensureVectors, rankByVector } from "../src/core/embed/vectors.ts";
import { rrfFuse, searchPassages } from "../src/core/rag/search.ts";
import { createRegistry, openRegistry, registerPaper } from "../src/core/registry.ts";
import { extractPdf } from "../src/core/source/extract.ts";
import { lexicalRank } from "../src/core/verify/retrieve.ts";
import { publishSource } from "../src/core/verify/store.ts";
import type { ChunkTextConfig } from "../src/core/chunk.ts";
import { locateQuote, overlapChars, type Span } from "./bench-evidence-metrics.ts";

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
};
const datasetDir = arg("dataset", "benchmarks/datasets/claim-verification-v1")!;
const pdfRoot = arg("pdf-root", "test_papers")!;
const outDir = arg("out", "docs/benchmarks")!;
const date = arg("date", new Date().toISOString().slice(0, 10))!;
const chunkTokens = Number(arg("chunk-tokens", "512"));
const boundary = arg("boundary", "section") as ChunkTextConfig["boundary"];
const embedUrl = arg("embed-url", "http://127.0.0.1:8124")!;
const embedModel = arg("embed-model", "embeddinggemma-2-q4_k_xl")!;
const profile = EMBED_PROFILES[(arg("profile", "embeddinggemma") as keyof typeof EMBED_PROFILES)];
const label = arg("label", `${boundary}-${chunkTokens}`)!;
const queryFields = (arg("query-fields", "claim") as string).split(",");
const extraQueries = new Map<string, Record<string, string>>(
  arg("queries") === undefined ? [] : (JSON.parse(readFileSync(arg("queries")!, "utf8")) as { id: string }[]).map((q) => [q.id, q as unknown as Record<string, string>]),
);

interface Claim { id: string; paper: string; claim: string; label: "TRUE" | "FALSE"; evidence: string }
const claims: Claim[] = (JSON.parse(readFileSync(join(datasetDir, "claims.json"), "utf8")).claims as Claim[]).filter((c) => c.label === "TRUE");
const paperIds = [...new Set(claims.map((c) => c.paper))].sort();
const split = (id: string): "tuning" | "held-out" => (paperIds.indexOf(id) % 2 === 0 ? "tuning" : "held-out");

function pdfFor(id: string): string {
  for (const d of readdirSync(pdfRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(pdfRoot, d.name))) if (f.endsWith(".pdf") && f.slice(0, -4).startsWith(id.slice(0, 38))) return join(pdfRoot, d.name, f);
  }
  throw new Error(`no PDF for ${id}`);
}

const cfg: ChunkTextConfig = { chunk_tokens: chunkTokens, overlap_tokens: boundary === "section" ? 0 : Math.round(chunkTokens / 64), chars_per_token: 2.8, boundary };
const KS = [1, 3, 5, 10];
const POOL = 50;

const root = mkdtempSync(join(tmpdir(), "uktub-rag-"));
try {
  const db = createRegistry(root);
  const dois = new Map<string, string>();
  const texts = new Map<string, string>();
  for (const [i, id] of paperIds.entries()) {
    const doi = `10.9999/p${String(i + 1).padStart(2, "0")}`;
    dois.set(id, doi);
    registerPaper(db, { doi, title: id, authors: [], year: 2026 });
    const bytes = new Uint8Array(readFileSync(pdfFor(id)));
    const x = await extractPdf(bytes);
    texts.set(id, x.text);
    publishSource(db, doi, { kind: "local-file", ref: "bench.pdf", license: null, digest: createHash("sha256").update(bytes).digest("hex"), extraction: x.extraction, text: x.text, pageStarts: x.pageStarts, sections: x.sections }, cfg, new Date());
  }
  const allDois = [...dois.values()];
  const embedder = createHttpEmbedder({ url: embedUrl, model: embedModel, profile, fetch });

  const t0 = Date.now();
  const ensured = await ensureVectors(db, embedder, allDois, new Date());
  const embedMs = Date.now() - t0;
  const chunkCount = (db.prepare("SELECT COUNT(*) n FROM chunks").get() as { n: number }).n;
  console.error(`embedded ${ensured.embedded} passages in ${(embedMs / 1000).toFixed(1)} s (${chunkCount} chunks)`);

  const chunkSpan = db.prepare("SELECT char_start AS s, char_end AS e FROM chunks WHERE doi = ? AND chunk_index = ?");
  const spanOf = (doi: string, idx: number): Span => {
    const r = chunkSpan.get(doi, idx) as { s: number; e: number };
    return { start: Number(r.s), end: Number(r.e) };
  };

  type Method = "lexical" | "vector" | "hybrid";
  const evaluate = async (field: string): Promise<{ located: number; rows: Record<string, unknown>[]; table: string[]; latency: Record<Method, number[]>; n: number }> => {
    const rows: Record<string, unknown>[] = [];
    let located = 0;
    const latency: Record<Method, number[]> = { lexical: [], vector: [], hybrid: [] };
    const hits = new Map<string, number>(); // scope|part|method|k → count
    const totals = new Map<string, number>();
    const bump = (m: Map<string, number>, key: string, by = 1): void => void m.set(key, (m.get(key) ?? 0) + by);
    for (const c of claims) {
      const gold = locateQuote(texts.get(c.paper)!, c.evidence);
      if (gold === null) continue;
      const text = field === "claim" ? c.claim : extraQueries.get(c.id)?.[field];
      if (text === undefined) continue;
      located++;
      const own = dois.get(c.paper)!;
      for (const scope of ["own", "all"] as const) {
        const scoped = scope === "own" ? [own] : allDois;
        const key = `${scope}|${split(c.paper)}`;
        bump(totals, key);
        const q = await embedder.embedQuery(text);
        const t1 = performance.now();
        const lex = lexicalRank(db, scoped, text, POOL);
        latency.lexical.push(performance.now() - t1);
        const t2 = performance.now();
        const vec = rankByVector(db, embedder.id, q, scoped, POOL);
        latency.vector.push(performance.now() - t2);
        const tk = (d: string, i: number): string => `${d}\u0000${String(i).padStart(8, "0")}`;
        const fused = rrfFuse([lex.map((h) => tk(h.doi, h.chunkIndex)), vec.map((h) => tk(h.doi, h.chunkIndex))]);
        const ranked: Record<Method, { doi: string; idx: number }[]> = {
          lexical: lex.map((h) => ({ doi: h.doi, idx: h.chunkIndex })),
          vector: vec.map((h) => ({ doi: h.doi, idx: h.chunkIndex })),
          hybrid: fused.map((f) => ({ doi: f.key.split("\u0000")[0], idx: Number(f.key.split("\u0000")[1]) })),
        };
        for (const m of ["lexical", "vector", "hybrid"] as const) {
          for (const k of KS) {
            const ok = ranked[m].slice(0, k).some((h) => h.doi === own && overlapChars(spanOf(h.doi, h.idx), gold) > 0);
            if (ok) bump(hits, `${key}|${m}|${k}`);
          }
        }
      }
      // end-to-end latency of the real search path (embedder query + fusion + hydration), all papers
      const t3 = performance.now();
      await searchPassages(db, { query: text, dois: allDois, limit: 5, embedder, now: new Date() });
      latency.hybrid.push(performance.now() - t3);
    }
    const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
    const table: string[] = [];
    for (const scope of ["own", "all"] as const) for (const part of ["tuning", "held-out", "both"] as const) {
      const parts = part === "both" ? (["tuning", "held-out"] as const) : [part];
      const n = parts.reduce((a, p) => a + (totals.get(`${scope}|${p}`) ?? 0), 0);
      for (const m of ["lexical", "vector", "hybrid"] as const) {
        const cells = KS.map((k) => pct(parts.reduce((a, p) => a + (hits.get(`${scope}|${p}|${m}|${k}`) ?? 0), 0), n));
        table.push(`| ${field} | ${scope} | ${part} | ${n} | ${m} | ${cells.join(" | ")} |`);
        rows.push({ field, scope, part, claims: n, method: m, recall: Object.fromEntries(KS.map((k, i) => [k, cells[i]])) });
      }
    }
    return { located, rows, table, latency, n: located };
  };

  const results = [];
  for (const f of queryFields) results.push(await evaluate(f));
  const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
  const lat = results[0].latency;
  const md = [
    `# Passage search — lexical vs vector vs hybrid — ${date}`,
    "",
    `Gold-passage recall@k for the located TRUE claims of \`claim-verification-v1\` (${results.map((r, i) => `${queryFields[i]}: ${r.located}`).join(", ")}), over ${chunkCount} ${label} chunks of the 14 papers (${profile.name} prompts, \`${embedModel}\`). Query styles: \`claim\` = the claim text; \`paraphrase\` / \`question\` = rewrites written without seeing the papers. A hit = a returned passage of the claim's own paper overlaps the gold span. \`own\` searches the claim's paper only; \`all\` searches all 14 (distractors). Hybrid = Reciprocal Rank Fusion (k = 60) of the two rankings (pool ${POOL} each).`,
    "",
    "| Query | Scope | Papers | Claims | Method | @1 | @3 | @5 | @10 |",
    "|---|---|---|---|---|---|---|---|---|",
    ...results.flatMap((r) => r.table),
    "",
    `Cost: embedding ${ensured.embedded} passages took ${(embedMs / 1000).toFixed(1)} s once (cached afterwards); median rank time over all papers — lexical ${median(lat.lexical).toFixed(2)} ms, vector scan ${median(lat.vector).toFixed(2)} ms; median end-to-end hybrid search (incl. one query embedding) ${median(lat.hybrid).toFixed(0)} ms.`,
    "",
  ].join("\n");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `rag-search-${label}-${date}.md`), md);
  writeFileSync(join(outDir, `rag-search-${label}-${date}.results.json`), JSON.stringify({ schema: "bench-rag/1", date, label, embedModel, profile: profile.name, chunkTokens, boundary, chunkCount, embedMs, rows: results.flatMap((r) => r.rows) }, null, 1));
  console.log(md);
  db.close();
  void openRegistry;
} finally {
  rmSync(root, { recursive: true, force: true });
}
