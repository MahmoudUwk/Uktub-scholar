/**
 * Frozen skill cases: a real Pi session (google-vertex/gemini-3.8-flash) is given a task that one of the package's product skills
 * (skills/<name>/SKILL.md) is for. Prompts describe user intent and never name the skill. A case holds the agent to the skill's
 * contract: it noticed and loaded the skill, followed its process, and the artifact it produced is checked deterministically
 * (files, bytes, extracted data). The artifact is also kept for a human or model to look at. Verdict meanings: cases.ts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { AgentCase } from "./agent-cases.ts";
import type { Turn } from "./agent.ts";
import { NotRun } from "./cases.ts";

export const SKILL_CASES_VERSION = "2026-10-10.2";

/** Deterministic user data (the controller's fixture, not an expected answer): accuracy of two methods against training-set size. */
export function writeFigureFixtures(project: string): { means: Record<string, number[]>; sizes: number[] } {
  const sizes = [100, 200, 500, 1000, 2000, 5000];
  let s = 20261009;
  const rnd = (): number => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rows = ["method,train_size,seed,accuracy"];
  const sums: Record<string, number[]> = { baseline: sizes.map(() => 0), ours: sizes.map(() => 0) };
  for (const [method, base, gain] of [["baseline", 0.46, 0.085], ["ours", 0.52, 0.105]] as const) {
    sizes.forEach((n, i) => {
      for (let seed = 1; seed <= 3; seed++) {
        const acc = Math.round((base + gain * Math.log10(n / 100) + (rnd() - 0.5) * 0.02) * 1000) / 1000;
        rows.push(`${method},${n},${seed},${acc}`);
        sums[method]![i]! += acc / 3;
      }
    });
  }
  mkdirSync(join(project, "data"), { recursive: true });
  writeFileSync(join(project, "data/accuracy.csv"), `${rows.join("\n")}\n`);
  return { means: sums, sizes };
}

/**
 * The fixture is built so that the method with the most data per size does NOT win across sizes: "ours" at 500 examples (0.591) is below
 * the baseline at 5,000 (0.609). A caption or summary that says otherwise is an overclaim (found live: an agent wrote "higher accuracy
 * with 500 examples than the baseline achieves with 5,000"). Returns the offending phrase.
 */
export function overclaimsAcrossSizes(text: string): string | undefined {
  const verb = "(?:match\\w*|higher|exceed\\w*|outperform\\w*|surpass\\w*|beat\\w*|better|equal\\w*)";
  const forward = new RegExp(`\\b${verb}\\b[^.\\n]{0,100}\\b500\\b[^.\\n]{0,140}\\b5,?000\\b`, "i");
  const backward = new RegExp(`\\b500\\b[^.\\n]{0,100}\\b${verb}\\b[^.\\n]{0,100}\\b5,?000\\b`, "i");
  return forward.exec(text)?.[0] ?? backward.exec(text)?.[0];
}


/** What the live cases need to know about a real test paper, kept beside the paper in `test_papers/<name>/uktub-case.json` (gitignored). */
export interface TestPaper {
  dir: string; entry: string; pdf: string; title: RegExp; limitations: RegExp[]; exclude: string[];
  docx: { mustContain: RegExp; headings: number; images: number; equations: number; tables: number; bibliography: number };
}
const TEST_PAPERS = resolve(import.meta.dirname, "../../test_papers");
/** The first folder under `test_papers/` that has a `uktub-case.json`; NOT_RUN (with what to add) when there is none. */
export function loadTestPaper(root: string = TEST_PAPERS): TestPaper {
  const dir = existsSync(root) ? readdirSync(root).map((n) => join(root, n)).find((d) => statSync(d).isDirectory() && existsSync(join(d, "uktub-case.json"))) : undefined;
  if (dir === undefined) throw new NotRun("no test paper: put a LaTeX paper in test_papers/<name>/ with a uktub-case.json (fields: docs/testing.md); the cases that need a real paper are NOT_RUN without it");
  const file = join(dir, "uktub-case.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> & { docx?: Record<string, unknown> };
  const need = <T>(value: T | undefined, name: string): T => {
    if (value === undefined) throw new Error(`${file}: missing "${name}"`);
    return value;
  };
  const docx = need(raw.docx, "docx");
  const pattern = (v: unknown, name: string) => new RegExp(String(need(v, name)), "i");
  return {
    dir,
    entry: String(need(raw.entry, "entry")),
    pdf: String(need(raw.pdf, "pdf")),
    title: pattern(raw.title, "title"),
    limitations: need(raw.limitations as string[] | undefined, "limitations").map((l) => new RegExp(l, "i")),
    exclude: (raw.exclude as string[] | undefined) ?? [],
    docx: {
      mustContain: pattern(docx.mustContain, "docx.mustContain"),
      headings: Number(need(docx.headings, "docx.headings")), images: Number(need(docx.images, "docx.images")),
      equations: Number(need(docx.equations, "docx.equations")), tables: Number(need(docx.tables, "docx.tables")),
      bibliography: Number(need(docx.bibliography, "docx.bibliography")),
    },
  };
}
/** Copy the paper into the project as the manuscript: without build products, its published PDF, the names its config excludes and the config itself (the grader's expectations). */
export function writeOwnPaper(project: string, paper: TestPaper): void {
  mkdirSync(join(project, "manuscript"), { recursive: true });
  cpSync(paper.dir, join(project, "manuscript"), {
    recursive: true,
    filter: (src) => !/\.(?:aux|bbl|blg|fdb_latexmk|fls|log|out|spl)$/.test(src) && ![paper.pdf, "uktub-case.json", ...paper.exclude].includes(basename(src)),
  });
}

/** Digest of every file under a folder: a read-only task must leave it unchanged. */
export function treeDigest(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(`${p.slice(dir.length)}\0${createHash("sha256").update(readFileSync(p)).digest("hex")}\n`);
    }
  };
  walk(dir);
  return h.digest("hex");
}

/** Like treeDigest, ignoring one top-level folder (what the task is allowed to add). */
export function treeDigestExcept(dir: string, skip: string): string {
  const h = createHash("sha256");
  for (const name of readdirSync(dir).sort()) {
    if (name === skip) continue;
    const p = join(dir, name);
    h.update(`${name}\0${statSync(p).isDirectory() ? treeDigest(p) : createHash("sha256").update(readFileSync(p)).digest("hex")}\n`);
  }
  return h.digest("hex");
}

