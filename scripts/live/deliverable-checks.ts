/**
 * Tier 1 deliverable evaluator for live experiments (see scripts/live/experiment.ts).
 *
 * Pure or temp-fs-driven checks over deterministic fixtures; no product
 * imports. Tier 1 is exactly five gated checks, read from the machine-readable
 * provenance JSON (`uktub-scholar provenance --json`: entry, summary, items,
 * document_digest, units), the registry and file mtimes:
 *
 * - T1.1 `citations-in-registry`: every citation in the provenance units
 *   resolves to a registry entry with `citable === true`.
 * - T1.2 `bibliography-matches-registry`: the bibliography covers every cited
 *   key and holds only registered keys.
 * - T1.3 `compiled-after-last-edit`: a project PDF is strictly newer than the
 *   last `.tex` edit among the entry's transitive inputs.
 * - T1.4 `pointers-resolve`: every pointer in the provenance JSON resolves
 *   inside its paper's current revision text (DOI registered, revision equal,
 *   span inside the ready text).
 * - T1.5 `figures-supported`: no figure with status `open` or `unsourced`
 *   ("in the cited paper", not "in text the agent saw").
 *
 * Reported, never gated: word count (the provenance count only),
 * verified/cited/uncited counts, figures that are `uncited`, `check` or
 * `unavailable` (see `tierReport`), plus `evidence-tools-used`,
 * `provider-warnings-disclosed` and `no-unrequested-removal` from the turns.
 *
 * Deleted (PLAN rev 3 §4.3): the `claims.json` checks, `sourced-numerics`,
 * the regex document model, `stop-signal` / `all-turns-completed` (run
 * validity now lives in scripts/live/validity.ts), and snapshot-based
 * compilation (mtimes replaced it).
 *
 * - Sources: `ready` counts ONLY status `ready`; acquiring / unavailable /
 *   failed / metadata_only / missing are reported separately. Registry reads
 *   are paged (`mergeRegistryPages`) and the `citable` flag is honored.
 * - Cites: unit `cites` from the provenance JSON. The bibliography must cover
 *   every cited key and hold only registered keys.
 * - Paper texts for T1.4 come from a read-only open of the project's
 *   registry (`readTierPaperTexts`); the check itself is pure.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { normalizeToolName } from "../../src/core/tool-names.ts";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { walkFiles } from "./files.ts";

export interface RegistryRecord {
  doi: string;
  citekey: string;
  title?: string;
  citable?: boolean;
  source?: { status?: string; revision?: string | null } | null;
}

export interface RegistryReadPage {
  records: RegistryRecord[];
  nextCursor?: string | null;
}

export interface Check {
  id: string;
  ok: boolean;
  detail: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: any;
}

export interface ToolEnd {
  toolCallId: string;
  name: string;
  isError: boolean;
  text: string;
  structured: any;
}

export interface VerifyHit {
  claim: string;
  pointers: string[];
  citekeys: string[];
  supportFound: boolean;
}

export interface ScenarioSpec {
  prompt: string;
  success: string;
  evidenceTablePath: string | null;
  expectedEntry: string | null;
}

const POINTER_PARSE = /^(.+)@([0-9a-f]{16})#(\d+)-(\d+)$/;

const isNonBlankString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Host-namespaced tool names (`mcp__uktub__verify`, …) to bare names. */
export function bareToolName(name: string): string {
  return normalizeToolName(name);
}

// ── sources ──────────────────────────────────────────────────────────────────

/** Honor registry-read pagination: every page in order (dedupe by citekey, first wins). */
export function mergeRegistryPages(pages: RegistryReadPage[]): RegistryRecord[] {
  const seen = new Set<string>();
  const out: RegistryRecord[] = [];
  for (const page of pages) {
    for (const r of page.records) {
      if (seen.has(r.citekey)) continue;
      seen.add(r.citekey);
      out.push(r);
    }
  }
  return out;
}

export interface SourceCounts {
  ready: number;
  acquiring: number;
  unavailable: number;
  failed: number;
  metadataOnly: number;
  missing: number;
}

/** `ready` counts ONLY ready sources; every other state is reported separately. */
export function countSources(records: RegistryRecord[]): SourceCounts {
  const c: SourceCounts = { ready: 0, acquiring: 0, unavailable: 0, failed: 0, metadataOnly: 0, missing: 0 };
  for (const r of records) {
    switch (r.source?.status) {
      case "ready": c.ready += 1; break;
      case "acquiring": c.acquiring += 1; break;
      case "unavailable": c.unavailable += 1; break;
      case "failed": c.failed += 1; break;
      case "metadata_only": c.metadataOnly += 1; break;
      default:
        if (r.source === null || r.source === undefined) c.missing += 1;
        else c.metadataOnly += 1;
    }
  }
  return c;
}

