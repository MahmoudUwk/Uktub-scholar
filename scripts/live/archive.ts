/**
 * Archive a live skills run (`pnpm live:skills`) into docs/benchmarks/skills/ as the proof of what each skill did against a real model.
 * One folder per case: report.md (the contract, the prompt, the tool order, cost, the agent's answer, the artifacts), results.json (the
 * machine-readable verdict) and artifacts/ (the small files the case produced inside the project). The raw evidence of the run stays local
 * under experiments/runs/ (gitignored); nothing in the archive carries a key value or a key name.
 *
 *   node scripts/live/archive.ts <run-dir> [--out docs/benchmarks/skills] [--only id,id] [--label baseline-no-skill] [--private]
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

export interface ArchiveOptions { runDir: string; outRoot: string; only?: string[]; /** Folder suffix for a labelled run, e.g. `baseline-no-skill` (the same case run without its skill). */ label?: string;
  /** The case ran on the owner's own paper: keep the evidence under `<out>/private/` (gitignored); only a content-free summary is committed. */ private?: boolean }

const MAX_ARTIFACT_BYTES = 1_500_000;
const MAX_CASE_BYTES = 6_000_000;

interface CaseResult { id: string; tool: string; verdict: string; elapsedMs: number; contract?: string; detail?: { turn?: string; artifacts?: string[] } & Record<string, unknown>; error?: string; reason?: string }
interface TurnRecord { id: string; prompt: string; final: string; model: string; elapsedMs: number; calls: Array<{ name: string; args?: { path?: string; command?: string } }>; usage?: { input: number; output: number; total: number; costUsd: number; responses: number } }

const slug = (id: string): string => id.replace(/^skill\./, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
const readJsonl = (file: string): TurnRecord[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as TurnRecord) : []);

/** The tool order in one line: a skill's SKILL.md read shows as `read(uktub-figures/SKILL.md)`. */
function toolOrder(t: TurnRecord): string {
  return t.calls.map((c) => {
    const skill = /skills\/([^/]+)\/SKILL\.md/.exec(c.args?.path ?? "");
    if (c.name === "read" && skill) return `read(${skill[1]}/SKILL.md)`;
    if (c.name === "read" || c.name === "write" || c.name === "edit") return `${c.name}(${basename(c.args?.path ?? "?")})`;
    return c.name.replace(/^mcp__uktub_scholar__/, "");
  }).join(" → ");
}

/** Runs recorded before results carried their contract: look it up in the case list by id. */
async function contractOf(id: string): Promise<string | undefined> {
  try {
    const { skillCases } = (await import("./skill-cases.ts")) as { skillCases: Array<{ id: string; contract: string }> };
    return skillCases.find((c) => c.id === id)?.contract;
  } catch {
    return undefined;
  }
}

