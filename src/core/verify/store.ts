/**
 * Source / chunk / judgment / evidence store (KTD4–KTD5, KTD8–KTD9): the only
 * writer of the v3 evidence tables.
 *
 * Model: a ready paper has ONE captured text (`paper_sources`) whose revision
 * is H(source digest, extraction identity, text). Chunks and the FTS index are
 * derived from it, content-addressed, and rebuilt on any change. Evidence and
 * pointers name (doi, revision, span); a replaced revision resolves as
 * `stale`, never as the new text. Judgments are a pure compute cache keyed by
 * decision identity; evidence is stored with its own decision so it never
 * depends on a cache row.
 *
 * Every multi-row write is one `BEGIN IMMEDIATE` transaction. Callers prepare
 * (network, parsing, model work) BEFORE calling in, and run these writes
 * through the package write queue (KTD9).
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ChunkTextConfig } from "../chunk.ts";
import { chunkDocument } from "../chunk-document.ts";
import type { SectionMark } from "../sections.ts";
import { detectHeadings } from "../source/headings.ts";
import { bumpGeneration } from "../registry.ts";
import type { PreparedSource } from "../source/prepare.ts";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const normalizeWs = (s: string): string => s.trim().replace(/\s+/g, " ");

export const claimHashOf = (claim: string): string => sha256(normalizeWs(claim));
export const passageHashOf = (text: string): string => sha256(text);
/** Pointer revision: binds the acquired bytes, the extractor, and the captured text. */
export const revisionOf = (digest: string, extraction: string, text: string): string =>
  sha256(`${digest}\0${extraction}\0${sha256(text)}`).slice(0, 16);
/** Version of the structure-aware chunking (splitter rules, heading detector, minimum-piece share):
 *  bump it when any of them changes so stored section chunks rebuild. */
export const SECTION_CHUNKING_VERSION = "sections-v1";
/** Chunk policy identity: any change to these fields rebuilds chunks under new ids.
 *  Fixed-window policies keep their original identity; section policies add the structure version. */
export const chunkPolicyOf = (cfg: ChunkTextConfig): string =>
  sha256(
    JSON.stringify(
      cfg.boundary === "section"
        ? [cfg.chunk_tokens, cfg.overlap_tokens, cfg.chars_per_token, cfg.boundary, SECTION_CHUNKING_VERSION]
        : [cfg.chunk_tokens, cfg.overlap_tokens, cfg.chars_per_token, cfg.boundary],
    ),
  ).slice(0, 12);

/** Client policy: a chunk with fewer non-space characters than this cannot
 *  support a claim and is not stored as a usable passage. */
export const MIN_CHUNK_CHARS = 20;

// ── pointers ────────────────────────────────────────────────────────────────

/** `doi@revision#start-end`: zero-based, end-exclusive UTF-16 offsets into the captured text. */
export const formatPointer = (doi: string, revision: string, start: number, end: number): string => `${doi}@${revision}#${start}-${end}`;

export function parsePointer(pointer: string): { doi: string; revision: string; start: number; end: number } | null {
  const m = /^(.+)@([0-9a-f]{16})#(\d+)-(\d+)$/.exec(pointer);
  if (m === null) return null;
  const start = Number(m[3]);
  const end = Number(m[4]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < end ? { doi: m[1], revision: m[2], start, end } : null;
}

// ── rows ────────────────────────────────────────────────────────────────────

export interface SourceRow {
  doi: string;
  status: "ready" | "unavailable" | "failed";
  kind: string | null;
  ref: string | null;
  license: string | null;
  digest: string | null;
  extraction: string | null;
  revision: string | null;
  chunkPolicy: string | null;
  preparedAt: string;
  failureCode: string | null;
  failureDetail: string | null;
  textLength: number | null;
}

export interface StoredChunk {
  doi: string;
  chunk_index: number;
  chunk_id: string;
  revision: string;
  char_start: number;
  char_end: number;
  est_tokens: number;
  content_hash: string;
  text: string;
  /** Heading of the section the chunk starts in; null for fixed-window policies. */
  section: string | null;
}

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // the original error is the report
    }
    throw err;
  }
}

