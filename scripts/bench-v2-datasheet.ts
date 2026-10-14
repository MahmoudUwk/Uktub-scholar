/**
 * ATTRIBUTION.md builder for claim-verification-v2: short licence names, a per-paper credit table, and the full document. Pure, except the CLI.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Paper {
  id: string;
  category: string;
  title: string;
  authors: string[];
  license: string | null;
  sha256: string;
  [key: string]: unknown;
}

/** Short name of an arXiv licence URI; anything not CC BY or CC0 is not an open licence. */
export function licenseName(uri: string | null): string {
  if (uri === null) return "not an open licence";
  const by = uri.match(/^https?:\/\/creativecommons\.org\/licenses\/by\/(\d+(?:\.\d+)?)\/?$/);
  if (by) return `CC BY ${by[1] as string}`;
  const zero = uri.match(/^https?:\/\/creativecommons\.org\/publicdomain\/zero\/(\d+(?:\.\d+)?)\/?$/);
  if (zero) return `CC0 ${zero[1] as string}`;
  return "not an open licence";
}

/** A cell with pipes escaped so the table keeps its columns. */
const cell = (s: string): string => s.replace(/\|/g, "\\|");

/** The arXiv id without its version suffix, for the abs URL. */
const baseId = (id: string): string => id.replace(/v\d+$/, "");

/** The licence cell: a link for an open licence, plain text otherwise so no dead link is printed. */
const licenceCell = (p: Paper): string => {
  const name = licenseName(p.license);
  if (p.license === null || name === "not an open licence") return cell(name);
  return `[${cell(name)}](${p.license})`;
};

/** One table row crediting a paper under its own licence. */
const row = (p: Paper): string => {
  const authors = p.authors.length === 0 ? "(not recorded)" : cell(p.authors.join(", "));
  return `| [${cell(p.id)}](https://arxiv.org/abs/${baseId(p.id)}) | ${cell(p.title)} | ${authors} | ${licenceCell(p)} | \`${p.sha256.slice(0, 16)}\` |`;
};

/** A GitHub-flavoured Markdown table crediting each paper in the order given. */
export function attributionTable(papers: Paper[]): string {
  const head = "| arXiv id | Title | Authors | Licence | PDF sha256 |";
  const sep = "| --- | --- | --- | --- | --- |";
  return [head, sep, ...papers.map(row)].join("\n");
}

/** A count line like "2 papers: 1 CC BY 4.0, 1 CC0 1.0", most frequent licence first. */
const countLine = (papers: Paper[]): string => {
  const counts = new Map<string, number>();
  for (const p of papers) {
    const name = licenseName(p.license);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([name, n]) => `${n} ${name}`);
  return `${papers.length} ${papers.length === 1 ? "paper" : "papers"}: ${parts.join(", ")}`;
};

/** The complete ATTRIBUTION.md text: title, licence paragraph, rule, counts, and table. */
export function attributionDocument(corpus: { papers: Paper[]; rule?: { licenses?: string } }): string {
  const lines = [
    "# Attribution",
    "",
    "Each paper in this dataset is credited below under its own licence. Quotes taken from the papers in the dataset remain under those licences.",
    "",
  ];
  if (corpus.rule?.licenses) lines.push(`Licence rule: ${corpus.rule.licenses}`, "");
  lines.push(countLine(corpus.papers), "", attributionTable(corpus.papers), "");
  return lines.join("\n");
}

/** The value of a `--flag <value>` argument, or null when absent. */
const flag = (argv: string[], name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : null;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const corpusFile = flag(argv, "--corpus");
  if (corpusFile === null) {
    process.stderr.write("usage: bench-v2-datasheet.ts --corpus <file> [--out <file>]\n");
    process.exit(1);
  }
  const outFile = flag(argv, "--out") ?? join(dirname(corpusFile), "ATTRIBUTION.md");
  const corpus = JSON.parse(readFileSync(corpusFile, "utf8")) as { papers: Paper[]; rule?: { licenses?: string } };
  writeFileSync(outFile, attributionDocument(corpus));
}
