/**
 * The file handling of the claim-verification-v2 pipeline (docs/plans/2026-10-11-claim-verification-v2-benchmark-plan.md); the logic is in
 * bench-v2-check.ts and bench-v2-assemble.ts. Work files live outside the repository; only the finished dataset is written into it.
 *
 *   node scripts/bench-v2-run.ts check    --work <dir> --text <dir> [--corpus <file>]
 *   node scripts/bench-v2-run.ts blind    --work <dir>              [--corpus <file>] [--seed N]
 *   node scripts/bench-v2-run.ts assemble --work <dir> --out <dir>  [--corpus <file>]   (models come from <work>/provenance.json; the licence and PDF hash from the corpus)
 *
 * <work>/author/<paper>.json (the author's 12 claims) -> check -> <work>/problems/<paper>.json
 * -> blind -> <work>/annotate/<paper>.input.json + .map.json -> (annotator) <paper>.labels.json -> assemble -> claims.json, dropped.json, manifest.json
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assemblePaper, blindInput, staleAnnotations, toRow, type Annotation, type Assembled, type DatasetRow } from "./bench-v2-assemble.ts";
import { checkAuthored, type Authored, type Problem } from "./bench-v2-check.ts";

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : process.argv[i + 1]; };
const need = (n: string): string => arg(n) ?? (() => { throw new Error(`--${n} is required`); })();
const cmd = process.argv[2];
const corpusFile = arg("corpus") ?? "benchmarks/datasets/claim-verification-v2/corpus.json";
const corpus = JSON.parse(readFileSync(corpusFile, "utf8")) as { papers: Array<{ id: string; category: string; fold: number; title: string; license?: string; sha256?: string }> };
const readJson = <T>(file: string): T | null => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null);
const hash = (s: string): number => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

if (cmd === "check") {
  const work = need("work");
  const text = need("text");
  mkdirSync(join(work, "problems"), { recursive: true });
  const byCode: Record<string, number> = {};
  let missing = 0;
  for (const p of corpus.papers) {
    const authored = readJson<Authored[]>(join(work, "author", `${p.id}.json`));
    if (authored === null) { missing += 1; continue; }
    const problems = checkAuthored(Array.isArray(authored) ? authored : [], readFileSync(join(text, `${p.id}.txt`), "utf8"));
    if (!Array.isArray(authored)) problems.push({ index: null, code: "format", message: "the author's file is not a JSON array" });
    writeFileSync(join(work, "problems", `${p.id}.json`), JSON.stringify(problems, null, 1));
    for (const x of problems) byCode[x.code] = (byCode[x.code] ?? 0) + 1;
    console.log(`${p.id} (${p.category}): ${Array.isArray(authored) ? authored.length : 0} claims, ${problems.length} problem(s)${problems.length ? ` [${problems.map((x) => `${x.index ?? "set"}:${x.code}`).join(" ")}]` : ""}`);
  }
  console.log(`no author file yet: ${missing}; problems by code: ${JSON.stringify(byCode)}`);
} else if (cmd === "blind") {
  const work = need("work");
  const seed = Number(arg("seed") ?? "20261011");
  mkdirSync(join(work, "annotate"), { recursive: true });
  for (const p of corpus.papers) {
    const authored = readJson<Authored[]>(join(work, "author", `${p.id}.json`));
    const problems = readJson<Problem[]>(join(work, "problems", `${p.id}.json`));
    if (authored === null || problems === null) continue;
    if (existsSync(join(work, "annotate", `${p.id}.labels.json`))) continue; // labelled: its input and map are frozen
    const bad = new Set(problems.filter((x) => x.index !== null).map((x) => x.index as number));
    const shown = authored.flatMap((x, index) => (bad.has(index) ? [] : [{ index, claim: x.claim }]));
    const { input, map } = blindInput(shown, (seed ^ hash(p.id)) >>> 0);
    writeFileSync(join(work, "annotate", `${p.id}.input.json`), JSON.stringify(input, null, 1));
    writeFileSync(join(work, "annotate", `${p.id}.map.json`), JSON.stringify(map));
    console.log(`${p.id}: ${input.length} claims for the annotator`);
  }
} else if (cmd === "assemble") {
  const work = need("work");
  const out = need("out");
  mkdirSync(out, { recursive: true });
  const claims: DatasetRow[] = [];
  const provenance = readJson<Record<string, { author?: string; annotator?: string }>>(join(work, "provenance.json")) ?? {};
  const sha = (f: string): string => createHash("sha256").update(readFileSync(f)).digest("hex");
  const authoringSha = sha("benchmarks/datasets/claim-verification-v2/AUTHORING.md");
  const annotationSha = sha("benchmarks/datasets/claim-verification-v2/ANNOTATION.md");
  const dropped: Array<Record<string, unknown>> = [];
  const setProblems: Array<Record<string, unknown>> = [];
  const agreement: Record<string, { agreed: number; labelled: number }> = {};
  const byPaper: Array<Record<string, unknown>> = [];
  for (const p of corpus.papers) {
    const authored = readJson<Authored[]>(join(work, "author", `${p.id}.json`));
    const problems = readJson<Problem[]>(join(work, "problems", `${p.id}.json`));
    if (authored === null || problems === null) continue;
    const allLabels = readJson<Annotation[]>(join(work, "annotate", `${p.id}.labels.json`));
    const map = readJson<Record<string, number>>(join(work, "annotate", `${p.id}.map.json`)) ?? {};
    // A label counts only for the claim the annotator was shown: if the author file changed afterwards, that claim is unannotated, not agreed.
    const shown = readJson<Array<{ id: string; claim: string }>>(join(work, "annotate", `${p.id}.input.json`)) ?? [];
    const stale = new Set(staleAnnotations(authored, shown, map));
    if (stale.size > 0) console.log(`${p.id}: ${stale.size} label(s) belong to a claim that changed after annotation and are not used`);
    const labels = allLabels === null ? null : allLabels.filter((a) => !stale.has(a.id));
    const r: Assembled = assemblePaper(p.id, authored, problems, labels, map);
    for (const c of r.claims) {
      claims.push(toRow(c, { license: p.license ?? "", pdfSha256: p.sha256 ?? "", authorModel: provenance[p.id]?.author ?? "", annotatorModel: provenance[p.id]?.annotator ?? "", authoringProtocolSha256: authoringSha, annotationProtocolSha256: annotationSha }));
    }
    for (const d of r.dropped) dropped.push({ paper: p.id, ...d });
    for (const s of r.setProblems) setProblems.push({ paper: p.id, ...s });
    for (const [t, c] of Object.entries(r.agreement)) { const a = (agreement[t] ??= { agreed: 0, labelled: 0 }); a.agreed += c.agreed; a.labelled += c.labelled; }
    byPaper.push({ paper: p.id, category: p.category, fold: p.fold, authored: authored.length, kept: r.claims.length });
  }
  const count = (f: (c: DatasetRow) => string): Record<string, number> => claims.reduce<Record<string, number>>((m, c) => ((m[f(c)] = (m[f(c)] ?? 0) + 1), m), {});
  writeFileSync(join(out, "claims.json"), JSON.stringify({ claims }, null, 1));
  writeFileSync(join(out, "dropped.json"), JSON.stringify({ dropped, setProblems }, null, 1));
  writeFileSync(join(out, "manifest.json"), JSON.stringify({
    dataset: "claim-verification-v2", created: new Date().toISOString().slice(0, 10), size: claims.length,
    labels: count((c) => c.label), types: count((c) => c.type), kinds: count((c) => c.kind), papers: byPaper.length, corpus: "corpus.json (ids, versions, sha256, extraction command, rule, seed)",
    authors: { description: "independent of the annotators, one author per paper, protocol AUTHORING.md", protocolSha256: authoringSha, claimsByModel: count((c) => c.author_model) },
    annotators: { description: "independent of the authors, blind to a claim's type and label, protocol ANNOTATION.md", protocolSha256: annotationSha, claimsByModel: count((c) => c.annotator_model) },
    licenses: count((c) => c.license),
    keptRule: "a claim is kept only if it passes the programmatic checks (scripts/bench-v2-check.ts) AND the annotator's label matches the author's type; every drop is in dropped.json with its reason",
    agreementByType: agreement, perPaper: byPaper,
    schema: { id: "v2-<paper>-<nn>", paper: "arXiv id with version (corpus.json)", arxiv_id: "without the version", arxiv_version: "the version the PDF was taken from", license: "the paper's licence URI", pdf_sha256: "of the PDF the claim was written from", claim: "one sentence", label: "TRUE = the paper supports it; FALSE = it does not", type: "reworded | numeric (TRUE); perturbed | fabricated | contradiction | general (FALSE)", kind: "method | dataset | finding | limitation | numeric | general", evidence_quote: "verbatim quote that supports (TRUE) or is contradicted (contradiction), else null", altered_from_quote: "verbatim quote of the true fact a perturbed claim was altered from, else null", author_model: "model that wrote the claim", annotator_model: "model that labelled it blind", authoring_protocol_sha256: "of AUTHORING.md", annotation_protocol_sha256: "of ANNOTATION.md", verification: "what the claim passed" },
  }, null, 1));
  console.log(`${claims.length} claims kept (${JSON.stringify(count((c) => c.label))}); ${dropped.length} dropped; manifest and claims in ${out}`);
} else {
  throw new Error("usage: bench-v2-run.ts check | blind | assemble (see the file header)");
}
