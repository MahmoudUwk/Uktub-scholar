/**
 * Text renderings of a provenance audit: a compact summary for the tool result, and the full view for people and the reviewer.
 * Neither judges whether a cited paper supports a statement's meaning; "found" means the number or name occurs in the paper's
 * captured text, "verified" means `verify` supported this very wording.
 */
import { unlabelledUnverifiedUnits, type OpenItem, type ProvenanceAudit } from "./audit.ts";

/** Client policy: groups listed in the tool-result summary; the rest are counted. */
const SUMMARY_GROUPS = 10;
/** Client policy: characters of the full view (about 3,000 tokens). */
const FULL_CHARS = 9000;

function reasonOf(i: OpenItem): string {
  switch (i.status) {
    case "open": return `not found in ${i.papers.join(", ")}`;
    case "unsourced": return "cites no registered paper";
    case "check": return i.papers.length > 0 ? `the number occurs in ${i.papers.join(", ")} but never with its unit` : i.why;
    case "unavailable": return `unchecked: the text of ${i.papers.join(", ")} is not available`;
    default: return "cites no paper";
  }
}

interface Group { severity: OpenItem["severity"]; line: number; kind: OpenItem["kind"]; tokens: string[]; reason: string; excerpt: string }

function groupItems(items: OpenItem[]): Group[] {
  const groups = new Map<string, Group>();
  for (const i of items) {
    if (i.severity === "info") continue;
    const key = `${i.severity}|${i.file}:${i.line}|${i.kind}|${reasonOf(i)}`;
    const g = groups.get(key) ?? { severity: i.severity, line: i.line, kind: i.kind, tokens: [], reason: reasonOf(i), excerpt: i.excerpt };
    g.tokens.push(i.token);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** D1: prose statements that are not verified and carry no unverified label (rows are outside the gate). */
const unlabelledOf = unlabelledUnverifiedUnits;

const lineOf = (g: Group): string => `${g.severity.toUpperCase()} L${g.line} [${g.kind}] ${[...new Set(g.tokens)].join(", ")} — ${g.reason}`;

export function renderSummary(a: ProvenanceAudit, maxGroups = SUMMARY_GROUPS): string[] {
  const s = a.summary;
  if (s.audited === 0 && s.unregistered.length === 0) return [];
  const out = [
    `provenance: ${s.audited} statements and rows audited — ${s.verified} verified (verify supported this wording), ${s.cited} cite a registered paper but this wording was not verified, ${s.uncited} cite no paper; ${s.words} words in the body.`,
    `figures: ${s.figures.open} open, ${s.figures.check} check, ${s.figures.ok} found in the cited paper${s.figures.computed > 0 ? `, ${s.figures.computed} computed from project result files` : ""}; ${s.figures.info} ${s.figures.info === 1 ? "figure" : "figures"} in statements that cite no paper (not listed).`,
  ];
  out.push(`prose: ${s.unlabelledUnverified} unlabelled non-verified prose ${s.unlabelledUnverified === 1 ? "statement" : "statements"} (FAILS deliverable checks), ${s.labelledUnverified} labelled "unverified".`);
  if (s.unregistered.length > 0) out.push(`citations to papers that are not registered: ${s.unregistered.join(", ")}`);
  const groups = groupItems(a.items);
  for (const g of groups.slice(0, maxGroups)) out.push(lineOf(g));
  if (groups.length > maxGroups) out.push(`+${groups.length - maxGroups} more (see the full view)`);
  const unlabelled = unlabelledOf(a);
  for (const u of unlabelled.slice(0, maxGroups)) out.push(`UNLABELLED L${u.unit.line} [${u.unit.kind}] — not verified, and not labelled "unverified"`);
  if (unlabelled.length > maxGroups) out.push(`+${unlabelled.length - maxGroups} more unlabelled (see the full view)`);
  if (groups.length > 0 || unlabelled.length > 0) out.push("legend — OPEN: not found in the cited paper's text, or in a table row that cites no registered paper (FAILS deliverable checks). CHECK: weaker (a round number found without its unit). Fix by citing the paper that states it, removing it, or writing \"not reported\". UNLABELLED: a prose statement that is not verified and does not say so; it FAILS deliverable checks. Fix by verifying it, or by labelling it \"unverified\" in the text. Full view: uktub-scholar provenance");
  return out;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

export function renderFull(a: ProvenanceAudit, maxChars = FULL_CHARS): string {
  const s = a.summary;
  const lines: string[] = [
    "# Provenance view",
    "",
    "How to read it. verified: the package's verify ledger holds support for this exact wording from EVERY paper the statement cites (pointers shown). cited: the statement cites a registered paper but this wording was not verified. uncited: no citation. A prose statement that is not verified must carry the word \"unverified\" to ship (D1); the unlabelled ones are listed at the end. A figure is \"found\" when the number (or hardware name) occurs in the cited paper's captured text; this view never judges whether a paper supports a statement's meaning.",
    "",
    ...renderSummary(a, 1000).slice(0, 2),
  ];
  if (s.unregistered.length > 0) lines.push(`citations to papers that are not registered: ${s.unregistered.join(", ")}`);
  const groups = groupItems(a.items);
  for (const sev of ["open", "check"] as const) {
    const g = groups.filter((x) => x.severity === sev);
    lines.push("", `## ${sev === "open" ? "Open" : "Check"} (${g.length})`);
    if (g.length === 0) lines.push("none");
    for (const x of g) lines.push(`- ${lineOf(x).replace(/^(?:OPEN|CHECK) /, "")} — "${clip(x.excerpt, 110)}"`);
  }
  const computed: string[] = [];
  for (const u of a.units) {
    for (const f of u.figures) {
      if (f.status === "computed") computed.push(`- L${u.unit.line} ${f.token} — ${f.detail}`);
    }
  }
  if (computed.length > 0) lines.push("", `## Computed figures (${computed.length})`, ...computed);
  const by = (st: "verified" | "cited" | "uncited") => a.units.filter((u) => u.status === st);
  lines.push("", `## Verified statements (${by("verified").length})`);
  for (const u of by("verified")) lines.push(`- L${u.unit.line} "${clip(u.unit.plain, 100)}" -> ${(u.ledger?.pointers ?? []).slice(0, 2).join(", ")}`);
  lines.push("", `## Cited, wording not verified (${by("cited").length})`);
  for (const u of by("cited")) {
    const missing = u.unsupportedCites.length > 0 ? ` — not supported by: ${u.unsupportedCites.join(", ")}` : "";
    lines.push(`- L${u.unit.line} [${u.unit.kind}] "${clip(u.unit.plain, 100)}" (${u.unit.cites.join(", ")})${missing}`);
  }
  const info = a.items.filter((i) => i.severity === "info");
  lines.push("", `## Figures in statements that cite no paper (${info.length})`);
  for (const i of info) lines.push(`- L${i.line} ${i.token} — "${clip(i.excerpt, 90)}"`);
  const unlabelled = unlabelledOf(a);
  lines.push("", `## Unlabelled, not verified statements (${unlabelled.length})`);
  if (unlabelled.length === 0) lines.push("none");
  for (const u of unlabelled) lines.push(`- L${u.unit.line} [${u.unit.kind}] "${clip(u.unit.plain, 100)}"`);
  let used = 0;
  const kept: string[] = [];
  for (const l of lines) {
    if (used + l.length + 1 > maxChars - 60) break;
    kept.push(l);
    used += l.length + 1;
  }
  if (kept.length < lines.length) kept.push(`[truncated: ${lines.length - kept.length} more lines]`);
  return kept.join("\n");
}
