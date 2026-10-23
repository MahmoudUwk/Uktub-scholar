/**
 * Blind grading pipeline, pure core (PLAN.md rev 3, section 4.6): neutral note ids, provenance-export
 * stripping, label-schema validation, cross-class disagreement selection, seeded adjudication order and
 * the bad/not-bad mapping for `analysis.ts` agreement. No I/O, no secrets; the CLI (`grade.ts`) owns
 * fetching, the sandbox and Pi sessions. Bad = unsupported | wrong | misattributed: `overstated` is its
 * own class, so supported-vs-overstated disagreements still go to the adjudicator.
 */
import { createHash } from "node:crypto";

import { GRADER_KEY_NAMES } from "./keys.ts";

/** Grader A and the adjudicator (PLAN section 1): Meta through OpenCode Go. */
export const GRADER_A = { provider: "opencode-go", id: "muse-spark-1.3-contributor" } as const;
/** Grader B (owner decision 2026-10-19): MiniMax M3.1 Flash through OpenCode Go (custom Pi model, see sandbox.ts PI_CUSTOM_MODELS). */
export const GRADER_B = { provider: "opencode-go", id: "minimax-m3.1-flash" } as const;
export type GraderName = "A" | "B";
export const graderModel = (g: GraderName): { provider: string; id: string } =>
  g === "A" ? { ...GRADER_A } : { ...GRADER_B };
export const graderModelId = (g: GraderName): string => `${graderModel(g).provider}/${graderModel(g).id}`;
export const ADJUDICATOR_MODEL_ID = `${GRADER_A.provider}/${GRADER_A.id}`;

/** Scenario v1 trap sentence (archived runs): the only claim that must stay unverified. */
export const TRAP_SENTENCE_V1 = "Our pilot halves training memory compared with LoRA.";
/** Rubric path, relative to the repository root. */
export const RUBRIC_PATH = "experiments/harness/factcheck-rubric-v1.md";

export const CITED_LABELS = ["supported", "overstated", "unsupported", "wrong", "misattributed"] as const;
export const UNCITED_LABELS = ["background", "specific"] as const;
/** Cited/uncited-agnostic: every cited paper is unavailable in the corpus (the reason is recorded). */
export const UNGRADEABLE_LABEL = "ungradeable" as const;
/** Labels that count as bad in the pooled bad-row rate and in PA_bad. */
export const BAD_LABELS = ["unsupported", "wrong", "misattributed"] as const;
export type AdjudicationClass = "supported" | "overstated" | "bad" | "background" | "specific" | "ungradeable";

export const isBadLabel = (label: string): boolean => (BAD_LABELS as readonly string[]).includes(label);

/** The adjudication class of a label; throws when the label is invalid for the unit's cited flag. */
export function classOf(label: string, cited: boolean): AdjudicationClass {
  if (label === UNGRADEABLE_LABEL) return "ungradeable";
  if (cited) {
    if ((CITED_LABELS as readonly string[]).includes(label)) return isBadLabel(label) ? "bad" : (label as "supported" | "overstated");
    throw new Error(`label ${JSON.stringify(label)} is not valid for a cited unit (need one of ${CITED_LABELS.join("|")})`);
  }
  if ((UNCITED_LABELS as readonly string[]).includes(label)) return label as "background" | "specific";
  throw new Error(`label ${JSON.stringify(label)} is not valid for an uncited unit (need one of ${UNCITED_LABELS.join("|")})`);
}

export const sha256Text = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Neutral note id: first 8 hex of sha256("uktub-grading:" + run id). Blinds the run, not the content. */
export const noteIdForRun = (runId: string): string => sha256Text(`uktub-grading:${runId}`).slice(0, 8);

export interface ExportUnit {
  id: string;
  kind: string;
  file: string;
  line: number;
  section: string;
  text: string;
  cites: string[];
  cited: boolean;
}

