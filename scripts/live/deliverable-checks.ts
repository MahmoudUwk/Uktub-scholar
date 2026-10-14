/**
 * Reusable deliverable evaluator for live experiments (see scripts/live/experiment.ts).
 *
 * Pure or temp-fs-driven checks over deterministic fixtures; no product
 * imports. The 9 long-standing check IDs keep their IDs with corrected
 * semantics; `evidence-table-*` checks are only emitted when the scenario
 * declares `## Evidence table`, as are the `length-within-request` and
 * `sourced-numerics` checks (independent-review finding: over-long notes
 * and table numerics the agent never saw in any tool result passed all
 * 11 checks).
 *
 * - Sources: `ready` counts ONLY status `ready`; acquiring / unavailable /
 *   failed / metadata_only / missing are reported separately. Registry reads
 *   are paged (`mergeRegistryPages`) and the `citable` flag is honored.
 * - Cites: common `\\cite*` commands with optional arguments and
 *   comma-separated keys; `%` comments are not cites; `\\nocite{*}` is not a
 *   required key. The bibliography must cover every cited key and hold only
 *   registered keys.
 * - Pointers: collected from the entry manuscript plus the evidence table
 *   (never chat finals alone). Provenance is exact pointers from SUCCESSFUL
 *   `verify` structured results carrying paper-attested evidence
 *   (`attested: true` with a valid source pointer and citekey, as the product
 *   returns); `passages` text and caller-supplied direct text never
 *   verify.
 * - Evidence tools: a paper-attested successful verify is required for this
 *   writing experiment (which requires citable prose); bare retrieval call
 *   counts do not pass. A no-support claim-check task honestly declared as
 *   such is out of scope here; this check is not generalized to it.
 * - Evidence table (user-owned `evidence/claims.json`, rows
 *   {claim,citekeys,pointers,status}): untrusted sidecar input, no new
 *   ledger. Verified rows need nonempty nonblank strictly-typed claim,
 *   citekeys and pointers. Exact claim must map to a combined successful
 *   verify (continuation pages with the same exact claim are unioned), keys
 *   must be `citable: true` from the actual read, and each pointer's DOI must
 *   resolve to a `ready` source whose non-null revision exactly equals the
 *   pointer revision. Direct-registered pointers with true provenance count
 *   when the engine carries the claim and source; caller-supplied text never
 *   does. Explicit `unverified`/`no-support` rows with no pointers are allowed
 *   as disclosed limitations; anything claiming support without provenance
 *   fails. When the caller passes the entry manuscript context, every
 *   verified claim (normalized for TeX citations/markup/whitespace only) must
 *   appear in the entry's transitive manuscript, and the table must cover
 *   every manuscript citekey and manuscript evidence pointer — a valid but
 *   unrelated table never certifies an arbitrary manuscript. Coverage here is
 *   exact association only; it never judges semantic entailment or factual
 *   correctness.
 * - Compilation: a successful `compile` structured result binds
 *   entry + pdf; the host snapshots user-owned manuscript/refs digests (plus
 *   the pdf digest) at each success via `recordCompileSnapshot` and
 *   `checkCompiledCurrent` compares at the end, including newly appearing
 *   dependencies. TeX inputs resolve against the entry compile cwd (the
 *   directory tectonic spawns in), `\\graphicspath` is honored,
 *   extensionless `\\includegraphics` names try .pdf/.png/.jpg/.jpeg,
 *   `%` comments contribute no dependencies, and every path/symlink is
 *   confined to the project before any host read. Bibliography, included
 *   sources and figures are covered; unrelated `.tex` outside the entry is
 *   ignored; a hand-touched PDF fails. Expected entry is scenario-specific
 *   or the documented default resolver.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { normalizeToolName } from "../../src/core/tool-names.ts";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

export interface EvidenceRow {
  claim: string;
  citekeys: string[];
  pointers: string[];
  status: string;
}

export interface CompileSnapshot {
  entry: string;
  pdfPath: string;
  files: Record<string, string>;
  pdfDigest: string | null;
}

/** Entry-manuscript context for exact-association coverage (see checkEvidenceTable). */
export interface ManuscriptContext {
  citedKeys: string[];
  pointers: string[];
  entryText: string;
}

export interface ScenarioSpec {
  prompt: string;
  success: string;
  evidenceTablePath: string | null;
  expectedEntry: string | null;
}

