/**
 * Corpus of claim-verification-v2: public arXiv papers chosen by a rule, not by hand (docs/plans/2026-10-11-claim-verification-v2-benchmark-plan.md).
 * The pure parts (parsing the listing, picking papers) are tested offline; `main` fetches from arXiv with the spacing it asks for.
 *
 *   node scripts/bench-v2-corpus.ts --out <dir> [--manifest benchmarks/datasets/claim-verification-v2/corpus.json] --rebuild
 *
 * This REBUILDS the corpus from arXiv's listing and rewrites the manifest, which the published dataset must never see: it refuses to overwrite an
 * existing manifest unless `--rebuild` is given. To fetch the papers a published manifest lists, use scripts/bench-v2-fetch.ts.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mulberry32 } from "./bench-claims-v2-metrics.ts";

export interface Entry {
  /** arXiv id without the version, e.g. 2610.00840 */
  id: string;
  version: number;
  title: string;
  authors: string[];
  primary: string;
  published: string;
  pdfUrl: string;
}

export interface Inspection {
  pages: number;
  chars: number;
}

/** What the picker asks about a candidate: its licence (cheap, asked first) and its size (needs the PDF). */
export interface Hooks {
  license: (e: Entry) => Promise<string | null>;
  inspect: (e: Entry) => Promise<Inspection | null>;
}

export const RULES = {
  window: { from: "202607010000", to: "202609302359" },
  perCategory: 3,
  pages: { min: 8, max: 40 },
  chars: { min: 40_000, max: 140_000 },
  seed: 20261011,
  /** Only licences that let an open dataset carry quotes from the paper and statements derived from it: CC BY (any version) and CC0. Share-alike, non-commercial, no-derivatives and arXiv's default licence are out. */
  licenses: "CC BY (any version), CC0",
  listing: 100,
  categories: ["cs.CL", "cs.CV", "cs.LG", "cs.RO", "cs.SE", "cs.CR", "cs.HC", "stat.ME", "stat.AP", "econ.GN", "astro-ph.GA", "astro-ph.EP", "physics.chem-ph", "physics.ao-ph", "cond-mat.mtrl-sci", "q-bio.QM"],
  /** Papers whose claims are not findings of their own. */
  excludedTitle: /survey|review|tutorial|position paper|perspective|roadmap|overview|vision paper|call for|challenges and opportunities/i,
} as const;

const decode = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");

/** The entries of an arXiv API (Atom) response: one per paper. */
const ALLOWED_LICENSES = [/^https?:\/\/creativecommons\.org\/licenses\/by\/\d\.\d\/?$/, /^https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/?$/];

export function licenseAllowed(license: string | null): boolean {
  return license !== null && ALLOWED_LICENSES.some((re) => re.test(license.trim()));
}

export function parseListing(xml: string): Entry[] {
  const out: Entry[] = [];
  for (const block of xml.split("<entry>").slice(1)) {
    const entry = block.split("</entry>")[0] ?? "";
    const idMatch = /<id>https?:\/\/arxiv\.org\/abs\/([^<]+?)v(\d+)<\/id>/.exec(entry);
    const title = /<title>([\s\S]*?)<\/title>/.exec(entry)?.[1];
    const primary = /<arxiv:primary_category[^>]*term="([^"]+)"/.exec(entry)?.[1];
    const published = /<published>([^<]+)<\/published>/.exec(entry)?.[1];
    const pdf = /<link[^>]*href="([^"]+)"[^>]*type="application\/pdf"/.exec(entry)?.[1] ?? /<link[^>]*type="application\/pdf"[^>]*href="([^"]+)"/.exec(entry)?.[1];
    if (!idMatch || title === undefined || !primary || !published || !pdf) continue;
    out.push({ id: idMatch[1] as string, version: Number(idMatch[2]), title: decode(title).replace(/\s+/g, " ").trim(), authors: [...entry.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)].map((m) => decode(m[1] as string).replace(/\s+/g, " ").trim()), primary, published, pdfUrl: pdf });
  }
  return out;
}

const hash = (s: string): number => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

/**
 * The papers of one category, by rule: the listing is put in a canonical order (so its order cannot matter), shuffled with the seed (a
 * different stream per category), and walked until `RULES.perCategory` papers pass the licence and the page and length limits. Nothing else is looked at.
 */
export async function pickPapers(entries: Entry[], category: string, hooks: Hooks, seed: number): Promise<Array<Entry & Inspection & { license: string }>> {
  const inspect = hooks.inspect;
  const pool = entries.filter((e) => e.primary === category && !RULES.excludedTitle.test(e.title)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rand = mulberry32((seed ^ hash(category)) >>> 0);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j] as Entry, pool[i] as Entry];
  }
  const picked: Array<Entry & Inspection & { license: string }> = [];
  for (const e of pool) {
    if (picked.length >= RULES.perCategory) break;
    const license = await hooks.license(e); // asked first: a paper that cannot be carried is never downloaded
    if (license === null || !licenseAllowed(license)) continue;
    const ins = await inspect(e);
    if (ins === null || ins.pages < RULES.pages.min || ins.pages > RULES.pages.max || ins.chars < RULES.chars.min || ins.chars > RULES.chars.max) continue;
    picked.push({ ...e, ...ins, license: license.trim() });
  }
  return picked;
}