// ── cites and bibliography ───────────────────────────────────────────────────

/** Strip `%` comments (an escaped `\\%` is not a comment start). */
export function stripTexComments(tex: string): string {
  return tex
    .split("\n")
    .map((line) => {
      let cut = -1;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "%" && (i === 0 || line[i - 1] !== "\\")) { cut = i; break; }
      }
      return cut < 0 ? line : line.slice(0, cut);
    })
    .join("\n");
}

const CITE_RE = /\\(?:cite\w*|Cite\w*|nocite)\s*(?:\[[^\]]*\]\s*)*\{([^}]+)\}/g;

/** Common cite commands incl. optional arguments and comma-separated keys. */
export function parseCitedKeys(tex: string): string[] {
  const out = new Set<string>();
  for (const m of stripTexComments(tex).matchAll(CITE_RE)) {
    for (const k of (m[1] as string).split(",").map((s) => s.trim())) {
      if (k === "" || k === "*") continue;
      out.add(k);
    }
  }
  return [...out];
}

export function parseBibKeys(bib: string): string[] {
  return [...bib.matchAll(/^@\w+\{([^,\s]+),/gm)].map((m) => m[1] as string);
}

export function checkCitationsInRegistry(cited: string[], records: RegistryRecord[]): Check {
  const byKey = new Map(records.map((r) => [r.citekey, r]));
  const bad = cited.filter((k) => byKey.get(k)?.citable !== true);
  const uncitable = cited.filter((k) => byKey.get(k)?.citable === false);
  return {
    id: "citations-in-registry",
    ok: cited.length > 0 && bad.length === 0,
    detail:
      `${cited.length} cited, ${bad.length} not usable in the registry` +
      (uncitable.length ? ` (not citable: ${uncitable.join(", ")})` : "") +
      (bad.length && !uncitable.length ? `: ${bad.join(", ")}` : ""),
  };
}

export function checkBibliography(bibText: string | null, cited: string[], records: RegistryRecord[]): Check {
  if (bibText === null) return { id: "bibliography-matches-registry", ok: false, detail: "refs/references.bib is missing" };
  const keys = new Set(records.map((r) => r.citekey));
  const bibKeys = parseBibKeys(bibText);
  const extra = bibKeys.filter((k) => !keys.has(k));
  const missing = cited.filter((k) => !bibKeys.includes(k));
  const ok = extra.length === 0 && missing.length === 0;
  return {
    id: "bibliography-matches-registry",
    ok,
    detail: ok
      ? `bibliography covers all ${cited.length} cited key(s); every bibliography key is a registered citekey`
      : [
          ...(missing.length ? [`cited but missing from the bibliography: ${missing.join(", ")}`] : []),
          ...(extra.length ? [`bibliography keys not in the registry: ${extra.join(", ")}`] : []),
        ].join("; "),
  };
}

// ── pointers ─────────────────────────────────────────────────────────────────

/**
 * Paper-attested hits from SUCCESSFUL verify structured results only.
 * Only evidence items with `attested === true` (the product's mark for
 * engine-judged paper passages, in both registry and direct-registered
 * modes), a valid source pointer and a nonblank citekey count.
 * Caller-supplied direct text (`attested: false`, no paper provenance) and
 * search text never verify; a result with no paper-attested evidence yields
 * no hit even when `supportFound` is true.
 */
export function extractVerifyHits(ends: ToolEnd[]): VerifyHit[] {
  const hits: VerifyHit[] = [];
  for (const e of ends) {
    if (bareToolName(e.name) !== "verify" || e.isError) continue;
    const s = e.structured as Record<string, unknown> | null;
    if (typeof s !== "object" || s === null || !isNonBlankString(s.claim) || (s.result as { supportFound?: unknown } | undefined)?.supportFound !== true) continue;
    const evidence: unknown[] = Array.isArray(s.evidence) ? (s.evidence as unknown[]) : [];
    const pointers: string[] = [];
    const citekeySet = new Set<string>();
    for (const item of evidence) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (rec.attested !== true) continue;
      if (typeof rec.pointer !== "string" || POINTER_PARSE.exec(rec.pointer) === null) continue;
      if (!isNonBlankString(rec.citekey)) continue;
      pointers.push(rec.pointer);
      citekeySet.add((rec.citekey as string).trim());
    }
    if (pointers.length === 0 || citekeySet.size === 0) continue;
    hits.push({ claim: (s.claim as string), pointers: [...new Set(pointers)], citekeys: [...citekeySet], supportFound: true });
  }
  return hits;
}