/** The `file.tex:line` pointers in an answer that name a real file of the manuscript and a line that exists in it. */
export function pointerCheck(answer: string, manuscriptDir: string): { valid: string[]; invalid: string[] } {
  const found = [...new Set([...answer.matchAll(/\b([A-Za-z0-9_-]+\.tex):(\d+)/g)].map((m) => `${m[1]}:${m[2]}`))];
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const ptr of found) {
    const [file, line] = ptr.split(":") as [string, string];
    const path = [join(manuscriptDir, file), ...(existsSync(manuscriptDir) ? readdirSync(manuscriptDir).map((d) => join(manuscriptDir, d, file)) : [])].find((c) => existsSync(c) && statSync(c).isFile());
    if (path !== undefined && Number(line) >= 1 && Number(line) <= readFileSync(path, "utf8").replace(/\n$/, "").split("\n").length) valid.push(ptr);
    else invalid.push(ptr);
  }
  return { valid, invalid };
}

/**
 * Quotes in a review must be the paper's words. Each quoted passage (30+ characters in curly or straight double quotes) is compared with the
 * manuscript on letters and digits only, so LaTeX markup ("1\\%", braces, "\\mathrm") cannot cause a false alarm; a passage counts when its first
 * 50 such characters appear in the source. Returns the passages that do not.
 */
export function unfoundQuotes(answer: string, manuscriptDir: string): { total: number; missing: string[] } {
  const alnum = (x: string): string => x.toLowerCase().replace(/\\(?:rev|mathrm|textbf|textit|emph|text)\b/g, "").replace(/[^a-z0-9]+/g, "");
  let source = "";
  const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith(".tex")) source += `${readFileSync(p, "utf8")}\n`; } };
  walk(manuscriptDir);
  const haystack = alnum(source);
  const quotes = [...answer.matchAll(/[“"]([^”"\n]{30,500})[”"]/g)].map((m) => m[1]!);
  const missing = quotes.filter((q) => !haystack.includes(alnum(q.replace(/\.\.\.|…/g, " ")).slice(0, 50)));
  return { total: quotes.length, missing };
}

/** Host-side look at a PDF the agent made: text, page count, page width in points, and whether ink touches the page edge (a clipped drawing). */
export function inspectPdf(pdf: string, previewPng: string): { text: string; pages: number; widthPt: number; touchesEdge: boolean | undefined } {
  const text = spawnSync("pdftotext", [pdf, "-"], { encoding: "utf8" }).stdout ?? "";
  const info = spawnSync("pdfinfo", [pdf], { encoding: "utf8" }).stdout ?? "";
  const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? 0);
  const widthPt = Number(/Page size:\s+([\d.]+)\s+x/.exec(info)?.[1] ?? 0);
  spawnSync("pdftoppm", ["-png", "-r", "100", "-singlefile", pdf, previewPng.replace(/\.png$/, "")]);
  const edge = spawnSync("python3", ["-c", "import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert('L'); w,h=im.size; px=im.load()\nedge=[px[x,y] for x in range(w) for y in (0,1,h-2,h-1)]+[px[x,y] for y in range(h) for x in (0,1,w-2,w-1)]\nprint('edge' if min(edge)<200 else 'clear')", previewPng], { encoding: "utf8" });
  return { text, pages, widthPt, touchesEdge: edge.status === 0 ? edge.stdout.trim() === "edge" : undefined };
}

/** Decimal numbers on a deck (12.5, 0.75) that the paper never states: a talk may not add results. Compared on digits only, so "1\\%" or "12.5~\\textcent" cannot hide a match. */
export function numbersNotInPaper(deckText: string, manuscriptDir: string): { total: number; missing: string[] } {
  let source = "";
  const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(?:tex|bib)$/.test(n)) source += `${readFileSync(p, "utf8")}\n`; } };
  walk(manuscriptDir);
  // a pointer into the paper ("Section 5.3", "Table 5.5", "lines 499\u2013506") is not a result
  const stripped = deckText.replace(/\b(?:Sections?|Secs?\.?|Tables?|Figures?|Figs?\.?|Eqs?\.?|Equations?|lines?)\s*~?\d+(?:\.\d+)*(?:\s*(?:,|and|&|to|--|\u2013|-)\s*\d+(?:\.\d+)*)*/gi, " ");
  const numbers = [...new Set(stripped.match(/(?<!\d)(?<!\d\.)\d+\.\d+(?!\d)(?!\.\d)/g) ?? [])];
  // compare values, not spellings: a table's 39.20 is the text's 39.2
  const canon = (n: string): string => String(Number(n));
  const inPaper = new Set((source.match(/\d+(?:\.\d+)?/g) ?? []).map(canon));
  const missing = numbers.filter((n) => !inPaper.has(canon(n)));
  return { total: numbers.length, missing };
}

const WNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
/** A tiny synthetic paper (public, no real work behind it) for the cases that need a manuscript but not a real one. */
export function writeMiniPaper(project: string): void {
  const dir = join(project, "manuscript");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n\\title{A Synthetic Study of Error Reduction}\n\\begin{document}\n\\maketitle\n\\input{results}\n\\end{document}\n");
  writeFileSync(join(dir, "results.tex"), [
    "\\section{Results}",
    "Compared to the baseline, our method reduces the mean error by about 5\\% (12.5 vs. 13.1 units per run). A formal sensitivity analysis was not performed.",
    "\\begin{table}\\centering",
    "\\begin{tabular}{lr}\\hline Method & Mean error \\\\ \\hline Baseline & 13.1 \\\\ Ours & 12.5 \\\\ \\hline\\end{tabular}",
    "\\caption{Mean error per run.}\\label{tab:err}",
    "\\end{table}",
    "",
  ].join("\n"));
}

/** What the co-author fixture contains, so a case can check the agent reported exactly this and nothing else. */
export const COAUTHOR_CHANGES = {
  numberDeleted: "12.5", numberInserted: "12.9", sentenceInserted: "Our method significantly outperforms all baselines.",
  sentenceDeleted: " A formal sensitivity analysis was not performed.", comment: "Please add the standard deviation over seeds.", commentOn: "the mean error",
};
/** A small .docx a co-author "returned": one changed number, an unsupported claim added, a hedge deleted, a heading reformatted, one comment. */
export function writeCoauthorDocx(file: string): void {
  const c = COAUTHOR_CHANGES;
  const meta = (id: number, who: string, day: string): string => `w:id="${id}" w:author="${who}" w:date="${day}T09:00:00Z"`;
  const body =
    `<w:p><w:pPr><w:pPrChange ${meta(9, "Ana", "2026-10-09")}><w:pPr/></w:pPrChange></w:pPr><w:r><w:t>Results</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t xml:space="preserve">Compared to the baseline, our method reduces </w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>${c.commentOn}</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>` +
    `<w:r><w:t xml:space="preserve"> by about 5% (</w:t></w:r><w:del ${meta(1, "Dr Co", "2026-10-08")}><w:r><w:delText>${c.numberDeleted}</w:delText></w:r></w:del><w:ins ${meta(2, "Dr Co", "2026-10-08")}><w:r><w:t>${c.numberInserted}</w:t></w:r></w:ins>` +
    `<w:r><w:t xml:space="preserve"> vs. 13.1 units per run).</w:t></w:r><w:ins ${meta(3, "Ana", "2026-10-09")}><w:r><w:t xml:space="preserve"> ${c.sentenceInserted}</w:t></w:r></w:ins>` +
    `<w:del ${meta(4, "Ana", "2026-10-09")}><w:r><w:delText xml:space="preserve">${c.sentenceDeleted}</w:delText></w:r></w:del></w:p>`;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/_rels/document.xml.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>'),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document ${WNS}><w:body>${body}</w:body></w:document>`),
    "word/comments.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:comments ${WNS}><w:comment ${meta(0, "Dr Co", "2026-10-08")}><w:p><w:r><w:t>${c.comment}</w:t></w:r></w:p></w:comment></w:comments>`),
  };
  writeFileSync(file, zipSync(files));
}