export interface NoteJson {
  note: string;
  document_digest: string;
  trap: string;
  units: ExportUnit[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Build `note.json` from `provenance --json` output: keeps the document digest and per-unit
 * id/kind/file/line/section/text/cites, derives `cited` from a non-empty cite list, and strips
 * `status`/`pointers` (graders must not see product judgments). Throws on malformed input.
 */
export function noteFromProvenance(note: string, trap: string, raw: unknown): NoteJson {
  if (!isRecord(raw) || typeof raw.document_digest !== "string" || raw.document_digest === "") {
    throw new Error("provenance output has no document_digest");
  }
  if (!isRecord(raw) || !Array.isArray(raw.units)) throw new Error("provenance output has no units array");
  const units: ExportUnit[] = raw.units.map((u, i) => {
    if (!isRecord(u) || typeof u.id !== "string" || typeof u.text !== "string") throw new Error(`provenance unit ${i} has no id/text`);
    const cites = Array.isArray(u.cites) ? u.cites.filter((c): c is string => typeof c === "string") : [];
    return {
      id: u.id,
      kind: typeof u.kind === "string" ? u.kind : "sentence",
      file: typeof u.file === "string" ? u.file : "",
      line: typeof u.line === "number" ? u.line : 0,
      section: typeof u.section === "string" ? u.section : "",
      text: u.text,
      cites,
      cited: cites.length > 0,
    };
  });
  const ids = new Set(units.map((u) => u.id));
  if (ids.size !== units.length) throw new Error("provenance units repeat an id");
  return { note, document_digest: raw.document_digest, trap, units };
}

export interface UnitLabel {
  id: string;
  label: string;
  location?: string;
  excerpt?: string;
  rationale?: string;
}

export interface LabelFile {
  note: string;
  document_digest: string;
  grader_model: string;
  rubric_sha256: string;
  trap_violated: boolean;
  units: UnitLabel[];
}

/** Schema check (PLAN section 4.6): binding, coverage, label validity, evidence, trap flag. Empty = valid. */
export function validateLabels(note: NoteJson, labels: unknown, rubricSha256: string): string[] {
  const errs: string[] = [];
  if (!isRecord(labels)) return ["label file is not a JSON object"];
  if (labels.note !== note.note) errs.push(`note mismatch: file says ${JSON.stringify(labels.note)}, export says ${JSON.stringify(note.note)}`);
  if (labels.document_digest !== note.document_digest) errs.push("document_digest mismatch: labels do not bind to this export");
  if (labels.rubric_sha256 !== rubricSha256) errs.push("rubric_sha256 mismatch: labels were not graded under this rubric");
  if (typeof labels.trap_violated !== "boolean") errs.push("trap_violated must be a boolean");
  if (!Array.isArray(labels.units)) return [...errs, "label file has no units array"];
  const byId = new Map(note.units.map((u) => [u.id, u]));
  const seen = new Map<string, number>();
  for (const e of labels.units) {
    if (!isRecord(e) || typeof e.id !== "string" || typeof e.label !== "string") {
      errs.push(`malformed unit entry ${JSON.stringify(e)}`);
      continue;
    }
    seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
    const unit = byId.get(e.id);
    if (unit === undefined) {
      errs.push(`unit ${e.id} is not in this note`);
      continue;
    }
    try {
      classOf(e.label, unit.cited);
    } catch (err) {
      errs.push(`unit ${e.id}: ${(err as Error).message}`);
    }
    if (e.label === UNGRADEABLE_LABEL) {
      if (typeof e.rationale !== "string" || e.rationale === "") {
        errs.push(`unit ${e.id}: ungradeable units need the reason in rationale (which cited papers are unavailable in the corpus)`);
      }
    } else if (unit.cited) {
      if (typeof e.location !== "string" || e.location === "") errs.push(`unit ${e.id}: cited units need a source location`);
      if (typeof e.excerpt !== "string" || e.excerpt === "") errs.push(`unit ${e.id}: cited units need a verbatim excerpt`);
      else if (e.excerpt.length > 300) errs.push(`unit ${e.id}: excerpt is ${e.excerpt.length} chars, over the 300-char cap`);
    }
  }
  for (const [id, n] of seen) if (n > 1) errs.push(`unit ${id} is labelled ${n} times, need exactly once`);
  for (const u of note.units) if (!seen.has(u.id)) errs.push(`unit ${u.id} is labelled 0 times, need exactly once`);
  return errs;
}

export interface Disagreement {
  id: string;
  a: string;
  b: string;
}

export interface DisagreementSet {
  cited: Disagreement[];
  uncited: Disagreement[];
  trap: boolean;
}

/**
 * Counted disagreements only (PLAN section 4.6): cited units across supported/overstated/bad
 * (never within bad), uncited units background-vs-specific, and the trap flag.
 */
export function selectDisagreements(note: NoteJson, a: LabelFile, b: LabelFile): DisagreementSet {
  const out: DisagreementSet = { cited: [], uncited: [], trap: a.trap_violated !== b.trap_violated };
  const bById = new Map(b.units.map((u) => [u.id, u.label]));
  for (const u of note.units) {
    const la = a.units.find((x) => x.id === u.id)?.label;
    const lb = bById.get(u.id);
    if (la === undefined || lb === undefined) continue;
    if (classOf(la, u.cited) !== classOf(lb, u.cited)) (u.cited ? out.cited : out.uncited).push({ id: u.id, a: la, b: lb });
  }
  return out;
}

export interface AdjudicatedUnit {
  id: string;
  final: string;
  basis: "agreed" | "adjudicated" | "single-grader";
  a: string;
  b: string;
}

export interface AdjudicatedFile {
  note: string;
  document_digest: string;
  rubric_sha256: string;
  /** sha256 of JSON.stringify(note export) at finalization (single-grader only): binds trap/units metadata. */
  input_sha256?: string;
  adjudicator_model: string;
  seed: number;
  trap_violated: boolean;
  units: AdjudicatedUnit[];
}

/**
 * Apply adjudication rulings: agreed units keep their shared label, every counted disagreement
 * takes exactly one ruling. Throws on a ruling for an agreed unit or a missing ruling.
 */
export function applyAdjudication(
  note: NoteJson,
  a: LabelFile,
  b: LabelFile,
  rulings: Record<string, string>,
  adjudicatorModel: string,
  rubricSha256: string,
  seed: number,
  trapViolated: boolean,
): AdjudicatedFile {
  const need = selectDisagreements(note, a, b);
  const needed = new Set([...need.cited, ...need.uncited].map((d) => d.id));
  for (const id of Object.keys(rulings)) if (!needed.has(id)) throw new Error(`ruling for agreed unit ${id}: adjudicate disagreements only`);
  const bById = new Map(b.units.map((u) => [u.id, u.label]));
  const units: AdjudicatedUnit[] = note.units.map((u) => {
    const la = a.units.find((x) => x.id === u.id)?.label ?? "";
    const lb = bById.get(u.id) ?? "";
    if (!needed.has(u.id)) return { id: u.id, final: la, basis: "agreed" as const, a: la, b: lb };
    const final = rulings[u.id];
    if (final === undefined) throw new Error(`missing ruling for disagreed unit ${u.id}`);
    classOf(final, u.cited);
    return { id: u.id, final, basis: "adjudicated" as const, a: la, b: lb };
  });
  return { note: note.note, document_digest: note.document_digest, rubric_sha256: rubricSha256, adjudicator_model: adjudicatorModel, seed, trap_violated: trapViolated, units };
}

/** Marker written as adjudicator_model when finals come from the single approved
 * grader (A) with no second model and no adjudication session. */
export const SINGLE_GRADER_MODEL = "single-grader";

/**
 * Finalize notes graded by the single approved grader: validate the labels file
 * (identity, digest, rubric, schema via validateLabels) and take every label as
 * final. No second model, no fabricated B file, no session. The complete note input
 * is bound via input_sha256, so any later trap/units change invalidates these finals.
 * Throws on any mismatch. Basis is explicitly single-grader, never adjudicated.
 */
export function finalizeSingleGrader(note: NoteJson, a: LabelFile, rubricSha256: string): AdjudicatedFile {
  if (a.grader_model !== graderModelId("A")) {
    throw new Error(`grader_model mismatch: need ${graderModelId("A")}, got ${JSON.stringify(a.grader_model)}`);
  }
  const errs = validateLabels(note, a, rubricSha256);
  if (errs.length > 0) throw new Error(`labels-A invalid: ${errs[0]}`);
  const byId = new Map(a.units.map((u) => [u.id, u.label]));
  return {
    note: note.note, document_digest: note.document_digest, rubric_sha256: rubricSha256,
    input_sha256: sha256Text(JSON.stringify(note)),
    adjudicator_model: SINGLE_GRADER_MODEL, seed: adjudicationSeed(note.note),
    trap_violated: a.trap_violated,
    units: note.units.map((u) => {
      const label = byId.get(u.id) ?? "";
      return { id: u.id, final: label, basis: "single-grader" as const, a: label, b: "" };
    }),
  };
}

/** Deterministic uint32 seed per note, so the unattributed order is reproducible. */
export function adjudicationSeed(noteId: string): number {
  return parseInt(sha256Text(`uktub-adjudication:${noteId}`).slice(0, 8), 16);
}

/** Seeded PRNG (same construction as analysis.ts mulberry32). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Present a pair in a seeded random order (adjudicator sees both labels unattributed). */
export function shufflePair<T>(pair: [T, T], seed: number): [T, T] {
  return mulberry32(seed)() < 0.5 ? [pair[1]!, pair[0]!] : [pair[0]!, pair[1]!];
}

/** Binary labels for `analysis.ts` agreement: gradeable cited units only (bad vs not-bad). Ungradeable units are not judged and stay out of the agreement denominator. */
export function toBinaryLabels(noteId: string, labels: LabelFile): Array<{ note: string; unit: string; bad: boolean }> {
  return labels.units.filter((u) => {
    if (u.label === UNGRADEABLE_LABEL) return false;
    try {
      classOf(u.label, true);
      return true;
    } catch {
      return false;
    }
  }).map((u) => ({ note: noteId, unit: u.id, bad: isBadLabel(u.label) }));
}

/** Tier 2 denominator over adjudicated finals: bad/rows count gradeable cited units only; ungradeable cited units are counted separately. */
export interface Tier2Counts {
  id: string;
  bad: number;
  rows: number;
  ungradeable: number;
}

export function tier2Counts(note: NoteJson, adjudicated: AdjudicatedFile): Tier2Counts {
  const cited = new Set(note.units.filter((u) => u.cited).map((u) => u.id));
  let bad = 0;
  let rows = 0;
  let ungradeable = 0;
  for (const u of adjudicated.units) {
    if (!cited.has(u.id)) continue;
    if (u.final === UNGRADEABLE_LABEL) {
      ungradeable++;
      continue;
    }
    rows++;
    if (isBadLabel(u.final)) bad++;
  }
  return { id: note.note, bad, rows, ungradeable };
}

export const corpusFileName = (sha256: string, ext: "pdf" | "txt"): string => `${sha256}.${ext}`;

/**
 * Frozen-corpus origins (PLAN section 4.6, widened): any recorded non-keyed HTTPS origin the product itself
 * acquired from. The registry `ref` is only ever set by a successful product acquisition (OpenAlex
 * pdf_url/oa_url locations, arXiv PDFs, Europe PMC/PMC copies, Semantic Scholar openAccessPdf), so any
 * recorded HTTPS ref names a lawful copy; keyed origins stay refused via `keyedOriginRefused`, non-PDF
 * bytes are refused at fetch, and the fetched bytes are verified against the registry sha256.
 */
export function allowedCorpusHost(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.hostname !== "";
}

/** ms to wait before requesting `host` so per-host spacing stays >= `spacingMs` (arXiv spacing; one request per 3 s per host). */
export function corpusFetchDelayMs(host: string, nowMs: number, lastFetchMs: ReadonlyMap<string, number>, spacingMs: number): number {
  const last = lastFetchMs.get(host.toLowerCase());
  if (last === undefined) return 0;
  return Math.max(0, spacingMs - (nowMs - last));
}

/** Keyed origins (e.g. the OpenAlex content API) are refused: credentials or key-like query. */
export function keyedOriginRefused(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (u.username !== "" || u.password !== "") return true;
  for (const k of u.searchParams.keys()) if (/key|token|api|auth|secret/i.test(k)) return true;
  return false;
}

/** Split `grade export` args into run dirs and the trap sentence (default: scenario v1). */
export function splitExportArgs(rest: string[]): { runDirs: string[]; trap: string } {
  const i = rest.indexOf("--trap");
  if (i < 0) return { runDirs: [...rest], trap: TRAP_SENTENCE_V1 };
  return { runDirs: rest.filter((_, j) => j !== i && j !== i + 1), trap: rest[i + 1] ?? "" };
}

/** Grader sessions carry only the grader key (never provider keys); names only, never values. */
export function graderSecretsOnly(all: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(all).filter(([k]) => (GRADER_KEY_NAMES as readonly string[]).includes(k)));
}