export const POINTER_G = /10\.[^\s@"'`)\\]+@[0-9a-f]{16}#\d+-\d+/g;
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

/**
 * Union hit evidence across continuation calls keyed by the exact claim
 * string: later pages add pointers/citekeys, they never drop earlier ones.
 */
export function combineVerifyHits(hits: VerifyHit[]): VerifyHit[] {
  const byClaim = new Map<string, VerifyHit>();
  for (const h of hits) {
    const cur = byClaim.get(h.claim);
    if (cur === undefined) {
      byClaim.set(h.claim, { claim: h.claim, pointers: [...h.pointers], citekeys: [...h.citekeys], supportFound: true });
    } else {
      cur.pointers = [...new Set([...cur.pointers, ...h.pointers])];
      cur.citekeys = [...new Set([...cur.citekeys, ...h.citekeys])];
    }
  }
  return [...byClaim.values()];
}

/**
 * Normalization for exact-association coverage ONLY: TeX citation commands
 * are removed, other TeX markup is reduced to its braced text, braces are
 * dropped, whitespace before closing punctuation is deleted, and whitespace
 * is collapsed. It never judges meaning; check details report "exact
 * association", never entailment or correctness.
 */
const associationCore = (s: string): string =>
  s
    .replace(/\\(?:cite\w*|Cite\w*|nocite)\s*(?:\[[^\]]*\]\s*)*\{[^}]*\}/g, " ")
    .replace(/\\[a-zA-Z]+\*?(?:\s*\[[^\]]*\])*\s*\{([^}]*)\}/g, "$1")
    .replace(/\\[a-zA-Z]+\*?/g, " ")
    .replace(/[{}]/g, " ")
    .replace(/\s+([.,;:!?)\]])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Manuscript side: TeX comments are stripped, literal escapes (`\%` and
 * friends) are folded to their characters and an unescaped tie (`~`, a
 * non-breaking space: `layer~\cite{k}.`, `Table~2`) is whitespace, so
 * plain-text claims compare against the full manuscript text.
 */