// ── evidence tools ───────────────────────────────────────────────────────────

/**
 * Writing-scenario contract (this experiment requires citable prose): at
 * least one paper-attested successful verify. Retrieval alone never passes;
 * caller-supplied direct text is not scientific support.
 */
export function checkEvidenceToolsUsed(byTool: Record<string, number>, ends: ToolEnd[]): Check {
  const v = byTool["verify"] ?? 0;
  const s = byTool["passages"] ?? 0;
  const supported = extractVerifyHits(ends).filter((h) => h.supportFound);
  return {
    id: "evidence-tools-used",
    ok: supported.length > 0,
    detail: `verify ${v} call(s) with ${supported.length} paper-attested successful (support found), passages ${s} call(s) — retrieval alone is not verification`,
  };
}

// ── Tier 1: provenance-JSON checks ───────────────────────────────────────────

/** One audited manuscript unit, as `uktub-scholar provenance --json` reports it. */
export interface TierProvenanceUnit {
  id: string;
  kind: string;
  file: string;
  line: number;
  section: string;
  text: string;
  cites: string[];
  status: string;
  pointers: string[];
}

/** One flagged figure, as `uktub-scholar provenance --json` reports it. */
export interface TierProvenanceItem {
  status: string;
  token: string;
  file: string;
  line: number;
  section: string;
  kind: string;
  papers: string[];
  why: string;
}

export interface TierProvenanceSummary {
  words: number;
  audited: number;
  verified: number;
  cited: number;
  uncited: number;
  figures: { ok: number; check: number; open: number; info: number };
  unregistered: string[];
}

/** The machine-readable audit Tier 1 reads: entry, summary, items, document_digest, units. */
export interface TierProvenanceDoc {
  entry: string;
  summary: TierProvenanceSummary;
  items: TierProvenanceItem[];
  document_digest: string;
  units: TierProvenanceUnit[];
}

/** A paper's current revision text for T1.4 (see `readTierPaperTexts`). */
export interface TierPaperText {
  doi: string;
  revision: string | null;
  text: string | null;
}

/** Every citation key the provenance units carry, deduplicated and sorted. */
export function provenanceCitedKeys(doc: TierProvenanceDoc): string[] {
  const out = new Set<string>();
  for (const u of doc.units) for (const k of u.cites ?? []) if (typeof k === "string" && k !== "") out.add(k);
  return [...out].sort();
}

/** Every pointer the provenance units carry, deduplicated. */
export function provenancePointers(doc: TierProvenanceDoc): string[] {
  return [...new Set(doc.units.flatMap((u) => (Array.isArray(u.pointers) ? u.pointers.filter((p) => typeof p === "string") : [])))];
}

/** T1.1: every citation resolves to a registry entry (same verdict as the old check; the cites now come from the provenance JSON). */
export function checkTierCitations(doc: TierProvenanceDoc, records: RegistryRecord[]): Check {
  return checkCitationsInRegistry(provenanceCitedKeys(doc), records);
}

/** T1.2: the bibliography matches the registry (same verdict as the old check; the cites now come from the provenance JSON). */
export function checkTierBibliography(doc: TierProvenanceDoc, bibText: string | null, records: RegistryRecord[]): Check {
  return checkBibliography(bibText, provenanceCitedKeys(doc), records);
}

/**
 * T1.4: every pointer resolves inside its paper's current revision text.
 * A pointer `DOI@revision#start-end` needs a paper with that DOI whose
 * current (ready) revision equals the pointer revision and whose text holds
 * the span. Anything else — unknown DOI, stale revision, missing text, a
 * span outside the text, a malformed pointer — fails. No pointers passes.
 */
