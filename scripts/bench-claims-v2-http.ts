/**
 * claim-verification-v2: scoring through a System One HTTP server, here the AUTHOR'S OWN Kev server (the exact prompt rendering of Kev lives
 * in its repository, so a re-implementation would not be faithful). Three small pieces: the question a claim becomes, the engine that posts it
 * (one `noul` question per row to `/v1/systemone`, `answers.c.noul` = P(supported)), and the wait for a server to come up.
 *
 * `criteria` is the claim wording every other candidate of the table is asked (`claim-noul-criteria-v1`, identical to the Decision 2.0, Decision
 * 3.0 and Intern workers); `native` is the claim alone, which is what the product's own System One engine sends to a System One server.
 */
import { spawn, type ChildProcess } from "node:child_process";

import { EngineError, type ClaimEngine } from "../src/core/verify/claim.ts";

export type Wording = "criteria" | "native";

/** The `noul` question for a claim: the shared Decision 2.0 wording with its yes and no criteria, or the claim alone. */
export function criteriaQuestion(claim: string, wording: Wording): Record<string, unknown> {
  if (wording === "native") return { type: "noul", instructions: claim };
  return {
    type: "noul",
    instructions:
      `Claim under test: "${claim}" Decide whether the state passage explicitly supports this claim. ` +
      "Answer true only if the passage itself states or directly entails the claim; answer false when the passage contradicts it or says nothing about it.",
    criteria: {
      false: "The passage contradicts the claim or says nothing about it.",
      true: "The passage explicitly states or directly entails the claim.",
    },
  };
}

/** Client policy: one row on a long passage must not stall a run for ever (the CPU path of a 0.8B model takes seconds). */
const REQUEST_TIMEOUT_MS = 120_000;

export function httpEngine(baseUrl: string, wording: Wording, fetchImpl: typeof fetch = fetch): ClaimEngine {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/systemone`;
  return {
    async run(rows) {
      const out: number[] = [];
      for (const row of rows) {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: row.state, questions: { c: criteriaQuestion(row.instructions, wording) } }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) throw new EngineError(`system one server ${url}: HTTP ${res.status}`);
        const parsed = (await res.json()) as { answers?: Record<string, { noul?: number }> };
        const p = parsed.answers?.c?.noul;
        if (typeof p !== "number") throw new EngineError(`system one server ${url}: response missing answers.c.noul`);
        out.push(p);
      }
      return out;
    },
  };
}

/** Polls `/v1/models` until it answers 200; rejects with the address after `timeoutMs`. */
export async function waitForServer(baseUrl: string, opts: { timeoutMs: number; intervalMs: number }): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(250, opts.intervalMs)) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`no server answered at ${baseUrl} within ${opts.timeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

/** Starts the server as its own process group (so every child dies with it) and returns a stop function. */
export function startServer(spec: { cwd: string; command: string[]; env: Record<string, string>; logFile?: string }): { child: ChildProcess; stop: () => Promise<void> } {
  const child = spawn(spec.command[0] as string, spec.command.slice(1), { cwd: spec.cwd, env: spec.env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const log: string[] = [];
  const keep = (d: Buffer) => { log.push(d.toString()); if (log.length > 200) log.shift(); };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const stop = async (): Promise<void> => {
    if (child.pid === undefined || child.exitCode !== null) return;
    process.kill(-child.pid, "SIGTERM");
    await new Promise<void>((done) => {
      const t = setTimeout(() => { try { process.kill(-(child.pid as number), "SIGKILL"); } catch { /* gone */ } done(); }, 15_000);
      child.once("exit", () => { clearTimeout(t); done(); });
    });
  };
  return { child, stop };
}