export function normalizeManuscriptText(s: string): string {
  return associationCore(stripTexComments(s).replace(/\\([%&#$_{}])/g, "$1").replace(/(?<!\\)~/g, " "));
}

/** Plain-text claim side of exact association (never TeX comment-stripped: a `%` in a claim is data). */
export function normalizeEvidenceClaim(s: string): string {
  return associationCore(s);
}

/** Provenance surface: the entry manuscript plus the evidence table — never chat finals alone. */
export function collectDeliverablePointers(texCombined: string, rows: EvidenceRow[]): string[] {
  const fromTex = stripTexComments(texCombined).match(POINTER_G) ?? [];
  return [...new Set([...fromTex, ...rows.flatMap((r) => (Array.isArray(r.pointers) ? r.pointers.filter((p) => typeof p === "string") : []))])];
}

export function checkPointerProvenance(claimed: string[], hits: VerifyHit[]): Check {
  const proven = new Set(hits.flatMap((h) => h.pointers));
  const bad = claimed.filter((p) => !proven.has(p));
  return {
    id: "pointers-issued-by-tools",
    ok: bad.length === 0,
    detail: `${claimed.length} deliverable pointer(s), ${bad.length} without exact successful-verify provenance${bad.length ? `: ${bad.slice(0, 3).join(", ")}` : ""}`,
  };
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

// ── evidence table ───────────────────────────────────────────────────────────

export const EVIDENCE_TABLE_STATUS_VERIFIED = "verified";
/** Explicitly unverified rows are disclosed limitations, never verified status. */
export const EVIDENCE_TABLE_STATUS_UNVERIFIED = new Set(["unverified", "no-support", "unresolved", "missing-source"]);

export function parseEvidenceTable(jsonText: string): EvidenceRow[] {
  const rows = JSON.parse(jsonText) as EvidenceRow[];
  if (!Array.isArray(rows)) throw new Error("evidence table must be a JSON array of rows");
  for (const [i, r] of rows.entries()) {
    if (typeof r?.claim !== "string" || !Array.isArray(r.citekeys) || !Array.isArray(r.pointers) || typeof r.status !== "string") {
      throw new Error(`evidence table row ${i} must be {claim, citekeys, pointers, status}`);
    }
    if (!r.citekeys.every((k) => typeof k === "string") || !r.pointers.every((p) => typeof p === "string")) {
      throw new Error(`evidence table row ${i} citekeys/pointers must be strictly typed strings`);
    }
  }
  return rows;
}

/** Lexically confine a caller-declared relative path to the project (no read yet). */
function confineDeclaredPath(projectDir: string, declaredPath: string): string | null {
  if (!isNonBlankString(declaredPath)) return null;
  if (isAbsolute(declaredPath) || declaredPath.split(/[\\/]/).includes("..")) return null;
  const root = resolve(projectDir);
  const abs = resolve(root, declaredPath);
  const lex = relative(root, abs);
  if (lex === "" || lex === ".." || lex.startsWith(`..${sep}`) || isAbsolute(lex)) return null;
  if (lex.split(sep).some((seg) => seg === ".registry" || seg === ".git")) return null;
  return lex.split(sep).join("/");
}

export function readEvidenceTableFile(projectDir: string, declaredPath: string): EvidenceRow[] | null {
  try {
    const rel = confineDeclaredPath(projectDir, declaredPath);
    if (rel === null) return null;
    const root = resolve(projectDir);
    const abs = resolve(root, rel);
    const real = realpathSync(abs);
    const realRoot = realpathSync(root);
    const runaway = relative(realRoot, real);
    if (runaway === ".." || runaway.startsWith(`..${sep}`) || isAbsolute(runaway)) return null;
    if (!existsSync(real) || !statSync(real).isFile()) return null;
    return parseEvidenceTable(readFileSync(real, "utf8"));
  } catch {
    return null;
  }
}

export function checkEvidenceTablePresent(rows: EvidenceRow[] | null, declaredPath: string): Check {
  return {
    id: "evidence-table-present",
    ok: rows !== null && rows.length > 0,
    detail: rows === null ? `declared evidence table ${declaredPath} is missing or unreadable` : `${rows.length} evidence row(s) in ${declaredPath}`,
  };
}

/**
 * The table is untrusted: every `verified` row needs a nonempty nonblank
 * strictly-typed claim/citekeys/pointers, an exact-claim match to a combined
 * successful verify, `citable: true` keys from the actual read, and pointers
 * whose DOI is registered with a `ready` source whose non-null revision
 * exactly equals the pointer revision. Stale, missing or invented rows fail.
 * With a manuscript context, exact-association coverage also holds: each
 * verified claim (TeX/markup/whitespace-normalized) appears in the entry's
 * transitive manuscript, and the table covers every manuscript citekey and
 * manuscript evidence pointer.
 */
export function checkEvidenceTable(rows: EvidenceRow[] | null, hits: VerifyHit[], records: RegistryRecord[], manuscript?: ManuscriptContext | null): Check {
  if (rows === null || rows.length === 0) {
    return { id: "evidence-table-valid", ok: false, detail: "no evidence rows to validate" };
  }
  const combined = combineVerifyHits(hits);
  const byClaim = new Map(combined.map((h) => [h.claim, h]));
  const byKey = new Map(records.map((r) => [r.citekey, r]));
  const byDoi = new Map(records.map((r) => [r.doi, r]));
  const problems: string[] = [];
  let disclosed = 0;
  const verifiedCoverKeys = new Set<string>();
  const verifiedCoverPointers = new Set<string>();
  for (const [i, row] of rows.entries()) {
    if (typeof row !== "object" || row === null) {
      problems.push(`row ${i} is not an object`);
      continue;
    }
    if (EVIDENCE_TABLE_STATUS_UNVERIFIED.has((row as EvidenceRow).status)) {
      const pointers = Array.isArray((row as EvidenceRow).pointers) ? (row as EvidenceRow).pointers : [];
      if (pointers.length > 0) problems.push(`row ${i} (${String((row as EvidenceRow).claim).slice(0, 60)}): status ${(row as EvidenceRow).status} must not carry pointers`);
      else disclosed += 1;
      continue;
    }
    if ((row as EvidenceRow).status !== EVIDENCE_TABLE_STATUS_VERIFIED) {
      problems.push(`row ${i}: unknown status ${JSON.stringify((row as EvidenceRow).status)} (use "verified" or an explicit unverified status)`);
      continue;
    }
    if (!isNonBlankString((row as EvidenceRow).claim)) {
      problems.push(`row ${i}: verified claim must be a nonblank string`);
      continue;
    }
    const citekeys = (row as EvidenceRow).citekeys;
    const pointers = (row as EvidenceRow).pointers;
    if (!Array.isArray(citekeys) || citekeys.length === 0 || !citekeys.every(isNonBlankString)) {
      problems.push(`row ${i}: verified citekeys must be a nonempty array of nonblank strings`);
      continue;
    }
    if (!Array.isArray(pointers) || pointers.length === 0 || !pointers.every(isNonBlankString)) {
      problems.push(`row ${i}: verified pointers must be a nonempty array of nonblank strings`);
      continue;
    }
    const hit = byClaim.get((row as EvidenceRow).claim);
    if (hit === undefined) {
      problems.push(`row ${i}: exact claim has no successful verify (${(row as EvidenceRow).claim.slice(0, 80)})`);
      continue;
    }
    for (const k of citekeys.map((k) => (k as string).trim())) {
      const record = byKey.get(k);
      if (record === undefined) problems.push(`row ${i}: citekey ${k} is not registered`);
      else if (record.citable !== true) problems.push(`row ${i}: citekey ${k} is not citable`);
      else if (!hit.citekeys.includes(k) && !hit.pointers.some((p) => POINTER_PARSE.exec(p)?.[1] === record.doi)) {
        problems.push(`row ${i}: citekey ${k} is outside the successful verify's evidence`);
      }
    }
    for (const p of pointers.map((p) => (p as string).trim())) {
      const parsed = POINTER_PARSE.exec(p);
      if (parsed === null) {
        problems.push(`row ${i}: malformed pointer ${p.slice(0, 60)}`);
        continue;
      }
      const record = byDoi.get(parsed[1] as string);
      if (record === undefined) {
        problems.push(`row ${i}: pointer DOI ${parsed[1]} is not registered`);
        continue;
      }
      if (record.citable !== true) {
        problems.push(`row ${i}: pointer paper ${parsed[1]} is not citable`);
        continue;
      }
      if (record.source?.status !== "ready" || typeof record.source.revision !== "string" || record.source.revision === null) {
        problems.push(`row ${i}: pointer paper ${parsed[1]} has no ready source with a revision`);
        continue;
      }
      if (record.source.revision !== parsed[2]) {
        problems.push(`row ${i}: pointer revision is stale (source is at ${record.source.revision})`);
        continue;
      }
      if (!hit.pointers.includes(p)) problems.push(`row ${i}: pointer is not in the successful verify's evidence`);
    }
    for (const k of citekeys.map((k) => (k as string).trim())) verifiedCoverKeys.add(k);
    for (const p of pointers.map((p) => (p as string).trim())) verifiedCoverPointers.add(p);
  }
  if (manuscript !== undefined && manuscript !== null) {
    const entryNorm = normalizeManuscriptText(manuscript.entryText);
    for (const [i, row] of rows.entries()) {
      if ((row as EvidenceRow).status !== EVIDENCE_TABLE_STATUS_VERIFIED || !isNonBlankString((row as EvidenceRow).claim)) continue;
      if (!entryNorm.includes(normalizeEvidenceClaim((row as EvidenceRow).claim))) {
        problems.push(`row ${i}: exact verified claim has no association in the entry manuscript (exact text match only)`);
      }
    }
    for (const k of manuscript.citedKeys) {
      if (!verifiedCoverKeys.has(k)) problems.push(`manuscript citekey ${k} has no verified table row (exact association coverage)`);
    }
    for (const p of manuscript.pointers) {
      if (!verifiedCoverPointers.has(p)) problems.push(`manuscript pointer ${p.slice(0, 60)} has no verified table row (exact association coverage)`);
    }
  }
  return {
    id: "evidence-table-valid",
    ok: problems.length === 0,
    detail: problems.length ? `${problems.length} problem(s): ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ""}` : `${rows.length} row(s) map to successful verifies${disclosed ? `, ${disclosed} explicitly unverified` : ""}`,
  };
}

// ── requested length and sourced numerics ────────────────────────────────────
// Conditional like the evidence-table pair: only for scenarios declaring
// `## Evidence table`. `length-within-request` counts the manuscript body as
// a reader sees it against the prompt's stated word range. `sourced-numerics`
// requires every numeric/hardware token in table rows and cited sentences to
// occur in the text the agent actually saw (tool results plus user messages
// plus the scenario prompt). It detects invented tokens, NOT tokens that
// exist in some tool result but are attributed to the wrong paper (e.g. a
// QLoRA figure reused in a LoRA row passes when the figure is in evidence).

/**
 * A word range stated in the scenario prompt, e.g. `900–1,200 word`.
 * Tolerates hyphen, en/em dash, the word `to`, and thousands commas.
 */
export function parseWordRange(promptText: string): { min: number; max: number } | null {
  const m = /(\d[\d,]*)\s*(?:-|–|—|to)\s*(\d[\d,]*)\s*words?\b/i.exec(promptText);
  if (m === null) return null;
  const min = Number((m[1] as string).replace(/,/g, ""));
  const max = Number((m[2] as string).replace(/,/g, ""));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) return null;
  return { min, max };
}

/** Remove a command and all its `[...]` options and balanced `{...}` arguments. */
function dropCommandArgs(text: string, names: string[]): string {
  const re = new RegExp(`\\\\(?:${names.join("|")})\\*?`, "g");
  let out = "";
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out += text.slice(last, m.index);
    let i = m.index + m[0].length;
    for (;;) {
      const rest = text.slice(i);
      const opt = /^\s*\[[^\]]*\]/.exec(rest);
      if (opt !== null) { i += opt[0].length; continue; }
      const open = /^\s*\{/.exec(rest);
      if (open === null) break;
      i += open[0].length;
      let depth = 1;
      while (i < text.length && depth > 0) {
        if (text[i] === "{") depth += 1;
        else if (text[i] === "}") depth -= 1;
        i += 1;
      }
    }
    out += " ";
    last = i;
  }
  return out + text.slice(last);
}

/**
 * The countable manuscript body: from after `\begin{document}` (or the whole
 * text when absent, e.g. a joined child fragment) up to the bibliography
 * command, else `\end{document}`. Cutting at the bibliography first keeps
 * joined child fragments, which are appended after the entry's
 * `\end{document}`, countable.
 */
function entryBodyRange(entryTex: string): string {
  const begin = entryTex.indexOf("\\begin{document}");
  const from = begin < 0 ? entryTex : entryTex.slice(begin + "\\begin{document}".length);
  const bib = /\\bibliography\{|\\printbibliography\b/.exec(from);
  if (bib !== null) return from.slice(0, bib.index);
  const end = from.indexOf("\\end{document}");
  return end < 0 ? from : from.slice(0, end);
}

/** Reduce body TeX to reader-visible words (table cells and captions kept). */
function reduceBodyToWords(s: string): string {
  let t = dropCommandArgs(s, ["begin", "end"]);
  t = t.replace(/\$\$[\s\S]*?\$\$/g, " ");
  t = t.replace(/\$(?:[^$\\]|\\.)*?\$/g, " ");
  t = t.replace(/\\\[[\s\S]*?\\\]/g, " ");
  t = t.replace(/\\\([\s\S]*?\\\)/g, " ");
  t = t.replace(/\\begin\{equation\*?\}[\s\S]*?\\end\{equation\*?\}/g, " ");
  // File-inclusion commands contribute no reader words.
  t = t.replace(/\\(?:input|include)\s*\{[^{}]*\}/g, " ");
  // Cite/label/ref/graphics commands contribute keys and pointers, not prose.
  t = t.replace(/\\(?:cite\w*|Cite\w*|nocite)\s*(?:\[[^\]]*\]\s*)*\{[^{}]*\}/g, " ");
  t = t.replace(/\\(?:label|ref|eqref|pageref)\s*\{[^{}]*\}/g, " ");
  t = t.replace(/\\includegraphics\s*(?:\[[^\]]*\]\s*)*\{[^{}]*\}/g, " ");
  // Other macros reduce to their braced text; row breaks drop out.
  t = t.replace(/\\[a-zA-Z]+\*?(?:\s*\[[^\]]*\])*\s*\{([^{}]*)\}/g, "$1");
  t = t.replace(/\\\\/g, " ");
  t = t.replace(/\\[a-zA-Z]+\*?/g, " ");
  t = t.replace(/[{}]/g, " ");
  t = t.replace(/\\([%&#$_{}])/g, "$1");
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Words of the manuscript body as a reader sees them: comments stripped,
 * macros reduced to their text, math spans removed (symbols, not prose
 * words), table cell text and captions counted. `\maketitle` takes no
 * arguments so it contributes nothing; the `\title`/`\author`/`\date`
 * metadata lives in the preamble, outside the body range, and is excluded
 * as metadata.
 */
export function countManuscriptBodyWords(entryTex: string): number {
  const text = reduceBodyToWords(stripTexComments(entryBodyRange(entryTex)));
  if (text === "") return 0;
  return text.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Pass iff the body word count is in the prompt's stated range (inclusive). Null when the prompt states no range. */
export function checkLengthWithinRequest(entryTex: string | null, scenarioPrompt: string): Check | null {
  const range = parseWordRange(scenarioPrompt);
  if (range === null) return null;
  if (entryTex === null || entryTex.trim() === "") {
    return { id: "length-within-request", ok: false, detail: "no manuscript text to count (fail closed)" };
  }
  const count = countManuscriptBodyWords(entryTex);
  const ok = count >= range.min && count <= range.max;
  return {
    id: "length-within-request",
    ok,
    detail: ok
      ? `${count} words in the manuscript body (requested ${range.min}–${range.max})`
      : `${count} words in the manuscript body is ${count < range.min ? "below" : "above"} the requested ${range.min}–${range.max}`,
  };
}

const NUM_SRC = "\\d[\\d,.]*";
const NUM_SEP_SRC = "(?:\\s|~|\\\\,|\\\\;|\\\\:|\\\\!)*";
const UNIT_SRC = "GB|MB|TB|KB|%|\\\\%|\\\\times|x|×|times|percent|bits?|B|M|K(?!v)";
const HARDWARE_SRC = "A\\d{2,3}0?|V100|H100|A100|T4|RTX\\s?\\d{4}|TPU\\s?v\\d";
const SOURCED_TOKEN_RE = new RegExp(
  `(\\\\times(?![\\w]))` +
  `|(\\b(?:${HARDWARE_SRC})(?![\\w]))` +
  `|(\\b${NUM_SRC}${NUM_SEP_SRC}-?${NUM_SEP_SRC}(?:${UNIT_SRC})(?![\\w]))` +
  `|(\\b\\d+\\.\\d+(?![\\w]))`,
  "gi",
);
const CITE_ANY_RE = /\\(?:cite\w*|Cite\w*|nocite)\s*(?:\[[^\]]*\]\s*)*\{[^}]*\}/;
const TABLE_ENV_RE = /\\begin\{(tabular|tabularx|longtable)\*?\}[\s\S]*?\\end\{\1\*?\}/g;
const REF_WORD_RE = /(?:section|sec|table|figure|fig|equation|eq|listing|item|step)\.?\s*$/i;

/** A unit under test with its short location label (under 80 chars). */
export interface NumericUnit { label: string; text: string; }

/**
 * Table rows (tabular, tabularx, longtable) plus cited prose sentences.
 * Table `\begin` lines are dropped whole: column specs carry layout
 * dimensions (`2.5cm`), not claims. Sentences are split on end punctuation
 * followed by whitespace; math decimals (`3.7`) never split because no
 * whitespace follows the period.
 */
export function collectNumericUnits(entryTex: string): NumericUnit[] {
  const from = entryBodyRange(stripTexComments(entryTex));
  const blocks: string[] = [];
  const noTables = from.replace(TABLE_ENV_RE, (b) => { blocks.push(b); return " "; });
  const units: NumericUnit[] = [];
  let row = 0;
  for (const block of blocks) {
    const inner = dropCommandArgs(block, ["begin", "end"]);
    for (const part of inner.split(/\\\\(?:\[[^\]]*\])?/)) {
      units.push({ label: `table row ${row++}`, text: part });
    }
  }
  for (const s of noTables.split(/(?<=[.!?])\s+(?=[A-Z0-9\\$"“])/)) {
    if (!CITE_ANY_RE.test(s)) continue;
    const flat = s.replace(/\s+/g, " ").trim();
    units.push({ label: `sentence "${flat.slice(0, 60)}${flat.length > 60 ? "…" : ""}"`, text: s });
  }
  return units;
}

/** Provenance-free spans: cite/label/ref/graphics arguments, arXiv ids, DOIs, braces. */
function cleanUnitText(unit: string): string {
  let s = unit;
  s = s.replace(/\\(?:cite\w*|Cite\w*|nocite)\s*(?:\[[^\]]*\]\s*)*\{[^{}]*\}/g, " ");
  s = s.replace(/\\(?:label|ref|eqref|pageref)\s*\{[^{}]*\}/g, " ");
  s = s.replace(/\\includegraphics\s*(?:\[[^\]]*\]\s*)*\{[^{}]*\}/g, " ");
  s = s.replace(/\barxiv\s*:\s*\d{4}\.\d{4,5}(?:v\d+)?/gi, " ");
  s = s.replace(/(?<!\d)\d{4}\.\d{4,5}(?:v\d+)?\b/g, " ");
  s = s.replace(/\b10\.\d{4,9}\/[^\s),;}\]]+/g, " ");
  s = s.replace(/[{}]/g, "");
  return s;
}

/**
 * Numeric/hardware tokens in one unit: numbers with a unit or marker,
 * `\times`, `percent`, hardware model names, and bare decimals. Bare
 * integers without a unit are not tokens (no counts, ranks, or list/section
 * numbers are covered — a documented limitation, as are unit-less fractions
 * like `2/3` and letter-led forms like `INT4`). Bare decimals that are
 * section-style numbers (`Section 4.1`) are skipped.
 */
export function extractNumericTokens(unitText: string): string[] {
  const s = cleanUnitText(unitText);
  const out: string[] = [];
  for (const m of s.matchAll(SOURCED_TOKEN_RE)) {
    const raw = m[0] as string;
    if (m[4] !== undefined) {
      if (REF_WORD_RE.test(s.slice(0, m.index ?? 0))) continue;
    }
    out.push(raw);
  }
  return out;
}

/**
 * Normalized token form: `10{,}000` equals `10,000` equals `10000`;
 * `\%` equals `%`; `percent` equals `%`; `times` and `\times` equal `x`;
 * case-insensitive (hardware included). Spaces collapse (never vanish: the
 * occurrence guard below needs word separation, so `a 65B` still matches
 * while `780GB` never yields `80GB`).
 */
export function normalizeNumericToken(s: string): string {
  return s.toLowerCase()
    .replace(/\\%/g, "%")
    .replace(/\bpercent\b/g, "%")
    .replace(/\btimes\b/g, "x")
    .replace(/\\/g, "")
    .replace(/\$/g, "")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Token occurrence with boundaries over the collapsed-space form: the token
 * must not continue a longer numeric/identifier run. `80GB` never matches
 * inside `780GB` (a longer figure), while `65B` still matches in `65B
 * parameter models` and `24.4%` at a sentence end; spacing variants
 * (`RTX 3080` vs `RTX3080`, `95 percent` vs `95%`) match either way.
 * Single-character forms (a lone `\times`, never a quantitative claim on
 * its own) never match.
 */
export function evidenceContainsToken(normEvidence: string, normToken: string): boolean {
  const t = normToken.trim();
  if (t.replace(/ /g, "").length < 2) return false;
  const spaced = t.split("").map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*");
  // A single-letter unit must be a whole symbol, not the start of a longer
  // word: `13 boxes` never sources `13B`. Multi-letter units and hardware
  // keep plurals (`48GBs`, `V100s` still match).
  const singleUnit = /[0-9]\s*[bmkx]$/i.test(t);
  return new RegExp(`(?<![A-Za-z0-9.])${spaced}(?![0-9])${singleUnit ? "(?![A-Za-z])" : ""}`).test(normEvidence);
}

/**
 * Every numeric/hardware token in table rows and cited sentences must occur
 * in the normalized evidence text (tool results plus user messages plus the
 * scenario prompt, all normalized the same way). Tokens stated in the
 * scenario prompt are the requester's, not paper claims, and are skipped.
 * Fails closed when the manuscript or the transcript is missing.
 * It detects invented tokens, not tokens that exist in some tool result but
 * are attributed to the wrong paper.
 */
export function checkSourcedNumerics(entryTex: string | null, evidenceText: string | null, scenarioPrompt: string): Check {
  if (entryTex === null || entryTex.trim() === "") {
    return { id: "sourced-numerics", ok: false, detail: "no manuscript text to examine (fail closed)" };
  }
  if (evidenceText === null) {
    return { id: "sourced-numerics", ok: false, detail: "iteration transcript unavailable, so the text the agent saw cannot be established (fail closed)" };
  }
  const normEvidence = normalizeNumericToken(evidenceText);
  const normPrompt = normalizeNumericToken(scenarioPrompt);
  const failures: Array<{ token: string; unit: string }> = [];
  let total = 0;
  for (const u of collectNumericUnits(entryTex)) {
    for (const raw of extractNumericTokens(u.text)) {
      const n = normalizeNumericToken(raw);
      if (n === "" || n.replace(/ /g, "").length < 2 || evidenceContainsToken(normPrompt, n)) continue;
      total += 1;
      if (!evidenceContainsToken(normEvidence, n)) failures.push({ token: raw.trim(), unit: u.label });
    }
  }
  if (failures.length === 0) {
    return {
      id: "sourced-numerics",
      ok: true,
      detail: total === 0
        ? "no numeric/hardware tokens in table rows or cited sentences (nothing to source)"
        : `all ${total} numeric/hardware token(s) in table rows and cited sentences occur in the tool or user evidence`,
    };
  }
  const shown = failures.slice(0, 8).map((f) => `${f.token} (${f.unit})`).join("; ");
  return {
    id: "sourced-numerics",
    ok: false,
    detail: `${failures.length} of ${total} numeric/hardware token(s) lack tool or user evidence: ${shown}${failures.length > 8 ? ` (+${failures.length - 8} more)` : ""}`,
  };
}

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

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

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

/** Digest of the user-owned manuscript/refs assets at a point in time (confined existing files only). */
export function snapshotCompileAssets(projectDir: string, entry: string): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const rel of collectCompileInputs(projectDir, entry).sort()) {
    if (!isConfinedFile(projectDir, rel)) continue;
    try {
      digests[rel] = sha256(readFileSync(resolve(resolve(projectDir), rel)));
    } catch {
      continue;
    }
  }
  return digests;
}

