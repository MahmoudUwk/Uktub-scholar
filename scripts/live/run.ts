/**
 * Live acceptance runner for the CURRENT tools (real providers, real engines, real files and processes; no mocks, no retries).
 *
 *   node scripts/live/run.ts --suite direct|agent|skills [--only id,id] [<out-dir>]
 *
 * `direct` calls the real stdio MCP server (no model). `agent` drives real Pi sessions with google-vertex/gemini-3.8-flash. `skills`
 * gives the same agent a task one of the package's product skills (skills/) is for and checks the skill was used and its artifact is
 * right (skill-cases.ts). The suites mutate the registry or the project, so each run is one suite on its own fresh project. <out-dir> defaults to
 * experiments/runs/acceptance/<suite>-<timestamp> and must not exist: every run writes fresh evidence. Verdict meanings: cases.ts.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { FALLBACK_MODEL, startAgent, type Agent } from "./agent.ts";
import { AGENT_CASES_VERSION, agentCases } from "./agent-cases.ts";
import { SKILL_CASES_VERSION, saveArtifacts, saveProjectOutputs, skillCases } from "./skill-cases.ts";
import { Blocked, CASES_VERSION, directCases, NotRun, type Case, type Ctx, type Session } from "./cases.ts";
import { createEnv, POLICY } from "./env.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const suite = flag("--suite") as "direct" | "agent" | "skills";
if (suite !== "direct" && suite !== "agent" && suite !== "skills") throw new Error("usage: run.ts --suite direct|agent|skills [--only id,id] [<out-dir>]");
const only = flag("--only") !== undefined ? new Set(String(flag("--only")).split(",")) : undefined;
const repo = resolve(import.meta.dirname, "../..");
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"))[0];
const out = positional ?? join(repo, "experiments/runs/acceptance", `${suite}-${new Date().toISOString().replace(/[:.]/g, "-")}`);

// Harness policy (not the product default of 120): a binding per-call judgment budget so continuation is really exercised.
const HARNESS_MAX_JUDGMENTS = 20;
const env = createEnv(out, { corpus: true, maxJudgments: HARNESS_MAX_JUDGMENTS, acquireOnRegister: suite === "agent" });
const { log } = env;

const corpus = resolve(repo, "test_papers/RF");
const sourceCache = new Map<string, string>();
for (const [key, file] of [["2411", "2411.09996v1.pdf"], ["2511", "2511.15162v1.pdf"]] as const) {
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(join(corpus, file))));
  sourceCache.set(key, (await extractText(pdf, { mergePages: true })).text.replace(/\s+/g, " ").trim());
}
const opened: Agent[] = []; // extra Pi sessions a case opened (their fallback turns count toward that case)
const ctxFor = (mcp: Session, state: Map<string, unknown>): Ctx => ({
  mcp, state, project: env.project, log, open: env.openSession, shell: env.shell,
  openAgent: async (label, extra) => {
    const started = await startAgent(env.base(label, extra), out, log, { label });
    opened.push(started.agent);
    return started;
  },
  hasKey: (name) => env.passEnv.includes(name),
  sourceText: (paper) => sourceCache.get(paper) as string,
});

type Verdict = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
interface Result { id: string; tool: string; contract?: string; verdict: Verdict; elapsedMs: number; detail?: unknown; reason?: string; error?: string }
const results: Result[] = [];
const manifest = env.manifest({
  suite,
  casesVersion: CASES_VERSION,
  agentCasesVersion: AGENT_CASES_VERSION,
  casesSha256: env.sha(join(import.meta.dirname, "cases.ts")),
  agentCasesSha256: env.sha(join(import.meta.dirname, "agent-cases.ts")),
  skillCasesVersion: SKILL_CASES_VERSION,
  skillCasesSha256: env.sha(join(import.meta.dirname, "skill-cases.ts")),
  agentDriverSha256: env.sha(join(import.meta.dirname, "agent.ts")),
  runnerSha256: env.sha(import.meta.filename),
  model: suite !== "direct" ? `google-vertex/gemini-3.8-flash (Vertex client, ADC); a fresh-session turn that fails with HTTP 429 / RESOURCE_EXHAUSTED is rerun once on ${FALLBACK_MODEL.provider}/${FALLBACK_MODEL.id} (owner decision 2026-10-07), and every such case is labelled` : "none (direct tool calls)",
  vertexProject: suite !== "direct" ? env.gcpProject : undefined,
  harnessVerificationMaxJudgments: `${HARNESS_MAX_JUDGMENTS} (harness policy to exercise continuation; product default 120)`,
});
const save = (): void => writeFileSync(join(out, "results.json"), JSON.stringify({ manifest, results }, null, 2));

async function runCase(c: Case, ctx: Ctx): Promise<void> {
  const unmet = (c.needs ?? []).find((id) => results.find((r) => r.id === id)?.verdict !== "PASS");
  const started = Date.now();
  let r: Result;
  if (unmet !== undefined) {
    r = { id: c.id, tool: c.tool, contract: c.contract, verdict: "NOT_RUN", elapsedMs: 0, reason: `prerequisite ${unmet} is ${results.find((x) => x.id === unmet)?.verdict ?? "not run"}` };
  } else {
    log(`CASE START ${c.id} — ${c.contract}`);
    let deadline: NodeJS.Timeout | undefined;
    try {
      const detail = await Promise.race([c.run(ctx), new Promise((_, rej) => { deadline = setTimeout(() => rej(new Blocked(`case deadline ${POLICY.caseTimeoutMs}ms`)), POLICY.caseTimeoutMs); })]);
      r = { id: c.id, tool: c.tool, contract: c.contract, verdict: "PASS", elapsedMs: Date.now() - started, detail };
    } catch (e) {
      const err = e as Error;
      const timedOut = /timed out|Request timed out|-32001/i.test(err.message);
      if (err instanceof NotRun) r = { id: c.id, tool: c.tool, contract: c.contract, verdict: "NOT_RUN", elapsedMs: Date.now() - started, reason: err.message };
      else if (err instanceof Blocked || timedOut) r = { id: c.id, tool: c.tool, contract: c.contract, verdict: "BLOCKED", elapsedMs: Date.now() - started, reason: err.message };
      else r = { id: c.id, tool: c.tool, contract: c.contract, verdict: "FAIL", elapsedMs: Date.now() - started, error: String(err.stack ?? err.message).slice(0, 1500) };
    } finally {
      clearTimeout(deadline);
    }
  }
  results.push(r);
  log(`CASE ${r.verdict} ${r.id}${r.reason ? ` — ${r.reason}` : ""}${r.error ? ` — ${r.error.split("\n")[0]}` : ""}`);
  save();
}

log(`SETUP project ${env.project}; commit ${String(manifest.commit).slice(0, 7)}; suite ${suite}`);
const state = new Map<string, unknown>();
const mcp = await env.openSession("main");
try {
  if (suite === "direct") {
    for (const c of directCases) if (only === undefined || only.has(c.id)) await runCase(c, ctxFor(mcp, state));
  } else {
    const pi = await startAgent(env.base("pi"), out, log).then(
      (p) => p,
      (e: Error) => { log(`PI START FAILED ${e.message}`); return undefined; },
    );
    try {
      for (const c of suite === "agent" ? agentCases : skillCases) {
        if (only !== undefined && !only.has(c.id)) continue;
        const wrapped: Case = {
          ...c,
          run: async (ctx) => {
            if (!pi) throw new Blocked("the Pi session could not start (see subscription.log)");
            const count = (): string[] => [pi.agent, ...opened].flatMap((a) => a.fallbackTurns);
            const before = count().length;
            const detail = await c.run(ctx, pi.agent as Agent).catch((e: unknown) => {
              if (suite === "skills") saveProjectOutputs(env.project, join(out, "artifacts", c.id));
              throw e;
            });
            if (suite === "skills") saveArtifacts(env.project, join(out, "artifacts", c.id), detail);
            const used = count().slice(before);
            return used.length > 0 ? { result: detail, ranOnFallbackModel: `${FALLBACK_MODEL.provider}/${FALLBACK_MODEL.id}`, fallbackTurns: used } : detail;
          },
        };
        await runCase(wrapped, ctxFor(mcp, state));
      }
    } finally {
      await pi?.stop();
    }
  }
} finally {
  await mcp.close().catch((e: Error) => log(`MCP CLOSE ${e.message}`));
}

const leftovers = spawnSync("docker", ["ps", "-a", "--filter", `name=uktub-live-${env.runId}`, "--format", "{{.Names}} {{.Status}}"], { encoding: "utf8" }).stdout.trim();
writeFileSync(join(out, "final-containers.txt"), leftovers ? `${leftovers}\n` : "none\n");
const onFallback = (r: Result): string => ((r.detail as { ranOnFallbackModel?: string } | undefined)?.ranOnFallbackModel ? ` [ran on fallback model ${FALLBACK_MODEL.id} after a quota failure on the primary]` : "");
const tally = (v: Verdict): number => results.filter((r) => r.verdict === v).length;
const fb = results.filter((r) => onFallback(r) !== "").length;
log(`COMPLETE${fb > 0 ? ` (${fb} case(s) on the fallback model)` : ""} ${tally("PASS")} PASS, ${tally("FAIL")} FAIL, ${tally("BLOCKED")} BLOCKED, ${tally("NOT_RUN")} NOT_RUN of ${results.length}; leftover containers: ${leftovers || "none"}`);
writeFileSync(join(out, "summary.txt"), `${results.map((r) => `${r.verdict.padEnd(8)} ${r.id}${onFallback(r)}${r.reason ? ` — ${r.reason}` : ""}${r.error ? ` — ${r.error.split("\n")[0]}` : ""}`).join("\n")}\n`);
process.exitCode = tally("FAIL") > 0 ? 1 : 0;
