/**
 * Runtime-neutral section writer: write a section from the listed papers' passages, verify it as written, repair the failures once,
 * re-verify, and report what remains unresolved. The host supplies the writer sub-session and the document verification as seams
 * (Pi: a real child session and the `verify` tool; a browser: its own), so this module imports no SDK, no Node builtin and no process state.
 *
 * It never writes files: the manuscript belongs to the user and the main agent assembles it.
 */
import type { DocumentUnitStatus } from "../core/verify/document-status.ts";
import { parseAnnotatedOutput, type AnnotationProblem, type ParsedAnnotations } from "../core/verify/annotations.ts";
import { countBodyWords } from "../core/provenance/units.ts";
import { createSourceTrace, unreadSources, type SourceTrace, type UnreadSource } from "./source-trace.ts";

export interface WriteSectionParams {
  goal: string;
  /** ONE string of citekeys separated by spaces or commas (never an array: some models send arrays as JSON strings). */
  papers: string[];
  query?: string;
  maxWords?: number;
}

export interface UnitVerdict {
  id: string;
  excerpt: string;
  status: DocumentUnitStatus;
  suggested: string[];
  pointers: string[];
  /** False when the unit's own check was interrupted before all passages were judged. */
  complete?: boolean;
  /** Figure counts of a `table-row` unit (D4); a row with no missing figure is resolved. */
  figures?: { found: number; missing: number; check: number };
  /** Papers that do not support this claim (annotated mode only). */
  failedCites?: string[];
  /** Where each cited paper's support was found (annotated mode only). */
  supportWhere?: Array<{ citekey: string; at: "stated" | "elsewhere" | "unstated" }>;
  /** Stated refs that resolve to no unit (annotated mode only). */
  unresolvedStated?: string[];
}

/** One document-mode page of the EXACT section text (core pages MAX_DOCUMENT_UNITS units). */
export interface VerifyPage {
  units: UnitVerdict[];
  summary: { total: number; from: number; units: number };
  next: number | null;
  /** Verification effort that produced the page (annotated mode only). */
  work?: { cells: number; fresh: number; cached: number; calls: number };
}

export interface SectionDeps {
  /** Run the writer sub-session once (initial brief or repair brief); returns the section LaTeX. */
  runWriter: (prompt: string) => Promise<string>;
  /** Check one page of the returned text with `verify` document mode, starting at `offset`. */
  verifyDocument: (text: string, offset: number) => Promise<VerifyPage>;
  /**
   * Settle the owned writer after an abort (the real child aborts its
   * in-flight prompt and waits for idle). The lifecycle awaits this before
   * reporting cancellation, so no background prompt is ever orphaned.
   */
  abortWriter: () => Promise<void>;
  /** Release the owned writer; called exactly once when the lifecycle settles. */
  disposeWriter: () => void;
  /**
   * Annotated checker (W4 contract): judges the parsed claims with stated
   * sources first. Present only in annotated mode; the no-marker fallback
   * stays on `verifyDocument` above.
   */
  verifyAnnotated?: (parsed: ParsedAnnotations, offset: number) => Promise<VerifyPage>;
  /** The child's source trace (W3); report-only, never mutates a verdict. */
  trace?: SourceTrace;
}

/** Verification counts of one text: units checked, supported, and supported-but-interrupted. */
export interface SectionCounts {
  units: number;
  ok: number;
  incomplete: number;
}

export interface SectionResult {
  latex: string;
  summary: string;
  unresolved: UnitVerdict[];
  /** Counts of the first draft, before any repair round. */
  firstDraft: SectionCounts;
  /** Counts of the returned text (equal to firstDraft when no repair ran). */
  final: SectionCounts;
  repaired: boolean;
  /** Reader-visible words of the returned LaTeX (the provenance body-word definition). */
  words: number;
  /** Annotated-mode detail (present only when the verifyAnnotated seam ran). */
  annotated?: AnnotatedSummary;
}

