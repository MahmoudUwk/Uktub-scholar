/**
 * claim-verification-v2: download the papers the published manifest lists, and nothing else, so anyone can rebuild the texts the claims were
 * written against (the PDFs are not redistributed). Every file is checked against the manifest's sha256 and size; the text is extracted with
 * the command the manifest records (`pdftotext -q`), and a different character count is reported (a different poppler version can do it).
 *
 *   node scripts/bench-v2-fetch.ts --out <dir> [--corpus benchmarks/datasets/claim-verification-v2/corpus.json]
 *
 * Writes <dir>/pdf/<id>.pdf and <dir>/text/<id>.txt, the layout `scripts/bench-claims-v2.ts --pdf-dir <dir>/pdf` reads. Re-running skips files that
 * are already there with the right hash. It never rebuilds or rewrites the manifest (that is scripts/bench-v2-corpus.ts --rebuild).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Listed { id: string; sha256: string; bytes: number; pdfUrl: string; chars?: number }

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** Is this the file the manifest records? The size is checked first (cheap), then the hash. */
export function verifyPdf(bytes: Uint8Array, paper: Listed): { ok: true } | { ok: false; reason: string } {
  if (bytes.length !== paper.bytes) return { ok: false, reason: `${paper.id}: size ${bytes.length} bytes, the manifest records ${paper.bytes}` };
  const got = sha256(bytes);
  if (got !== paper.sha256) return { ok: false, reason: `${paper.id}: sha256 ${got.slice(0, 16)}…, the manifest records ${paper.sha256.slice(0, 16)}…` };
  return { ok: true };
}

/** What a run has to do: papers already on disk with the right hash, papers to download (in manifest order), papers on disk with another hash. */
export function planFetch(papers: Listed[], onDisk: Map<string, string>): { have: string[]; download: string[]; mismatch: string[] } {
  const have: string[] = [];
  const download: string[] = [];
  const mismatch: string[] = [];
  for (const p of papers) {
    const disk = onDisk.get(p.id);
    if (disk === undefined) download.push(p.id);
    else if (disk === p.sha256) have.push(p.id);
    else mismatch.push(p.id);
  }
  return { have, download, mismatch };
}

/** Client policy: arXiv asks automated clients for one request every 3 seconds. */
const SPACING_MS = 3_000;

async function main(): Promise<void> {
  const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : process.argv[i + 1]; };
  const out = arg("out");
  if (!out) throw new Error("usage: bench-v2-fetch.ts --out <dir> [--corpus <corpus.json>]");
  const corpusPath = arg("corpus") ?? "benchmarks/datasets/claim-verification-v2/corpus.json";
  const papers = (JSON.parse(readFileSync(corpusPath, "utf8")) as { papers: Listed[] }).papers;
  mkdirSync(join(out, "pdf"), { recursive: true });
  mkdirSync(join(out, "text"), { recursive: true });
  const onDisk = new Map<string, string>();
  for (const p of papers) {
    const file = join(out, "pdf", `${p.id}.pdf`);
    if (existsSync(file)) onDisk.set(p.id, sha256(new Uint8Array(readFileSync(file))));
  }
  const plan = planFetch(papers, onDisk);
  console.log(`${papers.length} papers: ${plan.have.length} already here, ${plan.download.length} to download, ${plan.mismatch.length} on disk with another hash`);
  if (plan.mismatch.length > 0) throw new Error(`these files differ from the manifest, move them away and run again: ${plan.mismatch.join(", ")}`);
  const byId = new Map(papers.map((p) => [p.id, p]));
  let failed = 0;
  for (const [i, id] of plan.download.entries()) {
    const p = byId.get(id) as Listed;
    const res = await fetch(p.pdfUrl, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) { console.error(`${id}: HTTP ${res.status}`); failed += 1; continue; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const v = verifyPdf(bytes, p);
    if (!v.ok) { console.error(v.reason); failed += 1; continue; }
    writeFileSync(join(out, "pdf", `${id}.pdf`), bytes);
    console.log(`${i + 1}/${plan.download.length} ${id}`);
    await new Promise((r) => setTimeout(r, SPACING_MS));
  }
  let drift = 0;
  for (const p of papers) {
    const pdf = join(out, "pdf", `${p.id}.pdf`);
    if (!existsSync(pdf)) continue;
    const txt = join(out, "text", `${p.id}.txt`);
    if (!existsSync(txt) && spawnSync("pdftotext", ["-q", pdf, txt], { encoding: "utf8" }).status !== 0) { console.error(`${p.id}: pdftotext failed`); failed += 1; continue; }
    if (p.chars !== undefined && existsSync(txt) && statSync(txt).size !== p.chars) drift += 1;
  }
  if (drift > 0) console.warn(`${drift} text file(s) have another size than the manifest records: a different pdftotext version extracts slightly different text, so quotes may match less exactly`);
  if (failed > 0) throw new Error(`${failed} paper(s) could not be fetched or extracted`);
  console.log(`done: ${papers.length} papers in ${out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
