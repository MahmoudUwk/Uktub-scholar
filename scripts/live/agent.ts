/**
 * Drives a real Pi session (RPC mode) inside the sandbox container with google-vertex/gemini-3.8-flash and records everything.
 * No fallback model, no automatic retry: a provider error, abort or deadline is BLOCKED (cannot judge the product), never a pass.
 */
import { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { compactionsOf } from "./behavior.ts";
import { Blocked } from "./cases.ts";
import { redact } from "./redact.ts";
import { type GraderSandboxSpec, type SandboxSpec, spawnSandboxed } from "./sandbox.ts";

export const MODEL = { provider: "google-vertex", id: "gemini-3.8-flash" } as const;
/** Owner decision 2026-10-07: when gemini-3.8-flash is quota limited (HTTP 429 / RESOURCE_EXHAUSTED), rerun that turn once on this model. Explicit, per turn, always labelled in the evidence; never an implicit fallback. */
export const FALLBACK_MODEL = { provider: "google-vertex", id: "gemini-3.5-flash-lite" } as const;

/** Models are harness settings (Pi `provider/id` strings), not hard-coded: the agent driver accepts one per session. */
export interface ModelRef {
  provider: string;
  id: string;
}
/** Split a `provider/id` setting (e.g. `--assistant-model`). Anything else is a harness error, never a guess. */
export function parseModelSetting(text: string): ModelRef {
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) throw new Error(`model must be provider/id, got ${JSON.stringify(text)}`);
  return { provider: text.slice(0, slash), id: text.slice(slash + 1) };
}
export const formatModel = (m: ModelRef): string => `${m.provider}/${m.id}`;
export const isQuotaFailure = (text: string): boolean => /\b429\b|RESOURCE_EXHAUSTED|Resource exhausted/i.test(text);
const TOOL_PREFIX = "mcp__uktub__";
export const AGENT_POLICY = {
  // Client policy. A turn may legitimately run long (serial CPU verification took ~100 s per call; a literature review ran >15 min), so a
  // turn is only ended when nothing at all happened for turnIdleMs (a real stall) or it exceeds the hard cap. Production timeouts are unchanged.
  turnIdleMs: 600000,
  turnMaxMs: 5400000, // 90 min: a provider-throttled literature review exceeded 45 min (iter-08)
  rpcTimeoutMs: 120000,
  heartbeatMs: 30000,
  abortGraceMs: 30000,
  autoRetry: false,
};

export interface ToolCall { id: string; name: string; args: any; parent?: string; /** receive time (ms epoch) */ t: number }
export interface ToolEnd { toolCallId: string; name: string; isError: boolean; text: string; structured: any; /** Pi's `result.details` (a write_section end carries its child's figures here). */ details?: any; parent?: string; t: number }
export interface Turn {
  id: string;
  prompt: string;
  calls: ToolCall[];
  ends: ToolEnd[];
  final: string;
  dialogs: Array<{ method: string; title: string; answer: string }>;
  elapsedMs: number;
  /** Provider retries Pi performed inside this turn (empty when auto-retry is off). */
  retries: Array<{ attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }>;
  /** Set when the turn did not settle normally (deadline, abort, provider error): what the harness saw, never a pass. */
  incomplete?: string;
  messages: any[];
  /** Reasons of the compactions Pi started during this turn (`threshold`, `overflow`, `manual`). */
  compactions: string[];
  /** The model that produced this turn: the primary, or the labelled fallback after a quota failure. */
  model: string;
  /** Set when this turn ran on the fallback model: why the primary attempt was abandoned. */
  fallbackFrom?: string;
  /** Tokens and cost the provider reported for this turn's model responses. */
  usage: { input: number; output: number; reasoning: number; total: number; costUsd: number; responses: number };
}
/** A turn that could not be completed. It carries everything observed so far, so measurements stay honest about a cut-off turn. */
export class TurnBlocked extends Blocked {
  turn: Turn;
  constructor(message: string, turn: Turn) {
    super(message);
    this.turn = turn;
  }
}

