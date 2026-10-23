/**
 * Strongly-typed browser client for Uktub Scholar: encapsulates the dedicated Web
 * Worker RPC into asynchronous methods with request-response correlation,
 * lifecycle gating, timeouts, AbortSignal cancellation, and clean error handling.
 */
import type {
  InitArgs,
  ToolName,
  ImportProjectArgs,
  ImportSourceArgs,
  ExportedProject,
} from "./host.ts";

export type {
  InitArgs,
  ToolName,
  ImportProjectArgs,
  ImportSourceArgs,
  ExportedProject,
};

export interface ClientOptions {
  /** Default timeout for worker operations in milliseconds (default: 60,000ms). */
  timeoutMs?: number;
}

export interface CallToolOptions {
  callId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WorkerMessage<T = unknown> {
  id?: string;
  op?: string;
  args?: Record<string, unknown>;
  boot?: boolean;
  ok?: boolean;
  result?: T;
  error?: string;
}

interface Deferred<T = unknown> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
}

export class UktubBrowserClient {
  private readonly worker: Worker;
  private readonly defaultTimeoutMs: number;
  private readonly pending = new Map<string, Deferred<unknown>>();
  private readonly inflightCalls = new Set<string>();
  private nextCorrelationId = 0;
  public readonly ready: Promise<void>;
  private abortBoot?: (err: Error) => void;
  private closePromise?: Promise<{ ok: true }>;
  private closed = false;
  private closing = false;
  private crashError?: Error;
  private isReady = false;
  private bootTimer?: ReturnType<typeof setTimeout>;

  constructor(worker: Worker | string, options: ClientOptions = {}) {
    this.defaultTimeoutMs = options.timeoutMs ?? 60000;
    if (typeof worker === "string") {
      this.worker = new Worker(worker, { type: "module" });
    } else {
      this.worker = worker;
    }

    this.ready = new Promise<void>((resolve, reject) => {
      this.bootTimer = setTimeout(() => {
        cleanup();
        reject(new Error("UktubBrowserClient: worker boot timeout"));
      }, this.defaultTimeoutMs);

      const onBootMessage = (ev: MessageEvent) => {
        const data = ev.data as WorkerMessage;
        if (data && data.boot === true) {
          cleanup();
          if (data.ok) {
            this.isReady = true;
            resolve();
          } else {
            reject(new Error(`UktubBrowserClient boot failed: ${data.error ?? "unknown error"}`));
          }
        }
      };

      const onBootError = (err: Event | ErrorEvent) => {
        cleanup();
        const msg = "message" in err ? (err as ErrorEvent).message : "worker failed to load or crashed during boot";
        reject(new Error(`UktubBrowserClient boot error: ${msg}`));
      };

      const cleanup = () => {
        if (this.bootTimer !== undefined) {
          clearTimeout(this.bootTimer);
          this.bootTimer = undefined;
        }
        this.worker.removeEventListener("message", onBootMessage);
        this.worker.removeEventListener("error", onBootError);
      };

      this.abortBoot = (err: Error) => {
        cleanup();
        reject(err);
      };

      this.worker.addEventListener("message", onBootMessage);
      this.worker.addEventListener("error", onBootError);
    });
    // Requests awaiting boot observe this rejection; keep an unobserved one from becoming an unhandled rejection.
    this.ready.catch(() => {});

    this.worker.addEventListener("message", (ev: MessageEvent) => {
      this.handleMessage(ev);
    });

    this.worker.addEventListener("error", (ev: Event | ErrorEvent) => {
      const msg = "message" in ev ? (ev as ErrorEvent).message : "worker error";
      const err = new Error(`Worker crash: ${msg}`);
      this.handleCrash(err);
      // A crash after boot is fatal: the worker state is unknown, so later calls fail fast and the worker is released.
      if (this.isReady) {
        this.crashError = err;
        this.terminate();
      }
    });
  }

  private handleMessage(ev: MessageEvent): void {
    const data = ev.data as WorkerMessage;
    if (!data || data.boot === true || typeof data.id !== "string") return;
    const deferred = this.pending.get(data.id);
    if (!deferred) return;

    if (deferred.timer !== undefined) clearTimeout(deferred.timer);
    if (deferred.abortCleanup !== undefined) deferred.abortCleanup();
    this.pending.delete(data.id);

    if (data.ok) {
      deferred.resolve(data.result);
    } else {
      deferred.reject(new Error(data.error ?? "worker operation failed"));
    }
  }

