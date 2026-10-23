/**
 * Source trace (W3): which stated sources the section child actually opened.
 * The Pi forward records each real passages/verify outcome; `isSeen` reports
 * whether a stated source was opened, and `unreadSources` lists the rest with
 * a repair hint (report-only: claims are never mutated).
 *
 * Runtime-neutral: no Node builtin, no SDK, no process reference.
 */
import { parsePointer } from "../core/verify/pointer.ts";
import type { AnnotatedClaim, StatedSource } from "../core/verify/annotations.ts";

export interface SeenSpan {
  doi: string;
  citekey: string;
  revision: string;
  start: number;
  end: number;
}

export interface SeenHeading {
  citekey: string;
  heading: string;
}

export interface SourceTrace {
  /** Record one child forward outcome; never throws. Registry outcomes record nothing (metadata, not text). */
  record(kind: "passages" | "registry" | "verify", outcome: unknown): void;
  seen(): { spans: SeenSpan[]; headings: SeenHeading[] };
  isSeen(src: StatedSource): boolean;
}

export interface UnreadSource {
  marker: number;
  citekey: string;
  /** The stated ref as written: `section=<heading>` or the pointer. */
  ref: string;
  hint: string;
}

/** Whitespace collapse for heading comparison (exact case). */
const collapseWs = (s: string): string => s.trim().replace(/\s+/g, " ");

/**
 * The tool payload: the first of the nested/outer `structuredContent` slots
 * that holds an object with an array `hits` (passages) or `evidence`
 * (verify); anything else records nothing.
 */
const payloadOf = (outcome: unknown): { hits?: unknown; evidence?: unknown } | null => {
  if (typeof outcome !== "object" || outcome === null) return null;
  const o = outcome as { result?: unknown; structuredContent?: unknown };
  const viaResult = typeof o.result === "object" && o.result !== null
    ? (o.result as { structuredContent?: unknown }).structuredContent
    : undefined;
  const viaDirect = o.structuredContent;
  const nested = (v: unknown): unknown =>
    typeof v === "object" && v !== null ? (v as { structuredContent?: unknown }).structuredContent : undefined;
  for (const c of [nested(viaResult), viaResult, nested(viaDirect), viaDirect]) {
    if (typeof c === "object" && c !== null) {
      const p = c as { hits?: unknown; evidence?: unknown };
      if (Array.isArray(p.hits) || Array.isArray(p.evidence)) return p;
    }
  }
  return null;
};

export function createSourceTrace(): SourceTrace {
  const spans: SeenSpan[] = [];
  const headings: SeenHeading[] = [];
  return {
    record(kind, outcome): void {
      try {
        if (kind === "registry") return;
        const payload = payloadOf(outcome);
        if (payload === null) return;
        if (kind === "passages" && Array.isArray(payload.hits)) {
          for (const raw of payload.hits) {
            if (typeof raw !== "object" || raw === null) continue;
            const h = raw as Record<string, unknown>;
            // Withheld hits add nothing (D3): neither span nor heading.
            if (h.withheld !== null) continue;
            if (typeof h.section === "string" && typeof h.citekey === "string") headings.push({ citekey: h.citekey, heading: h.section });
            if (typeof h.excerpt !== "string") continue;
            const parsed = typeof h.pointer === "string" ? parsePointer(h.pointer) : null;
            if (parsed === null || typeof h.doi !== "string" || typeof h.citekey !== "string") continue;
            spans.push({ doi: h.doi, citekey: h.citekey, revision: parsed.revision, start: parsed.start, end: parsed.end });
          }
        } else if (kind === "verify" && Array.isArray(payload.evidence)) {
          for (const raw of payload.evidence) {
            if (typeof raw !== "object" || raw === null) continue;
            const e = raw as Record<string, unknown>;
            // Withheld evidence still counts (D2); only attested:false is ignored.
            if (e.attested === false) continue;
            const parsed = typeof e.pointer === "string" ? parsePointer(e.pointer) : null;
            if (parsed === null || typeof e.doi !== "string" || typeof e.citekey !== "string") continue;
            spans.push({ doi: e.doi, citekey: e.citekey, revision: parsed.revision, start: parsed.start, end: parsed.end });
          }
        }
      } catch {
        // Report-only: recording never breaks a forward.
      }
    },
    seen(): { spans: SeenSpan[]; headings: SeenHeading[] } {
      return { spans: spans.map((s) => ({ ...s })), headings: headings.map((h) => ({ ...h })) };
    },
    isSeen(src: StatedSource): boolean {
      const ref = src.ref;
      if (ref.kind === "pointer") {
        return spans.some((s) =>
          s.doi === ref.doi && s.revision === ref.revision && s.citekey === src.citekey && s.start <= ref.start && ref.end <= s.end
        );
      }
      return headings.some((h) => h.citekey === src.citekey && collapseWs(h.heading) === collapseWs(ref.heading));
    },
  };
}

/** The stated ref as written. */
const refTextOf = (src: StatedSource): string =>
  src.ref.kind === "section" ? `section=${src.ref.heading}` : src.ref.pointer;

/**
 * The stated sources the trace never saw, in claim order. Report-only: the
 * input claims are never mutated. Each hint names the marker, citekey and ref
 * and says to open it with passages (query from the heading words) or replace
 * or drop the source. Hint is tool output, not prompt text.
 */
export function unreadSources(claims: AnnotatedClaim[], trace: SourceTrace): UnreadSource[] {
  const out: UnreadSource[] = [];
  for (const claim of claims) {
    for (const src of claim.sources) {
      if (trace.isSeen(src)) continue;
      const ref = refTextOf(src);
      const open = src.ref.kind === "section"
        ? `run passages with a query from the heading words (${JSON.stringify(src.ref.heading)})`
        : `run passages over ${src.citekey}`;
      out.push({
        marker: claim.marker,
        citekey: src.citekey,
        ref,
        hint: `c${claim.marker} ${src.citekey} ${ref} was never opened: ${open}, or replace the source or drop the claim.`,
      });
    }
  }
  return out;
}