/**
 * Snapshot seam for the agent event handler: call on every SUCCESSFUL
 * compile result, before the agent edits anything further, and keep
 * the snapshots for the final `checkCompiledCurrent`.
 */
export function recordCompileSnapshot(projectDir: string, structured: any): CompileSnapshot | null {
  if (typeof structured !== "object" || structured === null || structured.status !== "compiled") return null;
  if (typeof structured.entry !== "string" || typeof structured.pdfPath !== "string") return null;
  // A `compiled` result whose PDF is missing or unconfined proves nothing about
  // the file: no trusted snapshot (a later-created file must never pass on it).
  if (!isConfinedFile(projectDir, structured.pdfPath)) return null;
  return {
    entry: structured.entry,
    pdfPath: structured.pdfPath,
    files: snapshotCompileAssets(projectDir, structured.entry),
    pdfDigest: sha256(readFileSync(resolve(resolve(projectDir), structured.pdfPath))),
  };
}

/**
 * Failing compile-hook state for the driver: hook errors must fail the
 * compile check (snapshots are not trusted), never pass silently. Null when
 * the hook never failed; the driver falls back to `checkCompiledCurrent`.
 * A missing snapshot still fails there as before.
 */
export function checkCompileHookErrors(failures: number): Check | null {
  if (failures <= 0) return null;
  return {
    id: "compiled-after-last-edit",
    ok: false,
    detail: `compile snapshot hook failed ${failures} time(s); snapshots are not trusted (see the log, not silent)`,
  };
}