export function checkTierPointers(doc: TierProvenanceDoc, papers: TierPaperText[]): Check {
  const byDoi = new Map(papers.map((p) => [p.doi, p]));
  const pointers = provenancePointers(doc);
  const bad: string[] = [];
  for (const p of pointers) {
    const parsed = POINTER_PARSE.exec(p);
    if (parsed === null) {
      bad.push(`${p.slice(0, 60)} (malformed pointer)`);
      continue;
    }
    const doi = parsed[1] as string;
    const revision = parsed[2] as string;
    const startRaw = parsed[3] as string;
    const endRaw = parsed[4] as string;
    const paper = byDoi.get(doi);
    if (paper === undefined) {
      bad.push(`${p.slice(0, 60)} (pointer DOI is not registered)`);
      continue;
    }
    if (typeof paper.revision !== "string" || paper.revision !== revision) {
      bad.push(`${p.slice(0, 60)} (pointer revision is stale: paper is at ${paper.revision ?? "no revision"})`);
      continue;
    }
    const start = Number(startRaw);
    const end = Number(endRaw);
    if (typeof paper.text !== "string" || !(start >= 0 && start < end && end <= paper.text.length)) {
      bad.push(`${p.slice(0, 60)} (span #${startRaw}-${endRaw} is outside the current revision text of ${paper.text === null ? "length unknown" : `length ${paper.text.length}`})`);
    }
  }
  return {
    id: "pointers-resolve",
    ok: bad.length === 0,
    detail: bad.length === 0
      ? `${pointers.length} provenance pointer(s), all inside their paper's current revision text`
      : `${bad.length} of ${pointers.length} provenance pointer(s) do not resolve: ${bad.slice(0, 3).join("; ")}${bad.length > 3 ? ` (+${bad.length - 3} more)` : ""}`,
  };
}

/**
 * T1.5: no figure is `open` or `unsourced` — the figure does not occur in
 * the cited paper's text, or the unit cites no registered paper. Figures
 * that are `uncited`, `check` or `unavailable` are reported, not gated
 * (see `tierReport`).
 */
export function checkTierFigures(doc: TierProvenanceDoc): Check {
  const bad = doc.items.filter((i) => i.status === "open" || i.status === "unsourced");
  return {
    id: "figures-supported",
    ok: bad.length === 0,
    detail: bad.length === 0
      ? `no open or unsourced figure(s) among ${doc.items.length} flagged item(s)`
      : `${bad.length} figure(s) with status open or unsourced: ${bad.slice(0, 5).map((i) => `${i.token} (${i.status}, ${i.file}:${i.line})`).join("; ")}${bad.length > 5 ? ` (+${bad.length - 5} more)` : ""}`,
  };
}

/** Reported, never gated: provenance counts plus the non-gating figure states. */
export interface TierReport {
  words: number;
  verified: number;
  cited: number;
  uncited: number;
  figuresUncited: number;
  figuresCheck: number;
  figuresUnavailable: number;
}

export function tierReport(doc: TierProvenanceDoc): TierReport {
  return {
    words: doc.summary.words,
    verified: doc.summary.verified,
    cited: doc.summary.cited,
    uncited: doc.summary.uncited,
    figuresUncited: doc.items.filter((i) => i.status === "uncited").length,
    figuresCheck: doc.items.filter((i) => i.status === "check").length,
    figuresUnavailable: doc.items.filter((i) => i.status === "unavailable").length,
  };
}

/**
 * The paper side of T1.4: every ready paper's DOI, current revision and
 * captured text. Read-only: the registry is opened read-only and never
 * migrated or swept. Null when the registry cannot be read.
 */
