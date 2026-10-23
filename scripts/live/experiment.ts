/**
 * One measured iteration (see experiments/README.md).
 *
 *   node scripts/live/experiment.ts <scenario> [--max-turns N] [--simulated-window TOKENS] [--arm A|B1|B2|sections|no-gate] [--user scripted|simulator] [--assistant-model provider/id] [--verify-engine eos|hosted|hosted-units]
 *
 * The user is scripted by default (PLAN §4.4: a deterministic state machine on file state reading ## Request,
 * ## Revision and ## Nudge from the scenario). `--user simulator` keeps the old path: a simulated user
 * (Pi, google-vertex/gemini-3.8-flash, no tools, persona in experiments/simulator.md) converses with the real
 * Uktub agent (Pi + this package, same model) in separate sandbox containers until it reports success or gives up. Then the agent is
 * asked, as the developers, how its tools could serve it better, and the simulator writes an assessment. The report keeps measured
 * facts (Part A) apart from model opinions (Parts B and C). A fresh-session turn quota limited on the primary is rerun once on the labelled fallback model (see docs/testing.md); Pi retries transient provider errors (up to 6, bounded by a 120 s HTTP idle timeout) and every retry is logged and recorded on the turn.
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { AGENT_POLICY, FALLBACK_MODEL, MODEL, formatModel, parseModelSetting, startAgent, TurnBlocked, type ToolEnd, type Turn } from "./agent.ts";
import { annotatedUsageOf, behaviorOf, childUsageOf, passagesAfterLastSection, simulatedWindowSettings, slowScopeOf, slowStepsOf, totalCostUsd, writeSectionDrafts } from "./behavior.ts";
import { Blocked } from "./cases.ts";
import { createEnv, assistantSecretsForProvider, usesHostedEngine, verifyEngineEnv } from "./env.ts";
import { walkFiles } from "./files.ts";
import { GRADER_KEY_NAMES, providerKeys, VERIFY_API_KEY_ENV, VERIFY_KEY_NAMES, verifySecrets } from "./keys.ts";
import { redact, registerSecrets } from "./redact.ts";
import { nextScriptedMessage, parseScriptedTexts, pdfIsCurrent, texEditedSince } from "./scripted-user.ts";
import { gitTreeHash, validityRecord } from "./validity.ts";
import { activityDigest, armSpec, channelText, fullView, legacyView, parseSimulatorReply, type ViewPolicy } from "./sim-view.ts";
import { renderFull } from "../../src/core/provenance/render.ts";
import { runProvenance } from "../../src/core/provenance/run.ts";
import {
  checkEvidenceToolsUsed,
  checkNoUnrequestedRemoval,
  checkProviderWarningsDisclosed,
  checkTierBibliography,
  checkTierCitations,
  checkTierFigures,
  checkTierPdfCurrent,
  checkTierPointers,
  checkTierProseVerifiedOrLabelled,
  collectCompileInputs,
  countSources,
  extractVerifyHits,
  isConfinedFile,
  mergeRegistryPages,
  parseScenarioSections,
  provenanceCitedKeys,
  readTierPaperTexts,
  resolveExpectedEntry,
  tierReport,
  type Check,
  type RegistryRecord,
  type TierProvenanceDoc,
} from "./deliverable-checks.ts";

export const EXPERIMENT_POLICY = {
  maxTurns: 12, // client policy: user turns before the run ends as "budget"
  wallClockMs: 3 * 60 * 60 * 1000, // client policy: three hours per iteration
  slowGapMs: 60_000, // a model/tool gap longer than this is reported as a slow step
  viewManuscriptChars: 6000, // what the simulated user can read of the manuscript per turn (arm A and runs without --arm)
  fullManuscriptChars: 60000, // arms B1 and B2: the whole manuscript, with any cut stated
  evidenceTableChars: 8000, // arms B1 and B2: evidence/claims.json
};
/** The real window of both agent models (pi-ai's google-vertex model data); `--simulated-window` is checked against what Pi reports at start. */
const MODEL_WINDOW_TOKENS = 1_048_576;

const scenarioName = process.argv[2];
if (scenarioName === undefined || scenarioName.startsWith("--")) throw new Error("usage: experiment.ts <scenario> [--max-turns N] [--simulated-window TOKENS] [--arm A|B1|B2|sections|no-gate] [--user scripted|simulator] [--assistant-model provider/id] [--verify-engine eos|hosted|hosted-units] [--turn-max-minutes N] [--pilot]");
/** A harness shakedown run: labelled PILOT in the metrics, manifest and index, and never analysed (PLAN §1). */
const pilot = process.argv.includes("--pilot");
const um = process.argv.indexOf("--user");
const userMode = um > 0 ? String(process.argv[um + 1]) : "scripted";
if (userMode !== "scripted" && userMode !== "simulator") throw new Error(`--user must be scripted|simulator, got ${JSON.stringify(userMode)}`);
const mm = process.argv.indexOf("--assistant-model");
const assistantModel = parseModelSetting(mm > 0 ? String(process.argv[mm + 1]) : formatModel(MODEL));
const assistantModelId = formatModel(assistantModel);
// The verify engine the assistant's sandbox uses (default `eos`: the product default stands). `hosted` points the
// sandbox at the hosted decision endpoint and forwards its key; anything else is a harness error, never a guess.
const ve = process.argv.indexOf("--verify-engine");
const verifyEngine = ve > 0 ? String(process.argv[ve + 1]) : "eos";
const assistantVerifyEnv = verifyEngineEnv(verifyEngine);
const mt = process.argv.indexOf("--max-turns");
const maxTurns = mt > 0 ? Number(process.argv[mt + 1]) : EXPERIMENT_POLICY.maxTurns;
// Client policy: a whole first draft runs inside one user turn, and a large document needs more than the default hard cap
// (a 38-paper review hit 90 min, 2026-10-18). The idle guard still ends a silent turn; the iteration wall clock still bounds the run.
const tm = process.argv.indexOf("--turn-max-minutes");
if (tm > 0) {
  const minutes = Number(process.argv[tm + 1]);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("--turn-max-minutes needs a positive number");
  AGENT_POLICY.turnMaxMs = Math.min(minutes * 60_000, EXPERIMENT_POLICY.wallClockMs);
  console.log(`turn hard cap: ${AGENT_POLICY.turnMaxMs / 60_000} min (--turn-max-minutes)`);
}
// An ablation, labelled in the manifest, the report and the index: Pi compacts as if the agent's window were this size. Validated before any run directory exists.
const sw = process.argv.indexOf("--simulated-window");
const simulatedWindow = sw > 0 ? Number(process.argv[sw + 1]) : undefined;
const windowSettings = simulatedWindow === undefined ? {} : simulatedWindowSettings([assistantModelId, `${FALLBACK_MODEL.provider}/${FALLBACK_MODEL.id}`], MODEL_WINDOW_TOKENS, simulatedWindow);

