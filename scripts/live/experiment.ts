/**
 * One user-simulation iteration (see experiments/README.md).
 *
 *   node scripts/live/experiment.ts <scenario> [--max-turns N]
 *
 * A simulated user (Pi, google-vertex/gemini-3.8-flash, no tools, persona in experiments/simulator.md) converses with the real
 * Uktub agent (Pi + this package, same model) in separate sandbox containers until it reports success or gives up. Then the agent is
 * asked, as the developers, how its tools could serve it better, and the simulator writes an assessment. The report keeps measured
 * facts (Part A) apart from model opinions (Parts B and C). A fresh-session turn quota limited on the primary is rerun once on the labelled fallback model (see docs/testing.md); Pi retries transient provider errors (up to 6, bounded by a 120 s HTTP idle timeout) and every retry is logged and recorded on the turn.
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { startAgent, TurnBlocked, type ToolEnd, type Turn } from "./agent.ts";
import { Blocked } from "./cases.ts";
import { createEnv } from "./env.ts";
import { redact } from "./redact.ts";

export const EXPERIMENT_POLICY = {
  maxTurns: 12, // client policy: user turns before the run ends as "budget"
  wallClockMs: 3 * 60 * 60 * 1000, // client policy: three hours per iteration
  slowGapMs: 60_000, // a model/tool gap longer than this is reported as a slow step
  viewManuscriptChars: 6000, // what the simulated user can read of the manuscript per turn
};

const scenarioName = process.argv[2];
if (scenarioName === undefined || scenarioName.startsWith("--")) throw new Error("usage: experiment.ts <scenario> [--max-turns N]");
const mt = process.argv.indexOf("--max-turns");
const maxTurns = mt > 0 ? Number(process.argv[mt + 1]) : EXPERIMENT_POLICY.maxTurns;

const repo = resolve(import.meta.dirname, "../..");
const expRoot = join(repo, "experiments");
const scenarioFile = join(expRoot, "scenarios", `${scenarioName}.md`);
if (!existsSync(scenarioFile)) throw new Error(`no scenario ${scenarioFile}`);
const scenarioText = readFileSync(scenarioFile, "utf8");
const section = (name: string): string => new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(scenarioText)?.[1]?.trim() ?? "";
const prompt = section("Prompt");
const success = section("Success");
if (!prompt || !success) throw new Error("a scenario needs ## Prompt and ## Success sections");
const persona = readFileSync(join(expRoot, "simulator.md"), "utf8");

const runsDir = join(expRoot, "runs", scenarioName);
const iteration = (existsSync(runsDir) ? readdirSync(runsDir).filter((d) => /^iter-\d+$/.test(d)).length : 0) + 1;
const iterDir = join(runsDir, `iter-${String(iteration).padStart(2, "0")}`);
mkdirSync(iterDir, { recursive: true });
// Client policy for long conversations (acceptance keeps Pi defaults and no retry): Vertex streams sometimes stall for minutes and then die with
// `fetch failed`; cut a request that is silent for 2 minutes and let Pi retry it. Every retry is logged and reported.
const PI_SETTINGS = { httpIdleTimeoutMs: 120_000, retry: { enabled: true, maxRetries: 6, baseDelayMs: 2000, maxAgentDelayMs: 30_000 } };
const env = createEnv(join(iterDir, "evidence"), { piSettings: PI_SETTINGS });
const { log } = env;
const t0 = Date.now();

// ── the two agents: the tested Uktub agent and the tool-less user simulator, each in its own container ───────────────────
const simProject = join(env.out, "sim-project");
const simAgentDir = join(env.out, "sim-pi-agent");
mkdirSync(simProject);
mkdirSync(simAgentDir);
writeFileSync(join(simAgentDir, "settings.json"), JSON.stringify(PI_SETTINGS));
writeFileSync(join(simAgentDir, "auth.json"), "{}");
const uk = await startAgent(env.base("uktub"), env.out, log, { label: "uktub", autoRetry: true });
const sim = await startAgent(env.base("sim", {}, { projectDir: simProject, agentDir: simAgentDir }), env.out, log, {
  label: "simulator",
  autoRetry: true,
  piArgs: ["--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--system-prompt", persona],
});

// ── what a real user sees of the project folder after each reply ─────────────────────────────────────────────────────────
function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === ".registry" || e.name === "node_modules") return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [relative(base, p)];
  });
}
let lastManuscript = "";
function projectView(): string {
  const files = walk(env.project).filter((f) => !f.startsWith("config/")).map((f) => `${f} (${statSync(join(env.project, f)).size} bytes)`);
  const tex = walk(env.project).filter((f) => f.endsWith(".tex")).sort();
  const body = tex.map((f) => `--- ${f} ---\n${readFileSync(join(env.project, f), "utf8")}`).join("\n").slice(0, EXPERIMENT_POLICY.viewManuscriptChars);
  const changed = body !== lastManuscript;
  lastManuscript = body;
  return `[Project folder view]\nFiles:\n${files.length ? files.map((f) => `- ${f}`).join("\n") : "(empty)"}\n${tex.length ? (changed ? `\nManuscript text now:\n${body}` : "\n(manuscript unchanged since your last view)") : "\n(no LaTeX manuscript yet)"}`;
}

// ── the conversation ─────────────────────────────────────────────────────────────────────────────────────────────────────
interface Exchange { n: number; sim: Turn; simStatus: string; simMessage: string; simNote: string; formatOk: boolean; agent?: Turn; view?: string }
const exchanges: Exchange[] = [];
const parse = (raw: string) => {
  const tag = (t: string): string => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i").exec(raw)?.[1]?.trim() ?? "";
  const status = tag("status").toLowerCase();
  return { status: ["continue", "success", "give_up"].includes(status) ? status : "", message: tag("message"), note: tag("note") };
};
let stopReason = "budget";
let simInput = `This is the start. Your request to the assistant (send it as the user would):\n\n${prompt}\n\nSuccess criteria you hold the assistant to (private):\n${success}`;
try {
  for (let n = 1; n <= maxTurns; n++) {
    if (Date.now() - t0 > EXPERIMENT_POLICY.wallClockMs) { stopReason = "wall-clock budget"; break; }
    const simTurn = await sim.agent.turn(`sim-${n}`, simInput, { newSession: n === 1 });
    const p = parse(simTurn.final);
    const ex: Exchange = { n, sim: simTurn, simStatus: p.status || "continue", simMessage: p.message, simNote: p.note, formatOk: p.status !== "" };
    exchanges.push(ex);
    if (n > 1 && (p.status === "success" || p.status === "give_up")) { stopReason = p.status; break; }
    const say = p.message || (n === 1 ? prompt : "");
    if (!say) { stopReason = "simulator sent no message"; break; }
    try {
      ex.agent = await uk.agent.turn(`agent-${n}`, say, { newSession: n === 1 });
    } catch (e) {
      if (e instanceof TurnBlocked) { ex.agent = e.turn; ex.view = projectView(); } // keep what the cut-off turn did: measurements stay honest
      throw e;
    }
    ex.view = projectView();
    simInput = `Assistant replied:\n${ex.agent.final}\n\n${ex.view}`;
  }
} catch (e) {
  stopReason = e instanceof Blocked ? `blocked: ${e.message}` : `error: ${(e as Error).message}`;
  log(`EXPERIMENT STOPPED ${stopReason}`);
}

// ── ask the agent, as the developers, how its tools could serve it better ───────────────────────────────────────────────
const FEEDBACK_PROMPT = [
  "This message is from the development team, not the user. The user conversation is over. We are improving the tools you used here (search_papers, paper_registry, search_passages, verify_claim, compile_document) and want your account of working with them.",
  "Please give: (1) every point where a tool result, parameter, schema, description or refusal message confused you, cost extra calls or forced a workaround — name the call; (2) what you wish a tool returned or accepted; (3) which of your calls were wasteful or unnecessary and why; (4) one ranked list of the tool changes that would help you most.",
  "Be specific and honest. If a tool worked well, say so. Do not invent problems.",
].join("\n\n");
let feedback = "";
try { feedback = (await uk.agent.turn("feedback", FEEDBACK_PROMPT, { newSession: false })).final; } catch (e) { feedback = `(not obtained: ${(e as Error).message})`; }

// ── deterministic measurements (facts) ───────────────────────────────────────────────────────────────────────────────────
const agentTurns = exchanges.flatMap((x) => (x.agent ? [x.agent] : []));
const bare = (n: string): string => n.replace("mcp__uktub_scholar__", "");
const label = (c: { name: string; args: any }): string => `${bare(c.name)}${c.args?.action ? `:${c.args.action}` : ""}`;
const allCalls = agentTurns.flatMap((t) => t.calls.filter((c) => c.name.startsWith("mcp__uktub_scholar__")));
const allEnds = agentTurns.flatMap((t) => t.ends.filter((e) => e.name.startsWith("mcp__uktub_scholar__")));
const endOf = new Map<string, ToolEnd>(allEnds.map((e) => [e.toolCallId, e]));
const byTool: Record<string, number> = {};
for (const c of allCalls) byTool[label(c)] = (byTool[label(c)] ?? 0) + 1;
const refusalOf = (e: ToolEnd): string | undefined => /^Refused: ([A-Z_]+)/.exec(e.text)?.[1] ?? (e.isError ? "TOOL_ERROR" : undefined);
const refusals = allEnds.flatMap((e) => { const code = refusalOf(e); return code ? [{ tool: bare(e.name), code, message: e.text.replace(/\s+/g, " ").slice(0, 220), call: allCalls.find((c) => c.id === e.toolCallId)?.args }] : []; });
// A repeat is the same call with the same arguments and NOTHING changed in between (an edit-compile loop is work, not repetition): the key
// carries a state version that every write, edit, shell command or registry change advances.
const changesState = (c: { name: string; args: any }): boolean => ["write", "edit", "bash"].includes(c.name) || (bare(c.name) === "paper_registry" && c.args?.action !== "read");
const seen = new Map<string, number>();
const repeats: Array<{ tool: string; args: unknown; times: number }> = [];
let stateVersion = 0;
for (const c of agentTurns.flatMap((t) => t.calls)) {
  if (changesState(c)) { stateVersion += 1; continue; }
  if (!c.name.startsWith("mcp__uktub_scholar__")) continue;
  const k = `${stateVersion}|${c.name}|${JSON.stringify(c.args)}`;
  seen.set(k, (seen.get(k) ?? 0) + 1);
}
for (const [k, times] of seen) if (times > 1) { const [, tool, args] = k.split("|") as [string, string, string]; repeats.push({ tool: bare(tool), args: JSON.parse(args), times }); }
const retriesAfterRefusal = allCalls.filter((c, i) => i > 0 && allCalls[i - 1]?.name === c.name && refusalOf(endOf.get(allCalls[i - 1]!.id) ?? ({ text: "", isError: false } as ToolEnd))).length;
const toolMs = (name?: string): number => allCalls.filter((c) => name === undefined || bare(c.name) === name).reduce((a, c) => a + Math.max(0, (endOf.get(c.id)?.t ?? c.t) - c.t), 0);
const slow: Array<{ turn: string; kind: string; ms: number; detail: string }> = [];
for (const t of agentTurns) {
  const evs = [...t.calls.map((c) => ({ at: c.t, kind: "call" as const, c })), ...t.ends.map((e) => ({ at: e.t, kind: "end" as const, e }))].sort((a, b) => a.at - b.at);
  for (let i = 1; i < evs.length; i++) {
    const gap = (evs[i] as { at: number }).at - (evs[i - 1] as { at: number }).at;
    if (gap > EXPERIMENT_POLICY.slowGapMs && evs[i - 1]!.kind === "end") slow.push({ turn: t.id, kind: "model gap after a tool result", ms: gap, detail: "next tool call started late" });
  }
  for (const c of t.calls) { const d = (endOf.get(c.id)?.t ?? c.t) - c.t; if (d > EXPERIMENT_POLICY.slowGapMs) slow.push({ turn: t.id, kind: "slow tool", ms: d, detail: label(c) }); }
}
const providerRetries = agentTurns.flatMap((t) => t.retries.map((r) => ({ turn: t.id, ...r })));
const usage = (ts: Turn[]) => ({ responses: ts.reduce((a, t) => a + t.usage.responses, 0), inputTokens: ts.reduce((a, t) => a + t.usage.input, 0), outputTokens: ts.reduce((a, t) => a + t.usage.output, 0), reasoningTokens: ts.reduce((a, t) => a + t.usage.reasoning, 0), costUsd: Number(ts.reduce((a, t) => a + t.usage.costUsd, 0).toFixed(4)) });

// registry + deliverables as the user ended up with them
const mcp = await env.openSession("final");
const registry = await mcp.call("paper_registry", { action: "read", fields: ["title", "authors", "venue", "source"] }).catch(() => undefined);
await mcp.close().catch(() => undefined);
const hasSource = (s: unknown): boolean => typeof s === "object" && s !== null && (s as { status?: string }).status !== "metadata_only";
const records: Array<{ doi: string; citekey: string; title: string; source?: unknown }> = registry?.structuredContent?.records ?? [];
const deliver = join(iterDir, "deliverables");
mkdirSync(deliver, { recursive: true });
for (const f of walk(env.project).filter((x) => /^(manuscript|refs)\//.test(x) || /^build\/.*\.pdf$/.test(x))) { mkdirSync(join(deliver, f, ".."), { recursive: true }); copyFileSync(join(env.project, f), join(deliver, f)); }
writeFileSync(join(deliver, "registry.json"), JSON.stringify(records, null, 2));
const texFiles = walk(env.project).filter((f) => f.endsWith(".tex"));
const tex = texFiles.map((f) => readFileSync(join(env.project, f), "utf8")).join("\n");
const cited = [...new Set([...tex.matchAll(/\\(?:cite\w*|nocite)\{([^}]+)\}/g)].flatMap((m) => (m[1] as string).split(",").map((k) => k.trim())))];
const keys = new Set(records.map((r) => r.citekey));
const pdfs = walk(env.project).filter((f) => /^build\/.*\.pdf$/.test(f));
const newestTex = Math.max(0, ...texFiles.map((f) => statSync(join(env.project, f)).mtimeMs));
const newestPdf = Math.max(0, ...pdfs.map((f) => statSync(join(env.project, f)).mtimeMs));
const POINTER_G = /10\.[^\s@"'`)\]]+@[0-9a-f]{16}#\d+-\d+/g;
const issued = new Set(allEnds.flatMap((e) => e.text.match(POINTER_G) ?? []));
const claimedPointers = agentTurns.flatMap((t) => t.final.match(POINTER_G) ?? []);
const warnedProviders = [...new Set(allEnds.flatMap((e) => [...e.text.matchAll(/^warning: (\S+) —/gm)].map((m) => m[1] as string)))];
const replies = agentTurns.map((t) => t.final).join("\n");
const checks: Array<{ id: string; ok: boolean; detail: string }> = [
  { id: "stop-signal", ok: stopReason === "success" || stopReason === "give_up", detail: `simulator ended the conversation with: ${stopReason}` },
  { id: "all-turns-completed", ok: !stopReason.startsWith("blocked") && !stopReason.startsWith("error"), detail: stopReason },
  { id: "citations-in-registry", ok: texFiles.length > 0 && cited.length > 0 && cited.every((k) => keys.has(k)), detail: `${cited.length} cited, ${cited.filter((k) => !keys.has(k)).length} not in the registry${cited.some((k) => !keys.has(k)) ? `: ${cited.filter((k) => !keys.has(k)).join(", ")}` : ""}` },
  { id: "bibliography-matches-registry", ok: existsSync(join(env.project, "refs/references.bib")) && [...readFileSync(join(env.project, "refs/references.bib"), "utf8").matchAll(/^@\w+\{([^,\s]+),/gm)].every((m) => keys.has(m[1] as string)), detail: "every bibliography key is a registered citekey" },
  { id: "compiled-after-last-edit", ok: pdfs.length > 0 && newestPdf >= newestTex, detail: `${pdfs.length} pdf(s); newest pdf ${newestPdf >= newestTex ? "is not older than" : "is OLDER than"} the newest tex` },
  { id: "pointers-issued-by-tools", ok: claimedPointers.every((p) => issued.has(p)), detail: `${claimedPointers.length} pointer(s) in replies, ${claimedPointers.filter((p) => !issued.has(p)).length} not issued by any tool result` },
  { id: "provider-warnings-disclosed", ok: warnedProviders.every((p) => new RegExp(p.replace(/-/g, "[- ]?"), "i").test(replies)), detail: warnedProviders.length ? `providers that warned: ${warnedProviders.join(", ")}` : "no provider warnings occurred (path not exercised)" },
  { id: "evidence-tools-used", ok: (byTool["verify_claim"] ?? 0) + (byTool["search_passages"] ?? 0) > 0, detail: `verify_claim ${byTool["verify_claim"] ?? 0}, search_passages ${byTool["search_passages"] ?? 0}` },
  { id: "no-unrequested-removal", ok: !(byTool["paper_registry:remove"] ?? 0), detail: `paper_registry:remove calls: ${byTool["paper_registry:remove"] ?? 0}` },
];
const metrics = {
  fallbackTurns: { uktub: uk.agent.fallbackTurns, simulator: sim.agent.fallbackTurns },
  scenario: scenarioName,
  iteration,
  outcome: stopReason,
  userTurns: exchanges.length,
  wallMs: Date.now() - t0,
  agent: { toolCalls: allCalls.length, byTool, refusalsOrErrors: refusals.length, refusals, retriesAfterRefusal, providerRetries, repeatedIdenticalCalls: repeats, toolMs: toolMs(), toolMsByTool: Object.fromEntries(Object.keys(byTool).map((k) => [k.split(":")[0], toolMs(k.split(":")[0])])), slowSteps: slow, usage: usage(agentTurns), perTurn: agentTurns.map((t) => ({ id: t.id, ms: t.elapsedMs, calls: t.calls.length, inputTokens: t.usage.input, outputTokens: t.usage.output })) },
  simulator: { usage: usage(exchanges.map((x) => x.sim)), formatFailures: exchanges.filter((x) => !x.formatOk).length },
  registry: { papers: records.length, withSource: records.filter((r) => hasSource(r.source)).length },
  deliverable: { texFiles, citations: cited.length, pdfs },
  checks,
};
writeFileSync(join(iterDir, "metrics.json"), JSON.stringify(metrics, null, 2));

// ── the simulator's assessment ──────────────────────────────────────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.ok);
const REPORT_PROMPT = [
  "The session is over. Now write a report as an evaluator of the assistant's work, in Markdown. Use exactly these section headings (## Verdict, ## What worked, ## Where the assistant struggled, ## Quality and honesty, ## Efficiency, ## Recommendations) and fill each as described.",
  "Verdict: success, partial or failed for the user's request, and why, in 3-5 sentences. What worked: specific, with evidence from the conversation. Where the assistant struggled: each item says what happened, which turn, and what it cost (extra calls, wrong turns, waiting). Quality and honesty: grounding of claims, invented or unsupported statements, what it admitted it could not do. Efficiency: wasted steps, retries, loops, slow stretches.",
  "Recommendations: a ranked list; each item gives the Area (tool schema | tool description | refusal/hint text | agent rules/prompt | harness | provider), the concrete change, the evidence (turn), and the expected benefit.",
  "Use only what you saw in the conversation, the measured facts and the assistant's own feedback below. The measured facts are authoritative; where they contradict your impression, trust them. Do not invent.",
  `\nMEASURED FACTS (computed by the harness, not opinions):\n${JSON.stringify({ outcome: stopReason, userTurns: metrics.userTurns, toolCalls: allCalls.length, byTool, refusalsOrErrors: refusals.map((r) => `${r.tool}:${r.code}`), repeatedIdenticalCalls: repeats.length, slowSteps: slow.length, costUsd: metrics.agent.usage.costUsd, failedChecks: failed.map((c) => `${c.id}: ${c.detail}`), registryPapers: records.length }, null, 1)}`,
  `\nTHE ASSISTANT'S OWN FEEDBACK ON ITS TOOLS (asked by the developers after the conversation):\n${feedback}`,
].join("\n");
let assessment = "";
try { assessment = (await sim.agent.turn("report", REPORT_PROMPT, { newSession: false })).final; } catch (e) { assessment = `(not obtained: ${(e as Error).message})`; }
await uk.stop();
await sim.stop();

// ── report ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const pct = (n: number, d: number): string => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
const conv = exchanges.map((x) => [
  `### Turn ${x.n}`,
  `**User (simulated)** — status \`${x.simStatus}\`${x.formatOk ? "" : " (format not followed)"}:`, x.simMessage ? `> ${x.simMessage.replace(/\n/g, "\n> ")}` : "_(no message)_",
  `_Simulator note:_ ${x.simNote || "(none)"}`,
  x.agent ? `**Uktub agent** (${Math.round(x.agent.elapsedMs / 1000)} s, ${x.agent.calls.length} tool call(s): ${x.agent.calls.map(label).join(", ") || "none"})${x.agent.incomplete ? ` — **INCOMPLETE: ${x.agent.incomplete}**` : ""}:\n\n${x.agent.final || "_(no final answer)_"}` : "",
].join("\n\n")).join("\n\n---\n\n");
writeFileSync(join(iterDir, "conversation.md"), redact(`# Conversation — ${scenarioName} iter-${iteration}\n\n${conv}\n\n---\n\n### Developer feedback request (to the agent)\n\n${feedback}\n`));
const table = (rows: Array<[string, string | number]>): string => `| | |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join("\n")}`;
const report = `# Experiment report — ${scenarioName} / iteration ${iteration}

Outcome: **${stopReason}** · ${exchanges.length} user turn(s) · ${Math.round(metrics.wallMs / 60000)} min · agent cost $${metrics.agent.usage.costUsd} · ${checks.filter((c) => c.ok).length}/${checks.length} deterministic checks passed

Model (both agents): google-vertex/gemini-3.8-flash via Pi's Vertex client. ${uk.agent.fallbackTurns.length > 0 || sim.agent.fallbackTurns.length > 0 ? `QUOTA FALLBACK: turns on google-vertex/gemini-3.5-flash-lite after a 429 on 3.8: uktub [${uk.agent.fallbackTurns.join(", ")}], simulator [${sim.agent.fallbackTurns.join(", ")}]. ` : ""}Sandbox: Docker image \`uktub-scholar-sandbox\`. Engine on CPU. Evidence: \`evidence/\` (git-ignored). Scenario: \`experiments/scenarios/${scenarioName}.md\` (sha256 ${env.sha(scenarioFile).slice(0, 12)}); simulator persona sha256 ${env.sha(join(expRoot, "simulator.md")).slice(0, 12)}.

## Part A — Measured facts (deterministic)

### Deterministic checks
${checks.map((c) => `- ${c.ok ? "PASS" : "**FAIL**"} \`${c.id}\` — ${c.detail}`).join("\n")}

### Tool use
${table([["tool calls", allCalls.length], ["calls by tool", Object.entries(byTool).map(([k, v]) => `${k}×${v}`).join(", ") || "none"], ["refusals / tool errors", `${refusals.length} (${pct(refusals.length, allCalls.length)} of calls)`], ["retries immediately after a refusal of the same tool", retriesAfterRefusal], ["provider retries performed by Pi (transient failures, visible)", providerRetries.length ? providerRetries.map((r) => `${r.turn}: ${r.errorMessage.slice(0, 80)}`).join("; ") : "none"], ["identical calls repeated", repeats.length ? repeats.map((r) => `${r.tool}×${r.times}`).join(", ") : "none"], ["tool time", `${Math.round(toolMs() / 1000)} s (${Object.entries(metrics.agent.toolMsByTool).map(([k, v]) => `${k} ${Math.round((v as number) / 1000)} s`).join(", ")})`], [`slow steps (> ${EXPERIMENT_POLICY.slowGapMs / 1000} s)`, slow.length ? slow.map((s) => `${s.turn}: ${s.kind} ${Math.round(s.ms / 1000)} s (${s.detail})`).join("; ") : "none"]])}

### Refusals and errors
${refusals.length ? refusals.map((r) => `- \`${r.tool}\` ${r.code}: ${r.message} — args ${JSON.stringify(r.call).slice(0, 160)}`).join("\n") : "none"}

### Model usage
${table([["agent responses", metrics.agent.usage.responses], ["agent input / output / reasoning tokens", `${metrics.agent.usage.inputTokens} / ${metrics.agent.usage.outputTokens} / ${metrics.agent.usage.reasoningTokens}`], ["agent cost (reported by the provider client)", `$${metrics.agent.usage.costUsd}`], ["simulator responses / cost", `${metrics.simulator.usage.responses} / $${metrics.simulator.usage.costUsd}`], ["simulator format failures", metrics.simulator.formatFailures]])}

### Result
${table([["registered papers", records.length], [`papers with a usable source (of ${records.length})`, metrics.registry.withSource], ["manuscript files", texFiles.join(", ") || "none"], ["citations in the manuscript", cited.length], ["pdf", pdfs.join(", ") || "none"]])}

## Part B — The simulated user's assessment (opinion)

${assessment}

## Part C — The Uktub agent's own feedback on its tools (opinion, asked by the developers)

${feedback}

---
Conversation: \`conversation.md\` · measurements: \`metrics.json\` · deliverables: \`deliverables/\`
`;
writeFileSync(join(iterDir, "report.md"), redact(report));
appendFileSync(join(runsDir, "index.md"), `- iter-${String(iteration).padStart(2, "0")} — ${stopReason}; ${checks.filter((c) => c.ok).length}/${checks.length} checks; ${exchanges.length} turns; ${allCalls.length} tool calls; ${refusals.length} refusals; $${metrics.agent.usage.costUsd}\n`);
writeFileSync(join(env.out, "manifest.json"), JSON.stringify(env.manifest({ scenario: scenarioName, iteration, scenarioSha256: env.sha(scenarioFile), simulatorSha256: env.sha(join(expRoot, "simulator.md")), experimentSha256: env.sha(import.meta.filename), agentDriverSha256: env.sha(join(import.meta.dirname, "agent.ts")), model: "google-vertex/gemini-3.8-flash (both agents; Vertex client, ADC; no fallback)", vertexProject: env.gcpProject, policy: { ...EXPERIMENT_POLICY, piSettings: PI_SETTINGS, piAutoRetry: "on for experiments (transient provider failures; every retry logged and reported); off for acceptance" } }), null, 2));
log(`EXPERIMENT COMPLETE iter-${iteration}: ${stopReason}; report ${join(iterDir, "report.md")}`);
process.exitCode = failed.length === 0 && stopReason === "success" ? 0 : 1;