/** One marked claim of an annotated check: per cited paper, where support was found. */
export interface AnnotatedClaimLine {
  marker: number;
  status: DocumentUnitStatus;
  /** Cited papers in claim order. */
  sources: string[];
  /** Per-paper outcome aligned with `sources`: where support was found, or "unsupported". */
  at: Array<"stated" | "elsewhere" | "unstated" | "unsupported">;
  /** Cited papers whose stated source the trace never saw. */
  unread: string[];
}

/** Annotated-mode detail: table input (section-tool) and Pi details share it. */
export interface AnnotatedSummary {
  mode: "annotated" | "fallback";
  firstDraft: { mode: "annotated" | "fallback"; markers: number; citedUnits: number };
  claims: AnnotatedClaimLine[];
  problems: AnnotationProblem[];
  unread: UnreadSource[];
  checkCalls: number;
  work: { cells: number; fresh: number; cached: number; calls: number };
}

/** Client policy: at most 4 annotated-checker calls (pages included) per write_section run; the fifth throws. */
export const MAX_CHECK_CALLS = 4;

/** Child-session totals, tallied from the child's own events (never from its text). */
export interface ChildStats {
  turns: number;
  retries: number;
  toolCalls: number;
  wallMs: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
}

/**
 * Tally of one child session's events: an assistant message end is a turn
 * (with its usage), an auto-retry start is a retry, a tool execution start is
 * a tool call. Other events are ignored.
 */
export function createChildTally(startedMs: number): { record: (event: unknown) => void; stats: (nowMs: number) => ChildStats } {
  const totals = { turns: 0, retries: 0, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 } };
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    record(event: unknown): void {
      const e = (typeof event === "object" && event !== null ? event : {}) as { type?: unknown; message?: unknown };
      if (e.type === "tool_execution_start") totals.toolCalls += 1;
      else if (e.type === "auto_retry_start") totals.retries += 1;
      else if (e.type === "message_end") {
        const m = (typeof e.message === "object" && e.message !== null ? e.message : {}) as { role?: unknown; usage?: Record<string, unknown> & { cost?: { total?: unknown } } };
        if (m.role !== "assistant") return;
        totals.turns += 1;
        const u = m.usage ?? {};
        totals.usage.input += num(u.input);
        totals.usage.output += num(u.output);
        totals.usage.cacheRead += num(u.cacheRead);
        totals.usage.cacheWrite += num(u.cacheWrite);
        totals.usage.costUsd += num(u.cost?.total);
      }
    },
    stats(nowMs: number): ChildStats {
      return { turns: totals.turns, retries: totals.retries, toolCalls: totals.toolCalls, wallMs: Math.max(0, nowMs - startedMs), usage: { ...totals.usage } };
    },
  };
}

/** Unwrap a fenced code block; bare text passes through. */
export function stripCodeFences(text: string): string {
  const m = /```(?:latex|tex)?\s*\n([\s\S]*?)```/.exec(text);
  return (m?.[1] ?? text).trim();
}

export function buildWriterPrompt(p: WriteSectionParams, opts?: { annotated?: boolean }): string {
  const head = [
    "Write only the section body in LaTeX for this goal:",
    p.goal,
    "",
    `You may use only facts from passages of these registered papers: ${p.papers.join(", ")}.`,
    "Use the passages, registry and verify tools to read them; use no other tools.",
    "End every factual sentence with \\cite{<key>} of the paper that states it.",
    "Write no fact from memory. If the papers do not support something, leave it out or write it as explicitly unverified.",
    p.query !== undefined ? `Focus on: ${p.query}.` : "",
    p.maxWords !== undefined ? `At most ${p.maxWords} words.` : "",
  ];
  if (opts?.annotated !== true) return [...head, "Return only the LaTeX section body, no explanation."].filter((l) => l !== "").join("\n");
  return [
    ...head,
    "Put each factual sentence on its own line and end that line with a LaTeX comment ` % c1`, ` % c2` and so on (numbers 1 to 20, each used once).",
    "After the LaTeX add a line `---SOURCES---`, then one line per paper a sentence cites: `cN | citekey | section=<heading exactly as passages printed it>` or `cN | citekey | ptr=<pointer from passages or verify>`; 1 to 4 lines per sentence.",
    "Return the LaTeX and the sources together in ONE code block, nothing else.",
  ].filter((l) => l !== "").join("\n");
}