/** Text of a .docx as Word shows it (no tracked-change markup), plus structure counts. */
export function docxFacts(file: string): { text: string; headings: number; images: number; equations: number; tables: number } {
  const z = unzipSync(new Uint8Array(readFileSync(file)));
  const xml = strFromU8(z["word/document.xml"] ?? new Uint8Array());
  const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(" ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return {
    text,
    headings: (xml.match(/<w:pStyle w:val="Heading\d"/g) ?? []).length,
    images: Object.keys(z).filter((k) => /^word\/media\//.test(k)).length,
    equations: (xml.match(/<m:oMath>/g) ?? []).length,
    tables: (xml.match(/<w:tbl>/g) ?? []).length,
  };
}

/** Files an answer says it made (paths with a folder and a known extension) that are not on disk, as a project path or as a LaTeX path relative to manuscript/: a claim about the work must be true. */
export function missingClaimedFiles(answer: string, project: string): string[] {
  const claimed = [...new Set([...answer.matchAll(/(?<![\w./-])((?:[\w-]+\/)+[\w.-]+\.(?:pdf|tex|png|docx|md|py|json|csv))(?![\w])/g)].map((m) => m[1]!))];
  return claimed.filter((p) => !p.startsWith("..") && !/^(?:\/|~)/.test(p) && !/[<>*]|\bname\b/.test(p) && !existsSync(join(project, p)) && !existsSync(join(project, "manuscript", p)));
}

/** Every case starts from an empty manuscript: the cases of one run share a project directory, and one case's output must not decide another's verdict. */
export function freshProject(project: string): void {
  for (const d of ["manuscript", "data", "reviews", "grants", "build", "papers"]) rmSync(join(project, d), { recursive: true, force: true });
  mkdirSync(join(project, "manuscript"), { recursive: true });
}

/** Keep what a case produced (its `artifacts`, project-relative) in the run's own folder before the next case resets the project. */
/** Where the agent's own outputs land: a failed case has no detail listing them, but its files are what a human needs to see why it failed. */
const OUTPUT_DIRS = ["manuscript/figures", "manuscript/slides", "manuscript/docx", "grants", "reviews"];
const MAX_SAVED_FILE_BYTES = 1_500_000;
export function saveProjectOutputs(project: string, dest: string): string[] {
  const saved: string[] = [];
  for (const rel of OUTPUT_DIRS) {
    const dir = join(project, rel);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (!statSync(file).isFile() || statSync(file).size > MAX_SAVED_FILE_BYTES) continue;
      mkdirSync(dest, { recursive: true });
      cpSync(file, join(dest, name));
      saved.push(name);
    }
  }
  return saved;
}
export function saveArtifacts(project: string, dest: string, detail: unknown): void {
  const rels = (detail as { artifacts?: string[] } | undefined)?.artifacts ?? [];
  mkdirSync(dest, { recursive: true });
  const root = resolve(project);
  for (const rel of rels) {
    const abs = resolve(root, rel);
    if (abs.startsWith(`${root}/`) && existsSync(abs) && statSync(abs).isFile()) cpSync(abs, join(dest, basename(abs)));
  }
}