export interface Agent {
  /** `newSession: false` continues the same conversation (an experiment is one conversation); default starts a clean session. */
  turn(id: string, prompt: string, opts?: { dialog?: "decline" | "accept"; newSession?: boolean }): Promise<Turn>;
  /** The uktub tool calls in a turn, with the bare tool name. */
  uktub(t: Turn, name?: string): ToolCall[];
  /** Ids of the turns that ran on the fallback model (after a quota failure on the primary), in order. */
  fallbackTurns: string[];
  /** The context window Pi reports for the primary model, in tokens (0 when it reports none). */
  contextWindow: number;
}

// Pi wraps an MCP result as {content, structuredContent: {…the tool's structured output…}}; the tool output is the inner object.
const sum = (xs: any[], f: (x: any) => number | undefined): number => xs.reduce((a, x) => a + (f(x) ?? 0), 0);
const textOf = (result: any): string => (result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

export interface StartOptions {
  /** Prefix of this agent's evidence files (two agents can share one evidence dir). */
  label?: string;
  /** Pi provider/id for this session (default MODEL), so a later grader can run Pi sessions on other models. */
  model?: { provider: string; id: string };
  /** Let Pi retry transient provider failures (experiments only; acceptance keeps it off so a provider failure stays visible). Every retry is logged and recorded on the turn. */
  autoRetry?: boolean;
  /** Smoke-test seam only: treat the first fresh-session turn's primary attempt as quota limited, to exercise the fallback path on demand. */
  simulateQuotaOnce?: boolean;
  /** Extra Pi flags (e.g. a tool-less, extension-less user simulator with its own system prompt). */
  piArgs?: string[];
  /**
   * Override how the Pi RPC process is spawned (grader sessions run in a different container layout;
   * see sandbox.ts GraderSandboxSpec). Receives the same `pi --mode rpc ...` argv spawnSandboxed gets.
   */
  spawnPi?: (args: string[]) => ChildProcess;
  /**
   * Optional hook fired on every `tool_execution_end` event, at tool-result
   * time (before the model continues the turn). Used by the experiment driver
   * to snapshot compile inputs at each successful compile; failures inside
   * the hook never break the turn. Only `tool_execution_end` events fire it.
   */
  onToolEnd?: (end: ToolEnd) => void;
}

export async function startAgent(spec: SandboxSpec | GraderSandboxSpec, outDir: string, log: (l: string) => void, opts: StartOptions = {}): Promise<{ agent: Agent; stop(): Promise<void> }> {
  const label = opts.label ?? "pi";
  const selected: { provider: string; id: string } = opts.model ?? MODEL;
  const piArgs = ["pi", "--mode", "rpc", "--provider", selected.provider, "--model", selected.id, "--no-session", ...(opts.piArgs ?? [])];
  const proc: ChildProcess = opts.spawnPi?.(piArgs)
    ?? spawnSandboxed(spec as SandboxSpec, piArgs); // spawnPi callers pass a grader spec and must set spawnPi
  const events: any[] = [];
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const waiters = new Set<{ type: string; resolve: (e: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let seq = 0;
  let phase = "startup";
  let lastEvent = Date.now();
  let active: { id: string; dialog: "decline" | "accept"; dialogs: Turn["dialogs"] } | null = null;
  const transcript = join(outDir, `${label}-transcript.jsonl`);
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (d: string) => appendFileSync(join(outDir, `${label}-stderr.log`), redact(d)));
  let buffer = "";
  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (d: string) => {
    buffer += d;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).replace(/\r$/, "");
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let e: any;
      try { e = JSON.parse(line); } catch { log(`PI NON-JSON ${redact(line).slice(0, 100)}`); continue; }
      appendFileSync(transcript, `${redact(JSON.stringify({ turn: active?.id ?? null, ...e }))}\n`);
      e._t = Date.now();
      events.push(e);
      lastEvent = e._t;
      const who = active?.id ?? "idle";
      if (e.type === "response" && pending.has(e.id)) { const p = pending.get(e.id)!; pending.delete(e.id); clearTimeout(p.timer); e.success ? p.resolve(e.data) : p.reject(new Error(String(e.error))); }
      if (e.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(e.method)) {
        const answer = (active?.dialog ?? "decline") === "accept" ? "accept" : "decline";
        active?.dialogs.push({ method: e.method, title: redact(String(e.title ?? "")), answer });
        log(`PI DIALOG ${who}: ${e.method} "${redact(String(e.title ?? "")).slice(0, 100)}" -> ${answer}`);
        proc.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id: e.id, ...(e.method === "confirm" ? { confirmed: answer === "accept" } : answer === "accept" ? { value: e.options?.[0] ?? "" } : { cancelled: true }) })}\n`);
      }
      if (e.type === "message_start" && e.message?.role === "assistant") { phase = "model response"; log(`PI MODEL START ${who}`); }
      if (e.type === "message_end" && e.message?.role === "assistant") { phase = e.message.stopReason === "toolUse" ? "tool dispatch" : "final response"; log(`PI MODEL END ${who}: ${e.message.stopReason}${e.message.errorMessage ? ` ${redact(e.message.errorMessage).slice(0, 200)}` : ""}`); }
      if (e.type === "tool_execution_start") { phase = `tool ${e.toolName}`; log(`PI TOOL START ${who}: ${e.toolName} ${redact(JSON.stringify(e.args)).slice(0, 260)}`); }
      if (e.type === "tool_execution_end") {
        phase = "waiting for model";
        log(`PI TOOL END ${who}: ${e.toolName} error=${!!e.isError} ${redact(textOf(e.result)).replace(/\s+/g, " ").slice(0, 160)}`);
        if (opts.onToolEnd !== undefined) {
          try {
            opts.onToolEnd({
              toolCallId: e.toolCallId, name: e.toolName, isError: !!e.isError, text: textOf(e.result),
              structured: e.result?.structuredContent?.structuredContent ?? e.result?.structuredContent,
              parent: e.parentToolCallId, t: e._t,
            });
          } catch (err) { log(`PI HOOK ERROR ${who}: ${(err as Error).message}`); }
        }
      }
      if (e.type === "auto_retry_start") log(`PI RETRY ${who}: attempt ${e.attempt}/${e.maxAttempts} in ${e.delayMs}ms after: ${redact(String(e.errorMessage ?? "")).slice(0, 160)}`);
      if (e.type === "auto_retry_end") log(`PI RETRY END ${who}: success=${e.success} attempt=${e.attempt}${e.finalError ? ` final: ${redact(String(e.finalError)).slice(0, 160)}` : ""}`);
      if (e.type === "agent_settled") { phase = "idle"; log(`PI SETTLED ${who}`); }
      for (const w of [...waiters]) if (w.type === e.type) { waiters.delete(w); clearTimeout(w.timer); w.resolve(e); }
    }
  });
  proc.on("exit", (code, signal) => {
    log(`PI EXIT ${code}/${signal}`);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`Pi exited ${code}/${signal}`)); }
    for (const w of waiters) { clearTimeout(w.timer); w.reject(new Error(`Pi exited ${code}/${signal}`)); }
    waiters.clear();
  });

  const command = (type: string, args: Record<string, unknown> = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = `c${++seq}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${type} exceeded ${AGENT_POLICY.rpcTimeoutMs}ms`)); }, AGENT_POLICY.rpcTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      proc.stdin?.write(`${JSON.stringify({ type, id, ...args })}\n`);
    });
  const wait = (type: string, timeoutMs: number, what: string) => {
    let w!: { type: string; resolve: (e: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
    const promise = new Promise<any>((resolve, reject) => {
      w = { type, resolve, reject, timer: setTimeout(() => { waiters.delete(w); reject(new Blocked(`${what}: client deadline ${timeoutMs}ms reached in phase "${phase}"`)); }, timeoutMs) };
      waiters.add(w);
    });
    return { promise, cancel: () => { clearTimeout(w.timer); waiters.delete(w); }, fail: (err: Error) => { clearTimeout(w.timer); waiters.delete(w); w.reject(err); } };
  };

  const state = (await command("get_state")) as any;
  if (state.model?.provider !== selected.provider || state.model?.id !== selected.id) throw new Error(`Pi selected ${state.model?.provider}/${state.model?.id}, not ${selected.provider}/${selected.id}: refusing to fall back`);
  const contextWindow = Number(state.model?.contextWindow ?? 0);
  await command("set_auto_retry", { enabled: opts.autoRetry ?? AGENT_POLICY.autoRetry });
  log(`PI READY [${label}] ${selected.provider}/${selected.id} (container ${spec.name})`);

  let desired: { provider: string; id: string } = { ...selected };
  let simulate = opts.simulateQuotaOnce === true;
  let current: { provider: string; id: string } = { ...selected };
  const selectModel = async (m: { provider: string; id: string }): Promise<void> => {
    if (current.provider === m.provider && current.id === m.id) return;
    await command("set_model", { provider: m.provider, modelId: m.id });
    current = m;
    log(`PI MODEL SET [${label}] ${m.provider}/${m.id}`);
  };
  const agent0: Agent = {
    fallbackTurns: [],
    contextWindow,
    uktub: (t, name) => t.calls.filter((c) => c.name.startsWith(TOOL_PREFIX) && (name === undefined || c.name === `${TOOL_PREFIX}${name}`)),
    async turn(id, prompt, opts) {
      if (opts?.newSession !== false) {
        await command("new_session");
        current = { ...selected }; // a new Pi session starts on the default model: apply the one this turn is meant to run on
        await selectModel(desired);
      }
      const want = current;
      const at = events.length;
      const dialogs: Turn["dialogs"] = [];
      active = { id, dialog: opts?.dialog ?? "decline", dialogs };
      phase = "prompt";
      lastEvent = Date.now();
      const started = Date.now();
      log(`PI TURN START ${id}: ${prompt}`);
      const done = wait("agent_settled", AGENT_POLICY.turnMaxMs, `turn ${id}`);
      const heart = setInterval(() => {
        log(`PI HEARTBEAT ${id}: phase=${phase}, idle=${Math.round((Date.now() - lastEvent) / 1000)}s, elapsed=${Math.round((Date.now() - started) / 1000)}s`);
        command("get_state").then((s: any) => log(`PI STATE ${id}: streaming=${s.isStreaming}, messages=${s.messageCount}`)).catch((e: Error) => log(`PI STATE ERROR ${id}: ${e.message}`));
        if (Date.now() - lastEvent > AGENT_POLICY.turnIdleMs) done.fail(new Blocked(`turn ${id}: no event for ${AGENT_POLICY.turnIdleMs}ms (a stall) in phase "${phase}"`));
      }, AGENT_POLICY.heartbeatMs);
      let settled = false;
      let blockedBy: Error | undefined;
      try {
        const ack = await command("prompt", { message: prompt });
        if (ack.disposition !== "started") throw new Error(`prompt not started: ${JSON.stringify(ack)}`);
        await done.promise;
        settled = true;
      } catch (e) {
        if (!(e instanceof Blocked)) throw e;
        blockedBy = e;
        if (!settled) {
          done.cancel();
          const halted = wait("agent_settled", AGENT_POLICY.abortGraceMs, `abort of ${id}`);
          await command("abort").catch((err: Error) => log(`PI ABORT ERROR ${id}: ${err.message}`));
          await halted.promise.catch((err: Error) => log(`PI SETTLE AFTER ABORT ${id}: ${err.message}`));
        }
      } finally {
        clearInterval(heart);
        done.cancel();
        active = null;
      }
      const slice = events.slice(at);
      const messages = slice.filter((e) => e.type === "message_end" && e.message?.role === "assistant").map((e) => e.message);
      const turn: Turn = {
        id, prompt, dialogs, messages, compactions: compactionsOf(slice), model: `${want.provider}/${want.id}`, elapsedMs: Date.now() - started,
        retries: slice.filter((e) => e.type === "auto_retry_start").map((e) => ({ attempt: e.attempt, maxAttempts: e.maxAttempts, delayMs: e.delayMs, errorMessage: redact(String(e.errorMessage ?? "")).slice(0, 300) })),
        usage: {
          input: sum(messages, (m) => m.usage?.input), output: sum(messages, (m) => m.usage?.output), reasoning: sum(messages, (m) => m.usage?.reasoning),
          total: sum(messages, (m) => m.usage?.totalTokens), costUsd: sum(messages, (m) => m.usage?.cost?.total), responses: messages.length,
        },
        calls: slice.filter((e) => e.type === "tool_execution_start").map((e) => ({ id: e.toolCallId, name: e.toolName, args: e.args, parent: e.parentToolCallId, t: e._t })),
        ends: slice.filter((e) => e.type === "tool_execution_end").map((e) => ({ toolCallId: e.toolCallId, name: e.toolName, isError: !!e.isError, text: textOf(e.result), structured: e.result?.structuredContent?.structuredContent ?? e.result?.structuredContent, details: e.result?.details, parent: e.parentToolCallId, t: e._t })),
        final: messages.at(-1)?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") ?? "",
      };
      // Judge the turn by its FINAL response: when Pi retried a transient failure and the retry succeeded, the earlier errored attempt is not a failure (it is in `retries`).
      const last = messages.at(-1);
      const bad = last !== undefined && ["error", "aborted"].includes(last.stopReason) ? last : undefined;
      if (blockedBy === undefined && bad) blockedBy = new Blocked(`turn ${id}: provider/model ${bad.stopReason}: ${redact(String(bad.errorMessage ?? "")).slice(0, 300)}`);
      if (blockedBy === undefined && messages.length === 0) blockedBy = new Blocked(`turn ${id}: no assistant message`);
      if (!messages.every((m) => (m.provider === want.provider && m.model === want.id) || ["aborted", "error"].includes(m.stopReason))) throw new Error(`turn ${id}: a response came from ${messages.map((m) => `${m.provider}/${m.model}`).join(", ")}: refusing a model fallback`);
      if (blockedBy !== undefined) {
        turn.incomplete = blockedBy.message;
        appendFileSync(join(outDir, `${label}-turns.jsonl`), `${redact(JSON.stringify(turn))}\n`);
        throw new TurnBlocked(blockedBy.message, turn);
      }
      appendFileSync(join(outDir, `${label}-turns.jsonl`), `${redact(JSON.stringify(turn))}\n`);
      return turn;
    },
  };
  // Fresh-session turns start on the primary model and are rerun once on the fallback after a quota failure. A turn that continues an
  // existing conversation is not rerun: its half-finished messages are already in the session, so it stays blocked.
  const agent: Agent = {
    ...agent0,
    async turn(id, prompt, opts) {
      const fresh = opts?.newSession !== false;
      if (fresh) desired = { ...selected };
      try {
        if (simulate && fresh) {
          simulate = false;
          throw new TurnBlocked("turn: provider/model error: simulated HTTP 429 RESOURCE_EXHAUSTED (smoke test of the fallback path)", { id, prompt, calls: [], ends: [], final: "", dialogs: [], elapsedMs: 0, retries: [], messages: [], compactions: [], model: `${selected.provider}/${selected.id}`, usage: { input: 0, output: 0, reasoning: 0, total: 0, costUsd: 0, responses: 0 } });
        }
        return await agent0.turn(id, prompt, opts);
      } catch (e) {
        if (!(e instanceof TurnBlocked) || !fresh || current.id !== MODEL.id || !isQuotaFailure(e.message)) throw e;
        log(`PI FALLBACK ${id}: ${MODEL.id} quota limited (${e.message.slice(0, 120)}); rerunning once on ${FALLBACK_MODEL.id}`);
        desired = FALLBACK_MODEL;
        const turn = await agent0.turn(id, prompt, opts);
        turn.fallbackFrom = e.message.slice(0, 300);
        agent0.fallbackTurns.push(id);
        return turn;
      }
    },
  };
  return {
    agent,
    async stop() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = once(proc, "exit");
      proc.stdin?.end();
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([exited, new Promise((r) => { grace = setTimeout(r, 30000); })]).finally(() => clearTimeout(grace));
      if (proc.exitCode === null && proc.signalCode === null) { log("PI did not exit after stdin close; SIGTERM to the review-owned docker client"); proc.kill("SIGTERM"); await exited; }
    },
  };
}