export function buildAnnotatedRepairPrompt(failures: UnitVerdict[], notes: UnreadSource[]): string {
  const lines = failures.map((f) => {
    const cause = (f.failedCites?.length ?? 0) > 0 ? ` — not supported by: ${f.failedCites!.join(", ")}` : f.suggested.length > 0 ? ` — support found in: ${f.suggested.join(", ")}` : "";
    return `- [${f.id}] (${f.status}) "${f.excerpt}"${cause}`;
  });
  const unread = notes.length > 0 ? ["Unread sources (open one before rewriting the claim):", ...notes.map((n) => n.hint)] : [];
  return [
    "The section you wrote was checked as written against its stated sources. These claims are NOT supported; rewrite each one from a passage of its cited paper, add the missing citation, or delete it:",
    ...lines,
    ...unread,
    "Return the full revised section in the same single code block: one claim per line ending ` % cN`, then `---SOURCES---` and its lines.",
  ].join("\n");
}

export function buildRepairPrompt(failures: UnitVerdict[]): string {
  const lines = failures.map((f) => `- [${f.id}] (${f.status}) "${f.excerpt}"${f.suggested.length > 0 ? ` — support found in: ${f.suggested.join(", ")}` : ""}`);
  return [
    "The section you wrote was checked as written against the registered papers. These units are NOT supported; rewrite each one from a passage of its cited paper, add the missing citation, or delete it:",
    ...lines,
    "Return only the full revised LaTeX section body, no explanation.",
  ].join("\n");
}

/** Statuses a document-mode unit may carry; anything else is a malformed page. */
const KNOWN_UNIT_STATUSES: ReadonlySet<string> = new Set([
  "supported",
  "cited-unsupported",
  "missing-citation",
  "unsourced",
  "unregistered",
  "skipped",
  "table-row",
]);

/** A unit the writer need not repair: supported, or a table row whose figures are all found or unchecked (none missing). */
const resolvedUnit = (u: UnitVerdict): boolean => u.status === "supported" || (u.status === "table-row" && u.figures !== undefined && u.figures.missing === 0);

/**
 * Write the section, verify every page of it as written, repair failures once,
 * re-verify all pages, and report what is still unresolved.
 *
 * Single owner of the writer resource: an abort fires abortWriter, the run
 * stays pending until that settles (no next page, repair, or prompt in the
 * meantime), cancellation is then reported (never success), and disposeWriter
 * runs exactly once in the finally below.
 */
