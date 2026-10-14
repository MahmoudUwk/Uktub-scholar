/**
 * Post-compose replay: verify the document AS WRITTEN, offline, no writer.
 *
 *   node scripts/live/replay-post-compose.ts [--scratch <S>] [--only iter-01,iter-02] [--out <json>]
 *
 * For each archived iteration: copy evidence/project to <S>/replay/work/<iter>
 * (cp -rp; the archive is never opened in place), run the PRODUCT's own
 * provenance audit (runProvenance, the function the CLI calls) for units, join
 * the Muse locator labels by unit id, then verify each unit's exact text with
 * the PRODUCT's own verifyClaimTool under UKTUB_VERIFY_ENGINE=hosted
 * (key from .env in-process, never printed):
 *   Pass A (cited units)   scoped to the unit's OWN cited papers;
 *   Pass B (uncited units) scoped to ALL registered papers.
 * Exhaustive (no query), default bar 0.99, current chunking. The product's
 * judgment cache lives in the copy's registry, so a rerun is cheap; per-iter
 * files make the run resume-safe (finished units are skipped by claim hash).
 *
 * Writes per-iter files to <S>/replay/work/<iter>/replay.json, the raw
 * results to docs/benchmarks/post-compose-replay-2026-10-14.json and a short
 * summary to <S>/replay/summary.md.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProvenance } from "../../src/core/provenance/run.ts";
import { WriteQueue } from "../../src/core/queue.ts";
import { createSafeDownloader } from "../../src/core/source/download.ts";
import type { ToolContext } from "../../src/core/tools/context.ts";
import { verifyClaimTool } from "../../src/core/tools/verify.ts";
import { providerKeys, VERIFY_KEY_NAMES, verifySecrets } from "./keys.ts";
import {
  BAD_CITED,
  computeMetrics,
  joinLabel,
  p95,
  passOf,
  type Split,
  type UnitRow,
} from "./post-compose-metrics.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKTREE = resolve(HERE, "..", "..");
const DEFAULT_DATE = "2026-10-14";

const sha8 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
const sha12 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);

interface Flags {
  scratch: string;
  only: string[] | null;
  out: string;
  pauseMs: number;
}

function parseFlags(argv: string[]): Flags {
  const dflt = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const scratch = dflt("scratch") ?? resolve(WORKTREE, "..");
  const onlyRaw = dflt("only");
  const pauseRaw = dflt("pause-ms");
  return {
    scratch,
    only: onlyRaw === undefined || onlyRaw === "" ? null : onlyRaw.split(",").map((s) => s.trim()).filter(Boolean),
    out: dflt("out") ?? join(WORKTREE, "docs", "benchmarks", `post-compose-replay-${DEFAULT_DATE}.json`),
    pauseMs: pauseRaw === undefined || pauseRaw === "" ? 1500 : Number(pauseRaw),
  };
}

interface IterRecord {
  iter: string;
  note: string;
  digest: string | null;
  digestMatch: boolean | null;
  provenanceOk: boolean;
  provenanceMessage?: string;
  units: Record<string, StoredUnit>;
}

interface StoredUnit {
  id: string;
  kind: string;
  text: string;
  claimHash: string;
  cites: string[];
  pass: "A" | "B";
  label: string | null;
  noteCited: string[];
  outcome: "promoted" | "not-found" | "skipped" | "error";
  supportFound: boolean | null;
  supportingPapers: string[];
  complete: boolean | null;
  limitations: string[];
  engineModel: string | null;
  engineProtocol: string | null;
  bar: number | null;
  candidates: number | null;
  checked: number;
  fresh: number;
  cached: number;
  timeMs: number;
  note: string;
  detail: string | null;
}

const loadJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8")) as unknown;

function makeWritable(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      try { chmodSync(p, 0o755); } catch { /* surfaces later */ }
      makeWritable(p);
    } else if (!e.isSymbolicLink()) {
      try { chmodSync(p, 0o644); } catch { /* surfaces later */ }
    }
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const archive = "/home/mahmoud/Desktop/AI_Projects/UktubAI/Uktub-scholar/experiments/runs/adapter-literature-workflow-v1";
  const split = loadJson(join(flags.scratch, "archive", "SPLIT.json")) as Split;
  const allIters = [...split.dev, ...split.heldout].sort();
  const iters = flags.only ?? allIters;

  // Key: shell wins over .env, in-process only, never printed.
  const dotenvPath = join(WORKTREE, ".env");
  const dotenvText = existsSync(dotenvPath) ? readFileSync(dotenvPath, "utf8") : null;
  const secrets = verifySecrets(providerKeys(process.env as Record<string, string | undefined>, dotenvText, VERIFY_KEY_NAMES));
  const apiKey = secrets["UKTUB_VERIFY_API_KEY"];
  if (!apiKey) {
    console.error("missing hosted verifier key (VLLM_decision_API in shell or .env); refusing a keyless run");
    process.exit(2);
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    UKTUB_VERIFY_ENGINE: "hosted",
    UKTUB_VERIFY_API_KEY: apiKey,
  };

  const workRoot = join(flags.scratch, "replay", "work");
  mkdirSync(workRoot, { recursive: true });

  for (const iter of iters) {
    const dest = join(workRoot, iter);
    if (!existsSync(dest)) {
      const src = join(archive, iter, "evidence", "project");
      if (!existsSync(src)) {
        console.error(`skip ${iter}: no evidence/project in archive`);
        continue;
      }
      const cp = spawnSync("cp", ["-rp", src, dest]);
      if (cp.status !== 0) {
        console.error(`skip ${iter}: cp failed`);
        continue;
      }
      makeWritable(dest);
    }
    const recPath = join(dest, "replay.json");
    let rec: IterRecord | null = null;
    try {
      rec = existsSync(recPath) ? (loadJson(recPath) as IterRecord) : null;
    } catch {
      rec = null;
    }

    const note = sha8(`uktub-grading:${iter}`);
    const labelsPath = join(flags.scratch, "grading-v1", "notes", note, "labels-A.json");
    if (!existsSync(labelsPath)) {
      console.error(`skip ${iter}: no labels for note ${note}`);
      continue;
    }
    const labels = loadJson(labelsPath) as { document_digest?: string; units: { id: string; label: string }[] };
    const labelById = new Map(labels.units.map((u) => [u.id, u.label] as [string, string]));

    const prov = runProvenance({ root: dest, now: () => new Date() });
    if (!prov.ok) {
      console.error(`skip ${iter}: provenance failed: ${prov.message}`);
      writeFileSync(recPath, JSON.stringify({ iter, note, digest: null, digestMatch: null, provenanceOk: false, provenanceMessage: prov.message, units: rec?.units ?? {} }, null, 2));
      continue;
    }
    const digestMatch = labels.document_digest === undefined ? null : prov.digest === labels.document_digest;
    const extracted = prov.audit.extracted.map((u) => {
      const audited = prov.audit.units.find((x) => x.unit.id === u.id);
      return { id: u.id, kind: u.kind, text: u.plain, cites: u.cites, status: audited?.status ?? "uncited" };
    });
    const noteCited = [...new Set(extracted.flatMap((u) => u.cites))].sort();

    if (rec === null || rec.digest !== prov.digest) {
      rec = { iter, note, digest: prov.digest, digestMatch, provenanceOk: true, units: rec?.digest === prov.digest ? rec.units : {} };
    } else {
      rec.digestMatch = digestMatch;
    }

    let done = 0;
    for (const u of extracted) {
      const claimHash = sha12(u.text);
      const prev = rec.units[u.id];
      if (prev !== undefined && prev.claimHash === claimHash && prev.outcome !== "error") {
        done++;
        continue;
      }
      const pass = passOf(u.cites);
      const stored: StoredUnit = {
        id: u.id, kind: u.kind, text: u.text, claimHash, cites: u.cites, pass,
        label: joinLabel(labelById, u.id), noteCited,
        outcome: "error", supportFound: null, supportingPapers: [], complete: null,
        limitations: [], engineModel: null, engineProtocol: null, bar: null,
        candidates: null, checked: 0, fresh: 0, cached: 0, timeMs: 0, note, detail: null,
      };
      const ctx: ToolContext = {
        root: dest,
        fetch: (...a) => globalThis.fetch(...a),
        env,
        now: () => new Date(),
        queue: new WriteQueue(),
        download: createSafeDownloader(),
      };
      const t0 = Date.now();
      let attempts = 0;
      for (;;) {
        attempts++;
        try {
          const result = await verifyClaimTool(
            ctx,
            pass === "A" ? { claim: u.text, papers: [...u.cites] } : { claim: u.text, papers: "all" },
          );
          stored.timeMs = Date.now() - t0;
          const refused = (result.details as { refused?: { code?: string; message?: string } })["refused"];
          if (refused !== undefined) {
            const code = refused.code ?? "refused";
            const transient = code === "VERIFY_ENGINE_MISSING" || code === "REGISTRY_BUSY";
            if (transient && attempts <= 4) {
              // Hosted rate limit / busy lock: back off 60s and retry the same
              // unit in-process (a per-minute quota resets). Recorded as an
              // error only when retries are exhausted, so resume retries it.
              await new Promise((r) => setTimeout(r, 60_000));
              continue;
            }
            if (transient) {
              stored.outcome = "error";
              stored.detail = `${code}: ${(refused.message ?? "").slice(0, 200)}`;
            } else {
              stored.outcome = "skipped";
              stored.detail = `${code}: ${(refused.message ?? "").slice(0, 200)}`;
            }
          } else {
          const s = result.structuredContent as Record<string, any>;
          const supportFound = s["result"]?.["supportFound"] === true;
          stored.outcome = supportFound ? "promoted" : "not-found";
          stored.supportFound = supportFound;
          stored.supportingPapers = [...new Set(((s["evidence"] ?? []) as { citekey?: string; doi?: string }[]).map((e) => e.citekey ?? e.doi ?? ""))].filter(Boolean).sort();
          stored.complete = s["result"]?.["complete"] ?? null;
          stored.limitations = s["result"]?.["limitations"] ?? [];
          stored.engineModel = s["engine"]?.["model"] ?? null;
          stored.engineProtocol = s["engine"]?.["protocol"] ?? null;
          stored.bar = s["engine"]?.["minConfidence"] ?? null;
          stored.candidates = s["coverage"]?.["candidates"]?.["total"] ?? null;
          stored.checked = s["coverage"]?.["work"]?.["checked"] ?? 0;
          stored.fresh = s["coverage"]?.["work"]?.["fresh"] ?? 0;
          stored.cached = s["coverage"]?.["work"]?.["cached"] ?? 0;
          }
          break;
        } catch (err) {
          stored.timeMs = Date.now() - t0;
          stored.outcome = "error";
          stored.detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);
          break;
        }
      }
      rec.units[u.id] = stored;
      done++;
      writeFileSync(recPath, JSON.stringify(rec, null, 2));
      console.log(`${iter} ${u.id} [${pass}] ${stored.outcome} ${stored.timeMs}ms${done % 10 === 0 ? ` (${done}/${extracted.length})` : ""}`);
      if (flags.pauseMs > 0) await new Promise((r) => setTimeout(r, flags.pauseMs));
    }
    console.log(`${iter}: done ${done}/${extracted.length}, digestMatch=${digestMatch}`);
  }

  // ── assemble ─────────────────────────────────────────────────────────────
  const rows: UnitRow[] = [];
  const perNoteExtra: Record<string, { iter: string; digestMatch: boolean | null; times: number[] }> = {};
  for (const iter of iters) {
    const recPath = join(workRoot, iter, "replay.json");
    if (!existsSync(recPath)) continue;
    const rec = loadJson(recPath) as IterRecord;
    if (!rec.provenanceOk) continue;
    const times: number[] = [];
    for (const u of Object.values(rec.units)) {
      times.push(u.timeMs);
      rows.push({
        iter: rec.iter, note: rec.note, id: u.id, kind: u.kind, pass: u.pass, label: u.label,
        cites: u.cites, outcome: u.outcome, supportingPapers: u.supportingPapers,
        noteCited: u.noteCited, complete: u.complete, timeMs: u.timeMs, judgments: u.checked,
      });
    }
    perNoteExtra[rec.note] = { iter: rec.iter, digestMatch: rec.digestMatch, times };
  }
  const metrics = computeMetrics(rows, split);
  const perNote: Record<string, unknown> = {};
  for (const [note, g] of Object.entries(metrics.perNote)) {
    const ex = perNoteExtra[note]!;
    perNote[note] = {
      iter: ex.iter, digestMatch: ex.digestMatch,
      wallMs: g.wallMs, judgments: g.judgments,
      p95Ms: p95(ex.times),
      ...JSON.parse(JSON.stringify(g)),
    };
  }
  const byIter: Record<string, StoredUnit[]> = {};
  const texts = new Map<string, string>();
  for (const iter of iters) {
    const recPath = join(workRoot, iter, "replay.json");
    if (!existsSync(recPath)) continue;
    const rec = loadJson(recPath) as IterRecord;
    if (!rec.provenanceOk) continue;
    byIter[iter] = Object.values(rec.units).sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const u of Object.values(rec.units)) texts.set(`${rec.note}:${u.id}`, u.text);
  }
  const out = {
    generated_at: new Date().toISOString().slice(0, 10),
    design: "verify the document as written: provenance units re-verified post-compose; Pass A cited units vs own papers, Pass B uncited units vs all papers; exhaustive, bar 0.99, current chunking, hosted engine",
    engine: { name: "hosted", note: "model/protocol/bar as reported per unit (engineModel/engineProtocol/bar)" },
    split: { dev: split.dev, heldout: split.heldout },
    metrics: {
      overall: metrics.overall,
      dev: metrics.dev,
      heldout: metrics.heldout,
    },
    perNote,
    units: byIter,
  };
  mkdirSync(dirname(flags.out), { recursive: true });
  writeFileSync(flags.out, JSON.stringify(out, null, 2));
  writeSummary(join(flags.scratch, "replay", "summary.md"), rows, metrics, perNoteExtra, texts);
  console.log(`wrote ${flags.out} (${rows.length} unit rows)`);
}

