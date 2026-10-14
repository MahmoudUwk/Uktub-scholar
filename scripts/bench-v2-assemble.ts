/**
 * Assembly of claim-verification-v2 (docs/plans/2026-10-11-claim-verification-v2-benchmark-plan.md): the claims an author wrote, the programmatic
 * checks, the blind annotator's labels, and the claims that survive both. Pure; the file handling is in bench-v2-run.ts.
 */
import { mulberry32 } from "./bench-claims-v2-metrics.ts";
import type { Authored, ClaimType, Problem } from "./bench-v2-check.ts";
import { licenseAllowed } from "./bench-v2-corpus.ts";

export interface Annotation {
  id: string;
  label: "SUPPORTED" | "NOT_SUPPORTED";
  quote: string | null;
}

export interface DatasetClaim {
  id: string;
  paper: string;
  claim: string;
  label: "TRUE" | "FALSE";
  /** Why a FALSE claim is false; `reworded` or `numeric` for a TRUE one. */
  type: ClaimType;
  kind: string;
  /** TRUE: the quote that supports it. perturbed: the quote of the true fact it was altered from. contradiction: the quote it contradicts. */
  evidence: string | null;
}

export interface Drop {
  index: number;
  claim: string;
  type: ClaimType;
  reason: "check" | "annotator" | "unannotated";
  detail: string;
}

export interface Assembled {
  claims: DatasetClaim[];
  dropped: Drop[];
  /** Problems of the whole set (a wrong count): reported, they drop nothing. */
  setProblems: Problem[];
  /** Annotator against author, per type: how many it agreed with, of how many it labelled. */
  agreement: Record<string, { agreed: number; labelled: number }>;
}

/**
 * What an annotator is shown: the claims in a seeded order under neutral ids (k01, k02 … by position shown), with nothing about their type or
 * the author's order. `map` takes an id back to the author's index.
 */
export function blindInput(claims: Array<{ index: number; claim: string }>, seed: number): { input: Array<{ id: string; claim: string }>; map: Record<string, number> } {
  const order = [...claims];
  const rand = mulberry32(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j] as (typeof order)[number], order[i] as (typeof order)[number]];
  }
  const input: Array<{ id: string; claim: string }> = [];
  const map: Record<string, number> = {};
  for (const [pos, x] of order.entries()) {
    const id = `k${String(pos + 1).padStart(2, "0")}`;
    input.push({ id, claim: x.claim });
    map[id] = x.index;
  }
  return { input, map };
}

const POSITIVE: ClaimType[] = ["reworded", "numeric"];

/**
 * The claims of one paper that survive: no failed check, and the blind annotator labelled them as the author's type implies (SUPPORTED for a
 * reworded or numeric claim, NOT_SUPPORTED for every negative). Every drop is kept with its reason.
 */
export function assemblePaper(paper: string, authored: Authored[], problems: Problem[], annotations: Annotation[] | null, map: Record<string, number>): Assembled {
  const checkProblems = new Map<number, Problem[]>();
  for (const p of problems) if (p.index !== null) checkProblems.set(p.index, [...(checkProblems.get(p.index) ?? []), p]);
  const labelOf = new Map<number, Annotation>();
  for (const a of annotations ?? []) {
    const index = map[a.id];
    if (index !== undefined) labelOf.set(index, a);
  }
  const out: Assembled = { claims: [], dropped: [], setProblems: problems.filter((p) => p.index === null), agreement: {} };
  for (const [index, x] of authored.entries()) {
    const drop = (reason: Drop["reason"], detail: string): void => void out.dropped.push({ index, claim: x.claim, type: x.type, reason, detail });
    const failed = checkProblems.get(index);
    if (failed !== undefined) {
      drop("check", failed.map((p) => `${p.code}: ${p.message}`).join("; "));
      continue;
    }
    const a = labelOf.get(index);
    if (a === undefined) {
      drop("unannotated", "the annotator gave no label");
      continue;
    }
    const expected = POSITIVE.includes(x.type) ? "SUPPORTED" : "NOT_SUPPORTED";
    const cell = (out.agreement[x.type] ??= { agreed: 0, labelled: 0 });
    cell.labelled += 1;
    if (a.label !== expected) {
      drop("annotator", `the annotator said ${a.label}${a.quote ? ` (quote: ${a.quote})` : ""}`);
      continue;
    }
    cell.agreed += 1;
    out.claims.push({
      id: `v2-${paper}-${String(index + 1).padStart(2, "0")}`, paper, claim: x.claim, label: POSITIVE.includes(x.type) ? "TRUE" : "FALSE", type: x.type, kind: x.type === "general" ? "general" : x.kind,
      evidence: x.type === "perturbed" ? x.source_quote : x.type === "fabricated" || x.type === "general" ? null : x.evidence,
    });
  }
  return out;
}