export async function archiveRun(o: ArchiveOptions): Promise<string[]> {
  const { manifest, results } = JSON.parse(readFileSync(join(o.runDir, "results.json"), "utf8")) as { manifest: Record<string, unknown>; results: CaseResult[] };
  const turns = readJsonl(join(o.runDir, "pi-turns.jsonl"));
  const date = String(manifest.startedAt ?? new Date().toISOString()).slice(0, 10);
  const project = resolve(o.runDir, "project");
  const made: string[] = [];
  for (const r of results) {
    if (o.only && !o.only.includes(r.id)) continue;
    const dir = join(o.private ? join(o.outRoot, "private") : o.outRoot, `${date}-${slug(r.id)}${o.label ? `--${o.label}` : ""}`);
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    // a failed case records no turn; in a run of several cases the last turn is another case's, so only a single-case run may fall back to it
    const turn = turns.find((t) => t.id === r.detail?.turn) ?? (results.length === 1 ? turns.at(-1) : undefined);
    const contract = r.contract ?? (await contractOf(r.id));
    const copied: string[] = [];
    const skipped: string[] = [];
    let total = 0;
    // a case that failed reports no artifact list, but the runner kept the files the agent left under artifacts/<case id>/
    const kept = existsSync(resolve(o.runDir, "artifacts", r.id)) ? readdirSync(resolve(o.runDir, "artifacts", r.id)) : [];
    const listed = r.detail?.artifacts ?? [];
    for (const rel of listed.length > 0 ? listed : kept) {
      // the runner saves each case's artifacts under <run>/artifacts/<case id>/ before the next case resets the project; fall back to the project
      const saved = resolve(o.runDir, "artifacts", r.id, basename(rel));
      const abs = existsSync(saved) ? saved : resolve(project, rel);
      const inside = abs === saved || abs.startsWith(project + sep);
      if (!inside || !existsSync(abs) || !statSync(abs).isFile()) { skipped.push(`${rel} (not a file inside the project)`); continue; }
      const size = statSync(abs).size;
      if (size > MAX_ARTIFACT_BYTES || total + size > MAX_CASE_BYTES) { skipped.push(`${rel} (${Math.round(size / 1024)} KB, over the size cap)`); continue; }
      copyFileSync(abs, join(dir, "artifacts", basename(abs)));
      copied.push(basename(abs));
      total += size;
    }
    const usage = turn?.usage;
    const lines = [
      `# ${r.id}: ${r.verdict}${o.label ? ` (${o.label})` : ""}`,
      "",
      `| | |`,
      `|---|---|`,
      `| Skill | ${r.tool} |`,
      `| Date | ${date} |`,
      `| Model | ${turn?.model ?? "google-vertex/gemini-3.8-flash"} |`,
      `| Commit | \`${String(manifest.commit ?? "").slice(0, 12)}\` plus the working tree \`${String(manifest.workingTreeDiffSha256 ?? "").slice(0, 10)}\` (case list ${String(manifest.skillCasesVersion ?? "")}) |`,
      `| Elapsed | ${Math.round((turn?.elapsedMs ?? r.elapsedMs) / 1000)} s |`,
      ...(usage ? [`| Tokens | ${usage.input} in, ${usage.output} out, ${usage.total} total over ${usage.responses} responses |`, `| Cost | $${usage.costUsd.toFixed(2)} |`] : []),
      "",
      "## Contract",
      "",
      contract ?? "(not recorded)",
      "",
      ...(r.error || r.reason ? ["## Why it did not pass", "", "```", r.error ?? r.reason ?? "", "```", ""] : []),
      ...(turn ? ["## The request", "", `> ${turn.prompt.replace(/\n/g, "\n> ")}`, "", "## What the agent did", "", toolOrder(turn), "", "## The agent's answer", "", turn.final.split("\n").map((l) => `> ${l}`).join("\n"), ""] : []),
      "## Artifacts",
      "",
      ...(copied.length ? copied.map((f) => (/\.(png|jpe?g|svg)$/.test(f) ? `- ![${f}](artifacts/${f})` : `- [${f}](artifacts/${f})`)) : ["(none)"]),
      ...(skipped.length ? ["", `Skipped: ${skipped.join("; ")}.`] : []),
      "",
      "The raw transcript and the working directory of this run are kept locally under `experiments/runs/` (gitignored).",
      "",
    ];
    writeFileSync(join(dir, "report.md"), lines.join("\n"));
    writeFileSync(join(dir, "results.json"), `${JSON.stringify({
      id: r.id, label: o.label, skill: r.tool, verdict: r.verdict, date, commit: manifest.commit, model: turn?.model, elapsedMs: r.elapsedMs, caseListVersion: manifest.skillCasesVersion,
      contract, usage, tools: turn?.calls.map((c) => c.name), artifacts: copied, skipped, error: r.error, reason: r.reason,
    }, null, 2)}\n`);
    made.push(dir);
  }
  writeSummary(o.outRoot);
  writeIndex(o.outRoot);
  return made;
}