const short = (t: string, n = 110): string => (t.length <= n ? t : `${t.slice(0, n)}…`);

function writeSummary(path: string, rows: UnitRow[], metrics: ReturnType<typeof computeMetrics>, extra: Record<string, { iter: string; digestMatch: boolean | null; times: number[] }>, texts: Map<string, string>): void {
  const f = (r: { num: number; den: number; rate: number | null }): string =>
    r.rate === null ? `${r.num}/${r.den} n/a` : `${r.num}/${r.den} ${(r.rate * 100).toFixed(0)}%`;
  const o = metrics.overall;
  const d = metrics.dev;
  const h = metrics.heldout;
  const uns = (m: typeof o): number => m.passB.specific.verified - m.passB.specific.found;
  const lines: string[] = [];
  lines.push("# Post-compose replay (2026-10-14): verify the document as written");
  lines.push("Product provenance units re-verified post-compose with the hosted verifier. A: cited vs own papers. B: uncited vs all. Exhaustive, bar 0.99.");
  lines.push("| metric | overall | dev (5) | held-out (13) |");
  lines.push("|---|---|---|---|");
  lines.push(`| Pass A promotion | ${f(o.passA.promotion)} | ${f(d.passA.promotion)} | ${f(h.passA.promotion)} |`);
  lines.push(`| FDR promoted-but-bad | ${f(o.passA.fdr)} | ${f(d.passA.fdr)} | ${f(h.passA.fdr)} |`);
  lines.push(`| recall Muse-supported | ${f(o.passA.recallSupported)} | ${f(d.passA.recallSupported)} | ${f(h.passA.recallSupported)} |`);
  lines.push(`| Pass B specific recovered | ${f(o.passB.specific.share)} | ${f(d.passB.specific.share)} | ${f(h.passB.specific.share)} |`);
  lines.push(`| Pass B specific unsourced | ${uns(o)}/${o.passB.specific.verified} | ${uns(d)}/${d.passB.specific.verified} | ${uns(h)}/${h.passB.specific.verified} |`);
  lines.push(`| Pass B background found | ${f(o.passB.background.share)} | ${f(d.passB.background.share)} | ${f(h.passB.background.share)} |`);
  lines.push(`| B hits cited elsewhere | ${f(o.passB.hitsCitedElsewhere)} | ${f(d.passB.hitsCitedElsewhere)} | ${f(h.passB.hitsCitedElsewhere)} |`);
  const ex = (r: UnitRow): string =>
    `${r.iter} ${r.id} [${r.label}] else=${r.supportingPapers.some((p) => r.noteCited.includes(p))} [${r.supportingPapers.join(",")}] ${short(texts.get(`${r.note}:${r.id}`) ?? "")}`;
  const show = (title: string, rs: UnitRow[]): void => {
    lines.push(`## ${title} (${rs.length})`);
    for (const r of rs.slice(0, 5)) lines.push(`- ${ex(r)}`);
  };
  show("A promoted but Muse-bad", rows.filter((r) => r.pass === "A" && r.outcome === "promoted" && r.label !== null && BAD_CITED.has(r.label)));
  show("B recovered specific", rows.filter((r) => r.pass === "B" && r.label === "specific" && r.outcome === "promoted"));
  show("B unsourced specific", rows.filter((r) => r.pass === "B" && r.label === "specific" && r.outcome === "not-found"));
  lines.push("## Cannot tell: support=engine output not truth; no-support is not false; one call/unit, incomplete coverage may hide support; Muse labels unadjudicated; 18 notes, one scenario.");
  lines.push(`## Wall/judgments/p95 per note: ${Object.entries(metrics.perNote).sort().map(([n, m]) => `${extra[n]!.iter}=${(m.wallMs / 1000).toFixed(0)}s/${m.judgments}/p95 ${p95(extra[n]!.times)}ms`).join(" ")}`);
  const capped = lines.slice(0, 60);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${capped.join("\n")}\n`);
}

await main();
