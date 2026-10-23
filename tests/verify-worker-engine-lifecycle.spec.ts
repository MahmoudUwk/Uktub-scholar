/**
 * Lifecycle of the verify engines' resident workers and of HTTP response bodies:
 * - a failed worker's 600 s load+batch timer never reaches a later respawned worker;
 * - a worker that exits while idle is respawned by the next run(), never written to;
 * - each worker's process 'exit' hook is removed when that worker closes;
 * - 429 and 401 response bodies are cancelled; unreadable 200 bodies throw a static EngineError.
 * Offline: fake ChildProcess built from EventEmitter + PassThrough, stub fetch, injected sleep.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";

import {
  EngineError,
  eosEngine,
  fetchWith429Retry,
  RateLimitedError,
  systemoneEndpointEngine,
} from "../src/core/verify/claim.ts";

/** Minimal ChildProcess stand-in: stdio are PassThroughs; the test drives stdout and exit. */
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
  ref(): void {}
  unref(): void {}
  /** The worker printed its ready line. */
  ready(): void {
    this.stdout.write('{"ready":true}\n');
  }
  /** The worker printed one raw line (a JSON answer or garbage). */
  answer(line: string): void {
    this.stdout.write(line + "\n");
  }
  /** The process exited (no further stdout). */
  exit(): void {
    this.emit("close", 0, null);
  }
}

function makeSpawn() {
  const children: FakeChild[] = [];
  const spawnImpl = (() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as unknown as typeof spawn;
  return { spawnImpl, children };
}

/** Lets pending stream data and microtasks run. */
const settle = () => new Promise<void>((r) => setImmediate(r));

/** Bounded wait so a hang fails the test instead of stalling the runner. */
async function within<T>(p: Promise<T>, what: string, ms = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no settlement within ${ms} ms: ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A 429/401 body that records how many times it was cancelled. */
function countedBody(counter: { cancelled: number }, text = "rate limited, slow down"): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel() {
        counter.cancelled += 1;
      },
    },
    { highWaterMark: 0 },
  );
}

describe("resident worker lifecycle", () => {
  it("a failed worker's load+batch timer never kills or rejects a later respawned worker", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { spawnImpl, children } = makeSpawn();
      const engine = eosEngine({ env: {}, spawnImpl });
      const first = engine.run([{ state: "a", instructions: "c" }]);
      await settle();
      children[0]!.ready();
      await settle();
      children[0]!.answer("not json"); // fail() on worker 1
      await assert.rejects(first, EngineError);

      mock.timers.tick(300_000); // worker 2 starts later, so its own 600 s timer is not due yet
      const second = engine.run([{ state: "b", instructions: "c" }]);
      await settle();
      children[1]!.ready(); // worker 2 is healthy and mid-batch
      await settle();
      mock.timers.tick(300_000); // t = 600 s: worker 1's leftover timer would fire here; worker 2's is due at 900 s
      assert.deepEqual(children[1]!.killed, [], "worker 2 must not be killed by worker 1's timer");
      children[1]!.answer('{"p_true":0.995}');
      assert.deepEqual(await second, [0.995]);
    } finally {
      mock.timers.reset();
    }
  });

  it("a worker that exits while idle is respawned by the next run(), not written to", async () => {
    const { spawnImpl, children } = makeSpawn();
    const engine = eosEngine({ env: {}, spawnImpl });
    const first = engine.run([{ state: "support a", instructions: "c" }]);
    await settle();
    children[0]!.ready();
    children[0]!.answer('{"p_true":0.995}');
    assert.deepEqual(await within(first, "first run"), [0.995]);

    children[0]!.exit(); // idle exit
    const second = engine.run([{ state: "support b", instructions: "c" }]);
    await settle();
    assert.equal(children.length, 2, "the next run must spawn a new worker, not reuse the dead child");
    children[1]!.ready();
    children[1]!.answer('{"p_true":0.5}');
    assert.deepEqual(await within(second, "second run on the respawned worker"), [0.5]);
  });

  it("a stdin write failure fails the pending request instead of crashing the process", async () => {
    const { spawnImpl, children } = makeSpawn();
    const engine = eosEngine({ env: {}, spawnImpl });
    const pending = engine.run([{ state: "s", instructions: "c" }]);
    await settle();
    children[0]!.ready();
    await settle();
    const rejected = assert.rejects(pending, EngineError);
    assert.doesNotThrow(() => children[0]!.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
    await within(rejected, "pending request after stdin EPIPE");
  });

  it("each resident worker's process exit hook is removed when that worker closes", async () => {
    const base = process.listenerCount("exit");
    const { spawnImpl, children } = makeSpawn();
    const engine = eosEngine({ env: {}, spawnImpl });
    for (let i = 0; i < 3; i++) {
      const p = engine.run([{ state: "support", instructions: "c" }]);
      await settle();
      children[i]!.ready();
      children[i]!.answer('{"p_true":0.9}');
      await within(p, `run ${i + 1}`);
      assert.equal(process.listenerCount("exit"), base + 1, `worker ${i + 1} holds one exit hook while resident`);
      children[i]!.exit();
      assert.equal(process.listenerCount("exit"), base, `worker ${i + 1} removed its exit hook on close`);
    }
  });
});

