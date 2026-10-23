/**
 * Annotated section output parser (W2): the writer marks each claim with a
 * trailing `% cN` comment and lists its sources after a `---SOURCES---`
 * delimiter; this pure parser binds markers to units and sources to claims.
 *
 * Runtime-neutral: no Node builtin, no SDK, no process reference (W5 calls it
 * inside the browser-bundled runWriteSection).
 */
import { extractUnits, type Unit } from "../provenance/units.ts";
import { linesFromString, parsePaper, stripComment } from "../review/latex.ts";
import { parsePointer } from "./pointer.ts";

/** Client policy: a section carries at most 20 claim markers. */
export const MAX_CLAIM_MARKERS = 20;
/** Client policy: at most 4 stated sources per claim. */
export const MAX_SOURCES_PER_CLAIM = 4;
/** The line that cuts the section body from the source list. */
export const SOURCES_DELIMITER = "---SOURCES---";

export type SourceRef =
  | { kind: "section"; heading: string }
  | { kind: "pointer"; pointer: string; doi: string; revision: string; start: number; end: number };

export interface StatedSource {
  citekey: string;
  ref: SourceRef;
  /** 1-based line number of the source line in the writer's output. */
  line: number;
}

export interface AnnotatedClaim {
  marker: number;
  unitId: string;
  /** The unit's plain wording (never typed by the writer). */
  plain: string;
  cites: string[];
  sources: StatedSource[];
}

export type AnnotationProblemCode =
  | "source-missing"
  | "ref-not-cited"
  | "bad-pointer"
  | "bad-source-line"
  | "too-many-sources"
  | "unmapped-marker"
  | "duplicate-marker"
  | "marker-out-of-range";

export interface AnnotationProblem {
  code: AnnotationProblemCode;
  /** The marker the problem is about, or null when no marker is involved. */
  marker: number | null;
  citekey?: string;
  /** 1-based line number in the writer's output. */
  line: number;
  detail: string;
}

export interface ParsedAnnotations {
  /** The section body with marker comments removed (source lines cut). */
  latex: string;
  units: Unit[];
  /** "fallback" when the writer used no markers: claims stay empty, every unit is still reported. */
  mode: "annotated" | "fallback";
  claims: AnnotatedClaim[];
  problems: AnnotationProblem[];
}

/** A marker comment is `% cN` with 1–6 digits; anything else stays an ordinary comment. */
const MARKER_COMMENT = /^%\s*c(\d{1,6})\s*$/i;
/** A source line names its marker with the same 1–6 digit shape. */
const SOURCE_NAME = /^c(\d{1,6})$/i;

/** End line of a unit: its start line plus the newlines its raw text spans. */
const endLineOf = (u: Unit): number => u.line + (u.raw.match(/\n/g) ?? []).length;

/**
 * Parse fence-stripped writer output: cut the SOURCES section, strip marker
 * comments (other comments stay, lines are never removed), bind each marker
 * to the last unit ending on its line, and attach each well-formed source
 * line to its claim when the unit cites the key.
 */
