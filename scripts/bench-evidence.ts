/**
 * Evidence-quality experiment (plan U6; docs/benchmarks): how well does the
 * package's own claim → supporting-passage workflow find gold support, and at
 * what cost? Separate from the deterministic contract tests on purpose: this
 * needs a real local engine and the owner's PDFs, and its numbers are
 * measurements, not guarantees.
 *
 * It uses the REAL package path — unpdf extraction, chunking, FTS5 retrieval,
 * two-stage judgment, containment — through `verifyClaimTool`, with the engine
 * behind the existing `llama-cpp` adapter (scripts/system-one-server.ts).
 * Papers are published directly (their identity is attested by the dataset),
 * so acquisition and identity checks are covered by the offline suite and the
 * CLI/Pi smoke instead.
 *
 * Phases:
 *   retrieval   candidate recall of the FTS locator vs K and chunk size (no engine)
 *   endtoend    exhaustive vs query-guided runs per claim; false supports over all papers
 *   review-out  bounded excerpts for independent blind review (no scores, no labels)
 *   review-in   merge reviewer labels into returned-evidence precision
 *
 * Split by PAPER (not claim): even-indexed papers tune policy, odd-indexed are
 * held out and reported. Paper bodies stay local; artifacts hold spans, counts
 * and bounded excerpts only.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry, registerPaper } from "../src/core/registry.ts";
import { extractPdf } from "../src/core/source/extract.ts";
import { verifyClaimTool, type VerifyClaimArgs } from "../src/core/tools/verify.ts";
import { selectCandidates } from "../src/core/verify/retrieve.ts";
import { chunkPolicyOf, publishSource } from "../src/core/verify/store.ts";
import type { ChunkTextConfig } from "../src/core/chunk.ts";
import { locateQuote, overlapChars, summarize, type ClaimRun, type Span } from "./bench-evidence-metrics.ts";

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
};
const phase = arg("phase", "retrieval")!;
const datasetDir = arg("dataset", "benchmarks/datasets/claim-verification-v1")!;
const pdfRoot = arg("pdf-root", "../test_papers")!;
const outDir = arg("out", "docs/benchmarks")!;
const date = arg("date", new Date().toISOString().slice(0, 10))!;
const chunkTokens = Number(arg("chunk-tokens", "8192"));
const perPaperK = Number(arg("k", "5"));
const url = arg("url", "http://127.0.0.1:8099")!;
const only = arg("papers"); // "held-out" | "tuning" | undefined = all
const engineName = arg("engine", "llama-cpp")!; // llama-cpp (server at --url) | eos (in-package worker)
const stride = Number(arg("stride", "1")); // every n-th claim of each label: a deterministic subset
const offset = Number(arg("offset", "0")); // which of the `stride` interleaved subsets (0..stride-1): disjoint samples for validation
const falseScope = arg("false-scope", "all")!; // all | own
const label = arg("label", `T${chunkTokens}`)!;
const boundary = arg("boundary", "paragraph") as ChunkTextConfig["boundary"]; // paragraph | hard | section (cap = --chunk-tokens)

interface Claim { id: string; paper: string; claim: string; label: "TRUE" | "FALSE"; evidence: string; kind?: string }
const claims: Claim[] = JSON.parse(readFileSync(join(datasetDir, "claims.json"), "utf8")).claims;
const paperIds = [...new Set(claims.map((c) => c.paper))].sort();
const split = (id: string): "tuning" | "held-out" => (paperIds.indexOf(id) % 2 === 0 ? "tuning" : "held-out");

function pdfFor(id: string): string {
  for (const d of readdirSync(pdfRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(pdfRoot, d.name))) if (f.endsWith(".pdf") && f.slice(0, -4).startsWith(id.slice(0, 38))) return join(pdfRoot, d.name, f);
  }
  throw new Error(`no PDF for ${id}`);
}

const cfgFor = (tokens: number): ChunkTextConfig => ({ chunk_tokens: tokens, overlap_tokens: Math.round(tokens / 64), chars_per_token: 2.8, boundary });

interface Project { root: string; dois: Map<string, string>; texts: Map<string, string>; close(): void }
async function buildProject(tokens: number): Promise<Project> {
  const root = mkdtempSync(join(tmpdir(), "uktub-evid-"));
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
    publishSource(db, doi, { kind: "local-file", ref: "bench.pdf", license: null, digest: createHash("sha256").update(bytes).digest("hex"), extraction: x.extraction, text: x.text, pageStarts: x.pageStarts, sections: x.sections }, cfgFor(tokens), new Date());
  }
  db.close();
  return { root, dois, texts, close: () => rmSync(root, { recursive: true, force: true }) };
}

const goldOf = (p: Project, c: Claim): Span | null => {
  const hit = locateQuote(p.texts.get(c.paper)!, c.evidence);
  return hit === null ? null : { start: hit.start, end: hit.end };
};
const inScope = (c: Claim): boolean => only === undefined || split(c.paper) === only;
const pct = (v: number | null): string => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);

// ── retrieval ───────────────────────────────────────────────────────────────

async function retrieval(): Promise<void> {
  const Ks = [1, 3, 5, 8, 12];
  const sizes = (arg("sizes", "1024,2048,8192") as string).split(",").map(Number);
  const rows: Record<string, unknown>[] = [];
  for (const tokens of sizes) {
    const p = await buildProject(tokens);
    const db = (await import("../src/core/registry.ts")).openRegistry(p.root);
    for (const k of Ks) for (const part of ["tuning", "held-out"] as const) {
      const runs: ClaimRun[] = [];
      let candShare = 0;
      let n = 0;
      for (const c of claims.filter((x) => x.label === "TRUE" && split(x.paper) === part)) {
        const gold = goldOf(p, c);
        const sel = selectCandidates(db, [p.dois.get(c.paper)!], c.claim, k)[0];
        const cands = sel?.candidates.map((x) => ({ start: x.start, end: x.end })) ?? [];
        runs.push({ label: "TRUE", gold, candidates: cands, evidence: [], freshJudgments: 0 });
        if (sel) { candShare += sel.candidates.length / sel.chunksTotal; n++; }
      }
      const s = summarize(runs);
      rows.push({ chunkTokens: tokens, k, part, claims: s.trueClaims, goldLocated: s.goldLocated, candidateRecall: s.candidateRecall, meanCandidateShare: n === 0 ? null : candShare / n });
    }
    db.close();
    p.close();
  }
  const json = join(outDir, `evidence-retrieval-${date}.results.json`);
  writeFileSync(json, JSON.stringify({ schema: "bench-evidence/1", phase, date, rows }, null, 1));
  const md = [
    `# Locator retrieval recall — ${date}`,
    "",
    "FTS5/BM25 candidate recall for the TRUE claims of `claim-verification-v1`: is the gold quote inside a candidate chunk when the locator is the claim text itself? Papers are split by source (even-indexed = tuning, odd-indexed = held-out). `share` is the mean fraction of a paper's chunks that become candidates (verifier work saved = 1 − share).",
    "",
    "| Chunk tokens | K | Part | Claims (gold located) | Candidate recall | Mean candidate share |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.chunkTokens} | ${r.k} | ${r.part} | ${r.claims} (${r.goldLocated}) | ${pct(r.candidateRecall as number | null)} | ${pct(r.meanCandidateShare as number | null)} |`),
    "",
    "Raw rows: the results JSON beside this file. Gold spans are located in the `unpdf` text by token matching because the dataset quotes were authored against `pdftotext`; claims whose quote cannot be located are excluded and counted.",
    "",
  ].join("\n");
  writeFileSync(join(outDir, `evidence-retrieval-${date}.md`), md);
  console.log(md);
}

// ── end to end ──────────────────────────────────────────────────────────────

interface Rec { id: string; paper: string; part: string; kind: string; mode: string; label: string; gold: Span | null; evidence: (Span & { doi: string; excerpt: string | null; withheld: string | null; score: number })[]; fresh: number; cached: number; unchecked: number; wallMs: number; limitations: string[]; chars: number }

async function endToEnd(): Promise<void> {
  const out: Rec[] = [];
  const tokens = chunkTokens;
  for (const mode of ["exhaustive", "guided"] as const) {
    const p = await buildProject(tokens); // a fresh registry per mode: no shared judgment cache
    const cfgPath = join(p.root, "bench.yaml");
    writeFileSync(cfgPath, `chunking:\n  chunk_tokens: ${tokens}\n  overlap_tokens: ${Math.round(tokens / 64)}\n  chars_per_token: 2.8\n  boundary: ${boundary}\nverification:\n  engine: ${engineName}\n  min_confidence: 0.99\n  workers: 2\n  max_judgments: 100000\n`);
    const engineEnv: Record<string, string> = engineName === "eos"
      ? Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith("UKTUB_EOS_") && v !== undefined) as [string, string][])
      : { UKTUB_VERIFY_URL: url };
    const ctx = { root: p.root, fetch: ((...a: Parameters<typeof fetch>) => fetch(...a)) as never, env: { UKTUB_CHUNK_CONFIG: cfgPath, ...engineEnv } as Record<string, string>, now: () => new Date(), queue: new WriteQueue() };
    const seen = { TRUE: 0, FALSE: 0 };
    const scoped = claims.filter(inScope).filter((c) => seen[c.label]++ % stride === offset);
    for (const c of scoped) {
      const doi = p.dois.get(c.paper)!;
      const wide = c.label === "FALSE" && falseScope === "all"; // FALSE claims run over EVERY paper (corpus-size false supports)
      if (mode === "guided" && wide) continue;
      const args: Record<string, unknown> = { claim: c.claim, papers: wide ? "all" : [doi], ...(mode === "guided" ? { query: c.claim } : {}) };
      const t0 = Date.now();
      const r = await verifyClaimTool(ctx as never, args as unknown as VerifyClaimArgs);
      const s = r.structuredContent as Record<string, any> | null;
      const refused = r.details.refused as { code: string; message: string } | undefined;
      if (s === null) { console.error(`${c.id} refused: ${refused?.code} ${refused?.message}`); continue; }
      out.push({
        id: c.id, paper: c.paper, part: split(c.paper), kind: c.kind ?? "", mode: wide ? "all-papers" : mode, label: c.label, gold: goldOf(p, c),
        evidence: (s.evidence as any[]).map((e) => ({ start: e.span.start, end: e.span.end, doi: e.doi, excerpt: e.excerpt, withheld: e.withheld, score: e.judgment.score })),
        fresh: s.coverage.work.fresh + s.coverage.work.localizationFresh, cached: s.coverage.work.cached, unchecked: s.coverage.work.unchecked,
        wallMs: Date.now() - t0, limitations: s.result.limitations, chars: (s.evidence as any[]).reduce((n, e) => n + (e.excerpt?.length ?? 0), 0),
      });
      if (out.length % 10 === 0) console.error(`${out.length} runs`);
    }
    p.close();
  }
  const file = join(outDir, `evidence-endtoend-${label}-${only ?? "all"}-${date}.results.json`);
  writeFileSync(file, JSON.stringify({ schema: "bench-evidence/1", phase, date, chunkTokens: tokens, boundary, k: perPaperK, engineUrl: url, policy: chunkPolicyOf(cfgFor(tokens)), records: out }, null, 1));
  console.log(`wrote ${file} (${out.length} runs)`);
}

// ── review export / merge ───────────────────────────────────────────────────

function loadResults(): { file: string; tokens: number; window: string; recs: Rec[] }[] {
  return (arg("results", "") as string).split(",").filter(Boolean).map((file) => {
    const d = JSON.parse(readFileSync(file, "utf8")) as { chunkTokens: number; boundary?: string; records: Rec[] };
    return { file, tokens: d.chunkTokens, window: d.boundary === "section" ? `${d.chunkTokens} (sections)` : String(d.chunkTokens), recs: d.records };
  });
}

function reviewOut(): void {
  const cmap = new Map(claims.map((c) => [c.id, c]));
  const items: { id: string; claim: string; excerpt: string; stratum: string }[] = [];
  for (const { tokens, recs } of loadResults()) for (const r of recs) for (const [i, e] of r.evidence.entries()) {
    if (e.excerpt === null) continue;
    const hitGold = r.gold !== null && overlapChars(e, r.gold) > 0;
    const stratum = r.label === "FALSE" ? "false-claim" : hitGold ? "gold-hit" : "extra";
    items.push({ id: `${tokens}|${r.id}|${r.mode}|${i}`, claim: cmap.get(r.id)!.claim, excerpt: e.excerpt, stratum });
  }
  // Stratified sample so the rare strata (false-claim supports, extras) are all reviewed.
  const cap = Number(arg("cap", "40"));
  const sample: typeof items = [];
  for (const stratum of ["false-claim", "extra", "gold-hit"]) {
    const pool = items.filter((x) => x.stratum === stratum);
    const step = Math.max(1, Math.ceil(pool.length / cap));
    sample.push(...pool.filter((_, i) => i % step === 0).slice(0, cap));
  }
  // Blind input: no scores, no gold, no mode, no stratum.
  writeFileSync(join(outDir, `evidence-review-input-${date}.json`), JSON.stringify(sample.map(({ id, claim, excerpt }) => ({ id, claim, excerpt })), null, 1));
  writeFileSync(join(outDir, `evidence-review-strata-${date}.json`), JSON.stringify(Object.fromEntries(sample.map((x) => [x.id, x.stratum])), null, 1));
  console.log(`${items.length} excerpts, ${sample.length} sampled`);
}

function reviewIn(): void {
  const labels = JSON.parse(readFileSync(arg("labels")!, "utf8")) as { id: string; label: "supports" | "partial" | "does_not_support"; reason?: string }[];
  const strata = JSON.parse(readFileSync(join(outDir, `evidence-review-strata-${date}.json`), "utf8")) as Record<string, string>;
  const rows: string[] = [];
  const cell = (xs: typeof labels): string => {
    const n = xs.length;
    const s = xs.filter((x) => x.label === "supports").length;
    const p = xs.filter((x) => x.label === "partial").length;
    return n === 0 ? "—" : `${n} | ${s} (${pct(s / n)}) | ${p} | ${pct((s + p) / n)}`;
  };
  for (const stratum of ["gold-hit", "extra", "false-claim"]) rows.push(`| ${stratum} | ${cell(labels.filter((l) => strata[l.id] === stratum))} |`);
  for (const tokens of [...new Set(labels.map((l) => l.id.split("|")[0]))]) rows.push(`| window ${tokens} (all strata) | ${cell(labels.filter((l) => l.id.startsWith(`${tokens}|`)))} |`);
  rows.push(`| all reviewed | ${cell(labels)} |`);
  const md = [
    `# Independent evidence review — ${date}`,
    "",
    "Returned supporting excerpts were rated by a fresh Claude reviewer (an LLM, not a human) that saw only the claim and the excerpt — no engine score, no gold quote, no mode. Ratings: **supports** (the excerpt states or directly entails the claim), **partial** (related or supports part of it), **does_not_support**. Strata: `gold-hit` overlaps the dataset's gold quote; `extra` is returned support elsewhere in the paper; `false-claim` is support returned for a FALSE (fabricated) claim.",
    "",
    "| Stratum | Reviewed | Supports | Partial | Strict precision / lenient precision |",
    "|---|---|---|---|---|",
    ...rows.map((r) => r.replace(/ \| (\d+) \| (\d+) \((\S+)\) \| (\d+) \| (\S+) \|$/, " | $1 | $2 ($3) | $4 | $3 / $5 |")),
    "",
    "Strict = supports only; lenient = supports + partial. An LLM reviewer can be wrong; a human spot-check of the `partial` and `does_not_support` rows is the next evidence step.",
    "",
  ].join("\n");
  writeFileSync(join(outDir, `evidence-review-${date}.md`), md);
  writeFileSync(join(outDir, `evidence-review-${date}.results.json`), JSON.stringify({ schema: "bench-evidence-review/1", date, labels: labels.map((l) => ({ ...l, stratum: strata[l.id] })) }, null, 1));
  console.log(md);
}

// ── redact ──────────────────────────────────────────────────────────────────

/** Client policy: committed artifacts keep spans, scores and short exemplars only — never paper text. */
const EXEMPLAR_CHARS = 160;