/** What a row needs to know about where it came from: the paper's licence and PDF hash, who wrote and who annotated it, and the protocols they followed. */
export interface SourceInfo {
  license: string;
  pdfSha256: string;
  authorModel: string;
  annotatorModel: string;
  authoringProtocolSha256: string;
  annotationProtocolSha256: string;
}

export interface DatasetRow {
  id: string;
  paper: string;
  arxiv_id: string;
  arxiv_version: number;
  license: string;
  pdf_sha256: string;
  claim: string;
  label: "TRUE" | "FALSE";
  type: ClaimType;
  kind: string;
  evidence_quote: string | null;
  altered_from_quote: string | null;
  author_model: string;
  annotator_model: string;
  authoring_protocol_sha256: string;
  annotation_protocol_sha256: string;
  verification: string;
}

/**
 * The released form of a claim. It refuses a claim whose paper's licence an open dataset cannot carry (only CC BY and CC0 papers are in the corpus,
 * and this is the last place that can still say no) or whose provenance is incomplete.
 */
export function toRow(c: DatasetClaim, s: SourceInfo): DatasetRow {
  if (!licenseAllowed(s.license)) throw new Error(`${c.paper}: the licence (${s.license || "none"}) is not one an open dataset can carry`);
  if (!s.authorModel) throw new Error(`${c.paper}: no author model is recorded`);
  if (!s.annotatorModel) throw new Error(`${c.paper}: no annotator model is recorded`);
  if (!s.pdfSha256) throw new Error(`${c.paper}: no PDF sha256 is recorded`);
  const id = /^(.+)v(\d+)$/.exec(c.paper);
  if (id === null) throw new Error(`${c.paper}: not an arXiv id with a version`);
  return {
    id: c.id, paper: c.paper, arxiv_id: id[1] as string, arxiv_version: Number(id[2]), license: s.license.trim(), pdf_sha256: s.pdfSha256,
    claim: c.claim, label: c.label, type: c.type, kind: c.kind,
    evidence_quote: c.type === "reworded" || c.type === "numeric" || c.type === "contradiction" ? c.evidence : null,
    altered_from_quote: c.type === "perturbed" ? c.evidence : null,
    author_model: s.authorModel, annotator_model: s.annotatorModel,
    authoring_protocol_sha256: s.authoringProtocolSha256, annotation_protocol_sha256: s.annotationProtocolSha256,
    verification: "passed the programmatic checks (scripts/bench-v2-check.ts) and a blind annotator, who did not know the claim's type, agreed with its label",
  };
}

/**
 * The ids of the annotated sentences that are not the authored claim any more (the author file changed after the annotator was shown it, or the
 * index it points at is gone). Labels of those ids must not be used.
 */
export function staleAnnotations(authored: Authored[], input: Array<{ id: string; claim: string }>, map: Record<string, number>): string[] {
  return input.filter((x) => {
    const index = map[x.id];
    return index === undefined || authored[index]?.claim !== x.claim;
  }).map((x) => x.id);
}