  private handleCrash(err: Error): void {
    const active = Array.from(this.pending.values());
    this.pending.clear();
    for (const deferred of active) {
      if (deferred.timer !== undefined) clearTimeout(deferred.timer);
      if (deferred.abortCleanup !== undefined) deferred.abortCleanup();
      deferred.reject(err);
    }
  }

  /**
   * Fire-and-forget cancel for an abandoned callTool. It bypasses `request()` so it
   * leaves no pending entry or timer behind if the worker is wedged.
   */
  private postCancel(op: string, args: Record<string, unknown>): void {
    if (op !== "callTool") return;
    this.worker.postMessage({ id: String(++this.nextCorrelationId), op: "cancelTool", args: { callId: args.callId } });
  }

  public async request<T = unknown>(
    op: string,
    args: Record<string, unknown> = {},
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.crashError) {
      throw new Error(`UktubBrowserClient worker crashed: ${this.crashError.message}`);
    }
    if (this.closed || (this.closing && op !== "close")) {
      throw new Error("UktubBrowserClient is closed");
    }
    if (!this.isReady) await this.ready;

    if (opts.signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    // Correlation ids are internal and never reused, so a late reply cannot settle a later request.
    const id = String(++this.nextCorrelationId);
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (deferred.abortCleanup) deferred.abortCleanup();
        this.postCancel(op, args);
        reject(new Error(`UktubBrowserClient request "${op}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      let abortCleanup: (() => void) | undefined;
      if (opts.signal) {
        const onAbort = () => {
          this.pending.delete(id);
          clearTimeout(timer);
          if (abortCleanup) abortCleanup();
          this.postCancel(op, args);
          reject(new DOMException("The operation was aborted", "AbortError"));
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => opts.signal?.removeEventListener("abort", onAbort);
      }

      const deferred: Deferred<unknown> = {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
        abortCleanup,
      };

      this.pending.set(id, deferred);
      this.worker.postMessage({ id, op, args });
    });
  }

  public async init(args: InitArgs): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("init", args as unknown as Record<string, unknown>);
  }

  public async callTool<T = unknown>(
    name: ToolName,
    toolArgs: Record<string, unknown> = {},
    opts: CallToolOptions = {},
  ): Promise<T> {
    const callId = opts.callId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    if (this.inflightCalls.has(callId)) {
      throw new Error(`UktubBrowserClient: duplicate callId in flight: ${callId}`);
    }
    this.inflightCalls.add(callId);
    try {
      return await this.request<T>("callTool", { name, toolArgs, callId }, {
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      });
    } finally {
      this.inflightCalls.delete(callId);
    }
  }

  public async cancelTool(callId: string): Promise<{ ok: true; cancelled: boolean }> {
    return this.request<{ ok: true; cancelled: boolean }>("cancelTool", { callId });
  }

  public async writeFile(
    rel: string,
    content: string | Uint8Array,
    encoding?: "utf8" | "base64",
  ): Promise<{ path: string; bytes: number }> {
    if (content instanceof Uint8Array) {
      return this.request<{ path: string; bytes: number }>("writeFile", { rel, bytes: content });
    }
    if (encoding === "base64") {
      return this.request<{ path: string; bytes: number }>("writeFile", { rel, base64: content });
    }
    return this.request<{ path: string; bytes: number }>("writeFile", { rel, text: content });
  }

  public async readFile(
    rel: string,
    encoding?: "utf8" | "base64",
  ): Promise<{ path: string; bytes: number; text?: string; base64?: string }> {
    return this.request<{ path: string; bytes: number; text?: string; base64?: string }>("readFile", {
      rel,
      ...(encoding ? { encoding } : {}),
    });
  }

  public async listFiles(): Promise<{ files: { path: string; size: number }[] }> {
    return this.request<{ files: { path: string; size: number }[] }>("listFiles", {});
  }

  public async agentSurface(): Promise<{
    rules: string[];
    workflow: string | null;
    tools: { name: string; description: string; inputSchema: unknown }[];
    keyNames: string[];
    compileTimeoutMs: number;
    verificationEngines: string[];
  }> {
    return this.request<{
      rules: string[];
      workflow: string | null;
      tools: { name: string; description: string; inputSchema: unknown }[];
      keyNames: string[];
      compileTimeoutMs: number;
      verificationEngines: string[];
    }>("agentSurface", {});
  }

  /** Phase 8a pre-completion gate: start a new per-prompt budget. */
  public async gateStartUserPrompt(): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("gateStartUserPrompt", {});
  }

  /** Phase 8a pre-completion gate: record one completed tool call. */
  public async gateToolEnded(args: { toolName: string; args?: unknown; isError?: boolean }): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("gateToolEnded", args as unknown as Record<string, unknown>);
  }

  /** Phase 8a pre-completion gate: audit at the would-finish point; null text means silence. */
  public async gateSettle(): Promise<{ text: string | null }> {
    return this.request<{ text: string | null }>("gateSettle", {});
  }

  public async setEnv(env: Record<string, string | undefined>): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("setEnv", { env });
  }

  /**
   * Phase 7 agent-compile prologue: the worker resolves the entry
   * (same refusals as Node). The page compiles the returned rel with
   * BusyTeX, then closes the loop with `compileFinish`.
   */
  public async compilePrepare(entry?: string): Promise<{ ok: true; rel: string } | { ok: false; code: "COMPILE_NO_ENTRY"; message: string }> {
    return this.request<{ ok: true; rel: string } | { ok: false; code: "COMPILE_NO_ENTRY"; message: string }>(
      "compilePrepare",
      entry === undefined ? {} : { entry },
    );
  }

  /**
   * Phase 7 agent-compile epilogue: the worker parses the BusyTeX log and
   * finishes through the engine-neutral core step, returning the same tool
   * result shape the Node tool returns.
   */
  public async compileFinish(args: {
    entry: string;
    engineLabel: string;
    code: number;
    timedOut: boolean;
    log: string;
    pdf?: Uint8Array | null;
  }): Promise<unknown> {
    return this.request<unknown>("compileFinish", args as unknown as Record<string, unknown>);
  }

  public async deleteFile(rel: string): Promise<{ deleted: boolean }> {
    return this.request<{ deleted: boolean }>("deleteFile", { rel });
  }

  /**
   * Destroy one project's OPFS storage (its pool, registry and files).
   * Refused while that project is open in this worker or in another tab.
   * Usable without `init` (e.g. from an ephemeral worker).
   */
  public async deleteProjectStorage(projectId: string): Promise<{ deleted: boolean }> {
    return this.request<{ deleted: boolean }>("deleteProjectStorage", { projectId });
  }

  public async exportProject(): Promise<ExportedProject> {
    return this.request<ExportedProject>("exportProject", {});
  }

  public async importProject(
    args: ImportProjectArgs,
  ): Promise<{ ok: true; filesImported: number; registryImported: boolean }> {
    return this.request<{ ok: true; filesImported: number; registryImported: boolean }>(
      "importProject",
      args as unknown as Record<string, unknown>,
    );
  }

  public async importSource(args: ImportSourceArgs): Promise<unknown> {
    return this.request<unknown>("importSource", args as unknown as Record<string, unknown>);
  }

  public async runProvenance(entry?: string): Promise<unknown> {
    return this.request<unknown>("provenance", entry !== undefined ? { entry } : {});
  }

  public async readAsset(path: string): Promise<{ text: string; size: number }> {
    return this.request<{ text: string; size: number }>("readAsset", { path });
  }

  public async close(): Promise<{ ok: true }> {
    // Also covers a post-boot crash: the worker is already gone, so there is nothing to close and it resolves.
    if (this.closed) return { ok: true };
    if (!this.closePromise) this.closePromise = this.runClose();
    return this.closePromise;
  }

  private async runClose(): Promise<{ ok: true }> {
    this.closing = true;
    try {
      const res = await this.request<{ ok: true }>("close", {});
      this.closed = true;
      return res;
    } finally {
      this.closed = true;
    }
  }

  public terminate(): void {
    this.closed = true;
    this.closing = true;
    // Rejects `ready` (so parked requests fail) and removes the boot listeners and timer.
    this.abortBoot?.(new Error("UktubBrowserClient: worker terminated"));
    this.handleCrash(new Error("UktubBrowserClient: worker terminated"));
    if (typeof this.worker.terminate === "function") {
      this.worker.terminate();
    }
  }
}

export function createUktubClient(worker: Worker | string, options?: ClientOptions): UktubBrowserClient {
  return new UktubBrowserClient(worker, options);
}
