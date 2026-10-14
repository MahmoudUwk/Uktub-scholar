/**
 * Release check of benchmarks/datasets/claim-verification-v2: the rows, the corpus manifest and the dataset manifest must agree with each other and
 * with the protocol files. Pure; `node scripts/bench-v2-validate.ts` runs it on the committed files and exits 1 on any problem.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { licenseAllowed } from "./bench-v2-corpus.ts";

export interface Files {
  claims: Array<Record<string, unknown>>;
  corpus: { papers: Array<Record<string, unknown>> };
  manifest: Record<string, any>;
  protocolHashes: { authoring: string; annotation: string };
}

const FIELDS = ["id", "paper", "arxiv_id", "arxiv_version", "license", "pdf_sha256", "claim", "label", "type", "kind", "evidence_quote", "altered_from_quote", "author_model", "annotator_model", "authoring_protocol_sha256", "annotation_protocol_sha256", "verification"];
const TYPES = ["reworded", "numeric", "perturbed", "fabricated", "contradiction", "general"];
const KINDS = ["method", "dataset", "finding", "limitation", "numeric"];
const POSITIVE = ["reworded", "numeric"];
const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
const countBy = (xs: string[]): Record<string, number> => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
const sameCounts = (a: Record<string, number>, b: Record<string, number>): boolean => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export function validateDataset(f: Files): string[] {
  const problems: string[] = [];
  const add = (m: string): void => void problems.push(m);
  const papers = new Map(f.corpus.papers.map((p) => [String(p.id), p]));
  for (const [id, p] of papers) {
    if (!Array.isArray(p.authors) || p.authors.length === 0) add(`corpus paper ${id}: no authors recorded (CC BY asks for credit)`);
    if (typeof p.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(p.sha256)) add(`corpus paper ${id}: sha256 is not a hex digest`);
    if (!licenseAllowed(typeof p.license === "string" ? p.license : null)) add(`corpus paper ${id}: the licence is not one an open dataset can carry`);
    if (!(typeof p.fold === "number" && p.fold >= 0 && p.fold <= 3)) add(`corpus paper ${id}: fold is not 0 to 3`);
  }
  const ids = new Map<string, string>();
  const claimsSeen = new Map<string, string>();
  let protocolOff = false;
  for (const r of f.claims) {
    const id = String(r.id);
    for (const field of FIELDS) if (!(field in r)) add(`${id}: missing field ${field}`);
    if (ids.has(id)) add(`duplicate id ${id}`);
    ids.set(id, id);
    const type = String(r.type);
    if (!TYPES.includes(type)) add(`${id}: unknown type ${type}`);
    const positive = POSITIVE.includes(type);
    if (r.label !== (positive ? "TRUE" : "FALSE")) add(`${id}: label ${String(r.label)} does not fit type ${type}`);
    const m = /^v2-(.+)-(\d{2})$/.exec(id);
    if (m === null || m[1] !== r.paper) add(`${id}: id does not follow its paper ${String(r.paper)}`);
    const norm = String(r.claim).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (claimsSeen.has(norm)) add(`${id}: duplicate claim of ${claimsSeen.get(norm)}`);
    claimsSeen.set(norm, id);
    const paper = papers.get(String(r.paper));
    if (paper === undefined) add(`${id}: paper ${String(r.paper)} is not in the corpus`);
    else {
      if (r.license !== paper.license) add(`${id}: the licence differs from the corpus's`);
      if (r.pdf_sha256 !== paper.sha256) add(`${id}: pdf sha256 differs from the corpus's`);
      if (r.paper !== `${String(r.arxiv_id)}v${String(r.arxiv_version)}`) add(`${id}: arxiv_id and arxiv_version do not make the paper id`);
    }
    if (!licenseAllowed(typeof r.license === "string" ? r.license : null)) add(`${id}: the licence ${String(r.license)} is not one an open dataset can carry`);
    const evidence = r.evidence_quote;
    const altered = r.altered_from_quote;
    const fits = type === "perturbed" ? typeof altered === "string" && evidence === null : type === "fabricated" || type === "general" ? evidence === null && altered === null : typeof evidence === "string" && altered === null;
    if (!fits) add(`${id}: the quote fields do not fit type ${type}`);
    for (const q of [evidence, altered]) if (typeof q === "string" && (wordCount(q) < 6 || wordCount(q) > 80)) add(`${id}: a quote of ${wordCount(q)} words (6 to 80 allowed)`);
    if (type === "general" ? r.kind !== "general" : !KINDS.includes(String(r.kind))) add(`${id}: kind ${String(r.kind)} is not allowed for type ${type}`);
    if (typeof r.author_model !== "string" || r.author_model === "" || typeof r.annotator_model !== "string" || r.annotator_model === "") add(`${id}: no author or annotator model recorded`);
    if (r.authoring_protocol_sha256 !== f.protocolHashes.authoring || r.annotation_protocol_sha256 !== f.protocolHashes.annotation) protocolOff = true;
  }
  if (protocolOff) add("rows name an authoring or annotation protocol whose hash is not the protocol file's: the protocol changed after the rows were written");
  const m = f.manifest;
  if (m.size !== f.claims.length) add(`manifest size ${String(m.size)} is not the ${f.claims.length} rows`);
  if (!sameCounts(m.labels ?? {}, countBy(f.claims.map((r) => String(r.label))))) add("manifest labels differ from the rows");
  if (!sameCounts(m.types ?? {}, countBy(f.claims.map((r) => String(r.type))))) add("manifest types differ from the rows");
  if (m.papers !== new Set(f.claims.map((r) => String(r.paper))).size) add(`manifest papers ${String(m.papers)} is not the number of papers with rows`);
  if (!sameCounts(m.licenses ?? {}, countBy(f.claims.map((r) => String(r.license))))) add("manifest licenses differ from the rows");
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = resolve(import.meta.dirname, "../benchmarks/datasets/claim-verification-v2");
  const read = (n: string): string => readFileSync(resolve(dir, n), "utf8");
  const sha = (n: string): string => createHash("sha256").update(readFileSync(resolve(dir, n))).digest("hex");
  const problems = validateDataset({ claims: JSON.parse(read("claims.json")).claims, corpus: JSON.parse(read("corpus.json")), manifest: JSON.parse(read("manifest.json")), protocolHashes: { authoring: sha("AUTHORING.md"), annotation: sha("ANNOTATION.md") } });
  for (const p of problems.slice(0, 40)) console.error(p);
  console.log(problems.length === 0 ? "claim-verification-v2: consistent" : `${problems.length} problem(s)`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