/** Four folds of equal size with every category spread over them (the bar for a fold is fitted on the other three). */
export function foldOf(categoryIndex: number, indexInCategory: number): number {
  return (categoryIndex + indexInCategory) % 4;
}

// ── fetching ────────────────────────────────────────────────────────────────

const UA = "uktub-scholar-benchmark/0.2 (research benchmark corpus; one request every 3 s)";
let lastCall = 0;
async function politeFetch(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const wait = lastCall + 3100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (res.ok) return res;
    if (attempt >= 4 || ![429, 500, 502, 503].includes(res.status)) throw new Error(`${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 15_000 * attempt));
  }
}

async function main(): Promise<void> {
  const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : process.argv[i + 1]; };
  const out = arg("out");
  if (!out) throw new Error("usage: bench-v2-corpus.ts --out <dir> [--manifest <file>] [--rebuild]");
  const manifestPath = arg("manifest") ?? "benchmarks/datasets/claim-verification-v2/corpus.json";
  if (existsSync(manifestPath) && !process.argv.includes("--rebuild")) {
    process.stderr.write(`${manifestPath} already exists and this command rebuilds it from arXiv's listing, which would change a published dataset. Pass --rebuild to do that on purpose; to download the papers it lists use scripts/bench-v2-fetch.ts.\n`);
    process.exit(1);
  }
  mkdirSync(join(out, "pdf"), { recursive: true });
  mkdirSync(join(out, "text"), { recursive: true });
  const papers: Array<Record<string, unknown>> = [];
  // A paper's licence is asked of arXiv once (one request every 3 s) and kept, so a rerun of the same rule costs nothing.
  const licenseFile = join(out, "licenses.json");
  const licenseCache: Record<string, string | null> = existsSync(licenseFile) ? (JSON.parse(readFileSync(licenseFile, "utf8")) as Record<string, string | null>) : {};
  for (const [ci, category] of RULES.categories.entries()) {
    const url = `https://export.arxiv.org/api/query?search_query=cat:${category}+AND+submittedDate:%5B${RULES.window.from}+TO+${RULES.window.to}%5D&sortBy=submittedDate&sortOrder=descending&max_results=${RULES.listing}`;
    const listing = parseListing(await (await politeFetch(url)).text());
    let inspected = 0;
    const license = async (e: Entry): Promise<string | null> => {
      if (e.id in licenseCache) return licenseCache[e.id] ?? null;
      const xml = await (await politeFetch(`https://oaipmh.arxiv.org/oai?verb=GetRecord&identifier=oai:arXiv.org:${e.id}&metadataPrefix=arXiv`)).text();
      const found = /<license>([^<]+)<\/license>/.exec(xml)?.[1] ?? null;
      licenseCache[e.id] = found;
      writeFileSync(licenseFile, JSON.stringify(licenseCache, null, 1));
      return found;
    };
    const picked = await pickPapers(listing, category, { license, inspect: async (e) => {
      inspected += 1;
      const file = join(out, "pdf", `${e.id}v${e.version}.pdf`);
      try {
        if (!existsSync(file)) writeFileSync(file, new Uint8Array(await (await politeFetch(e.pdfUrl)).arrayBuffer()));
        const info = spawnSync("pdfinfo", [file], { encoding: "utf8" });
        const pages = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1] ?? 0);
        const txt = join(out, "text", `${e.id}v${e.version}.txt`);
        const run = spawnSync("pdftotext", ["-q", file, txt], { encoding: "utf8" });
        if (run.status !== 0 || pages === 0) return null;
        return { pages, chars: statSync(txt).size };
      } catch (err) {
        console.error(`skip ${e.id}: ${(err as Error).message}`);
        return null;
      }
    } }, RULES.seed);
    console.log(`${category}: listing ${listing.length}, inspected ${inspected}, picked ${picked.length}`);
    for (const [i, p] of picked.entries()) {
      const file = join(out, "pdf", `${p.id}v${p.version}.pdf`);
      papers.push({ id: `${p.id}v${p.version}`, category, fold: foldOf(ci, i), title: p.title, authors: p.authors, published: p.published, pdfUrl: p.pdfUrl, license: p.license, sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), bytes: statSync(file).size, pages: p.pages, chars: p.chars });
    }
  }
  mkdirSync(dirname(manifestPath), { recursive: true });
  const poppler = spawnSync("pdftotext", ["-v"], { encoding: "utf8" }).stderr.split("\n")[0];
  writeFileSync(manifestPath, JSON.stringify({
    schema: "claim-verification-v2-corpus/1", generated: new Date().toISOString().slice(0, 10),
    rule: { window: RULES.window, perCategory: RULES.perCategory, pages: RULES.pages, chars: RULES.chars, seed: RULES.seed, listing: `the ${RULES.listing} most recently submitted papers of the category in the window, primary category only`, excludedTitle: RULES.excludedTitle.source, licenses: RULES.licenses, categories: RULES.categories },
    extraction: `pdftotext -q <pdf> <txt> (${poppler})`, folds: "4, stratified by category (foldOf); the bar for a fold is fitted on the other three",
    papers,
  }, null, 1));
  console.log(`${papers.length} papers; manifest ${manifestPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