/** Move full-excerpt result files to a private directory and rewrite the repo copies with exemplars only. */
function redact(): void {
  const priv = arg("private-dir")!;
  mkdirSync(priv, { recursive: true });
  for (const file of (arg("results", "") as string).split(",").filter(Boolean)) {
    const d = JSON.parse(readFileSync(file, "utf8")) as { records: Rec[]; redacted?: boolean };
    if (d.redacted) continue;
    writeFileSync(join(priv, file.split("/").pop()!), JSON.stringify(d, null, 1));
    for (const r of d.records) for (const e of r.evidence) if (e.excerpt !== null) e.excerpt = `${e.excerpt.slice(0, EXEMPLAR_CHARS)}…`;
    d.redacted = true;
    writeFileSync(file, JSON.stringify(d, null, 1));
    console.log(`redacted ${file}`);
  }
}

// ── report ──────────────────────────────────────────────────────────────────

function report(): void {
  const reports = loadResults().map((r) => ({ f: r.file, d: { chunkTokens: r.tokens, records: r.recs } }));
  const doiIndex = new Map(paperIds.map((id, i) => [`10.9999/p${String(i + 1).padStart(2, "0")}`, i]));
  const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
  const f1 = (v: number | null): string => (v === null ? "n/a" : v.toFixed(1));
  const rows: string[] = [];
  const subsetRows: string[] = [];
  for (const { d } of reports) {
    const parts = [...new Set(d.records.map((r) => r.part))];
    for (const part of parts) for (const mode of ["exhaustive", "guided"] as const) {
      const recs = d.records.filter((r) => r.part === part && r.mode === mode && r.label === "TRUE");
      if (recs.length === 0) continue;
      const runs: ClaimRun[] = recs.map((r) => ({ label: "TRUE", gold: r.gold, candidates: [], evidence: r.evidence, freshJudgments: r.fresh }));
      const s = summarize(runs);
      const withheld = recs.flatMap((r) => r.evidence).filter((e) => e.excerpt === null).length;
      const total = recs.flatMap((r) => r.evidence).length;
      rows.push(`| ${d.chunkTokens} | ${part} | ${mode} | ${s.trueClaims} (${s.goldLocated}) | ${pct(s.supportRecall)} | ${pct(s.goldHitPrecision)} | ${f1(s.meanEvidencePerTrue)} | ${f1(mean(recs.map((r) => r.fresh)))} | ${f1(mean(recs.map((r) => r.wallMs / 1000)))} | ${withheld}/${total} |`);
    }
    // FALSE claims ran over ALL papers: derive the corpus-size effect by restricting the returned evidence to n papers.
    for (const part of parts) {
      const falses = d.records.filter((r) => r.part === part && r.label === "FALSE" && r.mode === "all-papers");
      if (falses.length === 0) continue;
      for (const n of [1, 2, 4, 7, 14]) {
        const hits = falses.filter((r) => {
          const own = paperIds.indexOf(r.paper);
          const keep = new Set<number>([own]);
          for (let k = 1; keep.size < n && k <= paperIds.length; k++) keep.add((own + k) % paperIds.length);
          return r.evidence.some((e) => keep.has(doiIndex.get(e.doi) ?? -1));
        }).length;
        const own = falses.filter((r) => r.evidence.some((e) => doiIndex.get(e.doi) === paperIds.indexOf(r.paper))).length;
        subsetRows.push(`| ${d.chunkTokens} | ${part} | ${n} | ${falses.length} | ${hits} | ${pct(hits / falses.length)} | ${n === 1 ? pct(own / falses.length) : "—"} |`);
      }
    }
  }
  const md = [
    `# Evidence quality — end to end — ${date}`,
    "",
    "The package's own `verify_claim` workflow (unpdf extraction, chunking, FTS5 locator, two-stage judgment, containment) on `claim-verification-v1`, with a real local engine: Decision 2.0 Eos 0.8B behind the `llama-cpp` path, bar 0.99. Papers are split by source: even-indexed = tuning, odd-indexed = held-out. TRUE claims run scoped to their paper, exhaustive (no query) and guided (query = the claim); FALSE claims run exhaustive over all 14 papers. Each mode used its own fresh registry, so the judgment cache never flatters the cost comparison.",
    "",
    "Gold-hit precision is a LOWER bound: a returned passage that supports the claim somewhere other than the gold quote counts as a miss here; see the independent review report for true precision.",
    "",
    "| Chunk tokens | Part | Mode | TRUE claims (gold located) | Support recall | Gold-hit precision | Mean evidence / claim | Mean fresh judgments / claim | Mean wall s / claim | Excerpts withheld |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "## False supports versus corpus size",
    "",
    "FALSE claims are fabrications about one paper. `Papers` is how many papers are in scope (the claim's own paper plus the next n−1 in a fixed order); a false support is any supporting evidence returned from those papers. Supports from OTHER papers are not automatically errors (another paper may genuinely say the same thing); the review report decides. The last column is the hard case: support returned from the paper the claim was fabricated about.",
    "",
    "| Chunk tokens | Part | Papers | FALSE claims | With any support | Rate | Own-paper rate |",
    "|---|---|---|---|---|---|---|",
    ...subsetRows,
    "",
    "Raw per-claim records (spans, counts, bounded excerpts): the results JSON files named in `docs/benchmarks/evidence-endtoend-*`.",
    "",
  ].join("\n");
  const out = join(outDir, `evidence-quality-${arg("name", label)}-${date}.md`);
  writeFileSync(out, md);
  console.log(md);
}

