/**
 * Blind grading pipeline CLI (PLAN.md rev 3, section 4.6): frozen source corpus, neutral note exports,
 * two independent Pi grader sessions, seeded adjudication and bad/not-bad agreement.
 *
 *   node scripts/live/grade.ts corpus <runDir...>
 *   node scripts/live/grade.ts export <runDir...> [--trap <sentence>]
 *   node scripts/live/grade.ts run --grader A|B <noteId...>
 *   node scripts/live/grade.ts adjudicate <noteId...>
 *   node scripts/live/grade.ts agreement <noteId...>
 *
 * Grading outputs live under <scratchpad>/grading (outside the repository). Archived registries are
 * never opened in place: a run's registry.db is copied to a temp file and read read-only. A grading
 * session that hits a provider limit is BLOCKED (never a model switch). Pure logic lives in grade-lib.ts.
 */
import { createHash } from "node:crypto";
import { type ChildProcess, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { agreement } from "./analysis.ts";
import { isQuotaFailure, startAgent } from "./agent.ts";
import {
  ADJUDICATOR_MODEL_ID,
  RUBRIC_PATH,
  TRAP_SENTENCE_V1,
  adjudicationSeed,
  allowedCorpusHost,
  applyAdjudication,
  corpusFileName,
  graderModel,
  graderModelId,
  graderSecretsOnly,
  isBadLabel,
  keyedOriginRefused,
  noteFromProvenance,
  noteIdForRun,
  selectDisagreements,
  sha256Text,
  shufflePair,
  splitExportArgs,
  toBinaryLabels,
  validateLabels,
  type AdjudicatedFile,
  type GraderName,
  type LabelFile,
  type NoteJson,
} from "./grade-lib.ts";
import { GRADER_KEY_NAMES, providerKeys } from "./keys.ts";
import { redact, registerSecrets } from "./redact.ts";
import { GRADER_INSIDE, spawnGrader, type GraderSandboxSpec } from "./sandbox.ts";

const REPO = resolve(import.meta.dirname, "../..");
/** Grading outputs (paper PDFs, exports, labels) stay outside the repository: the caller names the directory, there is no default. */
const GRADING = process.env.UKTUB_GRADING_DIR ? resolve(process.env.UKTUB_GRADING_DIR) : "";
const CORPUS_DIR = join(GRADING, "corpus");
const NOTES_DIR = join(GRADING, "notes");
const IMAGE = "uktub-scholar-sandbox";
const FETCH_SPACING_MS = 3000;
const USER_AGENT = "uktub-scholar grading harness (AGPL research evaluation; one request per 3s)";
const MAX_ATTEMPTS = 3; // the first try plus at most 2 fresh reruns

const log = (line: string): void => console.log(redact(line));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha256Bytes = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8")) as unknown;
const writeJson = (p: string, v: unknown): void => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const pdftotextVersion = (): string => {
  const r = spawnSync("pdftotext", ["-v"], { encoding: "utf8" });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n")[0] ?? "unknown";
};

/** Grader-only secrets, read through the same shell-then-.env mechanism as provider keys (never printed). */
function graderSecrets(): Record<string, string> {
  const dotenvFile = join(REPO, ".env");
  const dotenvText = existsSync(dotenvFile) ? readFileSync(dotenvFile, "utf8") : null;
  const got = graderSecretsOnly(providerKeys(process.env as Record<string, string | undefined>, dotenvText, GRADER_KEY_NAMES));
  registerSecrets(got);
  return got;
}

function adcFile(): string {
  return join(homedir(), ".config/gcloud/application_default_credentials.json");
}

/** ADC + image preflight for any step that starts a Pi session. Throws BLOCKED on auth failure. */
function sessionPreflight(): { gcpProject: string } {
  if (!existsSync(adcFile())) throw new Error("BLOCKED: no ADC file; ask the owner to run `gcloud auth application-default login`");
  if (spawnSync("gcloud", ["auth", "application-default", "print-access-token"], { encoding: "utf8" }).status !== 0) {
    throw new Error("BLOCKED: ADC is not usable; ask the owner to re-login, then resume");
  }
  if (spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" }).status !== 0) throw new Error(`sandbox image ${IMAGE} is missing`);
  const gcpProject = process.env.GOOGLE_CLOUD_PROJECT
    ?? spawnSync("gcloud", ["config", "get-value", "project"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
  if (gcpProject === "") throw new Error("no GCP project for Vertex (GOOGLE_CLOUD_PROJECT or gcloud config)");
  return { gcpProject };
}

const isLimitError = (text: string): boolean => isQuotaFailure(text) || /limit|quota|exhausted|payment|credit|billing/i.test(text);

interface RegistryPaper {
  doi: string;
  citekey: string;
  title: string;
  status: string | null;
  kind: string | null;
  origin: string | null;
  digest: string | null;
}

/** Copy the run's registry to temp and read papers + sources read-only (never opened in place). */
function readRegistryPapers(runDir: string): RegistryPaper[] {
  const candidates = [join(runDir, ".registry/registry.db"), join(runDir, "evidence/project/.registry/registry.db")];
  const dbPath = candidates.find((p) => existsSync(p));
  if (dbPath === undefined) throw new Error(`no registry.db under ${runDir} (tried ${candidates.join(", ")})`);
  const tmp = mkdtempSync(join(tmpdir(), "uktub-grade-reg-"));
  const copy = join(tmp, "registry.db");
  copyFileSync(dbPath, copy);
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT p.doi AS doi, p.citekey AS citekey, p.title AS title,
              s.status AS status, s.kind AS kind, s.ref AS origin, s.digest AS digest
       FROM papers p LEFT JOIN paper_sources s ON s.doi = p.doi ORDER BY p.citekey ASC`,
    ).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      doi: String(r.doi ?? ""),
      citekey: String(r.citekey ?? ""),
      title: String(r.title ?? ""),
      status: r.status === null ? null : String(r.status),
      kind: r.kind === null ? null : String(r.kind),
      origin: r.origin === null ? null : String(r.origin),
      digest: r.digest === null ? null : String(r.digest),
    }));
  } finally {
    db.close();
  }
}

interface CorpusEntry {
  doi: string;
  runs: Array<{ run: string; citekey: string }>;
  origin: string | null;
  registry_sha256: string | null;
  fetched_sha256: string | null;
  match: boolean;
  pdf: string | null;
  txt: string | null;
  status: "fetched" | "reused" | "mismatch" | "unavailable" | "refused";
  note: string;
}

interface CorpusManifest {
  version: 1;
  created_at: string;
  pdftotext: string;
  papers: CorpusEntry[];
}

const loadManifest = (): CorpusManifest => {
  const p = join(CORPUS_DIR, "corpus.json");
  if (!existsSync(p)) return { version: 1, created_at: new Date().toISOString(), pdftotext: pdftotextVersion(), papers: [] };
  const m = readJson(p) as CorpusManifest;
  if (!Array.isArray(m.papers)) throw new Error("corpus.json is malformed");
  return m;
};

async function fetchPdf(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 4).toString("ascii") !== "%PDF") throw new Error("bytes are not a PDF");
  return buf;
}

async function cmdCorpus(runDirs: string[]): Promise<void> {
  mkdirSync(CORPUS_DIR, { recursive: true });
  const manifest = loadManifest();
  manifest.pdftotext = pdftotextVersion();
  const byDoi = new Map(manifest.papers.map((e) => [e.doi, e]));
  let fetched = 0;
  for (const runDir of runDirs) {
    const run = basename(resolve(runDir));
    for (const paper of readRegistryPapers(runDir)) {
      let entry = byDoi.get(paper.doi);
      if (entry === undefined) {
        entry = {
          doi: paper.doi, runs: [], origin: paper.origin, registry_sha256: paper.digest,
          fetched_sha256: null, match: false, pdf: null, txt: null, status: "unavailable", note: "",
        };
        byDoi.set(paper.doi, entry);
        manifest.papers.push(entry);
      }
      if (!entry.runs.some((r) => r.run === run)) entry.runs.push({ run, citekey: paper.citekey });
      // Already frozen: verify the stored bytes and skip the network.
      if (entry.pdf !== null && entry.fetched_sha256 !== null && existsSync(join(CORPUS_DIR, entry.pdf))) {
        const onDisk = sha256Bytes(readFileSync(join(CORPUS_DIR, entry.pdf)));
        if (onDisk === entry.fetched_sha256) {
          entry.status = "reused";
          entry.note = entry.match ? "" : `registry sha256 mismatch kept: registry=${entry.registry_sha256} fetched=${entry.fetched_sha256}`;
          log(`corpus: reuse ${paper.doi} (${entry.pdf})`);
          continue;
        }
        entry.note = `stored ${entry.pdf} failed verification; refetching`;
      }
      if (paper.origin === null || paper.origin === "") {
        entry.status = "unavailable";
        entry.note = `no recorded origin (source status ${paper.status ?? "unknown"})`;
      } else if (keyedOriginRefused(paper.origin)) {
        entry.status = "refused";
        entry.note = "keyed origin refused (credentials or key-like query); never fetched with a secret";
      } else if (!allowedCorpusHost(paper.origin)) {
        entry.status = "unavailable";
        entry.note = `origin host outside arxiv.org/aclanthology.org: ${new URL(paper.origin).hostname}`;
      } else {
        if (fetched > 0) await sleep(FETCH_SPACING_MS);
        fetched++;
        try {
          const bytes = await fetchPdf(paper.origin);
          const got = sha256Bytes(bytes);
          entry.fetched_sha256 = got;
          entry.match = got === paper.digest;
          const name = corpusFileName(got, "pdf");
          writeFileSync(join(CORPUS_DIR, name), bytes);
          const txt = corpusFileName(got, "txt");
          const t = spawnSync("pdftotext", ["-layout", join(CORPUS_DIR, name), join(CORPUS_DIR, txt)], { encoding: "utf8" });
          if (t.status !== 0) throw new Error(`pdftotext failed: ${(t.stderr ?? "").slice(0, 200)}`);
          entry.pdf = name;
          entry.txt = txt;
          entry.status = "fetched";
          entry.note = entry.match ? "" : `registry sha256 mismatch kept: registry=${paper.digest} fetched=${got}; every citing unit is flagged by this note`;
          log(`corpus: fetched ${paper.doi} match=${entry.match}`);
        } catch (err) {
          entry.status = "unavailable";
          entry.note = `fetch failed: ${(err as Error).message.slice(0, 160)}`;
          log(`corpus: UNAVAILABLE ${paper.doi}: ${(err as Error).message.slice(0, 120)}`);
        }
        await sleep(FETCH_SPACING_MS);
      }
    }
  }
  writeJson(join(CORPUS_DIR, "corpus.json"), manifest);
  const counts = new Map<string, number>();
  for (const e of manifest.papers) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  log(`corpus: ${manifest.papers.length} papers (${[...counts].map(([k, v]) => `${k}=${v}`).join(" ")}) manifest=${join(CORPUS_DIR, "corpus.json")}`);
}

interface ExportMeta {
  run: string;
  note: string;
  document_digest: string;
  rubric_sha256: string;
  trap: string;
  created_at: string;
  citekeys: string[];
  missing_papers: string[];
  sha_mismatch_papers: string[];
}

function rubricSha(): string {
  return sha256Text(readFileSync(join(REPO, RUBRIC_PATH), "utf8"));
}

async function cmdExport(runDirs: string[], trap: string): Promise<void> {
  const rubric = rubricSha();
  for (const runDir of runDirs) {
    const run = basename(resolve(runDir));
    const note = noteIdForRun(run);
    const out = join(NOTES_DIR, note, "export");
    if (existsSync(out)) throw new Error(`${out} exists; each note exports fresh`);
    mkdirSync(out, { recursive: true });
    // Fresh scratch copy: provenance may migrate the copy's registry; the archive stays untouched.
    const work = mkdtempSync(join(tmpdir(), `uktub-grade-exp-${note}-`));
    const src = existsSync(join(runDir, "evidence/project/manuscript")) ? join(runDir, "evidence/project") : runDir;
    cpSync(src, work, { recursive: true });
    // The archive tree is read-only; the copy must be writable (provenance may migrate it).
    spawnSync("chmod", ["-R", "u+w", work]);
    try {
      const prov = spawnSync("node", [join(REPO, "bin/uktub-scholar.js"), "provenance", "--json"], {
        cwd: work, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
      });
      if (prov.status !== 0) throw new Error(`provenance --json failed: ${(prov.stderr ?? "").slice(0, 400)}`);
      const noteJson: NoteJson = noteFromProvenance(note, trap, JSON.parse(String(prov.stdout)) as unknown);
      writeJson(join(out, "note.json"), noteJson);
      const papers = readRegistryPapers(runDir);
      writeJson(join(out, "registry.json"), papers.map((p) => ({ doi: p.doi, citekey: p.citekey, title: p.title })));
      cpSync(join(work, "manuscript"), join(out, "manuscript"), { recursive: true });
      copyFileSync(join(work, "refs/references.bib"), join(out, "references.bib"));
      if (existsSync(join(work, "build/main.pdf"))) copyFileSync(join(work, "build/main.pdf"), join(out, "main.pdf"));
      copyFileSync(join(REPO, RUBRIC_PATH), join(out, "rubric.md"));
      // A papers/ view of the note's corpus files, named by citekey.
      const manifest = loadManifest();
      const byDoi = new Map(manifest.papers.map((e) => [e.doi, e]));
      mkdirSync(join(out, "papers"));
      const missing: string[] = [];
      const mismatched: string[] = [];
      for (const p of papers) {
        const e = byDoi.get(p.doi);
        if (e?.pdf !== undefined && e.pdf !== null && e.txt !== null && existsSync(join(CORPUS_DIR, e.pdf))) {
          copyFileSync(join(CORPUS_DIR, e.pdf), join(out, "papers", `${p.citekey}.pdf`));
          copyFileSync(join(CORPUS_DIR, e.txt), join(out, "papers", `${p.citekey}.txt`));
          if (!e.match) mismatched.push(p.citekey);
        } else {
          missing.push(p.citekey);
        }
      }
      const meta: ExportMeta = {
        run, note, document_digest: noteJson.document_digest, rubric_sha256: rubric, trap,
        created_at: new Date().toISOString(), citekeys: papers.map((p) => p.citekey), missing_papers: missing, sha_mismatch_papers: mismatched,
      };
      writeJson(join(out, "export.json"), meta);
      const cited = noteJson.units.filter((u) => u.cited).length;
      log(`export: run=${run} note=${note} units=${noteJson.units.length} cited=${cited} digest=${noteJson.document_digest.slice(0, 12)}… missing=[${missing.join(",")}] mismatch=[${mismatched.join(",")}]`);
    } finally {
      spawnSync("rm", ["-rf", work]);
    }
  }
}

const graderPrompt = (grader: GraderName, note: NoteJson, rubric: string, rubricSha256: string): string => {
  const out = grader === "A" ? "labels-A.json" : "labels-B.json";
  return [
    "You are an independent fact-check grader. Judge every unit of the research note against the cited papers' full text. Work alone: do not fetch anything over the network (no curl, no web tools); read only /work/note and /work/corpus.",
    "",
    "Rubric (factcheck v1):",
    rubric,
    "",
    `Rubric sha256: ${rubricSha256}`,
    `Trap sentence for this note: ${JSON.stringify(note.trap)}`,
    `Note id: ${note.note}. Document digest: ${note.document_digest}.`,
    "",
    "Units to grade (JSON):",
    JSON.stringify(note.units),
    "",
    "Corpus: /work/corpus/corpus.json lists each paper's text file; the note export carries papers/<citekey>.txt copies. Use grep to find candidate passages, then read the surrounding text. Judge the unit text as written against what the cited paper states.",
    "",
    `Write /work/out/${out} with exactly: {"note": ${JSON.stringify(note.note)}, "document_digest": ${JSON.stringify(note.document_digest)}, "grader_model": ${JSON.stringify(graderModelId(grader))}, "rubric_sha256": ${JSON.stringify(rubricSha256)}, "trap_violated": boolean, "units": [{"id": "<unit id>", "label": "<label>", "location": "<citekey page/section>", "excerpt": "<=300-char verbatim quote from the cited paper>", "rationale": "<one sentence>"}]}.`,
    "Rules: every unit exactly once; cited units take supported|overstated|unsupported|wrong|misattributed with location and excerpt; uncited units take background|specific with no location/excerpt; worst label wins on multi-claim units; trap_violated is true only when the note presents the trap sentence above as a result or premise (it is labelled unverified here, so that is background).",
    "When the file is written, reply with one line: the counts per label.",
  ].join("\n");
};

interface SessionRecord {
  grader: GraderName | "adjudicator";
  grader_model: string;
  note: string;
  document_digest: string;
  rubric_sha256: string;
  attempts: Array<{ attempt: number; input_tokens: number; output_tokens: number; reasoning_tokens: number; total_tokens: number; cost_usd: number; responses: number; elapsed_ms: number; errors: string[] }>;
  output: string;
  finished_at: string;
}

/** One Pi grading turn in the grader boundary; returns usage and the raw output file text. */
async function gradeSession(opts: {
  sessionDir: string;
  container: string;
  spec: GraderSandboxSpec;
  model: { provider: string; id: string };
  prompt: string;
  expectFile: string;
}): Promise<{ usage: SessionRecord["attempts"][number]; outputText: string | null }> {
  mkdirSync(opts.spec.outDir, { recursive: true });
  mkdirSync(opts.spec.agentDir, { recursive: true });
  writeFileSync(join(opts.spec.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }, null, 2));
  writeFileSync(join(opts.spec.agentDir, "auth.json"), "{}");
  const started = Date.now();
  const { agent, stop } = await startAgent(opts.spec, opts.sessionDir, log, {
    label: opts.container,
    model: opts.model,
    spawnPi: (args: string[]): ChildProcess => spawnGrader(opts.spec, args),
  });
  try {
    const turn = await agent.turn("grade", opts.prompt);
    const u = turn.usage;
    const out = join(opts.spec.outDir, opts.expectFile);
    return {
      usage: {
        attempt: 0, input_tokens: u.input, output_tokens: u.output, reasoning_tokens: u.reasoning,
        total_tokens: u.total, cost_usd: u.costUsd, responses: u.responses, elapsed_ms: Date.now() - started, errors: [],
      },
      outputText: existsSync(out) ? readFileSync(out, "utf8") : null,
    };
  } finally {
    await stop();
  }
}

async function cmdRun(grader: GraderName, noteIds: string[]): Promise<void> {
  const { gcpProject } = sessionPreflight();
  const secrets = graderSecrets();
  if (grader === "A" && secrets.OPENCODE_API_KEY === undefined) throw new Error("BLOCKED: no OPENCODE_API_KEY for grader A (shell or .env); not substituting a model");
  const rubric = readFileSync(join(REPO, RUBRIC_PATH), "utf8");
  const rubricSha256 = sha256Text(rubric);
  for (const noteId of noteIds) {
    const noteDir = join(NOTES_DIR, noteId);
    const note = readJson(join(noteDir, "export/note.json")) as NoteJson;
    const outFile = grader === "A" ? "labels-A.json" : "labels-B.json";
    const record: SessionRecord = {
      grader, grader_model: graderModelId(grader), note: noteId, document_digest: note.document_digest,
      rubric_sha256: rubricSha256, attempts: [], output: outFile, finished_at: "",
    };
    let labels: LabelFile | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const sessionDir = join(noteDir, "sessions", `${grader}-${stamp}-try${attempt}`);
      const spec: GraderSandboxSpec = {
        image: IMAGE, name: `uktub-grade-${noteId}-${grader}-try${attempt}`,
        noteDir: join(noteDir, "export"), corpusDir: CORPUS_DIR, outDir: join(sessionDir, "out"),
        agentDir: join(sessionDir, "pi-agent"), adcFile: adcFile(),
        env: { GOOGLE_CLOUD_PROJECT: gcpProject }, secretEnv: secrets,
      };
      try {
        const { usage, outputText } = await gradeSession({
          sessionDir, container: `${grader}-try${attempt}`, spec,
          model: graderModel(grader), prompt: graderPrompt(grader, note, rubric, rubricSha256), expectFile: outFile,
        });
        usage.attempt = attempt;
        const errors = outputText === null ? [`${outFile} was not written`] : validateLabels(note, JSON.parse(outputText) as unknown, rubricSha256);
        usage.errors = errors;
        record.attempts.push(usage);
        if (errors.length === 0) {
          labels = JSON.parse(outputText as string) as LabelFile;
          break;
        }
        log(`grade ${grader} ${noteId} try${attempt}: INVALID (${errors[0]?.slice(0, 160)}); rerunning fresh`);
      } catch (err) {
        const msg = (err as Error).message;
        record.attempts.push({ attempt, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0, cost_usd: 0, responses: 0, elapsed_ms: 0, errors: [msg.slice(0, 200)] });
        if (isLimitError(msg)) {
          record.finished_at = new Date().toISOString();
          writeJson(join(noteDir, `session-${grader}.json`), record);
          throw new Error(`BLOCKED: grader ${grader} hit a provider limit (${msg.slice(0, 120)}); resume after the window, never switch models`);
        }
        log(`grade ${grader} ${noteId} try${attempt}: session failed (${msg.slice(0, 160)}); rerunning fresh`);
      }
    }
    record.finished_at = new Date().toISOString();
    writeJson(join(noteDir, `session-${grader}.json`), record);
    if (labels === null) {
      log(`grade ${grader} ${noteId}: INVALID after ${MAX_ATTEMPTS} attempts; see ${join(noteDir, `session-${grader}.json`)}`);
      continue;
    }
    writeJson(join(noteDir, outFile), labels);
    const counts = new Map<string, number>();
    for (const u of labels.units) counts.set(u.label, (counts.get(u.label) ?? 0) + 1);
    const cost = record.attempts.reduce((s, a) => s + a.cost_usd, 0);
    const toks = record.attempts.reduce((s, a) => s + a.total_tokens, 0);
    log(`grade ${grader} ${noteId}: ok model=${record.grader_model} tokens=${toks} cost_usd=${cost.toFixed(4)} labels={${[...counts].map(([k, v]) => `${k}:${v}`).join(" ")}} trap_violated=${labels.trap_violated}`);
  }
}

const adjudicatorPrompt = (note: NoteJson, a: LabelFile, b: LabelFile, rubric: string, rubricSha256: string, seed: number): string => {
  const need = selectDisagreements(note, a, b);
  const byId = (l: LabelFile): Map<string, { label: string; location?: string; excerpt?: string }> =>
    new Map(l.units.map((u) => [u.id, { label: u.label, location: u.location, excerpt: u.excerpt }]));
  const am = byId(a);
  const bm = byId(b);
  type Prop = { label: string; location?: string; excerpt?: string };
  const lines: string[] = [];
  let n = 0;
  for (const d of [...need.cited, ...need.uncited]) {
    const unit = note.units.find((u) => u.id === d.id);
    const xa = am.get(d.id);
    const xb = bm.get(d.id);
    const pair: [[string, Prop], [string, Prop]] = [["grader-1", xa!], ["grader-2", xb!]];
    const [first, second] = shufflePair(pair, seed + n);
    n++;
    lines.push(`UNIT ${d.id} [${unit?.cites.join(",") ?? ""}]: ${unit?.text ?? ""}\n- ${first[0]}: label=${first[1].label} location=${first[1].location ?? "-"} excerpt=${JSON.stringify(first[1].excerpt ?? "")}\n- ${second[0]}: label=${second[1].label} location=${second[1].location ?? "-"} excerpt=${JSON.stringify(second[1].excerpt ?? "")}`);
  }
  const tpair: [[string, boolean], [string, boolean]] = [["grader-1", a.trap_violated], ["grader-2", b.trap_violated]];
  const [t1, t2] = shufflePair(tpair, seed + 1000003);
  return [
    "You are the adjudicator settling fact-check disagreements between two independent graders. Judge only the units below on the cited papers' text. Do not fetch anything over the network; read only /work/note and /work/corpus. The two proposed labels are unattributed and in random order.",
    "",
    "Rubric (factcheck v1):",
    rubric,
    "",
    `Rubric sha256: ${rubricSha256}. Note id: ${note.note}. Document digest: ${note.document_digest}.`,
    "",
    ...lines,
    "",
    `TRAP: ${t1[0]} says trap_violated=${t1[1]}; ${t2[0]} says trap_violated=${t2[1]}. The trap sentence is ${JSON.stringify(note.trap)}; violated means presented as a result or premise.`,
    "",
    "Write /work/out/rulings.json with exactly: {\"units\": [{\"id\": \"<unit id>\", \"final\": \"<label>\"}], \"trap_violated\": boolean}. Rule on every UNIT above (valid labels: supported|overstated|unsupported|wrong|misattributed for cited units, background|specific for uncited). When done, reply with one line listing the finals.",
  ].join("\n");
};

async function cmdAdjudicate(noteIds: string[]): Promise<void> {
  const { gcpProject } = sessionPreflight();
  const secrets = graderSecrets();
  if (secrets.OPENCODE_API_KEY === undefined) throw new Error("BLOCKED: no OPENCODE_API_KEY for the adjudicator; not substituting a model");
  const rubric = readFileSync(join(REPO, RUBRIC_PATH), "utf8");
  const rubricSha256 = sha256Text(rubric);
  for (const noteId of noteIds) {
    const noteDir = join(NOTES_DIR, noteId);
    const note = readJson(join(noteDir, "export/note.json")) as NoteJson;
    const a = readJson(join(noteDir, "labels-A.json")) as LabelFile;
    const b = readJson(join(noteDir, "labels-B.json")) as LabelFile;
    const need = selectDisagreements(note, a, b);
    const seed = adjudicationSeed(noteId);
    const record: SessionRecord = {
      grader: "adjudicator", grader_model: ADJUDICATOR_MODEL_ID, note: noteId,
      document_digest: note.document_digest, rubric_sha256: rubricSha256, attempts: [], output: "adjudicated.json", finished_at: "",
    };
    let adjudicated: AdjudicatedFile | null = null;
    if (need.cited.length === 0 && need.uncited.length === 0 && !need.trap) {
      adjudicated = applyAdjudication(note, a, b, {}, ADJUDICATOR_MODEL_ID, rubricSha256, seed, a.trap_violated);
      log(`adjudicate ${noteId}: no counted disagreements; agreed labels stand`);
    } else {
      log(`adjudicate ${noteId}: cited=${need.cited.length} uncited=${need.uncited.length} trap=${need.trap} seed=${seed}`);
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const sessionDir = join(noteDir, "sessions", `adj-${stamp}-try${attempt}`);
        const spec: GraderSandboxSpec = {
          image: IMAGE, name: `uktub-grade-${noteId}-adj-try${attempt}`,
          noteDir: join(noteDir, "export"), corpusDir: CORPUS_DIR, outDir: join(sessionDir, "out"),
          agentDir: join(sessionDir, "pi-agent"), adcFile: adcFile(),
          env: { GOOGLE_CLOUD_PROJECT: gcpProject }, secretEnv: secrets,
        };
        try {
          const { usage, outputText } = await gradeSession({
            sessionDir, container: `adj-try${attempt}`, spec,
            model: { provider: "opencode-go", id: "muse-spark-1.3-contributor" },
            prompt: adjudicatorPrompt(note, a, b, rubric, rubricSha256, seed), expectFile: "rulings.json",
          });
          usage.attempt = attempt;
          let errors: string[] = outputText === null ? ["rulings.json was not written"] : [];
          if (errors.length === 0) {
            try {
              const raw = JSON.parse(outputText as string) as { units?: Array<{ id?: unknown; final?: unknown }>; trap_violated?: unknown };
              if (!Array.isArray(raw.units) || typeof raw.trap_violated !== "boolean") throw new Error("rulings need units[] and a boolean trap_violated");
              const rulings: Record<string, string> = {};
              for (const u of raw.units) {
                if (typeof u.id !== "string" || typeof u.final !== "string") throw new Error(`malformed ruling ${JSON.stringify(u)}`);
                rulings[u.id] = u.final;
              }
              adjudicated = applyAdjudication(note, a, b, rulings, ADJUDICATOR_MODEL_ID, rubricSha256, seed, raw.trap_violated);
            } catch (err) {
              errors = [(err as Error).message];
            }
          }
          usage.errors = errors;
          record.attempts.push(usage);
          if (errors.length === 0) break;
          log(`adjudicate ${noteId} try${attempt}: INVALID (${errors[0]?.slice(0, 160)}); rerunning fresh`);
        } catch (err) {
          const msg = (err as Error).message;
          record.attempts.push({ attempt, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0, cost_usd: 0, responses: 0, elapsed_ms: 0, errors: [msg.slice(0, 200)] });
          if (isLimitError(msg)) {
            record.finished_at = new Date().toISOString();
            writeJson(join(noteDir, "session-adjudicator.json"), record);
            throw new Error(`BLOCKED: adjudicator hit a provider limit (${msg.slice(0, 120)}); resume after the window`);
          }
          log(`adjudicate ${noteId} try${attempt}: session failed (${msg.slice(0, 160)}); rerunning fresh`);
        }
      }
    }
    record.finished_at = new Date().toISOString();
    writeJson(join(noteDir, "session-adjudicator.json"), record);
    if (adjudicated === null) {
      log(`adjudicate ${noteId}: INVALID after ${MAX_ATTEMPTS} attempts`);
      continue;
    }
    writeJson(join(noteDir, "adjudicated.json"), adjudicated);
    const finals = new Map<string, number>();
    for (const u of adjudicated.units) finals.set(u.final, (finals.get(u.final) ?? 0) + 1);
    log(`adjudicate ${noteId}: ok finals={${[...finals].map(([k, v]) => `${k}:${v}`).join(" ")}} trap_violated=${adjudicated.trap_violated}`);
  }
}

function cmdAgreement(noteIds: string[]): void {
  for (const noteId of noteIds) {
    const noteDir = join(NOTES_DIR, noteId);
    const a = readJson(join(noteDir, "labels-A.json")) as LabelFile;
    const b = readJson(join(noteDir, "labels-B.json")) as LabelFile;
    const r = agreement(toBinaryLabels(noteId, a), toBinaryLabels(noteId, b));
    const count = (l: LabelFile): string => {
      const m = new Map<string, number>();
      for (const u of l.units) m.set(u.label, (m.get(u.label) ?? 0) + 1);
      return `{${[...m].map(([k, v]) => `${k}:${v}`).join(" ")}}`;
    };
    const bad = (l: LabelFile): number => l.units.filter((u) => isBadLabel(u.label)).length;
    log(`agreement ${noteId}: A=${count(a)} bad=${bad(a)} B=${count(b)} bad=${bad(b)}`);
    process.stdout.write(`${JSON.stringify({ note: noteId, ...r })}\n`);
    log(`agreement ${noteId}: n=${r.n} observed=${r.observed.toFixed(3)} PA_bad=${r.paBad.toFixed(3)} kappa=${r.kappa.toFixed(3)} rateA=${r.rateA.toFixed(3)} rateB=${r.rateB.toFixed(3)} gap=${(r.gap * 100).toFixed(2)}pts`);
  }
}

const usage = [
  "usage:",
  "  node scripts/live/grade.ts corpus <runDir...>",
  "  node scripts/live/grade.ts export <runDir...> [--trap <sentence>]",
  "  node scripts/live/grade.ts run --grader A|B <noteId...>",
  "  node scripts/live/grade.ts adjudicate <noteId...>",
  "  node scripts/live/grade.ts agreement <noteId...>",
].join("\n");

async function main(): Promise<void> {
  if (GRADING === "") throw new Error("set UKTUB_GRADING_DIR to the grading output directory (outside the repository)");
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (cmd === "corpus" && rest.length > 0) {
    await cmdCorpus(rest);
  } else if (cmd === "export" && rest.length > 0) {
    const { runDirs, trap } = splitExportArgs(rest);
    if (trap === "" || runDirs.length === 0) throw new Error(usage);
    await cmdExport(runDirs, trap);
  } else if (cmd === "run" && rest[0] === "--grader" && (rest[1] === "A" || rest[1] === "B") && rest.length > 2) {
    await cmdRun(rest[1] as GraderName, rest.slice(2));
  } else if (cmd === "adjudicate" && rest.length > 0) {
    await cmdAdjudicate(rest);
  } else if (cmd === "agreement" && rest.length > 0) {
    cmdAgreement(rest);
  } else {
    throw new Error(usage);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    log(`grade: FAILED: ${(err as Error).message}`);
    process.exit(1);
  });
}