export async function runWriteSection(deps: SectionDeps, params: WriteSectionParams, signal?: AbortSignal): Promise<SectionResult> {
  let abortSettled: Promise<void> | null = null;
  /** Start the owned abort once; observe rejection now, propagate it on settlement. */
  const fireAbort = (): Promise<void> => {
    if (abortSettled !== null) return abortSettled;
    let p: Promise<void>;
    try {
      p = deps.abortWriter();
    } catch (err) {
      p = Promise.reject(err);
    }
    abortSettled = p;
    // Observe immediately so a rejected abort never surfaces as unhandled;
    // awaiting `abortSettled` below still propagates the cleanup failure.
    p.then(undefined, () => undefined);
    return p;
  };
  const onAbort = (): void => {
    fireAbort();
  };
  /** Settle a fired abort and report cancellation; a no-op when not aborted. */
  const settleAbort = async (): Promise<void> => {
    if (abortSettled !== null) await abortSettled;
    signal?.throwIfAborted();
  };
  /**
   * Run one writer call to settlement, then give a fired abort the outcome:
   * the run waits for abort settlement first and reports cancellation even
   * when the writer itself resolved or rejected in the meantime.
   */
  const runWriterSettled = async (prompt: string): Promise<string> => {
    await settleAbort();
    let outcome: { ok: true; value: string } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await deps.runWriter(prompt) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    await settleAbort();
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };
  if (signal !== undefined) signal.addEventListener("abort", onAbort);
  /**
   * Annotated-mode check of one parsed output: with markers through the
   * annotated checker (call-counted, capped), without through the unchanged
   * document path. Marked units are renamed to cN so failures, the repair
   * brief and the table share one naming.
   */
  const runAnnotatedFlow = async (first: string, countsOf: (units: UnitVerdict[]) => SectionCounts): Promise<SectionResult> => {
    const checkAnnotated = deps.verifyAnnotated!;
    const trace = deps.trace ?? createSourceTrace();
    let checkCalls = 0;
    const work = { cells: 0, fresh: 0, cached: 0, calls: 0 };
    const callAnnotated = async (parsed: ParsedAnnotations, offset: number): Promise<VerifyPage> => {
      checkCalls += 1;
      if (checkCalls > MAX_CHECK_CALLS) {
        throw new Error(`annotated check budget exceeded: at most ${MAX_CHECK_CALLS} verifyAnnotated calls (pages included) per write_section run (client policy)`);
      }
      const page = await checkAnnotated(parsed, offset);
      const w = page.work;
      if (w !== undefined) {
        const n = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
        work.cells += n(w.cells);
        work.fresh += n(w.fresh);
        work.cached += n(w.cached);
        work.calls += n(w.calls);
      }
      return page;
    };
    const checkParsed = async (parsed: ParsedAnnotations): Promise<{ parsed: ParsedAnnotations; units: UnitVerdict[]; failed: UnitVerdict[] }> => {
      const raw = parsed.mode === "annotated" ? await checkText(parsed.latex, (o) => callAnnotated(parsed, o)) : await checkText(parsed.latex);
      const markerOf = new Map(parsed.claims.map((c) => [c.unitId, c.marker]));
      const units = raw.units.map((u) => (markerOf.has(u.id) ? { ...u, id: `c${markerOf.get(u.id)}` } : u));
      return { parsed, units, failed: units.filter((u) => !resolvedUnit(u)) };
    };
    const unreadOf = (parsed: ParsedAnnotations): UnreadSource[] => unreadSources(parsed.claims, trace);
    const firstParsed = parseAnnotatedOutput(first);
    const firstDraftMeta = {
      mode: firstParsed.mode,
      markers: firstParsed.claims.length,
      citedUnits: firstParsed.units.filter((u) => u.cites.length > 0).length,
    };
    const firstCheck = await checkParsed(firstParsed);
    await settleAbort();
    let current = firstCheck;
    let repaired = false;
    // Annotation problems alone never trigger a repair: only failed units do.
    if (firstCheck.failed.length > 0) {
      repaired = true;
      const failedMarkers = new Set<number>();
      for (const c of firstParsed.claims) {
        if (firstCheck.failed.some((u) => u.id === `c${c.marker}`)) failedMarkers.add(c.marker);
      }
      const notes = unreadOf(firstParsed).filter((u) => failedMarkers.has(u.marker));
      const second = stripCodeFences(await runWriterSettled(buildAnnotatedRepairPrompt(firstCheck.failed, notes)));
      current = await checkParsed(parseAnnotatedOutput(second));
      await settleAbort();
    }
    const n = current.units.length;
    const ok = current.units.filter(resolvedUnit).length;
    const incomplete = current.units.filter((u) => u.complete === false).length;
    const summary = [
      repaired ? `${ok}/${n} supported (incomplete: ${incomplete}) after one repair round.` : `${ok}/${n} supported (incomplete: ${incomplete}), no repair needed.`,
      ...current.units.filter((u) => !resolvedUnit(u)).map((u) => `[${u.id}] ${u.status}: \"${u.excerpt}\"${u.suggested.length > 0 ? ` (suggests ${u.suggested.join(", ")})` : ""}`),
    ].join("\n");
    const unread = unreadOf(current.parsed);
    const unreadKeys = new Map<number, string[]>();
    for (const u of unread) unreadKeys.set(u.marker, [...(unreadKeys.get(u.marker) ?? []), u.citekey]);
    const unitById = new Map(current.units.map((u) => [u.id, u]));
    const claims: AnnotatedClaimLine[] = current.parsed.claims.map((c) => {
      const unit = unitById.get(`c${c.marker}`);
      const where = new Map((unit?.supportWhere ?? []).map((s) => [s.citekey, s.at] as const));
      const failed = new Set(unit?.failedCites ?? []);
      return {
        marker: c.marker,
        status: unit?.status ?? "skipped",
        sources: [...c.cites],
        at: c.cites.map((k) => where.get(k) ?? (failed.has(k) ? "unsupported" : "unstated")),
        unread: unreadKeys.get(c.marker) ?? [],
      };
    });
    return {
      latex: current.parsed.latex,
      summary,
      unresolved: current.units.filter((u) => !resolvedUnit(u) || u.complete === false),
      firstDraft: countsOf(firstCheck.units),
      final: countsOf(current.units),
      repaired,
      words: countBodyWords(current.parsed.latex),
      annotated: {
        mode: current.parsed.mode,
        firstDraft: firstDraftMeta,
        claims,
        problems: current.parsed.problems,
        unread,
        checkCalls,
        work: { ...work },
      },
    };
  };
  /** Every page of the EXACT text, in order; refuses malformed pagination rather than a partial set. */
  const checkText = async (
    text: string,
    fetchPage: (offset: number) => Promise<VerifyPage> = (o) => deps.verifyDocument(text, o),
  ): Promise<{ text: string; failed: UnitVerdict[]; units: UnitVerdict[] }> => {
    let offset = 0;
    let total: number | null = null;
    const seenIds = new Set<string>();
    const units: UnitVerdict[] = [];
    for (;;) {
      await settleAbort();
      const page = await fetchPage(offset);
      await settleAbort();
      const got = page as Partial<VerifyPage> | null | undefined;
      const summary = got?.summary;
      if (!got || !Array.isArray(got.units) || typeof summary?.total !== "number" || typeof summary?.from !== "number" || typeof summary?.units !== "number" || (got.next !== null && typeof got.next !== "number")) {
        throw new Error("verify document mode returned a malformed page: refusing a partial set as complete");
      }
      if (!Number.isInteger(summary.total) || summary.total <= 0) {
        throw new Error("verify document mode returned no units: refusing an empty check as success");
      }
      if (got.units.length === 0 || summary.units !== got.units.length) {
        throw new Error("verify document mode returned an empty or malformed page: refusing it as success");
      }
      if (summary.from !== offset) throw new Error("verify document mode skipped or duplicated a page: refusing a partial set as complete");
      if (total === null) total = summary.total;
      else if (summary.total !== total) throw new Error(`verify document mode changed its total (${summary.total} vs ${total}): refusing a partial set as complete`);
      // Unit identity is checked conservatively: a duplicated page (same ids
      // at plausible offsets) must not recount as complete.
      for (const raw of got.units as Array<Partial<UnitVerdict> | null | undefined>) {
        if (typeof raw?.id !== "string" || raw.id === "" || typeof raw.excerpt !== "string" || !KNOWN_UNIT_STATUSES.has(raw.status as string)) {
          throw new Error("verify document mode returned a malformed unit: refusing a partial set as complete");
        }
        if (seenIds.has(raw.id)) throw new Error(`verify document mode duplicated unit ${raw.id}: refusing a recount as complete`);
        seenIds.add(raw.id);
      }
      units.push(...(got.units as UnitVerdict[]));
      if (got.next === null) {
        if (offset + got.units.length !== total) {
          throw new Error("verify document mode ended before its own total: refusing a partial set as complete");
        }
        break;
      }
      // Reported total/next only: the page must advance exactly past what it returned.
      if (!Number.isInteger(got.next) || got.next <= offset || got.next !== offset + got.units.length || got.next > total) {
        throw new Error("verify document mode pagination did not progress: refusing a partial set as complete");
      }
      offset = got.next;
    }
    if (units.length !== (total as number)) {
      throw new Error("verify document mode did not return every unit: refusing a partial set as complete");
    }
    return { text, units, failed: units.filter((u) => !resolvedUnit(u)) };
  };
  let sawError = false;
  try {
    if (params.papers.length === 0) throw new Error("write_section needs at least one paper");
    if (signal?.aborted) {
      // Already cancelled (an abort may have raced resource creation): own
      // the resource — abort, settle, dispose — and never prompt the writer.
      await fireAbort();
      signal.throwIfAborted();
    }
    const countsOf = (units: UnitVerdict[]): SectionCounts => ({
      units: units.length,
      ok: units.filter(resolvedUnit).length,
      incomplete: units.filter((u) => u.complete === false).length,
    });
    if (deps.verifyAnnotated !== undefined) {
      const annotatedFirst = stripCodeFences(await runWriterSettled(buildWriterPrompt(params, { annotated: true })));
      return runAnnotatedFlow(annotatedFirst, countsOf);
    }
    const first = stripCodeFences(await runWriterSettled(buildWriterPrompt(params)));
    const firstCheck = await checkText(first);
    await settleAbort();
    let current = firstCheck;
    let repaired = false;
    // One repair round for actual nonsupported statuses only: a positively
    // supported unit is never rewritten just to chase missing coverage.
    if (firstCheck.failed.length > 0) {
      repaired = true;
      const second = stripCodeFences(await runWriterSettled(buildRepairPrompt(firstCheck.failed)));
      current = await checkText(second);
      await settleAbort();
    }
    const n = current.units.length;
    const ok = current.units.filter(resolvedUnit).length;
    const incomplete = current.units.filter((u) => u.complete === false).length;
    const summary = [
      repaired ? `${ok}/${n} supported (incomplete: ${incomplete}) after one repair round.` : `${ok}/${n} supported (incomplete: ${incomplete}), no repair needed.`,
      ...current.units.filter((u) => !resolvedUnit(u)).map((u) => `[${u.id}] ${u.status}: "${u.excerpt}"${u.suggested.length > 0 ? ` (suggests ${u.suggested.join(", ")})` : ""}`),
    ].join("\n");
    // Supported-but-incomplete checks stay explicitly unresolved: their
    // coverage was interrupted, so a clean "none" would misreport them.
    return {
      latex: current.text,
      summary,
      unresolved: current.units.filter((u) => !resolvedUnit(u) || u.complete === false),
      firstDraft: countsOf(firstCheck.units),
      final: countsOf(current.units),
      repaired,
      words: countBodyWords(current.text),
    };
  } catch (err) {
    sawError = true;
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // A rejected verification can bypass the normal abort checkpoints. Keep
    // ownership until the child settles even on that exit path.
    try {
      if (abortSettled !== null) await abortSettled;
    } finally {
      // Preserve a primary failure; cleanup alone may never turn into success.
      if (sawError) {
        try {
          deps.disposeWriter();
        } catch {
          // Secondary to the failure already in flight.
        }
      } else {
        deps.disposeWriter();
      }
    }
  }
}
