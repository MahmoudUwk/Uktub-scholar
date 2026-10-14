/**
 * Cause-tracing pure core for scripts/live/trace-causes.ts: text normalization,
 * content-token extraction, unit-to-write matching, near-variant detection and
 * the mechanical cause classifier with tie-breaks. No I/O.
 *
 * Tie-breaks (applied mechanically, in order):
 *   1. uncited units are always UNCITED-KNOWLEDGE.
 *   2. SLOT-FILL: a table row whose demanded column no prior tool result supplied
 *      (row + columnDemanded + zero content-token hits before the write).
 *   3. REVISION-FILL: introduced in the revision turn with no retrieval for its
 *      papers since the revision started.
 *   4. MEMORY: no prior tool result for the cited paper, or zero token hits.
 *   5. MISREPORT: partial hits plus a missing number/hardware token (a retrieved
 *      detail changed or a fresh detail added to a retrieved frame).
 *   6. OVERREAD: otherwise (retrieved text exists but does not contain the claim:
 *      inference, generalisation, transfer).
 * Secondary cause is the next rule in [SLOT-FILL, REVISION-FILL, MEMORY,
 * MISREPORT, OVERREAD] that also fires. Borderline marks the cases where only
 * judgement separates neighbours: SLOT-FILL on a generic demand match,
 * MISREPORT with no near-variant token anywhere, OVERREAD on partial hits.
 */

export type Cause =
  | "MEMORY"
  | "OVERREAD"
  | "MISREPORT"
  | "REVISION-FILL"
  | "SLOT-FILL"
  | "UNCITED-KNOWLEDGE";

export interface ContentToken {
  token: string;
  kind: "number" | "hardware" | "term";
}

const STOPWORDS = new Set(
  "a,an,the,and,or,but,if,then,else,when,while,with,without,from,into,during,including,until,against,among,through,over,under,between,each,other,more,most,such,only,also,just,than,that,this,these,those,their,there,them,they,they're,its,it's,have,has,using,use,used,based,well,both,either,neither,however,within,across,per,via,model,models,method,methods,paper,papers,result,results,about,which,what,were,where,while,been,being,does,doing,done,because,until,further,once".split(","),
);

/** Lowercase, strip LaTeX commands/cites/math, unify multiplication signs, collapse space. */
export function normalizeText(s: string): string {
  let t = s.toLowerCase();
  t = t.replace(/\\cite\{[^}]*\}/g, " ");
  t = t.replace(/\\[a-z]+\{([^}]*)\}/g, " $1 ");
  t = t.replace(/\\[a-z]+/g, " ");
  t = t.replace(/[{}_$^~]/g, " ");
  t = t.replace(/\u00d7/g, "x");
  t = t.replace(/(\d),(\d)/g, "$1$2");
  t = t.replace(/--+/g, "-");
  t = t.replace(/[^a-z0-9.%x+\-/\s]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

const HARDWARE_RE =
  /\b(v100|a100|h100|b200|titan\s*xp?|titan\b|rtx\s*\d{3,4}|gtx\s*\d{3,4}|rtx|tpu\s*v?\d?|tpu\b|single[-\s]?gpu|multi[-\s]?gpu|gpu\s*cluster|\d+\s*gb\s*gpu)\b/;

/** Content tokens: numbers with units, hardware names, distinctive terms (len>=6 or ALLCAPS acronyms). */
export function contentTokens(text: string): ContentToken[] {
  const out: ContentToken[] = [];
  const rank = (k: ContentToken["kind"]): number => (k === "number" ? 0 : k === "hardware" ? 1 : 2);
  const push = (token: string, kind: ContentToken["kind"]): void => {
    const t = token.toLowerCase().replace(/\s+/g, "").replace(/,/g, "");
    if (t === "") return;
    const ix = out.findIndex((e) => e.token === t);
    if (ix < 0) out.push({ token: t, kind });
    else if (rank(kind) < rank(out[ix].kind)) out[ix].kind = kind;
  };
  const norm = normalizeText(text);
  const numberRe = /\d+(?:\.\d+)?\s*(?:x|%|gb|mb|tb|kb|bpp|bits?|params?|billion|million|ms|s\b|tokens?\s*\/\s*s)?/g;
  for (const m of norm.matchAll(numberRe)) {
    const t = m[0].replace(/\s+/g, "");
    if (/\d/.test(t)) push(t, "number");
  }
  for (const m of norm.matchAll(new RegExp(HARDWARE_RE.source, "g"))) {
    push(m[0], "hardware");
  }
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (raw.length < 2) continue;
    const w = raw.toLowerCase();
    if (STOPWORDS.has(w)) continue;
    if (/^[A-Z0-9]{2,}$/.test(raw) && /[A-Z]/.test(raw)) push(w, "term");
    else if (w.length >= 6 && /^[a-z]+$/.test(w)) push(w, "term");
  }
  // Drop bare numbers embedded in a hardware token (e.g. "100" inside "v100").
  const hw = new Set(out.filter((t) => t.kind === "hardware").map((t) => t.token));
  return out.filter((t) => {
    if (t.kind !== "number" || /\D/.test(t.token)) return true;
    for (const h of hw) if (h !== t.token && h.includes(t.token)) return false;
    return true;
  });
}