/** The text of a markdown page from the heading that matches `heading` to the next heading of the same or a higher level (or the end). */
export function sectionText(page: string, heading: RegExp): string {
  const lines = page.split("\n");
  const lead = (l: string) => /^\*\*[^*]+\*\*/.test(l);
  const start = lines.findIndex((l) => (/^#{1,6}\s/.test(l) || lead(l)) && heading.test(/^\*\*([^*]+)\*\*/.exec(l)?.[1] ?? l));
  if (start < 0) return "";
  if (lead(lines[start]!)) {
    // a bold lead-in paragraph ("**Preliminary Results:** ..."): its own text up to the next heading or bold lead-in
    const next = lines.findIndex((l, i) => i > start && (/^#{1,6}\s/.test(l) || lead(l)));
    return lines.slice(start, next < 0 ? undefined : next).join("\n");
  }
  const level = /^(#+)/.exec(lines[start]!)![1]!.length;
  const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l) && /^(#+)/.exec(l)![1]!.length <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/** A money amount in prose (the user gave none), after removing LaTeX mathematics whose opening dollar sign looks like a currency sign. */
export function fundingAmount(page: string): string | undefined {
  const prose = page.replace(/\\\$/g, " ").replace(/\$[^$\n]*\$/g, " ");
  return /\$\s?\d[\d.,]*|\u20ac\s?\d[\d.,]*|\b\d[\d,]*\s?(?:USD|EUR|CAD)\b/.exec(prose)?.[0];
}

const BARE_READ = (t: Turn, fragment: string): number => t.calls.findIndex((c) => c.name === "read" && JSON.stringify(c.args ?? {}).includes(fragment));
const bashOut = (t: Turn): string => t.ends.filter((e) => e.name === "bash").map((e) => e.text).join("\n");
const figuresDir = (project: string): string => join(project, "manuscript/figures");
const listFigures = (project: string, ext: string): string[] => (existsSync(figuresDir(project)) ? readdirSync(figuresDir(project)).filter((f) => f.endsWith(ext)) : []);

export const skillCases: AgentCase[] = [
  {
    id: "skill.figures.plot-user-data",
    tool: "uktub-figures",
    contract: "asked for a paper figure from the user's CSV, the agent loads the figures skill, builds the figure from the file (every plotted value equals the data), saves a vector PDF with its script beside it, looks at the rendered image, and reports where the figure is and what it shows",
    async run(ctx, agent) {
      freshProject(ctx.project);
      const { means, sizes } = writeFigureFixtures(ctx.project);
      const t = await agent.turn("figure", "My results are in data/accuracy.csv: accuracy of two methods against training-set size, three seeds each. Make a figure for my paper from it showing how the two methods scale, save it where my LaTeX manuscript can include it, and tell me what you made.");
      const skillAt = BARE_READ(t, "uktub-figures/SKILL.md");
      assert.ok(skillAt >= 0, `the figures skill was not loaded (reads: ${t.calls.filter((c) => c.name === "read").map((c) => JSON.stringify(c.args)).join(" | ").slice(0, 300)})`);
      const pdfs = listFigures(ctx.project, ".pdf");
      assert.ok(pdfs.length >= 1, `no PDF figure under manuscript/figures (tools: ${t.calls.map((c) => c.name).join(",")})`);
      const base = pdfs[0]!.replace(/\.pdf$/, "");
      const pdf = readFileSync(join(figuresDir(ctx.project), `${base}.pdf`), "latin1");
      assert.ok(/\/FontFile/.test(pdf), "the PDF carries no embedded font");
      assert.ok(!/\/Subtype\s*\/Image/.test(pdf), "the plot was rasterized inside the PDF");
      const scripts = listFigures(ctx.project, ".py").filter((f) => f !== "figstyle.py");
      assert.ok(scripts.length >= 1, "no plotting script was kept beside the figure");
      const script = readFileSync(join(figuresDir(ctx.project), scripts[0]!), "utf8");
      assert.match(script, /accuracy\.csv/, "the script does not read the user's data file");
      assert.match(bashOut(t), /audit: clean/, "the figure audit did not report clean in any tool result");
      const sidecar = join(figuresDir(ctx.project), `${base}.plotdata.json`);
      assert.ok(existsSync(sidecar), "no plot-data record was written, so the plotted values cannot be checked");
      const plotted = (JSON.parse(readFileSync(sidecar, "utf8")).series as Array<{ y: number[] }>).map((s) => s.y);
      for (const [method, want] of Object.entries(means)) {
        assert.ok(plotted.some((y) => y.length === sizes.length && y.every((v, i) => Math.abs(v - want[i]!) < 1e-6)), `the plotted values do not contain the ${method} means from the CSV`);
      }
      const png = t.calls.findIndex((c, i) => i > skillAt && c.name === "read" && /\.png/.test(JSON.stringify(c.args ?? {})));
      assert.ok(png >= 0, "the agent never looked at the rendered image");
      assert.match(t.final, /manuscript\/figures\//, "the answer does not say where the figure is");
      assert.deepEqual(missingClaimedFiles(t.final, ctx.project), [], "the answer names files that do not exist");
      assert.match(t.final, /three seeds|3 seeds|seeds/i, "the answer does not state the seed count / uncertainty");
      assert.equal(overclaimsAcrossSizes(t.final), undefined, `the answer claims what the data do not show: "${overclaimsAcrossSizes(t.final)}"`);
      const files = readdirSync(figuresDir(ctx.project)).filter((f) => !f.startsWith("__"));
      return { turn: "figure", artifacts: ["data/accuracy.csv", ...files.map((f) => `manuscript/figures/${f}`)], plottedSeries: plotted.length };
    },
  },
  {
    id: "skill.figures.no-data-no-invention",
    tool: "uktub-figures",
    contract: "asked for a figure of results the user supplied no data for, the agent loads the figures skill and does not plot numbers from memory: no figure is written, and the answer asks for the data file or the paper it comes from",
    async run(ctx, agent) {
      freshProject(ctx.project);
      const t = await agent.turn("figure-no-data", "Make a bar chart for my paper comparing the ImageNet top-1 accuracy of ResNet-50 and ViT-B/16.");
      assert.ok(BARE_READ(t, "uktub-figures/SKILL.md") >= 0, "the figures skill was not loaded");
      const made = [...listFigures(ctx.project, ".pdf"), ...listFigures(ctx.project, ".png")];
      assert.equal(made.length, 0, `a figure was drawn without data: ${made.join(", ")}`);
      assert.match(t.final, /\b(data|csv|file|results|numbers|source|paper)\b/i);
      assert.match(t.final, /\b(provide|share|send|point me|give me|supply|upload|which|where)\b/i, "the answer does not ask the user for the data");
      return { turn: "figure-no-data", artifacts: [] };
    },
  },
  {
    id: "skill.review.own-paper",
    tool: "uktub-review",
    contract: "asked to review a real manuscript the way a referee would, the agent loads the review skill, runs the deterministic review (a report with file:line evidence appears under reviews/), leaves the manuscript byte-for-byte unchanged, answers with major and minor concerns whose file:line pointers exist, and gives no accept or reject verdict",
    async run(ctx, agent) {
      freshProject(ctx.project);
      const paper = loadTestPaper();
      writeOwnPaper(ctx.project, paper);
      const manuscript = join(ctx.project, "manuscript");
      const before = treeDigest(manuscript);
      const t = await agent.turn("review", `I am about to submit the paper in manuscript/${paper.entry}. Review it the way a careful referee would and tell me where it is weakest. Do not change any of my files.`);
      assert.ok(BARE_READ(t, "uktub-review/SKILL.md") >= 0, "the review skill was not loaded");
      const ran = t.calls.find((c) => c.name === "bash" && /uktub-scholar(?:\.js)?\s+review/.test(String(c.args?.command)));
      assert.ok(ran, "the deterministic review was not run (no `uktub-scholar review` command)");
      const reports = existsSync(join(ctx.project, "reviews")) ? readdirSync(join(ctx.project, "reviews")).filter((f) => /-slop(?:-\d+)?\.md$/.test(f)) : [];
      assert.equal(reports.length >= 1, true, "no report under reviews/");
      const report = readFileSync(join(ctx.project, "reviews", reports[0]!), "utf8");
      assert.match(report, /Cross-section references/);
      assert.match(report, /manuscript\/[A-Za-z_]+\.tex:\d+/, "the report has no file:line evidence");
      assert.equal(treeDigest(manuscript), before, "the manuscript was changed during a read-only review");
      assert.match(t.final, /major/i);
      assert.match(t.final, /minor/i);
      assert.doesNotMatch(t.final, /recommend(?:ation)?[^.\n]{0,40}\b(?:accept|reject|revision)/i, "an accept/reject recommendation");
      assert.doesNotMatch(t.final, /\b(?:verdict|decision)\s*:/i);
      assert.match(t.final, /cross-section|macro redundancy|citation isolation|evidence gap/i, "the deterministic diagnostics are not in the answer");
      const { valid, invalid } = pointerCheck(t.final, manuscript);
      assert.ok(valid.length >= 5, `fewer than 5 valid file:line pointers in the answer (${valid.length}); invalid: ${invalid.join(", ")}`);
      assert.ok(invalid.length <= Math.ceil(valid.length * 0.15), `pointers to lines or files that do not exist: ${invalid.join(", ")}`);
      const quotes = unfoundQuotes(t.final, manuscript);
      assert.ok(quotes.total >= 3, `the review quotes the paper fewer than 3 times (${quotes.total})`);
      assert.ok(quotes.missing.length <= Math.ceil(quotes.total * 0.2), `quoted words that are not in the manuscript: ${quotes.missing.map((q) => q.slice(0, 80)).join(" | ")}`);
      return { turn: "review", artifacts: [`reviews/${reports[0]}`], validPointers: valid.length, invalidPointers: invalid, quotes: quotes.total, unfoundQuotes: quotes.missing.length };
    },
  },
  {
    id: "skill.diagrams.smart-home",
    tool: "uktub-diagrams",
    contract: "asked for a system diagram of a smart home, the agent loads the diagrams skill, draws it as TikZ, compiles it to a one-page vector PDF that fits a two-column page, looks at the rendered image, includes every part the user named plus a legend that separates energy from information flows, adds no acronym (algorithm, standard or capability) the user did not give, draws nothing clipped, and says what it assumed",
    async run(ctx, agent) {
      freshProject(ctx.project);
      mkdirSync(join(ctx.project, "manuscript"), { recursive: true });
      const request = "For my paper on home energy management I need the system diagram of a smart home. A central HEMS controller (a reinforcement-learning agent) manages the grid connection through a smart meter, a rooftop PV array, a home battery (ESS), an electric vehicle with its charger, an electric water heater, an HVAC unit, the fixed loads (refrigerator, lighting, vacuum cleaner) and the deferrable loads (washing machine, dryer, dishwasher). Show energy flows and information flows differently. It has to be a vector figure for a two-column journal paper. Tell me what you drew.";
      const t = await agent.turn("diagram", request);
      assert.ok(BARE_READ(t, "uktub-diagrams/SKILL.md") >= 0, "the diagrams skill was not loaded");
      const texFiles = listFigures(ctx.project, ".tex");
      assert.ok(texFiles.length >= 1, `no TikZ source under manuscript/figures (tools: ${t.calls.map((c) => c.name).join(",")})`);
      const name = texFiles[0]!.replace(/\.tex$/, "");
      const source = readFileSync(join(figuresDir(ctx.project), texFiles[0]!), "utf8");
      assert.match(source, /tikzpicture/);
      assert.match(source, /dashed|dotted/, "energy and information flows are not told apart by line style");
      const pdfPath = [join(figuresDir(ctx.project), `${name}.pdf`), join(ctx.project, "build", `${name}.pdf`)].find((p) => existsSync(p));
      assert.ok(pdfPath, "the diagram was not compiled to a PDF");
      const preview = join(figuresDir(ctx.project), `${name}.host-render.png`);
      const pdf = inspectPdf(pdfPath, preview);
      assert.equal(pdf.pages, 1, "a diagram is one page");
      assert.ok(pdf.widthPt > 0 && pdf.widthPt <= 6.8 * 72, `the diagram is ${(pdf.widthPt / 72).toFixed(2)} in wide, wider than a two-column page (6.75 in)`);
      assert.ok(!/\/Subtype\s*\/Image/.test(readFileSync(pdfPath, "latin1")), "the diagram contains a raster image");
      const needed: Array<[string, RegExp]> = [["HEMS", /HEMS/i], ["grid", /grid/i], ["smart meter", /smart\s*meter/i], ["PV", /\bPV\b|photovoltaic|solar/i], ["ESS", /\bESS\b|batter/i], ["EV", /\bEV\b|electric vehicle/i], ["water heater", /water\s*heater/i], ["HVAC", /HVAC/i], ["refrigerator", /refrigerator|fridge/i], ["lighting", /lighting|lights?\b/i], ["vacuum", /vacuum/i], ["washing machine", /washing\s*machine|washer/i], ["dryer", /dryer/i], ["dishwasher", /dish\s*washer/i]];
      const missing = needed.filter(([, re]) => !re.test(pdf.text)).map(([n]) => n);
      assert.ok(missing.length === 0, `parts missing from the diagram text: ${missing.join(", ")}`);
      const invented = acronymsNotInRequest(pdf.text, request);
      assert.deepEqual(invented, [], `the figure names things the user did not mention: ${invented.join(", ")}`);
      assert.match(pdf.text, /energy/i, "no legend entry for energy");
      assert.match(pdf.text, /information|signal|data|control/i, "no legend entry for information");
      if (pdf.touchesEdge !== undefined) assert.equal(pdf.touchesEdge, false, "the drawing touches the page edge: it is clipped");
      assert.ok(t.calls.some((c, i) => i > BARE_READ(t, "uktub-diagrams/SKILL.md") && c.name === "read" && /\.png/.test(JSON.stringify(c.args ?? {}))), "the agent never looked at the rendered image");
      assert.match(t.final, /includegraphics/);
      assert.deepEqual(missingClaimedFiles(t.final, ctx.project), [], "the answer names files that do not exist");
      return { turn: "diagram", artifacts: [`manuscript/figures/${texFiles[0]}`, pdfPath.replace(ctx.project + "/", ""), `manuscript/figures/${name}.host-render.png`], pages: pdf.pages, widthIn: Number((pdf.widthPt / 72).toFixed(2)) };
    },
  },
  {
    id: "skill.slides.own-paper",
    tool: "uktub-slides",
    contract: "asked for a ten-minute talk from a real paper, the agent loads the slides skill, writes Beamer slides that compile to a 16:9 deck of a sensible length, titles content slides with sentences, reuses the paper's own figure files, shows no decimal number the paper does not state, looks at rendered slides, and lists the slide titles",
    async run(ctx, agent) {
      freshProject(ctx.project);
      const paper = loadTestPaper();
      writeOwnPaper(ctx.project, paper);
      const manuscript = join(ctx.project, "manuscript");
      const t = await agent.turn("slides", `Make a 10-minute conference talk from my paper in manuscript/${paper.entry}. Use my own figures and the numbers from the paper, and save it as slides in the project so I can compile it.`);
      const skillAt = BARE_READ(t, "uktub-slides/SKILL.md");
      assert.ok(skillAt >= 0, "the slides skill was not loaded");
      const slidesDir = join(manuscript, "slides");
      const texFiles = existsSync(slidesDir) ? readdirSync(slidesDir).filter((f) => f.endsWith(".tex")) : [];
      assert.ok(texFiles.length >= 1, `no slides source under manuscript/slides (tools: ${t.calls.map((c) => c.name).join(",")})`);
      const entry = texFiles.find((f) => /\\documentclass(?:\[[^\]]*\])?\{beamer\}/.test(readFileSync(join(slidesDir, f), "utf8"))) ?? texFiles[0]!;
      const name = entry.replace(/\.tex$/, "");
      const source = readFileSync(join(slidesDir, entry), "utf8");
      assert.match(source, /\\documentclass(?:\[[^\]]*\])?\{beamer\}/);
      const pdfPath = [join(slidesDir, `${name}.pdf`), join(ctx.project, "build", `${name}.pdf`)].find((p) => existsSync(p));
      assert.ok(pdfPath, "the slides were not compiled to a PDF");
      const info = spawnSync("pdfinfo", [pdfPath], { encoding: "utf8" }).stdout;
      const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? 0);
      const [w, h] = (/Page size:\s+([\d.]+) x ([\d.]+)/.exec(info) ?? []).slice(1).map(Number);
      assert.ok(pages >= 7 && pages <= 16, `${pages} slides for a ten-minute talk`);
      assert.ok(w && h && Math.abs(w / h - 16 / 9) < 0.05, `the deck is not 16:9 (${w} x ${h})`);
      const deckText = spawnSync("pdftotext", [pdfPath, "-"], { encoding: "utf8" }).stdout;
      assert.match(deckText, paper.title, "the title slide does not carry the paper's title");
      const titles = [...source.matchAll(/\\begin\{frame\}(?:\[[^\]]*\])?\{([^}]*)\}|\\frametitle\{([^}]*)\}/g)].map((m) => (m[1] ?? m[2] ?? "").trim()).filter((x) => x !== "" && !/^references$/i.test(x));
      assert.ok(titles.length >= 6, `only ${titles.length} titled content slides`);
      const sentences = titles.filter((x) => x.split(/\s+/).length >= 4).length;
      assert.ok(sentences / titles.length >= 0.7, `content slides are titled by topic, not takeaway: ${titles.join(" | ")}`);
      const figures = [...source.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)].map((m) => m[1]!);
      const real = figures.filter((f) => [f, `${f}.png`, `${f}.pdf`].some((c) => existsSync(join(slidesDir, c))));
      assert.ok(real.length >= 3, `fewer than 3 of the paper's figure files reused (${real.length} of ${figures.length} includes exist)`);
      const numbers = numbersNotInPaper(deckText, manuscript);
      assert.ok(numbers.total >= 5, `the deck states fewer than 5 decimal numbers (${numbers.total})`);
      assert.ok(numbers.missing.length <= Math.floor(numbers.total * 0.1), `numbers on the slides that the paper does not state: ${numbers.missing.join(", ")}`);
      const looked = t.calls.filter((c, i) => i > skillAt && c.name === "read" && /\.png/.test(JSON.stringify(c.args ?? {}))).length;
      assert.ok(looked >= 2, `the agent looked at ${looked} rendered slides, expected at least 2`);
      return { turn: "slides", artifacts: [`manuscript/slides/${entry}`, pdfPath.replace(ctx.project + "/", "")], slides: pages, titledSlides: titles.length, figuresReused: real.length, numbersChecked: numbers.total, numbersNotInPaper: numbers.missing };
    },
  },
  {
    id: "skill.slides.pptx-from-paper",
    tool: "uktub-slides",
    contract: "asked for a PowerPoint version of a ten-minute talk from a real paper, the agent loads the slides skill, builds a .pptx, reads it back, and the deck has a sensible number of slides each with a title (content slides titled by sentence), the paper's own figures as pictures, speaker notes on several slides and no decimal number the paper does not state, and the answer says what the format cannot do",
    async run(ctx, agent) {
      freshProject(ctx.project);
      const paper = loadTestPaper();
      writeOwnPaper(ctx.project, paper);
      const manuscript = join(ctx.project, "manuscript");
      const before = treeDigestExcept(manuscript, "slides");
      const t = await agent.turn("pptx", `Make a PowerPoint (.pptx) version of a 10-minute conference talk from my paper in manuscript/${paper.entry}, using my own figures and numbers, so I can send it to my co-authors. Save it in the project.`);
      const skillAt = BARE_READ(t, "uktub-slides/SKILL.md");
      assert.ok(skillAt >= 0, "the slides skill was not loaded");
      const slidesDir = join(manuscript, "slides");
      const decks = existsSync(slidesDir) ? readdirSync(slidesDir).filter((f) => f.endsWith(".pptx")) : [];
      assert.ok(decks.length >= 1, `no .pptx under manuscript/slides (tools: ${t.calls.map((c) => c.name).join(",")})`);
      const deck = join(slidesDir, decks[0]!);
      const facts = pptxFacts(deck);
      assert.ok(facts.slides >= 7 && facts.slides <= 16, `${facts.slides} slides for a ten-minute talk`);
      assert.equal(facts.untitled, 0, `${facts.untitled} slides have no title`);
      const content = facts.titles.slice(1).filter((x) => !/^references$/i.test(x));
      const sentences = content.filter((x) => x.split(/\s+/).length >= 4).length;
      assert.ok(content.length >= 5 && sentences / content.length >= 0.7, `content slides are titled by topic, not takeaway: ${content.join(" | ")}`);
      assert.ok(facts.pictures >= 3, `${facts.pictures} pictures; the paper's own figures were not reused`);
      assert.ok(facts.slidesWithNotes >= 3, `speaker notes on ${facts.slidesWithNotes} slides, expected at least 3`);
      assert.doesNotMatch(facts.text, /\\cite|\[\?\]|\?\?/, "unresolved citations in the deck text");
      const numbers = numbersNotInPaper(facts.text, manuscript);
      assert.ok(numbers.total >= 5, `the deck states fewer than 5 decimal numbers (${numbers.total})`);
      assert.ok(numbers.missing.length <= Math.floor(numbers.total * 0.1), `numbers on the slides that the paper does not state: ${numbers.missing.join(", ")}`);
      assert.ok(t.calls.some((c, i) => i > skillAt && c.name === "bash" && /pptx_outline\.py|zipfile|unzip/.test(String(c.args?.command)) && /\.pptx/.test(String(c.args?.command))), "the agent never read the .pptx back to check it");
      assert.match(t.final, /animation|default|plain|cannot|can't|does not|did not|limitation/i, "the answer does not say what the format cannot do");
      assert.deepEqual(missingClaimedFiles(t.final, ctx.project), [], "the answer names files that do not exist");
      assert.equal(treeDigestExcept(manuscript, "slides"), before, "the user's files were changed");
      return { turn: "pptx", artifacts: [`manuscript/slides/${decks[0]}`], slides: facts.slides, pictures: facts.pictures, slidesWithNotes: facts.slidesWithNotes, equations: facts.equations, tables: facts.tables, numbersChecked: numbers.total, numbersNotInPaper: numbers.missing };
    },
  },
  {
    id: "skill.office.latex-to-docx",
    tool: "uktub-office",
    contract: "asked for a Word version of a real LaTeX paper, the agent loads the office skill, exports with pandoc into manuscript/docx/ without touching the user's files, and the .docx has the paper's sections, figures, tables, equations as Word equations and a resolved bibliography, with no raw \\cite or [?]",
    async run(ctx, agent) {
      freshProject(ctx.project);
      const paper = loadTestPaper();
      writeOwnPaper(ctx.project, paper);
      const manuscript = join(ctx.project, "manuscript");
      const before = treeDigestExcept(manuscript, "docx");
      const t = await agent.turn("docx", `My co-authors work in Word. Make a .docx of my paper in manuscript/${paper.entry} with the figures, tables, equations and the references, and tell me what did not survive the conversion. Do not change my files.`);
      const skillAt = BARE_READ(t, "uktub-office/SKILL.md");
      assert.ok(skillAt >= 0, "the office skill was not loaded");
      const out = join(manuscript, "docx");
      const docs = existsSync(out) ? readdirSync(out).filter((f) => f.endsWith(".docx")) : [];
      assert.ok(docs.length >= 1, `no .docx under manuscript/docx (tools: ${t.calls.map((c) => c.name).join(",")})`);
      const f = docxFacts(join(out, docs[0]!));
      assert.ok(f.headings >= paper.docx.headings, `only ${f.headings} headings`);
      assert.ok(f.images >= paper.docx.images, `only ${f.images} figures embedded`);
      assert.ok(f.equations >= paper.docx.equations, `only ${f.equations} Word equations`);
      assert.ok(f.tables >= paper.docx.tables, `only ${f.tables} tables`);
      assert.doesNotMatch(f.text, /\\cite|\[\?\]|\?\?/, "unresolved citations in the document text");
      assert.match(f.text, paper.docx.mustContain);
      const bibTitles = [...readFileSync(join(manuscript, "ref.bib"), "utf8").matchAll(/title\s*=\s*[{"]+([^}"]{25,})/g)].map((m) => m[1]!.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 25));
      const text = f.text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
      const listed = bibTitles.filter((x) => text.includes(x)).length;
      assert.ok(listed >= paper.docx.bibliography, `only ${listed} bibliography entries appear in the document`);
      assert.equal(treeDigestExcept(manuscript, "docx"), before, "the user's files were changed");
      assert.deepEqual(missingClaimedFiles(t.final, ctx.project), [], "the answer names files that do not exist");
      assert.ok(t.calls.some((c, i) => i > skillAt && c.name === "bash" && /pandoc|unzip/.test(String(c.args?.command)) && /\.docx/.test(String(c.args?.command)) && /-t\s+(?:plain|markdown)|unzip/.test(String(c.args?.command))), "the agent never read the .docx back to check it");
      assert.match(t.final, /did not survive|lost|not preserved|differ|limitation|does not|did not/i, "the answer does not say what was lost");
      return { turn: "docx", artifacts: [`manuscript/docx/${docs[0]}`], headings: f.headings, images: f.images, equations: f.equations, tables: f.tables, bibliographyEntriesFound: listed };
    },
  },
  {
    id: "skill.office.tracked-changes",
    tool: "uktub-office",
    contract: "given a .docx a co-author returned with tracked changes and a comment, the agent loads the office skill, lists every change and the comment exactly (author, text), flags that the changed number disagrees with the paper, reports nothing that is not there, and leaves the user's files untouched",
    async run(ctx, agent) {
      freshProject(ctx.project);
      writeMiniPaper(ctx.project);
      const manuscript = join(ctx.project, "manuscript");
      writeCoauthorDocx(join(manuscript, "coauthor.docx"));
      const before = treeDigest(manuscript);
      const t = await agent.turn("coauthor", "My co-author sent back manuscript/coauthor.docx with tracked changes and a comment on the results paragraph. Tell me what they changed and what I need to decide. Do not change any of my files.");
      const skillAt = BARE_READ(t, "uktub-office/SKILL.md");
      assert.ok(skillAt >= 0, "the office skill was not loaded");
      assert.ok(t.calls.some((c) => c.name === "bash" && /docx_changes\.py/.test(String(c.args?.command))), "the agent did not list the changes with the skill's script");
      const c = COAUTHOR_CHANGES;
      for (const must of [c.numberDeleted, c.numberInserted, c.sentenceInserted.replace(/\.$/, ""), c.comment.replace(/\.$/, "")]) assert.ok(t.final.includes(must), `the answer does not report "${must}"`);
      assert.match(t.final, /sensitivity analysis/i, "the deleted sentence is not reported");
      assert.match(t.final, /Dr Co/);
      assert.match(t.final, /Ana/);
      assert.match(t.final, /(?:conflict|disagree|differ|mismatch|inconsisten|does not match|doesn't match|not match)/i, "the changed number is not flagged against the paper");
      assert.match(t.final, /results\.tex/, "the paper's own sentence is not located in the source");
      assert.equal(treeDigest(manuscript), before, "the user's files were changed");
      return { turn: "coauthor", artifacts: ["manuscript/coauthor.docx"] };
    },
  },
  {
    id: "skill.grants.specific-aims",
    tool: "uktub-grants",
    contract: "asked for a follow-up grant outline from a real paper, the agent loads the grants skill and writes a one-page Specific Aims file whose aims answer limitations the paper itself states, with every number taken from the paper and every printed Table or Section number it cites holding that number in the published paper, bracketed placeholders for what only the user knows (funder, budget), no invented citation, and a clear list of what it still needs",
    async run(ctx, agent) {
      freshProject(ctx.project);
      const paper = loadTestPaper();
      writeOwnPaper(ctx.project, paper);
      const manuscript = join(ctx.project, "manuscript");
      const t = await agent.turn("grant", `I want funding to continue the work in my paper manuscript/${paper.entry}. Draft the Specific Aims page for a follow-up project from what the paper says about its own limitations and future work. I have not picked a funder yet.`);
      assert.ok(BARE_READ(t, "uktub-grants/SKILL.md") >= 0, "the grants skill was not loaded");
      const file = [join(ctx.project, "grants/specific-aims.md"), ...(existsSync(join(ctx.project, "grants")) ? readdirSync(join(ctx.project, "grants")).map((f) => join(ctx.project, "grants", f)) : [])].find((p) => existsSync(p) && statSync(p).isFile());
      assert.ok(file, "no Specific Aims file under grants/");
      const page = readFileSync(file, "utf8");
      const words = (page.match(/[A-Za-z0-9][A-Za-z0-9'.%-]*/g) ?? []).length;
      assert.ok(words >= 300 && words <= 800, `${words} words; a Specific Aims page is about one page`);
      const aims = [...page.matchAll(/\bAim\s*([1-9])\b/gi)].map((m) => m[1]!);
      const distinct = new Set(aims);
      assert.ok(distinct.size >= 2 && distinct.size <= 4, `${distinct.size} aims`);
      assert.match(page, /hypothes|research question|we will test|objective/i);
      assert.match(page, /expected|outcome|success|deliverable/i);
      const prelim = sectionText(page, /preliminary/i);
      assert.ok(prelim.length > 0, "no preliminary-results section");
      const numbers = numbersNotInPaper(prelim, manuscript);
      assert.ok(numbers.total >= 2, `the preliminary results cite fewer than 2 decimal numbers from the paper (${numbers.total})`);
      assert.ok(numbers.missing.length === 0, `preliminary results state numbers the paper does not: ${numbers.missing.join(", ")}`);
      const published = spawnSync("pdftotext", [join(paper.dir, paper.pdf), "-"], { encoding: "utf8" }).stdout;
      assert.ok(published.length > 1000, "the published PDF of the paper is missing: printed Table and Section numbers cannot be checked");
      assert.deepEqual(misplacedPrintedRefs(page, published), [], "the page cites printed tables or sections that do not hold its numbers");
      assert.match(page, /\[[^\]]*(?:funder|budget|collaborat|programme|program|call|duration)[^\]]*\]/i, "no bracketed placeholder for what only the user knows");
      assert.equal(fundingAmount(page), undefined, "a funding amount the user never gave");
      const stated = paper.limitations.filter((re) => re.test(page)).length;
      assert.ok(stated >= 2, `the aims echo ${stated} of the paper's stated limitations, expected at least 2`);
      const keys = new Set([...readFileSync(join(manuscript, "ref.bib"), "utf8").matchAll(/@\w+\{([^,\s]+),/g)].map((m) => m[1]!));
      const cited = [...page.matchAll(/\\cite\w*\{([^}]+)\}|\[@([^\]]+)\]/g)].flatMap((m) => (m[1] ?? m[2] ?? "").split(/[,;]\s*@?/).map((k) => k.trim().replace(/^@/, "")));
      assert.ok(cited.every((k) => keys.has(k)), `citation keys not in the bibliography: ${cited.filter((k) => !keys.has(k)).join(", ")}`);
      assert.match(t.final, /funder|programme|program|call/i, "the answer does not ask for the funder or call text");
      assert.deepEqual(missingClaimedFiles(t.final, ctx.project), [], "the answer names files that do not exist");
      return { turn: "grant", artifacts: [file.replace(ctx.project + "/", "")], words, aims: distinct.size, numbersChecked: numbers.total, limitationsEchoed: stated };
    },
  },
];

/**
 * Acronyms in a figure's text that the user's request neither contains nor abbreviates (the agent added them on its own); AC and DC
 * describe the drawing itself. "EV" is allowed when the request says "electric vehicle".
 */
export function acronymsNotInRequest(figureText: string, request: string): string[] {
  const acronym = /\b(?=[A-Z0-9]*[A-Z][A-Z0-9]*[A-Z])[A-Z][A-Z0-9]+\b/g;
  const asked = new Set(request.match(acronym) ?? []);
  const words = request.split(/[^A-Za-z]+/).filter((w) => w !== "");
  for (let i = 0; i < words.length; i++) {
    for (let n = 2; n <= 4 && i + n <= words.length; n++) asked.add(words.slice(i, i + n).map((w) => w[0]!.toUpperCase()).join(""));
  }
  return [...new Set(figureText.match(acronym) ?? [])].filter((a) => !asked.has(a) && a !== "AC" && a !== "DC").sort();
}

/**
 * Printed "Table N" / "Section N.M" mentions whose sentence numbers do not appear where the published paper puts that table or section
 * (`pdftotext` of the PDF): an agent reading only the .tex cannot see printed numbers and guessed "Table 6" for the results table (it is
 * Table 9). A table is its caption's neighbourhood (45 lines either side), a section its heading, its subsections' headings and the lines
 * up to the next heading of each. Sentences without a decimal number are not checked.
 */
export function misplacedPrintedRefs(page: string, paperText: string): string[] {
  const lines = paperText.split("\n");
  const heading = /^\d+(?:\.\d+)*\.\s+[A-Z]/;
  const values = (text: string) => new Set((text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
  const tableText = (n: string): string | undefined => {
    const hits = lines.flatMap((l, i) => (new RegExp(`^Table ${n}[:.]`).test(l) ? [i] : []));
    return hits.length === 0 ? undefined : hits.map((i) => lines.slice(Math.max(0, i - 45), i + 46).join("\n")).join("\n");
  };
  const sectionText = (n: string): string | undefined => {
    const own = lines.flatMap((l, i) => (heading.test(l) && (l.startsWith(`${n}. `) || l.startsWith(`${n}.`)) ? [i] : []));
    if (own.length === 0) return undefined;
    return own.map((i) => { const next = lines.findIndex((l, j) => j > i && heading.test(l)); return lines.slice(i, next < 0 ? undefined : next).join("\n"); }).join("\n");
  };
  const mention = /\b(Tables?|Sections?)\s+(\d+(?:\.\d+)*(?:\s*(?:,|and|&)\s*\d+(?:\.\d+)*)*)/gi;
  const problems: string[] = [];
  for (const sentence of page.split(/(?<=[.!?])\s+(?=[A-Z*\[(#])/)) {
    const numbers = [...(sentence.replace(mention, " ").match(/\d+\.\d+/g) ?? [])].map(Number);
    if (numbers.length === 0) continue;
    for (const m of sentence.matchAll(mention)) {
      const kind = m[1]!.toLowerCase().startsWith("table") ? "Table" : "Section";
      for (const n of m[2]!.split(/\s*(?:,|and|&)\s*/)) {
        const text = kind === "Table" ? tableText(n) : sectionText(n);
        if (text === undefined) problems.push(`${kind} ${n} does not exist in the published paper`);
        else if (!numbers.some((v) => values(text).has(v))) problems.push(`${kind} ${n}: none of ${numbers.join(", ")} (stated with it) appears there in the published paper`);
      }
    }
  }
  return problems;
}

/** A .pptx as the slides skill's own reader (`skills/uktub-slides/scripts/pptx_outline.py`) reports it. */
export interface PptxFacts { slides: number; pictures: number; tables: number; equations: number; slidesWithNotes: number; titles: string[]; untitled: number; text: string }
export function pptxFacts(file: string): PptxFacts {
  const r = spawnSync("python3", [resolve(import.meta.dirname, "../../skills/uktub-slides/scripts/pptx_outline.py"), file], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`pptx_outline.py could not read ${file}: ${r.stderr.trim()}`);
  const lines = r.stdout.split("\n");
  const head = /— (\d+) slides, pictures (\d+), tables (\d+), equations (\d+), notes on (\d+) slides/.exec(lines[0] ?? "");
  if (head === null) throw new Error(`unexpected pptx_outline.py output: ${lines[0]}`);
  const titles = lines.flatMap((l) => { const m = /^\[\d+\] (.*?) \| pictures/.exec(l); return m && m[1] !== "(no title)" ? [m[1]!] : []; });
  const text = lines.flatMap((l) => (/^\[\d+\] /.test(l) ? [/^\[\d+\] (.*?) \| pictures/.exec(l)?.[1] ?? ""] : /^\s+(?:text|table): /.test(l) ? [l.replace(/^\s+(?:text|table): /, "")] : [])).join("\n");
  return { slides: +head[1]!, pictures: +head[2]!, tables: +head[3]!, equations: +head[4]!, slidesWithNotes: +head[5]!, titles, untitled: lines.filter((l) => /^\[\d+\] \(no title\) \|/.test(l)).length, text };
}