// The visibility A/B (docs/DECISIONS.md): an arm names the reviewer's observation channel and whether the assistant's compile result carries
// the provenance summary. Validated before any run directory exists. Without --arm a run is as before (legacy channel, old simulator spec).
const am = process.argv.indexOf("--arm");
const arm = am > 0 ? armSpec(String(process.argv[am + 1])) : undefined;
const VIEW_POLICY: ViewPolicy = { legacyChars: EXPERIMENT_POLICY.viewManuscriptChars, fullManuscriptChars: EXPERIMENT_POLICY.fullManuscriptChars, evidenceTableChars: EXPERIMENT_POLICY.evidenceTableChars };

const repo = resolve(import.meta.dirname, "../..");
const expRoot = join(repo, "experiments");
const scenarioFile = join(expRoot, "scenarios", `${scenarioName}.md`);
// Secrets the assistant sandbox needs beyond the provider keys, read shell-then-.env like every other harness key
// (values never logged; registered for redaction below): the hosted verify key for the hosted engine (renamed for the sandbox)
// and OPENCODE_API_KEY for an opencode-go assistant. Missing keys are clear errors, never silent fallbacks.
const shellEnv = process.env as Record<string, string | undefined>;
const dotenvText = existsSync(join(repo, ".env")) ? readFileSync(join(repo, ".env"), "utf8") : null;
const assistantSecrets: Record<string, string> = {
  ...assistantSecretsForProvider(assistantModel.provider, (n) => providerKeys(shellEnv, dotenvText, GRADER_KEY_NAMES)[n]),
};
if (usesHostedEngine(verifyEngine)) {
  const got = verifySecrets(providerKeys(shellEnv, dotenvText, VERIFY_KEY_NAMES));
  if (got[VERIFY_API_KEY_ENV] === undefined) throw new Error(`BLOCKED: --verify-engine ${verifyEngine} needs VLLM_decision_API (shell or .env); not falling back to another engine`);
  Object.assign(assistantSecrets, got);
}
registerSecrets(assistantSecrets);
if (!existsSync(scenarioFile)) throw new Error(`no scenario ${scenarioFile}`);
const scenarioText = readFileSync(scenarioFile, "utf8");
const section = (name: string): string => new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(scenarioText)?.[1]?.trim() ?? "";
const prompt = section("Prompt");
const success = section("Success");
if (!prompt || !success) throw new Error("a scenario needs ## Prompt and ## Success sections");
const personaFile = join(expRoot, arm === undefined ? "simulator.md" : "simulator-v2.md");
const persona = readFileSync(personaFile, "utf8");

const runsDir = join(expRoot, "runs", scenarioName);
const iteration = (existsSync(runsDir) ? readdirSync(runsDir).filter((d) => /^iter-\d+$/.test(d)).length : 0) + 1;
const iterDir = join(runsDir, `iter-${String(iteration).padStart(2, "0")}`);
mkdirSync(iterDir, { recursive: true });
// Client policy for long conversations (acceptance keeps Pi defaults and no retry): Vertex streams sometimes stall for minutes and then die with
// `fetch failed`; cut a request that is silent for 2 minutes and let Pi retry it. Every retry is logged and reported.
const PI_SETTINGS = { httpIdleTimeoutMs: 120_000, retry: { enabled: true, maxRetries: 6, baseDelayMs: 2000, maxAgentDelayMs: 30_000 } };
const env = createEnv(join(iterDir, "evidence"), { piSettings: { ...PI_SETTINGS, ...windowSettings }, assistantSecrets });
const { log } = env;
const t0 = Date.now();