/** Canonical token form for occurrence search (digits stripped of separators, x-unified). */
const canon = (t: string): string => t.toLowerCase().replace(/,/g, "").replace(/\u00d7/g, "x").replace(/\s+/g, "");

/** True when the normalized token occurs in the normalized haystack. Pure-digit
 * tokens need a digit boundary on both sides (so "16" does not hit "16000"). */
export function tokenOccurs(token: string, haystackNorm: string): boolean {
  const c = canon(token);
  if (c === "") return false;
  const esc = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/^\d/.test(c)) return new RegExp(`(?<!\\d)${esc}(?!\\d)`).test(haystackNorm);
  return haystackNorm.includes(c);
}

export interface WriteMatch {
  matched: boolean;
  score: number;
}

/**
 * Sentence: fraction of unit content tokens present in the write (recall).
 * Match at recall >= 0.6 (at least 2 tokens when the unit is short).
 * Row: split on | or &; a cell matches when >= half its tokens are present;
 * the row matches when >= half its non-empty cells match (min 2 cells).
 */
export function matchWrite(unitText: string, kind: string, writeContent: string): WriteMatch {
  const hay = normalizeText(writeContent);
  if (kind === "row") {
    const cells = unitText.split(/[|&\\\\]+/).map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length === 0) return { matched: false, score: 0 };
    let hit = 0;
    for (const cell of cells) {
      const toks = contentTokens(cell);
      if (toks.length === 0) continue;
      const present = toks.filter((t) => tokenOccurs(t.token, hay)).length;
      if (present / toks.length >= 0.5) hit++;
    }
    const score = hit / cells.length;
    return { matched: cells.length >= 2 ? hit >= 2 && score >= 0.5 : hit >= 1, score };
  }
  const toks = contentTokens(unitText);
  if (toks.length === 0) {
    const n = normalizeText(unitText);
    return { matched: n !== "" && hay.includes(n), score: n !== "" && hay.includes(n) ? 1 : 0 };
  }
  const present = toks.filter((t) => tokenOccurs(t.token, hay)).length;
  const score = present / toks.length;
  const need = toks.length <= 2 ? toks.length : Math.max(2, Math.ceil(toks.length * 0.6));
  return { matched: present >= need && score >= 0.6, score };
}

/** Jaccard >= 0.3 over content-token sets: a reworded verify claim. */
export function nearVariant(a: string, b: string): boolean {
  const setOf = (s: string): Set<string> => new Set(contentTokens(s).map((t) => `${t.kind}:${t.token}`));
  const x = setOf(a);
  const y = setOf(b);
  if (x.size === 0 || y.size === 0) return false;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter) >= 0.3;
}

export interface ClassifyInput {
  cited: boolean;
  isRow: boolean;
  columnDemanded: boolean;
  demandStrong: boolean;
  /** Row + demanded, and no prior paper result supplied the row's number/hardware
   * content (or any content when the row has no numbers/hardware). */
  slotUnsupplied: boolean;
  revisionPhase: boolean;
  retrievalSinceRevision: boolean;
  priorPaperResults: number;
  hitCount: number;
  totalTokens: number;
  missingNumberOrHardware: boolean;
  nearVariantPresent?: boolean;
}

export interface CauseResult {
  primary: Cause;
  secondary: Cause | null;
  borderline: boolean;
}

export function classifyCause(i: ClassifyInput): CauseResult {
  if (!i.cited) return { primary: "UNCITED-KNOWLEDGE", secondary: null, borderline: false };
  const noPrior = i.priorPaperResults === 0 || i.hitCount === 0;
  const noNewRetrieval = !i.retrievalSinceRevision;
  if (i.isRow && i.columnDemanded && i.slotUnsupplied) {
    return {
      primary: "SLOT-FILL",
      secondary: i.revisionPhase && noNewRetrieval ? "REVISION-FILL" : null,
      borderline: !i.demandStrong,
    };
  }
  if (i.revisionPhase && noNewRetrieval) {
    let secondary: Cause | null = null;
    if (noPrior) secondary = "MEMORY";
    else if (i.missingNumberOrHardware && i.hitCount > 0) secondary = "MISREPORT";
    else secondary = "OVERREAD";
    return { primary: "REVISION-FILL", secondary, borderline: false };
  }
  if (noPrior) {
    return { primary: "MEMORY", secondary: null, borderline: false };
  }
  if (i.missingNumberOrHardware && i.hitCount > 0) {
    return {
      primary: "MISREPORT",
      secondary: i.isRow && i.columnDemanded ? "SLOT-FILL" : null,
      borderline: i.nearVariantPresent === false,
    };
  }
  return {
    primary: "OVERREAD",
    secondary: i.isRow && i.columnDemanded ? "SLOT-FILL" : null,
    borderline: i.hitCount < i.totalTokens,
  };
}
