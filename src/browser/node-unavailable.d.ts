/**
 * Minimal ambient declarations for the NOT-yet-shimmed `node:*` modules the
 * browser typecheck program reaches. `src/browser/download.ts` imports only
 * TYPES from `src/core/source/download.ts`, but that drags the file (and
 * `source/extract.ts` behind it) into the program, including its `node:*`
 * value imports. Each module below is stubbed in the browser build; throws at
 * call time (see `tests-browser/build.mjs`). Types cover exactly what the
 * dragged-in core files use — nothing more.
 */

/** Stubbed in the browser build; throws at call time. */
declare module "node:dns/promises" {
  interface LookupAddress {
    address: string;
    family: number;
  }
  function lookup(hostname: string, options?: unknown): Promise<LookupAddress[]>;
}

/** Stubbed in the browser build; throws at call time. */
declare module "node:https" {
  interface RequestOptions {
    host?: string;
    servername?: string;
    port?: number;
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }
  interface IncomingMessage {
    headers: Record<string, string | string[] | undefined>;
    statusCode?: number;
    complete: boolean;
    resume(): void;
    on(event: string, listener: (...args: never[]) => void): void;
  }
  interface ClientRequest {
    on(event: string, listener: (...args: never[]) => void): void;
    destroy(): void;
    end(): void;
  }
  function request(options: RequestOptions, callback: (res: IncomingMessage) => void): ClientRequest;
}

/** Stubbed in the browser build; throws at call time. */
declare module "node:net" {
  function isIP(ip: string): number;
  class BlockList {
    constructor();
    addSubnet(network: string, prefix: number, type?: string): void;
    check(address: string, type?: string): boolean;
  }
  /** Stubbed in the browser build; throws at call time. */
  interface Server {
    listen(port: number, host: string, callback?: () => void): void;
    close(callback?: () => void): void;
    on(event: string, listener: (...args: any[]) => void): void;
    once(event: string, listener: (...args: any[]) => void): void;
    address(): unknown;
  }
  function createServer(listener?: (...args: any[]) => void): Server;
}

/** Types only: `tar`'s declarations extend bare `events` (stubbed at bundle). */
declare module "events" {
  class EventEmitter {
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: any[]): boolean;
    end(data?: unknown): void;
    pipe(dest: unknown): any;
  }
}

/**
 * The `NodeJS` namespace is absent (`types: []`), but the engine-seam core
 * files name `NodeJS.Platform` (compile engine dispatch) and
 * `NodeJS.ProcessEnv` (spawn env). Values never reach the browser.
 */
declare namespace NodeJS {
  type Platform = string;
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
  interface ErrnoException extends Error {
    code?: string;
    errno?: number;
    syscall?: string;
    path?: string;
  }
}

/** Stubbed in the browser build; throws at call time. */
declare module "node:child_process" {
  interface ChildStdio {
    on(event: string, listener: (...args: any[]) => void): void;
    write(data: unknown): boolean;
  }
  interface ChildProcessWithoutNullStreams {
    pid: number | undefined;
    stdin: ChildStdio | null;
    stdout: ChildStdio | null;
    stderr: ChildStdio | null;
    kill(signal?: string): boolean;
    unref(): void;
    ref(): void;
    on(event: string, listener: (...args: any[]) => void): void;
    once(event: string, listener: (...args: any[]) => void): void;
  }
  function spawn(file: string, args?: string[], options?: unknown): ChildProcessWithoutNullStreams;
  function execFile(file: string, args?: string[], options?: unknown, callback?: (...args: any[]) => void): unknown;
}

/** Stubbed in the browser build; throws at call time. */
declare module "node:util" {
  function promisify(fn: (...args: any[]) => any): (...args: any[]) => Promise<any>;
}

/** Stubbed in the browser build; throws at call time. */
declare module "node:stream" {
  class Readable {
    static fromWeb(stream: unknown, options?: unknown): any;
    pipe(dest: unknown): any;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  interface TransformCallback {
    (err?: unknown, data?: unknown): void;
  }
  interface TransformOptions {
    transform?(chunk: any, encoding: string, callback: TransformCallback): void;
    [key: string]: unknown;
  }
  class Transform {
    constructor(options?: TransformOptions);
    on(event: string, listener: (...args: any[]) => void): this;
    end(data?: unknown): void;
  }
}

/** Stubbed in the browser build; throws at call time. */
declare module "node:stream/promises" {
  function pipeline(...args: any[]): Promise<void>;
}