// ── the two agents: the tested Uktub agent and the tool-less user simulator, each in its own container ───────────────────
const simProject = join(env.out, "sim-project");
const simAgentDir = join(env.out, "sim-pi-agent");
mkdirSync(simProject);
mkdirSync(simAgentDir);
writeFileSync(join(simAgentDir, "settings.json"), JSON.stringify(PI_SETTINGS));
writeFileSync(join(simAgentDir, "auth.json"), "{}");
const uk = await startAgent(env.base("uktub", { ...assistantVerifyEnv, ...(arm !== undefined && !arm.agentProvenance ? { UKTUB_PROVENANCE: "off" } : {}), ...(arm?.arm === "sections" ? { UKTUB_SECTION_WRITER: "on" } : {}), ...(arm?.arm === "no-gate" ? { UKTUB_COMPLETION_GATE: "off" } : {}) }), env.out, log, {
  label: "uktub",
  autoRetry: true,
  model: assistantModel,
});
if (simulatedWindow !== undefined && assistantModelId === formatModel(MODEL) && uk.agent.contextWindow !== MODEL_WINDOW_TOKENS) throw new Error(`Pi reports a ${uk.agent.contextWindow}-token window for the agent model, not ${MODEL_WINDOW_TOKENS}: the simulated window would be wrong`);
if (simulatedWindow !== undefined && assistantModelId !== formatModel(MODEL)) log(`SIMULATED WINDOW skipped: the assistant model is ${assistantModelId}, not the ${MODEL_WINDOW_TOKENS}-token default`);
// The simulator path is frozen: --user simulator keeps the old Pi reviewer, otherwise there is no simulator at all.
let sim: Awaited<ReturnType<typeof startAgent>> | null = null;
if (userMode === "simulator") {
  sim = await startAgent(env.base("sim", {}, { projectDir: simProject, agentDir: simAgentDir }), env.out, log, {
  label: "simulator",
  autoRetry: true,
  piArgs: ["--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--system-prompt", persona],
  });
}

// ── what a real user sees of the project folder after each reply ─────────────────────────────────────────────────────────
const walk = walkFiles;
let lastManuscript = "";
const scenarioDecl = parseScenarioSections(scenarioText);
function projectView(calls: Array<{ name: string; args: any }>): string {
  const files = walk(env.project).filter((f) => !f.startsWith("config/")).map((f) => `${f} (${statSync(join(env.project, f)).size} bytes)`);
  const tex = walk(env.project).filter((f) => f.endsWith(".tex")).sort().map((f) => ({ path: f, text: readFileSync(join(env.project, f), "utf8") }));
  if (arm === undefined || arm.reviewerView === "legacy") {
    const v = legacyView({ files, tex, lastBody: lastManuscript, limit: EXPERIMENT_POLICY.viewManuscriptChars });
    lastManuscript = v.body;
    return v.text;
  }
  const tablePath = scenarioDecl.evidenceTablePath;
  const evidenceTable = tablePath !== null && existsSync(join(env.project, tablePath)) ? readFileSync(join(env.project, tablePath), "utf8") : null;
  const prov = runProvenance({ root: env.project, now: () => new Date() });
  return fullView({ files, tex, evidenceTable, activity: activityDigest(calls), provenance: prov.ok ? renderFull(prov.audit) : null, provenanceNote: prov.ok ? "" : prov.message }, VIEW_POLICY);
}

// ── the conversation ─────────────────────────────────────────────────────────────────────────────────────────────────────
interface Exchange { n: number; sim: Turn; simStatus: string; simMessage: string; simNote: string; simReview: string; formatOk: boolean; agent?: Turn; view?: string }
const exchanges: Exchange[] = [];
const parse = parseSimulatorReply;
let stopReason = "budget";
/** A harness-side failure (never a provider outage): forces INVALID even when the stop reason looks clean. */
let harnessError: string | null = null;
/** The scripted user has no Pi turn: its message is recorded as a zero-cost turn labelled "scripted". */
const scriptedTurn = (id: string, message: string): Turn => ({
  id, prompt: "", calls: [], ends: [], final: message, dialogs: [], elapsedMs: 0, retries: [],
  messages: [], compactions: [], model: "scripted",
  usage: { input: 0, output: 0, reasoning: 0, total: 0, costUsd: 0, responses: 0 },
});
async function agentReply(ex: Exchange, say: string): Promise<void> {
  try {
    ex.agent = await uk.agent.turn(`agent-${ex.n}`, say, { newSession: ex.n === 1 });
  } catch (e) {
    if (e instanceof TurnBlocked) { ex.agent = e.turn; ex.view = projectView(e.turn.calls); } // keep what the cut-off turn did: measurements stay honest
    throw e;
  }
  ex.view = projectView(ex.agent.calls);
}
if (userMode === "scripted") {
  const texts = parseScriptedTexts(scenarioText); // throws for scenarios without ## Request/## Revision/## Nudge
  let revisionRequested = false;
  let revisionRequestTime = 0;
  try {
    for (let n = 1; n <= maxTurns; n++) {
      if (Date.now() - t0 > EXPERIMENT_POLICY.wallClockMs) { stopReason = "wall-clock budget"; break; }
      const assistantTurns = exchanges.filter((x) => x.agent !== undefined).length;
      const next = nextScriptedMessage(assistantTurns, texts, {
        pdfCurrent: pdfIsCurrent(env.project),
        revisionRequested,
        texEditedSinceRevision: revisionRequested && texEditedSince(env.project, revisionRequestTime),
      });
      if (next.done) { stopReason = "success"; break; }
      if (next.message === texts.revision && !revisionRequested) { revisionRequested = true; revisionRequestTime = Date.now(); }
      const ex: Exchange = { n, sim: scriptedTurn(`user-${n}`, next.message), simStatus: "scripted", simMessage: next.message, simNote: "", simReview: "", formatOk: true };
      exchanges.push(ex);
      await agentReply(ex, next.message);
    }
  } catch (e) {
    stopReason = e instanceof Blocked ? `blocked: ${e.message}` : `error: ${(e as Error).message}`;
    if (!(e instanceof Blocked)) harnessError = (e as Error).message;
    log(`EXPERIMENT STOPPED ${stopReason}`);
  }
} else {
  let simInput = `This is the start. Your request to the assistant (send it as the user would):\n\n${prompt}\n\nSuccess criteria you hold the assistant to (private):\n${success}${arm === undefined ? "" : `\n\n${channelText(arm, VIEW_POLICY)}`}`;
  try {
    for (let n = 1; n <= maxTurns; n++) {
      if (Date.now() - t0 > EXPERIMENT_POLICY.wallClockMs) { stopReason = "wall-clock budget"; break; }
      const simTurn = await sim!.agent.turn(`sim-${n}`, simInput, { newSession: n === 1 });
      const p = parse(simTurn.final);
      const ex: Exchange = { n, sim: simTurn, simStatus: p.status || "continue", simMessage: p.message, simNote: p.note, simReview: p.review, formatOk: p.status !== "" };
      exchanges.push(ex);
      if (n > 1 && (p.status === "success" || p.status === "give_up")) { stopReason = p.status; break; }
      const say = p.message || (n === 1 ? prompt : "");
      if (!say) { stopReason = "simulator sent no message"; break; }
      await agentReply(ex, say);
      simInput = `Assistant replied:\n${ex.agent!.final}\n\n${ex.view}`;
    }
  } catch (e) {
    stopReason = e instanceof Blocked ? `blocked: ${e.message}` : `error: ${(e as Error).message}`;
    if (!(e instanceof Blocked)) harnessError = (e as Error).message;
    log(`EXPERIMENT STOPPED ${stopReason}`);
  }
}