export function parseAnnotatedOutput(output: string): ParsedAnnotations {
  const allLines = output.split("\n");
  const delimAt = allLines.findIndex((l) => l.trim() === SOURCES_DELIMITER);
  const bodyLines = delimAt < 0 ? allLines : allLines.slice(0, delimAt);
  const sourceLines = delimAt < 0 ? [] : allLines.slice(delimAt + 1);

  // Marker pass: only `% cN` comments are removed; every line survives.
  const latexLines: string[] = [];
  const markerHits: Array<{ n: number; line: number }> = [];
  let anyMarker = false;
  bodyLines.forEach((line, i) => {
    const code = stripComment(line);
    if (code.length < line.length) {
      const m = MARKER_COMMENT.exec(line.slice(code.length));
      if (m !== null) {
        anyMarker = true;
        markerHits.push({ n: Number(m[1]), line: i + 1 });
        latexLines.push(code.trimEnd());
        return;
      }
    }
    latexLines.push(line);
  });

  const latex = latexLines.join("\n").trimEnd();
  const units = extractUnits(parsePaper(linesFromString(latex, "fragment.tex")));
  if (!anyMarker) return { latex, units, mode: "fallback", claims: [], problems: [] };

  // Binding pass: first occurrence binds; out-of-range and repeats are flagged.
  const problems: AnnotationProblem[] = [];
  const boundByMarker = new Map<number, Unit>();
  const markerLineOf = new Map<number, number>();
  for (const hit of markerHits) {
    if (hit.n < 1 || hit.n > MAX_CLAIM_MARKERS) {
      problems.push({ code: "marker-out-of-range", marker: hit.n, line: hit.line, detail: `marker c${hit.n} is outside 1..${MAX_CLAIM_MARKERS} (client policy)` });
      continue;
    }
    if (markerLineOf.has(hit.n)) {
      problems.push({ code: "duplicate-marker", marker: hit.n, line: hit.line, detail: `marker c${hit.n} already binds line ${markerLineOf.get(hit.n)}; the first occurrence binds` });
      continue;
    }
    markerLineOf.set(hit.n, hit.line);
    let found: Unit | null = null;
    for (const u of units) if (endLineOf(u) === hit.line) found = u;
    if (found === null) {
      problems.push({ code: "unmapped-marker", marker: hit.n, line: hit.line, detail: `no unit ends on line ${hit.line}` });
      continue;
    }
    boundByMarker.set(hit.n, found);
  }

  // Source pass: malformed lines are flagged, identical lines deduped, and a
  // line attaches only when its marker binds a unit that cites its key.
  const stagedByMarker = new Map<number, StatedSource[]>();
  const seenSource = new Set<string>();
  sourceLines.forEach((rawLine, i) => {
    const line = delimAt + 2 + i;
    if (rawLine.trim() === "") return;
    const parts = rawLine.split("|");
    const bad = (marker: number | null, citekey: string | undefined, detail: string): void => {
      const p: AnnotationProblem = { code: "bad-source-line", marker, line, detail };
      if (citekey !== undefined) p.citekey = citekey;
      problems.push(p);
    };
    if (parts.length < 3) {
      bad(null, undefined, `a source line is "cN | citekey | ref", got ${JSON.stringify(rawLine)}`);
      return;
    }
    const name = parts[0]!.trim();
    const citekey = parts[1]!.trim();
    const refText = parts.slice(2).join("|").trim();
    const nm = SOURCE_NAME.exec(name);
    if (nm === null || citekey === "") {
      bad(nm === null ? null : Number(nm[1]), citekey === "" ? undefined : citekey, `a source line is "cN | citekey | ref", got ${JSON.stringify(rawLine)}`);
      return;
    }
    const n = Number(nm[1]);
    const dedupeKey = `${n}|${citekey}|${refText}`;
    if (seenSource.has(dedupeKey)) return;
    seenSource.add(dedupeKey);
    const rm = /^(section|ptr)=([\s\S]*)$/.exec(refText);
    if (rm === null || rm[2]!.trim() === "") {
      bad(n, citekey, `a source ref is section=<heading> or ptr=<pointer>, got ${JSON.stringify(refText)}`);
      return;
    }
    let ref: SourceRef;
    if (rm[1] === "section") {
      ref = { kind: "section", heading: rm[2]!.trim() };
    } else {
      const parsed = parsePointer(rm[2]!.trim());
      if (parsed === null) {
        problems.push({ code: "bad-pointer", marker: n, citekey, line, detail: `not a doi@revision#start-end pointer: ${JSON.stringify(rm[2]!.trim())}` });
        return;
      }
      ref = { kind: "pointer", pointer: rm[2]!.trim(), doi: parsed.doi, revision: parsed.revision, start: parsed.start, end: parsed.end };
    }
    if (n < 1 || n > MAX_CLAIM_MARKERS) {
      problems.push({ code: "marker-out-of-range", marker: n, citekey, line, detail: `marker c${n} is outside 1..${MAX_CLAIM_MARKERS} (client policy)` });
      return;
    }
    const unit = boundByMarker.get(n);
    if (unit === undefined) {
      problems.push({ code: "unmapped-marker", marker: n, citekey, line, detail: `no bound claim for marker c${n}` });
      return;
    }
    if (!unit.cites.includes(citekey)) {
      problems.push({ code: "ref-not-cited", marker: n, citekey, line, detail: `unit ${unit.id} does not cite ${citekey}` });
      return;
    }
    const list = stagedByMarker.get(n) ?? [];
    list.push({ citekey, ref, line });
    stagedByMarker.set(n, list);
  });

  // Claims: at most the first four sources attach; every cited key without a
  // source line is reported.
  const claims: AnnotatedClaim[] = [];
  for (const n of [...boundByMarker.keys()].sort((a, b) => a - b)) {
    const unit = boundByMarker.get(n)!;
    const staged = stagedByMarker.get(n) ?? [];
    const sources = staged.slice(0, MAX_SOURCES_PER_CLAIM);
    if (staged.length > MAX_SOURCES_PER_CLAIM) {
      problems.push({ code: "too-many-sources", marker: n, line: markerLineOf.get(n)!, detail: `claim c${n} states ${staged.length} sources; the first ${MAX_SOURCES_PER_CLAIM} attach (client policy)` });
    }
    claims.push({ marker: n, unitId: unit.id, plain: unit.plain, cites: [...unit.cites], sources });
    const attached = new Set(sources.map((s) => s.citekey));
    for (const key of unit.cites) {
      if (!attached.has(key)) {
        problems.push({ code: "source-missing", marker: n, citekey: key, line: markerLineOf.get(n)!, detail: `unit ${unit.id} cites ${key} with no source line` });
      }
    }
  }
  return { latex, units, mode: "annotated", claims, problems };
}