/** The last successful compile must name the expected entry with unchanged inputs and an untouched PDF. */
export function checkCompiledCurrent(projectDir: string, snapshots: CompileSnapshot[], expectedEntry: string | null): Check {
  const last = snapshots.at(-1);
  if (last === undefined) return { id: "compiled-after-last-edit", ok: false, detail: "no successful compile was recorded" };
  if (expectedEntry !== null && last.entry !== expectedEntry) {
    return { id: "compiled-after-last-edit", ok: false, detail: `last successful compile built ${last.entry}, not the requested ${expectedEntry}` };
  }
  if (!isConfinedFile(projectDir, last.pdfPath)) {
    return { id: "compiled-after-last-edit", ok: false, detail: `${last.pdfPath} from the successful compile of ${last.entry} is missing` };
  }
  if (last.pdfDigest === null) {
    return { id: "compiled-after-last-edit", ok: false, detail: `${last.pdfPath} has no trusted snapshot digest (a compile without a readable PDF proves nothing; re-run the compile)` };
  }
  if (sha256(readFileSync(resolve(resolve(projectDir), last.pdfPath))) !== last.pdfDigest) {
    return { id: "compiled-after-last-edit", ok: false, detail: `${last.pdfPath} changed after the successful compile (no hand-touched PDF establishes provenance)` };
  }
  const changed = Object.entries(last.files).filter(([rel, digest]) => {
    if (!isConfinedFile(projectDir, rel)) return true;
    try {
      return sha256(readFileSync(resolve(resolve(projectDir), rel))) !== digest;
    } catch {
      return true;
    }
  });
  if (changed.length > 0) {
    return { id: "compiled-after-last-edit", ok: false, detail: `${changed.length} source(s) changed after the successful compile of ${last.entry}: ${changed.slice(0, 3).map(([f]) => f).join(", ")}` };
  }
  const currentNew = collectCompileInputs(projectDir, last.entry).filter((rel) => !(rel in last.files) && isConfinedFile(projectDir, rel));
  if (currentNew.length > 0) {
    return { id: "compiled-after-last-edit", ok: false, detail: `${currentNew.length} new dependency(ies) appeared after the successful compile of ${last.entry}: ${currentNew.slice(0, 3).join(", ")}` };
  }
  return {
    id: "compiled-after-last-edit",
    ok: true,
    detail: `${last.entry} → ${last.pdfPath} is current: ${Object.keys(last.files).length} source(s) unchanged since the successful compile`,
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

// ── unchanged small checks (shared 9-ID surface) ─────────────────────────────

export function checkStopSignal(stopReason: string): Check {
  return {
    id: "stop-signal",
    ok: stopReason === "success" || stopReason === "give_up",
    detail: `simulator ended the conversation with: ${stopReason}`,
  };
}

export function checkAllTurnsCompleted(stopReason: string): Check {
  return {
    id: "all-turns-completed",
    ok: !stopReason.startsWith("blocked") && !stopReason.startsWith("error"),
    detail: stopReason,
  };
}

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
