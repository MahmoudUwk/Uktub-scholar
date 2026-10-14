/**
 * Post-compose replay: label join and metric arithmetic (pure; tested in
 * tests/post-compose-metrics.spec.ts). The runner (replay-post-compose.ts)
 * produces UnitRows; everything here is deterministic arithmetic over them.
 */

export type Pass = "A" | "B";
export type Outcome = "promoted" | "not-found" | "skipped" | "error";

/** One unit's replay result, joined with its Muse locator label. */
export interface UnitRow {
  iter: string;
  note: string;
  id: string;
  kind: string;
  pass: Pass;
  /** Muse locator label, or null when the id did not join. */
  label: string | null;
  cites: string[];
  outcome: Outcome;
  /** Citekeys of registered papers with supporting evidence (hits only). */
  supportingPapers: string[];
  /** Union of citekeys the note cites anywhere (for Pass B hits). */
  noteCited: string[];
  /** Product verdict completeness (single call, no continuation). */
  complete: boolean | null;
  timeMs: number;
  judgments: number;
}

/** Pass A = cited units verify their exact text against their OWN cited papers. */
export function passOf(cites: string[]): Pass {
  return cites.length > 0 ? "A" : "B";
}

/** Join provenance units to Muse labels by unit id. Null when the id is absent. */
export function joinLabel(labelById: Map<string, string>, id: string): string | null {
  return labelById.get(id) ?? null;
}

/** Muse labels that count as bad when a cited unit is promoted. */
export const BAD_CITED = new Set(["unsupported", "wrong", "misattributed"]);

export interface Rate {
  num: number;
  den: number;
  /** null when the denominator is zero. */
  rate: number | null;
}

const rate = (num: number, den: number): Rate => ({ num, den, rate: den === 0 ? null : num / den });

export function p95(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] ?? null;
}

export interface PassAMetrics {
  n: number;
  verified: number;
  skipped: number;
  promoted: number;
  promotion: Rate;
  supported: Rate;
  recallSupported: Rate;
  fdr: Rate;
  badPromoted: number;
}

export interface PassBClassMetrics {
  n: number;
  verified: number;
  found: number;
  share: Rate;
}

export interface PassBMetrics {
  specific: PassBClassMetrics;
  background: PassBClassMetrics;
  /** Hits whose supporting paper the note cites elsewhere. */
  hitsCitedElsewhere: Rate;
}

export interface GroupMetrics {
  passA: PassAMetrics;
  passB: PassBMetrics;
  skipped: number;
  errors: number;
  unjoined: number;
  wallMs: number;
  judgments: number;
  notes: number;
}

const emptyA = (): PassAMetrics => ({
  n: 0, verified: 0, skipped: 0, promoted: 0,
  promotion: rate(0, 0), supported: rate(0, 0), recallSupported: rate(0, 0), fdr: rate(0, 0),
  badPromoted: 0,
});

const emptyClass = (): PassBClassMetrics => ({ n: 0, verified: 0, found: 0, share: rate(0, 0) });

export function computeGroup(rows: UnitRow[]): GroupMetrics {
  const a = rows.filter((r) => r.pass === "A");
  const aVer = a.filter((r) => r.outcome === "promoted" || r.outcome === "not-found");
  const aProm = a.filter((r) => r.outcome === "promoted");
  const aSup = aVer.filter((r) => r.label === "supported");
  const aSupProm = aProm.filter((r) => r.label === "supported");
  const badProm = aProm.filter((r) => r.label !== null && BAD_CITED.has(r.label)).length;
  const aPromLabelled = aProm.filter((r) => r.label !== null);

  const cls = (label: string): PassBClassMetrics => {
    const all = rows.filter((r) => r.pass === "B" && r.label === label);
    const ver = all.filter((r) => r.outcome === "promoted" || r.outcome === "not-found");
    const found = ver.filter((r) => r.outcome === "promoted").length;
    return { n: all.length, verified: ver.length, found, share: rate(found, ver.length) };
  };

  const bHits = rows.filter((r) => r.pass === "B" && r.outcome === "promoted");
  const elsewhere = bHits.filter((r) =>
    r.supportingPapers.some((p) => r.noteCited.includes(p)),
  ).length;

  const passA: PassAMetrics = {
    n: a.length,
    verified: aVer.length,
    skipped: a.length - aVer.length,
    promoted: aProm.length,
    promotion: rate(aProm.length, aVer.length),
    supported: rate(aSup.length, aVer.filter((r) => r.label !== null).length),
    recallSupported: rate(aSupProm.length, aSup.length),
    fdr: rate(badProm, aPromLabelled.length),
    badPromoted: badProm,
  };
  return {
    passA,
    passB: {
      specific: cls("specific"),
      background: cls("background"),
      hitsCitedElsewhere: rate(elsewhere, bHits.length),
    },
    skipped: rows.filter((r) => r.outcome === "skipped").length,
    errors: rows.filter((r) => r.outcome === "error").length,
    unjoined: rows.filter((r) => r.label === null).length,
    wallMs: rows.reduce((s, r) => s + r.timeMs, 0),
    judgments: rows.reduce((s, r) => s + r.judgments, 0),
    notes: new Set(rows.map((r) => r.note)).size,
  };
}

export interface Split {
  dev: string[];
  heldout: string[];
}

export interface FullMetrics {
  overall: GroupMetrics;
  dev: GroupMetrics;
  heldout: GroupMetrics;
  perNote: Record<string, GroupMetrics>;
}

export function computeMetrics(rows: UnitRow[], split: Split): FullMetrics {
  const devSet = new Set(split.dev);
  const heldSet = new Set(split.heldout);
  const perNote: Record<string, GroupMetrics> = {};
  const byNote = new Map<string, UnitRow[]>();
  for (const r of rows) {
    const l = byNote.get(r.note) ?? [];
    l.push(r);
    byNote.set(r.note, l);
  }
  for (const [note, rs] of byNote) perNote[note] = computeGroup(rs);
  return {
    overall: computeGroup(rows),
    dev: computeGroup(rows.filter((r) => devSet.has(r.iter))),
    heldout: computeGroup(rows.filter((r) => heldSet.has(r.iter))),
    perNote,
  };
}