// ── ask the agent, as the developers, how its tools could serve it better ───────────────────────────────────────────────
const FEEDBACK_PROMPT = [
  "This message is from the development team, not the user. The user conversation is over. We are improving the tools you used here (papers, registry, passages, verify, compile) and want your account of working with them.",
  "Please give: (1) every point where a tool result, parameter, schema, description or refusal message confused you, cost extra calls or forced a workaround — name the call; (2) what you wish a tool returned or accepted; (3) which of your calls were wasteful or unnecessary and why; (4) one ranked list of the tool changes that would help you most.",
  "Be specific and honest. If a tool worked well, say so. Do not invent problems.",
].join("\n\n");
let feedback = "";
try { feedback = (await uk.agent.turn("feedback", FEEDBACK_PROMPT, { newSession: false })).final; } catch (e) { feedback = `(not obtained: ${(e as Error).message})`; }

// ── deterministic measurements (facts) ───────────────────────────────────────────────────────────────────────────────────
const agentTurns = exchanges.flatMap((x) => (x.agent ? [x.agent] : []));
const bare = (n: string): string => n.replace("mcp__uktub__", "");
const label = (c: { name: string; args: any }): string => `${bare(c.name)}${c.args?.action ? `:${c.args.action}` : ""}`;
const allCalls = agentTurns.flatMap((t) => t.calls.filter((c) => c.name.startsWith("mcp__uktub__")));
const allEnds = agentTurns.flatMap((t) => t.ends.filter((e) => e.name.startsWith("mcp__uktub__")));
const endOf = new Map<string, ToolEnd>(allEnds.map((e) => [e.toolCallId, e]));
const byTool: Record<string, number> = {};
for (const c of allCalls) byTool[label(c)] = (byTool[label(c)] ?? 0) + 1;
const refusalOf = (e: ToolEnd): string | undefined => /^Refused: ([A-Z_]+)/.exec(e.text)?.[1] ?? (e.isError ? "TOOL_ERROR" : undefined);
const refusals = allEnds.flatMap((e) => { const code = refusalOf(e); return code ? [{ tool: bare(e.name), code, message: e.text.replace(/\s+/g, " ").slice(0, 220), call: allCalls.find((c) => c.id === e.toolCallId)?.args }] : []; });
// A repeat is the same call with the same arguments and NOTHING changed in between (an edit-compile loop is work, not repetition): the key
// carries a state version that every write, edit, shell command or registry change advances.
const changesState = (c: { name: string; args: any }): boolean => ["write", "edit", "bash"].includes(c.name) || (bare(c.name) === "registry" && c.args?.action !== "read");
const seen = new Map<string, number>();
const repeats: Array<{ tool: string; args: unknown; times: number }> = [];
let stateVersion = 0;
for (const c of agentTurns.flatMap((t) => t.calls)) {
  if (changesState(c)) { stateVersion += 1; continue; }
  if (!c.name.startsWith("mcp__uktub__")) continue;
  const k = `${stateVersion}|${c.name}|${JSON.stringify(c.args)}`;
  seen.set(k, (seen.get(k) ?? 0) + 1);
}
for (const [k, times] of seen) if (times > 1) { const [, tool, args] = k.split("|") as [string, string, string]; repeats.push({ tool: bare(tool), args: JSON.parse(args), times }); }
const retriesAfterRefusal = allCalls.filter((c, i) => i > 0 && allCalls[i - 1]?.name === c.name && refusalOf(endOf.get(allCalls[i - 1]!.id) ?? ({ text: "", isError: false } as ToolEnd))).length;
const toolMs = (name?: string): number => allCalls.filter((c) => name === undefined || bare(c.name) === name).reduce((a, c) => a + Math.max(0, (endOf.get(c.id)?.t ?? c.t) - c.t), 0);
// Gaps and slow tools, each tagged with the write_section call it ran inside (null: the parent agent's own time).
const slow = slowStepsOf(agentTurns, EXPERIMENT_POLICY.slowGapMs, label);
const providerRetries = agentTurns.flatMap((t) => t.retries.map((r) => ({ turn: t.id, ...r })));
const childAttribution = childUsageOf(agentTurns.flatMap((t) => t.ends));
const childUsage = childAttribution.childUsage;
const sectionsAfter = passagesAfterLastSection(agentTurns);
const annotatedUsage = annotatedUsageOf(agentTurns.flatMap((t) => t.ends));
const usage = (ts: Turn[]) => ({ responses: ts.reduce((a, t) => a + t.usage.responses, 0), inputTokens: ts.reduce((a, t) => a + t.usage.input, 0), outputTokens: ts.reduce((a, t) => a + t.usage.output, 0), reasoningTokens: ts.reduce((a, t) => a + t.usage.reasoning, 0), costUsd: Number(ts.reduce((a, t) => a + t.usage.costUsd, 0).toFixed(4)) });