const paperExists = (db: DatabaseSync, doi: string): boolean => db.prepare("SELECT 1 FROM papers WHERE doi = ?").get(doi) !== undefined;

export function getSource(db: DatabaseSync, doi: string): SourceRow | null {
  const r = db
    .prepare(
      `SELECT doi, status, kind, ref, license, digest, extraction, revision, chunk_policy, prepared_at, failure_code, failure_detail,
              CASE WHEN text IS NULL THEN NULL ELSE length(text) END AS text_length
       FROM paper_sources WHERE doi = ?`,
    )
    .get(doi) as Record<string, string | number | null> | undefined;
  if (r === undefined) return null;
  return {
    doi: r.doi as string,
    status: r.status as SourceRow["status"],
    kind: r.kind as string | null,
    ref: r.ref as string | null,
    license: r.license as string | null,
    digest: r.digest as string | null,
    extraction: r.extraction as string | null,
    revision: r.revision as string | null,
    chunkPolicy: r.chunk_policy as string | null,
    preparedAt: r.prepared_at as string,
    failureCode: r.failure_code as string | null,
    failureDetail: r.failure_detail as string | null,
    textLength: r.text_length === null ? null : Number(r.text_length),
  };
}

/** The captured text of a ready source with its page offsets — internal use only; never an output surface. */
export function getSourceText(db: DatabaseSync, doi: string): { revision: string; text: string; pageStarts: number[] | null } | null {
  const r = db.prepare("SELECT revision, text, page_starts_json FROM paper_sources WHERE doi = ? AND status = 'ready'").get(doi) as
    | { revision: string; text: string; page_starts_json: string | null }
    | undefined;
  return r === undefined ? null : { revision: r.revision, text: r.text, pageStarts: r.page_starts_json === null ? null : (JSON.parse(r.page_starts_json) as number[]) };
}

export function chunksOf(db: DatabaseSync, doi: string): StoredChunk[] {
  return db
    .prepare("SELECT doi, chunk_index, chunk_id, revision, char_start, char_end, est_tokens, content_hash, text, section FROM chunks WHERE doi = ? ORDER BY chunk_index")
    .all(doi) as unknown as StoredChunk[];
}