describe("HTTP response bodies on the hosted and 429 paths", () => {
  it("a 429 body is cancelled before the backoff sleep", async () => {
    const counter = { cancelled: 0 };
    const cancelledAtSleep: number[] = [];
    let calls = 0;
    const res = await fetchWith429Retry(
      async () => (calls++ === 0 ? new Response(countedBody(counter), { status: 429 }) : new Response("ok", { status: 200 })),
      {
        label: "test engine",
        baseDelayMs: 1,
        sleepImpl: async () => {
          cancelledAtSleep.push(counter.cancelled);
        },
      },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cancelledAtSleep, [1]);
  });

  it("a 429 body is cancelled before RateLimitedError is thrown", async () => {
    const counter = { cancelled: 0 };
    await assert.rejects(
      fetchWith429Retry(async () => new Response(countedBody(counter), { status: 429 }), {
        label: "test engine",
        maxRetries: 0,
        sleepImpl: async () => {},
      }),
      RateLimitedError,
    );
    assert.equal(counter.cancelled, 1);
  });

  it("a hosted 401 body is cancelled before the EngineError is thrown", async () => {
    const counter = { cancelled: 0 };
    const engine = systemoneEndpointEngine({
      url: "https://decision.example.test/v1/systemone",
      label: "hosted",
      fetchImpl: (async () => new Response(countedBody(counter, "bad key"), { status: 401 })) as unknown as typeof fetch,
    });
    await assert.rejects(engine.run([{ state: "s", instructions: "c" }]), (e: unknown) => e instanceof EngineError && /HTTP 401/.test(e.message));
    assert.equal(counter.cancelled, 1);
  });

  it("a 200 HTML gateway page throws a static EngineError that never quotes the body", async () => {
    const engine = systemoneEndpointEngine({
      url: "https://decision.example.test/v1/systemone",
      label: "hosted",
      fetchImpl: (async () => new Response("<html>upstream gateway token-xyz-secret</html>", { status: 200 })) as unknown as typeof fetch,
    });
    await assert.rejects(engine.run([{ state: "s", instructions: "c" }]), (e: unknown) => {
      if (!(e instanceof EngineError)) return false;
      assert.match(e.message, /hosted engine returned an unreadable response/);
      assert.doesNotMatch(e.message, /gateway|token-xyz-secret|<html>/);
      return true;
    });
  });

  it("a 200 body cut mid-stream throws EngineError, not a raw transport TypeError", async () => {
    const truncated = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"answers":{"c":{"noul":0.9'));
        controller.error(new TypeError("terminated"));
      },
    });
    const engine = systemoneEndpointEngine({
      url: "https://decision.example.test/v1/systemone",
      label: "hosted",
      fetchImpl: (async () => new Response(truncated, { status: 200 })) as unknown as typeof fetch,
    });
    await assert.rejects(engine.run([{ state: "s", instructions: "c" }]), (e: unknown) => e instanceof EngineError && /unreadable response/.test(e.message));
  });
});