// registry + deliverables as the user ended up with them (paged read; citable + source metadata honored)
const mcp = await env.openSession("final");
const pages: { records: RegistryRecord[]; nextCursor: string | null }[] = [];
{
  let cursor: string | undefined;
  for (;;) {
    const res = await mcp.call("registry", { action: "read", fields: ["title", "authors", "venue", "citable", "source"], limit: 50, ...(cursor === undefined ? {} : { cursor }) }).catch(() => undefined);
    const structured = res?.structuredContent as { records?: RegistryRecord[]; nextCursor?: string | null } | undefined;
    if (structured?.records === undefined) break;
    pages.push({ records: structured.records, nextCursor: structured.nextCursor ?? null });
    if (typeof structured.nextCursor !== "string" || structured.nextCursor === "") break;
    cursor = structured.nextCursor;
  }
}
await mcp.close().catch(() => undefined);
const records: RegistryRecord[] = mergeRegistryPages(pages);
const sources = countSources(records);
const scenario = parseScenarioSections(scenarioText);
const deliver = join(iterDir, "deliverables");
mkdirSync(deliver, { recursive: true });
for (const f of walk(env.project).filter((x) => /^(manuscript|refs)\//.test(x) || /^build\/.*\.pdf$/.test(x))) { mkdirSync(join(deliver, f, ".."), { recursive: true }); copyFileSync(join(env.project, f), join(deliver, f)); }
// The evidence table is a user-owned sidecar deliverable: copy the declared file (confined) alongside the manuscript.
if (scenario.evidenceTablePath !== null && isConfinedFile(env.project, scenario.evidenceTablePath)) {
  mkdirSync(join(deliver, scenario.evidenceTablePath, ".."), { recursive: true });
  copyFileSync(join(env.project, scenario.evidenceTablePath), join(deliver, scenario.evidenceTablePath));
}
writeFileSync(join(deliver, "registry.json"), JSON.stringify(records, null, 2));
// The LaTeX every successful write_section returned, in return order: finished work stays inspectable when the run did not complete.
for (const d of writeSectionDrafts(agentTurns.flatMap((t) => t.ends))) {
  mkdirSync(join(deliver, d.file, ".."), { recursive: true });
  writeFileSync(join(deliver, d.file), d.latex);
}
const expectedEntry = resolveExpectedEntry(scenario.expectedEntry, walk(env.project));
// Tier 1 reads the machine-readable audit, not the .tex: the entry's
// transitive manuscript is only listed for the report.
const texFiles = expectedEntry !== null
  ? collectCompileInputs(env.project, expectedEntry).filter((f) => f.endsWith(".tex"))
  : walk(env.project).filter((f) => f.endsWith(".tex"));
const bibPath = join(env.project, "refs/references.bib");
const bibText = existsSync(bibPath) ? readFileSync(bibPath, "utf8") : null;
const pdfs = walk(env.project).filter((f) => /^build\/.*\.pdf$/.test(f));
const hits = extractVerifyHits(allEnds);
const warnedProviders = [...new Set(allEnds.flatMap((e) => [...e.text.matchAll(/^warning: (\S+) —/gm)].map((m) => m[1] as string)))];
const replies = agentTurns.map((t) => t.final).join("\n");
// The provenance of the delivered project as the project's own tools state it (computed by the harness at the end; evidence, never a deliverable:
// the independent fact-check must not see it). Circular as an outcome in arm B2, where the assistant saw the same view; reported, not scored.
const finalProvenance = runProvenance({ root: env.project, now: () => new Date() });
const provenanceDoc: TierProvenanceDoc | null = finalProvenance.ok
  ? {
    entry: finalProvenance.entry,
    summary: finalProvenance.audit.summary,
    items: finalProvenance.audit.items,
    document_digest: finalProvenance.digest,
    units: finalProvenance.audit.units.map((u) => ({
      id: u.unit.id,
      kind: u.unit.kind,
      file: u.unit.file,
      line: u.unit.line,
      section: u.unit.section,
      text: u.unit.plain,
      cites: u.unit.cites,
      status: u.status,
      pointers: u.ledger?.pointers ?? [],
    })),
  }
  : null;
if (finalProvenance.ok && provenanceDoc !== null) {
  writeFileSync(join(env.out, "provenance-final.json"), JSON.stringify(provenanceDoc, null, 2));
  writeFileSync(join(env.out, "provenance-final.md"), renderFull(finalProvenance.audit));
}
// Tier 1 is exactly six gated checks from the provenance JSON, the registry
// and file mtimes (the sixth, prose verified or labelled unverified, is owner decision D1, 2026-10-18).
// Without a provenance audit every gate fails closed.
const papers = readTierPaperTexts(env.project) ?? [];
const tierChecks: Check[] = provenanceDoc === null
  ? (["citations-in-registry", "bibliography-matches-registry", "compiled-after-last-edit", "pointers-resolve", "figures-supported", "prose-verified-or-labelled"] as const).map((id) => ({ id, ok: false, detail: "no provenance audit for the delivered project (fail closed)" }))
  : [
    checkTierCitations(provenanceDoc, records),
    checkTierBibliography(provenanceDoc, bibText, records),
    checkTierPdfCurrent(env.project, expectedEntry),
    checkTierPointers(provenanceDoc, papers),
    checkTierFigures(provenanceDoc),
    checkTierProseVerifiedOrLabelled(provenanceDoc),
  ];
// Reported, never gated: turn-derived evidence and disclosure checks.
const reportedChecks: Check[] = [
  checkProviderWarningsDisclosed(warnedProviders, replies),
  checkEvidenceToolsUsed(byTool, allEnds),
  checkNoUnrequestedRemoval(byTool),
];
const checks: Check[] = [...tierChecks, ...reportedChecks];
const tierFailed = tierChecks.filter((c) => !c.ok);
const cited = provenanceDoc === null ? [] : provenanceCitedKeys(provenanceDoc);
const tier1Report = provenanceDoc === null ? null : tierReport(provenanceDoc);
const behavior = behaviorOf(agentTurns, checks, uk.agent.contextWindow);
const modelProfile = {
  agent: [...new Set(agentTurns.map((t) => t.model))].sort(),
  simulator: [...new Set(exchanges.map((x) => x.sim.model))].sort(),
};
const turnModels = agentTurns.map((t) => t.model);
const record = validityRecord({
  scenarioId: scenarioName,
  scenarioSha256: env.sha(scenarioFile),
  assistantModel: assistantModelId,
  turnModels,
  adcCheckedAt: env.adcCheckedAt,
  treeHash: gitTreeHash(repo),
  stopReason,
  harnessError,
});
const metrics = {
  pilot,
  arm: arm?.arm ?? null,
  modelProfile,
  assistantModel: assistantModelId,
  verifyEngine,
  turnModels,
  validity: record.validity,
  userMode,
  simulatedWindowTokens: simulatedWindow ?? null,
  behavior,
  fallbackTurns: { uktub: uk.agent.fallbackTurns, simulator: sim?.agent.fallbackTurns ?? [] },
  scenario: scenarioName,
  iteration,
  outcome: stopReason,
  userTurns: exchanges.length,
  wallMs: Date.now() - t0,
  agent: { toolCalls: allCalls.length, byTool, refusalsOrErrors: refusals.length, refusals, retriesAfterRefusal, providerRetries, repeatedIdenticalCalls: repeats, toolMs: toolMs(), toolMsByTool: Object.fromEntries(Object.keys(byTool).map((k) => [k.split(":")[0], toolMs(k.split(":")[0])])), slowSteps: slow, slowStepsByScope: slowScopeOf(slow), childUsage, childUsageMissing: childAttribution.childUsageMissing, passagesAfterLastSection: sectionsAfter, annotatedUsage, totalCostUsd: totalCostUsd(usage(agentTurns).costUsd, childUsage.costUsd), usage: usage(agentTurns), perTurn: agentTurns.map((t) => ({ id: t.id, ms: t.elapsedMs, calls: t.calls.length, inputTokens: t.usage.input, outputTokens: t.usage.output })) },
  simulator: { usage: usage(exchanges.map((x) => x.sim)), formatFailures: exchanges.filter((x) => !x.formatOk).length, reviews: exchanges.map((x) => ({ turn: x.n, status: x.simStatus, review: x.simReview })) },
  provenance: finalProvenance.ok ? finalProvenance.audit.summary : { unavailable: finalProvenance.message },
  tier1: { documentDigest: provenanceDoc?.document_digest ?? null, report: tier1Report, gated: tierChecks.map((c) => c.id), reported: reportedChecks.map((c) => c.id) },
  registry: { papers: records.length, ready: sources.ready, acquiring: sources.acquiring, unavailable: sources.unavailable, failed: sources.failed, metadataOnly: sources.metadataOnly },
  deliverable: { texFiles, citations: cited.length, pdfs },
  checks,
};
writeFileSync(join(iterDir, "metrics.json"), JSON.stringify(metrics, null, 2));

// ── the reviewer's assessment (simulator runs only; scripted runs have no reviewer opinion) ─────────────────────────────
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
if (sim !== null) {
  try { assessment = (await sim.agent.turn("report", REPORT_PROMPT, { newSession: false })).final; } catch (e) { assessment = `(not obtained: ${(e as Error).message})`; }
} else {
  assessment = "(not obtained: scripted user runs have no simulator assessment)";
}
await uk.stop();
await sim?.stop();
const cleanup = spawnSync("docker", ["ps", "-a", "--filter", `name=uktub-live-${env.runId}`, "--format", "{{.Names}} {{.Status}}"], { encoding: "utf8" });
const cleanupOk = cleanup.status === 0 && cleanup.stdout.trim() === "";
writeFileSync(join(env.out, "final-containers.txt"), cleanup.status === 0 ? `${cleanup.stdout.trim() || "none"}\n` : "cleanup inspection failed\n");

// ── report ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const pct = (n: number, d: number): string => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
const conv = exchanges.map((x) => [
  `### Turn ${x.n}`,
  `**User (${userMode})** — status \`${x.simStatus}\`${x.formatOk ? "" : " (format not followed)"}:`, x.simMessage ? `> ${x.simMessage.replace(/\n/g, "\n> ")}` : "_(no message)_",
  ...(arm === undefined ? [] : [`_Simulator review:_\n\n${x.simReview ? x.simReview.replace(/^/gm, "> ") : "(none)"}`]),
  `_Simulator note:_ ${x.simNote || "(none)"}`,
  x.agent ? `**Uktub agent** (${Math.round(x.agent.elapsedMs / 1000)} s, ${x.agent.calls.length} tool call(s): ${x.agent.calls.map(label).join(", ") || "none"})${x.agent.incomplete ? ` — **INCOMPLETE: ${x.agent.incomplete}**` : ""}:\n\n${x.agent.final || "_(no final answer)_"}` : "",
].join("\n\n")).join("\n\n---\n\n");
writeFileSync(join(iterDir, "conversation.md"), redact(`# Conversation — ${scenarioName} iter-${iteration}\n\n${conv}\n\n---\n\n### Developer feedback request (to the agent)\n\n${feedback}\n`));
const table = (rows: Array<[string, string | number]>): string => `| | |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join("\n")}`;
const report = `# Experiment report — ${scenarioName} / iteration ${iteration}${arm === undefined ? "" : ` [arm ${arm.arm}]`}

Outcome: **${stopReason}** · ${exchanges.length} user turn(s) · ${Math.round(metrics.wallMs / 60000)} min · agent cost $${metrics.agent.usage.costUsd} · ${tierChecks.filter((c) => c.ok).length}/${tierChecks.length} Tier 1 checks passed

Model: assistant ${assistantModelId} via Pi's client (user: ${userMode}). ${simulatedWindow !== undefined ? `SIMULATED CONTEXT WINDOW (an ablation): Pi compacts as if the agent's window were ${simulatedWindow} tokens (the real one is ${MODEL_WINDOW_TOKENS}); compare only with runs of the same setting. ` : ""}${uk.agent.fallbackTurns.length > 0 || (sim?.agent.fallbackTurns.length ?? 0) > 0 ? `QUOTA FALLBACK: turns on google-vertex/gemini-3.5-flash-lite after a 429 on 3.8: uktub [${uk.agent.fallbackTurns.join(", ")}], simulator [${sim?.agent.fallbackTurns.join(", ") ?? ""}]. ` : ""}Sandbox: Docker image \`uktub-scholar-sandbox\`. Engine on CPU. Evidence: \`evidence/\` (git-ignored). Scenario: \`experiments/scenarios/${scenarioName}.md\` (sha256 ${env.sha(scenarioFile).slice(0, 12)}); simulator persona sha256 ${env.sha(join(expRoot, "simulator.md")).slice(0, 12)}. Run validity: ${record.validity}.

## Part A — Measured facts (deterministic)

### Tier 1 (gated)
${tierChecks.map((c) => `- ${c.ok ? "PASS" : "**FAIL**"} \`${c.id}\` — ${c.detail}`).join("\n")}

### Reported, never gated
${reportedChecks.map((c) => `- ${c.ok ? "pass" : "noted"} \`${c.id}\` — ${c.detail}`).join("\n")}

### Tool use
${table([["tool calls", allCalls.length], ["calls by tool", Object.entries(byTool).map(([k, v]) => `${k}×${v}`).join(", ") || "none"], ["refusals / tool errors", `${refusals.length} (${pct(refusals.length, allCalls.length)} of calls)`], ["retries immediately after a refusal of the same tool", retriesAfterRefusal], ["provider retries performed by Pi (transient failures, visible)", providerRetries.length ? providerRetries.map((r) => `${r.turn}: ${r.errorMessage.slice(0, 80)}`).join("; ") : "none"], ["identical calls repeated", repeats.length ? repeats.map((r) => `${r.tool}×${r.times}`).join(", ") : "none"], ["tool time", `${Math.round(toolMs() / 1000)} s (${Object.entries(metrics.agent.toolMsByTool).map(([k, v]) => `${k} ${Math.round((v as number) / 1000)} s`).join(", ")})`], [`slow steps (> ${EXPERIMENT_POLICY.slowGapMs / 1000} s)`, slow.length ? slow.map((s) => `${s.turn}: ${s.kind} ${Math.round(s.ms / 1000)} s (${s.detail}${s.parent === null ? "" : `, inside ${s.parentTool ?? "a child tool"}`})`).join("; ") : "none"], ["slow steps by scope: parent agent / inside write_section", `${metrics.agent.slowStepsByScope.parent.count} (${Math.round(metrics.agent.slowStepsByScope.parent.ms / 1000)} s) / ${metrics.agent.slowStepsByScope.child.count} (${Math.round(metrics.agent.slowStepsByScope.child.ms / 1000)} s)`], ["parent passages after the last write_section", sectionsAfter === null ? "n/a (no section written)" : String(sectionsAfter)]])}

### Behaviour signatures
${table([["peak context", `${behavior.peakContextTokens} tokens (${pct(behavior.peakContextTokens, behavior.contextWindowTokens)} of the ${behavior.contextWindowTokens}-token window${simulatedWindow !== undefined ? `; ${pct(behavior.peakContextTokens, simulatedWindow)} of the simulated ${simulatedWindow}` : ""})`], ["compactions by Pi", behavior.compactions ? `${behavior.compactions} (${behavior.overflowRecoveries} recovering from an overflow)` : "none"], ["invalid tool calls (all tools)", `${behavior.invalidToolCalls} of ${behavior.toolCalls}: validation ${behavior.invalidByKind.validation}, unknown tool ${behavior.invalidByKind.unknown_tool}, command not found ${behavior.invalidByKind.unresolved_command}`], ["agent turns that ended without a tool call", behavior.zeroCallTurns], ["premature stop", behavior.prematureStop ? `yes: a turn ended without a tool call and ${behavior.deliverableChecksFailed.join(", ")} failed` : "no"]])}

### Refusals and errors
${refusals.length ? refusals.map((r) => `- \`${r.tool}\` ${r.code}: ${r.message} — args ${JSON.stringify(r.call).slice(0, 160)}`).join("\n") : "none"}

### Model usage
${table([["agent responses", metrics.agent.usage.responses], ["agent input / output / reasoning tokens", `${metrics.agent.usage.inputTokens} / ${metrics.agent.usage.outputTokens} / ${metrics.agent.usage.reasoningTokens}`], ["agent cost (reported by the provider client, parent agent only)", `$${metrics.agent.usage.costUsd}`], ["write_section children: turns, retries, tool calls", `${metrics.agent.childUsage.turns}, ${metrics.agent.childUsage.retries}, ${metrics.agent.childUsage.toolCalls}`], ["write_section children: input / output tokens, cost", `${metrics.agent.childUsage.inputTokens} / ${metrics.agent.childUsage.outputTokens}, $${metrics.agent.childUsage.costUsd}`], ["write_section ends without child figures (not in the child numbers)", metrics.agent.childUsageMissing], ["write_section annotated use (sections, marker compliance)", annotatedUsage.sections === 0 ? "none" : `${annotatedUsage.sections} sections, ${pct(annotatedUsage.markerCompliance * 100, 100)} marker-compliant, ${annotatedUsage.claims} claims, multi-source ${pct(annotatedUsage.multiSourceShare * 100, 100)}, unread ${pct(annotatedUsage.unreadRate * 100, 100)}, work cells/fresh/cached/calls ${annotatedUsage.work.cells}/${annotatedUsage.work.fresh}/${annotatedUsage.work.cached}/${annotatedUsage.work.calls}`], ["total agent cost, parent + write_section children", `$${metrics.agent.totalCostUsd}`], ["simulator responses / cost", `${metrics.simulator.usage.responses} / $${metrics.simulator.usage.costUsd}`], ["simulator format failures", metrics.simulator.formatFailures]])}

### Result
${table([["registered papers", records.length], [`ready sources (of ${records.length}; acquiring ${sources.acquiring}, unavailable ${sources.unavailable}, failed ${sources.failed}, metadata-only ${sources.metadataOnly})`, sources.ready], ["manuscript files", texFiles.join(", ") || "none"], ["citations in the manuscript", cited.length], ["pdf", pdfs.join(", ") || "none"], ["document digest", provenanceDoc?.document_digest.slice(0, 12) ?? "unavailable"], ["provenance words / verified / cited / uncited", tier1Report === null ? "unavailable" : `${tier1Report.words} / ${tier1Report.verified} / ${tier1Report.cited} / ${tier1Report.uncited}`], ["successful verifies", hits.filter((h) => h.supportFound).length]])}

## Part B — The reviewer's assessment (opinion${userMode === "simulator" ? ", simulated user" : "; none in scripted runs"})

${assessment}

## Part C — The Uktub agent's own feedback on its tools (opinion, asked by the developers)

${feedback}

---
Conversation: \`conversation.md\` · measurements: \`metrics.json\` · deliverables: \`deliverables/\`
`;
writeFileSync(join(iterDir, "report.md"), redact(report));
appendFileSync(join(runsDir, "index.md"), `- iter-${String(iteration).padStart(2, "0")}${pilot ? " [PILOT]" : ""}${simulatedWindow !== undefined ? ` [simulated window ${simulatedWindow}]` : ""}${arm !== undefined ? ` [arm ${arm.arm}]` : ""} [user ${userMode}] [${assistantModelId}] [verify ${verifyEngine}] — ${stopReason}; ${record.validity}; ${tierChecks.filter((c) => c.ok).length}/${tierChecks.length} Tier 1; ${exchanges.length} turns; ${allCalls.length} tool calls; ${refusals.length} refusals; $${metrics.agent.usage.costUsd}\n`);
writeFileSync(join(env.out, "manifest.json"), JSON.stringify(env.manifest({ scenario: scenarioName, iteration, scenarioSha256: env.sha(scenarioFile), ...record.manifest, pilot, userMode, simulatorSha256: env.sha(join(expRoot, "simulator.md")), arm: arm?.arm ?? null, simulatorV2Sha256: arm === undefined ? null : env.sha(personaFile), experimentSha256: env.sha(import.meta.filename), agentDriverSha256: env.sha(join(import.meta.dirname, "agent.ts")), metricsSha256: env.sha(join(iterDir, "metrics.json")), modelProfile, model: `${assistantModelId} via Pi client; actual models: ${JSON.stringify(modelProfile)}`, verifyEngine, assistantSecretsPassed: Object.keys(assistantSecrets), vertexProject: env.gcpProject, cleanupOk, documentDigest: provenanceDoc?.document_digest ?? null, tier1: tierChecks, policy: { ...EXPERIMENT_POLICY, piSettings: { ...PI_SETTINGS, ...windowSettings }, simulatedWindowTokens: simulatedWindow ?? null, piAutoRetry: "on for experiments (transient provider failures; every retry logged and reported); off for acceptance" } }), null, 2));
log(`EXPERIMENT COMPLETE iter-${iteration}: ${stopReason}; report ${join(iterDir, "report.md")}`);
process.exitCode = tierFailed.length === 0 && stopReason === "success" ? 0 : 1;