// ── window sweep ────────────────────────────────────────────────────────────

/** Compare windows on the claims every file shares: `--results` = small-window sweep files (own-scoped FALSE
 *  claims) followed by the earlier full runs (FALSE claims over all papers, restricted to their own paper). */
function sweep(): void {
  const files = loadResults();
  const sweepFiles = files.filter((f) => f.file.includes("sweep"));
  const ids = new Set(sweepFiles[0].recs.map((r) => r.id));
  const byWindow = new Map<string, Rec[]>();
  for (const f of files) byWindow.set(f.window, [...(byWindow.get(f.window) ?? []), ...f.recs.filter((r) => ids.has(r.id))]);
  const doiIndex = new Map(paperIds.map((id, i) => [`10.9999/p${String(i + 1).padStart(2, "0")}`, i]));
  const mean = (xs: number[]): number => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
  const rows: string[] = [];
  for (const tokens of [...byWindow.keys()].sort((a, b) => parseInt(b) - parseInt(a) || a.localeCompare(b))) for (const mode of ["exhaustive", "guided"] as const) {
    const recs = byWindow.get(tokens)!;
    const tr = recs.filter((r) => r.label === "TRUE" && r.mode === mode);
    if (tr.length === 0) continue;
    const s = summarize(tr.map((r) => ({ label: "TRUE" as const, gold: r.gold, candidates: [], evidence: r.evidence, freshJudgments: r.fresh })));
    const fr = recs.filter((r) => r.label === "FALSE" && (r.mode === mode || (mode === "exhaustive" && r.mode === "all-papers")));
    const hit = fr.filter((r) => r.evidence.some((e) => r.mode !== "all-papers" || doiIndex.get(e.doi) === paperIds.indexOf(r.paper))).length;
    rows.push(`| ${tokens} | ${mode} | ${s.trueClaims} | ${pct(s.supportRecall)} | ${pct(s.goldHitPrecision)} | ${mean(tr.map((r) => r.evidence.length)).toFixed(2)} | ${mean(tr.map((r) => r.fresh)).toFixed(1)} | ${mean(tr.map((r) => r.wallMs / 1000)).toFixed(1)} | ${fr.length === 0 ? "n/a" : `${hit}/${fr.length}`} |`);
  }
  const md = [
    `# Chunk-window sweep — Eos 0.8B — ${date}`,
    "",
    `The same ${ids.size} claims (every third claim of each label, deterministic) at four stage-1 window sizes, in-package \`eos\` engine, bar 0.99, own-paper scope. Fresh registry per mode, so no cache sharing. The 8,192 and 2,048 rows are the earlier full runs restricted to these claims (their FALSE claims ran over all papers; only support from the claim's own paper is counted here). Locator query = the claim text.`,
    "",
    "| Window (tokens) | Mode | TRUE claims | Support recall | Gold-hit precision (lower bound) | Evidence / claim | Fresh judgments / claim | Wall s / claim | FALSE claims with support (own paper) |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "Reading: recall rises from 52 % at 8,192 to 84 % at 1,024 and does not improve at 512; the own-paper false-support count is the same at 2,048, 1,024 and 512. A locator query keeps the recall and removes most of the work once windows are small. Samples are small (25 true, 21 false claims): differences of one claim are noise; the direction agrees with the larger 2,048-vs-8,192 runs.",
    "",
  ].join("\n");
  writeFileSync(join(outDir, `evidence-window-sweep-${date}.md`), md);
  console.log(md);
}

// ── main ────────────────────────────────────────────────────────────────────

mkdirSync(outDir, { recursive: true });
if (phase === "retrieval") await retrieval();
else if (phase === "endtoend") await endToEnd();
else if (phase === "review-out") reviewOut();
else if (phase === "review-in") reviewIn();
else if (phase === "report") report();
else if (phase === "redact") redact();
else if (phase === "sweep") sweep();
else { console.error(`unknown phase ${phase}`); process.exit(2); }