/** Replace the derived chunks of a ready paper under `cfg`. Caller holds the transaction. */
function writeChunks(db: DatabaseSync, doi: string, revision: string, text: string, sections: SectionMark[] | null, cfg: ChunkTextConfig): number {
  const policy = chunkPolicyOf(cfg);
  db.prepare("DELETE FROM chunks WHERE doi = ?").run(doi);
  const ins = db.prepare(
    "INSERT INTO chunks (doi, chunk_index, chunk_id, revision, char_start, char_end, est_tokens, content_hash, text, section) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  let n = 0;
  for (const c of chunkDocument(text, sections, cfg)) {
    if (c.text.replace(/\s+/g, "").length < MIN_CHUNK_CHARS) continue;
    const id = sha256(`${doi}|${revision}|${policy}|${c.char_start}|${c.char_end}`).slice(0, 16);
    ins.run(doi, n++, id, revision, c.char_start, c.char_end, c.est_tokens, c.content_hash, c.text, c.section);
  }
  db.prepare("UPDATE paper_sources SET chunk_policy = ? WHERE doi = ?").run(policy, doi);
  return n;
}

// ── publication ─────────────────────────────────────────────────────────────

/**
 * Publish a prepared source: capture the text, derive chunks, drop evidence
 * bound to any older revision. Identical source + policy is a no-op. Returns
 * null (writing nothing) when the paper was removed while preparation ran.
 */
export function publishSource(
  db: DatabaseSync,
  doi: string,
  source: PreparedSource,
  cfg: ChunkTextConfig,
  now: Date,
): { revision: string; chunkCount: number; reused: boolean } | null {
  return inTransaction(db, () => {
    if (!paperExists(db, doi)) return null;
    const revision = revisionOf(source.digest, source.extraction, source.text);
    const policy = chunkPolicyOf(cfg);
    const sections = source.sections === undefined || source.sections === null || source.sections.length === 0 ? null : source.sections;
    const sectionsJson = sections === null ? null : JSON.stringify(sections);
    const cur = db.prepare("SELECT status, revision, chunk_policy, sections_json FROM paper_sources WHERE doi = ?").get(doi) as
      | { status: string; revision: string | null; chunk_policy: string | null; sections_json: string | null }
      | undefined;
    if (cur?.status === "ready" && cur.revision === revision) {
      if (cur.chunk_policy === policy && cur.sections_json === sectionsJson) {
        const n = (db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE doi = ?").get(doi) as { n: number }).n;
        return { revision, chunkCount: Number(n), reused: true };
      }
      db.prepare("UPDATE paper_sources SET sections_json = ? WHERE doi = ?").run(sectionsJson, doi);
      const chunkCount = writeChunks(db, doi, revision, source.text, sections, cfg);
      bumpGeneration(db);
      return { revision, chunkCount, reused: false };
    }
    db.prepare(
      `INSERT INTO paper_sources (doi, status, kind, ref, license, digest, extraction, revision, chunk_policy, text, page_starts_json, sections_json, prepared_at, failure_code, failure_detail)
       VALUES (?, 'ready', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(doi) DO UPDATE SET status='ready', kind=excluded.kind, ref=excluded.ref, license=excluded.license, digest=excluded.digest,
         extraction=excluded.extraction, revision=excluded.revision, chunk_policy=NULL, text=excluded.text, page_starts_json=excluded.page_starts_json,
         sections_json=excluded.sections_json, prepared_at=excluded.prepared_at, failure_code=NULL, failure_detail=NULL`,
    ).run(doi, source.kind, source.ref, source.license, source.digest, source.extraction, revision, source.text, source.pageStarts === null ? null : JSON.stringify(source.pageStarts), sectionsJson, iso(now));
    db.prepare("DELETE FROM claim_evidence WHERE doi = ? AND revision != ?").run(doi, revision);
    const chunkCount = writeChunks(db, doi, revision, source.text, sections, cfg);
    bumpGeneration(db);
    return { revision, chunkCount, reused: false };
  });
}

/** Record why a paper has no usable source. A ready source is never replaced by a failure. */
export function recordSourceFailure(
  db: DatabaseSync,
  doi: string,
  status: "unavailable" | "failed",
  code: string,
  detail: string,
  now: Date,
  kind: string | null = null,
): void {
  inTransaction(db, () => {
    if (!paperExists(db, doi)) return;
    const cur = db.prepare("SELECT status FROM paper_sources WHERE doi = ?").get(doi) as { status: string } | undefined;
    if (cur?.status === "ready") return;
    db.prepare(
      `INSERT INTO paper_sources (doi, status, kind, prepared_at, failure_code, failure_detail) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(doi) DO UPDATE SET status=excluded.status, kind=excluded.kind, prepared_at=excluded.prepared_at, failure_code=excluded.failure_code, failure_detail=excluded.failure_detail`,
    ).run(doi, status, kind, iso(now), code, detail);
    bumpGeneration(db);
  });
}

/** Rebuild chunks from the captured text when the chunk policy changed. A PDF source stored before
 *  section marks existed gets them derived from its text (the detector is a pure function of the
 *  text); other extractions cannot be re-derived and stay unmarked. */
export function ensureChunks(db: DatabaseSync, doi: string, cfg: ChunkTextConfig): void {
  inTransaction(db, () => {
    const cur = db.prepare("SELECT status, revision, chunk_policy, text, extraction, sections_json FROM paper_sources WHERE doi = ?").get(doi) as
      | { status: string; revision: string | null; chunk_policy: string | null; text: string | null; extraction: string | null; sections_json: string | null }
      | undefined;
    if (cur?.status !== "ready" || cur.revision === null || cur.text === null || cur.chunk_policy === chunkPolicyOf(cfg)) return;
    let sections: SectionMark[] | null = cur.sections_json === null ? null : (JSON.parse(cur.sections_json) as SectionMark[]);
    if (sections === null && cfg.boundary === "section" && cur.extraction?.startsWith("unpdf@")) {
      const found = detectHeadings(cur.text);
      if (found.length > 0) {
        sections = found;
        db.prepare("UPDATE paper_sources SET sections_json = ? WHERE doi = ?").run(JSON.stringify(found), doi);
      }
    }
    writeChunks(db, doi, cur.revision, cur.text, sections, cfg);
    bumpGeneration(db);
  });
}

// ── pointers resolve ────────────────────────────────────────────────────────

export type ResolvedPointer =
  | { status: "current"; doi: string; revision: string; start: number; end: number; text: string; page: number | null }
  | { status: "stale"; doi: string; currentRevision: string }
  | { status: "removed" | "unavailable" | "invalid" };

/** Page (1-based) containing `offset`, from the source's grounded page starts. */
export function pageOf(pageStarts: number[] | null, offset: number): number | null {
  if (pageStarts === null || pageStarts.length === 0) return null;
  let page = 1;
  for (let i = 0; i < pageStarts.length; i++) if (pageStarts[i] <= offset) page = i + 1;
  return page;
}

/** Reconstruct the exact captured span a pointer names, or say why it cannot be. */
export function resolvePointer(db: DatabaseSync, pointer: string): ResolvedPointer {
  const p = parsePointer(pointer);
  if (p === null) return { status: "invalid" };
  if (!paperExists(db, p.doi)) return { status: "removed" };
  const row = db.prepare("SELECT status, revision, text, page_starts_json FROM paper_sources WHERE doi = ?").get(p.doi) as
    | { status: string; revision: string | null; text: string | null; page_starts_json: string | null }
    | undefined;
  if (row === undefined || row.status !== "ready" || row.revision === null || row.text === null) return { status: "unavailable" };
  if (row.revision !== p.revision) return { status: "stale", doi: p.doi, currentRevision: row.revision };
  if (p.end > row.text.length) return { status: "invalid" };
  const pages = row.page_starts_json === null ? null : (JSON.parse(row.page_starts_json) as number[]);
  return { status: "current", doi: p.doi, revision: p.revision, start: p.start, end: p.end, text: row.text.slice(p.start, p.end), page: pageOf(pages, p.start) };
}

// ── judgments (compute cache) ───────────────────────────────────────────────

/** The effective decision identity a judgment is valid under (KTD8). */
export interface JudgmentIdentity {
  model: string;
  protocol: string;
}

export function cachedJudgments(db: DatabaseSync, claim: string, id: JudgmentIdentity, passageHashes: string[]): Map<string, number> {
  const ch = claimHashOf(claim);
  const sel = db.prepare("SELECT p_true FROM claim_judgments WHERE claim_hash = ? AND passage_hash = ? AND model_id = ? AND protocol = ?");
  const out = new Map<string, number>();
  for (const h of passageHashes) {
    const row = sel.get(ch, h, id.model, id.protocol) as { p_true: number } | undefined;
    if (row !== undefined) out.set(h, row.p_true);
  }
  return out;
}

export function saveJudgments(db: DatabaseSync, claim: string, id: JudgmentIdentity, rows: { passageHash: string; pTrue: number }[], now: Date): void {
  if (rows.length === 0) return;
  const ch = claimHashOf(claim);
  inTransaction(db, () => {
    const ins = db.prepare("INSERT OR REPLACE INTO claim_judgments (claim_hash, passage_hash, model_id, protocol, p_true, decided_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (const r of rows) ins.run(ch, r.passageHash, id.model, id.protocol, r.pTrue, iso(now));
  });
}

// ── runs and evidence ───────────────────────────────────────────────────────

/** What a run captured at its start; a continuation is refused when it no longer holds. */
export interface RunSnapshot {
  mode: "registry" | "query" | "direct";
  query: string | null;
  requested: "all" | "ids";
  /** Ready papers the run checks, in citekey order, at the revision and chunk policy captured. */
  papers: { doi: string; revision: string; policy: string }[];
  /** Identity of the requested selection: "all", or a digest of the resolved ids and unresolved handles. */
  scopeKey: string;
  /** Papers selected (ready or not) when the run began. */
  selected: number;
  /** Query mode: the exact candidate chunks (in judging order) captured at the start; BM25 is
   *  not stable when other papers are registered, so a continuation never recomputes it. */
  candidateIds: string[] | null;
  /** Per-paper candidate accounting captured at the start. */
  selection: { doi: string; chunksTotal: number; matched: number; selected: number }[];
  engine: string;
  /** Effective decision identity, or null when none could be established. */
  model: string | null;
  protocol: string;
  minConfidence: number;
}

/** Findings of the first call that later pages repeat. */
export interface RunCarry {
  unavailable: { doi: string; citekey: string; status: string; code: string | null; detail: string | null }[];
  unresolved: { handle: string; reason: string }[];
  staleDropped: number;
}

export interface RunRow {
  runId: string;
  claimHash: string;
  snapshot: RunSnapshot;
  carry: RunCarry;
  /** Index (into the run's candidate list) of the first unchecked candidate; null when work is complete. */
  nextWork: number | null;
}

/** Client policy: a continuation older than this is refused; older runs are pruned. */
export const RUN_TTL_MS = 24 * 60 * 60 * 1000;

export function createRun(db: DatabaseSync, runId: string, claim: string, snapshot: RunSnapshot, carry: RunCarry, now: Date): void {
  inTransaction(db, () => {
    db.prepare("DELETE FROM verify_runs WHERE created_at < ?").run(iso(new Date(now.getTime() - RUN_TTL_MS)));
    db.prepare("INSERT INTO verify_runs (run_id, claim_hash, snapshot_json, next_work, carry_json, created_at) VALUES (?, ?, ?, NULL, ?, ?)").run(
      runId,
      claimHashOf(claim),
      JSON.stringify(snapshot),
      JSON.stringify(carry),
      iso(now),
    );
  });
}

export function getRun(db: DatabaseSync, runId: string, now: Date): RunRow | null {
  const r = db.prepare("SELECT run_id, claim_hash, snapshot_json, next_work, carry_json, created_at FROM verify_runs WHERE run_id = ?").get(runId) as
    | { run_id: string; claim_hash: string; snapshot_json: string; next_work: number | null; carry_json: string; created_at: string }
    | undefined;
  if (r === undefined || Date.parse(r.created_at) < now.getTime() - RUN_TTL_MS) return null;
  return {
    runId: r.run_id,
    claimHash: r.claim_hash,
    snapshot: JSON.parse(r.snapshot_json) as RunSnapshot,
    carry: JSON.parse(r.carry_json) as RunCarry,
    nextWork: r.next_work === null ? null : Number(r.next_work),
  };
}

export function setRunState(db: DatabaseSync, runId: string, nextWork: number | null, carry: RunCarry): void {
  db.prepare("UPDATE verify_runs SET next_work = ?, carry_json = ? WHERE run_id = ?").run(nextWork, JSON.stringify(carry), runId);
}

export interface EvidenceRow {
  doi: string;
  revision: string;
  start: number;
  end: number;
  page: number | null;
  chunkId: string;
  model: string;
  protocol: string;
  minConfidence: number;
  pTrue: number;
}

/**
 * Persist a run's supporting evidence. Each row is checked against the
 * paper's CURRENT ready revision inside the write transaction: evidence judged
 * against a source that was replaced or removed meanwhile is dropped, never
 * published as a pointer into text it was not judged on. Returns the number dropped.
 */
export function saveEvidence(db: DatabaseSync, runId: string, rows: EvidenceRow[], now: Date): number {
  if (rows.length === 0) return 0;
  return inTransaction(db, () => {
    const current = db.prepare("SELECT revision FROM paper_sources WHERE doi = ? AND status = 'ready'");
    const ins = db.prepare(
      // DO NOTHING on conflict: re-finding a span a later call re-judged must not reset its delivery state.
      `INSERT INTO claim_evidence (run_id, doi, revision, char_start, char_end, page, chunk_id, model_id, protocol, min_confidence, p_true, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, doi, revision, char_start, char_end) DO NOTHING`,
    );
    let dropped = 0;
    for (const r of rows) {
      const cur = current.get(r.doi) as { revision: string } | undefined;
      if (cur === undefined || cur.revision !== r.revision) {
        dropped++;
        continue;
      }
      ins.run(runId, r.doi, r.revision, r.start, r.end, r.page, r.chunkId, r.model, r.protocol, r.minConfidence, r.pTrue, iso(now));
    }
    return dropped;
  });
}

export interface RunEvidence extends EvidenceRow {
  citekey: string;
  title: string;
  citable: boolean;
  /** null = not yet delivered to the agent; otherwise excerpt characters released (0 = pointer only). */
  releasedChars: number | null;
}

/** Record that these evidence rows were delivered, and how much text each released (exactly-once paging). */
export function markDelivered(db: DatabaseSync, runId: string, items: { doi: string; revision: string; start: number; end: number; released: number }[]): void {
  if (items.length === 0) return;
  inTransaction(db, () => {
    const up = db.prepare("UPDATE claim_evidence SET released_chars = ? WHERE run_id = ? AND doi = ? AND revision = ? AND char_start = ? AND char_end = ?");
    for (const i of items) up.run(i.released, runId, i.doi, i.revision, i.start, i.end);
  });
}

/** Was this exact span issued as supporting evidence by this package (in any live run)? Only issued spans may be re-judged directly. */
export function pointerIssued(db: DatabaseSync, doi: string, revision: string, start: number, end: number): boolean {
  return (
    db.prepare("SELECT 1 FROM claim_evidence WHERE doi = ? AND revision = ? AND char_start = ? AND char_end = ? LIMIT 1").get(doi, revision, start, end) !== undefined
  );
}

/** A run's evidence that still matches its paper's current revision, in reading order (citekey, position). */
export function evidenceOfRun(db: DatabaseSync, runId: string): RunEvidence[] {
  const rows = db
    .prepare(
      `SELECT e.doi, e.revision, e.char_start, e.char_end, e.page, e.chunk_id, e.model_id, e.protocol, e.min_confidence, e.p_true, e.released_chars, p.citekey, p.title, p.citable
       FROM claim_evidence e JOIN papers p ON p.doi = e.doi JOIN paper_sources s ON s.doi = e.doi AND s.status = 'ready' AND s.revision = e.revision
       WHERE e.run_id = ? ORDER BY p.citekey, e.char_start, e.char_end`,
    )
    .all(runId) as Record<string, string | number | null>[];
  return rows.map((r) => ({
    doi: r.doi as string,
    revision: r.revision as string,
    start: Number(r.char_start),
    end: Number(r.char_end),
    page: r.page === null ? null : Number(r.page),
    chunkId: r.chunk_id as string,
    model: r.model_id as string,
    protocol: r.protocol as string,
    minConfidence: Number(r.min_confidence),
    pTrue: Number(r.p_true),
    citekey: r.citekey as string,
    title: r.title as string,
    citable: Number(r.citable) === 1,
    releasedChars: r.released_chars === null ? null : Number(r.released_chars),
  }));
}
