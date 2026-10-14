/**
 * Cause tracer (worker brief section 3): for every faulty unit (Muse labels-A:
 * cited units labelled unsupported|wrong|misattributed, uncited units labelled
 * specific) trace in the run's own uktub-transcript.jsonl how it came to be
 * written, classify the primary (+optional secondary) cause, and write
 * <outDir>/units.json + <outDir>/causes.md.
 *
 *   node scripts/live/trace-causes.ts [--grading <dir> --runs <dir> --out <dir>] <runId...>
 *
 * Defaults: UKTUB_GRADING_DIR for --grading; the archived runs root is required.
 * Never opens a registry: only transcript/turns JSONL, the note export and labels.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { noteIdForRun } from "./grade-lib.ts";
import {
  classifyCause,
  contentTokens,
  matchWrite,
  nearVariant,
  normalizeText,
  tokenOccurs,
  type Cause,
} from "./trace-lib.ts";

const TRACE_LABELS_BAD = ["unsupported", "wrong", "misattributed"] as const;

interface TranscriptCall {
  startLine: number;
  endLine: number | null;
  toolCallId: string;
  turnId: string;
  turnIndex: number;
  tool: string;
  args: Record<string, unknown>;
  writeText: string;
  resultText: string;
}

interface UnitRec {
  id: string;
  kind: string;
  text: string;
  cites: string[];
  cited: boolean;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const verifyHeadline = (t: string): string => (t.split("\n")[0] ?? "").slice(0, 120);

const DEMAND_CUES = [
  "precision", "merge", "mergability", "mergeability", "overhead", "hardware",
  "throughput", "memory", "benchmark", "parameter", "dataset", "measured",
  "architectural", "empirical",
];

function parseTranscript(path: string): { calls: TranscriptCall[]; turnStarts: number[] } {
  const raw = readFileSync(path, "utf8").split("\n");
  const turnStarts: number[] = [];
  const byId = new Map<string, { call: TranscriptCall; idx: number }>();
  const calls: TranscriptCall[] = [];
  raw.forEach((line, i) => {
    if (line.trim() === "") return;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const lineNo = i + 1;
    if (e.type === "turn_start") turnStarts.push(lineNo);
    if (e.type !== "tool_execution_start" && e.type !== "tool_execution_end") return;
    const id = str(e.toolCallId);
    if (e.type === "tool_execution_start") {
      const args = (e.args ?? {}) as Record<string, unknown>;
      let writeText = "";
      if (e.toolName === "write" && typeof args.content === "string") writeText = args.content;
      else if (e.toolName === "edit" && Array.isArray(args.edits)) {
        writeText = (args.edits as Array<Record<string, unknown>>).map((x) => str(x.newText)).join("\n");
      }
      const turnIndex = turnStarts.filter((t) => t < lineNo).length;
      const call: TranscriptCall = {
        startLine: lineNo, endLine: null, toolCallId: id, turnId: str(e.turn), turnIndex,
        tool: str(e.toolName), args, writeText, resultText: "",
      };
      calls.push(call);
      if (id !== "") byId.set(id, { call, idx: calls.length - 1 });
    } else if (id !== "" && byId.has(id)) {
      const res = (e.result ?? {}) as Record<string, unknown>;
      const parts: string[] = [];
      for (const c of Array.isArray(res.content) ? res.content : []) {
        const t = str((c as Record<string, unknown>).text);
        if (t !== "") parts.push(t);
      }
      byId.get(id)!.call.resultText = parts.join("\n");
      byId.get(id)!.call.endLine = lineNo;
    }
  });
  return { calls, turnStarts };
}

const TEXT_BEARING = new Set(["mcp__uktub__passages", "mcp__uktub__verify"]);

function resultHitsPaper(call: TranscriptCall, citekey: string): boolean {
  if (arr(call.args.papers).includes(citekey)) return call.resultText !== "";
  return false;
}

export function traceRun(runId: string, gradingDir: string, runsRoot: string): Record<string, unknown>[] {
  const note = noteIdForRun(runId);
  const noteJson = JSON.parse(readFileSync(join(gradingDir, "notes", note, "export", "note.json"), "utf8")) as {
    units: UnitRec[];
  };
  const labels = JSON.parse(readFileSync(join(gradingDir, "notes", note, "labels-A.json"), "utf8")) as {
    units: Array<{ id: string; label: string }>;
  };
  const labelById = new Map(labels.units.map((u) => [u.id, u.label]));
  const runDir = join(runsRoot, runId);
  const { calls } = parseTranscript(join(runDir, "evidence", "uktub-transcript.jsonl"));
  const turnLines = readFileSync(join(runDir, "evidence", "uktub-turns.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "");
  const turnObjs = turnLines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const turnIds: string[] = turnObjs.map((o) => str(o.id));
  const phaseOf = (turnId: string): string => {
    const ix = turnIds.indexOf(turnId);
    if (ix === 0) return "initial";
    if (ix === 1) return "revision";
    return turnId === "" ? "unknown" : "other";
  };
  const requestText = turnObjs.length > 0 ? str(turnObjs[0].prompt) : "";
  const revisionText = turnObjs.length > 1 ? str(turnObjs[1].prompt) : "";
  const requestNorm = normalizeText(requestText);
  const revisionNorm = normalizeText(revisionText);
  const revisionStartLine = calls.find((c) => phaseOf(c.turnId) === "revision")?.startLine ?? Number.MAX_SAFE_INTEGER;

  // Writes that can introduce unit text: any write/edit except the derived
  // evidence file (agents also rewrite the manuscript through helper scripts).
  const contentWrites = calls.filter(
    (c) => (c.tool === "write" || c.tool === "edit") && !str(c.args.path).endsWith("claims.json"),
  );
  const records: Record<string, unknown>[] = [];
  for (const unit of noteJson.units) {
    const label = labelById.get(unit.id) ?? "";
    const traced = (unit.cited && (TRACE_LABELS_BAD as readonly string[]).includes(label)) ||
      (!unit.cited && label === "specific");
    if (!traced) continue;
    const toks = contentTokens(unit.text);
    let first: TranscriptCall | null = null;
    for (const w of contentWrites) {
      if (matchWrite(unit.text, unit.kind, w.writeText).matched) {
        first = w;
        break;
      }
    }
    const before = first !== null ? calls.filter((c) => c.startLine < first!.startLine && c.resultText !== "") : [];
    const paperInfo = unit.cites.map((citekey) => {
      const paperResults = before.filter((c) => TEXT_BEARING.has(c.tool) && resultHitsPaper(c, citekey));
      const hits: Record<string, number | null> = {};
      for (const t of toks) {
        let line: number | null = null;
        for (const r of paperResults) {
          if (tokenOccurs(t.token, normalizeText(r.resultText))) {
            line = r.startLine;
            break;
          }
        }
        hits[`${t.kind}:${t.token}`] = line;
      }
      return {
        citekey,
        retrieved_before: paperResults.length > 0,
        first_result_line: paperResults.length > 0 ? paperResults[0].startLine : null,
        result_tools: [...new Set(paperResults.map((r) => r.tool))],
        token_hits: hits,
      };
    });
    // Token occurrence in ANY prior tool result (task 3b), with the first source.
    const anyHits: Record<string, { line: number; tool: string } | null> = {};
    for (const t of toks) {
      let found: { line: number; tool: string } | null = null;
      for (const r of before) {
        if (tokenOccurs(t.token, normalizeText(r.resultText))) {
          found = { line: r.startLine, tool: r.tool };
          break;
        }
      }
      anyHits[`${t.kind}:${t.token}`] = found;
    }
    // Verify calls with this unit's wording or a near variant (task 3c): ever, not just before.
    const verifyCalls = calls
      .filter((c) => c.tool === "mcp__uktub__verify" && typeof c.args.claim === "string")
      .filter((c) => nearVariant(str(c.args.claim), unit.text))
      .map((c) => ({
        line: c.startLine,
        turn: phaseOf(c.turnId),
        claim: str(c.args.claim).slice(0, 200),
        result: c.resultText === "" ? "no result" : verifyHeadline(c.resultText),
      }));
    // Task 3d: demanded column for table rows. The demand attaches to the table's
    // header (nearest preceding uncited row), not to the row's own cells.
    let columnDemanded = false;
    let demandStrong = false;
    let demandTerms: string[] = [];
    if (unit.kind === "row" && unit.cited) {
      const ix = noteJson.units.findIndex((u) => u.id === unit.id);
      let header = "";
      for (let h = ix - 1; h >= 0; h--) {
        const u = noteJson.units[h];
        if (u.kind === "row" && !u.cited) {
          header = u.text;
          break;
        }
      }
      const hTerms = contentTokens(header).filter((t) => t.kind === "term").map((t) => t.token);
      const rTerms = toks.filter((t) => t.kind === "term").map((t) => t.token);
      demandTerms = [...hTerms, ...rTerms].filter((t) => requestNorm.includes(t) || revisionNorm.includes(t));
      columnDemanded = demandTerms.length > 0 || requestNorm.includes("comparison table") || requestNorm.includes("table");
      demandStrong = DEMAND_CUES.some((c) => revisionNorm.includes(c));
    }
    const paperResultCount = paperInfo.filter((p) => p.retrieved_before).length;
    const hitCount = Object.values(paperInfo).reduce(
      (n, p) => n + Object.values(p.token_hits).filter((v) => v !== null).length, 0,
    );
    const numHw = toks.filter((t) => t.kind !== "term");
    const numHwHits = numHw.filter((t) => paperInfo.some((p) => p.token_hits[`${t.kind}:${t.token}`] !== null)).length;
    const slotUnsupplied = unit.kind === "row" && columnDemanded &&
      (numHw.length > 0 ? numHwHits === 0 : hitCount === 0);
    const missingNumHw = numHw.some((t) => !paperInfo.some((p) => p.token_hits[`${t.kind}:${t.token}`] !== null));
    const nearVariantPresent = verifyCalls.length > 0 ||
      toks.some((t) =>
        t.kind !== "term" && before.some((r) =>
          TEXT_BEARING.has(r.tool) && normalizeText(r.resultText).includes(t.token.replace(/[^a-z0-9]/g, "").replace(/^0+/, "")) &&
          !tokenOccurs(t.token, normalizeText(r.resultText))
        )
      );
    const revisionPhase = first !== null && phaseOf(first.turnId) === "revision";
    const retrievalSinceRevision = first !== null && calls.some((c) =>
      TEXT_BEARING.has(c.tool) && c.startLine > revisionStartLine && c.startLine < first!.startLine &&
      unit.cites.some((k) => arr(c.args.papers).includes(k)) && c.resultText !== ""
    );
    const cause = classifyCause({
      cited: unit.cited,
      isRow: unit.kind === "row",
      columnDemanded,
      demandStrong,
      slotUnsupplied,
      revisionPhase,
      retrievalSinceRevision,
      priorPaperResults: paperResultCount,
      hitCount,
      totalTokens: toks.length,
      missingNumberOrHardware: missingNumHw,
      nearVariantPresent,
    });
    records.push({
      run: runId,
      note,
      unit_id: unit.id,
      kind: unit.kind,
      label,
      text: unit.text,
      cites: unit.cites,
      first_write: first === null ? null : {
        line: first.startLine,
        toolCallId: first.toolCallId,
        tool: first.tool,
        assistant_turn: first.turnIndex,
        phase: phaseOf(first.turnId),
      },
      papers: paperInfo,
      token_any_result: anyHits,
      verify_calls: verifyCalls,
      verify_ever_called: verifyCalls.length > 0,
      column_demanded: unit.kind === "row" ? columnDemanded : null,
      demand_terms: demandTerms,
      cause_primary: cause.primary satisfies Cause,
      cause_secondary: cause.secondary,
      borderline: cause.borderline,
    });
  }
  return records;
}

function causesDoc(all: Record<string, unknown>[], borderlineIds: string[]): string {
  const L: string[] = [];
  const count = (f: (r: Record<string, unknown>) => string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of all) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
    return m;
  };
  const fmt = (m: Map<string, number>): string =>
    [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ");
  L.push(`# Cause traces for faulty units in 18 adapter-literature notes (${all.length} traced units)`);
  L.push(`Locator: single grader A (opencode-go/muse-spark-1.3-contributor); cited bad = unsupported|wrong|misattributed, uncited bad = specific.`);
  L.push(`Tie-breaks: UNCITED-KNOWLEDGE > SLOT-FILL (demanded table cell, no result) > REVISION-FILL (revision write, no new retrieval) > MEMORY (no prior paper text) > MISREPORT (partial hit, changed number/setting) > OVERREAD (retrieved but claim goes beyond).`);
  L.push(`## Counts by cause: ${fmt(count((r) => str(r.cause_primary)))}`);
  L.push(`## By turn: ${fmt(count((r) => str((r.first_write as Record<string, unknown> | null)?.phase ?? "unmatched")))}`);
  L.push(`## By kind: ${fmt(count((r) => str(r.kind)))}`);
  const vCalled = all.filter((r) => r.verify_ever_called === true).length;
  const vSupport = all.filter((r) => (r.verify_calls as Array<Record<string, unknown>>).some((v) => str(v.result).startsWith("SUPPORT FOUND"))).length;
  L.push(`## Verify: ever-called=${vCalled}/${all.length}; at-least-one-SUPPORT=${vSupport}/${all.length}. A SUPPORT here means the engine backed a near-variant wording, not the unit as written.`);
  L.push(`## Exemplars`);
  const order: Cause[] = ["MEMORY", "OVERREAD", "MISREPORT", "REVISION-FILL", "SLOT-FILL", "UNCITED-KNOWLEDGE"];
  const picked: Record<string, unknown>[] = [];
  for (const cause of order) {
    const r = all.find((x) => x.cause_primary === cause && x.borderline !== true && !picked.includes(x))
      ?? all.find((x) => x.cause_primary === cause && !picked.includes(x));
    if (r !== undefined) picked.push(r);
  }
  for (const r of all) {
    if (picked.length >= 6) break;
    if (r.verify_ever_called === true && !picked.includes(r)) picked.push(r);
  }
  for (const r of all) {
    if (picked.length >= 6) break;
    if (!picked.includes(r)) picked.push(r);
  }
  picked.slice(0, 6).forEach((r, i) => {
    const fw = r.first_write as Record<string, unknown> | null;
    L.push(`${i + 1}. [${r.run} ${r.unit_id} ${r.label}] ${str(r.text).slice(0, 160)}`);
    const vs = (r.verify_calls as Array<Record<string, unknown>>)
      .map((v) => `L${String(v.line)}:${str(v.result).split(":")[0]}`).join(",");
    L.push(`   cause=${str(r.cause_primary)}${r.cause_secondary ? `+${str(r.cause_secondary)}` : ""}${r.borderline === true ? " (borderline)" : ""}; first-write=line ${fw !== null ? String(fw.line) : "UNMATCHED"} (${fw !== null ? str(fw.phase) : "-"}); verify=${vs === "" ? "never" : vs}.`);
  });
  L.push(`## Borderline (${borderlineIds.length}): ${borderlineIds.join(" ") || "none"}`);
  L.push(`## What the data cannot tell`);
  L.push(`Transcript shows tool traffic only: no model activations, so MEMORY (parametric vs unlogged text) and intent are inferred, not observed. Registry/papers results carry metadata, not paper text; only passages/verify count as retrieved paper text. First-write matching is token recall, so heavy paraphrase across writes can misattribute the turn. Verify headlines are engine outputs at bar 0.99, not truth.`);
  return L.join("\n") + "\n";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (k: string): string | null => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
  };
  const gradingDir = resolve(get("--grading") ?? process.env.UKTUB_GRADING_DIR ?? "");
  const runsRoot = resolve(get("--runs") ?? "");
  const outDir = resolve(get("--out") ?? join(process.cwd(), "traces"));
  const runs = argv.filter((a) => !a.startsWith("--") && a !== get("--grading") && a !== get("--runs") && a !== get("--out"));
  if (gradingDir === "" || runsRoot === "" || runs.length === 0) {
    throw new Error("usage: trace-causes.ts [--grading <dir> --runs <dir> --out <dir>] <runId...>");
  }
  const all: Record<string, unknown>[] = [];
  for (const run of runs) all.push(...traceRun(run, gradingDir, runsRoot));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "units.json"), `${JSON.stringify(all, null, 2)}\n`);
  const borderline = all.filter((r) => r.borderline === true).map((r) => `${str(r.run)}/${str(r.unit_id)}`);
  writeFileSync(join(outDir, "causes.md"), causesDoc(all, borderline));
  const unmatched = all.filter((r) => r.first_write === null).length;
  console.log(`trace: ${all.length} units across ${runs.length} runs; unmatched=${unmatched} borderline=${borderline.length} -> ${outDir}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`trace-causes: FAILED: ${(err as Error).message}`);
    process.exit(1);
  });
}
