/**
 * Runtime-neutral section writer: write a section from the listed papers' passages, verify it as written, repair the failures once,
 * re-verify, and report what remains unresolved. The host supplies the writer sub-session and the document verification as seams
 * (Pi: a real child session and the `verify` tool; a browser: its own), so this module imports no SDK, no Node builtin and no process state.
 *
 * It never writes files: the manuscript belongs to the user and the main agent assembles it.
 */
import type { DocumentUnitStatus } from "../core/verify/document-status.ts";
import { countBodyWords } from "../core/provenance/units.ts";

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
}

/** One document-mode page of the EXACT section text (core pages MAX_DOCUMENT_UNITS units). */
export interface VerifyPage {
  units: UnitVerdict[];
  summary: { total: number; from: number; units: number };
  next: number | null;
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
}

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

export function buildWriterPrompt(p: WriteSectionParams): string {
  return [
    "Write only the section body in LaTeX for this goal:",
    p.goal,
    "",
    `You may use only facts from passages of these registered papers: ${p.papers.join(", ")}.`,
    "Use the passages and verify tools to read them; use no other tools.",
    "End every factual sentence with \\cite{<key>} of the paper that states it.",
    "Write no fact from memory. If the papers do not support something, leave it out or write it as explicitly unverified.",
    p.query !== undefined ? `Focus on: ${p.query}.` : "",
    p.maxWords !== undefined ? `At most ${p.maxWords} words.` : "",
    "Return only the LaTeX section body, no explanation.",
  ].filter((l) => l !== "").join("\n");
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
  /** Every page of the EXACT text, in order; refuses malformed pagination rather than a partial set. */
  const checkText = async (text: string): Promise<{ text: string; failed: UnitVerdict[]; units: UnitVerdict[] }> => {
    let offset = 0;
    let total: number | null = null;
    const seenIds = new Set<string>();
    const units: UnitVerdict[] = [];
    for (;;) {
      await settleAbort();
      const page = await deps.verifyDocument(text, offset);
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
    const countsOf = (units: UnitVerdict[]): SectionCounts => ({
      units: units.length,
      ok: units.filter(resolvedUnit).length,
      incomplete: units.filter((u) => u.complete === false).length,
    });
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