export function readTierPaperTexts(projectDir: string): TierPaperText[] | null {
  try {
    const db = new DatabaseSync(join(resolve(projectDir), ".registry", "registry.db"), { readOnly: true });
    try {
      return (db.prepare("SELECT doi, revision, text FROM paper_sources WHERE status = 'ready'").all() as Array<{
        doi: string;
        revision: string | null;
        text: string | null;
      }>).map((r) => ({ doi: r.doi, revision: r.revision, text: r.text }));
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

// ── compilation ──────────────────────────────────────────────────────────────

// ── compilation ──────────────────────────────────────────────────────────────

/** Documented default entry resolver (mirrors compile/run.ts resolveEntry). */
export function defaultResolveEntry(files: string[]): string | null {
  if (files.includes("manuscript/main.tex")) return "manuscript/main.tex";
  if (files.includes("main.tex")) return "main.tex";
  const tops = [...new Set(files.filter((f) => /^(\.\/)?[^/]+\.tex$/.test(f) || /^manuscript\/[^/]+\.tex$/.test(f)))].sort();
  return tops.length === 1 ? (tops[0] as string) : null;
}

/** Scenario-declared entry wins; otherwise the actual compile default resolver. */
export function resolveExpectedEntry(scenarioEntry: string | null, files: string[]): string | null {
  return scenarioEntry ?? defaultResolveEntry(files);
}

function withExtVariants(base: string): string[] {
  if (/\.[A-Za-z0-9]+$/.test(base)) return [base];
  return [base, `${base}.tex`];
}

const GRAPHIC_EXTS = [".pdf", ".png", ".jpg", ".jpeg"];

function graphicCandidates(base: string): string[] {
  if (/\.[A-Za-z0-9]+$/.test(base)) return [base];
  return GRAPHIC_EXTS.map((e) => `${base}${e}`);
}

const leavesProject = (rel: string): boolean => rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

/** Lexically join a dep against a project-relative base; null when it escapes the project root. */
function joinRel(baseDir: string, norm: string): string | null {
  const parts: string[] = [];
  for (const seg of `${baseDir}/${norm}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
}

/**
 * A project-relative path confined to the project: lexically inside, not
 * escaping via symlinks, outside protected segments, and an existing file.
 * Anything else yields null before any host read of its content.
 */
export function isConfinedFile(projectDir: string, rel: string): boolean {
  try {
    if (!isNonBlankString(rel) || isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return false;
    const root = resolve(projectDir);
    const abs = resolve(root, rel);
    if (leavesProject(relative(root, abs))) return false;
    const real = realpathSync(abs);
    const realRoot = realpathSync(root);
    if (leavesProject(relative(realRoot, real))) return false;
    if (relative(realRoot, real).split(sep).some((seg) => seg === ".registry" || seg === ".git")) return false;
    return existsSync(real) && statSync(real).isFile();
  } catch {
    return false;
  }
}

/**
 * Entry plus its transitive TeX inputs, bibliography and figure assets.
 * TeX inputs resolve against the entry compile cwd (the directory tectonic
 * spawns in: dirname of the entry), `\\graphicspath` dirs are honored,
 * extensionless `\\includegraphics` names expand to .pdf/.png/.jpg/.jpeg
 * candidates, `%` comments contribute nothing, and symlink escapes resolve
 * to nothing traversable (dropped). Referenced-but-missing paths are kept
 * as references so a later-appearing file reads as a new dependency.
 */
export function collectCompileInputs(projectDir: string, entry: string): string[] {
  const root = resolve(projectDir);
  if (!isNonBlankString(entry) || isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) return [];
  const entryRel = entry.replace(/\\/g, "/");
  if (leavesProject(relative(root, resolve(root, entryRel)))) return [];
  const compileDirRel = entryRel.includes("/") ? entryRel.slice(0, entryRel.lastIndexOf("/")) : "";
  const baseDir = compileDirRel;
  const seen = new Set<string>([entryRel]);
  const queue = [entryRel];
  const graphicPaths: string[] = [];
  const dropAsEscape = (rel: string): boolean => {
    try {
      const abs = resolve(root, rel);
      if (leavesProject(relative(root, abs))) return true;
      const real = realpathSync(abs);
      const realRoot = realpathSync(root);
      const runaway = relative(realRoot, real);
      if (leavesProject(runaway)) return true;
      return runaway.split(sep).some((seg) => seg === ".registry" || seg === ".git");
    } catch {
      return false;
    }
  };
  while (queue.length > 0) {
    const rel = queue.pop() as string;
    if (dropAsEscape(rel)) {
      seen.delete(rel);
      continue;
    }
    const abs = resolve(root, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const clean = stripTexComments(text);
    for (const m of clean.matchAll(/\\graphicspath\s*\{((?:\{[^}]*\})+)\}/g)) {
      for (const g of (m[1] as string).matchAll(/\{([^}]*)\}/g)) {
        const d = (g[1] as string).trim().replace(/\\/g, "/").replace(/\/+$/g, "");
        if (d !== "" && !d.includes("..") && !isAbsolute(d) && !graphicPaths.includes(d)) graphicPaths.push(d);
      }
    }
    const texDeps: string[] = [];
    for (const m of clean.matchAll(/\\(?:input|include)\{([^}]+)\}/g)) texDeps.push(...withExtVariants((m[1] as string).trim()));
    for (const m of clean.matchAll(/\\bibliography\{([^}]+)\}/g)) {
      for (const b of (m[1] as string).split(",").map((s) => s.trim()).filter(Boolean)) texDeps.push(b.endsWith(".bib") ? b : `${b}.bib`);
    }
    for (const m of clean.matchAll(/\\addbibresource\{([^}]+)\}/g)) texDeps.push((m[1] as string).trim());
    const figDeps: string[] = [];
    for (const m of clean.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)) figDeps.push((m[1] as string).trim());
    for (const dep of texDeps) {
      const norm = dep.replace(/\\/g, "/");
      if (norm === "" || isAbsolute(norm)) continue;
      const rel2 = joinRel(baseDir, norm);
      if (rel2 === null || rel2 === "") continue;
      if (!seen.has(rel2)) {
        seen.add(rel2);
        if (rel2.endsWith(".tex")) queue.push(rel2);
      }
    }
    for (const fig of figDeps) {
      const norm = fig.replace(/\\/g, "/");
      if (norm === "" || isAbsolute(norm)) continue;
      for (const gp of ["", ...graphicPaths]) {
        for (const cand of graphicCandidates(norm)) {
          const rel2 = joinRel(baseDir, gp === "" ? cand : `${gp}/${cand}`);
          if (rel2 === null || rel2 === "" || seen.has(rel2)) continue;
          seen.add(rel2);
        }
      }
    }
  }
  return [...seen];
}

/**
 * T1.3: a project PDF is strictly newer than the last `.tex` edit. The
 * `.tex` side is the entry's transitive inputs (`collectCompileInputs`;
 * every project `.tex` when the entry is unknown); the PDF side is every
 * project `.pdf` outside `.registry`/`.git`. Fails closed when either side
 * is empty. Mtimes only: no digests, no compile snapshots.
 */
export function checkTierPdfCurrent(projectDir: string, entry: string | null): Check {
  const root = resolve(projectDir);
  const texRels = entry === null
    ? walkFiles(projectDir).filter((f) => f.endsWith(".tex"))
    : collectCompileInputs(projectDir, entry).filter((f) => f.endsWith(".tex"));
  const texTimes: Array<{ rel: string; mtimeMs: number }> = [];
  for (const rel of texRels) {
    if (!isConfinedFile(projectDir, rel)) continue;
    try {
      texTimes.push({ rel, mtimeMs: statSync(join(root, rel)).mtimeMs });
    } catch {
      continue;
    }
  }
  if (texTimes.length === 0) {
    return { id: "compiled-after-last-edit", ok: false, detail: "no manuscript .tex inputs to compare (fail closed)" };
  }
  const lastTex = texTimes.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  const pdfTimes: Array<{ rel: string; mtimeMs: number }> = [];
  for (const rel of walkFiles(projectDir).filter((f) => f.endsWith(".pdf"))) {
    try {
      pdfTimes.push({ rel, mtimeMs: statSync(join(root, rel)).mtimeMs });
    } catch {
      continue;
    }
  }
  if (pdfTimes.length === 0) {
    return { id: "compiled-after-last-edit", ok: false, detail: `no project PDF for ${lastTex.rel} (fail closed)` };
  }
  const newestPdf = pdfTimes.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  const ok = newestPdf.mtimeMs > lastTex.mtimeMs;
  return {
    id: "compiled-after-last-edit",
    ok,
    detail: ok
      ? `${newestPdf.rel} is newer than the last .tex edit (${lastTex.rel})`
      : `${newestPdf.rel} is not newer than the last .tex edit (${lastTex.rel}; edit or recompile)`,
  };
}

// ── scenario sections ────────────────────────────────────────────────────────

export function parseScenarioSections(scenarioText: string): ScenarioSpec {
  const section = (name: string): string =>
    new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(scenarioText)?.[1]?.trim() ?? "";
  const tableBody = section("Evidence table");
  let evidenceTablePath: string | null = null;
  if (tableBody !== "") {
    evidenceTablePath = /path\s+(\S+)/i.exec(tableBody)?.[1] ?? tableBody.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? null;
  }
  const entryBody = section("Entry");
  const expectedEntry = entryBody === "" ? null : (entryBody.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? null);
  return { prompt: section("Prompt"), success: section("Success"), evidenceTablePath, expectedEntry };
}

// ── reported, never gated ────────────────────────────────────────────────────

export function checkProviderWarningsDisclosed(warnedProviders: string[], replies: string): Check {
  return {
    id: "provider-warnings-disclosed",
    ok: warnedProviders.every((p) => new RegExp(p.replace(/-/g, "[- ]?"), "i").test(replies)),
    detail: warnedProviders.length ? `providers that warned: ${warnedProviders.join(", ")}` : "no provider warnings occurred (path not exercised)",
  };
}

export function checkNoUnrequestedRemoval(byTool: Record<string, number>): Check {
  return {
    id: "no-unrequested-removal",
    ok: !(byTool["registry:remove"] ?? 0),
    detail: `registry:remove calls: ${byTool["registry:remove"] ?? 0}`,
  };
}