/** own-paper-summary.md: verdict, time, cost and number of tool calls of the private cases, nothing from the paper, the prompts or the answers. */
function writeSummary(outRoot: string): void {
  const dir = join(outRoot, "private");
  if (!existsSync(dir)) return;
  const rows: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const f = join(dir, name, "results.json");
    if (!existsSync(f)) continue;
    const r = JSON.parse(readFileSync(f, "utf8")) as { id: string; skill: string; verdict: string; label?: string; model?: string; usage?: { costUsd: number }; elapsedMs: number; tools?: string[] };
    rows.push(`| ${r.id} | ${r.skill} | ${r.verdict} | ${r.model ?? ""} | ${Math.round(r.elapsedMs / 1000)} s | ${r.usage ? `$${r.usage.costUsd.toFixed(2)}` : ""} | ${r.tools ? `${r.tools.length} tool calls` : "not recorded"} | ${r.label ?? ""} |`);
  }
  if (rows.length === 0) return;
  writeFileSync(join(outRoot, "own-paper-summary.md"), [
    "# Skill cases on the owner's own paper: summary",
    "",
    "These live cases (`pnpm live:skills`) ran a real Pi session on `test_papers/` content that is not published here. Their reports quote the paper, so the evidence",
    "(prompt, answer, artifacts) stays in the gitignored `private/` folder next to this file; what is committed is only the verdict, the model, the time, the cost and",
    "the number of tool calls. A `baseline-without-skill` row is the same case with the skill hidden.",
    "",
    "| Case | Skill | Verdict | Model | Time | Cost | Tools | Variant |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"));
}

/** README.md of the archive: one row per archived case, rebuilt from the folders. */
function writeIndex(outRoot: string): void {
  const rows: string[] = [];
  for (const name of readdirSync(outRoot).sort()) {
    const f = join(outRoot, name, "results.json");
    if (!existsSync(f)) continue;
    const r = JSON.parse(readFileSync(f, "utf8")) as { id: string; skill: string; verdict: string; date: string; model?: string; usage?: { costUsd: number }; elapsedMs: number };
    rows.push(`| [${name}](${name}/report.md) | ${r.skill} | ${r.verdict} | ${r.model ?? ""} | ${Math.round(r.elapsedMs / 1000)} s | ${r.usage ? `$${r.usage.costUsd.toFixed(2)}` : ""} |`);
  }
  writeFileSync(join(outRoot, "README.md"), [
    "# Skill benchmarks: proof of what each product skill did",
    "",
    "Each folder is one live case (`pnpm live:skills`): a real Pi session on the model named in its report, in the Docker sandbox, given a task a skill is",
    "for. The case checks the skill was loaded and the artifact is right (files, bytes, extracted data); the folder keeps the request, the order of tools,",
    "the agent's answer and the artifacts it produced. Cases and verdicts are defined in `scripts/live/skill-cases.ts`; how to run them is in",
    "[docs/testing.md](../../testing.md). Archive a run with `node scripts/live/archive.ts <run-dir>`.",
    "",
    ...(existsSync(join(outRoot, "own-paper-summary.md")) ? ["Cases that ran on the owner's own paper quote it, so their evidence stays local; [own-paper-summary.md](own-paper-summary.md) lists their verdicts, time and cost.", ""] : []),
    "A `--baseline-without-skill` folder is the same case with the skill hidden. A `--superseded-...` folder passed the checks of its day and was replaced",
    "after a defect those checks missed; its report says which, and the case now checks for it.",
    "",
    "| Case | Skill | Verdict | Model | Time | Cost |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string): string | undefined => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const runDir = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (runDir === undefined) throw new Error("usage: archive.ts <run-dir> [--out docs/benchmarks/skills] [--only id,id] [--label name] [--private]");
  const outRoot = resolve(flag("--out") ?? join(import.meta.dirname, "../../docs/benchmarks/skills"));
  mkdirSync(outRoot, { recursive: true });
  for (const d of await archiveRun({ runDir: resolve(runDir), outRoot, only: flag("--only")?.split(","), label: flag("--label"), private: args.includes("--private") })) console.log(`archived ${d}`);
}
